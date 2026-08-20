/**
 * 立创EDA API 参考离线检索（cli，AI 也可通过 easyeda_doc_search MCP 工具调用）。
 *
 * 用法：
 *   node scripts/doc-search.mjs <docs/index.json> "<query>" [maxResults]
 */

import { loadIndex, searchIndex } from '../server/src/docsearch.mjs';

function main(argv) {
  const [indexPath, query, maxResultsRaw] = argv;
  if (!indexPath || !query) {
    console.error('用法: node doc-search.mjs <index.json> "<query>" [maxResults]');
    process.exit(2);
  }
  const maxResults = Number.isFinite(Number(maxResultsRaw)) ? Number(maxResultsRaw) : 8;

  let index;
  try {
    index = loadIndex(indexPath);
  }
  catch {
    console.error(`无法读取索引: ${indexPath}`);
    process.exit(1);
  }

  const { results, truncated, total } = searchIndex(index, query, maxResults);
  if (results.length === 0) {
    console.log(`未找到与 "${query}" 相关的 API。可尝试更短的类名前缀（如 DMT_/PCB_/SCH_/LIB_/SYS_）。`);
    return;
  }
  for (const r of results) {
    console.log(`[${r.kind}] ${r.snippet}`);
  }
  if (truncated) {
    console.log(`（还有 ${total - results.length} 条，请加关键词缩小范围）`);
  }
}

main(process.argv.slice(2));
