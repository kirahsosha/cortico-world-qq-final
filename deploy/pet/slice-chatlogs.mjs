#!/usr/bin/env node
/**
 * 聊天记录粗切流水线：每份聊天记录按 4 种方式切成 4 份，每份配不同提示词，交给 AI 分析。
 *
 *   time   按时间粗切：同一会话相邻消息间隔 ≤30 分钟为一段（过长再按 60 条切）
 *   person 按人粗切：按 QQ 归并昵称，把某个人的发言每 40 条一组
 *   at     按 @ 粗切：每条含 @ 的消息取前后各 3~4 条（私聊不适用）
 *   alias  按外号/称呼粗切：短消息里高频称呼，取「叫 → 回应」窗口（私聊降级为 mention）
 *
 * 产物（全部落盘，便于逐步检查）：
 *   <out>/<conv>/00-records.jsonl
 *   <out>/<conv>/00-identity.json
 *   <out>/<conv>/01-slices/<type>.jsonl
 *   <out>/<conv>/02-prompts/<type>/<sliceId>.md
 *   <out>/<conv>/03-llm/<type>.jsonl
 *   <out>/<conv>/99-manifest.json
 *
 * 用法：
 *   node slice-chatlogs.mjs --records tmp/todo5/history-records.jsonl --out tmp/slices \
 *     --convs 周六约饭,倒爷请给我机会 --cap 10 [--types time,person,at,alias]
 *     [--llm] [--concurrency 4] [--provider /data/home/providers/deepseek] [--dry-run]
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/* ============ 参数 ============ */
function parseArgs(argv) {
  const o = {
    records: '',
    out: 'tmp/slices',
    convs: [],
    cap: 10,
    maxMsgs: 60,
    personBlock: 40,
    gap: 30,
    types: ['time', 'person', 'at', 'alias'],
    llm: false,
    concurrency: 4,
    provider: '/data/home/providers/deepseek',
    model: '',
    limit: 0,
    since: '',
    countOnly: false,
    olderCap: null,
    capByType: {},
    atWithReply: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--records') o.records = next();
    else if (a === '--out') o.out = next();
    else if (a === '--convs') o.convs = String(next() || '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--cap') o.cap = Math.max(1, Number(next()) || 10);
    else if (a === '--max-msgs') o.maxMsgs = Math.max(10, Number(next()) || 60);
    else if (a === '--person-block') o.personBlock = Math.max(5, Number(next()) || 40);
    else if (a === '--gap') o.gap = Math.max(1, Number(next()) || 30);
    else if (a === '--types') o.types = String(next() || '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--llm') o.llm = true;
    else if (a === '--dry-run') o.llm = false;
    else if (a === '--concurrency') o.concurrency = Math.max(1, Number(next()) || 4);
    else if (a === '--provider') o.provider = next();
    else if (a === '--model') o.model = next();
    else if (a === '--limit') o.limit = Math.max(0, Number(next()) || 0);
    else if (a === '--since') o.since = String(next() || '').replace(' ', 'T');
    else if (a === '--count-only') o.countOnly = true;
    else if (a === '--older-cap') o.olderCap = Math.max(0, Number(next()) || 0);
    else if (a === '--at-with-reply') o.atWithReply = true;
    else if (a.startsWith('--cap-')) {
      const t = a.slice('--cap-'.length);
      if (!['time', 'person', 'at', 'alias'].includes(t)) throw new Error(`未知参数: ${a}`);
      o.capByType[t] = Math.max(0, Number(next()) || 0);
    }
    else if (a === '--help' || a === '-h') { console.log('see header'); process.exit(0); }
    else throw new Error(`未知参数: ${a}`);
  }
  if (!o.records) throw new Error('缺少 --records');
  return o;
}

/* ============ 基础 ============ */
const NOISE = ['撤回了一条消息', '向你发起临时会话', '以上是打招呼', '请使用最新版手机QQ', '该用户通过',
  '发起了语音通话', '邀请你加入', '加入了群聊', '拍了拍', '上传了', '戳了戳', '群公告', '【DSH', '【鲸鲸告警】'];
// 系统类消息（正则版）：入群/邀请/改名/撤回 之类不是人说的话
const NOISE_RE = [/邀请了?.{0,12}加入/, /加入了本?群/, /修改群名/, /撤回了一条消息/];
const EMOJI_ONLY = /^\[(表情|动画表情)[^\]]*\]$/;
const PRONOUNS = new Set(['他', '她', '它', '你', '我', '他们', '她们', '你们', '我们', '这个', '那个',
  '这人', '那人', '大家', '自己', '别人', '啥', '谁', '有人', '没人', '对面', '这位', '那位']);
const STOP = new Set(['什么', '怎么', '就是', '不是', '可以', '没有', '知道', '现在', '还是', '这么', '那么',
  '已经', '应该', '然后', '所以', '但是', '好像', '不过', '时候', '直接', '还有', '今天', '自己', '这样',
  '那样', '因为', '如果', '虽然', '有点', '觉得', '一次', '一点', '这个', '那个', '他们', '我们', '你们',
  '哈哈', '哈哈哈', '哈哈哈哈', '卧槽', '我靠', '他妈', '真的', '一个', '不是', '给我', '你的', '我的', '就是']);

const norm = (t) => String(t).replace(/\s+/g, ' ').trim();
const minutes = (a, b) => (new Date(b.ts).getTime() - new Date(a.ts).getTime()) / 60000;
const mmdd = (ts) => ts.slice(5, 16).replace('T', ' ');
const slug = (s) => String(s).replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 40) || 'conv';

/** 等距抽 n 个，保留时间顺序（避免「取前 N 段」全落在早年） */
function evenly(arr, n) {
  if (n <= 0) return [];
  if (arr.length <= n) return arr;
  const step = arr.length / n;
  const out = [];
  for (let i = 0; i < n; i += 1) out.push(arr[Math.min(arr.length - 1, Math.floor(i * step))]);
  return out;
}

