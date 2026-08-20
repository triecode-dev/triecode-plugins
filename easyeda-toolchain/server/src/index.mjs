/**
 * 立创EDA(EasyEDA) MCP 服务器入口 —— TrieCode 插件核心进程
 *
 * 一个进程两头说话：
 *  - stdio ⇄ TrieCode（MCP JSON-RPC）→ 注册 easyeda_* 工具
 *  - 127.0.0.1 WebSocket ⇄ 立创EDA 扩展（triecode-easyeda-gateway）
 *
 * 用法：node server.cjs [--port <n>] [--port-range <start>-<end>] [--token <t>] [--docs <index.json>]
 *
 * 注意：@modelcontextprotocol/sdk 1.30 的 registerTool(name, config, cb) 是 3 参，
 * inputSchema 要放进 config；不要把 schema 当 cb 传。
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod/v3';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Bridge, SERVICE_ID } from './bridge.mjs';
import { Units } from './units.mjs';
import { loadIndex, searchIndex } from './docsearch.mjs';
import { normBBoxMinMax, estimateComponentBox } from './layout/bbox.mjs';
import { lintLayout, classifyComponent } from './layout/lint.mjs';
import { planLayout } from './layout/planner.mjs';
import { parseLayoutIntent, layoutIntentSchema } from './layout/intent.mjs';
import { routeWire, polylineHitsObstacles, steinerTree } from './layout/router.mjs';
import { attachPinNetsFromNetlist } from './layout/netlist.mjs';

// 兼容两种运行形态：
//  - CJS bundle（server/dist/server.cjs）→ __dirname 可用
//  - 源码 ESM 直跑（node src/index.mjs）→ 回退 import.meta.url
const SELF_DIR = typeof __dirname === 'string' ? __dirname : dirname(fileURLToPath(import.meta.url));

// ─── 参数解析 ────────────────────────────────────────────────
function parseArgs(argv) {
  const args = { portRange: [49620, 49629] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port' && argv[i + 1]) args.port = Number(argv[i + 1]);
    else if (a === '--port-range' && argv[i + 1]) {
      const [s, e] = argv[i + 1].split('-').map(Number);
      if (Number.isFinite(s) && Number.isFinite(e) && s <= e) args.portRange = [s, e];
    }
    else if (a === '--token' && argv[i + 1]) args.token = argv[i + 1];
    else if (a === '--docs' && argv[i + 1]) args.docs = argv[i + 1];
  }
  if (!args.token && process.env.EASYEDA_TOKEN) args.token = process.env.EASYEDA_TOKEN;
  return args;
}

// ─── 文档索引 ────────────────────────────────────────────────
function resolveDocIndex(explicit) {
  const candidates = [
    explicit,
    process.env.EASYEDA_DOCS,
    join(SELF_DIR, '..', 'docs', 'index.json'), // server/dist/server.cjs → 插件根/docs
    join(SELF_DIR, 'docs', 'index.json'), // server/src/index.mjs（dev 直跑）
  ].filter(Boolean);
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

// ─── 常量与工具函数 ──────────────────────────────────────────
const DOC_TYPES = {
  '-1': 'HOME', '0': 'BLANK', '1': 'SCHEMATIC_PAGE', '2': 'SYMBOL_COMPONENT',
  '3': 'PCB', '4': 'FOOTPRINT', '26': 'PANEL',
};
function typeName(t) {
  return DOC_TYPES[String(t)] ?? (typeof t === 'number' ? `UNKNOWN(${t})` : String(t));
}

const J = JSON.stringify;

// ─── 原理图数据读取（布局/验证共用，一次 execute 读齐：组件+bbox+引脚+网络+页面）───
const READ_SCHEMATIC_CODE = [
  'const comps = await eda.sch_PrimitiveComponent.getAll();',
  'const out = [];',
  'for (const c of comps) {',
  '  let bb = null;',
  '  try { bb = await eda.sch_Primitive.getPrimitivesBBox([c.primitiveId]); } catch {}',
  '  let net = null;',
  '  try { net = c.getState_Net ? c.getState_Net() : null; } catch {}',
  '  let uid = null;',
  '  try { uid = c.getState_UniqueId ? c.getState_UniqueId() : (c.uniqueId || null); } catch {}',
  '  let pins = [];',
  '  try { pins = ((await eda.sch_PrimitiveComponent.getAllPinsByPrimitiveId(c.primitiveId)) || []).map(p => ({ number: p.pinNumber, name: p.pinName, x: p.x, y: p.y })); } catch {}',
  '  out.push({ id: c.primitiveId, uniqueId: uid, designator: c.designator, name: c.name, x: c.x, y: c.y, rotation: c.rotation, net, bbox: bb, pins });',
  '}',
  'let page = null;',
  'try { const p = await eda.dmt_Schematic.getCurrentSchematicPageInfo(); if (p && p.titleBlockData) { const w = Object.entries(p.titleBlockData).find(([k]) => k.toLowerCase() === "width"); const h = Object.entries(p.titleBlockData).find(([k]) => k.toLowerCase() === "height"); page = { w: Number(w?.[1]?.value ?? 1200), h: Number(h?.[1]?.value ?? 800) }; } } catch {}',
  'let netlistRaw = null;',
  'try { const f = await eda.sch_ManufactureData.getNetlistFile("netlist.json"); netlistRaw = f ? await f.text() : null; } catch {}',
  'return { components: out, page, netlistRaw };',
].join('\n');


/** 归一化原始 bbox（min<max 保证）供布局引擎用 */
function normalizeCompsForPlan(raw) {
  return (raw || []).map((c) => ({ ...c, bbox: normBBoxMinMax(c.bbox) }));
}

/**
 * 页面矩形归一化到 sch 单位（0.01 inch）。
 * EasyEDA 画布单位是 inch，A4 图纸 = 11.7 × 8.25 inch；titleBlockData 的 width/height
 * 可能为 inch（11.7）/ mm（297）/ 已是 sch（1170）三态 → 按值域识别：
 *   v < 60   → inch（×100，1 inch = 100 sch）
 *   60≤v<600 → mm（/0.254）
 *   v ≥ 600  → 已是 sch，保留
 * 三种解释对标准图纸都归一到 ~1170×825 sch，杜绝「迷你页面全越界」。
 * 可用区再内缩刃带宽（0.1 inch = 10 sch），元器件不压图框。
 */
function normalizeSheetRect(page) {
  if (!page) return null;
  const toSch = (v) => {
    if (v < 60) return v * 100;        // inch → sch
    if (v < 600) return Units.round(v / 0.254); // mm → sch
    return v;                           // 已是 sch
  };
  const w = toSch(page.w);
  const h = toSch(page.h);
  const EDGE_BAND = 10; // 0.1 inch 图框边带
  return { x: EDGE_BAND, y: EDGE_BAND, w: Math.max(w, 800) - EDGE_BAND * 2, h: Math.max(h, 600) - EDGE_BAND * 2 };
}

/** 引脚命中半径（sch 单位）—— 障碍防穿线（缩小让导线能在 40 脚芯片引脚间穿过） */
const PIN_HIT_RADIUS = 2;

/**
 * 路由降级重试：先严格（本体膨胀2+引脚半径2+已有线），逐步放宽到最简（仅本体）。
 * 保证 wire_routed 在密集布局也尽量找到路径；命中数>0 会在结果里上报，AI 可据实处理。
 * @returns {{polyline, level, hits}}
 */
function routeWithDegradation(fromPin, toPin, comps, wires) {
  const levels = [
    { bodyInflate: 2, pinRadius: 2, useWires: true, name: 'strict' },
    { bodyInflate: 1, pinRadius: 1, useWires: true, name: 'relaxed' },
    { bodyInflate: 1, pinRadius: 0.5, useWires: false, name: 'bodies+pins' },
    { bodyInflate: 0, pinRadius: 0, useWires: false, name: 'bodies-only' },
  ];
  // 找出 from/to 引脚所属器件：它们的本体和全部引脚都不设障
  // （否则引脚贴本体时 A* 起点被自己器件包围，第一跳全被堵死 → 必失败）
  const ownComp = new Set();
  for (const c of comps) {
    if (!c.pins) continue;
    if (c.pins.includes(fromPin) || c.pins.includes(toPin)) ownComp.add(c);
  }
  for (const lv of levels) {
    const obstacles = [];
    for (const c of comps) {
      if (ownComp.has(c)) continue; // from/to 器件本体+引脚全跳过
      if (c.bbox) {
        obstacles.push({ x: c.bbox.x - lv.bodyInflate, y: c.bbox.y - lv.bodyInflate, w: c.bbox.w + lv.bodyInflate * 2, h: c.bbox.h + lv.bodyInflate * 2 });
      }
      for (const p of c.pins || []) {
        if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
        const r = lv.pinRadius;
        obstacles.push({ x: p.x - r, y: p.y - r, w: r * 2, h: r * 2 });
      }
    }
    if (lv.useWires) {
      const T = 2;
      for (const w of wires || []) {
        const line = w.line || [];
        for (let i = 0; i + 3 < line.length; i += 2) {
          const x1 = line[i], y1 = line[i + 1], x2 = line[i + 2], y2 = line[i + 3];
          if (!Number.isFinite(x1) || !Number.isFinite(y1) || !Number.isFinite(x2) || !Number.isFinite(y2)) continue;
          obstacles.push({ x: Math.min(x1, x2) - T, y: Math.min(y1, y2) - T, w: Math.abs(x2 - x1) + T * 2, h: Math.abs(y2 - y1) + T * 2 });
        }
      }
    }
    const polyline = routeWire({ x: fromPin.x, y: fromPin.y }, { x: toPin.x, y: toPin.y }, obstacles, {
      grid: 5,
      hanan: true,
      wires,
      congestionAlpha: 0.1,
    });
    if (polyline) {
      const hits = polylineHitsObstacles(polyline, obstacles);
      return { polyline, level: lv.name, hits: hits.length };
    }
  }
  return null;
}

/** 读取现有导线（坐标行），供布线障碍防交叉 */
const READ_WIRES_CODE = [
  'const wires = await eda.sch_PrimitiveWire.getAll();',
  'const out = [];',
  'for (const w of wires) {',
  '  let line = null;',
  '  try { const l = w.getState_Line ? w.getState_Line() : w.line; if (Array.isArray(l)) { if (Array.isArray(l[0])) line = l.flat(); else line = l.slice(); } } catch {}',
  '  let net = null; try { net = w.getState_Net ? w.getState_Net() : w.net; } catch {}',
  '  let id = null; try { id = w.getState_PrimitiveId ? w.getState_PrimitiveId() : (w.primitiveId || null); } catch {}',
  '  out.push({ id, net, line });',
  '}',
  'return { wires: out };',
].join('\n');

/** 引脚显示名：有意义的名称（非纯数字，如 RST/XTAL1）优先，否则用编号 */
function pinDisplayRef(pin) {
  const n = String(pin.name || '').trim();
  if (n && !/^\d+$/.test(n)) return n;
  return pin.number || n || '?';
}

/**
 * 解析 from/to 组件+引脚（pin 省略时自动选距目标最近的端）。
 * @param {Array} comps 归一化组件（含 bbox rect + pins 绝对坐标）
 * @param {{component:string, pin?:string}} from
 * @param {{component:string, pin?:string}} to
 * @returns {{fromPin, toPin, note}} or throws
 */
function resolveWirePins(comps, from, to) {
  const findComp = (name) => comps.find((c) => c.designator === name);
  const fc = findComp(from.component);
  const tc = findComp(to.component);
  if (!fc) throw new Error(`找不到组件 ${from.component}`);
  if (!tc) throw new Error(`找不到组件 ${to.component}`);
  const pinsOf = (c) => (c.pins || []).filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
  const findPin = (c, ref) => {
    if (!ref) return null;
    const v = String(ref).toUpperCase();
    return pinsOf(c).find((p) => String(p.number || '').toUpperCase() === v || String(p.name || '').toUpperCase() === v) || null;
  };
  // to 的引脚先定（from 缺 pin 时要算到 to 的距离）
  let toPin = findPin(tc, to.pin);
  if (!toPin && to.pin) throw new Error(`组件 ${to.component} 找不到引脚 ${to.pin}`);
  let fromPin = findPin(fc, from.pin);
  let note = '';
  if (!fromPin) {
    const tPoint = toPin || { x: tc.x, y: tc.y };
    const nearest = pinsOf(fc).sort((a, b) => Math.hypot(a.x - tPoint.x, a.y - tPoint.y) - Math.hypot(b.x - tPoint.x, b.y - tPoint.y))[0];
    if (!nearest) throw new Error(`组件 ${from.component} 无可用引脚`);
    fromPin = nearest;
    note = `自动选 ${from.component} 最近端（${pinDisplayRef(fromPin)}）`;
  }
  if (!toPin) {
    const nearest = pinsOf(tc).sort((a, b) => Math.hypot(a.x - fromPin.x, a.y - fromPin.y) - Math.hypot(b.x - fromPin.x, b.y - fromPin.y))[0];
    if (!nearest) throw new Error(`组件 ${to.component} 无可用引脚`);
    toPin = nearest;
    note = `${note ? note + '；' : ''}自动选 ${to.component} 最近端（${pinDisplayRef(toPin)}）`;
  }
  return { fromPin, toPin, note };
}

