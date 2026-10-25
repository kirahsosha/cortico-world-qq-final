#!/usr/bin/env node
/**
 * 把切片分析结果（03-llm/*.jsonl）聚合成 cortico-memory-export，供 mem_transfer(import) 冷启动。
 *
 * 只做「聚合」，不调模型：
 *   - facts：跨切片去重、按「重复次数 + 长期性关键词」排序，每个会话留 N 条
 *   - knowledge：每个会话按话题聚成条目（topic → facts）
 *   - profiles：按 QQ 汇总 persona / 口头禅 / 立场 / 习惯
 *   - aliases：外号单独进 knowledge（「群内称呼」）
 *
 * 产物（已按 memory 世界 memory@0.3.1 的存储结构对齐，不是文档里的抽象 schema）：
 *   facts.scopes[scope] = [{hash,text,confidence,createdAt,updatedAt}]
 *   knowledge.entries   = [{id,topic,keywords,facts,sources,learnedAt,updated,hits}]
 *   profiles[qq]        = {facts[], updated}
 *
 * 用法：
 *   node aggregate-slice-memory.mjs --slices tmp/todo5/slices-v2-final/slices-v2-out \
 *     --convs 为什么一不小心改了群名捏,学弟压榨群,倒爷请给我机会 --out tmp/todo5/memory-export [--max-facts 30]
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

function parseArgs(argv) {
  const o = {
    slices: '', convs: [], out: '', maxFacts: 30, maxKnowledge: 24, maxProfileFacts: 40, identity: '', withRank: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--slices') o.slices = next();
    else if (a === '--convs') o.convs = String(next() || '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--out') o.out = next();
    else if (a === '--max-facts') o.maxFacts = Math.max(1, Number(next()) || 30);
    else if (a === '--max-knowledge') o.maxKnowledge = Math.max(1, Number(next()) || 24);
    else if (a === '--max-profile-facts') o.maxProfileFacts = Math.max(1, Number(next()) || 40);
    else if (a === '--identity') o.identity = String(next() || '');
    else if (a === '--with-rank') o.withRank = true;
    else throw new Error(`未知参数 ${a}`);
  }
  if (!o.slices || !o.out) throw new Error('需要 --slices 和 --out');
  return o;
}

const norm = (s) => String(s || '').replace(/\s+/g, '').replace(/[。！？!?.，,、；;：:“”"']/g, '').toLowerCase();
const DURABLE = ['约', '约定', '固定', '总是', '每天', '每周末', '习惯', '喜欢', '爱吃', '不吃', '讨厌', '生日',
  '住在', '老家', '上班', '工作', '公司', '学校', '专业', '养', '叫', '外号', '称呼', '规则', '必须', '不要',
  '不能', '过敏', '忌口', '老婆', '老公', '女朋友', '男朋友', '孩子', '爸', '妈'];
const EPHEMERAL = ['今天', '刚刚', '刚才', '现在', '这次', '目前', '今晚', '明天', '昨天', '等会', '一会儿', '马上'];
// 隐私：不进记忆（宁可丢，不可存）
const PII = [
  /验证码|动态码|密码|身份证|银行卡|卡号|护照|社保/,
  /\b1[3-9]\d{9}\b/,
  /\d{6}\s*(?:是|为)?\s*(?:验证码|动态码)/,
  /(?:省|市|区|县).{0,12}(?:路|街|道|弄).{0,12}(?:号|室|楼)/,
  /[\w.+-]+@[\w-]+\.[\w.]+/,
  /\b\d{17}[\dXx]\b/,
];
const isPrivate = (text) => PII.some((re) => re.test(String(text)));

function scoreFact(text, count) {
  const t = String(text);
  const durable = DURABLE.filter((k) => t.includes(k)).length;
  const ephemeral = EPHEMERAL.filter((k) => t.startsWith(k) || t.includes('今天')).length;
  let score = count * 2 + durable * 3 + Math.min(t.length, 40) / 20;
  if (ephemeral && count === 1) score -= 4;
  return { score, durable, ephemeral };
}

const shorthash = (scope, text) => createHash('sha256').update(`${scope}:${text}`).digest('hex');

const opt = parseArgs(process.argv.slice(2));
const nowSec = Math.round(Date.now() / 1000);
const nowStr = new Date().toISOString().slice(0, 19).replace('T', ' ');

const convs = opt.convs.length ? opt.convs : readdirSync(opt.slices).filter((d) => statSync(join(opt.slices, d)).isDirectory() && d !== '_templates');
const report = [];
const factScopes = {};
const knowledge = [];
const profiles = {};
const stats = { convs: [], factsBefore: 0, factsAfter: 0, knowledge: 0, profiles: 0, piiDropped: 0, idReplaced: 0, datedDropped: 0 };

/** 把事实里的 QQ 号换成「昵称」，读起来像人话；只替换本会话身份表里确实存在的号 */
function makeBeautifier(identityFile) {
  const map = new Map();
  try {
    const list = JSON.parse(readFileSync(identityFile, 'utf8'));
    for (const p of list) {
      const names = (p.names || []).map((n) => n.name);
      const name = names.length ? names[names.length - 1] : '';
      if (name) map.set(String(p.qq), name);
    }
  } catch { /* 没有身份表就不替换 */ }
  return (text) => {
    let out = String(text);
    for (const [qq, name] of map) {
      if (qq.length < 5 || !out.includes(qq)) continue;
      out = out.split(qq).join(name);
      stats.idReplaced += 1;
    }
    return out;
  };
}

