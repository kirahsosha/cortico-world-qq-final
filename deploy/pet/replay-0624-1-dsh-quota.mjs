/**
 * replay 1/6（0.6.24 基线）：!dsh 免模型通道 + 每日配额 + 可配置白名单（+ 出站队列消费者）
 *
 * 对应 deploy/pet/replay-069-1-dsh-quota.mjs，但锚点换成上游 0.6.24 的真实代码：
 *   - fs / config 导入行与 0.6.9 相同
 *   - start() 里插入点改成 `await this.driver.start();`（0.6.9 是 createDriver 之后）
 * 锚点缺失立即报错退出（绝不跨块正则）。
 *
 * 用法: node deploy/pet/replay-0624-1-dsh-quota.mjs <qq世界包目录>
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const pkg = process.argv[2];
if (!pkg) { console.error('用法: node replay-0624-1-dsh-quota.mjs <qq世界包目录>'); process.exit(2); }

const read = (rel) => {
  const raw = readFileSync(join(pkg, rel), 'utf8');
  return { raw, crlf: raw.includes('\r\n'), s: raw.replace(/\r\n/g, '\n') };
};
const write = (rel, out, crlf) => writeFileSync(join(pkg, rel), crlf ? out.replace(/\n/g, '\r\n') : out, 'utf8');

/* ============================ world.ts ============================ */
{
  const { s: raw, crlf } = read('src/world.ts');
  let s = raw;
  if (s.includes('/data/dsh-quota.json')) { console.log('世界：配额补丁已存在，跳过'); }
  else {
    /* 1) node:fs 具名导入补齐 */
    const fsOld = "import { existsSync, readFileSync, writeFileSync, readdirSync, openSync } from 'node:fs';";
    if (!s.includes(fsOld)) throw new Error('fs 导入锚点缺失');
    s = s.replace(fsOld, "import { existsSync, readFileSync, writeFileSync, readdirSync, openSync, mkdirSync, unlinkSync, copyFileSync } from 'node:fs';");

    /* 2) config 具名导入补 QQ_DSH_GROUP */
    const cfgImport = "import { QQ_CONFIG_GROUP, QQ_VOICE_GROUP, QQ_ASR_GROUP, QQ_DEFAULTS, normalizeConfig, toIds, type QQConfigSection, type QQWorldConfig } from './config.ts';";
    if (!s.includes(cfgImport)) throw new Error('config 导入锚点缺失');
    s = s.replace(cfgImport, "import { QQ_CONFIG_GROUP, QQ_VOICE_GROUP, QQ_ASR_GROUP, QQ_DSH_GROUP, QQ_DEFAULTS, normalizeConfig, toIds, type QQConfigSection, type QQWorldConfig } from './config.ts';");

    /* 3) 方法区：出站队列 + 白名单 + 配额（插在 start() 之前） */
    const startAnchor = '  async start(host: WorldHost): Promise<void> {';
    if (!s.includes(startAnchor)) throw new Error('start 锚点缺失');
    const methods = `  /** 出站队列：外部写 /data/qq-outbox/*.json → 这里发 QQ（DSH 结果、跨天摘要都走它）。 */
  private outboxTimer: ReturnType<typeof setInterval> | null = null;
  private readonly outboxDir = '/data/qq-outbox';

  /** !dsh 白名单：worlds.qqbot.dshAllowedUsers（逗号分隔字符串或数组）。留空 = 关闭桥接。 */
  private dshAllowed(userId: string): boolean {
    const cfg = this.config as unknown as { dshAllowedUsers?: unknown };
    const raw = cfg.dshAllowedUsers;
    let ids: string[] = [];
    if (Array.isArray(raw)) ids = raw.map((x) => String(x).trim()).filter(Boolean);
    else if (typeof raw === 'string') ids = raw.split(/[\\s,，]+/).map((x) => x.trim()).filter(Boolean);
    // 留空 = 关闭功能：谁都不允许（不回退内置主人号）
    return ids.includes(userId);
  }

  /** 配额与审计：按自然日计数，超限拒绝；新的一天首次使用时补发前一天摘要。 */
  private dshTakeDecide(userId: string, task: string): { ok: boolean; count: number; limit: number; reason: string } {
    const cfg = this.config as unknown as { dshQuotaPerDay?: unknown };
    const limit = Number(cfg.dshQuotaPerDay ?? 20) || 0;   // 0 或负数 = 不限制
    const file = '/data/dsh-quota.json';
    const today = new Date().toLocaleDateString('sv-SE');    // YYYY-MM-DD
    let st: { date: string; count: number; tasks: Array<{ ts: string; from: string; preview: string }> } = { date: today, count: 0, tasks: [] };
    try {
      const got = JSON.parse(readFileSync(file, 'utf8'));
      if (got && typeof got === 'object') st = { date: String(got.date ?? ''), count: Number(got.count ?? 0), tasks: Array.isArray(got.tasks) ? got.tasks : [] };
    } catch { /* 首次 */ }

    if (st.date !== today) {
      // 跨天：先把昨天的摘要推出去（有记录才发）
      if (st.date && st.tasks.length) {
        const lines = st.tasks.slice(0, 12).map((t, i) => \`\${i + 1}. [\${t.ts}] \${t.preview}\`);
        const more = st.tasks.length > 12 ? \`\\n…还有 \${st.tasks.length - 12} 条\` : '';
        try {
          const dir = '/data/qq-outbox';
          mkdirSync(dir, { recursive: true });
          writeFileSync(\`\${dir}/dsh-summary-\${Date.now()}.json\`, JSON.stringify({
            to: 'private:344380045',
            text: \`【DSH 日报 \${st.date}】共 \${st.tasks.length} 条：\\n\${lines.join('\\n')}\${more}\`,
          }), 'utf8');
        } catch { /* ignore */ }
      }
      st = { date: today, count: 0, tasks: [] };
    }

    if (limit > 0 && st.count >= limit) {
      return { ok: false, count: st.count, limit, reason: \`今天的 DSH 额度用完了（\${st.count}/\${limit}），明天再来。\` };
    }

    st.count += 1;
    const now = new Date();
    st.tasks.push({
      ts: now.toTimeString().slice(0, 5),
      from: userId,
      preview: task.replace(/\\s+/g, ' ').slice(0, 40),
    });
    if (st.tasks.length > 200) st.tasks = st.tasks.slice(-200);
    try { writeFileSync(file, JSON.stringify(st), 'utf8'); } catch { /* ignore */ }
    return { ok: true, count: st.count, limit, reason: '' };
  }

  private startOutbox(): void {
    if (this.outboxTimer) return;
    try { mkdirSync(\`\${this.outboxDir}/sent\`, { recursive: true }); mkdirSync(\`\${this.outboxDir}/failed\`, { recursive: true }); } catch { /* ignore */ }
    this.outboxTimer = setInterval(() => { void this.drainOutbox(); }, 5000);
    this.log.info('QQ 出站队列已启动', { dir: this.outboxDir });
  }

  private async drainOutbox(): Promise<void> {
    const driver = this.driver;
    if (!driver) return;
    let names: string[] = [];
    try { names = readdirSync(this.outboxDir).filter((n) => n.endsWith('.json')); } catch { return; }
    for (const name of names.slice(0, 10)) {
      const p = \`\${this.outboxDir}/\${name}\`;
      let job: { to?: string; text?: string; tries?: number } | null = null;
      try { job = JSON.parse(readFileSync(p, 'utf8')); } catch { job = null; }
      if (!job || !job.to || !job.text) {
        try { copyFileSync(p, \`\${this.outboxDir}/failed/\${name}\`); unlinkSync(p); } catch { /* ignore */ }
        continue;
      }
      const [kind, idStr] = String(job.to).split(':');
      const id = Number(idStr);
      try {
        await driver.callApi('send_msg', {
          message_type: kind === 'group' ? 'group' : 'private',
          ...(kind === 'group' ? { group_id: id } : { user_id: id }),
          message: [{ type: 'text', data: { text: String(job.text).slice(0, 4000) } }],
        });
        try { copyFileSync(p, \`\${this.outboxDir}/sent/\${name}\`); unlinkSync(p); } catch { /* ignore */ }
        this.log.info('出站队列已发送', { to: job.to, len: String(job.text).length });
      } catch (e) {
        const tries = Number(job.tries ?? 0) + 1;
        try {
          if (tries >= 3) { copyFileSync(p, \`\${this.outboxDir}/failed/\${name}\`); unlinkSync(p); }
          else writeFileSync(p, JSON.stringify({ ...job, tries }), 'utf8');
        } catch { /* ignore */ }
        this.log.warn('出站队列发送失败', { to: job.to, tries, err: String(e) });
      }
    }
  }

`;
    s = s.replace(startAnchor, methods + startAnchor);

    /* 4) start() 里起定时器（放在 driver 真正 start 之后，避免首轮 callApi 失败） */
    const driverReady = '    await this.driver.start();';
    if (!s.includes(driverReady)) throw new Error('driver.start 锚点缺失');
    s = s.replace(driverReady, driverReady + '\n    this.startOutbox();');

    /* 5) stop() 里清定时器 */
    const stopAnchor = '  async stop(): Promise<void> {';
    if (!s.includes(stopAnchor)) throw new Error('stop 锚点缺失');
    s = s.replace(stopAnchor, stopAnchor + '\n    if (this.outboxTimer) { clearInterval(this.outboxTimer); this.outboxTimer = null; }');

    /* 6) handleMessage：!dsh 分支（紧跟 HANDLE_IN 日志，早于一切推送判定） */
    const inLog = "    this.log.info('HANDLE_IN kind=' + conv.kind + ' text=' + JSON.stringify(text).slice(0, 40));";
    if (!s.includes(inLog)) throw new Error('HANDLE_IN 锚点缺失');
    const dshBranch = `

    // !dsh：白名单私聊专用，直接进 DSH 队列，不经过模型（也不算群消息采样）
    if (conv.kind === 'private' && /^[!！]dsh\\s+/.test(text)) {
      // 白名单留空 = 关闭：静默忽略，既不回复也不让模型看到
      if (!this.dshAllowed(String(sender.userId))) return;
      const task = text.replace(/^[!！]dsh\\s+/, '').trim();
      if (task) {
        const quota = this.dshTakeDecide(String(sender.userId), task);
        if (!quota.ok) {
          try {
            await this.driver?.callApi('send_msg', {
              message_type: 'private',
              user_id: Number(sender.userId),
              message: [{ type: 'text', data: { text: quota.reason } }],
            });
          } catch { /* ignore */ }
          return;
        }
        try {
          mkdirSync('/data/dsh-inbox', { recursive: true });
          writeFileSync(\`/data/dsh-inbox/\${Date.now()}.json\`, JSON.stringify({ task, sessionKey: conv.address }), 'utf8');
          this.log.info('!dsh 已入队', { task: task.slice(0, 40), today: quota.count });
        } catch (e) {
          this.log.warn('!dsh 入队失败', { err: String(e) });
        }
        try {
          await this.driver?.callApi('send_msg', {
            message_type: 'private',
            user_id: Number(sender.userId),
            message: [{ type: 'text', data: { text: \`收到，已转给 DSH（今天第 \${quota.count}/\${quota.limit} 条），跑完会把结果发回来。\` } }],
          });
        } catch { /* ignore */ }
        return;
      }
    }`;
    s = s.replace(inLog, inLog + dshBranch);

    /* 7) 注册配置组：webUi.config + configGroupById */
    const cfgArr = '      config: [QQ_CONFIG_GROUP, QQ_VOICE_GROUP, QQ_ASR_GROUP],';
    if (!s.includes(cfgArr)) throw new Error('webUi.config 锚点缺失');
    s = s.replace(cfgArr, '      config: [QQ_CONFIG_GROUP, QQ_DSH_GROUP, QQ_VOICE_GROUP, QQ_ASR_GROUP],');

    const mapAnchor = "      'world:qqbot': QQ_CONFIG_GROUP,";
    if (!s.includes(mapAnchor)) throw new Error('configGroupById 锚点缺失');
    s = s.replace(mapAnchor, mapAnchor + "\n      'world:qqbot-dsh': QQ_DSH_GROUP,");

    write('src/world.ts', s, crlf);
    console.log('world.ts：!dsh + 配额 + 白名单 + 出站队列 已接入');
  }
}

