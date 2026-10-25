#!/usr/bin/env node
/**
 * 群友画像 v2：对话切片（burst）取样 + 分层选片 + 全量校验
 *
 * 与 v1 的区别：
 *   - 取样单位从「单条消息」改成「一段连续对话（burst，间隔 <=10 分钟）」，保留上下文；
 *   - 分层选片：时间均匀 / 被点名 / 长句 / 多人在场 / 梗 / 最近 / 随机；
 *   - 口头禅不再要求「样本里出现 >=2 次」，改成「从切片提名 → 回全量语料验证 >=2 次」；
 *   - 画像多出 stance / habits / saysToBot / runningJokes / quotes 五个维度；
 *   - quotes 必须逐字出自他的消息（全量核对）。
 *
 * 用法：
 *   node llm-member-slices.mjs --records <records.jsonl> --only 380741085 \
 *     [--out <file>] [--slices 40] [--gap 10] [--provider /data/home/providers/deepseek]
 *     [--bot-names 鲸鲸] [--dry-run] [--quiet]
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/* ---------------- 参数 ---------------- */
function parseArgs(argv) {
  const o = {
    records: '',
    only: '',
    out: '',
    slices: 40,
    gap: 30,
    provider: '/data/home/providers/deepseek',
    model: '',
    botNames: ['鲸鲸'],
    dryRun: false,
    quiet: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--records') o.records = next();
    else if (a === '--only') o.only = String(next() || '');
    else if (a === '--out') o.out = next();
    else if (a === '--slices') o.slices = Math.max(8, Number(next()) || 40);
    else if (a === '--gap') o.gap = Math.max(1, Number(next()) || 10);
    else if (a === '--provider') o.provider = next();
    else if (a === '--model') o.model = next();
    else if (a === '--bot-names') o.botNames = String(next() || '').split(/[,，\s]+/).filter(Boolean);
    else if (a === '--dry-run') o.dryRun = true;
    else if (a === '--quiet') o.quiet = true;
    else if (a === '--help' || a === '-h') { console.log('see header'); process.exit(0); }
    else throw new Error(`未知参数: ${a}`);
  }
  if (!o.records) throw new Error('缺少 --records');
  if (!o.only) throw new Error('缺少 --only（QQ 号或昵称）');
  return o;
}

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
  if (!key) throw new Error(`找不到密钥 ${secretName}`);
  const baseUrl = (cfg.baseUrl || 'https://api.deepseek.com').replace(/\/+$/, '');
  return { key, url: `${baseUrl}/v1/chat/completions`, model: o.model || cfg.spec?.model || 'deepseek-flash' };
}

/* ---------------- 读 + 清洗 ---------------- */
const NOISE = ['撤回了一条消息', '向你发起临时会话', '以上是打招呼', '请使用最新版手机QQ', '该用户通过',
  '发起了语音通话', '邀请你加入', '加入了群聊', '拍了拍', '上传了', '戳了戳', '群公告', '【DSH', '【鲸鲸告警】'];
// 纯表情占位符丢掉；[图片] 保留（这是他的一种发言方式）
const PLACEHOLDER = /^\[(表情|动画表情)[^\]]*\]$/;

function norm(t) { return String(t).replace(/\s+/g, ' ').trim(); }

function loadRecords(file, botNames) {
  const out = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let r;
    try { r = JSON.parse(line); } catch { continue; }
    if (!r || r.kind === 'system') continue;
    const text = norm(r.text || '');
    if (!text || text.length < 1) continue;
    if (PLACEHOLDER.test(text)) continue;
    if (NOISE.some((n) => text.includes(n))) continue;
    if (botNames.some((b) => text === b)) continue; // 纯叫名字不算信息
    out.push({
      ts: String(r.ts).replace(' ', 'T'),
      conv: r.conv || '',
      convKind: r.convKind === 'group' ? 'group' : 'private',
      sender: r.sender || '',
      qq: r.qq == null ? null : String(r.qq),
      text: text.length > 300 ? text.slice(0, 300) : text,
    });
  }
  return out;
}

/** 去掉群装饰前缀，便于跨昵称匹配：`【论乌冬的吃法】乌冬` → `乌冬`，`[管理员]xxx` → `xxx`。 */
function normName(s) {
  return String(s || '').replace(/^【[^】]{0,24}】\s*/, '').replace(/^\[[^\]]{0,24}\]\s*/, '').trim();
}

/**
 * 身份层：昵称（含历史改名）→ QQ，带时间区间。
 * 同一个昵称在时间上会对应不同 QQ（改名后旧名被别人用），所以解析时按时段就近选。
 */
function buildIdentity(recs) {
  const byName = new Map(); // normName -> [{ qq, first, last, n, raw }]
  for (const r of recs) {
    if (!r.qq || !r.sender) continue;
    const n = normName(r.sender);
    if (!n) continue;
    if (!byName.has(n)) byName.set(n, new Map());
    const m = byName.get(n);
    const cur = m.get(r.qq) || { qq: r.qq, first: r.ts, last: r.ts, n: 0, raw: r.sender };
    cur.n += 1;
    if (r.ts < cur.first) cur.first = r.ts;
    if (r.ts > cur.last) cur.last = r.ts;
    m.set(r.qq, cur);
  }
  const nameIndex = new Map();
  for (const [n, m] of byName) nameIndex.set(n, [...m.values()].sort((a, b) => b.n - a.n));

  // 时间就近解析
  const resolve = (name, ts) => {
    const list = nameIndex.get(normName(name));
    if (!list || !list.length) return null;
    if (list.length === 1) return list[0].qq;
    const t = ts || '';
    let best = list[0];
    let bestD = Infinity;
    for (const c of list) {
      const d = t < c.first ? (new Date(c.first) - new Date(t)) : t > c.last ? (new Date(t) - new Date(c.last)) : 0;
      if (d < bestD) { bestD = d; best = c; }
    }
    return best.qq;
  };

  let merged = 0;
  for (const r of recs) {
    if (r.qq || !r.sender) continue;
    const qq = resolve(r.sender, r.ts);
    if (qq) { r.qq = qq; merged += 1; }
  }
  return { nameIndex, resolve, merged, mergedCount: merged };
}

/** 已知昵称集合（用于 @ 的最长匹配）。 */
function knownNames(nameIndex) {
  return [...nameIndex.keys()].filter((n) => n.length >= 2 && n.length <= 24).sort((a, b) => b.length - a.length);
}

/** 从正文里抽 @：按已知昵称最长匹配（QQ 导出的 `@偏偏 遇见。` 含空格，不能按空白切）。 */
function extractAts(text, namesSorted, resolve, ts, limit = 6) {
  const out = [];
  let i = text.indexOf('@');
  while (i >= 0 && out.length < limit) {
    const rest = text.slice(i + 1, i + 30);
    let hit = '';
    for (const n of namesSorted) {
      if (rest.startsWith(n)) { hit = n; break; }
    }
    if (hit) {
      const qq = resolve(hit, ts);
      if (qq) out.push({ name: hit, qq });
      else out.push({ name: hit, qq: null });
    } else {
      const m = /^([^\s@，,。!！?？:：]{1,20})/.exec(rest);
      if (m) out.push({ name: m[1], qq: resolve(m[1], ts) });
    }
    i = text.indexOf('@', i + 1);
  }
  return out;
}

