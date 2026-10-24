# deploy/

QQ 世界在 NAS 上的部署与迁移工具（对应 AI-交接纪要 §13/§14）。

## pet/  补丁与离线工具
- `replay-0624-{1..9}-*.mjs`  以上游 0.6.24 为基线重放 6 功能 + 3 修复（顺序 1→9）
- `parse-qq-export.mjs`       QQ 导出 txt → records.jsonl
- `aggregate-members.mjs`     records.jsonl → members/*.json 群友档案
- `patch-member-brief.mjs`    qq.memberBrief 提示词变量

## nas/  服务器侧脚本
- `_apply0624.sh <label> <tgz>`  备份 → 语法检查 → 落盘(cat>跟随硬链接) → 重启 → 轮询五世界 → 失败自动回滚
- `_rollback-qq.sh <tgz>`        回滚到指定发布包

## 铁律
1. 一步一部署，qqbot 不是 active 就停手排查
2. 不要 rsync/cp 整个 src 覆盖扩展目录（符号/硬链接布局会被破坏）
3. 不要改 /data/extensions/package.json 里的 0.6.9 依赖