/**
 * 布线数据验证（纯函数，供 verify_wiring 工具 + wire_repair 复用）：
 * ① 每线端点吸附（≤1sch）② 每线穿障 ③ 每网络闭合性。
 * @param {Array} comps 归一化组件（bbox rect + pins，可含 pin.net）
 * @param {Array<{id,net,line}>} wires
 * @returns {{ok, wires:Array, nets:Array, snapIssues:number, crossings:number, incompleteNets:Array}}
 */
function verifyWiringData(comps, wires) {
  // 吸附集合：组件引脚 + netflag 连接点（netflag 的 getAllPins 常为空，用其 (x,y) 作伪引脚）
  const allPins = [];
  for (const c of comps) {
    const isFlag = !c.designator && c.net;
    if (isFlag && Number.isFinite(c.x) && Number.isFinite(c.y)) {
      allPins.push({ x: c.x, y: c.y, number: 'flag', name: 'FLAG', net: c.net, comp: `${c.net}-flag` });
      continue;
    }
    for (const p of c.pins || []) {
      if (Number.isFinite(p.x) && Number.isFinite(p.y)) allPins.push({ ...p, comp: c.designator || c.id });
    }
  }
  // 穿障障碍：排除"线首尾点吸附到的引脚所在器件本体 + 该引脚自身"（否则正常线首尾被自挡）
  const wireChecks = [];
  for (const w of wires || []) {
    const line = w.line || [];
    const pts = [];
    for (let i = 0; i + 1 < line.length; i += 2) pts.push({ x: line[i], y: line[i + 1] });
    if (pts.length < 2) continue;
    // ① 端点吸附（只查首尾两个真端点）
    const snapIssues = [];
    const anchored = []; // [{pin, comp}] 每端吸附到的引脚
    for (const [idx, ep] of [[0, pts[0]], [pts.length - 1, pts[pts.length - 1]]]) {
      let d = Infinity;
      let nearest = null;
      for (const p of allPins) {
        const dd = Math.hypot(ep.x - p.x, ep.y - p.y);
        if (dd < d) { d = dd; nearest = p; }
      }
      if (d > 1) {
        snapIssues.push({ endpoint: idx, x: ep.x, y: ep.y, dist: Math.round(d * 10) / 10, nearestPin: nearest ? `${nearest.comp}.${pinDisplayRef(nearest)}` : null });
      } else if (nearest) {
        anchored.push(nearest);
      }
    }
    // ② 穿障：排除吸附引脚所在器件本体 + 吸附引脚自身（+ 吸附的 netflag 连接点）
    const skipComps = new Set(anchored.filter((a) => a.comp && !a.comp.endsWith('-flag')).map((a) => a.comp));
    const skipPinSet = new Set(anchored.map((a) => `${a.comp}|${a.x}|${a.y}`));
    const obstacles = [];
    for (const c of comps) {
      const cName = c.designator || c.id;
      if (skipComps.has(cName)) {
        // 该器件本体跳过，但其它引脚仍挡（只排除吸附的那个）
        for (const p of c.pins || []) {
          if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
          if (anchored.some((a) => a.x === p.x && a.y === p.y)) continue;
          obstacles.push({ x: p.x - 2, y: p.y - 2, w: 4, h: 4 });
        }
        continue;
      }
      if (c.bbox) obstacles.push({ x: c.bbox.x - 2, y: c.bbox.y - 2, w: c.bbox.w + 4, h: c.bbox.h + 4 });
      for (const p of c.pins || []) {
        if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
        obstacles.push({ x: p.x - 2, y: p.y - 2, w: 4, h: 4 });
      }
      // netflag 连接点也挡（防线穿过标记图形）
      if (!c.designator && c.net && Number.isFinite(c.x) && Number.isFinite(c.y)) {
        obstacles.push({ x: c.x - 2, y: c.y - 2, w: 4, h: 4 });
      }
    }
    const crossings = polylineHitsObstacles(pts, obstacles).length;
    wireChecks.push({ id: w.id, net: w.net || null, endpoints: [pts[0], pts[pts.length - 1]].map((p) => [p.x, p.y]), snapIssues, crossings });
  }
  // ③ 网络闭合性：每网络的引脚都应被某线真端点吸附（net 匹配才计）
  const netPins = new Map();
  for (const c of comps) {
    for (const p of c.pins || []) {
      if (!p.net || !Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
      if (!netPins.has(p.net)) netPins.set(p.net, []);
      netPins.get(p.net).push({ comp: c.designator || c.id, ref: pinDisplayRef(p), x: p.x, y: p.y });
    }
    if (!c.designator && c.net && Number.isFinite(c.x) && Number.isFinite(c.y)) {
      if (!netPins.has(c.net)) netPins.set(c.net, []);
      netPins.get(c.net).push({ comp: `${c.net}-flag`, ref: 'FLAG', x: c.x, y: c.y });
    }
  }
  // 只收集每线首尾两个真端点（Hanan 拐点不算，防误判闭合）
  const endpointSet = [];
  for (const w of wireChecks) {
    for (const e of w.endpoints || []) endpointSet.push({ x: e[0], y: e[1] });
  }
  const nearEndpoint = (x, y) => endpointSet.some((e) => Math.hypot(e.x - x, e.y - y) <= 1.5);
  const netClosure = [];
  const netMismatch = [];
  for (const [netName, pins] of netPins) {
    const missing = pins.filter((p) => !nearEndpoint(p.x, p.y)).map((p) => `${p.comp}.${p.ref}`);
    netClosure.push({ net: netName, pinCount: pins.length, connected: pins.length - missing.length, missing });
  }
  // ④ 线 net 与吸附引脚 net 不匹配告警（错误网络名的线连到引脚）
  for (const w of wireChecks) {
    if (!w.net) continue;
    for (const ep of w.endpoints || []) {
      const pin = allPins.find((p) => Math.hypot(p.x - ep[0], p.y - ep[1]) <= 1.5);
      if (pin && pin.net && pin.net !== w.net && !(w.net.includes(pin.net) || pin.net.includes(w.net))) {
        netMismatch.push({ wireNet: w.net, pinNet: pin.net, pin: `${pin.comp}.${pinDisplayRef(pin)}` });
      }
    }
  }
  const snapIssuesTotal = wireChecks.reduce((s, w) => s + w.snapIssues.length, 0);
  const crossingsTotal = wireChecks.reduce((s, w) => s + w.crossings, 0);
  const incompleteNets = netClosure.filter((n) => n.missing.length > 0);
  return {
    ok: snapIssuesTotal === 0 && crossingsTotal === 0 && incompleteNets.length === 0 && netMismatch.length === 0,
    wires: wireChecks,
    nets: netClosure,
    snapIssues: snapIssuesTotal,
    crossings: crossingsTotal,
    incompleteNets,
    netMismatch,
    wireCount: wireChecks.length,
  };
}

/**
 * Steiner 树落线（wire_net 工具 + wire_repair 共用）：把网络全部端点一次连成树并画线。
 * @param {Array} comps 归一化组件（bbox rect + pins）
 * @param {string} net 网络名
 * @param {Array<{component:string, pin?:string}>} pinRefs 该网络引脚
 * @param {{apply?:boolean}} [opts] apply=false 只返回折线不落线
 * @returns {{ok:boolean, edgeCount:number, applied:number, endpoints?:Array, polylines?:Array, error?:string}}
 */
async function wireNetApply(comps, net, pinRefs, { apply = true } = {}) {
  const endpoints = [];
  const ownComps = new Set();
  for (const ref of pinRefs) {
    const c = comps.find((x) => x.designator === ref.component);
    if (!c) return { ok: false, edgeCount: 0, applied: 0, error: `找不到组件 ${ref.component}` };
    let pinObj = null;
    if (ref.pin) {
      const v = String(ref.pin).toUpperCase();
      pinObj = (c.pins || []).find((p) => String(p.number || '').toUpperCase() === v || String(p.name || '').toUpperCase() === v) || null;
    }
    if (!pinObj) {
      const t = endpoints[0] || { x: c.x, y: c.y };
      pinObj = (c.pins || []).filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y))
        .sort((a, b) => Math.hypot(a.x - t.x, a.y - t.y) - Math.hypot(b.x - t.x, b.y - t.y))[0];
    }
    if (!pinObj || !Number.isFinite(pinObj.x) || !Number.isFinite(pinObj.y)) {
      return { ok: false, edgeCount: 0, applied: 0, error: `组件 ${ref.component} 无可用引脚` };
    }
    endpoints.push({ x: pinObj.x, y: pinObj.y, ref: `${ref.component}.${pinDisplayRef(pinObj)}` });
    ownComps.add(c);
  }
  if (!endpoints.length) return { ok: false, edgeCount: 0, applied: 0, error: '无端点' };
  const obstacles = [];
  for (const c of comps) {
    if (ownComps.has(c)) continue;
    if (c.bbox) obstacles.push({ x: c.bbox.x - 2, y: c.bbox.y - 2, w: c.bbox.w + 4, h: c.bbox.h + 4 });
    for (const p of c.pins || []) {
      if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
      obstacles.push({ x: p.x - 2, y: p.y - 2, w: 4, h: 4 });
    }
  }
  const edges = steinerTree(endpoints, obstacles, { grid: 5, hanan: true, allPoints: endpoints, congestionAlpha: 0.1 });
  if (!edges.length) return { ok: false, edgeCount: 0, applied: 0, error: `网络 ${net} 无法布线（无可用路径）` };
  const polylines = edges.map((e) => e.polyline);
  let applied = 0;
  if (apply) {
    for (const pl of polylines) {
      const flat = pl.flatMap((p) => [p.x, p.y]);
      const code = [
        `const w = await eda.sch_PrimitiveWire.create(${JSON.stringify(flat)}, ${J(net)});`,
        'return w ? { ok: true, id: w.primitiveId } : { ok: false, error: "画线失败" };',
      ].join('\n');
      const wRes = await runEda(bridge, code);
      if (wRes.ok && wRes.result && wRes.result.ok) applied++;
    }
  }
  return { ok: true, edgeCount: edges.length, applied, endpoints: endpoints.map((e) => e.ref), polylines };
}

/** 生成"批量移动"执行代码（async 图元模式，网络标记通用；挪件窗口内无 marker，零风险） */
function buildApplyMovesCode(placements) {
  const lines = [
    'const moves = ' + J(placements.map((p) => ({ id: p.id, x: p.x, y: p.y, rotation: p.rotation }))) + ';',
    'const results = [];',
    'for (const m of moves) {',
    '  try {',
    '    const raw = await eda.sch_PrimitiveComponent.get(m.id);',
    '    const prim = Array.isArray(raw) ? (raw[0] || null) : raw;',
    '    if (!prim) { results.push({ id: m.id, ok: false, error: "not found" }); continue; }',
    '    const ap = prim.toAsync();',
    '    ap.setState_X(m.x);',
    '    ap.setState_Y(m.y);',
    '    if (typeof m.rotation === "number") { try { ap.setState_Rotation(m.rotation); } catch {} }',
    '    await ap.done();',
    '    results.push({ id: m.id, ok: true });',
    '  } catch (e) { results.push({ id: m.id, ok: false, error: String(e && e.message || e) }); }',
    '}',
    'return { results };',
  ];
  return lines.join('\n');
}

/** 统一执行 EDA 代码并返回 {ok, result|error}（不让异常裸奔） */
async function runEda(bridge, code, opts = {}) {
  try {
    const result = await bridge.execute(code, opts);
    return { ok: true, result };
  }
  catch (err) {
    return { ok: false, error: err.message };
  }
}

function text(v) {
  return { content: [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v, null, 2) }] };
}