/* ---------------- burst 切片 ---------------- */
function minutes(a, b) { return (new Date(b.ts).getTime() - new Date(a.ts).getTime()) / 60000; }

function buildBursts(recs, gapMin) {
  const byConv = new Map();
  for (const r of recs) {
    if (!byConv.has(r.conv)) byConv.set(r.conv, []);
    byConv.get(r.conv).push(r);
  }
  const bursts = [];
  for (const [conv, arr] of byConv) {
    arr.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
    let cur = [];
    const flush = () => {
      if (cur.length) bursts.push({ conv, kind: arr[0].convKind, msgs: cur, start: cur[0].ts, end: cur[cur.length - 1].ts });
      cur = [];
    };
    for (const r of arr) {
      if (cur.length && minutes(cur[cur.length - 1], r) > gapMin) flush();
      cur.push(r);
    }
    flush();
  }
  bursts.sort((a, b) => (a.start < b.start ? -1 : 1));
  return bursts;
}

/** 以他为中心截 <=max 条的一段（保留上下文）。 */
function windowOf(burst, meQq, anchorIndex, max = 16) {
  const arr = burst.msgs;
  if (arr.length <= max) return arr;
  const half = Math.floor(max / 2);
  let start = Math.max(0, anchorIndex - half);
  if (start + max > arr.length) start = arr.length - max;
  return arr.slice(start, start + max);
}

function quarterOf(ts) {
  const d = new Date(ts);
  return `${d.getUTCFullYear()}Q${Math.floor(d.getUTCMonth() / 3) + 1}`;
}

/* ---------------- 外号挖掘 ---------------- */
/**
 * 别人怎么叫他：候选 2~4 字片段 → 用「别人叫完他 5 分钟内接话」的比例（lift）判定，
 * 再用「第一个回应的人是不是他」排除「别人也在用的词」（如笑声「桀桀」、别人的名字「蠢货」）。
 * 额外加分：片段是他某个 QQ 昵称的前缀（鸡哥 ⊂ 鸡哥明天玩什么）。
 */
function mineAliases(convIndex, targetQq, targetNames, opts = {}) {
  const { minUsage = 20, minLift = 1.8, maxCandidates = 300, top = 8, minVocative = 0.35, minExclusivity = 1.7, maxSelfRatio = 0.3 } = opts;
  const gramsOf = (text) => {
    const s = text.replace(/@\S+/g, ' ').replace(/\[[^\]]{0,12}\]/g, ' ').replace(/[^\u4e00-\u9fa5]/g, '');
    const out = [];
    for (let n = 2; n <= 4; n += 1) for (let i = 0; i + n <= s.length; i += 1) out.push(s.slice(i, i + n));
    return out;
  };
  const STOP = new Set(['什么', '怎么', '就是', '不是', '可以', '没有', '知道', '现在', '还是', '这么', '那么',
    '已经', '应该', '然后', '所以', '但是', '好像', '不过', '时候', '直接', '还有', '今天', '自己', '这样',
    '那样', '因为', '如果', '虽然', '有点', '觉得', '一次', '一点', '这个', '那个', '他们', '我们', '你们',
    '哈哈', '哈哈哈', '哈哈哈哈', '卧槽', '我靠', '他妈', '真的', '一个', '不是']);

  // 基线：别人一条消息后，5 分钟内他接话的概率；以及「第一个回应者是他」的占比
  let baseMsgs = 0;
  let baseReply = 0;
  let baseFirst = 0;
  let baseReplied = 0;
  for (const arr of convIndex.values()) {
    for (let i = 0; i < arr.length; i += 1) {
      const r = arr[i];
      if (r.qq === targetQq) continue;
      baseMsgs += 1;
      const firstReply = arr.slice(i + 1, i + 12).find((x) => x.qq !== r.qq && minutes(r, x) <= 5);
      if (firstReply) {
        baseReplied += 1;
        if (firstReply.qq === targetQq) baseFirst += 1;
        if (arr.slice(i + 1, i + 12).some((x) => x.qq === targetQq && minutes(r, x) <= 5)) baseReply += 1;
      }
    }
  }
  const baseLift = baseMsgs ? baseReply / baseMsgs : 0;
  const baseFirstShare = baseReplied ? baseFirst / baseReplied : 0;

  // 第一遍：只在「别人说话后他 5 分钟内接话」的上下文里数片段，候选量小很多
  const cand = new Map();
  for (const arr of convIndex.values()) {
    for (let i = 0; i < arr.length; i += 1) {
      const r = arr[i];
      if (r.qq === targetQq) continue;
      if (!arr.slice(i + 1, i + 12).some((x) => x.qq === targetQq && minutes(r, x) <= 5)) continue;
      for (const g of new Set(gramsOf(r.text))) cand.set(g, (cand.get(g) || 0) + 1);
    }
  }
  // 名字前缀候选（有些外号出现频率不高，但明显是名字截断）
  for (const nm of targetNames) {
    const n = normName(nm);
    for (let k = 2; k <= Math.min(4, n.length - 1); k += 1) {
      const p = n.slice(0, k);
      if (!STOP.has(p)) cand.set(p, (cand.get(p) || 0) + 500);
    }
  }
  const shortlist = [...cand.entries()]
    .filter(([g]) => !STOP.has(g) && g.length >= 2 && g.length <= 4)
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxCandidates)
    .map(([g]) => g);

  // 第二遍：对候选做全量统计（只扫他所在的会话）
  const rows = [];
  for (const g of shortlist) {
    let usage = 0;
    let self = 0;
    let reply = 0;
    let firstHit = 0;
    let replied = 0;
    let voc = 0;
    const speakers = new Map();
    const examples = [];
    for (const arr of convIndex.values()) {
      for (let i = 0; i < arr.length; i += 1) {
        const r = arr[i];
        if (!r.text.includes(g)) continue;
        if (r.qq === targetQq) { self += 1; continue; }
        usage += 1;
        speakers.set(r.sender, (speakers.get(r.sender) || 0) + 1);
        // 称呼位置：短消息 / 句首 / @ 后面
        const pos = r.text.indexOf(g);
        if (r.text.length <= 10 || pos <= 1 || r.text.slice(Math.max(0, pos - 1), pos) === '@') voc += 1;
        const firstReply = arr.slice(i + 1, i + 12).find((x) => x.qq !== r.qq && minutes(r, x) <= 5);
        if (firstReply) {
          replied += 1;
          if (firstReply.qq === targetQq) firstHit += 1;
        }
        if (arr.slice(i + 1, i + 12).some((x) => x.qq === targetQq && minutes(r, x) <= 5)) reply += 1;
        if (examples.length < 2) examples.push(`[${r.conv.slice(0, 8)}] ${r.sender}: ${r.text.slice(0, 46)}`);
      }
    }
    if (usage < minUsage) continue;
    const lift = baseLift ? (reply / usage) / baseLift : 0;
    const firstShare = replied ? firstHit / replied : 0;
    const isPrefix = targetNames.some((nm) => normName(nm).startsWith(g));
    const exclusivity = baseFirstShare ? firstShare / baseFirstShare : 0;
    const vocShare = usage ? voc / usage : 0;
    const selfRatio = self / Math.max(1, self + usage);
    if (lift < minLift) continue;
    if (exclusivity < minExclusivity) continue;
    if (vocShare < minVocative) continue;
    if (selfRatio > maxSelfRatio) continue;
    const score = lift * Math.min(2, exclusivity) * (1 + (isPrefix ? 0.35 : 0)) * Math.log10(1 + usage);
    rows.push({
      name: g, usage, self, speakers: speakers.size,
      lift: Number(lift.toFixed(2)), firstShare: Number(firstShare.toFixed(2)),
      vocShare: Number(vocShare.toFixed(2)), selfRatio: Number(selfRatio.toFixed(2)),
      prefix: isPrefix, score: Number(score.toFixed(2)),
      top: [...speakers.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3), examples,
    });
  }
  rows.sort((a, b) => b.score - a.score);
  // 去掉被更长候选包含的（鸡哥 vs 鸡哥明天）
  const picked = [];
  // 名字截断优先保留最短的那个（倒爷 > 倒爷请 > 倒爷请给）
  const prefixBest = new Map();
  for (const r of rows) {
    if (!r.prefix) continue;
    const nm = targetNames.find((n) => normName(n).startsWith(r.name));
    if (!nm) continue;
    const cur = prefixBest.get(nm);
    if (!cur || r.name.length < cur.name.length) prefixBest.set(nm, r);
  }
  const keepPrefix = new Set([...prefixBest.values()].map((r) => r.name));
  for (const r of rows) {
    if (r.prefix && !keepPrefix.has(r.name)) continue;
    if (picked.some((p) => p.name.includes(r.name) && p.name !== r.name)) continue;
    if (picked.some((p) => r.name.startsWith(p.name) && r.name !== p.name)) continue;
    picked.push(r);
    if (picked.length >= top) break;
  }
  return { rows: picked, baseLift, baseFirstShare, baseMsgs };
}

