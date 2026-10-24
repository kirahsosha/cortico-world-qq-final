/**
 * replay 7（0.6.24 基线）：收藏表情改走 /shared 真实路径
 *
 * 根因：NapCat 的 add_custom_face 只接受**本地文件路径**（stat + readFile），
 * `base64://` 会被当成路径去 stat 而报 ENAMETOOLONG。
 * 改法：图片先写到两个容器都挂载的共享目录（默认 /shared），再把真实路径交给协议端。
 *
 * 对应 tmp/qq-fav/patch.mjs（当时针对 fork 线），这里适配 0.6.24：
 *   - fs 导入可能已被 replay 1 补过 mkdirSync，按需补
 *   - 保留原文件换行风格（不整文件转 CRLF）
 *
 * 用法: node deploy/pet/replay-0624-7-fav-shared.mjs <qq世界包目录>
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const pkg = process.argv[2];
if (!pkg) { console.error('用法: node replay-0624-7-fav-shared.mjs <qq世界包目录>'); process.exit(2); }

const read = (rel) => {
  const raw = readFileSync(join(pkg, rel), 'utf8');
  return { raw, crlf: raw.includes('\r\n'), s: raw.replace(/\r\n/g, '\n') };
};
const write = (rel, out, crlf) => writeFileSync(join(pkg, rel), crlf ? out.replace(/\n/g, '\r\n') : out, 'utf8');

/* ============================ config.ts ============================ */
{
  const { s: raw, crlf } = read('src/config.ts');
  let s = raw;
  if (s.includes('sharedDir')) { console.log('config：sharedDir 已存在，跳过'); }
  else {
    const iface = `    addToQQFavorites: boolean;`;
    if (s.split(iface).length - 1 !== 1) throw new Error('interface 锚点不唯一');
    s = s.replace(iface, `${iface}
    /** 协议端（NapCat 容器）能读到的共享目录：add_custom_face 只认真实文件路径。 */
    sharedDir: string;`);

    const def = `    addToQQFavorites: false,`;
    if (s.split(def).length - 1 !== 1) throw new Error('defaults 锚点不唯一');
    s = s.replace(def, `${def}
    sharedDir: '/shared',`);

    const schema = `      'worlds.qqbot.sticker.addToQQFavorites':`;
    if (s.split(schema).length - 1 !== 1) throw new Error('schema 锚点不唯一');
    s = s.replace(schema, `      'worlds.qqbot.sticker.sharedDir': { type: 'string', title: '共享目录', 'x-hot': true, description: 'NapCat 容器也挂载了的目录（两侧路径要一致，默认 /shared）。add_custom_face 只接受真实文件路径，图片会先落到这里再把路径交给协议端。' },
${schema}`);

    const norm = `  if (typeof c.sticker.addToQQFavorites !== 'boolean') c.sticker.addToQQFavorites = false;`;
    if (s.split(norm).length - 1 !== 1) throw new Error('normalize 锚点不唯一');
    s = s.replace(norm, `${norm}
  if (typeof c.sticker.sharedDir !== 'string' || !c.sticker.sharedDir.trim()) c.sticker.sharedDir = QQ_DEFAULTS.sticker.sharedDir;`);

    write('src/config.ts', s, crlf);
    console.log('config.ts：sharedDir 已加入（接口/默认/schema/normalize）');
  }
}

/* ============================ world.ts ============================ */
{
  const { s: raw, crlf } = read('src/world.ts');
  let s = raw;
  if (s.includes('写入共享目录失败')) { console.log('world：共享目录补丁已存在，跳过'); }
  else {
    /* 1) mkdirSync 具名导入（replay 1 之后通常已补过） */
    const fsOld = "import { existsSync, readFileSync, writeFileSync, readdirSync, openSync } from 'node:fs';";
    const fsHasMkdir = "import { existsSync, readFileSync, writeFileSync, readdirSync, openSync, mkdirSync";
    if (!s.includes(fsHasMkdir)) {
      if (!s.includes(fsOld)) throw new Error('fs 导入锚点缺失（也没有 mkdirSync）');
      s = s.replace(fsOld, "import { existsSync, readFileSync, writeFileSync, readdirSync, openSync, mkdirSync } from 'node:fs';");
    }

    /* 2) 函数体：base64 -> 共享目录真实路径 */
    const from = `    const base64 = Buffer.from(bytes).toString('base64');
    try {
      const res = (await this.driver.callApi('add_custom_face', { file: \`base64://\${base64}\` })) as`;
    const to = `    // NapCat 的 add_custom_face 只认本地文件路径（stat + readFile + emojiPath 都是路径），
    // \`base64://\` 会被当成路径去 stat 而报 ENAMETOOLONG。所以先落到共享目录再传路径。
    const dir = (this.config.sticker.sharedDir || '/shared').replace(/[\\\\/]+$/, '');
    const extName = (ext || 'png').replace(/^\\./, '') || 'png';
    const file = \`\${dir}/sticker-\${Date.now().toString(36)}-\${randomBytes(3).toString('hex')}.\${extName}\`;
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(file, bytes);
    } catch (e) {
      this.log.warn('写入共享目录失败，跳过同步到 QQ 收藏表情', { dir, err: String(e) });
      return null;
    }
    try {
      const res = (await this.driver.callApi('add_custom_face', { file })) as`;
    if (s.split(from).length - 1 !== 1) throw new Error('函数体锚点不唯一');
    s = s.replace(from, to);

    const catchLine = `      this.log.warn('加入 QQ 收藏表情失败（协议端可能不支持 add_custom_face，或 QQ 收藏表情已达上限）', { err: String(e), ext });`;
    if (s.split(catchLine).length - 1 === 1) {
      s = s.replace(catchLine, `      this.log.warn('加入 QQ 收藏表情失败（协议端可能不支持 add_custom_face、共享目录没挂载，或已达上限）', { err: String(e), file });`);
    }

    write('src/world.ts', s, crlf);
    console.log('world.ts：收藏表情改为写共享目录 + 传真实路径');
  }
}
