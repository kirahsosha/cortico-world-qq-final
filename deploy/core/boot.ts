/**
 * Entry of the Core child process (run with `--import tsx`). Registers the `cortico/*` resolver
 * of the staged Cortico copy before anything imports it, then starts `companion.ts`.
 *
 * Environment: `CORTICO_HOME` (deployments root) and `CORTICO_EXTENSIONS_DIR` (npm-installed
 * Worlds and providers, kept in the data directory so they survive app reinstalls and never write
 * into the program, which is read-only in a macOS .app) are set by the Electron main process.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const APP = fileURLToPath(new URL('../', import.meta.url));
const CORTICO = process.env.CORTICO_COMPANION_ROOT ?? join(APP, 'build', 'cortico');
if (!existsSync(join(CORTICO, 'src', 'core'))) {
  // a source checkout before staging; the message goes to the Core's log, read by whoever runs it from source
  console.error(`Cortico not found: ${CORTICO} (from source, run pnpm run build:cortico first)`);
  process.exit(2);
}
process.env.CORTICO_HOME ??= join(APP, 'build', 'home');
process.env.CORTICO_EXTENSIONS_DIR ??= join(APP, 'build', 'data', 'extensions');

/* ---------------- 事件循环卡顿观测（2026-10-25 加，用于定位 Core 卡死） ----------------
 * Core 是单线程：任何同步长活都会让 /api/worlds、日志、定时器全部停摆。
 * 这里每 1s 打点，偏差 >3s 就往 core.log 写一条 [loop-lag]；只观测、不干预。
 * 同时把未捕获异常/拒绝打完整栈（默认只打一行，不好查）。
 */
(() => {
  const started = Date.now();
  let last = Date.now();
  const timer = setInterval(() => {
    const now = Date.now();
    const drift = now - last - 1000;
    last = now;
    if (drift > 3000) {
      console.error(`[loop-lag] 事件循环阻塞约 ${drift}ms（已运行 ${Math.round((now - started) / 1000)}s）${new Date().toISOString()}`);
    }
  }, 1000);
  (timer as { unref?: () => void }).unref?.();
  process.on('unhandledRejection', (e: any) => {
    console.error('[unhandledRejection]', e?.stack ?? e);
  });
  process.on('uncaughtException', (e: any) => {
    console.error('[uncaughtException]', e?.stack ?? e);
    process.exit(1);
  });
})();

/* ---------------- 按需 inspector（2026-10-25 加） ----------------
 * /data/logs/.inspect-on 存在时开 127.0.0.1:9229；只在容器内可达。
 * 卡死时自愈脚本会先连上去抓 5s CPU profile，再重启。
 * 关掉：删除该哨兵文件后重启。
 */
if (existsSync('/data/logs/.inspect-on')) {
  try {
    const { default: inspector } = await import('node:inspector');
    inspector.open(9229, '127.0.0.1', false);
    console.error('[inspect] 已开启 127.0.0.1:9229（哨兵 /data/logs/.inspect-on 存在）');
  } catch (e) {
    console.error('[inspect] 打开失败', e);
  }
}

await import(pathToFileURL(join(CORTICO, 'src', 'extensions', 'runtime.ts')).href);
const { main } = await import('./companion.ts');
await main();
