#!/usr/bin/env node
/**
 * 群友档案 LLM 分析（离线批处理）
 *
 * 从 records.jsonl 给每个人抽 ~150 条样本（最近 + 随机 + 专属片段命中 + 互动），
 * 调 bot 同款 provider，产出 {summary, catchphrases, topics, tone, relations, activeTime}
 * 写回 <members>/<key>.json 的 llm 字段；原有 stats/phrases/samples 字段保持不动。
 *
 * 用法：
 *   node llm-member-profiles.mjs [--dry-run] [--only 380741085] [--limit 3]
 *     [--records /data/home/companion/data/records.jsonl]
 *     [--members /data/home/companion/data/members]
 *     [--provider /data/home/providers/deepseek]
 *     [--model deepseek-flash] [--base-url https://api.deepseek.com]
 *     [--concurrency 2] [--max-samples 150] [--bot-names 鲸鲸] [--out <dir>]
 *
 * 凭据只从 <provider>/.env → /data/home/companion/.env → 环境变量 读，不落盘、不打印。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/* ---------------- 参数 ---------------- */
function parseArgs(argv) {
  const o = {
    records: '/data/home/companion/data/records.jsonl',
    members: '/data/home/companion/data/members',
    provider: '/data/home/providers/deepseek',
    model: '',
    baseUrl: '',
    only: [],
    limit: 0,
    concurrency: 2,
    dryRun: false,
    maxSamples: 150,
    botNames: ['鲸鲸'],
    out: '',
    skipSystem: true,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--records') o.records = next();
    else if (a === '--members') o.members = next();
    else if (a === '--provider') o.provider = next();
    else if (a === '--model') o.model = next();
    else if (a === '--base-url') o.baseUrl = next();
    else if (a === '--only') o.only = String(next() || '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--limit') o.limit = Number(next()) || 0;
    else if (a === '--concurrency') o.concurrency = Math.max(1, Number(next()) || 1);
    else if (a === '--max-samples') o.maxSamples = Math.max(20, Number(next()) || 150);
    else if (a === '--bot-names') o.botNames = String(next() || '').split(/[,，\s]+/).filter(Boolean);
    else if (a === '--out') o.out = next();
    else if (a === '--dry-run') o.dryRun = true;
    else if (a === '--keep-system') o.skipSystem = false;
    else if (a === '--help' || a === '-h') { console.log('see header'); process.exit(0); }
    else throw new Error(`未知参数: ${a}`);
  }
  return o;
}

/* ---------------- 小工具 ---------------- */
const isCJK = (s) => /^[\u4e00-\u9fa5]+$/.test(s);
const nowIso = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}${sign}${p(Math.floor(Math.abs(off) / 60))}:${p(Math.abs(off) % 60)}`;
};

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(arr, rand) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const NOISE = ['撤回了一条消息', '向你发起临时会话', '以上是打招呼', '请使用最新版手机QQ', '该用户通过',
  '发起了语音通话', '邀请你加入', '加入了群聊', '拍了拍', '上传了', '戳了戳', '群公告', '【DSH', '【鲸鲸告警】'];
const PLACEHOLDER = /^\[[^\]]{1,12}\]$/;

function cleanText(t) {
  return String(t).replace(/\s+/g, ' ').trim();
}
function useful(r) {
  if (!r || r.kind === 'system') return false;
  const t = cleanText(r.text || '');
  if (!t || t.length < 2 || t.length > 200) return false;
  if (PLACEHOLDER.test(t)) return false;
  if (NOISE.some((n) => t.includes(n))) return false;
  return true;
}

/** 2..6 字连续汉字片段 */
function grams(text, out) {
  const s = cleanText(text).replace(/@\S+/g, ' ').replace(/\[[^\]]{1,12}\]/g, ' ').replace(/[^\u4e00-\u9fa5]/g, '');
  for (let n = 2; n <= 6; n += 1) {
    for (let i = 0; i + n <= s.length; i += 1) {
      const g = s.slice(i, i + n);
      if (isCJK(g)) out.set(g, (out.get(g) || 0) + 1);
    }
  }
}

const samplesText = (arr) => arr.map((r) => r.text).join('\n');

/* ---------------- provider ---------------- */
function loadProvider(o) {
  const cfgPath = join(o.provider, 'config.json');
  const cfg = existsSync(cfgPath) ? JSON.parse(readFileSync(cfgPath, 'utf8')) : {};
  const secretName = cfg.secret || 'DEEPSEEK_API_KEY';
  let key = '';
  for (const p of [join(o.provider, '.env'), '/data/home/companion/.env']) {
    if (!existsSync(p)) continue;
    for (const line of readFileSync(p, 'utf8').split('\n')) {
      const m = /^\s*([A-Za-z0-9_]+)\s*=\s*(.+?)\s*$/.exec(line);
      if (m && m[1] === secretName) { key = m[2].replace(/^["']|["']$/g, ''); break; }
    }
    if (key) break;
  }
  if (!key) key = process.env[secretName] || '';
  if (!key) throw new Error(`找不到密钥 ${secretName}（${o.provider}/.env 或 /data/home/companion/.env）`);
  const baseUrl = (o.baseUrl || cfg.baseUrl || 'https://api.deepseek.com').replace(/\/+$/, '');
  const model = o.model || cfg.spec?.model || 'deepseek-flash';
  return { key, baseUrl, model, url: `${baseUrl}/v1/chat/completions` };
}

const SYS_PROMPT = '你是 QQ 群聊观察员。只依据用户给的样本分析，不补充样本外的任何信息。';

function buildUserPrompt({ name, qq, msgs, avgLen, activeHours, stats, sampleLines, n }) {
  return `下面是群友「${name}」（QQ ${qq}）在群里的发言样本，共 ${n} 条，按时间排序。带「某某:」前缀的是别人说的话，其余是他自己说的。

