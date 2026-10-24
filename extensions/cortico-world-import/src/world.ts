/**
 * cortico-world-import：把 QQ 导出的聊天记录导入成本地档案。
 *
 * 只做三件事：
 *   scan  — 看导入目录里有哪些 .txt、哪些已经导入过；
 *   run   — 解析新文件 → 追加 records.jsonl → 重新聚合 members/ → 可选写记忆冷启动包；
 *   stats — 看总量。
 *
 * 刻意不直接写 memory 世界的 memory-data.json：那个文件有内存态 + 防抖落盘，
 * 外部写入会被覆盖。冷启动走 cortico-memory-export JSON + mem_transfer(import)。
 */
import type { ConfigGroup, ToolDef, World, WorldWebUiDecl } from 'cortico/core/types.ts';
import type { WorldContext, WorldDefinition } from 'cortico/world.ts';
import { IMPORT_CONFIG_GROUP, IMPORT_DEFAULTS, type ImportConfig } from './config.ts';
import { ensureDirs, pathsOf, runImport, scan, stats, type Paths, type RunResult } from './lib.ts';

function fmtBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

export class ImportWorld implements World {
  readonly id = 'import';
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;
  private lastRun: { at: string; summary: string } | null = null;

  constructor(private readonly ctx: WorldContext<ImportConfig>) {}

  /** 不往 system 前缀塞任何东西。 */
  envPromptVars(): Record<string, string> | null {
    return null;
  }

  private paths(): Paths {
    return pathsOf(this.ctx.cfg, this.ctx.dataDir);
  }

  tools(): ToolDef[] {
    return [
      {
        name: 'chat_import',
        tags: ['read', 'write'],
        barrierAfter: true,
        description:
          '导入 QQ 导出的聊天记录（.txt）并聚合群友档案。三种 action：\n' +
          '- scan：列出导入目录里的 .txt、大小、是否已导入（按 sha256 去重）；\n' +
          '- run：导入所有没导入过的文件 → 追加 records.jsonl → 重新生成 members/ 档案 → 需要时写一份 cortico-memory-export 冷启动包；\n' +
          '- stats：看导入目录、已导入文件数、总消息数、档案人数。\n' +
          '只在用户明确要求「导入聊天记录 / 更新群友档案 / 看导入进度」时调用；不要自己反复轮询。',
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['scan', 'run', 'stats'], description: '要执行的动作。' },
          },
          required: ['action'],
        },
        handler: async (args) => {
          const action = typeof args.action === 'string' ? args.action : '';
          const p = this.paths();
          try {
            ensureDirs(p);
            if (action === 'stats') {
              const s = stats(p);
              return [
                `导入目录：${s.importDir}`,
                `待导入 .txt：${s.txtFiles} 个；已导入记录：${s.doneRecords} 条`,
                `records.jsonl：${s.recordsFile}（${s.records} 条消息）`,
                `群友档案：${s.members} 人（${p.membersDir}）`,
                `最近导入：${s.lastImport ?? '从未'}`,
                `上次本进程运行：${this.lastRun ? `${this.lastRun.at} ${this.lastRun.summary}` : '无'}`,
              ].join('\n');
            }
            if (action === 'scan') {
              const rows = scan(this.ctx.cfg, p);
              if (!rows.length) return `导入目录 ${p.importDir} 里没有 .txt 文件。把 QQ 导出的聊天记录放进去，再 chat_import(action=run)。`;
              const lines = rows.map((r) => `- ${r.file}（${fmtBytes(r.size)}，${r.imported ? `已导入 ${r.importedAt ?? ''}` : '未导入'}）`);
              const todo = rows.filter((r) => !r.imported).length;
              return `导入目录：${p.importDir}\n共 ${rows.length} 个 .txt，未导入 ${todo} 个：\n${lines.join('\n')}`;
            }
            if (action === 'run') {
              if (this.busy) return '上一次导入还没跑完，稍后再试。';
              this.busy = true;
              try {
                const r: RunResult = await runImport(this.ctx.cfg, p);
                const head = [
                  `扫描 ${r.scanned} 个文件：新导入 ${r.imported}，跳过（已导入）${r.skipped}，失败 ${r.details.filter((d) => d.status === 'failed').length}。`,
                  `新增消息 ${r.records} 条；档案现有人数 ${r.members}。`,
                ];
                const bad = r.details.filter((d) => d.status === 'failed');
                if (bad.length) head.push(`失败：${bad.map((d) => `${d.file}（${d.error ?? '未知'}）`).join('；')}`);
                if (r.memoryExport) {
                  head.push(`记忆冷启动包：${r.memoryExport}`);
                  head.push('要把它灌进记忆，请让用户在控制台执行 mem_transfer(action=import, file=上面这个路径)，不要直接写 memory-data.json。');
                }
                this.lastRun = { at: new Date().toISOString(), summary: `导入 ${r.imported} 个文件 / ${r.records} 条` };
                return head.join('\n');
              } finally {
                this.busy = false;
              }
            }
            return `未知 action：「${action}」，支持 scan / run / stats。`;
          } catch (e) {
            return `导入失败：${e instanceof Error ? e.message : String(e)}`;
          }
        },
      },
    ];
  }

  async start(): Promise<void> {
    ensureDirs(this.paths());
    this.arm();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** 自动扫描：间隔 > 0 才装定时器；只在有新文件且 autoRun 时真跑。 */
  private arm(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const minutes = Number(this.ctx.cfg.scanMinutes) || 0;
    if (minutes <= 0) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, Math.max(60, minutes * 60) * 1000);
    // 不阻塞 Core 退出
    (this.timer as unknown as { unref?: () => void }).unref?.();
  }

  private async tick(): Promise<void> {
    if (this.busy) return;
    try {
      const p = this.paths();
      const rows = scan(this.ctx.cfg, p);
      if (!rows.some((r) => !r.imported)) return;
      if (!this.ctx.cfg.autoRun) return;
      this.busy = true;
      try {
        const r = await runImport(this.ctx.cfg, p);
        this.lastRun = { at: new Date().toISOString(), summary: `自动导入 ${r.imported} 个文件 / ${r.records} 条` };
        console.log(`[import] 自动导入完成：${r.imported} 个文件、${r.records} 条消息、${r.members} 人档案`);
      } finally {
        this.busy = false;
      }
    } catch (e) {
      console.error('[import] 自动扫描失败：', e instanceof Error ? e.message : String(e));
    }
  }

  webUi(): WorldWebUiDecl {
    return { config: [IMPORT_CONFIG_GROUP as ConfigGroup] };
  }
}

export const IMPORT_WORLD: WorldDefinition<ImportConfig> = {
  id: 'import',
  label: '聊天记录导入',
  defaults: () => ({ ...IMPORT_DEFAULTS }),
  create: (ctx) => new ImportWorld(ctx),
};
