import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, extname } from 'node:path';
import type { Logger } from 'cortico/core/types.ts';

/** 单张表情包的元数据（按内容 sha256 去重）。 */
export interface StickerMeta {
  /** 内容 sha256，去重主键。 */
  hash: string;
  /** 文件扩展名（含点）。 */
  ext: string;
  /** 相对表情包目录的文件名，bot 可经 [表情包:文件名] 引用发送。 */
  file: string;
  /** 来自 OneBot 的 summary（如「[表情]摸头」），空则无。 */
  summary: string;
  /** 情感标签（词表内 23 个之一，或「其他」）。 */
  emotion: string;
  /** 适用场景（谁在什么情境下会发这张图），自由文本。 */
  usage: string;
  /** 2-4 字短标签。 */
  tag: string;
  /** 给人看的短名（优先用 summary 清洗后，其次 tag）。 */
  label: string;
  firstSeen: number;
  lastSeen: number;
  /** 累计出现次数（去重后仍计数）。 */
  count: number;
  /** 出现过的会话地址列表。 */
  sources: string[];
  /** 若已加入 QQ 收藏表情（custom face），记录其 emoji_id；缺省则未同步到 QQ。 */
  emojiId?: string;
  /** 最近一次归档判定：false 表示模型判为非表情包（仅用于排查；这类不落库）。 */
  lastVerdict?: boolean;
}

/** 视觉配置（直接复用 vision 段：超时/体积上限取自这里，模型三要素由 resolveModel 决定）。 */
export interface StickerVisionCfg {
  enabled: boolean;
  endpoint: string;
  apiKeySecret: string;
  model: string;
  maxBytes: number;
  timeoutMs: number;
}

/** 模型三要素的解析结果（由 world 的 resolveHelperModel 提供，避免与群图视觉分叉）。 */
export interface StickerModelRef {
  endpoint: string;
  apiKey: string;
  model: string;
}

/** 一次标注的结果。ok=false 表示「没拿到可用的模型判断」（无密钥/请求失败/解析失败）。 */
export interface StickerAnn {
  ok: boolean;
  isSticker: boolean;
  reason: string;
  emotion: string;
  usage: string;
  tag: string;
}

/** 入库结果（供 qq_sticker_save 之类需要回执的调用方）。 */
export interface StickerIngestResult {
  status: 'stored' | 'existing' | 'rejected' | 'skipped' | 'error';
  file?: string;
  emotion?: string;
  tag?: string;
  usage?: string;
  reason?: string;
  meta?: StickerMeta;
}

interface Job {
  url: string;
  conv: string;
  summary: string;
  /** true=跳过体积/尺寸预筛（真表情段或手动收录）。 */
  force?: boolean;
}

/** 表情包可用的 23 个情感词；归一化后必须落在其中，否则一律「其他」。 */
export const STICKER_EMOTIONS = [
  '开心', '得意', '喜爱', '期待', '害羞', '赞同', '鼓励',
  '难过', '生气', '害怕', '委屈', '失望', '嫌弃', '嫉妒',
  '无语', '无奈', '疑惑', '惊讶', '震惊', '嘲讽', '敷衍', '疲惫', '撒娇',
] as const;
/** 词表外的兜底情感。 */
export const STICKER_EMOTION_OTHER = '其他';
const EMOTION_SET = new Set<string>(STICKER_EMOTIONS);

/**
 * 同义词 → 词表。归一化顺序：先精确命中词表，再按本表做「包含」匹配，最后归「其他」。
 * 键的先后有意义（越具体的越靠前），避免「没办法」被「办」之类单字误伤。
 */
