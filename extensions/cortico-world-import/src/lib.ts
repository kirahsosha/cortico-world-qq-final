/**
 * 导入扩展的核心逻辑（无 Cortico 依赖，可单独 node 跑）：
 *
 *   QQ 导出 .txt → records.jsonl → members/index.json + members/<qq>.json
 *
 * - 解析：deploy/pet/parse-qq-export.mjs 的 vendored 版本
 * - 聚合：deploy/pet/aggregate-members.mjs 的 vendored 版本
 * - 去重：`.done/<sha256>.json`，同内容文件永不重复导入
 * - 冷启动：只写 cortico-memory-export JSON，**不碰** memory 世界的 memory-data.json
 */
import { createHash } from 'node:crypto';
import {
  appendFileSync, createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import type { ImportConfig } from './config.ts';

export interface ChatRecord {
  ts: string;
  conv: string;
  convKind: 'group' | 'private';
  sender: string;
  qq: string | null;
  kind: 'msg' | 'system';
  text: string;
}

export interface DoneRecord {
  sha256: string;
  file: string;
  at: string;
  records: number;
  convs: number;
  minTs: string | null;
  maxTs: string | null;
}

export interface IndexRow {
  qq: string | null;
  name: string;
  msgs: number;
  last: string;
}

export interface Paths {
  /** 导入目录（.txt 与 .done/ 都在这）。 */
  importDir: string;
  /** records.jsonl 的落盘位置。 */
  recordsFile: string;
  /** 群友档案目录（index.json + <qq>.json）。 */
  membersDir: string;
}

export interface ScanRow {
  file: string;
  size: number;
  mtime: string;
  sha256: string;
  imported: boolean;
  importedAt?: string;
}

export interface RunResult {
  scanned: number;
  imported: number;
  skipped: number;
  records: number;
  members: number;
  memoryExport: string | null;
  details: Array<{ file: string; records: number; status: 'imported' | 'skipped' | 'failed'; error?: string }>;
}

/* ---------------- 基础工具 ---------------- */

export function sha256File(file: string): string {
  const h = createHash('sha256');
  h.update(readFileSync(file));
  return h.digest('hex');
}

export function pathsOf(cfg: ImportConfig, dataDir: string): Paths {
  const base = typeof cfg.importDir === 'string' && cfg.importDir.trim() ? cfg.importDir.trim() : '/data/import';
  const data = dataDir && dataDir.trim() ? dataDir : '/data/home/companion/data';
  return {
    importDir: base,
    recordsFile: join(data, 'records.jsonl'),
    membersDir: join(data, 'members'),
  };
}

export function ensureDirs(p: Paths): void {
  mkdirSync(p.importDir, { recursive: true });
  mkdirSync(join(p.importDir, '.done'), { recursive: true });
  mkdirSync(p.membersDir, { recursive: true });
}

/** 导入目录下的 .txt（不递归）。 */
export function listTxtFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => n.toLowerCase().endsWith('.txt'))
    .map((n) => join(dir, n))
    .filter((f) => {
      try { return statSync(f).isFile(); } catch { return false; }
    })
    .sort();
}

export function readDone(dir: string): Map<string, DoneRecord> {
  const out = new Map<string, DoneRecord>();
  const doneDir = join(dir, '.done');
  if (!existsSync(doneDir)) return out;
  for (const n of readdirSync(doneDir)) {
    if (!n.endsWith('.json')) continue;
    try {
      const d = JSON.parse(readFileSync(join(doneDir, n), 'utf8')) as DoneRecord;
      if (d && typeof d.sha256 === 'string') out.set(d.sha256, d);
    } catch { /* 坏记录忽略，允许重导 */ }
  }
  return out;
}

function writeDone(dir: string, d: DoneRecord): void {
  const doneDir = join(dir, '.done');
  mkdirSync(doneDir, { recursive: true });
  const file = join(doneDir, `${d.sha256}.json`);
  writeFileSync(file, `${JSON.stringify(d, null, 2)}\n`, 'utf8');
}

/** 清掉超过 retentionDays 的 .done 记录（0/负数 = 不清理）。 */
export function pruneDone(dir: string, retentionDays: number): number {
  if (!Number.isFinite(retentionDays) || retentionDays <= 0) return 0;
  const doneDir = join(dir, '.done');
  if (!existsSync(doneDir)) return 0;
  const cutoff = Date.now() - retentionDays * 86400_000;
  let removed = 0;
  for (const n of readdirSync(doneDir)) {
    if (!n.endsWith('.json')) continue;
    const f = join(doneDir, n);
    try {
      const d = JSON.parse(readFileSync(f, 'utf8')) as DoneRecord;
      const at = Date.parse(d.at);
      if (Number.isFinite(at) && at < cutoff) { unlinkSync(f); removed += 1; }
    } catch {
      /* 坏记录留着，下次覆盖 */
    }
  }
  return removed;
}

