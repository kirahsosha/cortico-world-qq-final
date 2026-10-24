# cortico-world-import

Cortico World 扩展：把 **QQ 导出的聊天记录 `.txt`** 导入成 bot 能用的本地档案。

```
/data/import/*.txt
   │  parse（parse-qq-export 的 vendored 版本）
   ▼
/data/home/companion/data/records.jsonl        ← 逐行 JSON，追加写
   │  aggregate（aggregate-members 的 vendored 版本）
   ▼
/data/home/companion/data/members/index.json
/data/home/companion/data/members/<qq>.json    ← 统计 + 原样保留已有 llm 画像
   │  （可选）冷启动包
   ▼
/data/import/memory-export-<ts>.json           ← cortico-memory-export，交给 mem_transfer(import)
```

## 它刻意不做的事

- **不写** memory 世界的 `memory-data.json`：那个文件有内存态 + 防抖落盘，外部写入会被覆盖。
  要给记忆做冷启动，就用生成的 `cortico-memory-export` 包，让用户执行
  `mem_transfer(action=import, file=/data/import/memory-export-....json)`。
- 不递归子目录、不猜编码：QQ 导出就是 UTF-8 `.txt`，其它格式请先转换。
- 不调 LLM。LLM 画像由 `deploy/pet/llm-member-profiles.mjs` 离线补（写 `llm` 字段），
  重新聚合时本扩展会原样保留已有的 `llm` 字段。

## 配置（`worlds.import.*`）

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `false` | 是否启用本 World（由部署的 worlds 列表决定） |
| `importDir` | `/data/import` | 导入目录，放 QQ 导出的 `.txt` |
| `scanMinutes` | `30` | 自动扫描间隔（分钟）；`0` = 关闭 |
| `retentionDays` | `30` | `.done/` 去重记录保留天数 |
| `autoRun` | `true` | 扫到新文件自动导入 |
| `minMsgs` | `5` | 聚合档案的最小发言条数 |
| `memoryExport` | `true` | 导入后写一份记忆冷启动包 |

## 工具

`chat_import(action=scan|run|stats)`

- `scan`：列出 `.txt`、大小、是否已导入（按 sha256）
- `run`：导入未导入的文件 → 追加 records.jsonl → 重新聚合 members/ → 写记忆包
- `stats`：导入目录 / 已导入文件数 / 总消息数 / 档案人数 / 最近导入时间

## 去重

每个文件导入成功后写 `.done/<sha256>.json`（含文件名、条数、会话数、时间范围）。
同内容文件改名再放进来也不会重复导入；超过 `retentionDays` 的记录会被清理，允许重导。

## 安装（本地包）

Core 的扩展目录是 pnpm 布局，最简单的做法是把它当成一个独立包发布/打包后走扩展页安装：

```bash
cd extensions/cortico-world-import
npm pack                      # 产出 cortico-world-import-0.1.0.tgz
# 控制台：POST /api/extensions/install {"name":"cortico-world-import","version":"0.1.0"}
```

如果只是本机试用，也可以把整个目录复制到容器里再登记（重启后生效）：

```bash
docker cp extensions/cortico-world-import coopanion:/data/extensions/node_modules/cortico-world-import
docker exec -u 0 coopanion chown -R 1000:1000 /data/extensions/node_modules/cortico-world-import
# 然后在 config.json 的 worlds 里加 "import": { "enabled": true, ... }
```

> 不建议直接塞进 `.pnpm` store：pnpm 重装会把它清掉。

## 与 QQ 世界 / memory 的配合

1. 导入档案后，QQ 世界的 `qq.memberBrief` 和 `qq_member_profile` 会读 `members/`，
   要让新档案进 system 前缀，调一次 `POST /api/session/reload-prefix`（或重启容器）。
2. 想让 LLM 画像更准，跑一次 `deploy/pet/llm-member-profiles.mjs`（读同一份 records.jsonl），
   它只写 `llm` 字段，不碰统计字段。
3. 记忆冷启动：把 `memory-export-*.json` 交给 `mem_transfer(import)`，不要手写 `memory-data.json`。