【已有统计】他的高频片段（全量）：${stats}，总发言 ${msgs} 条，平均每句 ${avgLen} 字，最活跃时段 ${activeHours.join('、')} 点。

【硬性要求】
1. 只能依据样本里真实出现的内容，禁止推测、禁止编造（样本没提过的游戏/地点/职业/关系一律不写）。
2. catchphrases（口头禅/群内梗）必须是样本里作为连续字串出现 >=2 次的短语：
   - 不收「游戏」「一个」「就是」「什么」这类任何群都常见的通用词；
   - 不收单纯的错别字碎片（如「应为」「谓了」）；
   - 必须是能独立说出口的完整短语，不要从长句里截半句；不要把「别人昵称+普通动词」拼出来的半句当口头禅（如「蠢货带我」「让蠢货」这种不算）；
   - 但如果整个短语本身就是群内梗/称呼梗（如「哦鲸鲸」这类），即使带昵称也要收；
   - 优先收：他自己独有的、带昵称的、像群内梗的短句（哪怕只出现 2-3 次）；其次是他反复说的脏话/语气词口头禅；
   - 3~8 条，每条 2~6 字（最多 8 字），必须原样摘录样本里的字串。
3. summary：<=60 字，一句话说清「他是谁 / 说话什么路子 / 爱聊什么」，不要空话套话。
4. topics：他反复聊的话题，3~6 个，每个 2~6 字。
5. tone：说话风格，10~20 字。
6. relations：样本里能看出的关系，0~4 条，who 用样本里出现的昵称，how 说明关系（如「互怼」「带他打游戏」）。
7. activeTime：样本里他出没的时间段，如「晚上为主（17:00-24:00）」。

只输出 JSON，不要 markdown 代码块，不要解释：
{"summary":"...","catchphrases":["..."],"topics":["..."],"tone":"...","relations":[{"who":"...","how":"..."}],"activeTime":"..."}