const EMOTION_SYNONYMS: ReadonlyArray<readonly [string, string]> = [
  ['高兴', '开心'], ['愉快', '开心'], ['快乐', '开心'], ['喜悦', '开心'], ['兴奋', '开心'], ['惊喜', '开心'],
  ['炫耀', '得意'], ['显摆', '得意'], ['自豪', '得意'], ['嘚瑟', '得意'],
  ['喜欢', '喜爱'], ['爱了', '喜爱'], ['心动', '喜爱'],
  ['盼望', '期待'], ['等着', '期待'],
  ['羞涩', '害羞'], ['不好意思', '害羞'], ['腼腆', '害羞'],
  ['支持', '赞同'], ['同意', '赞同'], ['有道理', '赞同'], ['认可', '赞同'],
  ['加油', '鼓励'], ['打气', '鼓励'],
  ['伤心', '难过'], ['失落', '难过'], ['悲伤', '难过'], ['emo', '难过'],
  ['愤怒', '生气'], ['恼火', '生气'], ['火大', '生气'],
  ['恐惧', '害怕'], ['担心', '害怕'], ['慌', '害怕'],
  ['冤枉', '委屈'], ['吃亏', '委屈'], ['难受', '委屈'],
  ['沮丧', '失望'], ['丧', '失望'],
  ['讨厌', '嫌弃'], ['恶心', '嫌弃'], ['反感', '嫌弃'], ['看不惯', '嫌弃'],
  ['酸了', '嫉妒'], ['羡慕', '嫉妒'], ['眼红', '嫉妒'],
  ['汗', '无语'], ['沉默', '无语'], ['无言', '无语'], ['不知说什么', '无语'],
  ['没办法', '无奈'], ['认命', '无奈'], ['躺平', '无奈'],
  ['不解', '疑惑'], ['困惑', '疑惑'], ['问号', '疑惑'],
  ['吃惊', '惊讶'], ['意外', '惊讶'],
  ['震撼', '震惊'], ['惊呆', '震惊'], ['离谱', '震惊'],
  ['阴阳', '嘲讽'], ['讥讽', '嘲讽'], ['损', '嘲讽'], ['怼', '嘲讽'],
  ['冷淡', '敷衍'], ['随便', '敷衍'],
  ['累', '疲惫'], ['困', '疲惫'], ['乏', '疲惫'], ['心累', '疲惫'],
  ['卖萌', '撒娇'], ['求抱抱', '撒娇'], ['黏人', '撒娇'],
];

/**
 * 表情包标注的系统提示词（先判定「是不是表情包」，再给情感/用处/短标签）。
 * 改动此串等于换标注口径，改动后需要重标历史数据才能保持一致。
 */
export const STICKER_SYSTEM_PROMPT = [
  '你是表情包分析助手。先判断这张图是不是「表情包/梗图」：表情包通常是小尺寸、夸张表情或动漫/动物形象，用来表达情绪；聊天截图、界面截图、照片、商品图、文档截图都不算。',
  '严格只输出一个 JSON：',
  '{"is_sticker":true/false,"reason":"不是表情包时说明它是什么（8字以内）",' +
    '"emotion":"从下列词表里选一个最贴切的：' + STICKER_EMOTIONS.join('/') + '/' + STICKER_EMOTION_OTHER + '",' +
    '"usage":"用8-25字描述谁在什么情境下会发这张图，要具体可复用；不要用斜杠或顿号罗列多个标签，不要重复 emotion 的词",' +
    '"tag":"2-4个汉字描述画面主体或动作，不含标点和英文，想不出就留空"}。',
  '判断要点：无语=接不上话；无奈=没办法；震惊=强烈意外；惊讶=普通意外；嘲讽=阴阳怪气；敷衍=不想接话。',
  '只输出 JSON，不要别的话。',
].join('\n');

/** 情感归一：词表精确命中 → 同义词包含匹配 → 「其他」。 */
export function normalizeEmotion(raw: unknown): string {
  const s = String(raw ?? '').trim();
  if (!s) return STICKER_EMOTION_OTHER;
  if (EMOTION_SET.has(s)) return s;
  for (const [k, v] of EMOTION_SYNONYMS) if (s.includes(k)) return v;
  return STICKER_EMOTION_OTHER;
}

/** 短标签归一：必须是 2-4 个汉字，含标点/英文/数字/空白一律置空。 */
export function normalizeTag(raw: unknown): string {
  const s = String(raw ?? '').trim();
  if (!s) return '';
  const chars = [...s];
  if (chars.length < 2 || chars.length > 4) return '';
  if (!/^[\p{Script=Han}]+$/u.test(s)) return '';
  return s;
}

/** 用处归一：保留自由文本，只做空白压缩与长度截断。 */
export function normalizeUsage(raw: unknown, max = 40): string {
  const s = String(raw ?? '').replace(/\s+/g, ' ').trim();
  return s.slice(0, max);
}

/** 按扩展名取 MIME（送给 VLM 的 data URL 用真实格式，别一律谎报 jpeg）。 */
function mimeOfExt(ext: string): string {
  switch (ext.toLowerCase()) {
    case '.png': return 'image/png';
    case '.gif': return 'image/gif';
    case '.webp': return 'image/webp';
    case '.bmp': return 'image/bmp';
    default: return 'image/jpeg';
  }
}

