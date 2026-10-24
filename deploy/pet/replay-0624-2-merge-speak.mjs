/**
 * 重放 2/6（0.6.24 基线）：把「群消息采样 / 点名识别词 / 推送判定脚本」合并进 groupSpeak.* 命名空间
 *
 * 对应 replay-069-2，锚点已核对 0.6.24（groupSpeak 仍是 3 项）：
 * 官方版的 groupSpeak 只有 3 项（enabled/maxPerWindow/windowSec），也没有 listen.* 字段，
 * 所以这里直接往同一个组里加 sampleRate / cooldownSec / botAliases / pushRuleScript 四项（合计 7 项），
 * 并把「这条群消息要不要推给模型」的判定逻辑落到世界代码里——否则那 3 项就是死字段。
 *
 * 取值优先级：groupSpeak.* 优先，退回旧的 listen.*（config.json 里还有 listen.sampleRate=0.3 / cooldownSec=90），
 * 都没有则 sampleRate=1（全推）。
 *
 * 用法: node deploy/pet/replay-0624-2-merge-speak.mjs <qq世界包目录>
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const pkg = process.argv[2];
if (!pkg) { console.error('用法: node replay-0624-2-merge-speak.mjs <qq世界包目录>'); process.exit(2); }

const read = (rel) => {
  const raw = readFileSync(join(pkg, rel), 'utf8');
  return { raw, crlf: raw.includes('\r\n'), s: raw.replace(/\r\n/g, '\n') };
};
const write = (rel, out, crlf) => writeFileSync(join(pkg, rel), crlf ? out.replace(/\n/g, '\r\n') : out, 'utf8');

/* ============================ world.ts ============================ */
{
  const { s: raw, crlf } = read('src/world.ts');
  let s = raw;
  if (s.includes('shouldPushEvent')) { console.log('世界：推送判定已存在，跳过'); }
  else {
    /* 1) 判定逻辑：插在「群聊发言限速」段之前 */
    const anchor = '  // ---- 群聊发言限速 / 话题防死循环 ----';
    if (!s.includes(anchor)) throw new Error('群聊限速段锚点缺失');
    const block = `  // ---- 群消息采样 / 推送判定（groupSpeak.* 命名空间）----
  /** 群消息采样：会话地址 -> 上次抽样推送的时间。 */
  private lastSampledPush = new Map<string, number>();
  /** 自定义推送脚本的编译缓存（配置变了就重编）。 */
  private pushRule: { src: string; fn: (...args: unknown[]) => unknown } | null = null;

  /** 采样与冷却的取值：groupSpeak.* 优先，退回旧 listen.*，都没有则全推。 */
  private pushRates(): { sampleRate: number; cooldownSec: number } {
    const gs = this.config.groupSpeak as unknown as { sampleRate?: unknown; cooldownSec?: unknown };
    const ls = (this.config as unknown as { listen?: { sampleRate?: unknown; cooldownSec?: unknown } }).listen;
    const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
    const sampleRate = num(gs.sampleRate) ?? num(ls?.sampleRate) ?? 1;
    const cooldownSec = num(gs.cooldownSec) ?? num(ls?.cooldownSec) ?? 0;
    return { sampleRate, cooldownSec };
  }

  /** 内置判定：不经脚本时的行为。私聊与被 @/点名永远推；群里其余消息按采样率抽样并受冷却限制。 */
  private builtinPush(kind: string, address: string, atMe: boolean, sampleRate: number, cooldownSec: number, last: number, now: number): boolean {
    if (kind !== 'group' || atMe) return true;
    if (sampleRate >= 1) return true;
    if (sampleRate <= 0) return false;
    if (cooldownSec > 0 && now - last < cooldownSec * 1000) return false;
    if (Math.random() > sampleRate) return false;
    this.lastSampledPush.set(address, now);
    return true;
  }

  /**
   * 这条消息要不要推给模型。
   * 配了 pushRuleScript 就完全交给脚本（可用变量见面板说明）；脚本报错/不返回布尔值则回退内置逻辑。
   * 注意：脚本在这个进程里执行，等同管理员权限 —— 只写你自己看得懂的代码。
   */
  private shouldPushEvent(kind: string, address: string, atMe: boolean, nameHit = false, text = ''): boolean {
    const { sampleRate, cooldownSec } = this.pushRates();
    const now = Date.now();
    const last = this.lastSampledPush.get(address) ?? 0;
    const rand = Math.random();

    const src = String((this.config.groupSpeak as unknown as { pushRuleScript?: unknown }).pushRuleScript ?? '').trim();
    if (src) {
      try {
        if (!this.pushRule || this.pushRule.src !== src) {
          // eslint-disable-next-line no-new-func
          const fn = new Function('text', 'kind', 'senderId', 'atMe', 'nameHit', 'sampleRate', 'cooldownSec', 'lastAgoMs', 'rand', src);
          this.pushRule = { src, fn };
        }
        const out = this.pushRule.fn(text, kind, address, atMe, nameHit, sampleRate, cooldownSec, now - last, rand);
        if (out === true) { if (kind === 'group' && !atMe && !nameHit) this.lastSampledPush.set(address, now); return true; }
        if (out === false) return false;
        this.log.warn('推送脚本没有返回布尔值，按内置逻辑处理', { got: typeof out });
      } catch (e) {
        this.log.warn('推送脚本报错，按内置逻辑处理', { err: String(e) });
        this.pushRule = null;
      }
    }
    return this.builtinPush(kind, address, atMe, sampleRate, cooldownSec, last, now);
  }

`;
    s = s.replace(anchor, block + anchor);

    /* 2) handleMessage 里加门禁（HANDLE_PUSH 之前） */
    const pushLog = "    this.log.info('HANDLE_PUSH pre kind=' + conv.kind);";
    if (!s.includes(pushLog)) throw new Error('HANDLE_PUSH 锚点缺失');
    s = s.replace(pushLog, `    if (!this.shouldPushEvent(conv.kind, conv.address, atMe, false, text)) {
      this.log.info('群消息采样：本条不推给模型', { conv: conv.address });
      return;
    }
${pushLog}`);

    write('src/world.ts', s, crlf);
    console.log('world.ts：推送判定（采样率/冷却/脚本）已接入');
  }
}