/**
 * 抽样：先保证「每个锚点/每个人/每个会话」各有一片，再按时间均匀补足。
 * 否则 evenly 会把某些锚点的片段全挤掉（例如「倒爷」明明是锚点却没进样例）。
 */
function sampleSlices(slices, cap) {
  if (slices.length <= cap) return slices;
  const keyOf = (s) => s.meta.token || s.meta.qq || s.meta.anchor || s.meta.offset || 'x';
  const groups = new Map();
  for (const s of slices) {
    const k = keyOf(s);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(s);
  }
  const keys = [...groups.keys()];
  const picked = [];
  // 锚点按强度排序取前 N（倒爷这种强锚点不会被均匀抽样挤掉）
  for (const k of keys.slice(0, cap)) picked.push(groups.get(k)[0]);
  const rest = slices.filter((s) => !picked.includes(s));
  picked.push(...evenly(rest, Math.max(0, cap - picked.length)));
  return picked.sort((a, b) => (a.start < b.start ? -1 : 1));
}

function loadRecords(file, botNames) {
  const out = [];
  const SYS_QQ = new Set(['10000', '1000000']);
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let r;
    try { r = JSON.parse(line); } catch { continue; }
    if (!r || r.kind === 'system') continue;
    // 系统消息直接按 QQ 过滤（10000/1000000），不再依赖文本特征
    if (r.qq != null && SYS_QQ.has(String(r.qq))) continue;
    if (r.sender === '系统消息') continue;
    const text = norm(r.text || '');
    if (!text || EMOJI_ONLY.test(text)) continue;
    if (NOISE.some((n) => text.includes(n))) continue;
    if (NOISE_RE.some((re) => re.test(text))) continue;
    out.push({
      ts: String(r.ts).replace(' ', 'T'),
      convQq: r.convQq == null ? null : String(r.convQq),
      conv: r.conv || '',
      convKind: r.convKind === 'group' ? 'group' : 'private',
      sender: r.sender || '',
      qq: r.qq == null ? null : String(r.qq),
      text: text.length > 400 ? text.slice(0, 400) : text,
    });
  }
  return out;
}