/** 图片宽高（像素）。 */
export interface ImageDim {
  w: number;
  h: number;
}

const be16 = (b: Uint8Array, o: number) => (b[o] << 8) | b[o + 1];
const le16 = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);
const be32 = (b: Uint8Array, o: number) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const le32 = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

/**
 * 零依赖读图片宽高：PNG（IHDR）/ GIF（逻辑屏描述符）/ JPEG（SOFn）/ WEBP（VP8X/VP8L/VP8）/ BMP。
 * 读不出（格式怪异、截断）返回 null——调用方按「不拦」处理，别把不懂的格式误杀。
 */
export function imageDim(bytes: Uint8Array): ImageDim | null {
  if (bytes.length < 26) return null;
  // PNG：89 50 4E 47 0D 0A 1A 0A，IHDR 宽高在 16/20（大端 u32）
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return { w: be32(bytes, 16), h: be32(bytes, 20) };
  }
  // GIF87a / GIF89a：逻辑屏描述符宽高在 6/8（小端 u16）
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
    return { w: le16(bytes, 6), h: le16(bytes, 8) };
  }
  // BMP：BITMAPINFOHEADER 宽高在 18/22（小端 i32，高可为负）
  if (bytes[0] === 0x42 && bytes[1] === 0x4d) {
    return { w: Math.abs(le32(bytes, 18) | 0), h: Math.abs(le32(bytes, 22) | 0) };
  }
  // WEBP：RIFF....WEBP + 具体块
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
    && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
    const fmt = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]);
    if (fmt === 'VP8X') {
      return {
        w: 1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16)),
        h: 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16)),
      };
    }
    if (fmt === 'VP8L') {
      const b0 = bytes[21], b1 = bytes[22], b2 = bytes[23], b3 = bytes[24];
      return {
        w: 1 + (((b1 & 0x3f) << 8) | b0),
        h: 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)),
      };
    }
    if (fmt === 'VP8 ') {
      return { w: le16(bytes, 26) & 0x3fff, h: le16(bytes, 28) & 0x3fff };
    }
    return null;
  }
  // JPEG：逐段扫 SOFn（C0-CF 除 C4/C8/CC），高在 +5、宽在 +7（大端 u16）
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let i = 2;
    while (i + 9 < bytes.length) {
      if (bytes[i] !== 0xff) { i++; continue; }
      const m = bytes[i + 1];
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
        return { h: be16(bytes, i + 5), w: be16(bytes, i + 7) };
      }
      const len = be16(bytes, i + 2);
      if (len < 2) break;
      i += 2 + len;
    }
    return null;
  }
  return null;
}

/** 尺寸/体积预筛阈值（面板暂未暴露，改 config.json 的 worlds.qqbot.sticker.* 即可）。 */
export interface StickerLimits {
  /** PNG/JPG 体积上限（KB）。 */
  maxKBJpg: number;
  /** GIF 体积上限（KB）——动画表情天然偏大，放宽。 */
  maxKBGif: number;
  /** 长边上限（像素）。 */
  maxEdge: number;
  /** 长宽比下限（宽/高，竖图 <1）。 */
  minRatio: number;
  /** 长宽比上限。 */
  maxRatio: number;
}

/** 预筛默认值：表情包通常体积小、近似方形；聊天/界面截图与照片通常又大又长。 */
export const DEFAULT_LIMITS: StickerLimits = {
  maxKBJpg: 800,
  maxKBGif: 3072,
  maxEdge: 1024,
  minRatio: 0.5,
  maxRatio: 2.0,
};

/**
 * 标注前的尺寸/体积预筛（省钱：明显不是表情包的大图不送视觉）。
 * @returns null=通过；字符串=丢弃原因（直接写日志）
 */
export function screenImage(bytes: Uint8Array, ext: string, cfg?: Partial<StickerLimits>): string | null {
  const l: StickerLimits = { ...DEFAULT_LIMITS, ...(cfg ?? {}) };
  const isGif = /\.gif$/i.test(ext) || (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46);
  const capKB = isGif ? l.maxKBGif : l.maxKBJpg;
  const kb = bytes.byteLength / 1024;
  if (capKB > 0 && kb > capKB) return `体积超限 ${Math.round(kb)}KB>${capKB}KB`;
  const dim = imageDim(bytes);
  if (!dim || !dim.w || !dim.h) return null;
  const edge = Math.max(dim.w, dim.h);
  if (l.maxEdge > 0 && edge > l.maxEdge) return `长边超限 ${dim.w}x${dim.h}>${l.maxEdge}px`;
  const ratio = dim.w / dim.h;
  if (l.minRatio > 0 && ratio < l.minRatio) return `长宽比异常 ${dim.w}x${dim.h}(${ratio.toFixed(2)}<${l.minRatio})`;
  if (l.maxRatio > 0 && ratio > l.maxRatio) return `长宽比异常 ${dim.w}x${dim.h}(${ratio.toFixed(2)}>${l.maxRatio})`;
  return null;
}

