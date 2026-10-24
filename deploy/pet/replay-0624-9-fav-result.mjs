/**
 * replay 9（验收修复）：兼容 NapCat 的 add_custom_face 成功响应
 *
 * 实测：NapCat 成功时返回 `{ result: 0, errMsg: '', isExist: 0 }`，没有 emoji_id。
 * 原逻辑只认 emoji_id，会把它记成失败（日志「add_custom_face 未返回 emoji_id」），
 * 导致表情元数据不记 emojiId、qq_sticker_to_favorites 反复重推同一张。
 *
 * 改法：emoji_id / result===0 / retcode===0 都算成功；没有 emoji_id 时用合成 id 记账。
 *
 * 用法: node deploy/pet/replay-0624-9-fav-result.mjs <qq世界包目录>
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const pkg = process.argv[2];
if (!pkg) { console.error('用法: node replay-0624-9-fav-result.mjs <qq世界包目录>'); process.exit(2); }

const file = join(pkg, 'src/world.ts');
const raw = readFileSync(file, 'utf8');
const crlf = raw.includes('\r\n');
let s = raw.replace(/\r\n/g, '\n');

if (s.includes('NapCat 成功时返回')) { console.log('已打过 fav-result，跳过'); process.exit(0); }

const old = `      const res = (await this.driver.callApi('add_custom_face', { file })) as
        | { emoji_id?: string; data?: { emoji_id?: string } }
        | undefined;
      const eid = res?.emoji_id ?? res?.data?.emoji_id ?? null;
      if (eid) this.log.info('已加入 QQ 收藏表情', { emojiId: eid, ext });
      else this.log.warn('add_custom_face 未返回 emoji_id', { res });
      return eid ?? null;`;

const neu = `      const res = (await this.driver.callApi('add_custom_face', { file })) as
        | { emoji_id?: string; data?: { emoji_id?: string }; result?: number; retcode?: number; errMsg?: string }
        | undefined;
      const eid = res?.emoji_id ?? res?.data?.emoji_id ?? null;
      // NapCat 成功时返回 { result: 0, errMsg: '', isExist: 0 }，没有 emoji_id；
      // 也认 result/retcode=0，并用合成 id 记账，避免 qq_sticker_to_favorites 反复重推同一张。
      const ok = eid != null || res?.result === 0 || res?.retcode === 0;
      const id = eid ?? \`napcat-\${Date.now().toString(36)}\`;
      if (ok) this.log.info('已加入 QQ 收藏表情', { emojiId: id, ext, raw: eid ? undefined : res });
      else this.log.warn('add_custom_face 未返回 emoji_id', { res });
      return ok ? id : null;`;

if (s.split(old).length - 1 !== 1) throw new Error('add_custom_face 响应块锚点不唯一');
s = s.replace(old, neu);

writeFileSync(file, crlf ? s.replace(/\n/g, '\r\n') : s, 'utf8');
console.log('world.ts：add_custom_face 响应兼容（result=0 算成功，合成 emojiId 记账）');