for (const conv of convs) {
  const dir = join(opt.slices, conv);
  if (!existsSync(join(dir, '03-llm'))) { console.log('跳过（无 03-llm）', conv); continue; }
  const convKind = JSON.parse(readFileSync(join(dir, '99-manifest.json'), 'utf8')).kind;
  const beautify = makeBeautifier(join(dir, '00-identity.json'));

  // sliceId → meta（person 切片的 qq、时间切片的 start）
  const sliceMeta = new Map();
  for (const f of readdirSync(join(dir, '01-slices'))) {
    if (!f.endsWith('.jsonl')) continue;
    for (const l of readFileSync(join(dir, '01-slices', f), 'utf8').split('\n').filter(Boolean)) {
      const s = JSON.parse(l);
      sliceMeta.set(s.sliceId, { type: s.type, start: s.start, meta: s.meta || {} });
    }
  }

  // 收集 facts / topics / person 信息
  const factMap = new Map(); // norm -> {text, count, dates:Set, types:Set, people:Set, topics:Set}
  const topicCount = new Map();
  const personFacts = new Map(); // qq -> Set
  let before = 0;

  for (const f of readdirSync(join(dir, '03-llm'))) {
    const type = f.replace(/\.jsonl$/, '');
    for (const l of readFileSync(join(dir, '03-llm', f), 'utf8').split('\n').filter(Boolean)) {
      const o = JSON.parse(l);
      if (!o.ok) continue;
      const p = o.parsed || {};
      const meta = sliceMeta.get(o.sliceId) || {};
      const date = String(meta.start || '').slice(0, 10);
      // 这段切片里有哪些人、在聊什么（用于给「约定/事件」类事实补主语）
      const people = [...new Set((p.participants || []).map((x) => beautify(String(x.name || ''))).filter(Boolean))].slice(0, 4);
      const sliceTopic = typeof p.topic === 'string' ? p.topic.slice(0, 20) : '';
      for (const x of p.facts || []) {
        if (typeof x !== 'string' || x.trim().length < 4) continue;
        before += 1;
        if (isPrivate(x)) { stats.piiDropped = (stats.piiDropped || 0) + 1; continue; }
        const text = beautify(x);
        const k = norm(text);
        const cur = factMap.get(k) || { text: text.trim(), count: 0, dates: new Set(), types: new Set(), people: new Set(), topics: new Set() };
        cur.count += 1;
        if (date) cur.dates.add(date);
        cur.types.add(type);
        for (const n of people) cur.people.add(n);
        if (sliceTopic) cur.topics.add(sliceTopic);
        factMap.set(k, cur);
      }
      for (const t of p.topics || []) if (typeof t === 'string' && t.trim()) topicCount.set(t.trim(), (topicCount.get(t.trim()) || 0) + 1);
      if (type === 'person') {
        const qq = meta.meta?.qq;
        if (qq) {
          const set = personFacts.get(qq) || new Set();
          if (p.persona) set.add(`画像：${p.persona}`);
          for (const c of p.catchphrases || []) set.add(`口头禅：${c}`);
          for (const s of p.stance || []) set.add(`观点：${s}`);
          for (const h of p.habits || []) set.add(`习惯：${h}`);
          personFacts.set(qq, set);
        }
      }
    }
  }

  // 评分 + 过滤 + 去重（包含关系：留长的，计数相加）
  const scored = [...factMap.values()]
    .map((v) => {
      const { score, durable, ephemeral } = scoreFact(v.text, v.count);
      return { ...v, score, durable, ephemeral };
    })
    .filter((v) => !(v.ephemeral && v.count === 1 && v.text.length < 26))
    // 「2026-07-04 夜 某人…」这种一次性事件，只有出现过一次、又没有长期性关键词，就不进记忆
    .filter((v) => {
      const dated = /^\d{4}-\d{2}-\d{2}/.test(v.text);
      const sticky = /约定|生日|固定|每天|每周|总是|习惯/.test(v.text);
      if (dated && v.count === 1 && !sticky) { stats.datedDropped += 1; return false; }
      return true;
    })
    .sort((a, b) => b.score - a.score);
  const kept = [];
  for (const v of scored) {
    if (kept.some((k) => norm(k.text).includes(norm(v.text)) || norm(v.text).includes(norm(k.text)))) continue;
    kept.push(v);
    if (kept.length >= opt.maxFacts) break;
  }

  const scope = `chat:${conv}`;
  // 「约定/事件」类事实补上在场人和话题，否则只记了「几点开战」不知道跟谁
  const EVENT = /约定|约了|约好|生日|聚会|聚餐|开战|几点|点见|碰头|见面|^\d{4}-\d{2}-\d{2}/;
  const enrich = (v) => {
    if (!EVENT.test(v.text)) return v.text;
    const people = [...v.people].filter((n) => n && !v.text.includes(n)).slice(0, 3);
    const topic = [...v.topics][0] || '';
    const extra = [];
    if (people.length) extra.push(`在场：${people.join('、')}`);
    if (topic && !v.text.includes(topic)) extra.push(`话题：${topic}`);
    if (!extra.length) return v.text;
    stats.enriched = (stats.enriched || 0) + 1;
    return `${v.text}（${extra.join('；')}）`;
  };
  factScopes[scope] = kept.map((v) => {
    const text = enrich(v);
    return {
      hash: shorthash(scope, text),
      text,
      confidence: Math.min(1, 0.6 + Math.min(0.35, (v.count - 1) * 0.1 + v.durable * 0.05)),
      createdAt: nowSec,
      updatedAt: nowSec,
    };
  });
  stats.factsBefore += before;
  stats.factsAfter += kept.length;

  // knowledge：每个会话按高频话题聚一条（过滤「游戏/吃饭」这类过泛话题）
  const GENERIC = new Set(['游戏', '吃饭', '吃喝', '聊天', '日常', '生活', '群聊', '闲聊', '发图', '表情包', '视频', '音乐', '抽卡']);
  const topics = [...topicCount.entries()]
    .filter(([t]) => t.length >= 2 && !GENERIC.has(t))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4);
  for (const [topic, cnt] of topics) {
    if (knowledge.length >= opt.maxKnowledge) break;
    // 话题关联用「过滤前的全部 fact」，否则 30 条 kept 里很少正好提到某个话题
    const related = scored.filter((v) => v.text.includes(topic)).slice(0, 5).map((v) => enrich(v));
    if (related.length < 2) continue;
    if (!related.length) continue;
    knowledge.push({
      id: Math.random().toString(36).slice(2, 10),
      topic: `${conv} · ${topic}`,
      keywords: [topic],
      facts: related,
      sources: [scope],
      learnedAt: nowStr.slice(0, 10),
      updated: nowStr,
      hits: cnt,
    });
  }

  // profiles：按 QQ 汇总
  for (const [qq, set] of personFacts) {
    const list = [...set].slice(0, opt.maxProfileFacts);
    if (!list.length) continue;
    profiles[qq] = { facts: list, updated: nowSec };
    stats.profiles += 1;
  }

  report.push({ conv, kind: convKind, factsBefore: before, factsAfter: kept.length, top: kept.slice(0, 5).map((v) => `[${v.count}次] ${v.text}`) });
  console.log(`${conv}: facts ${before} → ${kept.length}，话题 ${topics.length}，人物 ${personFacts.size}`);
}