/** 熔断时长：连续 3 次标注失败后静默 10 分钟（视觉端点挂掉时不再烧 token/刷日志）。 */
const DEGRADE_MS = 10 * 60 * 1000;
/** 连续失败多少次触发熔断。 */
const DEGRADE_AFTER = 3;

/**
 * 表情包自动收藏：下载 + 内容级去重（sha256）+ 是否表情包的判定 + 情感/用处标注 + 持久化。
 *
 * - 仅当 sticker.enabled 时启用（world 在消息循环里判定表情段后调用 ingest）。
 * - 去重：相同内容只落盘一次，重复出现仅累加 count / 刷新 lastSeen / 记录来源。
 * - **先标注、后落盘**：模型判定「不是表情包」或拿不到判断时，不写文件、不入库、不推 QQ 收藏。
 * - 连续 3 次失败熔断 10 分钟，期间直接丢弃（避免视觉端点故障时无限重试）。
 * - 元数据持久化到 <dataDir>/sticker-index.json，跨重启仍生效。
 */
export class StickerStore {
  private readonly dir: string;
  private readonly vision: StickerVisionCfg;
  private readonly log: Logger;
  private readonly indexFile: string;
  private readonly meta = new Map<string, StickerMeta>();
  private inflight = 0;
  private readonly queue: Job[] = [];
  private saveTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly secret?: (name: string) => string;
  /** 统一的模型三要素解析（world.resolveHelperModel）。返回 null 表示未配置/取不到密钥。 */
  private readonly resolveModel?: () => StickerModelRef | null;
  private readonly reportUsage?: (usage: {
    promptTokens: number;
    completionTokens: number;
    cacheHitTokens: number;
    cacheMissTokens: number;
  }, model: string) => void;
  /** 把一张表情图加入 QQ 收藏表情（custom face）的回调，由 world 注入；返回 emoji_id 或 null。 */
  private readonly addToFavoritesCb?: (bytes: Uint8Array, ext: string) => Promise<string | null>;
  /** 连续标注失败次数。 */
  private failures = 0;
  /** 熔断截止时间戳（毫秒）；大于当前时间即处于熔断期。 */
  private degradedUntil = 0;
  /** 缺视觉时只告警一次，避免每张图都刷一条 warn。 */
  private warnedNoVision = false;
  /** 尺寸/体积预筛阈值（world.start 里用配置覆盖）。 */
  private limits: StickerLimits = { ...DEFAULT_LIMITS };

  constructor(
    dir: string,
    vision: StickerVisionCfg,
    log: Logger,
    dataDir = '',
    /** 部署级密钥读取器（框架 WorldContext.secret）。不得自行扫 providers 下的 .env。 */
    secret?: (name: string) => string,
    /** 用量上报（宿主 WorldHost.reportUsage）。 */
    reportUsage?: (usage: {
      promptTokens: number;
      completionTokens: number;
      cacheHitTokens: number;
      cacheMissTokens: number;
    }, model: string) => void,
    /** 把一张表情图加入 QQ 收藏表情（custom face）的回调，由 world 注入；返回 emoji_id 或 null。 */
    addToFavorites?: (bytes: Uint8Array, ext: string) => Promise<string | null>,
    /** 统一模型解析器（可选）：给定时优先用它，避免表情标注与群图视觉各走一套配置。 */
    resolveModel?: () => StickerModelRef | null,
  ) {
    this.dir = dir;
    this.vision = vision;
    this.log = log.child('sticker');
    this.secret = secret;
    this.reportUsage = reportUsage;
    this.addToFavoritesCb = addToFavorites;
    this.resolveModel = resolveModel;
    this.indexFile = dataDir ? join(dataDir, 'sticker-index.json') : '';
    this.load();
    this.log.info(`StickerStore init indexFile=${this.indexFile} emojiDir=${this.dir} loaded=${this.meta.size}`);
    try {
      if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
    } catch {
      this.log.warn('无法创建表情包目录', { dir: this.dir });
    }
  }

  get size(): number {
    return this.meta.size;
  }

