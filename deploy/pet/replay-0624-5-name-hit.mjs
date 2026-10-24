/**
 * 重放 5/6（0.6.24 基线）：群里点名（含「鲸鲸」）视同被 @
 *
 * 对应 deploy/pet/patch-name-hit.mjs。官方 0.6.9 里 `const atMe = segs.some(...)` 这行原样存在，
 * 锚点可用；差别只在点名词来源：这里读 groupSpeak.botAliases（第 2 步加的 7 项之一，字符串），
 * 外加 config.botAliases（数组，老写法）与账号昵称，并兜底「鲸鲸」。
 *
 * 顺带把第 2 步推送判定里占位的 nameHit=false 换成真实值——否则点名能进模型、却仍被采样率拦掉。
 *
 * 用法: node deploy/pet/replay-0624-5-name-hit.mjs <qq世界包目录>
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const pkg = process.argv[2];
if (!pkg) { console.error('用法: node replay-069-5-name-hit.mjs <qq世界包目录>'); process.exit(2); }

const file = join(pkg, 'src/world.ts');
const raw = readFileSync(file, 'utf8');
const crlf = raw.includes('\r\n');
let s = raw.replace(/\r\n/g, '\n');
if (s.includes('atMeDirect')) { console.log('已打过 nameHit，跳过'); process.exit(0); }

/* 1) atMe 判定：@ 或 正文点名 */
const from = `    const atMe = segs.some((s) => s.type === 'at' && Number((s as { data: { qq: string } }).data.qq) === selfId);`;
if (!s.includes(from)) { console.error('atMe 锚点缺失'); process.exit(3); }

const to = `    const atMeDirect = segs.some((s) => s.type === 'at' && Number((s as { data: { qq: string } }).data.qq) === selfId);

    // 没有 @、但正文里点了名（昵称/点名词），按 @ 处理：照样推给模型，由模型判断是不是在问它。
    const plainText = segs
      .filter((seg) => seg.type === 'text')
      .map((seg) => String((seg as { data?: { text?: string } }).data?.text ?? ''))
      .join('');
    const aliases: string[] = [];
    const pushAlias = (v: unknown): void => {
      const t = typeof v === 'string' ? v.trim() : '';
      if (t.length >= 2 && !aliases.includes(t)) aliases.push(t);
    };
    pushAlias(this.identity?.nickname);
    const aliasArr = (this.config as unknown as { botAliases?: unknown }).botAliases;
    if (Array.isArray(aliasArr)) for (const a of aliasArr) pushAlias(a);
    // 点名词来自配置（逗号/空格分隔，groupSpeak.botAliases），留空则只靠昵称
    const aliasCfg = (this.config.groupSpeak as unknown as { botAliases?: unknown }).botAliases;
    if (Array.isArray(aliasCfg)) for (const a of aliasCfg) pushAlias(a);
    else if (typeof aliasCfg === 'string') for (const a of aliasCfg.split(/[\\s,，、]+/)) pushAlias(a);
    pushAlias('鲸鲸');
    const nameHit = plainText.length > 0 && aliases.some((a) => plainText.includes(a));
    if (nameHit && !atMeDirect) {
      this.log.info('群聊点名按 @ 处理', { alias: aliases.find((a) => plainText.includes(a)) });
    }
    const atMe = atMeDirect || nameHit;`;

s = s.replace(from, to);

/* 2) 推送判定：nameHit 参与（点名必推，不再被采样率拦） */
const gateOld = `    if (!this.shouldPushEvent(conv.kind, conv.address, atMe, false, text)) {`;
if (!s.includes(gateOld)) { console.error('推送判定锚点缺失'); process.exit(3); }
s = s.replace(gateOld, `    if (!this.shouldPushEvent(conv.kind, conv.address, atMe, nameHit, text)) {`);

writeFileSync(file, crlf ? s.replace(/\n/g, '\r\n') : s, 'utf8');
console.log('world.ts：点名视同 @（nameHit 接入 atMe + 推送判定）');