/* ---------------- 反向：他给别人起的外号 ---------------- */
/**
 * 「他叫 → 别人接」：从他发的消息里找 2~4 字片段，看 5 分钟内第一个回应的人是谁。
 * 如果某个片段反复由同一个人接（占比 >=55%），这个片段大概率是他对那个人的称呼。
 */
function mineCallsToOthers(convIndex, targetQq, opts = {}) {
  const { minUsage = 8, minDominant = 0.55, maxCandidates = 200, top = 8 } = opts;
  const gramsOf = (text) => {
    const s = text.replace(/@\S+/g, ' ').replace(/\[[^\]]{0,12}\]/g, ' ').replace(/[^\u4e00-\u9fa5]/g, '');
    const out = [];
    for (let n = 2; n <= 4; n += 1) for (let i = 0; i + n <= s.length; i += 1) out.push(s.slice(i, i + n));
    return out;
  };
  const STOP = new Set(['什么', '怎么', '就是', '不是', '可以', '没有', '知道', '现在', '还是', '这么', '那么',
    '已经', '应该', '然后', '所以', '但是', '好像', '不过', '时候', '直接', '还有', '今天', '自己', '这样',
    '那样', '因为', '如果', '虽然', '有点', '觉得', '一次', '一点', '这个', '那个', '他们', '我们', '你们',
    '哈哈', '哈哈哈', '哈哈哈哈', '卧槽', '我靠', '他妈', '真的', '一个', '不是', '玩什么', '什么鬼']);

  let baseMsgs = 0;
  let baseReply = 0;
  const baseResp = new Map();
  let baseResponders = 0;
  for (const arr of convIndex.values()) {
    for (let i = 0; i < arr.length; i += 1) {
      if (arr[i].qq !== targetQq) continue;
      baseMsgs += 1;
      const first = arr.slice(i + 1, i + 12).find((x) => x.qq !== targetQq && minutes(arr[i], x) <= 5);
      if (!first) continue;
      baseReply += 1;
      baseResponders += 1;
      baseResp.set(first.qq, (baseResp.get(first.qq) || 0) + 1);
    }
  }
  const baseLift = baseMsgs ? baseReply / baseMsgs : 0;

  const cand = new Map();
  for (const arr of convIndex.values()) {
    for (let i = 0; i < arr.length; i += 1) {
      const r = arr[i];
      if (r.qq !== targetQq) continue;
      if (!arr.slice(i + 1, i + 12).some((x) => x.qq !== targetQq && minutes(r, x) <= 5)) continue;
      const short = r.text.length <= 12 || r.text.startsWith('@');
      for (const g of new Set(gramsOf(r.text))) cand.set(g, (cand.get(g) || 0) + (short ? 2 : 1));
    }
  }
  const shortlist = [...cand.entries()]
    .filter(([g]) => !STOP.has(g) && g.length >= 2 && g.length <= 4)
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxCandidates)
    .map(([g]) => g);

  const rows = [];
  for (const g of shortlist) {
    let usage = 0;
    let reply = 0;
    let voc = 0;
    const byAuthor = new Map();
    const responders = new Map();
    let example = '';
    // 先统计所有人在用这个词的次数（判断是不是话题词：被叫的人自己也常说 → 不是外号）
    for (const arr of convIndex.values()) {
      for (let i = 0; i < arr.length; i += 1) {
        const r = arr[i];
        if (!r.text.includes(g)) continue;
        const k = r.qq || `name:${r.sender}`;
        byAuthor.set(k, (byAuthor.get(k) || 0) + 1);
      }
    }
    const totalAll = [...byAuthor.values()].reduce((a, b) => a + b, 0) || 1;
    for (const arr of convIndex.values()) {
      for (let i = 0; i < arr.length; i += 1) {
        const r = arr[i];
        if (r.qq !== targetQq || !r.text.includes(g)) continue;
        usage += 1;
        const pos = r.text.indexOf(g);
        if (r.text.length <= 12 || pos <= 1 || r.text.slice(Math.max(0, pos - 1), pos) === '@') voc += 1;
        const first = arr.slice(i + 1, i + 12).find((x) => x.qq !== targetQq && minutes(r, x) <= 5);
        if (!first) continue;
        reply += 1;
        const k = first.qq || `name:${first.sender}`;
        responders.set(k, (responders.get(k) || 0) + 1);
        if (!example) example = `[${r.conv.slice(0, 8)}] 他: ${r.text.slice(0, 40)} → ${first.sender}`;
      }
    }
    if (usage < minUsage || !reply) continue;
    const vocShare = usage ? voc / usage : 0;
    if (vocShare < 0.35) continue;
    const ranked = [...responders.entries()].map(([q, n]) => {
      const baseShare = (baseResp.get(q) || 0) / Math.max(1, baseResponders);
      return { q, n, share: n / reply, lift: baseShare ? (n / reply) / baseShare : 0 };
    }).sort((a, b) => b.n * Math.min(3, b.lift) - a.n * Math.min(3, a.lift));
    const top1 = ranked[0];
    if (!top1) continue;
    if (top1.lift < 1.6 || top1.n < 5) continue;
    // 被叫的那个人自己也常说这个词 → 是话题词，不是外号
    const targetSelf = (byAuthor.get(top1.q) || 0) / totalAll;
    if (targetSelf > 0.2) continue;
    const score = top1.n * Math.min(3, top1.lift) * (1 + (vocShare > 0.6 ? 0.2 : 0));
    rows.push({
      who: top1.q, alias: g, usage, count: top1.n,
      lift: Number(top1.lift.toFixed(1)), share: Number(top1.share.toFixed(2)),
      vocShare: Number(vocShare.toFixed(2)), score: Number(score.toFixed(1)), example,
    });
  }
  rows.sort((a, b) => b.score - a.score);

  // 对称校验：如果这个词真是 X 的外号，那「别人叫它」时也该主要 X 来接
  const forwardTop = (g) => {
    const resp = new Map();
    let n = 0;
    for (const arr of convIndex.values()) {
      for (let i = 0; i < arr.length; i += 1) {
        const r = arr[i];
        if (r.qq === targetQq || !r.text.includes(g)) continue;
        const first = arr.slice(i + 1, i + 12).find((x) => x.qq !== r.qq && minutes(r, x) <= 5);
        if (!first) continue;
        const k = first.qq || `name:${first.sender}`;
        resp.set(k, (resp.get(k) || 0) + 1);
        n += 1;
      }
    }
    const top = [...resp.entries()].sort((a, b) => b[1] - a[1])[0];
    return top ? { who: top[0], share: top[1] / Math.max(1, n) } : null;
  };
  const verified = [];
  for (const r of rows.slice(0, 24)) {
    const f = forwardTop(r.alias);
    if (!f || f.who !== r.who || f.share < 0.5) { console.warn(`    ! 反向外号「${r.alias}→${r.who}」对称校验没过（别人叫时主回应 ${f?.who ?? '无'}）`); continue; }
    verified.push({ ...r, forwardShare: Number(f.share.toFixed(2)) });
    if (verified.length >= top) break;
  }
  const picked = [];
  for (const r of verified) {
    if (picked.some((p) => p.alias === r.alias)) continue;
    picked.push(r);
    if (picked.length >= top) break;
  }
  return { rows: picked, baseLift };
}

