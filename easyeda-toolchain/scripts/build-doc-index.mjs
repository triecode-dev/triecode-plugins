/**
 * 从立创EDA 官方 references/（markdown）抽取轻量可检索索引。
 *
 * 用法：
 *   node scripts/build-doc-index.mjs --refs <官方references目录> --out <docs/index.json>
 *
 * 输出结构：
 * {
 *   "generatedAt": "...",
 *   "sourceVersion": "1.0.3",
 *   "classes": [{ "name","module","summary","methods":[签名] }],
 *   "enums":    [{ "name","summary","values":[["PCB","3","PCB"]] }],
 *   "interfaces":[{ "name","summary","methods":[签名] }],
 *   "types":    [{ "name","summary","alias" }]
 * }
 *
 * 说明：方法签名是功能性事实（可引用）；我们不复制官方文档原文措辞，只留签名与极短摘要。
 */

import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

function unescape(s = '') {
  return s.replace(/\\_/g, '_').replace(/\\`/g, '`').replace(/\\\*/g, '*').trim();
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--refs') args.refs = argv[++i];
    else if (argv[i] === '--out') args.out = argv[++i];
  }
  return args;
}

function stripMarkdown(s = '') {
  return s
    .replace(/<[^>]+>/g, '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/#+\s*/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function readFile(p) {
  try {
    return readFileSync(p, 'utf8');
  }
  catch {
    return '';
  }
}

/** 清理参数单元：去 markdown 强调/链接/转义，压成干净文本。
 *  只在「空格/串首 + _内容_ + 空格/串尾」处剥离强调，避免误伤 ESYS_Unit 等类型里的下划线。 */
function cleanCell(s) {
  return unescape(stripMarkdown(s))
    .replace(/(^|\s)_([^_\s][^_]*?)_(?=\s|$)/g, '$1$2') // _（可选）_ → （可选）
    .replace(/(^|\s)\*([^*\s][^*]*?)\*(?=\s|$)/g, '$1$2') // *文本* → 文本
    .replace(/\s+/g, ' ')
    .trim();
}

/** 从方法节里解析「参数名」表格：<tr><td>参数</td><td>类型</td><td>描述</td></tr> */
function extractParams(section) {
  const params = [];
  const cellRe = /<tr>[\s\S]*?<td>\s*([^<]+?)\s*<\/td>\s*<td>\s*([^<]+?)\s*<\/td>\s*<td>\s*([^<]+?)\s*<\/td>\s*<\/tr>/g;
  let m;
  while ((m = cellRe.exec(section)) !== null) {
    params.push({
      name: m[1].trim(),
      type: cleanCell(m[2]).slice(0, 60),
      description: cleanCell(m[3]).slice(0, 80),
    });
  }
  return params;
}

/** 类/接口/类型 文档解析 */
function parseClassDoc(text, name) {
  const summary = stripMarkdown(text.split('## 签名')[0]?.split('\n').slice(1).join('\n')).slice(0, 160);
  // 方法详情：### name → 紧随其后的 ```typescript ... ``` 块取签名；再从「参数名」表取参数描述 + BETA 标记
  const methods = [];
  const methodDocs = [];
  // 方法详情标题形如 `### createProject`（无括号）或 `### getX(...)`
  const methodRe = /^###\s+([a-zA-Z_][a-zA-Z0-9_]*)(?:\s*\([^)]*\))?\s*$/gm;
  let m;
  while ((m = methodRe.exec(text)) !== null) {
    // 方法节 = 本 ### 到下个 ### 之间（用 indexOf 定位，避免全局正则 lastIndex 串扰）
    const start = m.index + m[0].length;
    const nextIdx = text.indexOf('\n### ', start);
    const section = nextIdx === -1 ? text.slice(start) : text.slice(start, nextIdx);
    const sigMatch = /```(?:typescript|ts|js)?\s*\n([\s\S]*?)```/.exec(section);
    let sig = sigMatch ? sigMatch[1].trim().replace(/\s+/g, ' ') : `${m[1]}(...)`;
    if (sig.length > 300) sig = `${sig.slice(0, 300)}…`;
    methods.push(sig);
    // 参数描述 + BETA（功能性接口信息；BETA 标记提醒工具层勿当稳定 API 用）
    const params = extractParams(section);
    const beta = /BETA/.test(section);
    if (params.length > 0 || beta) {
      methodDocs.push({ name: m[1], sig, params, beta });
    }
  }
  // 若方法详情没解析到（空方法类），从方法表格里抓方法名
  if (methods.length === 0) {
    const tableRe = /\[([a-zA-Z_][a-zA-Z0-9_]*)\s*\([^\]]*\)\]/g;
    let t;
    while ((t = tableRe.exec(text)) !== null) methods.push(t[1]);
  }
  const module = /^([A-Z]{1,4})_/i.exec(name)?.[1]?.toLowerCase() ?? '';
  return { name: unescape(name), module, summary, methods, methodDocs };
}

