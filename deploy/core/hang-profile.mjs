#!/usr/bin/env node
/**
 * 卡死时抓 Core 的 CPU profile（在容器内跑）。
 *
 * 用法：docker exec coopanion node /data/hang-profile.mjs [秒数] [输出文件]
 * 依赖：Core 已开 inspector（/data/logs/.inspect-on 哨兵），端口 127.0.0.1:9229。
 * 说明：V8 inspector 在独立线程上响应，主线程死循环时仍有机会打断采样；
 *       真拿不到（例如卡在原生代码）就超时退出，不阻塞自愈重启。
 */
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const seconds = Math.max(1, Math.min(30, Number(process.argv[2] || 5)));
const out = process.argv[3] || `/data/logs/hang-${Date.now()}.cpuprofile`;
const hardTimeout = setTimeout(() => {
  console.error('profile: 超时（inspector 无响应），放弃');
  process.exit(3);
}, (seconds + 20) * 1000);
hardTimeout.unref?.();

const require = createRequire('/opt/Coopanion/resources/app/');
let WebSocket;
try {
  WebSocket = require('ws');
} catch (e) {
  console.error('profile: 找不到 ws 模块', e.message);
  process.exit(2);
}

let list;
try {
  const res = await fetch('http://127.0.0.1:9229/json/list', { signal: AbortSignal.timeout(3000) });
  list = await res.json();
} catch (e) {
  console.error('profile: inspector 未开启或不可达:', e.message);
  process.exit(2);
}
const target = (list || []).find((t) => t.webSocketDebuggerUrl);
if (!target) {
  console.error('profile: 没有可用的 inspector target');
  process.exit(2);
}

const ws = new WebSocket(target.webSocketDebuggerUrl);
const pending = new Map();
let seq = 0;
const call = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
ws.on('message', (raw) => {
  let msg;
  try { msg = JSON.parse(String(raw)); } catch { return; }
  if (msg.id && pending.has(msg.id)) {
    const p = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) p.reject(new Error(msg.error.message));
    else p.resolve(msg.result);
  }
});
ws.on('error', (e) => { console.error('profile: ws 错误', e.message); });

await new Promise((resolve, reject) => {
  ws.once('open', resolve);
  ws.once('error', reject);
});
console.log(`profile: 已连接 ${target.title || target.id}，采样 ${seconds}s`);

await call('Profiler.enable');
await call('Profiler.setSamplingInterval', { interval: 500 });
await call('Profiler.start');
await new Promise((r) => setTimeout(r, seconds * 1000));
const { profile } = await call('Profiler.stop');
writeFileSync(out, JSON.stringify(profile));
console.log(`profile: 已保存 ${out}（${profile.nodes.length} 个节点，${(profile.samples || []).length} 个样本）`);
ws.close();
process.exit(0);
