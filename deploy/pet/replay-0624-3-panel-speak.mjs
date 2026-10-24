/**
 * 重放 3/6（0.6.24 基线）：让「群聊限速」tab 的说明反映合并后的语义
 *
 * 对应 deploy/pet/patch-panel-speak.mjs。原脚本的锚点是「group-speak + listen 两行」，
 * 并把 tab 指向独立组 world:qqbot-push + 空前缀——那是中间版本的做法，后来（仓库里 5e78931/b48b14f 之后）
 * 改成了「同一个 QQ_CONFIG_GROUP + prefix worlds.qqbot.groupSpeak.」，官方 0.6.9 也是后者。
 * 所以这里只做该版本等价的最小改动：保留 group/prefix，只把说明改成「哪些消息进来 + 说多少」。
 * 「群消息采样」tab 在官方 0.6.9 里本来就不存在，无需删除。
 *
 * 用法: node deploy/pet/replay-0624-3-panel-speak.mjs <qq世界包目录>
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const pkg = process.argv[2];
if (!pkg) { console.error('用法: node replay-069-3-panel-speak.mjs <qq世界包目录>'); process.exit(2); }

const file = join(pkg, 'src/world.ts');
const raw = readFileSync(file, 'utf8');
const crlf = raw.includes('\r\n');
let s = raw.replace(/\r\n/g, '\n');

const before = `      { id: 'group-speak', title: '群聊限速', description: '限制每个群在单位窗口内被 bot 发出的消息总量，防刷屏/死循环。', group: 'world:qqbot', prefix: 'worlds.qqbot.groupSpeak.', topOnly: false },`;
if (!s.includes(before)) { console.error('panel 锚点缺失（group-speak 行变了？）'); process.exit(3); }

const after = `      { id: 'group-speak', title: '群聊限速', description: '群消息进不进来（采样率/采样冷却/点名识别词/推送脚本）与 bot 说多少（窗口内条数）。改完即时生效。', group: 'world:qqbot', prefix: 'worlds.qqbot.groupSpeak.', topOnly: false },`;
if (s.includes(after)) { console.log('panel 已改过'); process.exit(0); }

s = s.replace(before, after);
writeFileSync(file, crlf ? s.replace(/\n/g, '\r\n') : s, 'utf8');
console.log('world.ts：群聊限速 tab 说明已更新为合并语义（group/prefix 不变，仍是 7 项）');
