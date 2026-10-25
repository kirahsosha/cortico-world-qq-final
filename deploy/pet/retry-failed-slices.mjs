#!/usr/bin/env node
/**
 * 只重试 03-llm/*.jsonl 里 ok=false 的切片：
 * 直接用已落盘的 02-prompts/<type>/<sliceId>.md 重新调模型，成功就原地替换那一行。
 *
 * 用法：node retry-failed-slices.mjs --out <切片产物目录> [--provider ...] [--concurrency 4]
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

function parseArgs(argv) {
  const o = { out: '', provider: '/data/home/providers/deepseek', model: '', concurrency: 4 };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--out') o.out = next();
    else if (a === '--provider') o.provider = next();
    else if (a === '--model') o.model = next();
    else if (a === '--concurrency') o.concurrency = Math.max(1, Number(next()) || 4);
    else throw new Error(`未知参数 ${a}`);
  }
  if (!o.out) throw new Error('缺少 --out');
  return o;
}

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
  if (!key) throw new Error('找不到密钥');
  return { key, url: `${(cfg.baseUrl || 'https://api.deepseek.com').replace(/\/+$/, '')}/v1/chat/completions`, model: o.model || cfg.spec?.model || 'deepseek-flash' };
}

const SYS = '你是 QQ 聊天记录分析员。只依据材料分析，不补充材料外的信息。输出严格 JSON。';

/** 宽松解析：先整体，再取第一个配对完整的 {...}（跳过字符串里的括号） */
function parseLoose(text) {
  const t = String(text || '').trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try { return JSON.parse(t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1)); } catch { /* 继续 */ }
  const start = t.indexOf('{');
  if (start < 0) throw new Error('没有 JSON');
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < t.length; i += 1) {
    const c = t[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) {
        const cand = t.slice(start, i + 1).replace(/,\s*([}\]])/g, '$1');
        return JSON.parse(cand);
      }
    }
  }
  throw new Error('JSON 不完整');
}

async function call(prov, prompt) {
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
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 160)}`);
  const j = JSON.parse(text);
  const content = j.choices?.[0]?.message?.content ?? '';
  if (!content) throw new Error('空 content');
  return { parsed: parseLoose(content), usage: j.usage || {}, ms: Date.now() - t0 };
}

const opt = parseArgs(process.argv.slice(2));
const prov = loadProvider(opt);
console.log('model', prov.model, '| out', opt.out);

const jobs = [];
for (const d of readdirSync(opt.out)) {
  const dir = join(opt.out, d);
  if (!statSync(dir).isDirectory()) continue;
  const llmDir = join(dir, '03-llm');
  if (!existsSync(llmDir)) continue;
  for (const f of readdirSync(llmDir)) {
    const file = join(llmDir, f);
    const type = f.replace(/\.jsonl$/, '');
    const rows = readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    rows.forEach((r, idx) => {
      if (r.ok) return;
      const promptFile = join(dir, '02-prompts', type, `${r.sliceId}.md`);
      if (!existsSync(promptFile)) { console.log('缺提示词，跳过', d, r.sliceId); return; }
      jobs.push({ conv: d, file, idx, rows, sliceId: r.sliceId, prompt: readFileSync(promptFile, 'utf8') });
    });
  }
}
console.log('待重试', jobs.length, '个');
let ok = 0;
let fail = 0;
let cursor = 0;
const worker = async () => {
  for (;;) {
    const i = cursor;
    cursor += 1;
    if (i >= jobs.length) return;
    const job = jobs[i];
    let done = false;
    for (let attempt = 1; attempt <= 3 && !done; attempt += 1) {
      try {
        const p = attempt === 1 ? job.prompt : `${job.prompt}\n\n（上次输出不是合法 JSON，请只输出一个 JSON 对象。）`;
        const r = await call(prov, p);
        job.rows[job.idx] = { sliceId: job.sliceId, type: job.rows[job.idx].type, ok: true, parsed: r.parsed, usage: r.usage, ms: r.ms, retried: attempt };
        done = true;
        ok += 1;
        console.log(`ok ${job.conv} ${job.sliceId} (第 ${attempt} 次)`);
      } catch (e) {
        if (attempt === 3) { fail += 1; console.log(`fail ${job.conv} ${job.sliceId}: ${String(e.message).slice(0, 100)}`); }
        else await new Promise((res) => setTimeout(res, 1500));
      }
    }
    writeFileSync(job.file, job.rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  }
};
await Promise.all(Array.from({ length: Math.min(opt.concurrency, jobs.length) }, () => worker()));
console.log(`完成：成功 ${ok}，失败 ${fail}`);
process.exitCode = fail ? 1 : 0;