/* ---------------- 选片 ---------------- */
function pickSlices(member, bursts, opt) {
  const me = member.qq;
  const names = member.aliases && member.aliases.length ? member.aliases : [member.name];
  const mine = (b) => b.msgs.filter((r) => r.qq === me);
  const otherNameHit = (b) => b.msgs.some((r) => r.qq !== me && names.some((n) => n.length >= 2 && (r.text.includes('@' + n) || r.text.includes(n))));
  const longHit = (b) => mine(b).some((r) => r.text.length > 30);
  const speakers = (b) => new Set(b.msgs.map((r) => r.qq || r.sender)).size;
  const botHit = (b) => mine(b).some((r) => opt.botNames.some((n) => r.text.includes(n)));

  // 单条 / 两条的 burst 没有上下文，直接排除
  const all = bursts.filter((b) => b.msgs.length >= 3 && b.msgs.some((r) => r.qq === me));
  const lastTs = all.length ? all[all.length - 1].end : '';
  const recentCut = lastTs ? new Date(lastTs).getTime() - 30 * 86400_000 : 0;

  // 跨会话：除了主会话，其它会话（私聊/小群）各保底几片，否则永远轮不到
  const byConv = new Map();
  for (const b of all) {
    if (!byConv.has(b.conv)) byConv.set(b.conv, []);
    byConv.get(b.conv).push(b);
  }
  const mainConv = [...byConv.entries()].sort((a, b) => b[1].length - a[1].length)[0]?.[0];
  const crossConv = all.filter((b) => b.conv !== mainConv).sort((a, b) => (a.start < b.start ? -1 : 1));

  const strata = {
    quarter: [],
    mention: all.filter(otherNameHit),
    long: all.filter(longHit),
    multi: all.filter((b) => speakers(b) >= 3),
    meme: all.filter(botHit),
    crossConv,
    recent: all.filter((b) => new Date(b.end).getTime() >= recentCut),
    random: [...all],
  };

  // 时间均匀：每个季度挑 1 个（按季度轮转，最多 quota 个）
  const byQuarter = new Map();
  for (const b of all) {
    const q = quarterOf(b.start);
    if (!byQuarter.has(q)) byQuarter.set(q, []);
    byQuarter.get(q).push(b);
  }
  const quarters = [...byQuarter.keys()].sort();
  // 每个季度从中间取（避免全是月初）
  strata.quarter = quarters.map((q) => byQuarter.get(q)[Math.floor(byQuarter.get(q).length / 2)]);

  const total = opt.slices;
  const quota = {
    quarter: Math.round(total * 0.25),
    mention: Math.round(total * 0.18),
    long: Math.round(total * 0.14),
    multi: Math.round(total * 0.12),
    meme: Math.round(total * 0.08),
    crossConv: Math.round(total * 0.1),
    recent: Math.round(total * 0.08),
    random: 0,
  };
  quota.random = Math.max(0, total - Object.values(quota).reduce((a, b) => a + b, 0));

  const picked = [];
  const seen = new Set();
  const take = (b, why) => {
    if (!b) return false;
    const id = b.start + '|' + b.conv;
    if (seen.has(id)) return false;
    seen.add(id);
    picked.push({ burst: b, why });
    return true;
  };
  // 均匀抽样的辅助：在数组里等距取 n 个
  const evenly = (arr, n) => {
    if (!arr.length || n <= 0) return [];
    const step = arr.length / n;
    const out = [];
    for (let i = 0; i < n && i < arr.length; i += 1) out.push(arr[Math.floor(i * step)]);
    return out;
  };

  for (const b of evenly(strata.quarter, quota.quarter)) take(b, '时间');
  for (const b of evenly(strata.mention, quota.mention)) take(b, '被点名');
  for (const b of evenly(strata.long, quota.long)) take(b, '长句');
  for (const b of evenly(strata.multi, quota.multi)) take(b, '多人');
  for (const b of evenly(strata.meme, quota.meme)) take(b, '梗');
  for (const b of evenly(strata.crossConv, quota.crossConv)) take(b, '跨会话');
  for (const b of evenly(strata.recent, quota.recent)) take(b, '最近');
  for (const b of evenly(strata.random, quota.random)) take(b, '随机');

  // 补齐到 total
  for (const b of evenly(strata.random, total)) {
    if (picked.length >= total) break;
    take(b, '补');
  }

  // 每个 burst 截成窗口（锚点优先用触发它的那条他的消息）
  return picked.slice(0, total).map(({ burst, why }) => {
    const mineIdx = [];
    burst.msgs.forEach((r, i) => { if (r.qq === me) mineIdx.push(i); });
    let anchor = mineIdx[Math.floor(mineIdx.length / 2)] ?? 0;
    if (why === '被点名') {
      const i = burst.msgs.findIndex((r) => r.qq !== me && names.some((n) => n.length >= 2 && (r.text.includes(n) || r.text.includes('@' + n))));
      if (i >= 0) anchor = Math.min(i + 1, burst.msgs.length - 1);
    } else if (why === '长句') {
      const i = burst.msgs.findIndex((r) => r.qq === me && r.text.length > 30);
      if (i >= 0) anchor = i;
    } else if (why === '梗') {
      const i = burst.msgs.findIndex((r) => r.qq === me && opt.botNames.some((n) => r.text.includes(n)));
      if (i >= 0) anchor = i;
    }
    return { why, conv: burst.conv, kind: burst.kind, start: burst.start, msgs: windowOf(burst, me, anchor, 16) };
  });
}