  /** 覆盖预筛阈值（world.start 里按 config.sticker.* 传入；缺项走默认值）。 */
  setLimits(limits?: Partial<StickerLimits>): void {
    this.limits = { ...DEFAULT_LIMITS, ...(limits ?? {}) };
  }

  /** 消息里检测到表情包时调用（异步、不阻塞事件循环）。 */
  ingest(url: string, conv: string, summary: string, opts: { force?: boolean } = {}): void {
    if (this.queue.length > 300) {
      this.log.warn('表情包队列已满，丢弃一条', { url });
      return;
    }
    this.queue.push({ url, conv, summary, force: opts.force === true });
    this.pump();
  }

  /**
   * 同步收录一张图并等结果（供 qq_sticker_save 手动收录使用）。
   * 绕过队列/体积预筛，但仍然必须标注成功才落库。
   */
  async saveNow(url: string, conv: string, summary: string, opts: { force?: boolean } = {}): Promise<StickerIngestResult> {
    return await this.processCore({ url, conv, summary, force: opts.force !== false });
  }

  /** 立即落盘（stop 时调用）。 */
  flush(): void {
    this.save();
  }

  /** 统计 + 最近列表，供 qq_sticker_stats 工具与控制台自查。 */
  stats(limit = 10): { total: number; byEmotion: Record<string, number>; synced: number; recent: StickerMeta[] } {
    const byEmotion: Record<string, number> = {};
    let synced = 0;
    for (const m of this.meta.values()) {
      byEmotion[m.emotion] = (byEmotion[m.emotion] ?? 0) + 1;
      if (m.emojiId) synced++;
    }
    const recent = [...this.meta.values()]
      .sort((a, b) => b.lastSeen - a.lastSeen)
      .slice(0, limit);
    return { total: this.meta.size, byEmotion, synced, recent };
  }

  /**
   * 随机抽 n 张（优先有 emotion/tag 的），供提示词里列出「可用表情包」。
   * 库里为空时返回空数组。
   */
  sample(n = 8): StickerMeta[] {
    const all = [...this.meta.values()];
    if (!all.length) return [];
    // Fisher–Yates 部分洗牌，避免每次都把同一批放前面
    for (let i = all.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const t = all[i]; all[i] = all[j]; all[j] = t;
    }
    return all.slice(0, Math.max(1, n));
  }

  /**
   * 把尚未加入 QQ 收藏表情的条目（无 emojiId）批量补推到 QQ「收藏表情」。
   * 用于开启开关前已攒下的历史表情一次性刷进 QQ。返回各计数。
   * 无回调（未接线）时所有条目记到 skipped，不报错。
   */
  async favoriteSync(max = 50): Promise<{ checked: number; added: number; failed: number; skipped: number }> {
    const r = { checked: 0, added: 0, failed: 0, skipped: 0 };
    if (!this.addToFavoritesCb) {
      r.skipped = this.meta.size;
      return r;
    }
    let n = 0;
    for (const m of this.meta.values()) {
      if (n >= max) break;
      if (m.emojiId) continue; // 已同步过
      r.checked++;
      n++;
      try {
        const buf = readFileSync(join(this.dir, m.file));
        const eid = await this.addToFavoritesCb(buf, m.ext);
        if (eid) {
          m.emojiId = eid;
          r.added++;
        } else {
          r.failed++;
        }
      } catch {
        r.failed++;
      }
    }
    if (r.added) this.save();
    return r;
  }

  /**
   * 按文件名定位一张表情包，返回其元数据（找不到返回 null）。
   * file 也接受 [表情包:xxx.jpg] 写法或省略扩展名的形式。
   */
  find(file: string): StickerMeta | null {
    let key = (file || '').trim();
    key = key.replace(/^\[表情包:/i, '').replace(/\]$/, '').trim();
    if (!key) return null;
    const want = key.toLowerCase();
    return [...this.meta.values()].find((x) => {
      const f = x.file.toLowerCase();
      return f === want || f.replace(/\.[^.]+$/, '') === want.replace(/\.[^.]+$/, '');
    }) ?? null;
  }

