// 生成「改名排行」快照文件（给 bot 读，不进记忆）
import { readFileSync, writeFileSync } from 'node:fs';

const m = JSON.parse(readFileSync('tmp/todo5/identity/identity-map.json', 'utf8'));
const top = [...m.people].sort((a, b) => b.akaCount - a.akaCount).slice(0, 20);
const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
const lines = [
  '# 群友改名排行（快照）',
  '',
  `生成时间：${now}　数据范围：${m.convs.length} 个会话、${m.people.length} 个 ID`,
  '> 这是**阶段性快照**：随着新聊天记录导入会变化。要最新的就重新生成，不要当成永久事实记。',
  '',
  '| # | 当前昵称 | QQ/邮箱 | 曾用名数 | 会话数 | 消息数 |',
  '|---|---|---|---|---|---|',
];
top.forEach((p, i) => {
  lines.push(`| ${i + 1} | ${p.latest} | ${p.id} | ${p.akaCount} | ${p.convs.length} | ${p.msgs} |`);
});
lines.push('');
lines.push('## 说明');
lines.push('- 「曾用名数」= 身份表里出现过的不同昵称个数 − 1（当前昵称）');
lines.push('- 带【】前缀的管理员昵称会单独计数（同一个人的【管理员】X 与 X 算两条）');
writeFileSync('tmp/todo5/identity/rename-rank.md', lines.join('\n') + '\n', 'utf8');
console.log('写好', top.length, '条 ->', 'tmp/todo5/identity/rename-rank.md');
