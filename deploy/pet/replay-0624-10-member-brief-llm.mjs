/**
 * 重放 10（0.6.24 基线）：群友档案注入升级 + qq_member_profile 工具
 *
 * 相对 replay-0624-6（口头禅版 memberBrief）：
 *   1. memberBrief 改用每个人的 `llm.summary`（LLM 画像文字），没有再退回口头禅；仍截断 1000 字
 *   2. 新增 `qq_member_profile` 工具 + `memberProfile()`：按 QQ 号或昵称查单人完整档案
 *      （画像/口头禅/常聊/语气/关系/活跃/高频片段）
 *
 * 幂等：文件里同时存在 `qq_member_profile` 与「llm.summary 模式」就直接跳过。
 * 锚点全部来自官方 0.6.24 的 src/world.ts（qq.unread 声明/取值、unreadSummary、组装工具表）。
 *
 * 用法: node deploy/pet/replay-0624-10-member-brief-llm.mjs <qq世界包目录> [--dry-run]
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const snippetDir = join(here, 'replay-0624-10');
const load = (name) => `${readFileSync(join(snippetDir, name), 'utf8').replace(/\r\n/g, '\n').trimEnd()}\n\n`;

const argv = process.argv.slice(2);
const pkg = argv.find((a) => !a.startsWith('--'));
const dryRun = argv.includes('--dry-run');
if (!pkg) {
  console.error('用法: node deploy/pet/replay-0624-10-member-brief-llm.mjs <qq世界包目录> [--dry-run]');
  process.exit(2);
}
for (const f of ['memberBrief.txt', 'memberProfile.txt', 'memberProfileTool.txt']) {
  if (!existsSync(join(snippetDir, f))) {
    console.error(`缺少补丁片段: ${join(snippetDir, f)}`);
    process.exit(2);
  }
}

const file = join(pkg, 'src/world.ts');
const raw = readFileSync(file, 'utf8');
const crlf = raw.includes('\r\n');
let s = raw.replace(/\r\n/g, '\n');
const steps = [];

if (s.includes("name: 'qq_member_profile'") && s.includes('llm.summary 模式')) {
  console.log('已打过 replay-10（qq_member_profile + llm.summary），跳过');
  process.exit(0);
}

/* 1) prompt 变量声明 */
if (!s.includes("name: 'qq.memberBrief'")) {
  const anchor = `            { name: 'qq.unread', description: '未读摘要。' },`;
  if (!s.includes(anchor)) throw new Error('qq.unread 声明锚点缺失');
  s = s.replace(anchor, `${anchor}
            { name: 'qq.memberBrief', description: '群友档案速查：发言量靠前的人的画像摘要，供参考、不必刻意提起。', multiline: true },`);
  steps.push('声明 qq.memberBrief 变量');
}

/* 2) prompt 变量取值 */
if (!s.includes("'qq.memberBrief': this.memberBrief()")) {
  const anchor = `      'qq.unread': this.unreadSummary(),`;
  if (!s.includes(anchor)) throw new Error('qq.unread 取值锚点缺失');
  s = s.replace(anchor, `${anchor}
      'qq.memberBrief': this.memberBrief(),`);
  steps.push('接上 qq.memberBrief 取值');
}

/* 3) memberBrief 方法：有旧版（replay-6 之前）就替换，没有就插到 memberProfile/unreadSummary 前面 */
const brief = load('memberBrief.txt');
if (s.includes('  /** 群友档案速查：')) {
  const start = s.indexOf('  /** 群友档案速查：');
  const endMarker = s.includes('  /** 单人完整档案：') ? '  /** 单人完整档案：' : '  private unreadSummary(';
  const end = s.indexOf(endMarker, start);
  if (end < 0) throw new Error('memberBrief 结束锚点缺失');
  s = `${s.slice(0, start)}${brief}${s.slice(end)}`;
  steps.push('替换 memberBrief 为 llm.summary 版');
} else {
  const at = s.includes('  /** 单人完整档案：') ? s.indexOf('  /** 单人完整档案：') : s.indexOf('  private unreadSummary(');
  if (at < 0) throw new Error('memberBrief 插入锚点缺失');
  s = `${s.slice(0, at)}${brief}${s.slice(at)}`;
  steps.push('插入 memberBrief（llm.summary 版）');
}

/* 4) memberProfile 方法 */
if (!s.includes('  /** 单人完整档案：')) {
  const at = s.indexOf('  private unreadSummary(');
  if (at < 0) throw new Error('memberProfile 插入锚点缺失');
  s = `${s.slice(0, at)}${load('memberProfile.txt')}${s.slice(at)}`;
  steps.push('插入 memberProfile()');
}

/* 5) 工具定义 */
if (!s.includes('const memberProfileTool: ToolDef')) {
  const at = s.indexOf('    /*\n     * 组装所有工具。');
  if (at < 0) throw new Error('工具表锚点缺失（组装所有工具）');
  s = `${s.slice(0, at)}${load('memberProfileTool.txt')}${s.slice(at)}`;
  steps.push('插入 qq_member_profile 工具定义');
}

/* 6) 挂到工具数组 */
if (!s.includes('stickerTag, memberProfileTool')) {
  if (!s.includes('stickerTag, proactiveTool')) throw new Error('工具数组锚点缺失（stickerTag, proactiveTool）');
  s = s.replace('stickerTag, proactiveTool', 'stickerTag, memberProfileTool, proactiveTool');
  steps.push('把 qq_member_profile 挂进工具数组');
}

if (!steps.length) {
  console.log('没有需要改的地方');
  process.exit(0);
}
console.log(`将应用 ${steps.length} 步：`);
for (const x of steps) console.log(`  - ${x}`);

if (dryRun) {
  console.log('--dry-run：不写文件');
  process.exit(0);
}
const outText = crlf ? s.replace(/\n/g, '\r\n') : s;
writeFileSync(file, outText, 'utf8');
console.log(`已写入 ${file}（${raw.length} → ${outText.length} 字节）`);