  /**
   * 删除一张表情包：删文件 + 从索引移除 + 落盘。
   * 只删本机文件，不撤回已推送到 QQ 收藏表情的那一份（NapCat 没有删除 custom face 的接口）。
   */
  remove(file: string): { ok: boolean; file: string; deletedFile: boolean; removedFromIndex: boolean } {
    const m = this.find(file);
    if (!m) return { ok: false, file, deletedFile: false, removedFromIndex: false };
    let deletedFile = false;
    try {
      unlinkSync(join(this.dir, m.file));
      deletedFile = true;
    } catch {
      /* 文件已不在也算删索引成功 */
    }
    this.meta.delete(m.hash);
    this.save();
    return { ok: true, file: m.file, deletedFile, removedFromIndex: true };
  }

  /**
   * 按文件名定位一张表情包并更新其标注字段（emotion/usage/tag/label），随后调度落盘。
   * 这是除收货标注外唯一的写回通道，供 qq_sticker_tag 工具让 bot 自己修正/补充标注。
   * 找不到返回 null。
   */
  updateMeta(
    file: string,
    patch: { emotion?: string; usage?: string; tag?: string; label?: string },
  ): StickerMeta | null {
    const m = this.find(file);
    if (!m) return null;
    const clean = (s?: string) => (typeof s === 'string' ? s.trim().slice(0, 40) : '');
    const emo = clean(patch.emotion);
    const uso = clean(patch.usage);
    const tg = clean(patch.tag);
    const lb = clean(patch.label);
    if (emo) m.emotion = normalizeEmotion(emo);
    if (uso) m.usage = uso;
    const ntg = normalizeTag(tg);
    if (ntg) m.tag = ntg;
    if (lb) m.label = lb;
    this.scheduleSave();
    return m;
  }

  private pump(): void {
    if (this.inflight >= 4) return;
    const job = this.queue.shift();
    if (!job) return;
    this.inflight++;
    void this.process(job).finally(() => {
      this.inflight--;
      this.pump();
    });
  }

  private async process(job: Job): Promise<void> {
    const r = await this.processCore(job);
    // 注意：本项目的 logger 在 INFO 级别只输出正文，第二个参数（对象）不会打印，
    // 所以关键字段一律拼进正文，否则日志里只剩一句「表情包已收藏」没法核对。
    if (r.status === 'stored') {
      this.log.info(`表情包已收藏 file=${r.file} emotion=${r.emotion} tag=${r.tag || '-'} force=${job.force === true} usage=${r.usage || '-'}`);
    } else if (r.status === 'rejected') {
      this.log.info(`表情包未收录 reason=${r.reason || 'not-sticker'} summary=${JSON.stringify(job.summary || '')} url=${(job.url || '').slice(0, 70)}`);
    } else if (r.status === 'skipped') {
      this.log.info(`表情包跳过 reason=${r.reason || 'skipped'} url=${(job.url || '').slice(0, 70)}`);
    } else if (r.status === 'error') {
      this.log.warn('表情包处理失败', { err: r.reason ?? 'unknown', url: job.url });
    }
  }