/* ---------------- 渲染 + 提示词 ---------------- */
function hhmm(ts) { return ts.slice(11, 16); }

function renderSlice(s, meQq, memberName, botNames, botQq) {
  const head = `### 片段 ${s.i}/${s.n}｜${s.start.slice(0, 16).replace('T', ' ')}｜${s.kind === 'group' ? '群' : '私聊'}「${s.conv}」｜入选理由：${s.why}`;
  const lines = s.msgs.map((r) => {
    const isMe = r.qq === meQq;
    const isBot = botQq ? r.qq === botQq : botNames.some((n) => n === r.sender);
    const tag = isMe ? '>>> ' : isBot ? '[鲸鲸] ' : '';
    return `[${hhmm(r.ts)}] ${tag}${r.sender}: ${r.text}`;
  });
  return `${head}\n${lines.join('\n')}`;
}

const SYS = '你是 QQ 群聊观察员。只依据给你的对话片段分析，不补充片段外的任何信息；不确定就留空。';

function buildPrompt(member, stats, slicesText, n) {
  const alias = (member.aliases || []).filter((x) => x !== member.name).slice(0, 5);
  const akaLine = (member.aka || []).length > 1
    ? `\n他改过很多次昵称（同一个人，按 QQ 合并）：${member.aka.join('；')}。片段里不同名字可能都是他。\n`
    : '\n';
  const mined = member.minedAliases || [];
  const aliasBlock = mined.length
    ? `\n【别人怎么叫他（全量统计，供参考）】\n${mined.map((a) => `- ${a.name}：别人说了 ${a.usage} 条、${a.speakers} 人；叫完后他 5 分钟内接话 ${Math.round(a.lift * 100)}%（全群基线 ${Math.round((member.baseLift || 0) * 100)}%）；常用者：${a.top.map(([s, c]) => `${s}(${c})`).join('、')}；例：${a.examples[0] || ''}`).join('\n')}\n`
    : '';
  const calls = member.callsOthers || [];
  const callsBlock = calls.length
    ? `\n【他给别人起的外号（全量统计，供参考）】\n${calls.map((a) => `- 「${a.alias}」→ ${a.whoName}：他说了 ${a.usage} 次，其中 ${a.count} 次是 ${a.whoName} 接话（是他平时接话率的 ${a.lift} 倍）；例：${a.example}`).join('\n')}\n`
    : '';
  return `下面是群友「${member.name}」（QQ ${member.qq}${alias.length ? `，历史昵称：${alias.join(' / ')}` : ''}）的 ${n} 段真实对话片段，按时间排序。
每段是一段连续聊天（时间上接近、通常围绕同一个话题），带日期与场景（群/私聊）。
标 \`>>>\` 的是他本人说的话；标 \`[鲸鲸]\` 的是群里的机器人鲸鲸；其余是别人。${akaLine}
【全量统计】总发言 ${stats.msgs} 条，分布在 ${stats.convs} 个会话；平均每句 ${stats.avgLen} 字；最活跃时段 ${stats.activeHours.join('、')} 点。${aliasBlock}${callsBlock}

【硬性要求】
1. 只能依据片段，禁止推测、禁止编造。片段里没有的（职业、地点、游戏、关系）一律不写。
2. catchphrases：3~8 条，只收他自己（>>>）反复说的短语，2~8 字，原样摘录。优先级：
   a) 他独有的叫法/梗——他给机器人或群友起的外号、固定玩梗、专属称呼（如把鲸鲸叫成某个梗），哪怕只出现 2~3 次也要收；
   b) 他自己的语气词/脏话口头禅；
   不要通用词（「游戏」「一个」「就是」）；不要从长句里截半句；不要收群里已有的普通昵称。
3. quotes：逐字摘录 3~5 句他的原话（<=30 字），必须能在片段里找到原文，带片段日期（YYYY-MM-DD）。
4. stance：他有明确表态的观点/立场（如对某事的态度、支持/反对什么），0~5 条，每条 <=20 字；没有就空数组。
5. habits：说话/生活上的习惯（如「爱用图片回话」「凌晨活跃」「一句话拆几条发」），0~5 条。
6. saysToBot：他怎么跟鲸鲸说话（逗它、使唤它、吐槽它），一句话；片段里没有互动就空字符串。
7. runningJokes：片段里他参与的群内梗/黑话，0~5 条，每条 2~10 字。
8. relations：只写片段里真实出现的互动，0~5 条，{who, how}，who 用片段里的昵称。
9. summary：<=80 字，说清「他是谁 / 说话什么路子 / 爱聊什么 / 在群里什么角色」。
10. activeTime：片段里他出没的时间段。
11. contexts：分场景各一句话——群聊里的他、私聊里的他（没有该场景就给空字符串），各 <=50 字。
12. nicknames：结合「别人怎么叫他」统计和片段，确认他的外号，0~6 条，{name, kind, note}。
    kind 只能是「外号」「名字截断」「戏称」；note <=20 字（谁在叫、什么语气）；
    只收片段或统计里真实出现过的称呼，明显是别人的名字不要收。
13. callsOthers：结合「他给别人起的外号」统计，确认他常用的称呼，0~6 条，{who, alias, note}；
    who 用统计里的名字，alias 是他叫对方的词，note <=20 字（怎么叫、什么语气）。

只输出 JSON，不要 markdown 代码块，不要解释：
{"summary":"...","catchphrases":["..."],"topics":["..."],"tone":"...","relations":[{"who":"...","how":"..."}],"activeTime":"...","stance":["..."],"habits":["..."],"saysToBot":"...","runningJokes":["..."],"quotes":[{"text":"...","date":"YYYY-MM-DD"}],"contexts":{"group":"...","private":"..."},"nicknames":[{"name":"...","kind":"外号","note":"..."}],"callsOthers":[{"who":"...","alias":"...","note":"..."}]}

${slicesText}`;
}