/* ---- 身份对照（可选）：把 QQ/邮箱 ↔ 昵称/曾用名 灌进记忆，解决「档案只按号建、正文没名字」 ---- */
if (opt.identity && existsSync(opt.identity)) {
  const im = JSON.parse(readFileSync(opt.identity, 'utf8'));
  const people = im.people || [];
  const idFacts = [];
  const byId = new Map();
  for (const p of people) {
    byId.set(p.id, p);
    const aka = (p.names || []).filter((n) => n.name && n.name !== p.latest)
      .map((n) => `${n.name}(${n.first}~${n.last})`);
    const akaCount = p.akaCount ?? Math.max(0, (p.names || []).length - 1);
    // 默认不写「N 个」这种计数：改名次数是派生快照、会随新数据变化，不该当永久事实（v4 已因此被否）
    const text = opt.withRank
      ? `昵称对照：${p.latest}（${p.id}）；曾用名 ${akaCount} 个${aka.length ? `，如 ${aka.slice(0, 6).join('、')}${aka.length > 6 ? ' 等' : ''}` : ''}；${(p.convs || []).length} 个会话、${p.msgs} 条`
      : `昵称对照：${p.latest}（${p.id}）${aka.length ? `；曾用名 ${aka.slice(0, 8).join('、')}${aka.length > 8 ? ' 等' : ''}` : ''}；${(p.convs || []).length} 个会话、${p.msgs} 条`;
    idFacts.push({
      hash: shorthash('identity', text),
      text,
      confidence: 0.95,
      createdAt: nowSec,
      updatedAt: nowSec,
    });
  }
  factScopes.identity = idFacts;

  // 每个会话一条「群友名单」知识，按发言量取前 20
  const convPeople = new Map();
  for (const p of people) {
    for (const c of p.convs || []) {
      const arr = convPeople.get(c) || [];
      arr.push(p);
      convPeople.set(c, arr);
    }
  }
  for (const [c, arr] of convPeople) {
    if (knowledge.length >= opt.maxKnowledge + 20) break;
    const top = arr.sort((a, b) => b.msgs - a.msgs).slice(0, 20);
    knowledge.push({
      id: Math.random().toString(36).slice(2, 10),
      topic: `${c} · 群友名单`,
      keywords: ['名单', 'QQ', '昵称'],
      facts: top.map((p) => `${p.latest} = ${p.id}`),
      sources: [`chat:${c}`],
      learnedAt: nowStr.slice(0, 10),
      updated: nowStr,
      hits: top.length,
    });
    stats.identityRosters = (stats.identityRosters || 0) + 1;
  }

  // 改名排行：预计算好，避免模型去翻 51 KB 对照表现数
  // 改名排行：默认不生成（派生快照，随时会变；要的话 --with-rank，或看 partner/rename-rank.md）
  const topRenames = opt.withRank
    ? [...people].sort((a, b) => (b.akaCount ?? 0) - (a.akaCount ?? 0)).slice(0, 10)
    : [];
  if (topRenames.length) {
    knowledge.push({
      id: Math.random().toString(36).slice(2, 10),
      topic: '群友改名排行',
      keywords: ['改名', '群名片', '昵称', '曾用名'],
      facts: topRenames.map((p, i) => `${i + 1}. ${p.latest}（${p.id}）：曾用名 ${p.akaCount ?? 0} 个`),
      sources: ['identity'],
      learnedAt: nowStr.slice(0, 10),
      updated: nowStr,
      hits: 1,
    });
  }

  // 档案里补昵称（反查「这个号是谁」）
  let stamped = 0;
  for (const [qq, prof] of Object.entries(profiles)) {
    const p = byId.get(qq);
    if (!p) continue;
    const aka = (p.names || []).filter((n) => n.name && n.name !== p.latest).map((n) => n.name).slice(0, 5);
    prof.facts.unshift(`昵称：${p.latest}${aka.length ? `（曾用名：${aka.join('、')}）` : ''}`);
    stamped += 1;
  }
  stats.profileStamped = stamped;
  stats.identityFacts = idFacts.length;
  console.log(`身份对照：${idFacts.length} 条事实 + ${stats.identityRosters} 个群名单，档案补昵称 ${stamped} 人`);
}