/** 枚举文档解析 */
function parseEnumDoc(text, name) {
  const summary = stripMarkdown(text.split('## 签名')[0]?.split('\n').slice(1).join('\n')).slice(0, 160);
  const values = [];
  const pairRe = /^\s*([A-Z_][A-Z0-9_]*)\s*$/gm;
  let m;
  while ((m = pairRe.exec(text)) !== null) {
    const after = text.slice(m.index + m[0].length);
    const valRe = /^\s*`(-?\d+|[^`]+)`/gm;
    valRe.lastIndex = 0;
    const v = valRe.exec(after);
    if (v) values.push([m[1], v[1]]);
  }
  // 去重保序
  const seen = new Set();
  const uniq = values.filter(([k]) => (seen.has(k) ? false : (seen.add(k), true)));
  return { name: unescape(name), summary, values: uniq.slice(0, 60) };
}

/** 类型别名文档解析 */
function parseTypeDoc(text, name) {
  const summary = stripMarkdown(text.split('## 签名')[0]?.split('\n').slice(1).join('\n')).slice(0, 160);
  const sigMatch = /```(?:typescript|ts|js)?\s*\n([\s\S]*?)```/.exec(text);
  return { name: unescape(name), summary, alias: sigMatch ? sigMatch[1].trim().replace(/\s+/g, ' ').slice(0, 200) : '' };
}

function parseDir(dir, kind) {
  const out = [];
  const files = readdirSync(dir, { withFileTypes: true });
  for (const f of files) {
    if (!f.isFile() || !f.name.endsWith('.md')) continue;
    const name = f.name.replace(/\.md$/, '').replace(/\\_/g, '_');
    const text = readFile(join(dir, f.name));
    if (kind === 'classes') out.push(parseClassDoc(text, name));
    else if (kind === 'enums') out.push(parseEnumDoc(text, name));
    else if (kind === 'interfaces') out.push(parseClassDoc(text, name));
    else if (kind === 'types') out.push(parseTypeDoc(text, name));
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function main() {
  const { refs, out } = parseArgs(process.argv.slice(2));
  if (!refs) {
    console.error('用法: node build-doc-index.mjs --refs <references目录> --out <输出.json>');
    process.exit(1);
  }
  const refDir = resolve(refs);
  const index = {
    generatedAt: new Date().toISOString(),
    classes: parseDir(join(refDir, 'classes'), 'classes'),
    enums: parseDir(join(refDir, 'enums'), 'enums'),
    interfaces: parseDir(join(refDir, 'interfaces'), 'interfaces'),
    types: parseDir(join(refDir, 'types'), 'types'),
  };
  const total = index.classes.length + index.enums.length + index.interfaces.length + index.types.length;
  if (out) {
    mkdirSync(resolve(out, '..'), { recursive: true });
    writeFileSync(resolve(out), JSON.stringify(index), 'utf8');
  }
  console.log(`索引已生成：classes=${index.classes.length}, enums=${index.enums.length}, interfaces=${index.interfaces.length}, types=${index.types.length}（共 ${total}）`);
}

main();