/* ============================ config.ts ============================ */
{
  const { s: raw, crlf } = read('src/config.ts');
  let s = raw;
  if (s.includes('worlds.qqbot.groupSpeak.pushRuleScript')) { console.log('config：4 项已存在，跳过'); }
  else {
    /* 1) 类型：groupSpeak 补 4 个字段 */
    const typeOld = `  /** 群聊发言频率限制：限制每个群在单位时间窗口内被 bot 主动+回复发出的消息总量，防止刷屏。 */
  groupSpeak: {
    /** 是否启用群聊发言频率限制。 */
    enabled: boolean;
    /** 滑动窗口内允许发出的最大消息条数。 */
    maxPerWindow: number;
    /** 滑动窗口长度（秒）。 */
    windowSec: number;
  };`;
    if (!s.includes(typeOld)) throw new Error('groupSpeak 类型锚点缺失');
    s = s.replace(typeOld, `  /** 群聊发言频率限制 + 群消息要不要推给模型：一个命名空间管全。 */
  groupSpeak: {
    /** 是否启用群聊发言频率限制。 */
    enabled: boolean;
    /** 滑动窗口内允许发出的最大消息条数。 */
    maxPerWindow: number;
    /** 滑动窗口长度（秒）。 */
    windowSec: number;
    /** 群消息采样率（0~1）：被 @ / 点名 / 脚本放行的必推，其余按此概率抽样。1=全推。 */
    sampleRate: number;
    /** 采样冷却（秒）：同一群里两次抽样推送的最小间隔；0=不限制。 */
    cooldownSec: number;
    /** 点名识别词（逗号分隔）：群里正文命中就当作被 @，必定推给模型。 */
    botAliases: string;
    /** 推送判定脚本（JS，返回 true 才推）：留空=内置逻辑。 */
    pushRuleScript: string;
  };`);

    /* 2) 默认值 */
    const defOld = `  groupSpeak: {
    enabled: true,
    maxPerWindow: 12,
    windowSec: 60,
  },`;
    if (!s.includes(defOld)) throw new Error('groupSpeak 默认值锚点缺失');
    s = s.replace(defOld, `  groupSpeak: {
    enabled: true,
    maxPerWindow: 12,
    windowSec: 60,
    sampleRate: 0.3,
    cooldownSec: 90,
    botAliases: '',
    pushRuleScript: '',
  },`);

    /* 3) normalizeConfig 补齐 */
    const normOld = `  if (typeof gs.windowSec !== 'number' || (gs.windowSec as number) < 1) gs.windowSec = QQ_DEFAULTS.groupSpeak.windowSec;`;
    if (!s.includes(normOld)) throw new Error('normalizeConfig 锚点缺失');
    s = s.replace(normOld, normOld + `
  if (typeof gs.sampleRate !== 'number' || (gs.sampleRate as number) < 0) gs.sampleRate = QQ_DEFAULTS.groupSpeak.sampleRate;
  if ((gs.sampleRate as number) > 1) gs.sampleRate = 1;
  if (typeof gs.cooldownSec !== 'number' || (gs.cooldownSec as number) < 0) gs.cooldownSec = QQ_DEFAULTS.groupSpeak.cooldownSec;
  if (typeof gs.botAliases !== 'string') gs.botAliases = QQ_DEFAULTS.groupSpeak.botAliases;
  if (typeof gs.pushRuleScript !== 'string') gs.pushRuleScript = QQ_DEFAULTS.groupSpeak.pushRuleScript;`);

    /* 4) schema：加 4 项（面板 prefix='worlds.qqbot.groupSpeak.' 会一起渲染成 7 项） */
    const schemaOld = `      'worlds.qqbot.groupSpeak.windowSec': { type: 'integer', title: '窗口长度(秒)', minimum: 1, maximum: 3600, 'x-hot': true, description: '限速滑动窗口长度。' },`;
    if (!s.includes(schemaOld)) throw new Error('groupSpeak schema 锚点缺失');
    s = s.replace(schemaOld, schemaOld + `
      'worlds.qqbot.groupSpeak.sampleRate': { type: 'number', title: '群消息采样率', minimum: 0, maximum: 1, multipleOf: 0.05, 'x-hot': true, description: '不是每条群消息都推给模型：被 @、点名、脚本放行的必推；其余按此概率抽样。1=全推，0.3=约三条挑一条，0=只在被 @ 时推。' },
      'worlds.qqbot.groupSpeak.cooldownSec': { type: 'integer', title: '采样冷却(秒)', minimum: 0, maximum: 3600, 'x-hot': true, description: '同一群里两次抽样推送的最小间隔；0=不限制。防止热闹的群把采样额度一次用光。' },
      'worlds.qqbot.groupSpeak.botAliases': { type: 'string', title: '点名识别词(逗号分隔)', 'x-hot': true, description: '群里正文命中这些词就当作被 @，必定推给模型。留空则只用账号昵称匹配。例：鲸鲸,大肥鱼,肥鱼' },
      'worlds.qqbot.groupSpeak.pushRuleScript': { type: 'string', title: '推送判定脚本(JS，返回 true 才推)', 'x-hot': true, description: '留空 = 内置逻辑。可用变量：text、kind、senderId、atMe、nameHit、sampleRate、cooldownSec、lastAgoMs、rand。脚本报错自动回退内置逻辑。注意：它跑在 Core 进程里，等同管理员权限。' },`);

    write('src/config.ts', s, crlf);
    console.log('config.ts：groupSpeak 组补齐 7 项（schema + 默认值 + 归一化）');
  }
}
