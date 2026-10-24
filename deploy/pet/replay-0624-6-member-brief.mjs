/**
 * 重放 6/6（0.6.24 基线）：群友档案注入（qq.memberBrief prompt 变量）+ ENV_PROMPT 模板行
 *
 * 对应 deploy/pet/patch-member-brief.mjs。官方 0.6.9 里三个锚点都还在（qq.unread 声明 / 取值 / unreadSummary），
 * 逻辑照搬，只补一句：Core 是 `await mod.envPromptVars()` 一次性求值整个 vars 对象，
 * 所以变量会被真的读一遍（日志「群友档案注入：N 人」可据此判断数据管道通没通）。
 *
 * 注意：ENV_PROMPT.md 模板里目前**没有** {{qq.memberBrief}}（官方 0.6.9 的模板 + 仓库里的版本都没有），
 * 也就是说值会被算出来但不会出现在提示词里。要真生效得往模板加一行——本次不动模板，只在报告里说明。
 *
 * 用法: node deploy/pet/replay-0624-6-member-brief.mjs <qq世界包目录>
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const pkg = process.argv[2];
if (!pkg) { console.error('用法: node replay-069-6-member-brief.mjs <qq世界包目录>'); process.exit(2); }

const file = join(pkg, 'src/world.ts');
const raw = readFileSync(file, 'utf8');
const crlf = raw.includes('\r\n');
let s = raw.replace(/\r\n/g, '\n');
if (s.includes('qq.memberBrief')) { console.log('已打过 memberBrief，跳过'); process.exit(0); }

/* 1) 声明 prompt 变量 */
const declAnchor = `            { name: 'qq.unread', description: '未读摘要。' },`;
if (!s.includes(declAnchor)) throw new Error('qq.unread 声明锚点缺失');
s = s.replace(declAnchor, `${declAnchor}
            { name: 'qq.memberBrief', description: '群友档案速查：发言量靠前的人及其口头禅，供参考、不必刻意提起。', multiline: true },`);

/* 2) 提供取值 */
const valAnchor = `      'qq.unread': this.unreadSummary(),`;
if (!s.includes(valAnchor)) throw new Error('qq.unread 取值锚点缺失');
s = s.replace(valAnchor, `${valAnchor}
      'qq.memberBrief': this.memberBrief(),`);

/* 3) 方法（读 /data/home/companion/data/members/index.json + 每人档案，拼成 ≤800 字） */
const methodAnchor = '  private unreadSummary(';
if (!s.includes(methodAnchor)) throw new Error('unreadSummary 方法锚点缺失');
s = s.replace(methodAnchor, `  /** 群友档案速查：读 /data/home/companion/data/members/index.json + 每人档案，拼成 ≤800 字。 */
  private memberBriefCache: { key: string; text: string } | null = null;
  private memberBriefLogged = false;
  private memberBrief(): string {
    try {
      const dir = '/data/home/companion/data/members';
      const idx = JSON.parse(readFileSync(\`\${dir}/index.json\`, 'utf8')) as Array<{ qq?: string; name: string; msgs: number }>;
      if (!Array.isArray(idx) || !idx.length) return '';
      const key = \`\${idx.length}:\${idx[0]?.msgs ?? 0}\`;
      if (this.memberBriefCache && this.memberBriefCache.key === key) return this.memberBriefCache.text;

      const lines = idx.slice(0, 8).map((m) => {
        try {
          const p = JSON.parse(readFileSync(\`\${dir}/\${String(m.qq ?? m.name).replace(/[\\\\/:*?"<>|\\s]/g, '_')}.json\`, 'utf8')) as { phrases?: Array<{ g: string }> };
          const ph = (p.phrases ?? []).slice(0, 4).map((x) => x.g).join('/');
          return \`- \${m.name}（\${m.qq ?? '?'}）：\${m.msgs} 条\${ph ? \`，常挂嘴边「\${ph}」\` : ''}\`;
        } catch {
          return \`- \${m.name}（\${m.qq ?? '?'}）：\${m.msgs} 条\`;
        }
      });
      const text = \`群友档案（按发言量排序，只作参考，不必刻意提起）：\\n\${lines.join('\\n')}\`.slice(0, 800);
      this.memberBriefCache = { key, text };
      if (!this.memberBriefLogged) {
        this.memberBriefLogged = true;
        this.log.info(\`群友档案注入：\${idx.length} 人，\${text.length} 字\`);
      }
      return text;
    } catch {
      return '';
    }
  }

${methodAnchor}`);

writeFileSync(file, crlf ? s.replace(/\n/g, '\r\n') : s, 'utf8');
console.log('world.ts：memberBrief 已加入（prompt 变量 + 取值 + 方法）');
