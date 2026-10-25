# Core 侧补丁（卡死观测 / 自愈 / profile）

> 2026-10-25 起因：Core 主线程 100% CPU 空转、`/api/worlds` 无响应，只能人工重启。根因未定位。

## 文件

| 文件 | 部署到 | 作用 |
|---|---|---|
| `boot.ts` | `/opt/Coopanion/resources/app/core/boot.ts` | 事件循环卡顿日志（>3s 打 `[loop-lag]`）、未捕获异常完整栈、按需 inspector（`/data/logs/.inspect-on` 存在时开 127.0.0.1:9229） |
| `hang-profile.mjs` | `/data/hang-profile.mjs` | 连 9229 抓 N 秒 CPU profile 存 `/data/logs/hang-<ts>.cpuprofile` |
| `watchdog-heal.sh` | `/data_n005/coopanion/watchdog-heal.sh` | 每 2 分钟检查；连续 3 次异常 → 先抓 profile → 删 `instance.lock` → `docker restart` → 复查五世界 |

## 部署/回滚

```bash
# 备份
docker cp coopanion:/opt/Coopanion/resources/app/core/boot.ts backup/boot-<ts>.ts
# 覆盖 + 重启
docker cp deploy/core/boot.ts coopanion:/opt/Coopanion/resources/app/core/boot.ts
docker restart coopanion   # 等 45s 后验五世界
# 回滚
docker cp backup/boot-<ts>.ts coopanion:/opt/Coopanion/resources/app/core/boot.ts && docker restart coopanion
```

## 注意

- 关掉 inspector：`docker exec -u 0 coopanion rm /data/logs/.inspect-on` 后重启（端口只在容器内可达）
- 自愈会先抓 profile 再重启；`watchdog.log` 里能看到 `已保存 CPU profile /data/logs/hang-*.cpuprofile`
- 分析 profile：Chrome DevTools → Performance → Load profile，或 `node --prof-process`（需转格式）