/* ---------------- 解析 QQ 导出 ---------------- */

const START = /^(\d{4}-\d{2}-\d{2} \d{1,2}:\d{2}:\d{2}) (.+)$/;
const SYSTEM_HINTS = ['撤回了一条消息', '向你发起临时会话', '以上是打招呼的内容', '消息记录'];

function splitSender(raw: string): { sender: string; qq: string | null } {
  const m = /^(.*?)[(（](\d{5,12})[)）]\s*$/.exec(raw);
  if (m) return { sender: m[1].trim() || m[2], qq: m[2] };
  return { sender: raw.trim(), qq: null };
}

function isoLocal(ts: string): string {
  const m = /^(\d{4}-\d{2}-\d{2}) (\d{1,2})(:\d{2}:\d{2})$/.exec(ts);
  const fixed = m ? `${m[1]} ${m[2].padStart(2, '0')}${m[3]}` : ts;
  return fixed.replace(' ', 'T');
}

/** 解析一个 QQ 导出 txt；格式见 parse-qq-export.mjs 头注释。 */
export async function parseQqExport(file: string): Promise<ChatRecord[]> {
  const out: ChatRecord[] = [];
  const rl = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  let conv = '';
  let convKind: 'group' | 'private' = 'private';
  let cur: { ts: string; sender: string; qq: string | null; lines: string[] } | null = null;
  const flush = () => {
    if (!cur) return;
    const text = cur.lines.join('\n').trim();
    if (text) {
      const kind = SYSTEM_HINTS.some((h) => text.includes(h)) ? 'system' : 'msg';
      out.push({ ts: isoLocal(cur.ts), conv, convKind, sender: cur.sender, qq: cur.qq, kind, text });
    }
    cur = null;
  };
  for await (let line of rl) {
    line = line.replace(/^\uFEFF/, '').replace(/\r$/, '');
    const trimmed = line.trim();
    // 头部两种写法都要认：`消息分组:…` 与 `============ 消息分组:… ============ 消息对象:… ============`
    if (/^=*\s*消息分组:/.test(trimmed)) {
      convKind = /消息分组:[^=]*群/.test(trimmed) ? 'group' : 'private';
      const obj = /消息对象:(.+?)(?:\s*=+|$)/.exec(trimmed);
      if (obj) { flush(); conv = obj[1].trim(); }
      continue;
    }
    if (/^=*\s*消息对象:/.test(trimmed)) {
      flush();
      const obj = /消息对象:(.+?)(?:\s*=+|$)/.exec(trimmed);
      conv = obj ? obj[1].trim() : trimmed.slice(trimmed.indexOf('消息对象:') + '消息对象:'.length).trim();
      continue;
    }
    if (trimmed.startsWith('消息记录（') || /^=+$/.test(trimmed) || trimmed === '') continue;
    const m = START.exec(trimmed);
    if (m) {
      flush();
      const { sender, qq } = splitSender(m[2]);
      cur = { ts: m[1], sender, qq, lines: [] };
      continue;
    }
    if (cur) cur.lines.push(line);
  }
  flush();
  return out;
}

/* ---------------- 聚合群友档案 ---------------- */

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

function clean(text: string): string {
  return text.replace(/@\S+/g, ' ').replace(/\[[^\]]{1,10}\]/g, ' ').replace(/\s+/g, ' ').trim();
}

function isValid(text: string): boolean {
  if (!text) return false;
  if (PLACEHOLDER_ONLY.test(text)) return false;
  if (NOISE.some((re) => re.test(text))) return false;
  return clean(text).length >= 2;
}

function cjkGrams(text: string): string[] {
  const s = clean(text).replace(/[^\u4e00-\u9fa5]/g, '');
  const out: string[] = [];
  for (let n = 2; n <= 4; n += 1) {
    for (let i = 0; i + n <= s.length; i += 1) out.push(s.slice(i, i + n));
  }
  return out;
}

interface Aggregated {
  qq: string | null;
  names: Set<string>;
  msgs: number;
  chars: number;
  validMsgs: number;
  first: string;
  last: string;
  convs: Set<string>;
  hours: Map<number, number>;
  grams: Map<string, number>;
  samples: string[];
}

