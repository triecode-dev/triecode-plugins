/**
 * 把 MCP 服务器（含 @modelcontextprotocol/sdk + ws）打包成自包含单文件 dist/server.cjs。
 * 运行期零 npm 依赖（只依赖 Node 内置模块），随插件分发。
 *
 * 为什么 CJS：ws 内部用 `require('node:events')` 等 CJS 动态 require，
 * 若打成 ESM（format:esm）运行时会报 "Dynamic require is not supported"。
 * CJS 输出让 ws 的 require 天然可用；SDK 虽是 ESM-only，esbuild 会转成 CJS。
 *
 * 用法：node server/build.mjs
 */

import { build } from 'esbuild';
import { rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const selfDir = dirname(fileURLToPath(import.meta.url));
const outfile = resolve(selfDir, 'dist', 'server.cjs');

rmSync(resolve(selfDir, 'dist'), { recursive: true, force: true });

await build({
  entryPoints: [resolve(selfDir, 'src', 'index.mjs')],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  logLevel: 'info',
  external: [],
});

console.log(`✅ 桥已打包 → ${outfile}`);
console.log('（产物自包含：@modelcontextprotocol/sdk + ws 已内联，仅依赖 Node 内置模块）');
