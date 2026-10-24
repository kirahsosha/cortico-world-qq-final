#!/bin/bash
# 部署 0.6.24 线：备份 -> 阶段 -> esbuild 检查 -> 落盘 -> 重启 -> 轮询五世界 -> 失败回滚
set -u
LABEL="${1:-step}"
TGZ="$2"
TS=$(date +%Y%m%d-%H%M%S)
BAK=/data_n005/coopanion/backup/${LABEL}-${TS}
EXT=/data/extensions/node_modules/cortico-world-qq-final
mkdir -p "$BAK"
echo "=== backup -> $BAK ==="
docker exec coopanion sh -c "cd $EXT && tar czf - ." > "$BAK/ext-before.tar.gz"
ls -l "$BAK" | tail -2

STAGE=/data_n005/coopanion/_stage0624
rm -rf "$STAGE"; mkdir -p "$STAGE"
tar xzf "$TGZ" -C "$STAGE" 2>/dev/null
docker exec coopanion rm -rf /data/_new0624
docker cp "$STAGE/." coopanion:/data/_new0624 || exit 2
docker cp /data_n005/coopanion/_check0624.cjs coopanion:/data/_check0624.cjs || exit 2
echo "=== check ==="
docker exec coopanion node /data/_check0624.cjs /data/_new0624 || { echo "CHECK FAIL"; exit 3; }

docker cp /data_n005/coopanion/_apply_inner.sh coopanion:/data/_apply_inner.sh || exit 2
echo "=== write files ==="
docker exec -u 0 coopanion bash /data/_apply_inner.sh /data/_new0624 || exit 4

echo "=== restart ==="
docker restart coopanion >/dev/null
sleep 8
echo "=== poll ==="
OK=0
for i in $(seq 1 30); do
  sleep 4
  OUT=$(docker exec coopanion node -e 'const want=["console","desktop-pet","coopanion","memory","qqbot"];fetch("http://127.0.0.1:17789/api/worlds").then(r=>r.json()).then(j=>{const got=new Map(j.worlds.map(w=>[w.id,w.status]));const bad=want.filter(id=>got.get(id)!=="active");console.log(bad.length?("BAD "+bad.map(id=>id+"="+(got.get(id)||"missing")).join(" ")):"ALL-ACTIVE")}).catch(e=>console.log("ERR"))' 2>/dev/null | tr -d '\r')
  echo "  [$((i*4))s] $OUT"
  if [ "$OUT" = "ALL-ACTIVE" ]; then OK=1; break; fi
  ST=$(docker exec coopanion node -e 'fetch("http://127.0.0.1:17789/api/extensions").then(r=>r.json()).then(j=>{const e=j.extensions.find(x=>/qq-final/.test(x.name));console.log(e?e.state:"none")}).catch(()=>console.log("?"))' 2>/dev/null | tr -d '\r')
  if [ "$ST" = "failed" ]; then echo "  ext state=failed"; break; fi
done
if [ $OK -ne 1 ]; then
  echo "!!! NOT ACTIVE, rollback !!!"
  docker exec coopanion sh -c "cd $EXT && tar xzf -" < "$BAK/ext-before.tar.gz"
  docker restart coopanion >/dev/null
  sleep 10
  echo "ROLLED-BACK from $BAK"
  exit 5
fi
echo "=== lamps ==="
docker exec coopanion node -e 'fetch("http://127.0.0.1:17789/api/worlds").then(r=>r.json()).then(j=>{const w=j.worlds.find(x=>x.id==="qqbot");console.log(JSON.stringify(w.lamps));})' 2>/dev/null
echo "=== md5 ==="
docker exec coopanion sh -c "md5sum $EXT/src/world.ts $EXT/src/config.ts; wc -c < $EXT/src/world.ts"
echo "=== log tail ==="
docker exec coopanion sh -c "tail -n 12 /data/logs/core.log" | cut -c1-160
echo "=== OK $LABEL ==="
