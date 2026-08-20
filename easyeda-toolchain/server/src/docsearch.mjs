/**
 * 立创EDA API 参考离线检索核心（MCP 工具与 cli 共用）。
 * 搜索范围：类/枚举/接口/类型名 + 方法签名 + 摘要 + 枚举值；按命中分排序。
 */

import { readFileSync } from 'node:fs';

export function searchIndex(index, query, maxResults = 8) {
  const terms = String(query || '')
    .toLowerCase()
    .split(/[\s,，、;；:：()（）]+/)
    .filter((t) => t.length > 0);

  if (terms.length === 0) return { results: [], truncated: false, total: 0 };

  const results = [];

  const hitScore = (text, baseWeight) => {
    const t = (text || '').toLowerCase();
    let score = 0;
    for (const term of terms) {
      if (t === term) score += baseWeight * 3;
      else if (t.startsWith(term)) score += baseWeight * 2;
      else if (t.includes(term)) score += baseWeight;
    }
    return score;
  };

  for (const c of index.classes || []) {
    let score = hitScore(c.name, 10) + hitScore(c.summary, 1);
    let best = null; // 命中最佳方法：{ sig, doc, score }
    for (const sig of c.methods || []) {
      const s = hitScore(sig, 2);
      if (s > 0) {
        score += s;
        if (!best || s > best.score) best = { sig, score: s };
      }
    }
    // 参数搜索：只算参数名/描述命中（签名已在 methods 循环计分，避免同签名重复计分抬高类排序）
    for (const d of c.methodDocs || []) {
      let dScore = 0;
      for (const p of d.params || []) dScore += hitScore(p.name, 1) + hitScore(p.description, 0.5);
      if (dScore > 0) {
        score += dScore;
        if (!best || dScore > best.score) best = { sig: d.sig, doc: d, score: dScore };
      }
    }
    if (score > 0) {
      let snippet;
      if (best) {
        if (!best.doc) best.doc = (c.methodDocs || []).find((d) => d.sig === best.sig);
        snippet = `${c.name} · ${best.sig}`;
        if (best.doc?.params?.length) {
          snippet += `\n  参数: ${best.doc.params.slice(0, 4).map((p) => `${p.name}: ${p.description || p.type}`).join('；')}`;
        }
        if (best.doc?.beta) snippet += ' [BETA]';
      }
      else {
        snippet = `${c.name} · ${c.summary || '（无摘要）'}`;
      }
      results.push({ kind: 'class', name: c.name, snippet, score });
    }
  }
  for (const e of index.enums || []) {
    let score = hitScore(e.name, 10) + hitScore(e.summary, 1);
    let hitVal = null;
    for (const [k, v] of e.values || []) {
      if (terms.some((t) => k.toLowerCase().includes(t) || v === t)) {
        score += 5;
        hitVal = `${k}=${v}`;
      }
    }
    if (score > 0) results.push({ kind: 'enum', name: e.name, snippet: `${e.name}${hitVal ? ` · ${hitVal}` : ''} ${e.summary || ''}`.trim(), score });
  }
  for (const i of index.interfaces || []) {
    const score =
      hitScore(i.name, 10) +
      (i.methods || []).reduce((acc, sig) => acc + hitScore(sig, 2), 0) +
      hitScore(i.summary, 1);
    if (score > 0) {
      const hotMethod = (i.methods || []).find((m) => terms.some((t) => m.toLowerCase().includes(t)));
      results.push({ kind: 'interface', name: i.name, snippet: hotMethod ? `${i.name} · ${hotMethod}` : `${i.name} · ${i.summary || ''}`, score });
    }
  }
  for (const t of index.types || []) {
    const score = hitScore(t.name, 10) + hitScore(t.alias, 2) + hitScore(t.summary, 1);
    if (score > 0) results.push({ kind: 'type', name: t.name, snippet: `${t.name} · ${t.alias || t.summary || ''}`, score });
  }

  results.sort((a, b) => b.score - a.score);
  const total = results.length;
  const top = results.slice(0, maxResults);
  return {
    results: top.map(({ snippet, kind, name }) => ({ kind, name, snippet })),
    truncated: total > maxResults,
    total,
  };
}

export function loadIndex(indexPath) {
  return JSON.parse(readFileSync(indexPath, 'utf8'));
}