/** 读 records.jsonl（或给定的记录数组）→ 写 members/index.json + members/<qq>.json。 */
export function aggregateMembers(records: ChatRecord[], membersDir: string, minMsgs = 5): IndexRow[] {
  const people = new Map<string, Aggregated>();
  for (const r of records) {
    if (r.kind === 'system') continue;
    const key = r.qq || `name:${r.sender}`;
    let p = people.get(key);
    if (!p) {
      p = {
        qq: r.qq, names: new Set(), msgs: 0, chars: 0, validMsgs: 0,
        first: r.ts, last: r.ts, convs: new Set(), hours: new Map(), grams: new Map(), samples: [],
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
    p.validMsgs += 1;
    p.chars += r.text.length;
    for (const g of cjkGrams(r.text)) if (!STOP.has(g)) p.grams.set(g, (p.grams.get(g) ?? 0) + 1);
    if (p.samples.length >= 200) p.samples.shift();
    p.samples.push(r.text.replace(/\s+/g, ' ').slice(0, 60));
  }

  mkdirSync(membersDir, { recursive: true });
  const index: IndexRow[] = [];
  for (const p of people.values()) {
    if (p.msgs < minMsgs) continue;
    const phrases = [...p.grams.entries()]
      .filter(([, n]) => n >= PHRASE_MIN)
      .sort((a, b) => b[1] - a[1])
      .slice(0, PHRASE_TOP)
      .map(([g, n]) => ({ g, n }));
    const activeHours = [...p.hours.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([h]) => h);
    const name = [...p.names].sort((a, b) => b.length - a.length)[0] ?? p.qq ?? 'unknown';
    const safe = String(p.qq ?? name).replace(/[\\/:*?"<>|\s]/g, '_');
    const file = join(membersDir, `${safe}.json`);
    // 已有档案的 llm 字段（LLM 画像）不要被重新聚合冲掉
    let llm: unknown = null;
    try { llm = JSON.parse(readFileSync(file, 'utf8')).llm ?? null; } catch { /* 新档案 */ }
    const profile: Record<string, unknown> = {
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
    if (llm) profile.llm = llm;
    writeFileSync(file, `${JSON.stringify(profile, null, 2)}\n`, 'utf8');
    index.push({ qq: p.qq, name, msgs: p.msgs, last: p.last });
  }
  index.sort((a, b) => b.msgs - a.msgs);
  writeFileSync(join(membersDir, 'index.json'), `${JSON.stringify(index, null, 2)}\n`, 'utf8');
  return index;
}

/* ---------------- 记忆冷启动包 ---------------- */

/** 生成 cortico-memory-export（specVersion 1）里的最小合法包；不写 memory-data.json。 */
export function buildMemoryExport(membersDir: string, source: string): Record<string, unknown> {
  // 注意：这里输出的是 memory 世界「存储层」的真实形状（fact-store 的 Fact 是
  // {hash,text,confidence,createdAt,updatedAt}，memory 的四个子字段都是 scope→值 的映射），
  // 不是文档里的抽象 schema——mem_transfer(import) 会把它原样 merge 进 store。
  const scope = 'import:members';
  const now = Math.round(Date.now() / 1000);
  const texts: string[] = [];
  try {
    const idx = JSON.parse(readFileSync(join(membersDir, 'index.json'), 'utf8')) as IndexRow[];
    for (const m of idx) {
      const safe = String(m.qq ?? m.name).replace(/[\\/:*?"<>|\s]/g, '_');
      let p: { msgs?: number; llm?: Record<string, unknown> } = {};
      try { p = JSON.parse(readFileSync(join(membersDir, `${safe}.json`), 'utf8')); } catch { /* 缺失跳过 */ }
      const l = (p.llm ?? {}) as {
        summary?: string; catchphrases?: string[]; topics?: string[]; tone?: string;
        relations?: Array<{ who: string; how: string }>; activeTime?: string;
      };
      const b = [
        `${m.name}（QQ ${m.qq ?? '未知'}）`,
        l.summary ? `画像：${l.summary}` : '',
        l.catchphrases?.length ? `口头禅：${l.catchphrases.join('/')}` : '',
        l.topics?.length ? `常聊：${l.topics.join('/')}` : '',
        l.tone ? `语气：${l.tone}` : '',
        l.relations?.length ? `关系：${l.relations.map((r) => `${r.who}-${r.how}`).join('；')}` : '',
        l.activeTime ? `活跃：${l.activeTime}` : '',
        `发言 ${p.msgs ?? m.msgs} 条`,
      ].filter(Boolean);
      texts.push(`${b.join('；')}（来源：${source}）`);
    }
  } catch { /* 没有档案就输出空包 */ }
  const facts = texts.map((text) => ({
    hash: createHash('sha256').update(`${scope}:${text}`).digest('hex'),
    text,
    confidence: 0.8,
    createdAt: now,
    updatedAt: now,
  }));
  return {
    format: 'cortico-memory-export',
    specVersion: 1,
    plugin: 'cortico-world-import',
    exportedAt: new Date().toISOString(),
    scope: 'ALL',
    backend: 'json',
    memory: { store: {}, summary: {}, topic: {}, notes: {} },
    facts: { scopes: { [scope]: facts } },
    vectors: { model: null, vectors: {} },
    knowledge: { entries: [] },
    reflection: { reflections: [], rules: [], stats: {} },
    persona: { personas: {}, globalStyle: '' },
    profiles: {},
  };
}

/* ---------------- 三个动作 ---------------- */

export function scan(cfg: ImportConfig, p: Paths): ScanRow[] {
  ensureDirs(p);
  const done = readDone(p.importDir);
  return listTxtFiles(p.importDir).map((f) => {
    const st = statSync(f);
    const sha = sha256File(f);
    const d = done.get(sha);
    return {
      file: f.split(/[\\/]/).pop() ?? f,
      size: st.size,
      mtime: new Date(st.mtimeMs).toISOString(),
      sha256: sha,
      imported: Boolean(d),
      ...(d ? { importedAt: d.at } : {}),
    };
  });
}

function readAllRecords(file: string): ChatRecord[] {
  if (!existsSync(file)) return [];
  const out: ChatRecord[] = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line) as ChatRecord); } catch { /* 跳过坏行 */ }
  }
  return out;
}

/** 导入目录里所有没导入过的 .txt：解析 → 追加 records.jsonl → 重新聚合 → 可选写记忆包。 */
export async function runImport(cfg: ImportConfig, p: Paths): Promise<RunResult> {
  ensureDirs(p);
  const pruned = pruneDone(p.importDir, Number(cfg.retentionDays) || 0);
  if (pruned) console.log(`[import] 清理过期 .done 记录 ${pruned} 条`);
  const done = readDone(p.importDir);
  const files = listTxtFiles(p.importDir);
  const result: RunResult = { scanned: files.length, imported: 0, skipped: 0, records: 0, members: 0, memoryExport: null, details: [] };

  for (const file of files) {
    const name = file.split(/[\\/]/).pop() ?? file;
    const sha = sha256File(file);
    if (done.has(sha)) {
      result.skipped += 1;
      result.details.push({ file: name, records: 0, status: 'skipped' });
      continue;
    }
    try {
      const recs = await parseQqExport(file);
      const msgs = recs.filter((r) => r.kind !== 'system');
      if (!msgs.length) {
        result.details.push({ file: name, records: 0, status: 'failed', error: '没有解析出消息（格式不是 QQ 导出？）' });
        continue;
      }
      appendFileSync(p.recordsFile, recs.map((r) => `${JSON.stringify(r)}\n`).join(''), 'utf8');
      const convs = new Set(msgs.map((r) => r.conv));
      const ts = msgs.map((r) => r.ts).sort();
      writeDone(p.importDir, {
        sha256: sha, file: name, at: new Date().toISOString(), records: recs.length,
        convs: convs.size, minTs: ts[0] ?? null, maxTs: ts[ts.length - 1] ?? null,
      });
      result.imported += 1;
      result.records += recs.length;
      result.details.push({ file: name, records: recs.length, status: 'imported' });
    } catch (e) {
      result.details.push({ file: name, records: 0, status: 'failed', error: e instanceof Error ? e.message : String(e) });
    }
  }

  const all = readAllRecords(p.recordsFile);
  const index = aggregateMembers(all, p.membersDir, Math.max(1, Number(cfg.minMsgs) || 5));
  result.members = index.length;

  if (cfg.memoryExport && result.imported > 0) {
    const bundle = buildMemoryExport(p.membersDir, `import:${new Date().toISOString().slice(0, 10)}`);
    const out = join(p.importDir, `memory-export-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    writeFileSync(out, `${JSON.stringify(bundle, null, 2)}\n`, 'utf8');
    result.memoryExport = out;
  }
  return result;
}

export interface StatsResult {
  importDir: string;
  txtFiles: number;
  doneRecords: number;
  records: number;
  members: number;
  lastImport: string | null;
  recordsFile: string;
}

export function stats(p: Paths): StatsResult {
  const done = readDone(p.importDir);
  const records = readAllRecords(p.recordsFile);
  let members = 0;
  try {
    const idx = JSON.parse(readFileSync(join(p.membersDir, 'index.json'), 'utf8')) as unknown[];
    members = Array.isArray(idx) ? idx.length : 0;
  } catch { /* 没有档案 */ }
  const last = [...done.values()].map((d) => d.at).sort().pop() ?? null;
  return {
    importDir: p.importDir,
    txtFiles: listTxtFiles(p.importDir).length,
    doneRecords: done.size,
    records: records.length,
    members,
    lastImport: last,
    recordsFile: p.recordsFile,
  };
}