/* ---------------- 模型 ---------------- */
async function callModel(prov, messages) {
  const body = {
    model: prov.model,
    messages,
    temperature: 0.3,
    max_tokens: 4000,
    thinking: { type: 'disabled' },
    response_format: { type: 'json_object' },
  };
  const res = await fetch(prov.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${prov.key}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(180000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  const j = JSON.parse(text);
  const ch = j.choices?.[0];
  const content = ch?.message?.content ?? '';
  if (!content) throw new Error(`空 content（finish=${ch?.finish_reason}）`);
  return { content, usage: j.usage || {} };
}

function extractJson(s) {
  const t = String(s || '').replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const a = t.indexOf('{');
  const b = t.lastIndexOf('}');
  if (a < 0 || b <= a) throw new Error('没有 JSON 对象');
  return JSON.parse(t.slice(a, b + 1));
}

/* ---------------- 校验 ---------------- */
const STOP = new Set(['游戏', '一个', '就是', '什么', '这个', '那个', '他们', '我们', '你们', '可以', '没有',
  '知道', '现在', '还是', '这么', '那么', '已经', '应该', '然后', '所以', '但是', '好像', '不过', '时候',
  '直接', '还有', '今天', '自己', '这样', '那样', '因为', '如果', '虽然', '有点', '觉得', '一次', '一点']);

function validate(parsed, ctx) {
  const { myTexts, memberNames } = ctx;
  const countIn = (ph) => myTexts.reduce((n, t) => n + (t.split(ph).length - 1), 0);
  const out = {};
  out.summary = typeof parsed.summary === 'string' ? parsed.summary.trim().slice(0, 80) : '';
  out.catchphrases = [];
  for (const c of Array.isArray(parsed.catchphrases) ? parsed.catchphrases : []) {
    if (typeof c !== 'string') continue;
    const v = c.trim();
    if (v.length < 2 || v.length > 8) continue;
    if (STOP.has(v)) { console.warn(`    ! 丢弃「${v}」：通用词`); continue; }
    if (memberNames.some((n) => v.includes(n) && !ctx.botNames.includes(v))) { console.warn(`    ! 丢弃「${v}」：含群友昵称`); continue; }
    const n = countIn(v);
    if (n < 2) { console.warn(`    ! 丢弃「${v}」：全量只出现 ${n} 次`); continue; }
    if (!out.catchphrases.includes(v)) out.catchphrases.push(v);
    if (out.catchphrases.length >= 8) break;
  }
  out.topics = (Array.isArray(parsed.topics) ? parsed.topics : []).filter((t) => typeof t === 'string' && t.trim()).map((t) => t.trim().slice(0, 8)).slice(0, 8);
  out.tone = typeof parsed.tone === 'string' ? parsed.tone.trim().slice(0, 40) : '';
  out.relations = (Array.isArray(parsed.relations) ? parsed.relations : [])
    .filter((r) => r && typeof r.who === 'string' && typeof r.how === 'string')
    .map((r) => ({ who: r.who.trim().slice(0, 20), how: r.how.trim().slice(0, 40) })).slice(0, 5);
  out.activeTime = typeof parsed.activeTime === 'string' ? parsed.activeTime.trim().slice(0, 40) : '';
  out.stance = (Array.isArray(parsed.stance) ? parsed.stance : []).filter((t) => typeof t === 'string' && t.trim()).map((t) => t.trim().slice(0, 40)).slice(0, 5);
  out.habits = (Array.isArray(parsed.habits) ? parsed.habits : []).filter((t) => typeof t === 'string' && t.trim()).map((t) => t.trim().slice(0, 40)).slice(0, 5);
  out.saysToBot = typeof parsed.saysToBot === 'string' ? parsed.saysToBot.trim().slice(0, 60) : '';
  out.runningJokes = (Array.isArray(parsed.runningJokes) ? parsed.runningJokes : []).filter((t) => typeof t === 'string' && t.trim()).map((t) => t.trim().slice(0, 20)).slice(0, 5);
  const c = parsed.contexts && typeof parsed.contexts === 'object' ? parsed.contexts : {};
  out.contexts = {
    group: typeof c.group === 'string' ? c.group.trim().slice(0, 60) : '',
    private: typeof c.private === 'string' ? c.private.trim().slice(0, 60) : '',
  };
  out.nicknames = [];
  for (const nk of Array.isArray(parsed.nicknames) ? parsed.nicknames : []) {
    if (!nk || typeof nk.name !== 'string') continue;
    const name = nk.name.trim();
    if (name.length < 2 || name.length > 10) continue;
    if (ctx.countByOthers(name) < 2) { console.warn(`    ! 丢弃外号「${name}」：别人没这么叫过`); continue; }
    const kind = ['外号', '名字截断', '戏称'].includes(nk.kind) ? nk.kind : '外号';
    out.nicknames.push({ name, kind, note: typeof nk.note === 'string' ? nk.note.trim().slice(0, 20) : '' });
    if (out.nicknames.length >= 6) break;
  }
  out.callsOthers = [];
  for (const ck of Array.isArray(parsed.callsOthers) ? parsed.callsOthers : []) {
    if (!ck || typeof ck.alias !== 'string' || typeof ck.who !== 'string') continue;
    const alias = ck.alias.trim();
    const who = ck.who.trim();
    if (alias.length < 2 || alias.length > 10 || !who) continue;
    if (ctx.countByHim(alias) < 2) { console.warn(`    ! 丢弃「${alias}→${who}」：他没这么叫过`); continue; }
    out.callsOthers.push({ who: who.slice(0, 20), alias, note: typeof ck.note === 'string' ? ck.note.trim().slice(0, 20) : '' });
    if (out.callsOthers.length >= 6) break;
  }
  // quotes 必须逐字出自他的消息
  out.quotes = [];
  for (const q of Array.isArray(parsed.quotes) ? parsed.quotes : []) {
    if (!q || typeof q.text !== 'string') continue;
    const text = q.text.trim();
    if (text.length < 2) continue;
    const found = myTexts.find((t) => t.includes(text));
    if (!found) { console.warn(`    ! 丢弃 quote「${text.slice(0, 20)}」：全量里找不到原文`); continue; }
    out.quotes.push({ text: text.slice(0, 60), date: typeof q.date === 'string' ? q.date.slice(0, 10) : '' });
    if (out.quotes.length >= 5) break;
  }
  // 把「他反复说、且几乎只有他在说」的梗提升为口头禅（模型常把这类归到 runningJokes）
  for (const j of out.runningJokes) {
    if (out.catchphrases.includes(j)) continue;
    if (j.length < 2 || j.length > 8) continue;
    if (countIn(j) < 2) continue;
    const sp = ctx.speakersOf(j);
    if (sp > 2) { console.warn(`    ! 梗「${j}」有 ${sp} 个人在说，不提升`); continue; }
    out.catchphrases.unshift(j);
    if (out.catchphrases.length >= 8) out.catchphrases.length = 8;
    console.warn(`    + 梗「${j}」提升为口头禅（${sp} 人说，他 ${countIn(j)} 次）`);
  }
  return out;
}

/* ---------------- 主流程 ---------------- */
const opt = parseArgs(process.argv.slice(2));
const t0 = Date.now();
console.log('=== llm-member-slices (v3) ===');
console.log('records:', opt.records);

const recs = loadRecords(opt.records, opt.botNames);
const ident = buildIdentity(recs);
console.log(`有效消息 ${recs.length}；按昵称补 QQ ${ident.merged} 条；昵称表 ${ident.nameIndex.size} 个`);
const namesSorted = knownNames(ident.nameIndex);
const bursts = buildBursts(recs, opt.gap);
console.log(`burst ${bursts.length} 个（间隔 >${opt.gap} 分钟切段）`);

// 找目标（支持 QQ / 昵称 / 昵称片段；昵称走时间线解析）
const q = opt.only.trim();
let qq = /^\d+$/.test(q) ? q : (ident.resolve(q) || '');
if (!qq) {
  const cand = [...ident.nameIndex.keys()].find((n) => n.includes(q));
  if (cand) qq = ident.resolve(cand);
}
if (!qq) throw new Error(`找不到「${q}」对应的 QQ`);
const mineAll = recs.filter((r) => r.qq === qq);
if (!mineAll.length) throw new Error(`QQ ${qq} 没有消息`);
const nameCount = new Map();
const nameLast = new Map();
for (const r of mineAll) {
  nameCount.set(r.sender, (nameCount.get(r.sender) || 0) + 1);
  if (!nameLast.has(r.sender) || r.ts > nameLast.get(r.sender)) nameLast.set(r.sender, r.ts);
}
// 显示名用「最近一次用的昵称」；历史昵称全部作为别名用于点名匹配
const nameOrder = [...nameCount.keys()].sort((a, b) => (nameLast.get(b) > nameLast.get(a) ? 1 : -1));
const akaMap = new Map();
for (const r of mineAll) {
  const a = akaMap.get(r.sender) || { first: r.ts, last: r.ts, n: 0 };
  a.n += 1;
  if (r.ts < a.first) a.first = r.ts;
  if (r.ts > a.last) a.last = r.ts;
  akaMap.set(r.sender, a);
}
const aka = [...akaMap.entries()]
  .sort((a, b) => a[1].first.localeCompare(b[1].first))
  .map(([n, v]) => `${n}（${v.first.slice(0, 7)}~${v.last.slice(0, 7)}，${v.n} 条）`);
const member = { qq, name: nameOrder[0], aliases: nameOrder.slice(0, 8), aka };
const myTexts = mineAll.map((r) => r.text);
const convs = new Set(mineAll.map((r) => r.conv));
const hours = new Map();
for (const r of mineAll) { const h = Number(r.ts.slice(11, 13)); hours.set(h, (hours.get(h) || 0) + 1); }
const stats = {
  msgs: mineAll.length,
  convs: convs.size,
  avgLen: Math.round(myTexts.reduce((a, b) => a + b.length, 0) / myTexts.length),
  activeHours: [...hours.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([h]) => h),
};
const botQq = (() => {
  const c = new Map();
  for (const r of recs) if (opt.botNames.includes(r.sender) && r.qq) c.set(r.qq, (c.get(r.qq) || 0) + 1);
  return [...c.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || '';
})();
const memberNames = [...new Set(recs.map((r) => r.sender))].filter((n) => n && n.length >= 2 && !opt.botNames.includes(n));

/* ---- @ 锚点切片：别人 @ 他 → 他 5 分钟内的回应，连同前后文 ---- */
const convMsgs = new Map();
for (const r of recs) {
  if (!convMsgs.has(r.conv)) convMsgs.set(r.conv, []);
  convMsgs.get(r.conv).push(r);
}
for (const arr of convMsgs.values()) arr.sort((a, b) => (a.ts < b.ts ? -1 : 1));
const idxInConv = new Map();
for (const arr of convMsgs.values()) arr.forEach((m, i) => idxInConv.set(m, i));

const atHits = [];
for (const r of recs) {
  if (r.qq === qq || !r.text.includes('@')) continue;
  const ats = extractAts(r.text, namesSorted, ident.resolve, r.ts);
  if (ats.some((a) => a.qq === qq)) atHits.push(r);
}
const atSlices = [];
const seenAt = new Set();
for (const r of atHits) {
  const arr = convMsgs.get(r.conv);
  const i = idxInConv.get(r);
  if (i == null) continue;
  const reply = arr.slice(i + 1, i + 14).find((x) => x.qq === qq && (new Date(x.ts) - new Date(r.ts)) / 60000 <= 5);
  const endIdx = reply ? Math.min(arr.length, idxInConv.get(reply) + 3) : Math.min(arr.length, i + 8);
  const startIdx = Math.max(0, i - 2);
  const win = arr.slice(startIdx, Math.max(endIdx, startIdx + 3)).slice(0, 16);
  if (win.length < 3) continue;
  const key = `${r.conv}|${Math.floor(new Date(win[0].ts).getTime() / 300000)}`; // 5 分钟窗口去重
  if (seenAt.has(key)) continue;
  seenAt.add(key);
  atSlices.push({ why: reply ? '被@' : '被@未回', conv: r.conv, kind: r.convKind, start: win[0].ts, msgs: win });
}
console.log(`@ 到他的消息 ${atHits.length} 条 → @ 切片 ${atSlices.length} 个（有回应 ${atSlices.filter((s) => s.why === '被@').length}）`);

/* ---- 外号挖掘 + 外号锚点切片 ---- */
const aliasMine = mineAliases(convMsgs, qq, nameOrder);
console.log(`外号基线：接话率 ${(aliasMine.baseLift * 100).toFixed(1)}% / 第一回应者占比 ${(aliasMine.baseFirstShare * 100).toFixed(1)}%`);
console.log('外号候选：' + (aliasMine.rows.map((x) => `${x.name}(使用${x.usage}/lift${x.lift}/排他${x.firstShare})`).join('  ') || '(无)'));
const aliasSlices = [];
const aliasSeen = new Set();
for (const a of aliasMine.rows.slice(0, 4)) {
  let taken = 0;
  for (const arr of convMsgs.values()) {
    for (let i = 0; i < arr.length && taken < 2; i += 1) {
      const r = arr[i];
      if (r.qq === qq || !r.text.includes(a.name)) continue;
      const reply = arr.slice(i + 1, i + 12).find((x) => x.qq === qq && minutes(r, x) <= 5);
      if (!reply) continue;
      const start = Math.max(0, i - 1);
      const end = Math.min(arr.length, idxInConv.get(reply) + 3);
      const win = arr.slice(start, Math.max(end, start + 3)).slice(0, 14);
      const key = `${r.conv}|${Math.floor(new Date(win[0].ts).getTime() / 300000)}`;
      if (aliasSeen.has(key) || seenAt.has(key)) continue;
      aliasSeen.add(key);
      aliasSlices.push({ why: `外号:${a.name}`, conv: r.conv, kind: r.convKind, start: win[0].ts, msgs: win });
      taken += 1;
    }
  }
}
console.log(`外号切片 ${aliasSlices.length} 个`);
member.minedAliases = aliasMine.rows.slice(0, 6);
member.baseLift = aliasMine.baseLift;

/* ---- 反向：他给别人起的外号 ---- */
const lastSeen = new Map();
for (const r of recs) {
  if (!r.qq) continue;
  const cur = lastSeen.get(r.qq);
  if (!cur || r.ts > cur.ts) lastSeen.set(r.qq, { ts: r.ts, name: r.sender });
}
const callsMine = mineCallsToOthers(convMsgs, qq);
const calls = callsMine.rows.map((x) => ({ ...x, whoName: lastSeen.get(x.who)?.name || x.who }));
console.log(`他给别人起的外号：${calls.map((x) => `${x.alias}→${x.whoName}(${x.count}次/lift${x.lift})`).join('  ') || '(无)'}`);
member.callsOthers = calls.slice(0, 6);

const pickEvenly = (arr, n) => {
  if (!arr.length || n <= 0) return [];
  const step = arr.length / n;
  const out = [];
  for (let i = 0; i < n && i < arr.length; i += 1) out.push(arr[Math.floor(i * step)]);
  return out;
};
const atTake = Math.min(10, atSlices.length);
const aliasTake = Math.min(4, aliasSlices.length);
const baseOpt = { ...opt, slices: Math.max(10, opt.slices - atTake - aliasTake) };
const baseSlices = pickSlices(member, bursts, baseOpt);
const slices = [...pickEvenly(atSlices, atTake), ...pickEvenly(aliasSlices, aliasTake), ...baseSlices]
  .sort((a, b) => (a.start < b.start ? -1 : 1))
  .slice(0, opt.slices);
console.log(`目标：${member.name}（${qq}）${stats.msgs} 条 / ${stats.convs} 会话 / 选中 ${slices.length} 片`);
if (!opt.quiet) {
  const cnt = new Map();
  for (const s of slices) cnt.set(s.why, (cnt.get(s.why) || 0) + 1);
  console.log('分层：' + [...cnt.entries()].map(([k, v]) => `${k}${v}`).join(' / '));
}

const rendered = slices.map((s, i) => renderSlice({ ...s, i: i + 1, n: slices.length }, qq, member.name, opt.botNames, botQq));
const prompt = buildPrompt(member, stats, rendered.join('\n\n'), slices.length);
console.log(`prompt ${prompt.length} 字 ≈ ${Math.round(prompt.length / 1.6)} tokens`);

if (opt.dryRun) {
  const out = opt.out || '/tmp/slices-dry.txt';
  writeFileSync(out, prompt, 'utf8');
  console.log(`dry-run -> ${out}`);
  process.exit(0);
}

const prov = loadProvider(opt);
console.log(`model ${prov.model}`);
const r = await callModel(prov, [{ role: 'system', content: SYS }, { role: 'user', content: prompt }]);
const parsed = extractJson(r.content);
const speakerCache = new Map();
const speakersOf = (phrase) => {
  if (speakerCache.has(phrase)) return speakerCache.get(phrase);
  const set = new Set();
  for (const x of recs) if (x.text.includes(phrase)) set.add(x.qq || x.sender);
  speakerCache.set(phrase, set.size);
  return set.size;
};
const clean = validate(parsed, {
  myTexts, memberNames, botNames: opt.botNames, speakersOf,
  countByOthers: (name) => {
    let n = 0;
    for (const x of recs) if (x.qq !== qq && x.text.includes(name)) n += 1;
    return n;
  },
  countByHim: (name) => {
    let n = 0;
    for (const x of recs) if (x.qq === qq && x.text.includes(name)) n += 1;
    return n;
  },
});

const result = {
  version: 3,
  qq,
  name: member.name,
  stats,
  slices: slices.length,
  slicePlan: slices.reduce((m, s) => { m[s.why] = (m[s.why] || 0) + 1; return m; }, {}),
  llm: clean,
  model: prov.model,
  at: new Date().toISOString(),
  usage: { prompt_tokens: r.usage.prompt_tokens ?? 0, completion_tokens: r.usage.completion_tokens ?? 0 },
};
const outFile = opt.out || `/tmp/member-v2-${qq}.json`;
writeFileSync(outFile, `${JSON.stringify(result, null, 2)}\n`, 'utf8');

console.log(`\n--- ${member.name}（${qq}）---`);
console.log(`summary: ${clean.summary}`);
console.log(`catch:   ${clean.catchphrases.join(' / ') || '(空)'}`);
console.log(`topics:  ${clean.topics.join(' / ')}`);
console.log(`tone:    ${clean.tone}`);
console.log(`stance:  ${clean.stance.join(' / ') || '(空)'}`);
console.log(`habits:  ${clean.habits.join(' / ') || '(空)'}`);
console.log(`toBot:   ${clean.saysToBot || '(空)'}`);
console.log(`jokes:   ${clean.runningJokes.join(' / ') || '(空)'}`);
console.log(`quotes:  ${clean.quotes.map((x) => `${x.date} ${x.text.slice(0, 24)}`).join(' | ') || '(空)'}`);
console.log(`relations: ${clean.relations.map((x) => `${x.who}-${x.how}`).join('；')}`);
console.log(`contexts: 群=${clean.contexts.group || '(空)'} / 私=${clean.contexts.private || '(空)'}`);
console.log(`nicknames: ${clean.nicknames.map((x) => `${x.name}(${x.kind}${x.note ? '·' + x.note : ''})`).join(' / ') || '(空)'}`);
console.log(`callsOthers: ${clean.callsOthers.map((x) => `${x.alias}→${x.who}${x.note ? '(' + x.note + ')' : ''}`).join(' / ') || '(空)'}`);
console.log(`\n${((Date.now() - t0) / 1000).toFixed(1)}s，tokens ${result.usage.prompt_tokens}/${result.usage.completion_tokens}，-> ${outFile}`);
