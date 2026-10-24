/**
 * 重放 4/6（0.6.24 基线）：!dsh 入队带 sessionKey + replyTo（+ 可配置会话 ID / 共用一个会话）
 *
 * 对应 deploy/pet/patch-dsh-direct.mjs(qq) + deploy/pet/patch-dsh-session.mjs 的 qq 世界/qq 配置部分。
 * 桌面世界那份（patch-dsh-session.mjs desk：startDshInbox / drainDshInbox / dshFinished(replyTo) / dshSessionCfg）
 * 在 /data_n005/coopanion/pet/world.ts，是 bind mount，没被这次重装覆盖，本次不动它。
 *
 * 关键点（交接纪要 §5.2）：sessionKey 不是地址——共用会话时它是 'qq-shared'，
 * 拿它当回复地址就会把 !dsh 结果错发到桌宠气泡。真正地址放 replyTo。
 *
 * 用法: node deploy/pet/replay-0624-4-dsh-direct.mjs <qq世界包目录>
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const pkg = process.argv[2];
if (!pkg) { console.error('用法: node replay-069-4-dsh-direct.mjs <qq世界包目录>'); process.exit(2); }

const read = (rel) => {
  const raw = readFileSync(join(pkg, rel), 'utf8');
  return { raw, crlf: raw.includes('\r\n'), s: raw.replace(/\r\n/g, '\n') };
};
const write = (rel, out, crlf) => writeFileSync(join(pkg, rel), crlf ? out.replace(/\n/g, '\r\n') : out, 'utf8');

/* ============================ world.ts ============================ */
{
  const { s: raw, crlf } = read('src/world.ts');
  let s = raw;
  if (s.includes('replyTo: conv.address')) { console.log('世界：replyTo 已存在，跳过'); }
  else {
    const old = `          mkdirSync('/data/dsh-inbox', { recursive: true });
          writeFileSync(\`/data/dsh-inbox/\${Date.now()}.json\`, JSON.stringify({ task, sessionKey: conv.address }), 'utf8');`;
    if (!s.includes(old)) throw new Error('!dsh 入队锚点缺失');
    const neu = `          mkdirSync('/data/dsh-inbox', { recursive: true });
          // QQ 的 !dsh 默认共用一个 DSH 会话（上下文连续、会话不会越攒越多）；关掉则按会话地址各建一个
          const shared = (this.config as unknown as { dshSharedSession?: unknown }).dshSharedSession !== false;
          const sessKey = shared ? 'qq-shared' : conv.address;
          // 配置里的会话 ID：空串 = 让桌面世界那边新建一个再回写；字段不存在 = 老行为（宿主按 sessionKey 映射）
          const sessCfg = this.config as unknown as { dshQqSessionId?: unknown };
          const sessionId = typeof sessCfg.dshQqSessionId === 'string' ? sessCfg.dshQqSessionId.trim() : '';
          // replyTo 才是结果要回到的 QQ 会话；sessionKey 只留给老宿主按会话映射
          writeFileSync(\`/data/dsh-inbox/\${Date.now()}.json\`, JSON.stringify({ task, sessionKey: sessKey, replyTo: conv.address, sessionId }), 'utf8');`;
    s = s.replace(old, neu);
    write('src/world.ts', s, crlf);
    console.log('world.ts：!dsh 入队带 sessionKey/qq-shared + replyTo + sessionId');
  }
}

/* ============================ config.ts ============================ */
{
  const { s: raw, crlf } = read('src/config.ts');
  let s = raw;
  if (s.includes('worlds.qqbot.dshQqSessionId')) { console.log('config：会话字段已存在，跳过'); }
  else {
    const anchor = `      'worlds.qqbot.dshQuotaPerDay': {`;
    if (!s.includes(anchor)) throw new Error('DSH 组额度字段锚点缺失');
    const fields = `      'worlds.qqbot.dshPetSessionId': {
        type: 'string',
        title: '桌宠的 DSH 会话 ID',
        'x-hot': true,
        description: '留空 = 下次自动新建一个，并把新 ID 回写到这里；填上就复用（会话没了会自动新建并覆盖）。桌宠窗口里的 DSH 任务用它。',
      },
      'worlds.qqbot.dshQqSessionId': {
        type: 'string',
        title: 'QQ 的 DSH 会话 ID',
        'x-hot': true,
        description: '留空 = 下次自动新建一个，并把新 ID 回写到这里；填上就复用（会话没了会自动新建并覆盖）。「!dsh」和 QQ 私聊里的 DSH 任务用它。',
      },
      'worlds.qqbot.dshSharedSession': {
        type: 'boolean',
        title: 'QQ 共用一个 DSH 会话',
        'x-hot': true,
        description: '开启时所有 QQ 私聊/群聊的 !dsh 都写进同一个 DSH 会话（上下文连续、不会越攒越多）。关闭则按会话地址各建一个。',
      },
${anchor}`;
    s = s.replace(anchor, fields);
    write('src/config.ts', s, crlf);
    console.log('config.ts：DSH 组补 会话 ID ×2 + 共用开关（共 5 项）');
  }
}
