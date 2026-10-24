/**
 * 导入扩展的配置形状。`ctx.cfg` 是 `worlds.import` 的活引用，
 * 只有扫描间隔/目录这类「启动时读」的键需要重启实例。
 */
import type { ConfigGroup } from 'cortico/core/types.ts';

export interface ImportConfig {
  /** 框架对账用；是否启用由部署的 worlds 列表决定。 */
  enabled: boolean;
  [k: string]: unknown;
  /** 扫描目录：QQ 导出的 .txt 放这里。 */
  importDir: string;
  /** 自动扫描间隔（分钟）；0 = 关闭，只靠工具手动触发。 */
  scanMinutes: number;
  /** `.done/` 里的导入记录保留天数；过期记录允许同内容文件重新导入。 */
  retentionDays: number;
  /** 扫描到新文件时是否自动导入（否则只提示）。 */
  autoRun: boolean;
  /** 聚合群友档案的最小发言条数。 */
  minMsgs: number;
  /** 导入后是否顺带写一份 cortico-memory-export 冷启动包。 */
  memoryExport: boolean;
}

export const IMPORT_DEFAULTS: ImportConfig = {
  enabled: false,
  importDir: '/data/import',
  scanMinutes: 30,
  retentionDays: 30,
  autoRun: true,
  minMsgs: 5,
  memoryExport: true,
};

/** 控制台可调旋钮。一个属性一条 JSON Schema，没有手写表单。 */
export const IMPORT_CONFIG_GROUP: ConfigGroup = {
  id: 'world:import',
  owner: 'world:import',
  schema: {
    type: 'object',
    title: '聊天记录导入',
    description:
      '把 QQ 导出的聊天记录 .txt 放进导入目录，扩展会解析、聚合群友档案（写进 memory 世界也在读的 members/），' +
      '并按 sha256 去重。要给记忆做冷启动时，把生成的 cortico-memory-export JSON 交给 mem_transfer(import)。',
    properties: {
      'worlds.import.importDir': {
        type: 'string',
        title: '导入目录',
        description: 'QQ 导出的 .txt 放这里；子目录不递归。默认 /data/import。',
      },
      'worlds.import.scanMinutes': {
        type: 'number',
        title: '自动扫描间隔（分钟）',
        description: '0 = 关闭自动扫描，只用 chat_import(action=scan|run) 手动触发。',
        'x-hot': true,
      },
      'worlds.import.retentionDays': {
        type: 'number',
        title: '去重记录保留（天）',
        description: '超过这么多天的 .done 记录会被清理，同内容文件可重新导入。',
      },
      'worlds.import.autoRun': {
        type: 'boolean',
        title: '自动导入新文件',
        description: '扫描到没导入过的文件时自动跑一遍；关掉则只提示。',
        'x-hot': true,
      },
      'worlds.import.minMsgs': {
        type: 'number',
        title: '档案最少发言数',
        description: '聚合群友档案时的最小发言条数，默认 5。',
      },
      'worlds.import.memoryExport': {
        type: 'boolean',
        title: '生成记忆冷启动包',
        description: '导入后写一份 cortico-memory-export JSON（不直接写 memory-data.json）。',
      },
    },
  },
};
