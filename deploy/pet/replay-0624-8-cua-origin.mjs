/**
 * replay 8（0.6.24 基线）：__cuaOrigin 回填
 *
 * 桌面工具只认「主人私聊」或「非 QQ（本机）」。QQ 世界推事件前把来源写到同进程的
 * globalThis.__cuaOrigin，桌面世界读它；带时间戳，过期就不算数。
 *
 * 对应 deploy/pet/patch-perm.mjs 的 qq 模式，但保留原文件换行风格。
 *
 * 用法: node deploy/pet/replay-0624-8-cua-origin.mjs <qq世界包目录>
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const pkg = process.argv[2];
if (!pkg) { console.error('用法: node replay-0624-8-cua-origin.mjs <qq世界包目录>'); process.exit(2); }

const file = join(pkg, 'src/world.ts');
const raw = readFileSync(file, 'utf8');
const crlf = raw.includes('\r\n');
let s = raw.replace(/\r\n/g, '\n');

if (s.includes('__cuaOrigin')) { console.log('已打过 __cuaOrigin，跳过'); process.exit(0); }

const anchor = "    this.log.info('HANDLE_PUSH pre kind=' + conv.kind);";
if (s.split(anchor).length - 1 !== 1) throw new Error('HANDLE_PUSH pre 锚点不唯一');

s = s.replace(anchor, `    // 给桌面世界留个来源标记：桌面工具只认「主人私聊」或「非 QQ（本机）」。
    // 同进程，另一个 World 读 globalThis 即可；带时间戳，过期就不算数。
    (globalThis as unknown as Record<string, unknown>).__cuaOrigin = {
      kind: conv.kind,
      conv: conv.address,
      user: String(sender.userId ?? ''),
      ts: Date.now(),
    };
${anchor}`);

writeFileSync(file, crlf ? s.replace(/\n/g, '\r\n') : s, 'utf8');
console.log('world.ts：__cuaOrigin 来源标记已回填（HANDLE_PUSH 之前）');