/** 昵称去装饰 + 时间线 → QQ */
function buildIdentity(recs) {
  const normName = (s) => String(s || '').replace(/^【[^】]{0,24}】\s*/, '').replace(/^\[[^\]]{0,24}\]\s*/, '').trim();
  const byName = new Map();
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
  const resolve = (name, ts) => {
    const list = nameIndex.get(normName(name));
    if (!list || !list.length) return null;
    if (list.length === 1) return list[0].qq;
    let best = list[0];
    let bestD = Infinity;
    for (const c of list) {
      const d = !ts ? 0 : ts < c.first ? (new Date(c.first) - new Date(ts)) : ts > c.last ? (new Date(ts) - new Date(c.last)) : 0;
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
  return { nameIndex, resolve, merged, normName };
}

/* ============ 四种粗切 ============ */
function sliceTime(msgs, opt) {
  const sorted = [...msgs].sort((a, b) => (a.ts < b.ts ? -1 : 1));
  const sessions = [];
  let cur = [];
  for (const m of sorted) {
    if (cur.length && minutes(cur[cur.length - 1], m) > opt.gap) { sessions.push(cur); cur = []; }
    cur.push(m);
  }
  if (cur.length) sessions.push(cur);
  // 太短的段（<4 条）并进前一段，避免切出「一个草字」这种切片
  const merged = [];
  for (const s of sessions) {
    if (s.length < 4 && merged.length) merged[merged.length - 1] = merged[merged.length - 1].concat(s);
    else merged.push(s);
  }
  const slices = [];
  for (const s of merged) {
    for (let i = 0; i < s.length; i += opt.maxMsgs) {
      const part = s.slice(i, i + opt.maxMsgs);
      if (part.length < 4) continue;
      slices.push({ kind: 'time', msgs: part, meta: { sessionMsgs: s.length, offset: i } });
    }
  }
  return { slices, total: merged.length };
}

function slicePerson(msgs, opt) {
  const byQq = new Map();
  for (const m of msgs) {
    if (!m.qq) continue;
    if (!byQq.has(m.qq)) byQq.set(m.qq, []);
    byQq.get(m.qq).push(m);
  }
  // 人多的排前面，避免 cap 只覆盖到最早出现的几个人
  const ordered = [...byQq.entries()].sort((a, b) => b[1].length - a[1].length);
  const slices = [];
  for (const [qq, arr] of ordered) {
    arr.sort((a, b) => (a.ts < b.ts ? -1 : 1));
    for (let i = 0; i < arr.length; i += opt.personBlock) {
      const block = arr.slice(i, i + opt.personBlock);
      if (block.length < 5) continue;
      slices.push({ kind: 'person', msgs: block, meta: { qq, total: arr.length, offset: i } });
    }
  }
  return { slices, total: byQq.size };
}

function sliceAt(msgs, opt) {
  if (msgs.length && msgs[0].convKind === 'private') return { slices: [], total: 0 };
  const sorted = [...msgs].sort((a, b) => (a.ts < b.ts ? -1 : 1));
  const slices = [];
  const seen = new Set();
  for (let i = 0; i < sorted.length; i += 1) {
    if (!sorted[i].text.includes('@')) continue;
    // 只要「被 @ 后有人回应」的片段（一次性的 @ 信息量低）
    if (opt.atWithReply) {
      const replied = sorted.slice(i + 1, i + 10).some((x) => x.qq !== sorted[i].qq && minutes(sorted[i], x) <= 5);
      if (!replied) continue;
    }
    const key = Math.floor(new Date(sorted[i].ts).getTime() / 300000);
    if (seen.has(key)) continue;
    seen.add(key);
    const win = sorted.slice(Math.max(0, i - 3), Math.min(sorted.length, i + 5));
    if (win.length < 2) continue;
    // 解析被 @ 的人：已知昵称最长匹配（@ 后面可能带空格）
    const anchorText = sorted[i].text;
    const atPos = anchorText.indexOf('@');
    let toName = '';
    if (atPos >= 0) {
      const rest = anchorText.slice(atPos + 1, atPos + 30);
      const names = opt.knownNameList || [];
      for (const n of names) if (rest.startsWith(n)) { toName = n; break; }
      if (!toName) {
        const m = /^([^\s@，,。!！?？:：]{1,16})/.exec(rest);
        if (m) toName = m[1];
      }
    }
    const toQq = toName ? (opt.resolve ? opt.resolve(toName, sorted[i].ts) : null) : null;
    // 「@浮生闪华」这种：整串不在昵称表里，就退一步找串里包含的已知昵称（闪华）
    let toQq2 = toQq;
    let toName2 = toName;
    if (!toQq2 && toName) {
      for (const n of opt.knownNameList || []) {
        if (n.length >= 2 && toName.includes(n)) {
          const q = opt.resolve ? opt.resolve(n, sorted[i].ts) : null;
          if (q) { toQq2 = q; toName2 = n; break; }
        }
      }
    }
    slices.push({
      kind: 'at',
      msgs: win,
      meta: {
        anchor: sorted[i].ts,
        by: sorted[i].sender,
        byQq: sorted[i].qq || '',
        toName: toName2,
        toQq: toQq2 || '',
      },
    });
  }
  return { slices, total: slices.length };
}

/** 外号/称呼粗切：只锚在「已知昵称 / 昵称前缀 / 叫完有人固定接」的词上；私聊降级为「提及 + 约定」 */
function sliceAlias(msgs, opt) {
  const sorted = [...msgs].sort((a, b) => (a.ts < b.ts ? -1 : 1));
  const privateConv = sorted.length > 0 && sorted[0].convKind === 'private';
  const known = opt.knownNames || new Set();
  const prefixes = opt.knownPrefixes || new Set();
  const CJK = /^[\u4e00-\u9fa5]{2,4}$/;
  const minFreq = Math.max(3, Math.min(10, Math.round(sorted.length / 500)));

  // 锚点 1：已知昵称 / 昵称前缀（2~4 字，纯中文；排除代词）
  const hit = new Map();
  for (const m of sorted) {
    const t = m.text;
    for (let n = 2; n <= 4; n += 1) {
      for (let i = 0; i + n <= t.length; i += 1) {
        const sub = t.slice(i, i + n);
        if (!CJK.test(sub) || STOP.has(sub) || PRONOUNS.has(sub)) continue;
        if (!known.has(sub) && !prefixes.has(sub)) continue;
        hit.set(sub, (hit.get(sub) || 0) + 1);
      }
    }
  }
  // 前缀必须能独立当称呼用（开头/整条/@后），否则是「我不」这种句子碎片
  const anchors = [];
  for (const [g, n] of [...hit.entries()].sort((a, b) => b[1] - a[1])) {
    if (known.has(g)) {
      if (n >= minFreq) anchors.push({ token: g, count: n, kind: 'name' });
    } else if (!privateConv) {
      // 只保留「该昵称最短的、够频次的」前缀（鸡哥 > 鸡哥明天，游公 > 游公子专用司机）
      const parents = [...known].filter((nm) => nm.length > g.length && nm.startsWith(g));
      if (!parents.length) continue;
      let ok = false;
      for (const parent of parents) {
        let shortest = parent;
        for (let k = 2; k < parent.length && k <= 4; k += 1) {
          const p = parent.slice(0, k);
          if ((hit.get(p) || 0) >= minFreq) { shortest = p; break; }
        }
        if (shortest === g) { ok = true; break; }
      }
      if (!ok) continue;
      // 行为证据：说这个词之后，主要就那么一个人接话
      let replied = 0;
      const resp = new Map();
      for (let i = 0; i < sorted.length; i += 1) {
        const m = sorted[i];
        if (!m.text.includes(g)) continue;
        const first = sorted.slice(i + 1, i + 12).find((x) => x.qq !== m.qq && minutes(m, x) <= 5);
        if (!first) continue;
        replied += 1;
        const k = first.qq || `name:${first.sender}`;
        resp.set(k, (resp.get(k) || 0) + 1);
      }
      if (replied < 5) continue;
      const topResp = Math.max(...resp.values());
      if (topResp / replied >= 0.5) anchors.push({ token: g, count: n, kind: 'name' });
    }
    if (anchors.length >= 10) break;
  }

  // 锚点 2（仅群聊）：短消息里「叫完 5 分钟内总是同一个人接」的词 —— 捕捉不在昵称表里的外号
  if (!privateConv) {
    const cand = new Map();
    for (let i = 0; i < sorted.length; i += 1) {
      const m = sorted[i];
      if (m.text.length > 12) continue;
      const s = m.text.replace(/@\S+/g, ' ').replace(/[^\u4e00-\u9fa5]/g, '');
      for (let n = 2; n <= 4; n += 1) {
        for (let j = 0; j + n <= s.length; j += 1) {
          const g = s.slice(j, j + n);
          if (!STOP.has(g) && !PRONOUNS.has(g)) cand.set(g, (cand.get(g) || 0) + 1);
        }
      }
    }
    const top = [...cand.entries()].filter(([, n]) => n >= minFreq).sort((a, b) => b[1] - a[1]).slice(0, 30);
    for (const [g] of top) {
      if (hit.has(g)) continue;
      let replied = 0;
      const resp = new Map();
      for (let i = 0; i < sorted.length; i += 1) {
        const m = sorted[i];
        if (m.text.length > 12 || !m.text.includes(g)) continue;
        const first = sorted.slice(i + 1, i + 10).find((x) => x.qq !== m.qq && minutes(m, x) <= 5);
        if (!first) continue;
        replied += 1;
        const k = first.qq || `name:${first.sender}`;
        resp.set(k, (resp.get(k) || 0) + 1);
      }
      if (replied < 3) continue;
      const topResp = Math.max(...resp.values());
      if (topResp / replied >= 0.6) anchors.push({ token: g, count: cand.get(g), kind: 'alias' });
    }
  }

  // 锚点 3（私聊）：约定/事件词 —— 私聊没有 @ 和第三人，最有价值的是「约了什么」
  if (privateConv) {
    const EVENT = ['见面', '约', '几点', '地址', '车票', '酒店', '生日', '考试', '出发', '回家', '吃饭',
      '多少钱', '转账', '快递', '到了', '请假', '面试', '加班', '下班', '周末', '明天', '下周', '订', '买'];
    const ev = new Map();
    for (const m of sorted) for (const w of EVENT) if (m.text.includes(w)) ev.set(w, (ev.get(w) || 0) + 1);
    for (const [w, n] of [...ev.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6)) {
      if (n >= 2) anchors.push({ token: w, count: n, kind: 'event' });
    }
  }

  // 去掉被更短锚点包含的长名字锚点（倒爷 > 倒爷请）
  const finalAnchors = anchors.filter((a, i) => !(a.kind === 'name'
    && anchors.some((b) => b !== a && b.kind === 'name' && b.token.length < a.token.length && a.token.startsWith(b.token))));
  const slices = [];
  for (const a of finalAnchors) {
    let taken = 0;
    for (let i = 0; i < sorted.length && taken < 2; i += 1) {
      if (!sorted[i].text.includes(a.token)) continue;
      const win = sorted.slice(Math.max(0, i - 2), Math.min(sorted.length, i + 5));
      if (win.length < 3) continue;
      slices.push({
        kind: privateConv ? 'mention' : 'alias',
        msgs: win,
        meta: { token: a.token, anchorKind: a.kind, convKind: privateConv ? 'private' : 'group' },
      });
      taken += 1;
      i += 8;
    }
  }
  return { slices, total: anchors.length };
}

/* ============ 提示词 ============ */
const SYS = `你是 QQ 聊天记录分析员。你收到的是从真实聊天记录里【粗切】出来的一段材料，以及「这是什么材料、怎么切出来的」说明。
只依据材料里出现的内容分析，不补充材料外的信息；材料没写的不猜。输出严格 JSON，不要 markdown 代码块，不要解释。`;

const PROMPTS = {
  time: (s) => `# 这段材料是什么
一段${s.convKind === 'group' ? '群聊' : '私聊'}的连续聊天记录，按【时间】粗切：同一会话里相邻消息间隔不超过 ${s.gap} 分钟归为一段。
- 会话：「${s.conv}」，本段 ${s.msgs.length} 条，时间 ${fmtTs(s.start)} ~ ${fmtTs(s.end)}
- 一刀切下去可能包含多个小话题，也可能只是几句寒暄；不要假设它是一个完整话题。
- 记录格式：\`[YYYY-MM-DD HH:MM] QQ号/邮箱(昵称): 内容\`。**同一个 ID（QQ 号或邮箱）就是同一个人**（他可能改过很多次昵称）。
- 行首 \`?(昵称)\` 表示这条**没能确定身份**（导出里既没有 QQ 也没有邮箱）：可能是导出者本人，也可能是对方改过昵称；结合上下文判断，不要硬猜，也不要因此把两个人合并。
- 本段人物（QQ ← 昵称）：
${s.roster}
${s.truncated ? `- 注意：这个会话总共切出 ${s.totalSlices} 段，本段只是其中一段。\n` : ''}${s.convKind === 'group' ? '- 标 [鲸鲸] 的是机器人鲸鲸，其余是真人。\n' : ''}
# 聊天记录
${s.lines}

# 请你分析
把「这一段时间里发生的事情」整理成可复用的记忆。要求：
1. topic：这段主要在聊什么，一句话（<=20 字）。
2. summary：<=80 字，客观概括，不要评价。
3. participants：出现的人（<=6 个），{name, role, said}；
   - name：**填 QQ 号**（与记录里一致，便于定位）；role 只能是「主导」「附和」「提问」「潜水」；said 是他的代表性原话（<=20 字，逐字）。
4. threads：这段里并列的几条话题线（0~4 条，每条 <=12 字）。
5. facts：值得长期记住的事实（约定、时间地点、人物信息、决定、结果），0~5 条，每条 <=40 字；没有就空数组。
6. memes：这段出现的梗/黑话/外号，0~4 条。
7. mood：氛围，<=10 字（如「轻松」「互怼」「冷场」）。
8. followups：没聊完/待办的事，0~3 条。

只输出 JSON：
{"topic":"","summary":"","participants":[{"name":"","role":"","said":""}],"threads":[""],"facts":[""],"memes":[""],"mood":"","followups":[""]}`,

  person: (s) => `# 这段材料是什么
【某个人】在【某个会话】里自己的发言，按【人】粗切：按 QQ 号把他的所有昵称归并，把他自己的话按时间每 ${s.block} 条一组。
- 目标：QQ ${s.qq}${s.aka.length > 1 ? `（历史昵称：${s.aka.join(' / ')}）` : ''}
- 会话：「${s.conv}」；本段 ${s.msgs.length} 条，时间 ${fmtTs(s.start)} ~ ${fmtTs(s.end)}
- **本段只有他自己的话，没有别人的上下文**；所以不要推测他在回应谁、也不要脑补没说过的事。
- 记录格式：\`[YYYY-MM-DD HH:MM] QQ号/邮箱(昵称): 内容\`（都是他说的）。
${s.truncated ? `- 注意：他共有 ${s.totalMsgs} 条发言，本段只是其中一段。\n` : ''}
# 他的发言
${s.lines}

# 请你分析
只根据这些原话，整理这个人的画像。要求：
1. persona：<=60 字，「他是谁 / 说话什么路子 / 关心什么」。
2. catchphrases：他自己的口头禅/梗，0~6 条，每条 2~8 字，必须逐字出现在上面。
3. topics：反复聊的话题，2~6 个，每个 <=8 字。
4. tone：语气，<=20 字。
5. stance：他明确表达过的观点/态度，0~4 条，每条 <=30 字。
6. habits：说话习惯（拆句、爱用问号、爱发图…），0~4 条。
7. quotes：3~5 句代表性原话，逐字，<=30 字，带日期（完整 YYYY-MM-DD）。
8. relations：从他的话里能看出的关系（提到谁、怎么提），0~4 条，{who, how}；who 填 QQ 号或记录里出现的标识。

只输出 JSON：
{"persona":"","catchphrases":[""],"topics":[""],"tone":"","stance":[""],"habits":[""],"quotes":[{"text":"","date":""}],"relations":[{"who":"","how":""}]}`,

  at: (s) => `# 这段材料是什么
以【@】为中心粗切出来的互动片段：同一会话里，每条「有人 @ 某人」的消息，取它前后各 3~4 条。
- 会话：「${s.conv}」；本段 ${s.msgs.length} 条，锚点是 ${fmtTs(s.anchor)}，${s.byLabel} @ ${s.toLabel || '某人'}
- 本段可能跨话题；@ 的对象可能不止一个。
- 记录格式：\`[YYYY-MM-DD HH:MM] QQ号/邮箱(昵称): 内容\`。**同一个 ID（QQ 号或邮箱）就是同一个人**（可能改过昵称）。
- 行首 \`?(昵称)\` 表示这条**没能确定身份**（导出里既没有 QQ 也没有邮箱）：可能是导出者本人，也可能是对方改过昵称；结合上下文判断，不要硬猜，也不要因此把两个人合并。
- 本段人物（QQ ← 昵称）：
${s.roster}
# 聊天记录
${s.lines}

# 请你分析
重点看「谁在叫谁、为什么叫、被叫的人怎么接」。
1. interactions：0~4 条，{from, to, ask, reply, response}；
   - from / to：**填 QQ 号**（与记录一致）
   - ask：@ 的那句话在问/要什么（<=20 字）
   - reply：被 @ 的人怎么回应（逐字，<=20 字；没回应就空字符串）
   - response：只能填「答了」「没答」「打岔」「反问」「表情」
2. relationHints：从这次互动看出的关系，0~3 条，每条 <=20 字（如「上下级」「熟人互怼」「求助」）。
3. notable：这段里值得记住的信息，0~3 条。

只输出 JSON：
{"interactions":[{"from":"","to":"","ask":"","reply":"","response":""}],"relationHints":[""],"notable":[""]}`,

  alias: (s) => `# 这段材料是什么
以【外号/称呼】为中心粗切出来的片段：先统计「叫完这个名字后 5 分钟内谁接话」，再把包含高频称呼的对话切出来。
- 会话：「${s.conv}」；本段 ${s.msgs.length} 条，锚点称呼「${s.token}」
- 注意：这个「称呼」可能是真外号、也可能是普通词/别人的名字，需要你根据上下文判断。
- 记录格式：\`[YYYY-MM-DD HH:MM] QQ号/邮箱(昵称): 内容\`。**同一个 ID（QQ 号或邮箱）就是同一个人**；昵称会变，ID 不变。
- 行首 \`?(昵称)\` 表示这条**没能确定身份**（导出里既没有 QQ 也没有邮箱）：可能是导出者本人，也可能是对方改过昵称；结合上下文判断，不要硬猜，也不要因此把两个人合并。
- 本段人物（QQ ← 昵称）：
${s.roster}
# 聊天记录（>>> 是被称呼的人，» 是提到这个称呼的消息）
${s.lines}

# 请你分析
1. aliases：这段出现的称呼，0~3 条，{alias, target, usedBy, tone, evidence}；
   - target：这个称呼指向谁，**必须从上面的「本段人物」表里选一个 ID**（QQ 号或邮箱）；表里没有就填「不确定」，绝对不要编造
   - usedBy：谁在这么叫（**填 QQ 号**，多个用逗号）
   - tone：只能填「亲昵」「调侃」「贬义」「中性」
   - evidence：一句能证明的原话（<=24 字）
2. uncertain：这句称呼是不是外号，拿不准就写 1，拿得准写 0。
3. notable：从这段能看出的相处方式，0~2 条。

只输出 JSON：
{"aliases":[{"alias":"","target":"","usedBy":"","tone":"","evidence":""}],"uncertain":0,"notable":[""]}`,

  mention: (s) => `# 这段材料是什么
【私聊】里以「称呼 / 提及 / 约定」为中心粗切出来的片段：消息开头直接叫对方、提到群里其他人、或说到约定和事件的地方。
- 会话：「${s.conv}」（私聊）；本段 ${s.msgs.length} 条
- 本段锚点：${s.anchorKind === 'event' ? `约定/事件词「${s.token}」` : `称呼/提及「${s.token}」`}
- 私聊里没有 @ 和多人接话，所以这里看的是「怎么称呼对方」「提到了谁」「约了什么」。
- 记录格式：\`[YYYY-MM-DD HH:MM] QQ号/邮箱(昵称): 内容\`。私聊里通常只有两个 ID，同一个 ID 就是同一个人（昵称会变）。
- 行首 \`?(昵称)\` 表示这条**没能确定身份**（导出里既没有 QQ 也没有邮箱）：可能是导出者本人，也可能是对方改过昵称；结合上下文判断，不要硬猜，也不要因此把两个人合并。
- 本会话对象：「${s.conv}」（ID ${s.convQq || '未知'}）；但对方可能改过昵称，\`?\` 开头的行可能是他，也可能是导出者本人。
- 本段人物（QQ ← 昵称）：
${s.roster}
# 聊天记录
${s.lines}

# 请你分析
1. addresses：他怎么称呼对方，0~3 条，{name, tone, evidence}；
   - name：**填对方 QQ 号**；tone 只能填「亲昵」「调侃」「客套」「中性」
2. mentions：这段提到的第三方（群里其他人），0~4 条，{who, what, relation}；who 填 QQ 号或记录里的标识，what 是提到他什么事（<=20 字）。
3. events：这段里的约定/事件（时间、地点、和谁、做什么），0~3 条，{what, when, where, who}；没有就空数组。when 用完整日期（YYYY-MM-DD HH:MM）。
4. tone：这段私聊的整体语气，<=10 字。
5. notable：值得记住的信息，0~2 条。

只输出 JSON：
{"addresses":[{"name":"","tone":"","evidence":""}],"mentions":[{"who":"","what":"","relation":""}],"events":[{"what":"","when":"","where":"","who":""}],"tone":"","notable":[""]}`,
};

/* ============ 渲染 ============ */
/** 提示词里的时间一律带年份：`2024-06-20 21:51`（不截年份） */
const fmtTs = (ts) => String(ts).slice(0, 16).replace('T', ' ');

/** 每行：`[YYYY-MM-DD HH:MM] QQ号/邮箱(昵称): 内容`；没有 QQ 才退回昵称 */
function renderLines(msgs, opts = {}) {
  return msgs.map((m) => {
    let tag = '';
    if (opts.mark) tag = opts.mark(m) ? '>>> ' : '';
    else if (opts.token) tag = m.text.includes(opts.token) ? '» ' : '';
    // 有 ID 显示 ID(昵称)；没 ID 显示 ?(昵称)，交给 AI 结合上下文判断
    const who = m.qq ? `${m.qq}(${m.sender})` : `?(${m.sender})`;
    return `[${fmtTs(m.ts)}] ${tag}${who}: ${m.text}`;
  }).join('\n');
}

function buildPrompt(type, slice, ctx) {
  const isAliasType = type === 'alias' || type === 'mention';
  // 本段人物对照：QQ ← 最近昵称 / 曾用名（让模型能把「鸡哥」对上 QQ）
  const qqSet = [...new Set(slice.msgs.map((m) => m.qq).filter(Boolean))].slice(0, 8);
  const roster = qqSet.map((qq) => {
    const names = (ctx.qqNames && ctx.qqNames.get(qq)) || [];
    const latest = (ctx.latestName && ctx.latestName.get(qq)) || names[names.length - 1] || '';
    const aka = names.filter((n) => n !== latest).slice(-3);
    return `${qq}（${latest}${aka.length ? `；曾用名：${aka.join('/')}` : ''}）`;
  }).join('\n');
  const s = {
    conv: slice.conv,
    convKind: slice.convKind,
    msgs: slice.msgs,
    roster,
    gap: ctx.gap,
    start: slice.msgs[0].ts,
    end: slice.msgs[slice.msgs.length - 1].ts,
    truncated: slice.truncated,
    totalSlices: slice.totalSlices,
    token: slice.meta.token || '',
    anchor: slice.meta.anchor || slice.msgs[0].ts,
    by: slice.meta.by || '',
    byLabel: slice.meta.byQq || slice.meta.by || '',
    toLabel: slice.meta.toQq || slice.meta.toName || '',
    anchorKind: slice.meta.anchorKind || 'name',
    name: slice.meta.name || '',
    convQq: (slice.msgs.find((m) => m.convQq) || {}).convQq || '',
    qq: slice.meta.qq || '',
    aka: slice.meta.aka || [],
    block: ctx.personBlock,
    totalMsgs: slice.meta.total || 0,
    lines: renderLines(slice.msgs, isAliasType
      ? { token: slice.meta.token || '' }
      : { mark: (m) => (slice.meta.qq ? m.qq === slice.meta.qq : m.sender === slice.meta.name) }),
  };
  if (type === 'person') s.lines = slice.msgs.map((m) => `[${fmtTs(m.ts)}] ${m.qq ? `${m.qq}(${m.sender})` : m.sender}: ${m.text}`).join('\n');
  return PROMPTS[type](s);
}

/* ============ provider ============ */
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

async function callModel(prov, prompt) {
  const body = {
    model: prov.model,
    messages: [{ role: 'system', content: SYS }, { role: 'user', content: prompt }],
    temperature: 0.3,
    max_tokens: 2000,
    thinking: { type: 'disabled' },
    response_format: { type: 'json_object' },
  };
  const t0 = Date.now();
  const res = await fetch(prov.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${prov.key}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(180000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  const j = JSON.parse(text);
  const content = j.choices?.[0]?.message?.content ?? '';
  if (!content) throw new Error('空 content');
  const clean = content.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const a = clean.indexOf('{');
  const b = clean.lastIndexOf('}');
  const parsed = JSON.parse(clean.slice(a, b + 1));
  return { parsed, usage: j.usage || {}, ms: Date.now() - t0 };
}

/* ============ 主流程 ============ */
const opt = parseArgs(process.argv.slice(2));
const outRoot = opt.out;
mkdirSync(outRoot, { recursive: true });
console.log('=== slice-chatlogs ===');
console.log('records:', opt.records);
console.log('types  :', opt.types.join(','), '| cap', opt.cap, '| llm', opt.llm);

const all = loadRecords(opt.records, ['鲸鲸']);
const ident = buildIdentity(all);
console.log(`有效消息 ${all.length}；昵称补全 ${ident.merged}；会话 ${new Set(all.map((r) => r.conv)).size}`);

// 选会话
const convNames = [...new Set(all.map((r) => r.conv))];
let targets = opt.convs.length
  ? convNames.filter((c) => opt.convs.some((q) => c.includes(q)))
  : convNames;
if (opt.limit) targets = targets.slice(0, opt.limit);
if (!targets.length) throw new Error('没有匹配到会话');
console.log('会话:', targets.join(' / '));

// 模板落盘，方便查看
const tplDir = join(outRoot, '_templates');
mkdirSync(tplDir, { recursive: true });
writeFileSync(join(tplDir, 'system.md'), `${SYS}\n`, 'utf8');
for (const [k, fn] of Object.entries(PROMPTS)) {
  writeFileSync(join(tplDir, `${k}.md`), `# ${k} 提示词模板\n\n（占位符由脚本填充：会话、条数、时间、记录正文、切片说明）\n\n\`\`\`\n${fn({ conv: '{{conv}}', convKind: 'group', gap: opt.gap, start: '{{start}}', end: '{{end}}', lines: '{{lines}}', msgs: [], token: '{{token}}', anchor: '{{anchor}}', by: '{{by}}', name: '{{name}}', qq: '{{qq}}', aka: [], block: opt.personBlock, totalMsgs: 0, totalSlices: 0 })}\n\`\`\`\n`, 'utf8');
}

const prov = opt.llm ? loadProvider(opt) : null;
if (opt.llm) console.log('model:', prov.model);

// 已知昵称（纯中文）+ 2~4 字前缀（用于外号/称呼锚点）
const knownNames = new Set();
const knownPrefixes = new Set();
for (const n of ident.nameIndex.keys()) {
  if (!/^[\u4e00-\u9fa5]{2,}$/.test(n)) continue;
  knownNames.add(n);
  for (let k = 2; k <= Math.min(4, n.length - 1); k += 1) knownPrefixes.add(n.slice(0, k));
}
for (const p of knownNames) knownPrefixes.delete(p);
console.log('称呼锚点：昵称', knownNames.size, '/ 前缀', knownPrefixes.size);
const knownNameList = [...knownNames].sort((a, b) => b.length - a.length);

// QQ → 昵称时间线（提示词里的「本段人物」对照表用）
const qqNames = new Map();
for (const [name, list] of ident.nameIndex) {
  for (const c of list) {
    if (!qqNames.has(c.qq)) qqNames.set(c.qq, []);
    qqNames.get(c.qq).push({ name, first: c.first });
  }
}
for (const [qq, arr] of qqNames) {
  qqNames.set(qq, arr.sort((a, b) => a.first.localeCompare(b.first)).map((x) => x.name));
}

// 归一化：任何昵称 → 该 QQ 最近用的名字（修「ネイト vs 萌新奈特」这类变体）
const lastByQq = new Map();
for (const r of all) {
  if (!r.qq) continue;
  const cur = lastByQq.get(r.qq);
  if (!cur || r.ts > cur.ts) lastByQq.set(r.qq, { ts: r.ts, name: r.sender });
}
const canonName = (n) => {
  if (typeof n !== 'string' || !n) return n;
  const qq = ident.resolve(n, '');
  return qq ? (lastByQq.get(qq)?.name || n) : n;
};
const latestName = new Map([...lastByQq.entries()].map(([qq, v]) => [qq, v.name]));
const stripAt = (s) => (typeof s === 'string' ? s.replace(/^@+/, '').trim() : s);
const canonParsed = (p) => {
  for (const x of p.participants || []) x.name = canonName(x.name);
  for (const x of p.relations || []) x.who = canonName(x.who);
  for (const x of p.interactions || []) { x.from = canonName(x.from); x.to = canonName(x.to); }
  for (const x of p.aliases || []) { x.alias = stripAt(x.alias); x.target = canonName(x.target); x.usedBy = canonName(x.usedBy); }
  for (const x of p.addresses || []) x.name = canonName(x.name);
  for (const x of p.mentions || []) x.who = canonName(x.who);
  for (const x of p.events || []) x.who = canonName(x.who);
  return p;
};

const manifest = { startedAt: new Date().toISOString(), records: opt.records, cap: opt.cap, convs: [] };
let totalCalls = 0;
let totalIn = 0;
let totalOut = 0;

for (const conv of targets) {
  const msgs = all.filter((r) => r.conv === conv);
  if (!msgs.length) continue;
  const convKind = msgs[0].convKind;
  const dir = join(outRoot, slug(conv));
  if (!opt.countOnly) for (const d of ['', '01-slices', '02-prompts', '03-llm']) mkdirSync(join(dir, d), { recursive: true });
  console.log(`\n--- ${conv}（${convKind}，${msgs.length} 条）`);

  // 00 原始记录 + 身份表
  if (!opt.countOnly) writeFileSync(join(dir, '00-records.jsonl'), msgs.map((m) => JSON.stringify(m)).join('\n') + '\n', 'utf8');
  const people = new Map();
  for (const m of msgs) {
    if (!m.qq) continue;
    const p = people.get(m.qq) || { qq: m.qq, names: new Map(), n: 0 };
    p.n += 1;
    const nm = p.names.get(m.sender) || { first: m.ts, last: m.ts, n: 0 };
    nm.n += 1;
    if (m.ts < nm.first) nm.first = m.ts;
    if (m.ts > nm.last) nm.last = m.ts;
    p.names.set(m.sender, nm);
    people.set(m.qq, p);
  }
  if (!opt.countOnly) writeFileSync(join(dir, '00-identity.json'), JSON.stringify([...people.values()].map((p) => ({
    qq: p.qq, n: p.n,
    names: [...p.names.entries()].sort((a, b) => a[1].first.localeCompare(b[1].first)).map(([n, v]) => ({ name: n, ...v })),
  })), null, 2), 'utf8');

  const convStat = { conv, kind: convKind, msgs: msgs.length, types: {} };

  for (const type of opt.types) {
    // 私聊不切 @
    if (type === 'at' && convKind === 'private') { convStat.types[type] = { skipped: 'private' }; continue; }
    const builder = type === 'time' ? sliceTime : type === 'person' ? slicePerson : type === 'at' ? sliceAt : sliceAlias;
    const built = builder(msgs, { ...opt, knownNames, knownPrefixes, knownNameList, resolve: ident.resolve });
    const total = built.total;
    const slices = built.slices;
    const capFor = opt.capByType[type] ?? opt.cap;
    const recent = opt.since ? slices.filter((s) => s.msgs[0].ts >= opt.since) : [];
    const older = opt.since ? slices.filter((s) => s.msgs[0].ts < opt.since) : slices;
    if (opt.countOnly) {
      console.log(`  ${type}: 全量 ${slices.length} 段，${opt.since ? `since ${opt.since.slice(0, 10)} 之后 ${recent.length} 段 / 之前 ${older.length} 段` : `命中 ${slices.length} 段`}`);
      convStat.types[type] = { total: slices.length, recent: recent.length, older: older.length };
      continue;
    }
    // 近段全读 + 旧段按类型 cap 抽样
    const take = opt.since
      ? [...sampleSlices(older, opt.olderCap ?? capFor), ...recent]
      : sampleSlices(slices, capFor);
    // 锚点清单（全量，便于检查切了哪些锚点）
    const anchorSummary = {};
    for (const s of slices) {
      const k = s.meta.token || s.meta.toName || s.meta.qq || '(无)';
      anchorSummary[k] = anchorSummary[k] || { slices: 0, kind: s.meta.anchorKind || type };
      anchorSummary[k].slices += 1;
    }
    writeFileSync(join(dir, '01-slices', `${type}.anchors.json`), `${JSON.stringify(anchorSummary, null, 2)}\n`, 'utf8');
    const outSlices = take.map((s, i) => ({
      sliceId: `${type}-${String(i + 1).padStart(3, '0')}`,
      type: type === 'person' ? 'person' : s.kind,
      conv, convKind,
      start: s.msgs[0].ts,
      end: s.msgs[s.msgs.length - 1].ts,
      meta: s.meta,
      truncated: slices.length > opt.cap,
      totalSlices: slices.length,
      msgs: s.msgs,
    }));
    // 人员切片的 meta 补名字/别名
    for (const s of outSlices) {
      if (s.type === 'person') {
        const p = people.get(s.meta.qq);
        s.meta.name = p ? [...p.names.keys()].pop() : s.meta.qq;
        s.meta.aka = p ? [...p.names.keys()] : [];
      }
    }
    writeFileSync(join(dir, '01-slices', `${type}.jsonl`), outSlices.map((s) => JSON.stringify(s)).join('\n') + '\n', 'utf8');
    for (const s of outSlices) {
      const md = join(dir, '02-prompts', type);
      mkdirSync(md, { recursive: true });
      const ptype = s.type === 'mention' ? 'mention' : type;
      writeFileSync(join(md, `${s.sliceId}.md`), buildPrompt(ptype, s, { gap: opt.gap, personBlock: opt.personBlock, qqNames, latestName }), 'utf8');
    }
    convStat.types[type] = { total: slices.length, anchors: total, sliced: outSlices.length, capped: take.length < slices.length, recent: recent.length, older: older.length };
    console.log(`  ${type}: 粗切 ${slices.length} 段，落盘 ${outSlices.length} 段（prompt 已写）`);
  }

  // LLM
  if (opt.llm) {
    for (const type of opt.types) {
      if (convStat.types[type]?.skipped) continue;
      const sliceFile = join(dir, '01-slices', `${type}.jsonl`);
      const slices = readFileSync(sliceFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
      const outFile = join(dir, '03-llm', `${type}.jsonl`);
      writeFileSync(outFile, '', 'utf8');
      let cursor = 0;
      const results = [];
      const worker = async () => {
        for (;;) {
          const i = cursor;
          cursor += 1;
          if (i >= slices.length) return;
          const s = slices[i];
          const prompt = buildPrompt(type === 'person' ? 'person' : (s.type === 'mention' ? 'mention' : type), s, { gap: opt.gap, personBlock: opt.personBlock, qqNames, latestName });
          try {
            let r = null;
            let lastErr = null;
            for (let attempt = 1; attempt <= 2 && !r; attempt += 1) {
              try {
                const p2 = attempt === 1 ? prompt : `${prompt}\n\n（上次输出不是合法 JSON，请只输出 JSON 对象，不要解释。）`;
                r = await callModel(prov, p2);
              } catch (e) {
                lastErr = e;
                if (attempt === 1) await new Promise((res) => setTimeout(res, 1200));
              }
            }
            if (!r) throw lastErr || new Error('unknown');
            totalCalls += 1;
            totalIn += r.usage.prompt_tokens || 0;
            totalOut += r.usage.completion_tokens || 0;
            const rec = { sliceId: s.sliceId, type: s.type, ok: true, parsed: canonParsed(r.parsed), usage: r.usage, ms: r.ms };
            results.push(rec);
            writeFileSync(outFile, results.map((x) => JSON.stringify(x)).join('\n') + '\n', 'utf8');
          } catch (e) {
            const rec = { sliceId: s.sliceId, type: s.type, ok: false, error: String(e.message).slice(0, 200) };
            results.push(rec);
            writeFileSync(outFile, results.map((x) => JSON.stringify(x)).join('\n') + '\n', 'utf8');
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(opt.concurrency, slices.length) }, () => worker()));
      const ok = results.filter((x) => x.ok).length;
      console.log(`  ${type}: LLM ${ok}/${results.length} ok`);
      convStat.types[type].llm = { ok, fail: results.length - ok };
    }
  }

  if (!opt.countOnly) writeFileSync(join(dir, '99-manifest.json'), JSON.stringify(convStat, null, 2), 'utf8');
  manifest.convs.push(convStat);
}

manifest.calls = totalCalls;
manifest.tokens = { in: totalIn, out: totalOut };
manifest.finishedAt = new Date().toISOString();
writeFileSync(join(outRoot, '_manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
console.log(`\n=== 完成：${manifest.convs.length} 个会话，LLM ${totalCalls} 次，tokens ${totalIn}/${totalOut} ===`);
console.log(`产物目录：${outRoot}`);