// ─── 工具定义 ────────────────────────────────────────────────
function registerTools(server, bridge, docsPath) {
  let docIndex = null;
  const ensureDocs = () => {
    if (docIndex) return docIndex;
    if (!docsPath) throw new Error('未找到文档索引 docs/index.json（插件安装可能不完整）');
    docIndex = loadIndex(docsPath);
    return docIndex;
  };

  // 1. 状态
  server.registerTool(
    'easyeda_status',
    { title: '桥与 EDA 连接状态', description: '返回桥进程、已连接 EDA 窗口、当前活动窗口、端口与连接信息（只读）。' },
    () => Promise.resolve(text(bridge.getStatus())),
  );

  // 2. 窗口列表
  server.registerTool(
    'easyeda_list_windows',
    { title: '列出已连接 EDA 窗口', description: '列出所有已连接 EDA 窗口及其状态（活动/工程/文档类型）。' },
    () => Promise.resolve(text(bridge.listWindows())),
  );

  // 3. 选择窗口
  server.registerTool(
    'easyeda_select_window',
    { title: '选择活动 EDA 窗口', description: '当有多个 EDA 窗口时，指定后续操作使用哪个窗口。' },
    z.object({ windowId: z.string().describe('要设为活动的窗口 ID（来自 easyeda_list_windows）') }),
    ({ windowId }) => {
      try {
        return Promise.resolve(text(bridge.selectWindow(windowId)));
      }
      catch (err) {
        return Promise.resolve(text({ ok: false, error: err.message }));
      }
    },
  );

  // 4. 执行任意 JS（专家兜底）
  server.registerTool(
    'easyeda_execute',
    {
      title: '在立创EDA 中执行 JS',
      description: '在立创EDA中执行任意JS（必须 return，console.log 不捕获）。可调全部官方 eda.* API。先 doc_search 查签名，注意坐标单位与 null 即失败。高风险任意代码，先确认意图。',
      inputSchema: z.object({
        code: z.string().describe('JS 代码主体（勿含外壳函数，勿用 console.log 返回结果）'),
        windowId: z.string().optional().describe('可选：目标窗口 ID'),
        timeoutMs: z.number().optional().describe('可选：超时（默认 30000）'),
        maxResultChars: z.number().optional().describe('可选：结果最大字符数（默认 200000）'),
      }),
    },
    async (params) => text(await runEda(bridge, params.code, {
      windowId: params.windowId,
      timeoutMs: params.timeoutMs,
      maxResultChars: params.maxResultChars ?? 200_000,
    })),
  );

  // 5. 文档检索
  server.registerTool(
    'easyeda_doc_search',
    {
      title: '检索立创EDA API 参考',
      description: '在插件自带的离线 API 参考索引中搜索（类名/方法签名/枚举值）。写复杂 EDA 调用前先用它查正确的方法签名与文档状态前提。',
      inputSchema: z.object({
        query: z.string().describe('搜索关键词（英文类名/方法名最佳，如 "DMT_Project" / "getAllProjectsUuid" / "pcb_Drc"）'),
        maxResults: z.number().optional().describe('可选：返回条数（默认 8）'),
      }),
    },
    async ({ query, maxResults }) => {
      try {
        const { results, truncated, total } = searchIndex(ensureDocs(), query, maxResults ?? 8);
        const lines = results.length === 0
          ? [`未找到与 "${query}" 相关的 API。可尝试更短的类名前缀（DMT_/PCB_/SCH_/LIB_/SYS_）。`]
          : results.map((r) => `[${r.kind}] ${r.snippet}`);
        if (truncated) lines.push(`（共 ${total} 条，已显示 ${results.length} 条，请加关键词）`);
        return text(lines.join('\n'));
      }
      catch (err) {
        return text({ ok: false, error: err.message });
      }
    },
  );

  // 6. 单位换算
  server.registerTool(
    'easyeda_convert',
    {
      title: '立创EDA 坐标单位换算',
      description: '换算 PCB(mil)/原理图(0.01inch)/毫米 坐标单位。PCB 1 单位=1mil，原理图 1 单位=10mil。放件前请先换算正确，避免 10 倍错位。',
      inputSchema: z.object({
        value: z.number().describe('要换算的数值'),
        from: z.enum(['mm', 'mil', 'sch']).describe('源单位'),
        to: z.enum(['mm', 'mil', 'sch']).describe('目标单位'),
      }),
    },
    ({ value, from, to }) => {
      try {
        const converted = Units.convert(value, { from, to });
        return Promise.resolve(text({ ok: true, value: converted, rounded: Units.round(converted) }));
      }
      catch (err) {
        return Promise.resolve(text({ ok: false, error: err.message }));
      }
    },
  );

  // 7. 当前工程信息
  server.registerTool(
    'easyeda_project_info',
    { title: '获取当前工程信息', description: '返回当前打开的立创EDA 工程与文档信息（只读）。PCB 操作需先有工程且激活 PCB 文档。' },
    async () => {
      const code = [
        'const project = await eda.dmt_Project.getCurrentProjectInfo();',
        'const doc = await eda.dmt_SelectControl.getCurrentDocumentInfo();',
        'return {',
        '  projectOpened: !!project,',
        '  project: project ? { name: project.friendlyName || project.name, uuid: project.uuid } : null,',
        '  document: doc ? { type: doc.documentType, uuid: doc.uuid, tabId: doc.tabId } : null',
        '};',
      ].join('\n');
      const { ok, result, error } = await runEda(bridge, code);
      if (ok) {
        if (result?.document && typeof result.document.type === 'number') {
          result.document.typeName = typeName(result.document.type);
        }
        return text(result);
      }
      return text({ ok: false, error });
    },
  );

  // 8. 列出工程
  server.registerTool(
    'easyeda_project_list',
    {
      title: '列出可打开工程',
      description: '遍历团队/文件夹列出可打开的工程（最多 50 个）。openProject 可能丢弃当前工程未保存修改，打开前请提示用户保存。',
      inputSchema: z.object({ maxItems: z.number().optional().describe('可选：返回条数上限（默认 50）') }),
    },
    async ({ maxItems }) => {
      const code = [
        'const teams = (await eda.dmt_Team.getAllInvolvedTeamInfo()) || [];',
        'const out = [];',
        'for (const team of teams) {',
        '  const uuids = (await eda.dmt_Project.getAllProjectsUuid(team.uuid)) || [];',
        '  for (const uuid of uuids) {',
        '    const info = await eda.dmt_Project.getProjectInfo(uuid);',
        '    out.push({ uuid, name: (info && (info.friendlyName || info.name)) || uuid });',
        '  }',
        '}',
        `return { count: out.length, projects: out.slice(0, ${maxItems ?? 50}) };`,
      ].join('\n');
      const { ok, result, error } = await runEda(bridge, code);
      return ok ? text(result) : text({ ok: false, error });
    },
  );

  // 9. 打开工程（含轮询验证：立创EDA 打开工程有异步延时，需确认真的切到目标工程）
  server.registerTool(
    'easyeda_project_open',
    {
      title: '打开立创EDA 工程',
      description: '按工程 UUID 打开工程，自动轮询确认已切换成功。注意：openProject 可能丢弃当前工程未保存的修改——请先询问用户确认保存。',
      inputSchema: z.object({ projectUuid: z.string().describe('目标工程 UUID（来自 easyeda_project_list）') }),
    },
    async ({ projectUuid }) => {
      const code = [
        `const target = ${J(projectUuid)};`,
        'const opened = await eda.dmt_Project.openProject(target);',
        '// 轮询验证当前工程确为目标工程（EDA 异步落地延时）',
        'let cur = null;',
        'for (let _i = 0; _i < 15; _i++) {',
        '  try { cur = await eda.dmt_Project.getCurrentProjectInfo(); } catch {}',
        '  if (cur && cur.uuid === target) break;',
        '  await new Promise(r => setTimeout(r, 300));',
        '}',
        'const switched = !!(cur && cur.uuid === target);',
        'return { ok: switched, projectUuid: target, opened: switched || opened, hint: switched ? null : "openProject 已返回但未能确认工程已切换（可能仍在加载），请稍候用 project_info 复查" };',
      ].join('\n');
      const { ok, result, error } = await runEda(bridge, code, { timeoutMs: 20_000 });
      return ok ? text(result) : text({ ok: false, error });
    },
  );

  // 10. 文档状态（前置检查）
  server.registerTool(
    'easyeda_document_state',
    {
      title: '检查当前文档类型',
      description: '返回当前激活文档类型（原理图/PCB/封装等）与工程是否打开。执行 PCB/SCH 操作前先调用，类型不匹配时提示正确的文档域。',
      inputSchema: z.object({
        want: z.enum(['PCB', 'SCHEMATIC_PAGE', 'FOOTPRINT', 'SYMBOL_COMPONENT', 'PANEL']).optional().describe('可选：期望文档类型，返回是否匹配与指引'),
      }),
    },
    async ({ want }) => {
      const code = [
        'const project = await eda.dmt_Project.getCurrentProjectInfo();',
        'const doc = await eda.dmt_SelectControl.getCurrentDocumentInfo();',
        'return { projectOpened: !!project, documentType: doc ? doc.documentType : null, documentUuid: doc ? doc.uuid : null };',
      ].join('\n');
      const { ok, result, error } = await runEda(bridge, code);
      if (!ok) return text({ ok: false, error });

      const type = result?.documentType;
      const currentName = typeName(type);
      let guidance = null;
      if (!result?.projectOpened) {
        guidance = '当前没有打开的工程。请先打开/新建工程，再激活目标文档后再操作。';
      }
      else if (want) {
        if (currentName === want) {
          guidance = `当前文档正是 ${want}，可以操作。`;
        }
        else {
          guidance = `当前文档类型是 ${currentName}，不是 ${want}。请先用 eda_dmt_EditorControl.openDocument 打开 ${want} 文档（或提示用户手动切换），再继续。`;
        }
      }
      return text({ ...result, documentTypeName: currentName, want, guidance });
    },
  );

  // 11. 器件库搜索
  server.registerTool(
    'easyeda_lib_search',
    {
      title: '搜索立创EDA 器件库',
      description: '在立创EDA 器件库按关键词搜索器件（返回 name/uuid/libraryUuid/封装名）。放件前先搜索拿到器件 UUID。',
      inputSchema: z.object({
        keyword: z.string().describe('搜索关键词（如 "STM32F103" / "10k 0603"）'),
        libraryUuid: z.string().optional().describe('可选：限定库 UUID'),
        page: z.number().optional().describe('可选：页码（默认 1）'),
        pageSize: z.number().optional().describe('可选：每页条数（默认 8，最大 20）'),
      }),
    },
    async ({ keyword, libraryUuid, page, pageSize }) => {
      const size = Math.min(Math.max(pageSize ?? 8, 1), 20);
      const pg = page ?? 1;
      const libExpr = libraryUuid ? J(libraryUuid) : 'undefined';
      const code = [
        `const items = await eda.lib_Device.search(${J(keyword)}, ${libExpr}, undefined, undefined, ${size}, ${pg});`,
        'return (items || []).map(d => ({ name: d.name, uuid: d.uuid, libraryUuid: d.libraryUuid, footprintName: d.footprintName, description: d.description }));',
      ].join('\n');
      const { ok, result, error } = await runEda(bridge, code);
      return ok ? text({ ok: true, count: Array.isArray(result) ? result.length : 0, items: result }) : text({ ok: false, error });
    },
  );

  // 12. 原理图器件列表（v3：bbox 归一化 + 同尺重叠检测 + 网络标记压件检查）
  server.registerTool(
    'easyeda_sch_list',
    {
      title: '列出当前原理图器件（含尺寸/重叠）',
      description: '列出当前激活原理图的全部器件，含归一化包围盒 bbox（minX/minY/maxX/maxY，sch 单位，顺序保证 min<max）与重叠器件对 overlaps、网络标记压在器件上的 netflagsInsideParts。放置/移动后务必调用它检查。',
    },
    async () => {
      const code = [
        'const comps = await eda.sch_PrimitiveComponent.getAll();',
        'const out = [];',
        'for (const c of comps) {',
        '  let bb = null;',
        '  try { bb = await eda.sch_Primitive.getPrimitivesBBox([c.primitiveId]); } catch {}',
        '  let net = null;',
        '  try { net = c.getState_Net ? c.getState_Net() : null; } catch {}',
        '  out.push({ id: c.primitiveId, designator: c.designator, name: c.name, x: c.x, y: c.y, rotation: c.rotation, net, bbox: bb });',
        '}',
        'return { components: out };',
      ].join('\n');
      const { ok, result, error } = await runEda(bridge, code, { timeoutMs: 20_000 });
      if (!ok) return text({ ok: false, error });
      // 插件侧：归一化 bbox + 同尺 lint（判定与生成同一把尺）
      const comps = (result.components || []).map((c) => ({
        ...c,
        bbox: normBBoxMinMax(c.bbox),
        _rect: c.bbox ? { x: Math.min(c.bbox.minX, c.bbox.maxX), y: Math.min(c.bbox.minY, c.bbox.maxY), w: Math.abs(c.bbox.maxX - c.bbox.minX), h: Math.abs(c.bbox.maxY - c.bbox.minY) } : null,
      }));
      const lint = lintLayout(
        comps.map((c) => ({ ...c, bbox: c._rect })),
        { clearance: 5 },
      );
      const components = comps.map(({ _rect, ...c }) => c);
      return text({
        count: components.length,
        components,
        overlaps: lint.overlaps,
        netflagsInsideParts: lint.netflagsInsideParts,
        clearance: 5,
      });
    },
  );

  // 12.5 布局验证门禁（同尺 lint，LLM 放置后可自查）
  server.registerTool(
    'easyeda_sch_verify_layout',
    {
      title: '校验原理图布局（重叠/标记压件/越界）',
      description: '同尺校验当前原理图布局：overlaps=器件两两重叠（含间距余量 5 sch），netflagsInsideParts=网络标记压在器件上，outOfSheet=越出页面。返回 ok 布尔。重排后务必调用确认无重叠。',
    },
    async () => {
      const { ok, result, error } = await runEda(bridge, READ_SCHEMATIC_CODE, { timeoutMs: 30_000 });
      if (!ok) return text({ ok: false, error });
      const comps = (result.components || []).map((c) => ({
        ...c,
        bbox: c.bbox
          ? { x: Math.min(c.bbox.minX, c.bbox.maxX), y: Math.min(c.bbox.minY, c.bbox.maxY), w: Math.abs(c.bbox.maxX - c.bbox.minX), h: Math.abs(c.bbox.maxY - c.bbox.minY) }
          : null,
      }));
      const lint = lintLayout(comps, { clearance: 5 });
      const usable = normalizeSheetRect(result.page);
      const outOfSheet = [];
      if (usable) {
        for (const c of comps) {
          if (c.bbox && (c.bbox.x < usable.x || c.bbox.y < usable.y || c.bbox.x + c.bbox.w > usable.x + usable.w || c.bbox.y + c.bbox.h > usable.y + usable.h)) {
            outOfSheet.push({ designator: c.designator || c.id });
          }
        }
      }
      // 通道校验（与 plan_layout 同尺）：相邻 part 间隙 < 12 报 routingBlocked
      const ROUTING_CHANNEL = 12;
      const partList = comps.filter((c) => c.designator).map((c) => ({ c, bbox: c.bbox })).filter((x) => x.bbox);
      const routingBlocked = [];
      const rectGap = (a, b) => {
        const xGap = Math.max(b.x - (a.x + a.w), a.x - (b.x + b.w));
        const yGap = Math.max(b.y - (a.y + a.h), a.y - (b.y + b.h));
        if (xGap < 0 && yGap < 0) return -1;
        if (xGap < 0) return yGap;
        if (yGap < 0) return xGap;
        return Math.min(xGap, yGap);
      };
      for (let i = 0; i < partList.length; i++) {
        for (let j = i + 1; j < partList.length; j++) {
          const g = rectGap(partList[i].bbox, partList[j].bbox);
          if (g < ROUTING_CHANNEL) {
            routingBlocked.push({ a: partList[i].c.designator, b: partList[j].c.designator, gap: Math.round(g * 10) / 10 });
          }
        }
      }
      return text({
        ok: lint.overlaps.length === 0 && lint.netflagsInsideParts.length === 0 && lint.pinOverlaps.length === 0 && outOfSheet.length === 0 && routingBlocked.length === 0,
        overlaps: lint.overlaps,
        netflagsInsideParts: lint.netflagsInsideParts,
        pinOverlaps: lint.pinOverlaps,
        outOfSheet,
        routingBlocked,
        clearance: 5,
      });
    },
  );

  // 12.6 确定性布局规划（AI 给意图，引擎算坐标）
  server.registerTool(
    'easyeda_sch_plan_layout',
    {
      title: '规划原理图布局（AI 表达意图，引擎算坐标）',
      description: '确定性布局引擎：AI 只表达意图（mode/anchors/groups/netFlags），坐标由引擎计算并保证不重叠。anchors 示例 [{s:"C3",p:"1",t:"U1",tp:"RST"}] 表示 C3 的 pin1 贴到 U1.RST。返回 placements（坐标 sch 单位）+ violations + notes。layout.apply=true 直接落图，否则 LLM 自行用 sch_modify 执行。',
      inputSchema: layoutIntentSchema,
    },
    async (args) => {
      let intent;
      try {
        intent = parseLayoutIntent(args);
      } catch (e) {
        return text({ ok: false, error: `意图解析失败: ${e.message}` });
      }
      const { ok, result, error } = await runEda(bridge, READ_SCHEMATIC_CODE, { timeoutMs: 30_000 });
      if (!ok) return text({ ok: false, error });
      const components = attachPinNetsFromNetlist(normalizeCompsForPlan(result.components), result.netlistRaw);
      const sheet = normalizeSheetRect(result.page);
      const plan = planLayout({ components, intent, sheet });

      let applied = 0;
      let applyErrors = [];
      if (intent.layout?.apply && plan.placements.length) {
        const applyCode = buildApplyMovesCode(plan.placements);
        const applyResult = await runEda(bridge, applyCode, { timeoutMs: 30_000 });
        if (applyResult.ok && applyResult.result && applyResult.result.results) {
          for (const r of applyResult.result.results) {
            if (r.ok) applied++;
            else applyErrors.push(`${r.id}: ${r.error}`);
          }
        } else {
          applyErrors.push(applyResult.error || 'apply 失败');
        }
      }

      return text({
        ok: plan.violations.ok && applyErrors.length === 0,
        mode: plan.mode,
        movedCount: plan.movedCount,
        placements: plan.placements,
        violations: plan.violations,
        notes: plan.notes,
        applied: applied,
        applyErrors,
        apply: !!intent.layout?.apply,
      });
    },
  );

  // 13. 原理图放件（默认单位 mm，更符合用户直觉）
  server.registerTool(
    'easyeda_sch_place_component',
    {
      title: '原理图放置器件',
      description: '在原理图坐标 (x, y) 放置器件。坐标单位默认 mm（用户口头说的坐标通常指毫米），可传 unit:"sch"（0.01inch）用 EDA 内部单位。需先激活原理图文档并已从 easyeda_lib_search 拿到器件 UUID。',
      inputSchema: z.object({
        deviceUuid: z.string().describe('器件 UUID（来自 easyeda_lib_search）'),
        libraryUuid: z.string().describe('器件所在库 UUID（来自 easyeda_lib_search）'),
        x: z.number().describe('X 坐标（单位见 unit，默认 mm）'),
        y: z.number().describe('Y 坐标（单位见 unit，默认 mm）'),
        unit: z.enum(['mm', 'sch']).optional().describe('坐标单位（默认 mm）'),
        rotation: z.number().optional().describe('可选：旋转角度（0/90/180/270，默认 0）'),
        mirror: z.boolean().optional().describe('可选：镜像（默认 false）'),
      }),
    },
    async ({ deviceUuid, libraryUuid, x, y, unit = 'mm', rotation = 0, mirror = false }) => {
      if (typeof deviceUuid !== 'string' || typeof libraryUuid !== 'string') {
        return text({ ok: false, error: '缺少 deviceUuid/libraryUuid（请先用 easyeda_lib_search 搜索）' });
      }
      const sx = unit === 'mm' ? Units.round(Units.mmToSch(x)) : x;
      const sy = unit === 'mm' ? Units.round(Units.mmToSch(y)) : y;
      const code = [
        `const c = await eda.sch_PrimitiveComponent.create({ libraryUuid: ${J(libraryUuid)}, uuid: ${J(deviceUuid)} }, ${sx}, ${sy}, undefined, ${rotation}, ${mirror ? 'true' : 'false'}, true, true);`,
        'if (!c) return { ok: false, error: "放置失败（返回 null）" };',
        '// 返回尺寸 bbox + 引脚坐标（供布局检查 / 后续布线直接用）',
        'let bb = null; let pins = [];',
        'try { bb = await eda.sch_Primitive.getPrimitivesBBox([c.primitiveId]); } catch {}',
        'try { pins = ((await eda.sch_PrimitiveComponent.getAllPinsByPrimitiveId(c.primitiveId)) || []).map(p => ({ number: p.pinNumber, name: p.pinName, x: p.x, y: p.y })); } catch {}',
        'return { ok: true, id: c.primitiveId, designator: c.designator, name: c.name, x: c.x, y: c.y, rotation: c.rotation, bbox: bb, pins };',
      ].join('\n');
      const { ok, result, error } = await runEda(bridge, code);
      if (!ok) return text({ ok: false, error });
      if (result && result.bbox) result.bbox = normBBoxMinMax(result.bbox);
      return text(result);
    },
  );

  // 14. 网络标记
  server.registerTool(
    'easyeda_sch_add_net_flag',
    {
      title: '原理图添加电源/地网络标记',
      description: '在原理图坐标处添加电源/地网络标记（net flag）。identification 是标记类型，仅支持 Power(电源)/Ground(地)/AnalogGround(模拟地)/ProtectGround(保护地)；net 是网络名（如 VCC/3V3/GND）。需先激活原理图文档。',
      inputSchema: z.object({
        identification: z.enum(['Power', 'Ground', 'AnalogGround', 'ProtectGround']).describe('标记类型（Power 电源 / Ground 地 / AnalogGround 模拟地 / ProtectGround 保护地）'),
        net: z.string().describe('网络名（如 VCC / 3V3 / GND）'),
        x: z.number().describe('X 坐标（mm，自动换算 sch 单位）'),
        y: z.number().describe('Y 坐标（mm，自动换算 sch 单位）'),
      }),
    },
    async ({ identification, net, x, y }) => {
      const sx = Units.round(Units.mmToSch(x));
      const sy = Units.round(Units.mmToSch(y));
      const code = [
        `const f = await eda.sch_PrimitiveComponent.createNetFlag(${J(identification)}, ${J(net)}, ${sx}, ${sy});`,
        'return f ? { ok: true, id: f.primitiveId, x: f.x ?? (f.getState_X ? f.getState_X() : null), y: f.y ?? (f.getState_Y ? f.getState_Y() : null) } : { ok: false, error: "添加网络标记失败（返回 null）" };',
      ].join('\n');
      const { ok, result, error } = await runEda(bridge, code);
      return ok ? text(result) : text({ ok: false, error });
    },
  );

  // 15. 读取原理图器件引脚坐标（布线前先读精确坐标，避免连错端点）
  server.registerTool(
    'easyeda_sch_get_pins',
    {
      title: '读取原理图器件引脚坐标',
      description: '按器件 id 读取全部引脚的精确坐标（sch 单位）。布线/验证前先调用，避免端点连错。',
      inputSchema: z.object({ primitiveId: z.string().describe('器件图元 id（来自 easyeda_sch_list）') }),
    },
    async ({ primitiveId }) => {
      const code = [
        `const pins = await eda.sch_PrimitiveComponent.getAllPinsByPrimitiveId(${J(primitiveId)});`,
        `return { componentId: ${J(primitiveId)}, pins: (pins || []).map(p => ({ number: p.pinNumber, name: p.pinName, x: p.x, y: p.y })) };`,
      ].join('\n');
      const { ok, result, error } = await runEda(bridge, code);
      return ok ? text(result) : text({ ok: false, error });
    },
  );

  // 15b. 原理图画导线（精确连线，带网络名；端点用 sch_get_pins 读到的引脚坐标）
  server.registerTool(
    'easyeda_sch_wire',
    {
      title: '原理图画导线',
      description: '按一组折线端点画导线（可带网络名）。坐标默认 mm（自动换算 sch 单位），可传 unit:"sch"。端点应为引脚/器件端点坐标（用 easyeda_sch_get_pins 读取），否则导线连不上。',
      inputSchema: z.object({
        points: z.array(z.array(z.number()).length(2)).describe('折线端点 [[x,y],...]（至少 2 点）'),
        net: z.string().optional().describe('可选：网络名（如 VCC/GND）'),
        unit: z.enum(['mm', 'sch']).optional().describe('坐标单位（默认 mm）'),
      }),
    },
    async ({ points, net, unit = 'mm' }) => {
      if (!Array.isArray(points) || points.length < 2 || points.some((p) => !Array.isArray(p) || p.length !== 2 || typeof p[0] !== 'number' || typeof p[1] !== 'number')) {
        return text({ ok: false, error: 'points 必须是至少 2 个 [x, y] 数组' });
      }
      const pts = points.map(([x, y]) => (unit === 'mm' ? [Units.round(Units.mmToSch(x)), Units.round(Units.mmToSch(y))] : [x, y]));
      // ⚠️ 立创 EDA 的 sch_PrimitiveWire.create 只接受**扁平坐标数组** [x0,y0,x1,y1,...]，
      // 嵌套 [[x,y],...] 会报 "create failed!"（真机多次复现）。这里拍平再传。
      const flat = pts.flat();
      // 同尺校验：穿障拒绝 + 端点吸附检查（约束②③，让 sch_wire 兜底也守规矩）
      let hits = 0;
      let unsnapped = [];
      try {
        const rRes = await runEda(bridge, READ_SCHEMATIC_CODE, { timeoutMs: 30_000 });
        if (rRes.ok && rRes.result) {
          const comps = (rRes.result.components || []).map((c) => ({
            designator: c.designator,
            id: c.id,
            net: c.net,
            x: c.x,
            y: c.y,
            bbox: c.bbox ? { x: Math.min(c.bbox.minX, c.bbox.maxX), y: Math.min(c.bbox.minY, c.bbox.maxY), w: Math.abs(c.bbox.maxX - c.bbox.minX), h: Math.abs(c.bbox.maxY - c.bbox.minY) } : null,
            pins: (c.pins || []).filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y)),
          }));
          const pl = pts.map((p) => ({ x: p[0], y: p[1] }));
          // 首尾端点吸附的引脚（含 netflag 连接点）
          const allSnapPts = [];
          for (const c of comps) {
            for (const p of c.pins) allSnapPts.push({ x: p.x, y: p.y, c });
            if (!c.designator && c.net && Number.isFinite(c.x) && Number.isFinite(c.y)) allSnapPts.push({ x: c.x, y: c.y, c });
          }
          const anchoredPins = [pl[0], pl[pl.length - 1]]
            .map((ep) => allSnapPts.reduce((best, p) => {
              const d = Math.hypot(ep.x - p.x, ep.y - p.y);
              return d < best.d ? { d, p } : best;
            }, { d: Infinity, p: null }))
            .filter((x) => x.p && x.d <= 1)
            .map((x) => x.p);
          // 障碍：排除吸附引脚所在器件本体 + 吸附引脚自身
          const skipComps = new Set(anchoredPins.map((p) => p.c && (p.c.designator || p.c.id)));
          const obstacles = [];
          for (const c of comps) {
            if (skipComps.has(c.designator || c.id)) {
              for (const p of c.pins) {
                if (anchoredPins.some((a) => a.x === p.x && a.y === p.y)) continue;
                obstacles.push({ x: p.x - 2, y: p.y - 2, w: 4, h: 4 });
              }
              continue;
            }
            if (c.bbox) obstacles.push({ x: c.bbox.x - 2, y: c.bbox.y - 2, w: c.bbox.w + 4, h: c.bbox.h + 4 });
            for (const p of c.pins) obstacles.push({ x: p.x - 2, y: p.y - 2, w: 4, h: 4 });
            if (!c.designator && c.net && Number.isFinite(c.x) && Number.isFinite(c.y)) {
              obstacles.push({ x: c.x - 2, y: c.y - 2, w: 4, h: 4 });
            }
          }
          hits = polylineHitsObstacles(pl, obstacles).length;
          // 端点吸附：首尾点距最近引脚 > 1 sch → 未吸附
          for (const [i, ep] of [[0, pl[0]], [pl.length - 1, pl[pl.length - 1]]]) {
            let d = Infinity;
            for (const c of comps) for (const p of c.pins) d = Math.min(d, Math.hypot(ep.x - p.x, ep.y - p.y));
            if (d > 1) unsnapped.push({ endpoint: i, x: ep.x, y: ep.y, dist: Math.round(d * 10) / 10 });
          }
        }
      } catch {}
      if (hits > 0) {
        return text({ ok: false, error: `导线穿过元器件/引脚（${hits} 处），请用 easyeda_sch_wire_routed 自动绕障布线，不要手画折线` });
      }
      const code = [
        `const w = await eda.sch_PrimitiveWire.create(${JSON.stringify(flat)}, ${J(net ?? undefined)});`,
        'return w ? { ok: true, id: w.primitiveId } : { ok: false, error: "画导线失败（返回 null）" };',
      ].join('\n');
      const { ok, result, error } = await runEda(bridge, code);
      if (!ok) return text({ ok: false, error });
      return text({ ...result, hits: 0, unsnapped });
    },
  );

  // 15aa. 删除原理图导线（用 getState_PrimitiveId 正确取 id，防手写 w.id 删了个寂寞）
  server.registerTool(
    'easyeda_sch_wire_delete',
    {
      title: '删除原理图导线',
      description: '删除全部导线（或按网络名只删指定网络）。⚠️ 立创导线对象没有 .id 属性，必须用 getState_PrimitiveId() 取 id 才能删（手写 w.id 会静默失败）。返回删除条数。',
      inputSchema: z.object({
        net: z.string().optional().describe('可选：只删除该网络名的导线；省略删除全部'),
      }),
    },
    async ({ net }) => {
      const code = [
        'const wires = await eda.sch_PrimitiveWire.getAll();',
        `const onlyNet = ${J(net ?? null)};`,
        'const targets = wires.filter(w => {',
        '  let id = null;',
        '  try { id = w.getState_PrimitiveId ? w.getState_PrimitiveId() : (w.primitiveId || w.id); } catch {}',
        '  if (!id) return false;',
        '  if (onlyNet) { let wn = null; try { wn = w.getState_Net ? w.getState_Net() : w.net; } catch {} return wn === onlyNet; }',
        '  return true;',
        '});',
        'const ids = targets.map(w => { try { return w.getState_PrimitiveId ? w.getState_PrimitiveId() : (w.primitiveId || w.id); } catch {} return null; }).filter(Boolean);',
        'let deleted = 0;',
        'if (ids.length) { try { deleted = (await eda.sch_PrimitiveWire.delete(ids)) ? ids.length : 0; } catch (e) { return { ok: false, error: "删除失败: " + String(e && e.message || e) }; } }',
        'return { ok: true, total: wires.length, deleted, byNet: onlyNet || undefined };',
      ].join('\n');
      const { ok, result, error } = await runEda(bridge, code, { timeoutMs: 20_000 });
      return ok ? text(result) : text({ ok: false, error });
    },
  );

  // 15a. 一次性重排（AI 只调一次：读全量→确定性布局→批量落图→验证）
  server.registerTool(
    'easyeda_sch_redesign',
    {
      title: '一键重新布局并接线（确定性）',
      description: '一次性重排整个原理图：主 IC 居中、电源(VCC)朝上/地(GND)朝下、信号流左到右、外围件贴对应引脚、器件间留布线通道；随后自动布全部网络（Steiner）。AI 只调这一次，不用逐条 modify/wire。返回移动+布线+验证结果。',
      inputSchema: z.object({
        core: z.string().optional().describe('可选：主 IC 位号（省略自动选引脚最多的器件）'),
        wire: z.boolean().optional().describe('true=同时自动布线（默认 true）；false=只布局不布线'),
        apply: z.boolean().optional().describe('true=直接落图（默认）；false=只返回规划不落图'),
      }),
    },
    async ({ core, wire = true, apply = true }) => {
      const rRes = await runEda(bridge, READ_SCHEMATIC_CODE, { timeoutMs: 30_000 });
      if (!rRes.ok) return text({ ok: false, error: rRes.error });
      const comps = attachPinNetsFromNetlist((rRes.result.components || []).map((c) => ({
        ...c,
        bbox: c.bbox ? { x: Math.min(c.bbox.minX, c.bbox.maxX), y: Math.min(c.bbox.minY, c.bbox.maxY), w: Math.abs(c.bbox.maxX - c.bbox.minX), h: Math.abs(c.bbox.maxY - c.bbox.minY) } : null,
      })), rRes.result.netlistRaw);
      const sheet = normalizeSheetRect(rRes.result.page);
      // 自动选核心：引脚最多的 part
      const autoCore = core || (() => {
        const parts = comps.filter((c) => c.designator);
        const byPins = parts.slice().sort((a, b) => (b.pins || []).length - (a.pins || []).length);
        return byPins[0] ? byPins[0].designator : null;
      })();
      if (!autoCore) return text({ ok: false, error: '原理图无器件' });
      // 确定性布局（central-lr：主 IC 居中 + 无网表时用标记反推连通性）
      const plan = planLayout({ components: comps, intent: { mode: 'central-lr', core: autoCore, layout: { apply: false } }, sheet });
      const moves = plan.placements;
      // 批量落图
      let moved = 0;
      let moveErrors = [];
      if (apply && moves.length) {
        const applyCode = buildApplyMovesCode(moves);
        const aRes = await runEda(bridge, applyCode, { timeoutMs: 30_000 });
        if (aRes.ok && aRes.result && aRes.result.results) {
          for (const r of aRes.result.results) {
            if (r.ok) moved++;
            else moveErrors.push(r.error);
          }
        } else {
          moveErrors.push(aRes.error || '移动失败');
        }
      }
      // 自动布线：按网络分组（用 net 反推的引脚网络），Steiner 一次连
      let wiredNets = 0;
      let wireErrors = [];
      if (wire && apply) {
        const wRes = await runEda(bridge, READ_SCHEMATIC_CODE, { timeoutMs: 30_000 });
        if (wRes.ok) {
          const wc = attachPinNetsFromNetlist((wRes.result.components || []).map((c) => ({
            ...c,
            bbox: c.bbox ? { x: Math.min(c.bbox.minX, c.bbox.maxX), y: Math.min(c.bbox.minY, c.bbox.maxY), w: Math.abs(c.bbox.maxX - c.bbox.minX), h: Math.abs(c.bbox.maxY - c.bbox.minY) } : null,
          })), wRes.result.netlistRaw);
          // 按网络分组
          const netGroups = new Map();
          for (const c of wc) {
            for (const p of c.pins || []) {
              if (!p.net || !Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
              if (!netGroups.has(p.net)) netGroups.set(p.net, []);
              netGroups.get(p.net).push({ component: c.designator, pin: p.number || p.name });
            }
          }
          // 信号网优先（电源地后布），端点少先布
          const netNames = [...netGroups.keys()].sort((a, b) => {
            const sa = /^(GND|VSS|VCC|VDD|\+[0-9A-Z.]*V)/.test(a) ? 1 : 0;
            const sb = /^(GND|VSS|VCC|VDD|\+[0-9A-Z.]*V)/.test(b) ? 1 : 0;
            if (sa !== sb) return sa - sb;
            return netGroups.get(a).length - netGroups.get(b).length;
          });
          for (const netName of netNames) {
            const pins = netGroups.get(netName);
            if (pins.length < 2) continue;
            const wNet = await wireNetApply(wc, netName, pins);
            if (wNet.ok && wNet.applied > 0) wiredNets++;
            else wireErrors.push(`${netName}: ${wNet.error || '失败'}`);
          }
        }
      }
      // 验证
      const finalRes = await runEda(bridge, READ_SCHEMATIC_CODE, { timeoutMs: 30_000 });
      const finalWires = await runEda(bridge, READ_WIRES_CODE, { timeoutMs: 15_000 });
      let verify = null;
      if (finalRes.ok && finalWires.ok) {
        const fc = attachPinNetsFromNetlist((finalRes.result.components || []).map((c) => ({
          ...c,
          bbox: c.bbox ? { x: Math.min(c.bbox.minX, c.bbox.maxX), y: Math.min(c.bbox.minY, c.bbox.maxY), w: Math.abs(c.bbox.maxX - c.bbox.minX), h: Math.abs(c.bbox.maxY - c.bbox.minY) } : null,
        })), finalRes.result.netlistRaw);
        verify = verifyWiringData(fc, finalWires.result.wires || []);
      }
      return text({
        ok: (plan.violations.overlaps.length === 0 && plan.violations.pinOverlaps.length === 0 && (moveErrors.length === 0)) && (!verify || verify.ok),
        core: autoCore,
        moved,
        moveErrors: moveErrors.slice(0, 5),
        layoutViolations: plan.violations,
        wiredNets,
        wireErrors: wireErrors.slice(0, 5),
        verify,
      });
    },
  );

  // 15b. 确定性绕障布线（A*：线自动绕开元器件/无关引脚，自动选最近端）
  server.registerTool(
    'easyeda_sch_wire_routed',
    {
      title: '确定性绕障布线（自动避开元器件和无关引脚）',
      description: '在原理图两点间自动画一条**绕开所有元器件本体和其他无关引脚**的正交导线。from/to 用「位号.引脚」指定（如 {component:"C1",pin:"1"} 到 {component:"U1",pin:"XTAL1"}）；**pin 可省略**——自动选距离目标最近的端（电容 AB 端等效时选近端）。apply=true 直接画线，否则返回 polyline 供预览。线绝不穿过元器件/无关引脚。',
      inputSchema: z.object({
        from: z.object({ component: z.string().describe('起始器件位号（如 C1）'), pin: z.string().optional().describe('起始引脚号/名（可省略，省略自动选距目标最近的端）') }),
        to: z.object({ component: z.string().describe('目标器件位号（如 U1）'), pin: z.string().optional().describe('目标引脚号/名（可省略）') }),
        net: z.string().optional().describe('可选：网络名（如 XTAL1/VCC/GND）'),
        apply: z.boolean().optional().describe('true=直接画线（默认）；false=只返回 polyline 预览'),
      }),
    },
    async ({ from, to, net, apply = true }) => {
      if (!from || !to || !from.component || !to.component) {
        return text({ ok: false, error: 'from/to 都需要 {component, pin?}' });
      }
      const { ok, result, error } = await runEda(bridge, READ_SCHEMATIC_CODE, { timeoutMs: 30_000 });
      if (!ok) return text({ ok: false, error });
      // 归一化组件（bbox→rect，pins 绝对坐标）
      const comps = (result.components || []).map((c) => ({
        ...c,
        bbox: c.bbox ? { x: Math.min(c.bbox.minX, c.bbox.maxX), y: Math.min(c.bbox.minY, c.bbox.maxY), w: Math.abs(c.bbox.maxX - c.bbox.minX), h: Math.abs(c.bbox.maxY - c.bbox.minY) } : null,
        pins: (c.pins || []).map((p) => ({ ...p })),
      }));
      let fromPin;
      let toPin;
      let note = '';
      try {
        const r = resolveWirePins(comps, from, to);
        fromPin = r.fromPin;
        toPin = r.toPin;
        note = r.note;
      } catch (e) {
        return text({ ok: false, error: e.message });
      }
      // 读已有导线（防新线交叉）
      let wires = [];
      try {
        const wRes = await runEda(bridge, READ_WIRES_CODE, { timeoutMs: 15_000 });
        if (wRes.ok && wRes.result && wRes.result.wires) wires = wRes.result.wires;
      } catch {}
      // 路由降级重试（严格→放宽→最简），密集布局也能找到路径
      const routed = routeWithDegradation(fromPin, toPin, comps, wires);
      if (!routed) {
        return text({ ok: false, error: `无法在 ${from.component}.${pinDisplayRef(fromPin)} → ${to.component}.${pinDisplayRef(toPin)} 间找到路径（布局过挤，请先 plan_layout 重新摆放）` });
      }
      const polyline = routed.polyline;
      const hits = routed.hits;
      const level = routed.level;
      const flat = polyline.flatMap((p) => [p.x, p.y]);
      let wireId = null;
      if (apply) {
        const code = [
          `const w = await eda.sch_PrimitiveWire.create(${JSON.stringify(flat)}, ${J(net ?? undefined)});`,
          'return w ? { ok: true, id: w.primitiveId } : { ok: false, error: "画导线失败（返回 null）" };',
        ].join('\n');
        const wRes = await runEda(bridge, code);
        if (!wRes.ok) return text({ ok: false, error: `画线失败: ${wRes.error}` });
        wireId = wRes.result && wRes.result.id;
      }
      return text({
        ok: true,
        from: `${from.component}.${pinDisplayRef(fromPin)}`,
        to: `${to.component}.${pinDisplayRef(toPin)}`,
        note: note || undefined,
        polyline,
        hits,
        level,
        wireId: wireId || undefined,
        applied: apply,
      });
    },
  );

  // 15b2. Steiner 树多端点布线（一次连一个网络的全部端点）
  server.registerTool(
    'easyeda_sch_wire_net',
    {
      title: '多端点网络一次布线（Steiner 树）',
      description: '把一个网络的**全部端点**一次连起来（去耦/晶振/电源这类多点网络用这个，不用多次 wire_routed 再手工汇合）。net 指定网络名，pins 可省略（自动从网表找该网络的全部引脚）。apply=true 直接画线。',
      inputSchema: z.object({
        net: z.string().describe('网络名（如 XTAL1 / GND / +5V）'),
        pins: z.array(z.object({ component: z.string(), pin: z.string().optional() })).optional().describe('可选：该网络的引脚（省略自动从网表找）'),
        apply: z.boolean().optional().describe('true=直接画线（默认）；false=只返回折线'),
      }),
    },
    async ({ net, pins, apply = true }) => {
      if (!net) return text({ ok: false, error: 'net 必填' });
      const { ok, result, error } = await runEda(bridge, READ_SCHEMATIC_CODE, { timeoutMs: 30_000 });
      if (!ok) return text({ ok: false, error });
      const comps = (result.components || []).map((c) => ({
        ...c,
        bbox: c.bbox ? { x: Math.min(c.bbox.minX, c.bbox.maxX), y: Math.min(c.bbox.minY, c.bbox.maxY), w: Math.abs(c.bbox.maxX - c.bbox.minX), h: Math.abs(c.bbox.maxY - c.bbox.minY) } : null,
        pins: (c.pins || []).map((p) => ({ ...p })),
      }));
      const allComps = attachPinNetsFromNetlist(comps, result.netlistRaw);
      const pinRefs = pins && pins.length
        ? pins
        : allComps.flatMap((c) => (c.pins || []).filter((p) => p.net === net).map((p) => ({ component: c.designator, pin: p.number || p.name })));
      if (!pinRefs.length) {
        return text({ ok: false, error: `网络 ${net} 找不到引脚（网表里无该网络，或 pins 未匹配）` });
      }
      const res = await wireNetApply(allComps, net, pinRefs, { apply });
      if (!res.ok) return text({ ok: false, error: res.error });
      return text({ ok: true, net, ...res });
    },
  );


  // 15b3. 布线验证（连通性回读：端点吸附 + 穿障 + 每网络闭合性）
  server.registerTool(
    'easyeda_sch_verify_wiring',
    {
      title: '验证布线（端点吸附/穿障/网络闭合）',
      description: '读回全部导线做电气自证：① 每线端点是否精确吸附在引脚上（≤1 sch，差半格就没电气连接）② 每线是否穿过元器件/无关引脚 ③ 每个网络的引脚是否都被线连到（闭合性）。布线完成后调用，ok=true 才算电气正确。',
      inputSchema: z.object({}),
    },
    async () => {
      const rRes = await runEda(bridge, READ_SCHEMATIC_CODE, { timeoutMs: 30_000 });
      const wRes = await runEda(bridge, READ_WIRES_CODE, { timeoutMs: 15_000 });
      if (!rRes.ok) return text({ ok: false, error: rRes.error });
      if (!wRes.ok) return text({ ok: false, error: wRes.error });
      const comps = attachPinNetsFromNetlist((rRes.result.components || []).map((c) => ({
        ...c,
        bbox: c.bbox ? { x: Math.min(c.bbox.minX, c.bbox.maxX), y: Math.min(c.bbox.minY, c.bbox.maxY), w: Math.abs(c.bbox.maxX - c.bbox.minX), h: Math.abs(c.bbox.maxY - c.bbox.minY) } : null,
      })), rRes.result.netlistRaw);
      const v = verifyWiringData(comps, wRes.result.wires || []);
      return text({ ok: v.ok, ...v });
    },
  );

  // 15b4. 布线修复（拆线重布）：验证 → 拆失败网络 → Steiner 重布，最多 3 轮
  server.registerTool(
    'easyeda_sch_wire_repair',
    {
      title: '修复布线（拆线重布）',
      description: '验证布线后把不完整的网络**拆掉重布**（Steiner 树一次连全部端点），最多迭代 3 轮。用于多网络布线后"有网络没连上/连错"的自动修复。返回最终验证结果。',
      inputSchema: z.object({}),
    },
    async () => {
      const rRes = await runEda(bridge, READ_SCHEMATIC_CODE, { timeoutMs: 30_000 });
      if (!rRes.ok) return text({ ok: false, error: rRes.error });
      const comps = attachPinNetsFromNetlist((rRes.result.components || []).map((c) => ({
        ...c,
        bbox: c.bbox ? { x: Math.min(c.bbox.minX, c.bbox.maxX), y: Math.min(c.bbox.minY, c.bbox.maxY), w: Math.abs(c.bbox.maxX - c.bbox.minX), h: Math.abs(c.bbox.maxY - c.bbox.minY) } : null,
      })), rRes.result.netlistRaw);
      const rounds = [];
      for (let round = 0; round < 3; round++) {
        const wRes = await runEda(bridge, READ_WIRES_CODE, { timeoutMs: 15_000 });
        const v = verifyWiringData(comps, (wRes.ok && wRes.result && wRes.result.wires) || []);
        rounds.push({ round: round + 1, ok: v.ok, snapIssues: v.snapIssues, crossings: v.crossings, incompleteNets: v.incompleteNets.map((n) => ({ net: n.net, missing: n.missing })) });
        if (v.ok) break;
        const netsToFix = v.incompleteNets.filter((n) => n.net);
        if (!netsToFix.length) break;
        // 拆该网络全部旧线
        for (const n of netsToFix) {
          const delCode = [
            'const wires = await eda.sch_PrimitiveWire.getAll();',
            `const onlyNet = ${J(n.net)};`,
            'const ids = [];',
            'for (const w of wires) { let wn = null; try { wn = w.getState_Net ? w.getState_Net() : w.net; } catch {} if (wn === onlyNet) { let id = null; try { id = w.getState_PrimitiveId ? w.getState_PrimitiveId() : (w.primitiveId || null); } catch {} if (id) ids.push(id); } }',
            'if (ids.length) { try { await eda.sch_PrimitiveWire.delete(ids); } catch {} }',
            'return { deleted: ids.length };',
          ].join('\n');
          await runEda(bridge, delCode, { timeoutMs: 15_000 });
        }
        // 用 Steiner 重布
        for (const n of netsToFix) {
          const netPins = comps.flatMap((c) => (c.pins || []).filter((p) => p.net === n.net).map((p) => ({ component: c.designator, pin: p.number || p.name })));
          if (!netPins.length) continue;
          const wNet = await runEda(bridge, READ_SCHEMATIC_CODE, { timeoutMs: 30_000 });
          if (!wNet.ok) continue;
          const wc = attachPinNetsFromNetlist((wNet.result.components || []).map((c) => ({
            ...c,
            bbox: c.bbox ? { x: Math.min(c.bbox.minX, c.bbox.maxX), y: Math.min(c.bbox.minY, c.bbox.maxY), w: Math.abs(c.bbox.maxX - c.bbox.minX), h: Math.abs(c.bbox.maxY - c.bbox.minY) } : null,
          })), wNet.result.netlistRaw);
          await wireNetApply(wc, n.net, netPins);
        }
      }
      const finalRes = await runEda(bridge, READ_WIRES_CODE, { timeoutMs: 15_000 });
      const finalV = verifyWiringData(comps, (finalRes.ok && finalRes.result && finalRes.result.wires) || []);
      return text({ ok: finalV.ok, ...finalV, rounds });
    },
  );

  // 15c. 新建空白原理图并激活（含轮询验证：立创EDA 新建有异步延时，防重复创建）
  server.registerTool(
    'easyeda_sch_create',
    {
      title: '新建空白原理图并激活',
      description: '在立创EDA 新建空白原理图并打开激活。EDA 新建命令可能有数秒异步延时，本工具会自动轮询确认创建成功并找到新页面，避免误判失败而重复创建。',
      inputSchema: z.object({
        name: z.string().optional().describe('可选：原理图名称（不填由 EDA 自动命名）'),
      }),
    },
    async ({ name }) => {
      const code = [
        `const name = ${J(name ?? null)};`,
        '// 0. 记录创建前的原理图 uuid 集合（重名时 EDA 会加后缀如「(1)」，按名字精确匹配会漏判）',
        'const before = new Set(((await eda.dmt_Schematic.getAllSchematicsInfo()) || []).map(s => s.uuid));',
        '// 1. 新建原理图（Promise resolve 即返回 schematic uuid；但文档树可能未同步）',
        'const created = await eda.dmt_Schematic.createSchematic(name || undefined);',
        'let schemUuid = (typeof created === "string" && created) ? created : null;',
        '// 2. 轮询直到新原理图出现（立创EDA 异步落地延时）：优先找不在 before 里的新 uuid，再兜底名字前缀匹配）',
        'for (let _i = 0; _i < 20 && !schemUuid; _i++) {',
        '  await new Promise(r => setTimeout(r, 300));',
        '  const list = (await eda.dmt_Schematic.getAllSchematicsInfo()) || [];',
        '  const found = list.find(s => !before.has(s.uuid))',
        '    || (name ? list.find(s => s.name === name || s.name.startsWith(name + " ")) : list[list.length - 1]);',
        '  if (found && found.uuid) schemUuid = found.uuid;',
        '}',
        'if (!schemUuid) return { ok: false, error: "新建原理图后未能在文档树中找到（可能仍在处理中），请稍后重试" };',
        '// 3. 轮询找到该原理图的第一个页面',
        'let pageUuid = null;',
        'for (let _i = 0; _i < 20 && !pageUuid; _i++) {',
        '  const pages = (await eda.dmt_Schematic.getAllSchematicPagesInfo()) || [];',
        '  const page = pages.find(p => p.parentSchematicUuid === schemUuid) || null;',
        '  if (page && page.uuid) pageUuid = page.uuid;',
        '  if (!pageUuid) await new Promise(r => setTimeout(r, 300));',
        '}',
        'if (!pageUuid) return { ok: false, error: "原理图已创建但未找到页面（可能仍在处理中），schematicUuid: " + schemUuid };',
        '// 4. 打开并激活该页面',
        'let tabId = null;',
        'for (let _i = 0; _i < 10; _i++) {',
        '  try { tabId = await eda.dmt_EditorControl.openDocument(pageUuid); if (tabId) break; } catch {}',
        '  await new Promise(r => setTimeout(r, 300));',
        '}',
        '// 5. 验证当前文档已切换',
        'let cur = null;',
        'for (let _i = 0; _i < 10; _i++) {',
        '  cur = await eda.dmt_SelectControl.getCurrentDocumentInfo();',
        '  if (cur && cur.uuid === pageUuid) break;',
        '  await new Promise(r => setTimeout(r, 300));',
        '}',
        'return { ok: true, schematicUuid: schemUuid, pageUuid, tabId, activated: !!(cur && cur.uuid === pageUuid) };',
      ].join('\n');
      const { ok, result, error } = await runEda(bridge, code, { timeoutMs: 30_000 });
      return ok ? text(result) : text({ ok: false, error });
    },
  );

  // 16. 打开并激活文档（含轮询验证）
  server.registerTool(
    'easyeda_doc_open',
    {
      title: '打开并激活文档',
      description: '按文档 uuid 打开并激活（原理图页/PCB/封装等），自动轮询确认激活成功，返回 tabId 与文档类型。',
      inputSchema: z.object({
        uuid: z.string().describe('要打开的文档 uuid（来自 project_info / document_state / sch_list 等）'),
      }),
    },
    async ({ uuid }) => {
      const code = [
        `const target = ${J(uuid)};`,
        'let tabId = null;',
        'for (let _i = 0; _i < 10; _i++) {',
        '  try { tabId = await eda.dmt_EditorControl.openDocument(target); if (tabId) break; } catch {}',
        '  await new Promise(r => setTimeout(r, 300));',
        '}',
        'let cur = null;',
        'for (let _i = 0; _i < 10; _i++) {',
        '  cur = await eda.dmt_SelectControl.getCurrentDocumentInfo();',
        '  if (cur && cur.uuid === target) break;',
        '  await new Promise(r => setTimeout(r, 300));',
        '}',
        'return { ok: !!(cur && cur.uuid === target), tabId, uuid: target, documentType: cur ? cur.documentType : null };',
      ].join('\n');
      const { ok, result, error } = await runEda(bridge, code, { timeoutMs: 15_000 });
      if (ok && result?.documentType && typeof result.documentType === 'number') {
        result.documentTypeName = typeName(result.documentType);
      }
      return ok ? text(result) : text({ ok: false, error });
    },
  );

  // 17. 修改原理图器件（官方 SCH_PrimitiveComponent.modify，移动/旋转/改位号）
  server.registerTool(
    'easyeda_sch_modify',
    {
      title: '移动/旋转原理图元件或网络标记',
      description: '按 primitiveId 移动/旋转/改位号原理图元件，也能移动 VCC/GND 等网络标记（async 图元模式）。坐标默认 mm（自动换算 sch），可传 unit:"sch"。返回新坐标+bbox+引脚。',
      inputSchema: z.object({
        primitiveId: z.string().describe('器件图元 id（来自 easyeda_sch_list 的 id）'),
        x: z.number().optional().describe('新 X（单位见 unit，默认 mm）'),
        y: z.number().optional().describe('新 Y（单位见 unit，默认 mm）'),
        unit: z.enum(['mm', 'sch']).optional().describe('坐标单位（默认 mm）'),
        rotation: z.number().optional().describe('新旋转角度（0/90/180/270）'),
        designator: z.string().optional().describe('可选：新位号（如 R1 / U2）'),
      }),
    },
    async ({ primitiveId, x, y, unit = 'mm', rotation, designator }) => {
      const sx = x !== undefined ? (unit === 'mm' ? Units.round(Units.mmToSch(x)) : x) : undefined;
      const sy = y !== undefined ? (unit === 'mm' ? Units.round(Units.mmToSch(y)) : y) : undefined;
      // 用 async 图元模式（get→toAsync→setState→done）而非 sch_PrimitiveComponent.modify：
      // modify 只认普通元件（part 类型），网络标记（VCC/GND netflag）会被拒；async 模式对二者通用。
      const code = [
        `const raw = await eda.sch_PrimitiveComponent.get(${J(primitiveId)});`,
        // get 对 string 返回单个，对 array 返回数组——防御兼容两种形态
        'const prim = Array.isArray(raw) ? (raw[0] || null) : raw;',
        'if (!prim) return { ok: false, error: "图元不存在或不是可移动的元件/网络标记" };',
        'const ap = prim.toAsync();',
        sx !== undefined ? `ap.setState_X(${sx});` : null,
        sy !== undefined ? `ap.setState_Y(${sy});` : null,
        rotation !== undefined ? `ap.setState_Rotation(${rotation});` : null,
        designator !== undefined ? `ap.setState_Designator(${J(designator)});` : null,
        'await ap.done();',
        '// 返回移动后的新坐标 + 尺寸 bbox + 引脚（供布局检查/布线直接用）',
        'let info = null, bb = null, pins = [];',
        `try { const list = await eda.sch_PrimitiveComponent.getAll(); info = list.find(x => x.primitiveId === ${J(primitiveId)}) || null; } catch {}`,
        `try { bb = await eda.sch_Primitive.getPrimitivesBBox([${J(primitiveId)}]); } catch {}`,
        `try { pins = ((await eda.sch_PrimitiveComponent.getAllPinsByPrimitiveId(${J(primitiveId)})) || []).map(p => ({ number: p.pinNumber, name: p.pinName, x: p.x, y: p.y })); } catch {}`,
        `return { ok: true, primitiveId: ${J(primitiveId)}, x: info ? info.x : null, y: info ? info.y : null, rotation: info ? info.rotation : null, bbox: bb, pins };`,
      ].join('\n');
      const { ok, result, error } = await runEda(bridge, code);
      if (!ok) return text({ ok: false, error });
      if (result && result.bbox) result.bbox = normBBoxMinMax(result.bbox);
      return text(result);
    },
  );

  // 18. PCB DRC
  server.registerTool(
    'easyeda_pcb_drc',
    {
      title: '运行 PCB 设计规则检查',
      description: '对当前激活 PCB 运行 DRC。verbose=true 返回详细错误数组，否则返回是否通过。需先激活 PCB 文档，可能耗时较长。',
      inputSchema: z.object({
        verbose: z.boolean().optional().describe('可选：返回详细错误列表（默认 false 只返回是否通过）'),
        timeoutMs: z.number().optional().describe('可选：超时（默认 55000）'),
      }),
    },
    async ({ verbose = false, timeoutMs }) => {
      const code = [`const r = await eda.pcb_Drc.check(true, true, ${verbose ? 'true' : 'false'});`, 'return r;'].join('\n');
      const { ok, result, error } = await runEda(bridge, code, { timeoutMs: timeoutMs ?? 55_000, maxResultChars: 300_000 });
      return ok ? text({ ok: true, passed: verbose ? !(Array.isArray(result) && result.length > 0) : result === true, detail: result }) : text({ ok: false, error });
    },
  );

  // 18. PCB 读板概览（对齐官方 pcb_* 能力）
  server.registerTool(
    'easyeda_pcb_read',
    { title: '读取 PCB 概览', description: '返回当前激活 PCB 的板级信息：器件清单（位号/坐标/层）、网络列表、工程与文档状态（只读）。需先激活 PCB 文档。' },
    async () => {
      const code = [
        'const project = await eda.dmt_Project.getCurrentProjectInfo();',
        'const doc = await eda.dmt_SelectControl.getCurrentDocumentInfo();',
        'let comps = [], nets = [];',
        'try { comps = (await eda.pcb_PrimitiveComponent.getAll()) || []; } catch {}',
        'try { nets = (await eda.pcb_Net.getAllNetName()) || []; } catch {}',
        'return {',
        '  projectOpened: !!project,',
        '  documentType: doc ? doc.documentType : null,',
        '  componentCount: comps.length,',
        '  components: comps.slice(0, 50).map(c => ({ id: c.primitiveId, designator: c.designator, name: c.name, x: c.x, y: c.y, layer: c.layer })),',
        '  netCount: nets.length,',
        '  nets: nets.slice(0, 100),',
        '};',
      ].join('\n');
      const { ok, result, error } = await runEda(bridge, code);
      if (ok && result?.documentType && typeof result.documentType === 'number') result.documentTypeName = typeName(result.documentType);
      return ok ? text(result) : text({ ok: false, error });
    },
  );

  // 19. PCB 放件
  server.registerTool(
    'easyeda_pcb_place_component',
    {
      title: 'PCB 放置器件',
      description: '在当前 PCB 坐标 (x, y) 放置器件（需先从 easyeda_lib_search 拿器件 UUID）。坐标默认 mm（自动换算成 PCB mil），可传 unit:"mil"。需激活 PCB 文档。',
      inputSchema: z.object({
        deviceUuid: z.string().describe('器件 UUID（来自 easyeda_lib_search）'),
        libraryUuid: z.string().describe('器件所在库 UUID'),
        x: z.number().describe('X 坐标（单位见 unit，默认 mm）'),
        y: z.number().describe('Y 坐标（单位见 unit，默认 mm）'),
        layer: z.number().optional().describe('PCB 层号（默认 1 顶层，按 EPCB_Layer）'),
        unit: z.enum(['mm', 'mil']).optional().describe('坐标单位（默认 mm）'),
        rotation: z.number().optional().describe('旋转角度（默认 0）'),
      }),
    },
    async ({ deviceUuid, libraryUuid, x, y, layer = 1, unit = 'mm', rotation = 0 }) => {
      const sx = unit === 'mm' ? Units.round(Units.mmToMil(x)) : x;
      const sy = unit === 'mm' ? Units.round(Units.mmToMil(y)) : y;
      const code = [
        `const c = await eda.pcb_PrimitiveComponent.create({ libraryUuid: ${J(libraryUuid)}, uuid: ${J(deviceUuid)} }, ${layer}, ${sx}, ${sy}, ${rotation});`,
        'return c ? { ok: true, id: c.primitiveId, designator: c.designator, name: c.name, x: c.x, y: c.y, layer: c.layer } : { ok: false, error: "PCB 放置失败（返回 null）" };',
      ].join('\n');
      const { ok, result, error } = await runEda(bridge, code);
      return ok ? text(result) : text({ ok: false, error });
    },
  );

  // 20. LCSC 编号查器件
  server.registerTool(
    'easyeda_lib_get_by_lcsc',
    {
      title: '按立创商城编号查器件',
      description: '按立创商城 LCSC 编号（C 开头，如 C14663）查询器件，返回 name/uuid/libraryUuid/封装。',
      inputSchema: z.object({
        lcsc: z.string().describe('LCSC 编号（如 C14663）'),
        allowMultiMatch: z.boolean().optional().describe('允许返回多个匹配（默认 true）'),
      }),
    },
    async ({ lcsc, allowMultiMatch = true }) => {
      const code = [
        `const items = await eda.lib_Device.getByLcscIds([${J(lcsc)}], undefined, ${allowMultiMatch ? 'true' : 'false'});`,
        'return (items || []).map(d => ({ name: d.name, uuid: d.uuid, libraryUuid: d.libraryUuid, footprintName: d.footprintName, description: d.description }));',
      ].join('\n');
      const { ok, result, error } = await runEda(bridge, code);
      return ok ? text({ ok: true, count: Array.isArray(result) ? result.length : 0, items: result }) : text({ ok: false, error });
    },
  );

  // 21. 系统确认对话框（回调式 API → Promise 包装）
  server.registerTool(
    'easyeda_confirm',
    {
      title: '向用户弹出确认框',
      description: '在立创EDA 里弹出确认对话框，等用户点「确定/取消」并返回结果。用于破坏性操作（删除/覆盖/打开工程丢弃未保存等）前询问用户。',
      inputSchema: z.object({
        message: z.string().describe('确认内容（一句话说清要做什么）'),
        title: z.string().optional().describe('可选：对话框标题'),
      }),
    },
    async ({ message, title }) => {
      const code = [
        `const ok = await new Promise(res => { try { eda.sys_Dialog.showConfirmationMessage(${J(message)}, ${J(title ?? undefined)}, undefined, undefined, (main) => res(!!main)); } catch { res(false); } });`,
        'return { ok };',
      ].join('\n');
      const { ok, result, error } = await runEda(bridge, code, { timeoutMs: 20_000 });
      return ok ? text(result) : text({ ok: false, error });
    },
  );

  // 22. 新建工程
  server.registerTool(
    'easyeda_project_create',
    {
      title: '新建立创EDA 工程',
      description: '新建一个空白工程并返回工程 UUID。创建后可用 easyeda_project_open 打开。',
      inputSchema: z.object({
        name: z.string().describe('工程显示名'),
        description: z.string().optional().describe('可选：工程描述'),
      }),
    },
    async ({ name, description }) => {
      const code = [
        `const uuid = await eda.dmt_Project.createProject(${J(name)}, undefined, undefined, undefined, ${J(description ?? undefined)});`,
        'return { ok: !!uuid, projectUuid: uuid || null };',
      ].join('\n');
      const { ok, result, error } = await runEda(bridge, code);
      return ok ? text(result) : text({ ok: false, error });
    },
  );

  // 23. 保存当前文档
  server.registerTool(
    'easyeda_document_save',
    { title: '保存当前文档', description: '保存当前激活的 PCB/原理图文档（需先激活文档）。' },
    async () => {
      const code = [
        'const doc = await eda.dmt_SelectControl.getCurrentDocumentInfo();',
        'if (!doc) return { ok: false, error: "没有激活的文档" };',
        'let saved = false;',
        'if (doc.documentType === 3) { try { saved = await eda.pcb_Document.save(doc.uuid); } catch { saved = false; } }',
        'else if (doc.documentType === 1) { try { saved = await eda.sch_Document.save(); } catch { saved = false; } }',
        'else return { ok: false, error: "当前文档类型不支持保存（需 PCB 或原理图）" };',
        'return { ok: saved, documentType: doc.documentType };',
      ].join('\n');
      const { ok, result, error } = await runEda(bridge, code);
      return ok ? text(result) : text({ ok: false, error });
    },
  );

  // 24. PCB 网络列表
  server.registerTool(
    'easyeda_pcb_net',
    { title: '列出 PCB 网络', description: '返回当前 PCB 的全部网络名（最多 200 个）。' },
    async () => {
      const code = ['const nets = (await eda.pcb_Net.getAllNetName()) || [];', 'return { count: nets.length, nets: nets.slice(0, 200) };'].join('\n');
      const { ok, result, error } = await runEda(bridge, code);
      return ok ? text(result) : text({ ok: false, error });
    },
  );

  // 25. PCB 器件移动/旋转（async toAsync/setState/done 模式）
  server.registerTool(
    'easyeda_pcb_modify',
    {
      title: '移动/旋转 PCB 器件',
      description: '按 primitiveId 移动或旋转一个 PCB 器件（异步 toAsync/setState/done 模式）。坐标默认 mm。',
      inputSchema: z.object({
        primitiveId: z.string().describe('器件图元 id（来自 easyeda_pcb_read 的 components.id）'),
        x: z.number().optional().describe('新 X（mm）'),
        y: z.number().optional().describe('新 Y（mm）'),
        rotation: z.number().optional().describe('新旋转角度'),
      }),
    },
    async ({ primitiveId, x, y, rotation }) => {
      // 注意：桥端已把数值内联，EDA 作用域里没有 x/y/rotation 变量——不能写 `if (x !== undefined)` 守卫（会 ReferenceError）
      const code = [
        `const raw = await eda.pcb_PrimitiveComponent.get([${J(primitiveId)}]);`,
        // get 对 string 返回单个、对 array 返回数组——官方类型有两个重载，防御兼容（官方 SKILL 示例本身未处理）
        'const prim = Array.isArray(raw) ? (raw[0] || null) : raw;',
        'if (!prim) return { ok: false, error: "图元不存在" };',
        'const ap = prim.toAsync();',
        x !== undefined ? `ap.setState_X(${Units.round(Units.mmToMil(x))});` : null,
        y !== undefined ? `ap.setState_Y(${Units.round(Units.mmToMil(y))});` : null,
        rotation !== undefined ? `ap.setState_Rotation(${rotation});` : null,
        'await ap.done();',
        `return { ok: true, id: ${J(primitiveId)} };`,
      ].filter(Boolean).join('\n');
      const { ok, result, error } = await runEda(bridge, code);
      return ok ? text(result) : text({ ok: false, error });
    },
  );

  // 26. 导出 Gerber（BETA）
  server.registerTool(
    'easyeda_export_gerber',
    {
      title: '导出 Gerber 制造文件',
      description: '导出当前 PCB 的 Gerber（BETA，立创EDA 端触发导出）。需激活 PCB 文档，可能较慢。',
      inputSchema: z.object({ fileName: z.string().optional().describe('可选：文件名') }),
    },
    async ({ fileName }) => {
      const code = [`const r = await eda.pcb_ManufactureData.getGerberFile(${J(fileName ?? undefined)});`, 'return { exported: !!r, detail: r };'].join('\n');
      const { ok, result, error } = await runEda(bridge, code, { timeoutMs: 60_000, maxResultChars: 100_000 });
      return ok ? text({ ok: true, ...result }) : text({ ok: false, error });
    },
  );

  // 27. 导出 BOM（BETA）
  server.registerTool(
    'easyeda_export_bom',
    {
      title: '导出 BOM 清单',
      description: '导出当前 PCB/原理图的 BOM（xlsx 或 csv，BETA）。',
      inputSchema: z.object({
        fileName: z.string().optional().describe('可选：文件名'),
        fileType: z.enum(['xlsx', 'csv']).optional().describe('文件格式（默认 xlsx）'),
      }),
    },
    async ({ fileName, fileType = 'xlsx' }) => {
      const code = [`const r = await eda.pcb_ManufactureData.getBomFile(${J(fileName ?? undefined)}, ${J(fileType)});`, 'return { exported: !!r, detail: r };'].join('\n');
      const { ok, result, error } = await runEda(bridge, code, { timeoutMs: 60_000, maxResultChars: 100_000 });
      return ok ? text({ ok: true, ...result }) : text({ ok: false, error });
    },
  );

  // 28. 符号库搜索
  server.registerTool(
    'easyeda_lib_search_symbol',
    {
      title: '搜索符号库',
      description: '在立创EDA 符号库按关键词搜索符号。',
      inputSchema: z.object({
        keyword: z.string().describe('搜索关键词'),
        libraryUuid: z.string().optional().describe('可选：限定库'),
        pageSize: z.number().optional().describe('每页条数（默认 8，最大 20）'),
      }),
    },
    async ({ keyword, libraryUuid, pageSize = 8 }) => {
      const size = Math.min(Math.max(pageSize, 1), 20);
      const libExpr = libraryUuid ? J(libraryUuid) : 'undefined';
      const code = [
        `const items = await eda.lib_Symbol.search(${J(keyword)}, ${libExpr}, undefined, undefined, ${size}, 1);`,
        'return (items || []).map(s => ({ name: s.name, uuid: s.uuid, libraryUuid: s.libraryUuid, description: s.description }));',
      ].join('\n');
      const { ok, result, error } = await runEda(bridge, code);
      return ok ? text({ ok: true, count: Array.isArray(result) ? result.length : 0, items: result }) : text({ ok: false, error });
    },
  );

  // 29. 封装库搜索
  server.registerTool(
    'easyeda_lib_search_footprint',
    {
      title: '搜索封装库',
      description: '在立创EDA 封装库按关键词搜索封装。',
      inputSchema: z.object({
        keyword: z.string().describe('搜索关键词'),
        libraryUuid: z.string().optional().describe('可选：限定库'),
        pageSize: z.number().optional().describe('每页条数（默认 8，最大 20）'),
      }),
    },
    async ({ keyword, libraryUuid, pageSize = 8 }) => {
      const size = Math.min(Math.max(pageSize, 1), 20);
      const libExpr = libraryUuid ? J(libraryUuid) : 'undefined';
      const code = [
        `const items = await eda.lib_Footprint.search(${J(keyword)}, ${libExpr}, undefined, ${size}, 1);`,
        'return (items || []).map(f => ({ name: f.name, uuid: f.uuid, libraryUuid: f.libraryUuid, description: f.description }));',
      ].join('\n');
      const { ok, result, error } = await runEda(bridge, code);
      return ok ? text({ ok: true, count: Array.isArray(result) ? result.length : 0, items: result }) : text({ ok: false, error });
    },
  );

  // 30. 截图（BETA，返回 base64；MCP 结果有大小上限，超大画面会被截断）
  server.registerTool(
    'easyeda_screenshot',
    { title: '截取 EDA 画面', description: '截取当前 EDA 画布区域，返回 base64 图片（BETA；超大画面会被截断，建议缩小视图）。' },
    async () => {
      const code = [
        'const blob = await eda.dmt_EditorControl.getCurrentRenderedAreaImage();',
        'if (!blob) return { ok: false, error: "无法获取画面（BETA 接口可能不可用）" };',
        'const bytes = new Uint8Array(await blob.arrayBuffer());',
        'let bin = ""; const CHUNK = 0x8000;',
        'for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));',
        'const b64 = btoa(bin);',
        'return { ok: true, mime: blob.type || "image/png", base64: b64.slice(0, 60000), truncated: b64.length > 60000, length: b64.length };',
      ].join('\n');
      const { ok, result, error } = await runEda(bridge, code, { timeoutMs: 20_000, maxResultChars: 80_000 });
      return ok ? text(result) : text({ ok: false, error });
    },
  );
}