【样本】
${sampleLines}`;
}

/* ---------------- 模型调用 ---------------- */
async function callModel(prov, messages, { jsonMode = true, noThink = true } = {}) {
  const body = { model: prov.model, messages, temperature: 0.3, max_tokens: 4000 };
  if (noThink) body.thinking = { type: 'disabled' };
  if (jsonMode) body.response_format = { type: 'json_object' };
  const res = await fetch(prov.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${prov.key}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(180000),
  });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  let j;
  try { j = JSON.parse(text); } catch { throw new Error('响应不是 JSON: ' + text.slice(0, 200)); }
  const ch = j.choices?.[0];
  const content = ch?.message?.content ?? '';
  const finish = ch?.finish_reason ?? '?';
  const reasoningLen = (ch?.message?.reasoning_content ?? '').length;
  if (!content && finish === 'length') throw new Error(`输出被截断（finish=length, reasoning=${reasoningLen}）`);
  return { content, usage: j.usage || {}, finish, reasoningLen, raw: j };
}

function extractJson(s) {
  let t = String(s || '').trim();
  t = t.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const a = t.indexOf('{');
  const b = t.lastIndexOf('}');
  if (a < 0 || b <= a) throw new Error('没有 JSON 对象');
  return JSON.parse(t.slice(a, b + 1));
}

/** 群友昵称（不含 bot）：出现在 catchphrase 里说明是称呼/半句，不是口头禅 */
let MEMBER_NAMES = [];

function validate(parsed, sampleBlob) {
  const out = {};
  out.summary = typeof parsed.summary === 'string' ? parsed.summary.trim().slice(0, 60) : '';
  const rawCatch = Array.isArray(parsed.catchphrases) ? parsed.catchphrases : [];
  const seen = new Set();
  out.catchphrases = [];
  for (const c of rawCatch) {
    if (typeof c !== 'string') continue;
    const v = c.trim();
    if (v.length < 2 || v.length > 8) continue;
    if (seen.has(v)) continue;
    if (MEMBER_NAMES.some((n) => v.includes(n))) { console.warn(`    ! 丢弃「${v}」：含群友昵称（是称呼/半句）`); continue; }
    if (/发起了|加入了|邀请了|拍了拍|上传了/.test(v)) continue;
    const n = sampleBlob.split(v).length - 1;
    if (n < 2) { console.warn(`    ! 丢弃「${v}」：样本里只出现 ${n} 次`); continue; }
    seen.add(v);
    out.catchphrases.push(v);
    if (out.catchphrases.length >= 8) break;
  }
  const rawTopics = Array.isArray(parsed.topics) ? parsed.topics : [];
  out.topics = rawTopics.filter((t) => typeof t === 'string' && t.trim().length >= 1).map((t) => t.trim().slice(0, 6)).slice(0, 6);
  out.tone = typeof parsed.tone === 'string' ? parsed.tone.trim().slice(0, 40) : '';
  const rawRel = Array.isArray(parsed.relations) ? parsed.relations : [];
  out.relations = rawRel
    .filter((r) => r && typeof r.who === 'string' && typeof r.how === 'string' && r.who.trim())
    .map((r) => ({ who: r.who.trim().slice(0, 20), how: r.how.trim().slice(0, 30) }))
    .slice(0, 4);
  out.activeTime = typeof parsed.activeTime === 'string' ? parsed.activeTime.trim().slice(0, 40) : '';
  return out;
}

/* ---------------- 主流程 ---------------- */
const opt = parseArgs(process.argv.slice(2));
const recordsPath = resolve(opt.records);
const membersDir = resolve(opt.out || opt.members);

console.log('=== llm-member-profiles ===');
console.log('records :', recordsPath);
console.log('members :', membersDir);
console.log('provider:', opt.provider);

let prov;
try {
  prov = loadProvider(opt);
} catch (e) {
  if (!opt.dryRun) throw e;
  prov = { key: '', baseUrl: '(dry-run)', model: opt.model || '(dry-run)', url: '' };
  console.log('dry-run: 跳过 provider 校验（' + e.message + '）');
}
console.log('model   :', prov.model, '@', prov.baseUrl);
console.log('dry-run :', opt.dryRun);

/* 读档案索引 */
const indexPath = join(membersDir, 'index.json');
if (!existsSync(indexPath)) throw new Error('缺少 index.json: ' + indexPath);
const index = JSON.parse(readFileSync(indexPath, 'utf8'));
MEMBER_NAMES = [...new Set(index.map((m) => String(m?.name || '').trim()).filter((n) => n.length >= 2 && !opt.botNames.includes(n)))];
const isSystem = (m) => m.qq === '10000' || m.qq === '1000000' || /系统消息/.test(m.name || '');
let targets = index.filter((m) => m && m.name && !(opt.skipSystem && isSystem(m)));
if (opt.only.length) targets = targets.filter((m) => opt.only.includes(String(m.qq)) || opt.only.includes(m.name));
if (opt.limit) targets = targets.slice(0, opt.limit);
console.log('index   :', index.length, '条，待分析', targets.length, '人');

/* 读记录 */
const lines = readFileSync(recordsPath, 'utf8').split('\n');
const recs = [];
for (const l of lines) {
  if (!l.trim()) continue;
  let r;
  try { r = JSON.parse(l); } catch { continue; }
  if (!useful(r)) continue;
  recs.push({ ts: r.ts || '', text: cleanText(r.text), qq: r.qq == null ? null : String(r.qq), sender: r.sender || '', conv: r.conv || '' });
}
console.log('records :', recs.length, '条有效');

/* 按人分组 */
const keyOf = (r) => (r.qq ? r.qq : `name:${r.sender}`);
const byKey = new Map();
for (const r of recs) {
  const k = keyOf(r);
  let arr = byKey.get(k);
  if (!arr) { arr = []; byKey.set(k, arr); }
  arr.push(r);
}

/* 候选片段：每人频次>=2 的 2..6 gram */
const targetKeys = targets.map((m) => (m.qq ? String(m.qq) : `name:${m.name}`));
const candidatePer = new Map();
const allCand = new Set();
for (const k of targetKeys) {
  const arr = byKey.get(k) || [];
  const m = new Map();
  for (const r of arr) grams(r.text, m);
  const cand = new Map([...m].filter(([, n]) => n >= 2));
  candidatePer.set(k, cand);
  for (const g of cand.keys()) allCand.add(g);
}
console.log('candidates:', allCand.size);

/* 全局：每个片段被多少个不同的人说过 */
const speakers = new Map();
for (const r of recs) {
  const k = keyOf(r);
  const m = new Map();
  grams(r.text, m);
  for (const g of m.keys()) {
    if (!allCand.has(g)) continue;
    let s = speakers.get(g);
    if (!s) { s = new Set(); speakers.set(g, s); }
    if (s.size < 3) s.add(k);
  }
}

/* 名字表：群友名 + bot 昵称（用于识别「称呼类梗」） */
const names = new Set();
for (const m of index) {
  if (!m.name) continue;
  const n = String(m.name).trim();
  if (n.length >= 2) names.add(n);
}
for (const n of opt.botNames) if (n.length >= 2) names.add(n);
const nameParts = new Set();
for (const n of names) {
  if (n.length >= 2) nameParts.add(n);
}

function pickSamples(member) {
  const k = member.qq ? String(member.qq) : `name:${member.name}`;
  const mine = (byKey.get(k) || []).filter((r) => keyOf(r) === k);
  const rand = mulberry32((Number(member.qq) || 12345) % 2147483647);
  const buckets = { recent: [], random: [], phrase: [], interact: [] };
  const used = new Set();
  const push = (bucket, r) => {
    if (!r) return false;
    const id = r.ts + '|' + r.text;
    if (used.has(id)) return false;
    used.add(id);
    bucket.push(r);
    return true;
  };

  /* 1) 最近 30 */
  for (const r of mine.slice(-30)) push(buckets.recent, r);

  /* 2) 随机 60 */
  for (const r of shuffle(mine, rand).slice(0, 60)) push(buckets.random, r);

  /* 3) 专属片段命中 30 */
  const cand = candidatePer.get(k) || new Map();
  const ranked = [...cand.entries()]
    .filter(([, n]) => n >= 2)
    .filter(([g]) => (speakers.get(g)?.size || 99) <= 2)
    .map(([g, n]) => {
      const isBotName = opt.botNames.some((p) => p.length >= 2 && g.includes(p));
      const tier = isBotName ? 0 : (g.length >= 3 && n >= 3 ? 1 : 2);
      return { g, n, tier };
    })
    .sort((a, b) => a.tier - b.tier || b.n - a.n || b.g.length - a.g.length);
  const chosen = [];
  const perName = new Map();
  for (const { g } of ranked) {
    if (chosen.length >= 12) break;
    if (chosen.some((c) => c !== g && c.includes(g))) continue; // 已有更长的包含它
    // 同一个群友昵称最多贡献 2 条片段，避免整批都是「蠢货X」
    const hit = [...nameParts].find((n) => g.includes(n) && !opt.botNames.includes(n));
    if (hit) {
      if ((perName.get(hit) || 0) >= 2) continue;
      perName.set(hit, (perName.get(hit) || 0) + 1);
    }
    chosen.push(g);
  }
  for (const g of chosen) {
    let taken = 0;
    for (const r of mine) {
      if (taken >= 3 || buckets.phrase.length >= 30) break;
      if (r.text.includes(g) && push(buckets.phrase, r)) taken += 1;
    }
  }

  /* 4) 互动 30：别人提到他 20 + 他提到 bot 昵称 10 */
  const myNames = (member.names || [member.name]).filter((n) => typeof n === 'string' && n.length >= 2);
  let mentioned = 0;
  const others = [];
  for (const [ok, arr] of byKey) {
    if (ok === k) continue;
    for (const r of arr) {
      if (myNames.some((n) => r.text.includes(n))) others.push(r);
    }
  }
  // 均匀取最多 20 条，避免全是最早的
  const step = Math.max(1, Math.floor(others.length / 20));
  for (let i = 0; i < others.length && mentioned < 20; i += step) {
    if (push(buckets.interact, others[i])) mentioned += 1;
  }
  let botMention = 0;
  for (const r of mine) {
    if (botMention >= 10) break;
    if (opt.botNames.some((n) => r.text.includes(n)) && push(buckets.interact, r)) botMention += 1;
  }

  /* 合并并按时间排序，控制总数 */
  const all = [...buckets.recent, ...buckets.random, ...buckets.phrase, ...buckets.interact];
  all.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  let merged = all;
  if (merged.length > opt.maxSamples) {
    // 优先保留片段/互动组，再随机组，再最近组
    const keep = new Set();
    for (const r of [...buckets.phrase, ...buckets.interact, ...buckets.random, ...buckets.recent]) {
      if (keep.size >= opt.maxSamples) break;
      keep.add(r.ts + '|' + r.text);
    }
    merged = merged.filter((r) => keep.has(r.ts + '|' + r.text));
  }
  return { buckets, merged, chosen };
}

function fmtSampleSelf(r, member) {
  const ts = String(r.ts).slice(5, 16).replace('T', ' ');
  const mine = r.qq ? String(r.qq) === String(member.qq) : (member.names || []).includes(r.sender);
  return mine ? `[${ts}] ${r.text}` : `[${ts}] ${r.sender}: ${r.text}`;
}

async function analyzeOne(member, idx, total) {
  const t0 = Date.now();
  const k = member.qq ? String(member.qq) : `name:${member.name}`;
  const file = join(membersDir, `${String(member.qq ?? member.name).replace(/[\\/:*?"<>|\s]/g, '_')}.json`);
  if (!existsSync(file)) return { ok: false, label: member.name, err: '档案文件不存在: ' + file };
  const profile = JSON.parse(readFileSync(file, 'utf8'));

  const { buckets, merged, chosen } = pickSamples(member);
  const sampleBlob = merged.map((r) => r.text).join('\n');
  const stats = (profile.phrases || []).slice(0, 8).map((p) => p.g).join('/');
  const prompt = buildUserPrompt({
    name: member.name,
    qq: member.qq ?? '(未知)',
    msgs: profile.msgs ?? member.msgs ?? 0,
    avgLen: profile.avgLen ?? 0,
    activeHours: profile.activeHours || [],
    stats,
    sampleLines: merged.map((r) => fmtSampleSelf(r, member)).join('\n'),
    n: merged.length,
  });
  const tag = `[${idx}/${total}] ${member.name}(${member.qq ?? '-'})`;
  const counts = `样本${merged.length}(近${buckets.recent.length}/随${buckets.random.length}/片${buckets.phrase.length}/互动${buckets.interact.length})`;
  console.log(`${tag} ${counts} prompt=${prompt.length}字 片段=${chosen.slice(0, 6).join(',')}`);

  if (opt.dryRun) {
    const p = join('/tmp', `dry-${member.qq ?? 'name'}.txt`);
    writeFileSync(p, prompt, 'utf8');
    console.log(`  dry-run -> ${p}`);
    return { ok: true, label: member.name, dry: true };
  }

  let parsed = null;
  let usage = {};
  let lastErr = null;
  for (let attempt = 1; attempt <= 2 && !parsed; attempt += 1) {
    try {
      const messages = [{ role: 'system', content: SYS_PROMPT }, { role: 'user', content: prompt + (attempt > 1 ? '\n\n上次输出不是合法 JSON，请只输出 JSON。' : '') }];
      const r = await callModel(prov, messages, { jsonMode: attempt === 1, noThink: attempt === 1 });
      usage = r.usage || usage;
      parsed = extractJson(r.content);
    } catch (e) {
      lastErr = e;
      console.warn(`  ! ${tag} 第 ${attempt} 次失败: ${e.message.slice(0, 160)}`);
      await new Promise((res) => setTimeout(res, 1500));
    }
  }
  if (!parsed) return { ok: false, label: member.name, err: lastErr?.message || '未知错误', usage };

  const clean = validate(parsed, sampleBlob);
  if (!clean.catchphrases.length && !opt.dryRun) {
    console.warn(`  ! ${tag} catchphrases 全被丢弃，重试一次`);
    try {
      const r2 = await callModel(prov, [
        { role: 'system', content: SYS_PROMPT },
        { role: 'user', content: `${prompt}\n\n【补充】你上次给的口头禅在样本里都只出现 1 次，已全部作废。请重新输出 JSON：catchphrases 必须是样本里出现 >=2 次的字串（短脏话、语气词也可以），确实没有就给空数组。` },
      ], { jsonMode: true, noThink: true });
      const c2 = validate(extractJson(r2.content), sampleBlob);
      usage = r2.usage || usage;
      if (c2.catchphrases.length > clean.catchphrases.length) Object.assign(clean, c2);
      console.log(`  重试结果：口头禅=${clean.catchphrases.join('/') || '(空)'}`);
    } catch (e) {
      console.warn(`  ! ${tag} 重试失败: ${e.message.slice(0, 120)}`);
    }
  }

  const next = {
    ...profile,
    llm: {
      ...clean,
      model: prov.model,
      at: nowIso(),
      sampleCount: merged.length,
      usage: { prompt_tokens: usage.prompt_tokens ?? 0, completion_tokens: usage.completion_tokens ?? 0 },
    },
  };
  const tmp = file + '.tmp';
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  renameSync(tmp, file);
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`  ok ${tag} ${secs}s tokens=${usage.prompt_tokens ?? 0}/${usage.completion_tokens ?? 0} 口头禅=${clean.catchphrases.join('/')}`);
  return { ok: true, label: member.name, usage };
}

/* 并发池 */
const results = [];
let cursor = 0;
let tokenIn = 0;
let tokenOut = 0;
const tStart = Date.now();
async function worker() {
  for (;;) {
    const i = cursor;
    cursor += 1;
    if (i >= targets.length) return;
    try {
      const r = await analyzeOne(targets[i], i + 1, targets.length);
      results.push(r);
      tokenIn += r.usage?.prompt_tokens || 0;
      tokenOut += r.usage?.completion_tokens || 0;
    } catch (e) {
      results.push({ ok: false, label: targets[i]?.name, err: e.message });
      console.error(`  x ${targets[i]?.name} 异常: ${e.message}`);
    }
  }
}
await Promise.all(Array.from({ length: Math.min(opt.concurrency, Math.max(1, targets.length)) }, () => worker()));

const okN = results.filter((r) => r.ok).length;
const failN = results.length - okN;
const secs = ((Date.now() - tStart) / 1000).toFixed(1);
const cost = (tokenIn / 1e6) * 1 + (tokenOut / 1e6) * 2;
console.log('\n=== 汇总 ===');
console.log(`成功 ${okN}，失败 ${failN}，耗时 ${secs}s`);
console.log(`tokens: 输入 ${tokenIn} / 输出 ${tokenOut}，约 ¥${cost.toFixed(3)}（按 1元/M 输入、2元/M 输出估）`);
for (const r of results) if (!r.ok) console.log(`  失败: ${r.label} -> ${r.err}`);
process.exitCode = failN ? 1 : 0;
