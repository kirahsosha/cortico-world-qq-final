// 从 31 个会话的 00-identity.json 汇总全局「QQ/邮箱 ↔ 昵称/曾用名」对照表
import { readFileSync, readdirSync, existsSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.argv[2] || 'tmp/todo5/slices-v2-final/slices-v2-out';
const outDir = process.argv[3] || 'tmp/todo5/identity';
const people = new Map(); // id -> { names: Map(name -> {first,last,n}), convs: Set, msgs }
const convNames = [];

for (const d of readdirSync(root)) {
  const dir = join(root, d);
  if (!statSync(dir).isDirectory() || d === '_templates') continue;
  const mf = join(dir, '99-manifest.json');
  const idf = join(dir, '00-identity.json');
  if (!existsSync(mf) || !existsSync(idf)) continue;
  const man = JSON.parse(readFileSync(mf, 'utf8'));
  convNames.push({ conv: man.conv, kind: man.kind, msgs: man.msgs });
  const list = JSON.parse(readFileSync(idf, 'utf8'));
  for (const p of list) {
    const id = String(p.qq);
    const cur = people.get(id) || { id, names: new Map(), convs: new Set(), msgs: 0 };
    cur.convs.add(man.conv);
    cur.msgs += p.n || 0;
    for (const nm of p.names || []) {
      const e = cur.names.get(nm.name) || { first: nm.first, last: nm.last, n: 0 };
      e.n += nm.n || 0;
      if (nm.first < e.first) e.first = nm.first;
      if (nm.last > e.last) e.last = nm.last;
      cur.names.set(nm.name, e);
    }
    people.set(id, cur);
  }
}

const rows = [...people.values()].map((p) => {
  const names = [...p.names.entries()].sort((a, b) => a[1].first.localeCompare(b[1].first));
  return {
    id: p.id,
    latest: names.length ? names[names.length - 1][0] : '',
    // 改名次数：names 里包含当前昵称，曾用名 = 其余
    nameCount: names.length,
    akaCount: Math.max(0, names.length - 1),
    names: names.map(([name, v]) => ({ name, first: v.first.slice(0, 10), last: v.last.slice(0, 10), n: v.n })),
    convs: [...p.convs],
    msgs: p.msgs,
  };
}).sort((a, b) => b.msgs - a.msgs);

import { mkdirSync } from 'node:fs';
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'identity-map.json'), JSON.stringify({ generatedAt: new Date().toISOString(), convs: convNames, people: rows }, null, 2) + '\n', 'utf8');

// 人读版：按「最近昵称」列，带曾用名和出现过的会话
const lines = ['# QQ 对照表（自动生成）', '', `共 ${rows.length} 个 ID，来自 ${convNames.length} 个会话。列：最近昵称 | ID | 曾用名(时间) | 出现会话 | 消息数`, ''];
for (const r of rows) {
  const aka = r.names.filter((n) => n.name !== r.latest).map((n) => `${n.name}(${n.first}~${n.last})`).join('、');
  lines.push(`- ${r.latest}（${r.id}）｜曾用名 ${r.akaCount} 个${aka ? `：${aka}` : ''}｜${r.convs.slice(0, 3).join('、')}${r.convs.length > 3 ? ` 等${r.convs.length}个` : ''}｜${r.msgs} 条`);
}
writeFileSync(join(outDir, 'qq-map.md'), lines.join('\n') + '\n', 'utf8');

// 统计
const multi = rows.filter((r) => r.names.length > 1).length;
const emails = rows.filter((r) => r.id.includes('@')).length;
console.log(`ID 总数 ${rows.length}（邮箱 ${emails}），有曾用名的 ${multi}`);
console.log(`会话 ${convNames.length}`);
console.log('Top 10:', rows.slice(0, 10).map((r) => `${r.latest}(${r.id},${r.msgs})`).join(' '));
console.log(`-> ${outDir}/identity-map.json / qq-map.md`);
