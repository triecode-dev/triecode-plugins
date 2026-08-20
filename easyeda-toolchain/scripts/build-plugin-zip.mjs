/**
 * 打插件分发 zip（排除 node_modules / 扩展构建产物等 dev 内容）。
 *
 * 用法：node scripts/build-plugin-zip.mjs [输出路径]
 * 默认输出：easyeda-toolchain.zip（仓库根）
 *
 * zip 顶层直接含 plugin.json（installFromZip 接受「内容直接或单层包裹目录」）。
 */

import { readdirSync, statSync, createWriteStream } from 'node:fs';
import { join, resolve, dirname, basename, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { createRequire } from 'node:module';

const selfDir = dirname(fileURLToPath(import.meta.url));
const pluginRoot = resolve(selfDir, '..');
const require = createRequire(import.meta.url);

// node_modules 里找 jszip（若插件目录已装过依赖；否则用系统 zip）
let JSZip;
try {
  JSZip = require(require.resolve('jszip', { paths: [pluginRoot] }));
} catch {
  console.error('未找到 jszip，请先在插件目录 npm install（或 cd 插件目录后安装依赖）。');
  process.exit(1);
}

// 排除项：dev 依赖与构建中间产物。
// 运行时真正需要的只有：plugin.json / server/dist/server.cjs / docs/index.json / ui/ / assets/*.eext / extension 版权文件。
// 源码/测试/构建脚本/压缩包/package.json 都不进包（避免安装目录膨胀 + 把上一次的 zip 递归打进去）。
const IGNORE_DIRS = new Set(['node_modules', '.git']);
const IGNORE_REL_PREFIXES = [
  'extension/dist', 'extension/build', 'extension/src', 'extension/config',
  'server/src', 'server/test', 'scripts',
  // 扩展构建期文件：运行期只有 .eext（assets/）被 EDA 导入，源码/构建配置/清单不进包
  'extension/package-lock.json',
  'extension/tsconfig.json',
  'extension/package.json',
  'extension/.edaignore',
  'extension/.editorconfig',
];
// 精确排除的文件（压缩包自递归 / 构建期清单 / 桥构建脚本 / VCS 元数据）
const IGNORE_EXACT = new Set([
  'easyeda-toolchain.zip',
  'package.json',
  'package-lock.json',
  'server/build.mjs',
  '.e2e-smoke.mjs',
  '.gitignore',
]);
const IGNORE_EXT = new Set(['.tsbuildinfo']);

function shouldInclude(rel) {
  if (IGNORE_EXACT.has(rel)) return false;
  if (rel.endsWith('.zip')) return false; // 任何压缩包不进包
  const parts = rel.split(/[\\/]/);
  for (const p of parts) {
    if (IGNORE_DIRS.has(p)) return false;
  }
  for (const pre of IGNORE_REL_PREFIXES) {
    if (rel === pre || rel.startsWith(pre + '/')) return false;
  }
  return !IGNORE_EXT.has(basename(rel));
}

async function collectFiles(dir, base, out) {
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    const rel = relative(base, abs).replace(/\\/g, '/');
    if (!shouldInclude(rel)) continue;
    const st = statSync(abs);
    if (st.isDirectory()) {
      await collectFiles(abs, base, out);
    } else {
      out.push({ abs, rel });
    }
  }
}

async function main() {
  const outPath = resolve(process.argv[2] || 'easyeda-toolchain.zip');
  const files = [];
  await collectFiles(pluginRoot, pluginRoot, files);

  const zip = new JSZip();
  for (const f of files) {
    zip.file(f.rel, require('node:fs').readFileSync(f.abs));
  }

  const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 9 } });
  const dest = createWriteStream(outPath);
  dest.write(buf);
  await new Promise((res) => dest.end(res));
  console.log(`✅ 插件包已生成 → ${outPath}（${(buf.length / 1024).toFixed(0)} KB，${files.length} 个文件）`);
}

main().catch((e) => { console.error('打包失败:', e.message); process.exit(1); });