  /**
   * 入库主流程：下载 → 去重 → 熔断检查 → 标注（判定是否表情包）→ 落盘 → 入库 → 推 QQ 收藏。
   * 判定不通过时**不写文件、不入库、不推 QQ**（这是 TODO-11 的核心修正）。
   */
  private async processCore(job: Job): Promise<StickerIngestResult> {
    try {
      const bytes = await this.fetchBytes(job.url);
      if (!bytes) return { status: 'error', reason: 'fetch-failed' };
      const hash = createHash('sha256').update(bytes).digest('hex');

      // 去重：已存在则只更新计数/来源，不重复落盘
      const existing = this.meta.get(hash);
      if (existing) {
        existing.count++;
        existing.lastSeen = Date.now();
        if (job.summary && !existing.summary) existing.summary = job.summary;
        if (!existing.sources.includes(job.conv)) existing.sources.push(job.conv);
        this.scheduleSave();
        return { status: 'existing', file: existing.file, emotion: existing.emotion, tag: existing.tag, meta: existing };
      }

      // 熔断期：直接丢弃（视觉端点故障时不再无意义地烧钱）
      if (Date.now() < this.degradedUntil) {
        const left = Math.ceil((this.degradedUntil - Date.now()) / 60000);
        this.log.info(`熔断期，丢弃 minutesLeft=${left} url=${(job.url || '').slice(0, 70)}`);
        return { status: 'skipped', reason: 'degraded' };
      }
      if (!this.vision.enabled) {
        this.log.info(`表情包未收录 reason=vision-disabled url=${(job.url || '').slice(0, 70)}`);
        return { status: 'rejected', reason: 'vision-disabled' };
      }

      const ext = this.extOf(job.url, bytes);
      // 预筛（标注前，省钱）：明显的截图/照片/大图直接丢，不送视觉。
      // 真表情段与手动收录（force）跳过限制——动画贴纸确实可能 2 MB+。
      if (!job.force) {
        const why = screenImage(bytes, ext, this.limits);
        if (why) {
          this.log.info(`表情包预筛丢弃 reason=${why} summary=${JSON.stringify(job.summary || '')}`);
          return { status: 'skipped', reason: `prefilter:${why}` };
        }
      }

      const ann = await this.annotate(bytes, mimeOfExt(ext));
      if (!ann.ok || !ann.isSticker) {
        this.failures++;
        if (this.failures >= DEGRADE_AFTER) {
          this.degradedUntil = Date.now() + DEGRADE_MS;
          this.failures = 0;
          this.log.warn('熔断 10 分钟', {
            reason: ann.reason || 'not-sticker',
            degradedUntil: new Date(this.degradedUntil).toISOString(),
          });
        }
        return { status: 'rejected', reason: ann.reason || 'not-sticker' };
      }
      this.failures = 0;

      // 标注成功才落盘
      const file = `sticker-${hash.slice(0, 16)}${ext}`;
      writeFileSync(join(this.dir, file), bytes);

      const label = this.cleanSummary(job.summary) || ann.tag || (ann.emotion !== STICKER_EMOTION_OTHER ? ann.emotion : '') || '表情包';
      const meta: StickerMeta = {
        hash,
        ext,
        file,
        summary: job.summary || '',
        emotion: ann.emotion,
        usage: ann.usage,
        tag: ann.tag,
        label,
        firstSeen: Date.now(),
        lastSeen: Date.now(),
        count: 1,
        sources: [job.conv],
        lastVerdict: true,
      };
      this.meta.set(hash, meta);
      // 若开启了「同步到 QQ 收藏表情」，把同一张图加入 QQ 的 custom face（收藏表情），
      // 返回的 emoji_id 记进元数据，便于在 QQ 客户端里直接看到/使用。失败仅告警，不影响本机收藏。
      if (this.addToFavoritesCb) {
        try {
          const eid = await this.addToFavoritesCb(bytes, ext);
          if (eid) {
            meta.emojiId = eid;
            this.log.info(`表情包已加入 QQ 收藏表情 file=${file} emojiId=${eid}`);
          }
        } catch (e) {
          this.log.warn('加入 QQ 收藏表情回调异常（已忽略，仍按本机收藏处理）', { err: String(e), file });
        }
      }
      this.scheduleSave();
      return { status: 'stored', file, emotion: ann.emotion, tag: ann.tag, usage: ann.usage, meta };
    } catch (e) {
      return { status: 'error', reason: String(e) };
    }
  }

  /** 解析实际该用的模型三要素：优先 world 注入的统一 resolver，退化到本类自己的 secret + vision 配置。 */
  private modelRef(): StickerModelRef | null {
    if (this.resolveModel) {
      try {
        const m = this.resolveModel();
        if (m && m.endpoint && m.apiKey && m.model) return m;
      } catch { /* 落到下面的退化路径 */ }
    }
    let apiKey = '';
    try {
      apiKey = this.secret?.(this.vision.apiKeySecret)?.trim() || '';
    } catch { /* 密钥解析失败按无 key 处理 */ }
    const endpoint = (this.vision.endpoint || '').trim().replace(/\/+$/, '');
    const model = (this.vision.model || '').trim();
    if (!apiKey || !endpoint || !model) return null;
    return { endpoint, apiKey, model };
  }