// ─── 启动 ────────────────────────────────────────────────────
async function main() {
  const args = parseArgs(process.argv.slice(2));
  const docsPath = resolveDocIndex(args.docs);
  if (!docsPath) {
    console.error('[easyeda] 未找到 docs/index.json，请确认插件目录完整');
    process.exit(1);
  }

  const bridge = new Bridge({
    portRange: args.port ? [args.port, args.port] : args.portRange,
    token: args.token,
  });

  let port;
  try {
    port = await bridge.start();
  }
  catch (err) {
    console.error(`[easyeda] 桥启动失败: ${err.message}`);
    process.exit(1);
  }
  console.error(`[easyeda] 桥已启动：127.0.0.1:${port}（service=${SERVICE_ID}，token配置=${bridge.configuredToken ? '是' : '否'}）`);

  const server = new McpServer({ name: 'easyeda-toolchain', version: '0.1.0' });
  registerTools(server, bridge, docsPath);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // 优雅退出：TrieCode 关 MCP → stdin 关闭 / 信号 → 通知 EDA 扩展后退出
  let shuttingDown = false;
  const shutdown = async (reason) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error(`[easyeda] 收到关闭信号（${reason}），通知 EDA 扩展…`);
    await bridge.stop('mcp-shutdown');
    setTimeout(() => process.exit(0), 1500).unref?.();
    try { await server.close(); } catch { /* ignore */ }
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  if (process.stdin) {
    process.stdin.on('end', () => void shutdown('stdin end'));
    process.stdin.on('close', () => void shutdown('stdin close'));
  }
}

main().catch((err) => {
  console.error(`[easyeda] 启动失败: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
});
