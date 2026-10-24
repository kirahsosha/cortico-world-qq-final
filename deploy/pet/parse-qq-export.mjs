#!/usr/bin/env node
/**
 * 解析 QQ 导出的聊天记录 txt → JSONL。
 *
 *   node parse-qq-export.mjs <文件或目录>... [--out records.jsonl] [--verbose]
 *
 * 格式（QQ 客户端导出）：
 *   消息记录（…）
 *   ============ 消息分组:… ============ 消息对象:… ============
 *   2024-04-26 18:29:20 乌冬(675287246)
 *   正文…
 *   （空行分隔）
 *
 * 输出每行：{ts, conv, convKind, sender, qq, kind, text}
 */
import { createReadStream, createWriteStream, existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';

const args = process.argv.slice(2);
const verbose = args.includes('--verbose');
const outIdx = args.indexOf('--out');
const outPath = outIdx >= 0 ? resolve(args[outIdx + 1]) : resolve('records.jsonl');
const inputs = args.filter((a, i) => !a.startsWith('--') && (outIdx < 0 || i !== outIdx + 1));

const START = /^(\d{4}-\d{2}-\d{2} \d{1,2}:\d{2}:\d{2}) (.+)$/;
const SYSTEM_HINTS = ['撤回了一条消息', '向你发起临时会话', '以上是打招呼的内容', '消息记录'];

function collectTxt(p, out) {
  const st = statSync(p);
  if (st.isDirectory()) {
    for (const name of readdirSync(p)) {
      if (name.toLowerCase().endsWith('.txt')) collectTxt(join(p, name), out);
    }
  } else if (p.toLowerCase().endsWith('.txt')) {
    out.push(p);
  }
  return out;
}

function splitSender(raw) {
  const m = /^(.*?)[(（](\d{5,12})[)）]\s*$/.exec(raw);
  if (m) return { sender: m[1].trim() || m[2], qq: m[2] };
  return { sender: raw.trim(), qq: null };
}

function isoLocal(ts) {
  // QQ 导出偶尔是 8:09:22（小时不补零），统一补成两位再转 ISO
  const m = /^(\d{4}-\d{2}-\d{2}) (\d{1,2})(:\d{2}:\d{2})$/.exec(ts);
  const fixed = m ? `${m[1]} ${m[2].padStart(2, '0')}${m[3]}` : ts;
  return fixed.replace(' ', 'T');
}

async function parseFile(file, onRecord) {
  const rl = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });

  let conv = '';
  let convKind = 'private';
  let cur = null;          // { ts, sender, qq, lines[] }
  let inBody = false;

  const flush = () => {
    if (!cur) return;
    const text = cur.lines.join('\n').trim();
    const kind = SYSTEM_HINTS.some((h) => text.includes(h)) ? 'system' : 'msg';
    if (text) {
      onRecord({
        ts: isoLocal(cur.ts),
        conv,
        convKind,
        sender: cur.sender,
        qq: cur.qq,
        kind,
        text,
      });
    }
    cur = null;
  };

  for await (let line of rl) {
    line = line.replace(/^\uFEFF/, '').replace(/\r$/, '');
    const trimmed = line.trim();

    if (trimmed.startsWith('消息分组:')) { convKind = trimmed.includes('群') ? 'group' : 'private'; continue; }
    if (trimmed.startsWith('消息对象:')) { flush(); conv = trimmed.slice('消息对象:'.length).trim(); continue; }
    if (trimmed.startsWith('消息记录（') || /^=+$/.test(trimmed) || trimmed === '') { continue; }

    const m = START.exec(trimmed);
    if (m) {
      flush();
      const { sender, qq } = splitSender(m[2]);
      cur = { ts: m[1], sender, qq, lines: [] };
      inBody = true;
      continue;
    }

    if (cur && inBody) cur.lines.push(line);
  }
  flush();
}

const files = [];
for (const p of inputs) {
  const abs = resolve(p);
  if (!existsSync(abs)) { console.error('跳过（不存在）:', abs); continue; }
  collectTxt(abs, files);
}
if (!files.length) { console.error('没有找到 .txt 文件'); process.exit(1); }

const out = createWriteStream(outPath, { encoding: 'utf8' });
let total = 0, sys = 0;
const convs = new Set();
const senders = new Set();
let minTs = null, maxTs = null;

for (const f of files) {
  const before = total;
  await parseFile(f, (rec) => {
    total += 1;
    if (rec.kind === 'system') sys += 1;
    convs.add(rec.conv);
    senders.add(rec.qq || rec.sender);
    if (!minTs || rec.ts < minTs) minTs = rec.ts;
    if (!maxTs || rec.ts > maxTs) maxTs = rec.ts;
    out.write(`${JSON.stringify(rec)}\n`);
  });
  if (verbose) console.error(`  ${f}: +${total - before} 条`);
}

await new Promise((r) => out.end(r));

console.error('---');
console.error(`文件      : ${files.length}`);
console.error(`会话      : ${convs.size}`);
console.error(`消息      : ${total}（其中 system ${sys}）`);
console.error(`发送者    : ${senders.size}`);
console.error(`时间范围  : ${minTs} ~ ${maxTs}`);
console.log(`-> ${outPath}（${total} 行）`);