  /** 用 VLM 判定「是不是表情包」并结构化标注情感/用处/短标签。 */
  private async annotate(bytes: Uint8Array, mime: string): Promise<StickerAnn> {
    const bad = (reason: string): StickerAnn => ({
      ok: false, isSticker: false, reason,
      emotion: STICKER_EMOTION_OTHER, usage: '', tag: '',
    });
    const ref = this.modelRef();
    if (!ref) {
      if (!this.warnedNoVision) {
        this.warnedNoVision = true;
        this.log.warn('视觉不可用（模型地址/密钥名/模型名缺失或取不到密钥），表情包不会再入库');
      }
      return bad('vision-unavailable');
    }
    const base64 = Buffer.from(bytes).toString('base64');
    const ctrl = new AbortController();
    const timeoutMs = this.timeoutMs();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(`${ref.endpoint}/chat/completions`, {
        method: 'POST',
        signal: ctrl.signal,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${ref.apiKey}` },
        body: JSON.stringify({
          model: ref.model,
          temperature: 0.2,
          messages: [
            { role: 'system', content: STICKER_SYSTEM_PROMPT },
            {
              role: 'user',
              content: [
                { type: 'text', text: '分析这个表情包。' },
                { type: 'image_url', image_url: { url: `data:${mime};base64,${base64}` } },
              ],
            },
          ],
        }),
      });
      if (!res.ok) {
        this.log.warn('视觉标注请求失败', { status: res.status, endpoint: ref.endpoint, model: ref.model });
        return bad(`http-${res.status}`);
      }
      const json = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      this.reportUsage?.({
        promptTokens: json.usage?.prompt_tokens ?? 0,
        completionTokens: json.usage?.completion_tokens ?? 0,
        cacheHitTokens: 0,
        cacheMissTokens: 0,
      }, ref.model);
      return this.parseAnn(json.choices?.[0]?.message?.content?.trim(), ref.model);
    } catch (e) {
      this.log.warn('视觉标注异常', { err: String(e), model: ref.model });
      return bad('vision-error');
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 解析模型返回：`{ok}` 表示拿到了可用判断，`{isSticker}` 是它对着张图的判定。
   * emotion/tag/usage 在这里就做归一，保证入库数据永远是可枚举的干净值。
   */
  private parseAnn(text: string | undefined, model = ''): StickerAnn {
    const bad = (reason: string): StickerAnn => ({
      ok: false, isSticker: false, reason,
      emotion: STICKER_EMOTION_OTHER, usage: '', tag: '',
    });
    if (!text) return bad('empty');
    let o: Record<string, unknown> | null = null;
    try {
      const m = text.match(/\{[\s\S]*\}/);
      o = m ? (JSON.parse(m[0]) as Record<string, unknown>) : null;
    } catch {
      o = null;
    }
    if (!o) {
      this.log.warn('标注返回不是合法 JSON', { model, head: text.slice(0, 120) });
      return bad('parse');
    }
    const rawFlag = o.is_sticker;
    const isSticker = rawFlag === true || rawFlag === 1 || rawFlag === 'true' || rawFlag === '是';
    return {
      ok: true,
      isSticker,
      reason: String(o.reason ?? '').replace(/\s+/g, ' ').trim().slice(0, 20),
      emotion: normalizeEmotion(o.emotion),
      usage: normalizeUsage(o.usage),
      tag: normalizeTag(o.tag),
    };
  }

  private extOf(url: string, bytes: Uint8Array): string {
    const u = url.split('?')[0];
    const e = extname(u).toLowerCase();
    if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'].includes(e)) return e;
    if (bytes[0] === 0xff && bytes[1] === 0xd8) return '.jpg';
    if (bytes[0] === 0x89 && bytes[1] === 0x50) return '.png';
    if (bytes[0] === 0x47 && bytes[1] === 0x49) return '.gif';
    if (bytes.length >= 12 && bytes.slice(0, 4).toString('hex') === '52494646') return '.webp';
    return '.img';
  }

  private cleanSummary(s: string): string {
    return (s || '')
      .replace(/^\[表情\]/i, '')
      .replace(/^\[emoji\]/i, '')
      .replace(/^\[(图片|动画表情|表情)\]$/, '')
      .trim();
  }

  private timeoutMs(): number {
    const t = Number(this.vision.timeoutMs);
    return Number.isFinite(t) && t > 0 ? t : 30_000;
  }

  private async fetchBytes(url: string): Promise<Uint8Array | null> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs());
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      if (!res.ok) return null;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.byteLength > this.vision.maxBytes) return null;
      return buf;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  private load(): void {
    if (!this.indexFile || !existsSync(this.indexFile)) return;
    try {
      const raw = JSON.parse(readFileSync(this.indexFile, 'utf8')) as Record<string, StickerMeta>;
      for (const [k, v] of Object.entries(raw)) if (k === v.hash) this.meta.set(k, v);
    } catch {
      this.log.warn('表情包索引损坏，忽略', { file: this.indexFile });
    }
  }

  private scheduleSave(): void {
    if (!this.indexFile || this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      this.save();
    }, 2000);
  }

  private save(): void {
    if (!this.indexFile) return;
    try {
      mkdirSync(dirname(this.indexFile), { recursive: true });
      writeFileSync(this.indexFile, JSON.stringify(Object.fromEntries(this.meta)), 'utf8');
    } catch {
      this.log.warn('表情包索引写入失败', { file: this.indexFile });
    }
  }
}
