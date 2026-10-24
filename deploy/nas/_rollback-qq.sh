#!/bin/bash
# 回滚 QQ 世界扩展：把指定 tar 包解回扩展目录 -> 重启 -> 轮询五世界
# 用法: bash /data_n005/coopanion/_rollback-qq.sh <包.tgz>
set -u
TGZ="$1"
EXT=/data/extensions/node_modules/cortico-world-qq-final
BAK=/data_n005/coopanion/backup/rollback-$(date +%Y%m%d-%H%M%S)
mkdir -p "$BAK"
echo "=== 先备份当前状态到 $BAK ==="
docker exec coopanion sh -c "cd $EXT && tar czf - ." > "$BAK/before.tgz"
ls -l "$BAK" | tail -1

echo "=== 解包覆盖 $TGZ ==="
docker cp "$TGZ" coopanion:/data/_rb.tgz || exit 2
docker exec -u 0 coopanion sh -c "cd $EXT && tar xzf /data/_rb.tgz" || exit 3
docker exec coopanion sh -c "md5sum $EXT/src/world.ts $EXT/src/config.ts; wc -c < $EXT/src/world.ts"

echo "=== 重启 + 轮询 ==="
docker restart coopanion >/dev/null
OK=0
for i in $(seq 1 30); do
  sleep 4
  OUT=$(docker exec coopanion node -e 'const want=["console","desktop-pet","coopanion","memory","qqbot"];fetch("http://127.0.0.1:17789/api/worlds").then(r=>r.json()).then(j=>{const got=new Map(j.worlds.map(w=>[w.id,w.status]));const bad=want.filter(id=>got.get(id)!=="active");console.log(bad.length?("BAD "+bad.map(id=>id+"="+(got.get(id)||"missing")).join(" ")):"ALL-ACTIVE")}).catch(e=>console.log("ERR"))' 2>/dev/null | tr -d '\r')
  echo "  [$((i*4))s] $OUT"
  if [ "$OUT" = "ALL-ACTIVE" ]; then OK=1; break; fi
done
[ $OK -eq 1 ] && echo "=== ROLLBACK OK ===" || echo "=== ROLLBACK 后仍未全 active，请人工检查 ==="
