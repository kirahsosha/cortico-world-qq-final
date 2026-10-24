#!/usr/bin/env node
/**
 * 从 records.jsonl 聚合出群友档案。
 *
 *   node aggregate-members.mjs <records.jsonl> [--out-dir members] [--min-msgs 5]
 *
 * 产物：<out-dir>/index.json + <out-dir>/<qq>.json
 */
import { createReadStream, mkdirSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join, resolve } from 'node:path';

const args = process.argv.slice(2);
const input = resolve(args.find((a) => !a.startsWith('--')) ?? 'records.jsonl');
const outIdx = args.indexOf('--out-dir');
const outDir = resolve(outIdx >= 0 ? args[outIdx + 1] : 'members');
const minIdx = args.indexOf('--min-msgs');
const minMsgs = minIdx >= 0 ? Number(args[minIdx + 1]) || 5 : 5;

const PLACEHOLDER_ONLY = /^\[[^\]]{1,10}\]$/;
const NOISE = [/^\[大怨种\]/, /请使用最新版手机QQ/, /该用户通过/, /以上是打招呼/];
const STOP = new Set([
  '的了', '我们', '你们', '他们', '这个', '那个', '什么', '怎么', '就是', '不是',
  '可以', '没有', '知道', '现在', '还是', '这么', '那么', '一个', '已经', '应该',
  '然后', '所以', '但是', '好像', '不过', '时候', '直接', '还有', '今天', '自己',
  '这样', '那样', '因为', '如果', '虽然', '有点', '觉得', '一次', '一点', '确实',
]);
const PHRASE_MIN = 2;
const PHRASE_TOP = 12;

function clean(text) {
  return text
    .replace(/@\S+/g, ' ')
    .replace(/\[[^\]]{1,10}\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isValid(text) {
  if (!text) return false;
  if (PLACEHOLDER_ONLY.test(text)) return false;
  if (NOISE.some((re) => re.test(text))) return false;
  return clean(text).length >= 2;
}

function cjkGrams(text) {
  const s = clean(text).replace(/[^\u4e00-\u9fa5]/g, '');
  const out = [];
  for (let n = 2; n <= 4; n += 1) {
    for (let i = 0; i + n <= s.length; i += 1) out.push(s.slice(i, i + n));
  }
  return out;
}

const people = new Map();
let total = 0;
let valid = 0;

const rl = createInterface({ input: createReadStream(input, { encoding: 'utf8' }), crlfDelay: Infinity });
for await (const line of rl) {
  if (!line.trim()) continue;
  let r;
  try { r = JSON.parse(line); } catch { continue; }
  total += 1;
  if (r.kind === 'system') continue;

  const key = r.qq || `name:${r.sender}`;
  let p = people.get(key);
  if (!p) {
    p = {
      qq: r.qq ?? null,
      names: new Set(),
      msgs: 0, chars: 0, validMsgs: 0,
      first: r.ts, last: r.ts,
      convs: new Set(),
      hours: new Map(),
      grams: new Map(),
      samples: [],
    };
    people.set(key, p);
  }
  if (r.sender) p.names.add(r.sender);
  p.msgs += 1;
  p.convs.add(r.conv);
  if (r.ts < p.first) p.first = r.ts;
  if (r.ts > p.last) p.last = r.ts;
  const hour = Number(r.ts.slice(11, 13));
  if (Number.isFinite(hour)) p.hours.set(hour, (p.hours.get(hour) ?? 0) + 1);

  if (!isValid(r.text)) continue;
  valid += 1;
  p.validMsgs += 1;
  p.chars += r.text.length;
  for (const g of cjkGrams(r.text)) if (!STOP.has(g)) p.grams.set(g, (p.grams.get(g) ?? 0) + 1);
  if (p.samples.length >= 200) p.samples.shift();
  p.samples.push(r.text.replace(/\s+/g, ' ').slice(0, 60));
}

mkdirSync(outDir, { recursive: true });

const index = [];
let written = 0;
for (const p of people.values()) {
  if (p.msgs < minMsgs) continue;
  const phrases = [...p.grams.entries()]
    .filter(([, n]) => n >= PHRASE_MIN)
    .sort((a, b) => b[1] - a[1])
    .slice(0, PHRASE_TOP)
    .map(([g, n]) => ({ g, n }));
  const activeHours = [...p.hours.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([h]) => h);
  const name = [...p.names].sort((a, b) => b.length - a.length)[0] ?? p.qq ?? 'unknown';

  const profile = {
    qq: p.qq,
    names: [...p.names],
    msgs: p.msgs,
    chars: p.chars,
    avgLen: p.validMsgs ? Math.round(p.chars / p.validMsgs) : 0,
    first: p.first,
    last: p.last,
    convs: [...p.convs],
    activeHours,
    phrases,
    samples: p.samples.slice(-5),
    updatedAt: new Date().toISOString().slice(0, 19),
  };

  const safe = String(p.qq ?? name).replace(/[\\/:*?"<>|\s]/g, '_');
  writeFileSync(join(outDir, `${safe}.json`), `${JSON.stringify(profile, null, 2)}\n`, 'utf8');
  written += 1;
  index.push({ qq: p.qq, name, msgs: p.msgs, last: p.last });
}

index.sort((a, b) => b.msgs - a.msgs);
writeFileSync(join(outDir, 'index.json'), `${JSON.stringify(index, null, 2)}\n`, 'utf8');

console.error('---');
console.error(`读入 ${total} 条，有效 ${valid} 条`);
console.error(`人数 ${people.size}，写出 ${written} 份档案（>= ${minMsgs} 条）`);
console.error(`目录 ${outDir}`);

console.log('QQ'.padEnd(12), '昵称'.padEnd(16), '条数', ' 高频词');
for (const row of index.slice(0, 10)) {
  const p = people.get(row.qq || `name:${row.name}`);
  const top = (p?.grams ? [...p.grams.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([g]) => g) : []).join('/');
  console.log(String(row.qq).padEnd(12), row.name.slice(0, 14).padEnd(16), String(row.msgs).padStart(6), ' ' + top);
}
