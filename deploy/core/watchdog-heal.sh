#!/bin/bash
# 看门狗 + 自愈：先跑原检查，连续 ≥3 次异常就删锁重启容器，再复查一次
set -u
C=coopanion
BASE=/data_n005/coopanion
STATE=/data/logs/watchdog-state.json
LOG=$BASE/watchdog.log

ts() { date '+%Y-%m-%d %H:%M:%S'; }

echo "[$(ts)] heal: run check" >> "$LOG"
docker exec $C node /data/watchdog.cjs >> "$LOG" 2>&1

FAILS=$(docker exec $C sh -c "cat $STATE 2>/dev/null" | sed -n 's/.*"fails"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' | head -1)
FAILS=${FAILS:-0}
echo "[$(ts)] heal: fails=$FAILS" >> "$LOG"

if [ "${FAILS:-0}" -ge 3 ]; then
  echo "[$(ts)] heal: 连续 ${FAILS} 次异常，执行自愈（抓 profile → 删锁 → 重启）" >> "$LOG"
  # 卡死时先抓 5 秒 CPU profile，再重启（inspector 未开/不可达时会快速失败，不阻塞）
  PROF=/data/logs/hang-$(date +%Y%m%d-%H%M%S).cpuprofile
  if docker exec $C timeout 45 node /data/hang-profile.mjs 5 "$PROF" >> "$LOG" 2>&1; then
    echo "[$(ts)] heal: 已保存 CPU profile $PROF" >> "$LOG"
  else
    echo "[$(ts)] heal: profile 未抓到（inspector 不可达或超时），继续重启" >> "$LOG"
  fi
  docker exec -u 0 $C rm -f /data/home/companion/data/instance.lock >> "$LOG" 2>&1
  docker restart $C >> "$LOG" 2>&1
  sleep 55
  OK=$(docker exec $C node -e '
    (async () => {
      try {
        const res = await fetch("http://127.0.0.1:17789/api/worlds", { signal: AbortSignal.timeout(5000) });
        const j = await res.json();
        const need = ["console", "desktop-pet", "coopanion", "memory", "qqbot"];
        const bad = need.filter((id) => !(j.worlds || []).some((w) => w.id === id && w.status === "active"));
        console.log(bad.length ? "MISSING:" + bad.join(",") : "OK");
      } catch (e) { console.log("FAIL:" + e.message); }
    })();
  ' 2>/dev/null)
  echo "[$(ts)] heal: 重启后复查 $OK" >> "$LOG"
  if [ "$OK" = "OK" ]; then
    docker exec $C sh -c "echo '{\"fails\":0,\"lastAlert\":0}' > $STATE" 2>/dev/null
    echo "[$(ts)] 自愈成功（此前连续 ${FAILS} 次异常，已重启）" >> /data/logs/alerts.log
  else
    echo "[$(ts)] 自愈失败：$OK，需人工介入" >> /data/logs/alerts.log
  fi
fi