const bundle = {
  format: 'cortico-memory-export',
  specVersion: 1,
  plugin: 'cortico-world-import',
  exportedAt: new Date().toISOString(),
  scope: 'ALL',
  backend: 'json',
  memory: { store: {}, summary: {}, topic: {}, notes: {} },
  facts: { scopes: factScopes },
  vectors: { model: null, vectors: {} },
  knowledge: { entries: knowledge },
  reflection: { reflections: [], rules: [], stats: {} },
  persona: { personas: {}, globalStyle: '' },
  profiles,
};

mkdirSync(opt.out, { recursive: true });
const file = join(opt.out, `memory-export-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
writeFileSync(file, `${JSON.stringify(bundle, null, 2)}\n`, 'utf8');
stats.knowledge = knowledge.length;
stats.profiles = Object.keys(profiles).length;
stats.scopes = Object.keys(factScopes).length;
stats.file = file;

// 结构自检：hash 必须等于 sha256(scope:text)；字段类型要能被 memory 世界直接读
const problems = [];
for (const [scope, list] of Object.entries(factScopes)) {
  for (const f of list) {
    if (!f.hash || !f.text || typeof f.confidence !== 'number' || typeof f.createdAt !== 'number') problems.push(`fact 字段缺失 ${scope}`);
    else if (f.hash !== shorthash(scope, f.text)) problems.push(`fact hash 不匹配 ${scope}`);
  }
}
for (const e of knowledge) {
  if (!e.id || !e.topic || !Array.isArray(e.facts) || !Array.isArray(e.keywords) || !Array.isArray(e.sources)) problems.push(`knowledge 字段缺失 ${e.topic}`);
  for (const k of ['learnedAt', 'updated']) if (typeof e[k] !== 'string') problems.push(`knowledge.${k} 类型错 ${e.topic}`);
}
for (const [qq, p] of Object.entries(profiles)) {
  if (!Array.isArray(p.facts) || typeof p.updated !== 'number') problems.push(`profile 字段缺失 ${qq}`);
}
stats.validation = problems.length ? { ok: false, problems: problems.slice(0, 5) } : { ok: true };
writeFileSync(join(opt.out, 'report.json'), `${JSON.stringify({ stats, report }, null, 2)}\n`, 'utf8');
if (problems.length) console.log(`结构自检失败：${problems.slice(0, 3).join('; ')}`);
else console.log('结构自检：通过');

console.log(`\nfacts: ${stats.factsBefore} → ${stats.factsAfter}（${stats.scopes} 个 scope）`);
console.log(`knowledge: ${stats.knowledge} 条；profiles: ${stats.profiles} 人`);
console.log(`-> ${file}`);