/* ============================ config.ts ============================ */
{
  const { s: raw, crlf } = read('src/config.ts');
  let s = raw;
  if (s.includes('QQ_DSH_GROUP')) { console.log('config：DSH 组已存在，跳过'); }
  else {
    const anchor = `  /** 语音收发配置分组：收语音转文字、发语音，两种实现可切。路径/模型均不写死，由下方各字段或环境变量决定。 */
  export const QQ_VOICE_GROUP: ConfigGroup = {`;
    if (!s.includes(anchor)) throw new Error('QQ_VOICE_GROUP 锚点缺失');
    const group = `  /** 「!dsh <任务>」免模型通道的额度与白名单。 */
  export const QQ_DSH_GROUP: ConfigGroup = {
  id: 'world:qqbot-dsh',
  owner: 'world:qqbot-dsh',
  schema: {
    type: 'object',
    title: 'QQ · DSH 桥接',
    description: '「!dsh <任务>」免模型通道：每日额度与白名单。改完即时生效，无需重启。',
    properties: {
      'worlds.qqbot.dshQuotaPerDay': {
        type: 'integer',
        title: 'DSH 每日条数上限',
        minimum: 0,
        maximum: 500,
        'x-hot': true,
        description: '每天最多跑几条；0 = 不限制。超限直接回「今天的 DSH 额度用完了（N/N），明天再来」。',
      },
      'worlds.qqbot.dshAllowedUsers': {
        type: 'string',
        title: 'DSH 白名单（QQ 号）',
        'x-hot': true,
        description: '允许用「!dsh」的 QQ 号，逗号分隔（如 344380045,2961227626）。留空 = 关闭 DSH 桥接：任何人都发不进去，消息也不会进模型。',
      },
    },
  },
};

`;
    s = s.replace(anchor, group + anchor);
    write('src/config.ts', s, crlf);
    console.log('config.ts：QQ_DSH_GROUP（额度 + 白名单）已加入');
  }
}
