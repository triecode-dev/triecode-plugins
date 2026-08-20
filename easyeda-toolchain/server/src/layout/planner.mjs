/**
 * 布局规划器 —— 5 阶段确定性编排（超越所有参考）
 *
 * Phase 0 数据归一化（bbox→rect、pin→相对、分类）
 * Phase 1 初始铺散（central-lr 中央芯片 / functional-zones 功能分区）
 * Phase 2 贴脚细化（solveAnchors attach + flow + pair）
 * Phase 3 网络标签防重叠（planLabels）
 * Phase 4 合法化兜底（占用图 + findFreeSpot）
 * Phase 5 同尺验证（verifyPlacements → violations）
 *
 * 输入 components：{id, designator, x, y, rotation, net, bbox:{minX,minY,maxX,maxY}|null, pins:[{number,name,x,y}]}
 * 输出：{placements:[{id,designator,x,y,rotation}], violations, notes, pages}
 */
import { rectFromMinMax, pointInsideRect, inflateRect } from './geometry.mjs';
import { classifyComponent, lintLayout } from './lint.mjs';
import { solveAnchors, solveFlows, solvePairs } from './attach.mjs';
import { planZones } from './zones.mjs';
import { planCentralLR } from './central-lr.mjs';
import { planLabels } from './labels.mjs';
import { findFreeSpot, spiralSearch } from './occupancy.mjs';
import { estimateComponentBox } from './bbox.mjs';

const DEFAULT_CLEARANCE = 5;

// ─── 组件模型 ────────────────────────────────────────────────
function buildModel(components) {
  return components.map((c) => {
    const x = c.x ?? 0;
    const y = c.y ?? 0;
    let rect = c.bbox ? rectFromMinMax(c.bbox.minX, c.bbox.minY, c.bbox.maxX, c.bbox.maxY) : null;
    // getPrimitivesBBox 失败兜底：从引脚估算本体（autodraw 思路）
    if (!rect && (c.pins || []).length) {
      const est = estimateComponentBox(c.pins, { x, y });
      if (est) rect = { x: est.x, y: est.y, w: est.w, h: est.h };
    }
    return {
      id: c.id,
      designator: c.designator || '',
      name: c.name,
      x,
      y,
      rotation: c.rotation ?? 0,
      net: c.net || null,
      kind: classifyComponent({ designator: c.designator, net: c.net }),
      origX: x,
      origY: y,
      bboxRel: rect ? { dx: rect.x - x, dy: rect.y - y, w: rect.w, h: rect.h } : null,
      pinRels: (c.pins || []).map((p) => ({
        number: p.number,
        name: p.name,
        dx: (p.x ?? 0) - x,
        dy: (p.y ?? 0) - y,
        net: p.net || null,
      })),
    };
  });
}

function absBBox(comp) {
  return comp.bboxRel ? { x: comp.x + comp.bboxRel.dx, y: comp.y + comp.bboxRel.dy, w: comp.bboxRel.w, h: comp.bboxRel.h } : null;
}

function absPins(comp) {
  return comp.pinRels.map((p) => ({ number: p.number, name: p.name, x: comp.x + p.dx, y: comp.y + p.dy }));
}

/** 求解器格式（当前绝对几何） */
function solverFormat(comp) {
  return {
    id: comp.id,
    designator: comp.designator,
    x: comp.x,
    y: comp.y,
    rotation: comp.rotation,
    net: comp.net,
    bbox: absBBox(comp),
    pins: absPins(comp),
  };
}

function applyPlacements(comps, placements) {
  const byId = new Map(placements.map((p) => [p.id, p]));
  for (const c of comps) {
    const p = byId.get(c.id);
    if (p) {
      c.x = p.x;
      c.y = p.y;
      if (p.rotation !== undefined) c.rotation = p.rotation;
    }
  }
}

function toOutput(comp) {
  return { id: comp.id, designator: comp.designator, x: comp.x, y: comp.y, rotation: comp.rotation };
}

/** 两矩形最近可穿方向的间隙：轴向重叠则取另一轴间隙；对角取最窄方向；重叠返回 -1 */
function partGap(a, b) {
  const xGap = Math.max(b.x - (a.x + a.w), a.x - (b.x + b.w));
  const yGap = Math.max(b.y - (a.y + a.h), a.y - (b.y + b.h));
  const ox = xGap < 0;
  const oy = yGap < 0;
  if (ox && oy) return -1;
  if (ox) return yGap; // 垂直堆叠 → 线水平穿过
  if (oy) return xGap; // 水平并排 → 线垂直穿过
  return Math.min(xGap, yGap);
}

const NET_SCORE = (net) => {
  const n = String(net || '').toUpperCase();
  if (/^(GND|VSS|0V)$/.test(n)) return 0;
  if (/^(VCC|VDD|\+[0-9A-Z.]*V|-?[0-9.]+V)$/.test(n)) return 1;
  return 2; // 信号网优先
};

/**
 * 无网表连通性推断（真实 EDA getNetlistFile 常失败，网表不可用时的兜底）：
 * 用网络标记的 net（getState_Net 对标记组件可用）反推相邻引脚的网络名。
 * 标记的连接点 (x,y) 与某引脚坐标距离 < 阈值 → 该引脚 net = 标记 net。
 * @param {Array} comps 内部模型（含 pinRels、net）
 * @param {number} [tol] 相邻距离阈值（sch）
 */
function inferPinNetsFromFlags(comps, tol = 12) {
  // 找到网络标记（kind=netflag）的连接点 + net
  const flags = comps.filter((c) => c.kind === 'netflag' && c.net && Number.isFinite(c.x) && Number.isFinite(c.y));
  const flagPins = flags.map((f) => ({ x: f.x, y: f.y, net: f.net }));
  if (!flagPins.length) return;
  for (const c of comps) {
    if (c === flags[0] || (c.kind !== 'part')) continue;
    for (const pin of (c.pinRels || [])) {
      if (pin.net) continue; // 已有网表给的 net
      const px = c.x + pin.dx;
      const py = c.y + pin.dy;
      let best = null;
      let bestD = tol;
      for (const f of flagPins) {
        const d = Math.hypot(px - f.x, py - f.y);
        if (d < bestD) { bestD = d; best = f; }
      }
      if (best) pin.net = best.net;
    }
  }
}

/**
 * 从网表连通性自动推断贴脚意图（AI 没给 anchors 时的兜底）。
 * 泛化 IC 分簇：每个多引脚器件（≥3 脚，视为 IC/宿主）为种子，把与它共享网络的
 * 2 脚无源件归入它的簇并贴到对应引脚：
 * - 优先信号网（如 C3 pin1 连 RST → 贴 U1.RST）
 * - 只有电源网则贴非 GND 电源脚（如 C4 连 +5V/GND → 贴 U1.VCC，不贴 GND）
 * - 一个无源件只生成一个锚点（其余脚靠导线接）；已归簇的不重复归
 * @param {Array} comps 内部模型（含 pinRels[].net）
 * @param {string} [coreDesignator] 可选：优先用此核心；缺省按全部多引脚器件
 * @returns {Array<{s,p,t,tp}>}
 */
function autoDetectAnchors(comps, coreDesignator) {
  const hosts = coreDesignator
    ? [comps.find((c) => c.designator === coreDesignator)].filter(Boolean)
    : comps.filter((c) => c.kind === 'part' && (c.pinRels || []).length >= 3);
  if (!hosts.length) return [];
  const anchors = [];
  const anchored = new Set();
  for (const host of hosts) {
    const hostPinByNet = new Map();
    for (const cp of host.pinRels || []) {
      if (cp.net && !hostPinByNet.has(cp.net)) hostPinByNet.set(cp.net, cp);
    }
    for (const c of comps) {
      if (c === host || anchored.has(c.designator)) continue;
      const pins = c.pinRels || [];
      if (pins.length !== 2) continue; // 只处理 2 脚无源件
      const connected = [];
      for (const pin of pins) {
        const cp = pin.net ? hostPinByNet.get(pin.net) : null;
        if (cp) connected.push({ pin, cp });
      }
      if (!connected.length) continue;
      connected.sort((a, b) => NET_SCORE(b.cp.net) - NET_SCORE(a.cp.net));
      const best = connected[0];
      const cpRef = best.cp.number || best.cp.name;
      const pinRef = best.pin.number || best.pin.name;
      if (!cpRef || !pinRef) continue;
      anchors.push({ s: c.designator, p: pinRef, t: host.designator, tp: cpRef });
      anchored.add(c.designator);
    }
  }
  return anchors;
}

// ─── 主入口 ─────────────────────────────────────────────────
export function planLayout(input) {
  const { components = [], intent = {}, sheet = null } = input;
  const clearance = intent.layout?.clearance ?? DEFAULT_CLEARANCE;
  const keepSet = new Set(intent.layout?.keepDesignators || []);
  const mode = intent.mode || 'rearrange';
  const notes = [];
  const comps = buildModel(components);
  const usable = sheet ? { x: sheet.x ?? 0, y: sheet.y ?? 0, w: sheet.w ?? 1200, h: sheet.h ?? 800 } : null;

  const placements = new Map();

  // Phase 1 初始铺散（网络标记不铺散——由 Phase 3 处理）
  // 先算自动推断贴脚：若 central-lr 却无锚（网表读不到连通性），兜底 functional-zones
  // 避免把全部外设堆在核心右侧一列
  const flagIds = new Set(comps.filter((c) => c.kind === 'netflag').map((c) => c.id));
  // 无网表连通性兜底：用网络标记 net 反推相邻引脚（真实 EDA getNetlistFile 常失败）
  inferPinNetsFromFlags(comps);
  const explicitAnchors0 = intent.anchors || [];
  // IC 分簇：central-lr 用指定核心，其余模式按全部多引脚器件自动归簇
  const autoAnchors0 = !explicitAnchors0.length
    ? autoDetectAnchors(comps, mode === 'central-lr' ? intent.core : undefined)
    : [];
  const effectiveMode = mode === 'central-lr' && !explicitAnchors0.length && !autoAnchors0.length
    ? 'functional-zones'
    : mode;
  const modeUsed = effectiveMode;
  if (mode !== effectiveMode) notes.push('网表连通性不可用，自动改用功能分区布局（避免外设堆成一列）');
  if (effectiveMode === 'central-lr') {
    const anchored = new Set((intent.anchors || []).map((a) => a.s));
    const result = planCentralLR(comps.map(solverFormat), intent.core, {
      usable,
      clearance,
      fixed: keepSet,
      skip: new Set([...anchored, ...flagIds]),
    });
    notes.push(...(result.notes || []));
    for (const p of result.placements) placements.set(p.id, p);
  } else if (effectiveMode === 'functional-zones') {
    const result = planZones(
      comps.filter((c) => !flagIds.has(c.id)).map(solverFormat),
      { fixed: keepSet, pageRect: usable },
    );
    notes.push(...(result.unplaced || []).map((d) => `铺散未放置: ${d}`));
    for (const p of result.placements) placements.set(p.id, p);
  } else {
    // rearrange：原位，记录当前位姿（供后续细化）
    for (const c of comps) placements.set(c.id, toOutput(c));
  }

  applyPlacements(comps, [...placements.values()]);

  // Phase 2 贴脚细化（autoAnchors 已在 Phase 1 前算好）
  const explicitAnchors = intent.anchors || [];
  const autoAnchors = autoAnchors0;
  if (autoAnchors.length) notes.push(`自动推断贴脚 ${autoAnchors.length} 条（按网表连通性）`);
  const allAnchors = [...explicitAnchors, ...autoAnchors];
  const anchoredSet = new Set(allAnchors.map((a) => a.s));
  const flowGroups = (intent.groups || []).filter((g) => g.kind === 'flow');
  const pairGroups = (intent.groups || []).filter((g) => g.kind === 'pair');

  if (allAnchors.length) {
    const r = solveAnchors(comps.map(solverFormat), allAnchors, { clearance, usable });
    notes.push(...(r.notes || []).map((n) => `贴脚: ${n}`));
    for (const p of r.placements) placements.set(p.id, p);
  }
  if (flowGroups.length) {
    const r = solveFlows(comps.map(solverFormat), flowGroups, { clearance, usable, spacing: intent.layout?.spacing ?? 8 });
    notes.push(...(r.notes || []));
    for (const p of r.placements) placements.set(p.id, p);
  }
  if (pairGroups.length) {
    const r = solvePairs(comps.map(solverFormat), pairGroups, { clearance, usable, spacing: intent.layout?.spacing ?? 8 });
    notes.push(...(r.notes || []));
    for (const p of r.placements) placements.set(p.id, p);
  }
  applyPlacements(comps, [...placements.values()]);

  // Phase 3 网络标签防重叠
  const flags = comps.filter((c) => c.kind === 'netflag');
  const parts = comps.filter((c) => c.kind === 'part');
  if (flags.length) {
    // 标记跟随所属引脚：按「初始最近引脚」把标记随宿主器件一起平移，保持标签就近连接点
    const dirOverride = new Map((intent.netFlags || []).map((nf) => [nf.net, nf.dir]));
    const flagInputs = flags.map((f) => {
      // 找初始位置最近的 part 引脚
      let best = null;
      let bestD = Infinity;
      for (const p of parts) {
        for (const pin of p.pinRels) {
          const px = p.origX + pin.dx;
          const py = p.origY + pin.dy;
          const d = Math.hypot(px - f.origX, py - f.origY);
          if (d < bestD) {
            bestD = d;
            best = { part: p, pin };
          }
        }
      }
      // 期望位置：连接点对准新引脚（标记随宿主平移，图形偏移由 bboxRel 处理）
      let dx = 0;
      let dy = 0;
      if (best && bestD < 120) {
        const b = best;
        const oldPinX = b.part.origX + b.pin.dx;
        const oldPinY = b.part.origY + b.pin.dy;
        const newPinX = b.part.x + b.pin.dx;
        const newPinY = b.part.y + b.pin.dy;
        dx += newPinX - oldPinX;
        dy += newPinY - oldPinY;
      }
      return {
        ...solverFormat(f),
        _desiredX: f.origX + dx,
        _desiredY: f.origY + dy,
        _dirOverride: dirOverride.get(f.net),
      };
    });
    const r = planLabels(flagInputs, parts.map(absBBox).filter(Boolean), { usable, clearance });
    notes.push(...(r.notes || []).map((n) => `标记: ${n}`));
    for (const p of r.placements) placements.set(p.id, p);
  }
  applyPlacements(comps, [...placements.values()]);

  // Phase 4 合法化兜底：仍有重叠的非锚定件，尝试就近找空位
  // 仅在确有放置意图时执行（纯 rearrange 检查不挪任何件）
  // 核心（central-lr 的 core）与已锚定件永不在此被移动——锚点关系优先
  const hasPlacementIntent = mode !== 'rearrange' || (intent.anchors?.length) || (intent.groups?.length);
  const coreD = effectiveMode === 'central-lr' ? intent.core : null;
  const overlapPairs = [];
  if (hasPlacementIntent) {
    for (let i = 0; i < comps.length; i++) {
      for (let j = i + 1; j < comps.length; j++) {
        const a = absBBox(comps[i]);
        const b = absBBox(comps[j]);
        if (a && b && a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y) {
          overlapPairs.push([comps[i], comps[j]]);
        }
      }
    }
  }
  for (const [c1, c2] of overlapPairs) {
    // 优先移较小的件（保留大件/芯片不动）
    const movableList = [c1, c2].filter(
      (c) =>
        c.kind === 'part' &&
        !keepSet.has(c.designator) &&
        !anchoredSet.has(c.designator) &&
        c.designator !== coreD,
    );
    const area = (c) => {
      const bb = absBBox(c);
      return bb ? bb.w * bb.h : Infinity;
    };
    const movable = movableList.length === 2
      ? (area(movableList[0]) <= area(movableList[1]) ? movableList[0] : movableList[1])
      : movableList[0];
    if (!movable) continue;
    const others = comps.filter((c) => c !== movable);
    const busy = others.map(absBBox).filter(Boolean);
    const bb = absBBox(movable);
    if (!bb) continue;
    // 以**本体**为基准找空位（膨胀 clearance），再反推锚点（与 central-lr 同法）
    const size = { w: bb.w + clearance * 2, h: bb.h + clearance * 2 };
    const spot = findFreeSpot({ x: bb.x, y: bb.y }, size, busy, usable, {
      preference: 'center',
      grid: 5,
      step: 40,
    });
    if (spot) {
      const rel = movable.bboxRel;
      const anchorX = spot.x + clearance - rel.dx;
      const anchorY = spot.y + clearance - rel.dy;
      const r = { id: movable.id, designator: movable.designator, x: anchorX, y: anchorY, rotation: movable.rotation };
      // 立即更新模型，避免后续 pair 用陈旧位置（findFreeSpot 对全体 others 保证不新重叠）
      movable.x = anchorX;
      movable.y = anchorY;
      placements.set(movable.id, r);
      notes.push(`合法化: ${movable.designator} 就近移开至 (${anchorX},${anchorY})`);
    } else {
      notes.push(`合法化: ${movable.designator} 无法就近移开（保持，lint 会标记）`);
    }
  }
  // 标记合法化：标记压器件本体 OR 器件引脚压标记 → 就近移开（只移标记，不动器件）
  if (hasPlacementIntent) {
    const flagComps = comps.filter((c) => c.kind === 'netflag');
    const partComps = comps.filter((c) => c.kind === 'part');
    const partBodies = partComps.map(absBBox).filter(Boolean);
    // 器件引脚绝对点（引脚可能伸出本体压到标记图形）
    const partPinPoints = partComps.flatMap((c) => absPins(c).filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y)).map((p) => ({ x: p.x, y: p.y })));
    for (const f of flagComps) {
      const fb = absBBox(f);
      if (!fb) continue;
      // 双向同尺判定（lint 判定 = 生成判定）：
      //  ① 标记本体压器件本体  ② 器件引脚点压标记本体
      const hitBody = partBodies.some((b) => b.x < fb.x + fb.w + clearance && fb.x < b.x + b.w + clearance && b.y < fb.y + fb.h + clearance && fb.y < b.y + b.h + clearance);
      const hitPin = partPinPoints.some((p) => pointInsideRect(p.x, p.y, inflateRect(fb, 2)));
      if (!hitBody && !hitPin) continue;
      const others = comps.filter((c) => c !== f);
      const busy = others.map(absBBox).filter(Boolean);
      const size = { w: fb.w + clearance * 2, h: fb.h + clearance * 2 };
      // 螺旋就近搜索（保持贴近引脚，不跳角落）
      const spot = spiralSearch(fb.x, fb.y, size, busy, usable, { step: 20, maxRadius: 400, grid: 5 });
      if (spot) {
        const rel = f.bboxRel;
        f.x = spot.x + clearance - rel.dx;
        f.y = spot.y + clearance - rel.dy;
        placements.set(f.id, { id: f.id, designator: f.designator, x: f.x, y: f.y, rotation: f.rotation || 0 });
        notes.push(`标记合法化: ${f.net || f.id} 移开`);
      }
    }
  }
  applyPlacements(comps, [...placements.values()]);

  // Phase 5 同尺验证 —— 用内部模型的最终绝对 bbox（与 lint 同尺，杜绝格式不一致假通过）
  const outPlacements = [...placements.values()];
  const finalLint = lintLayout(
    comps.map((c) => ({
      id: c.id,
      designator: c.designator,
      x: c.x,
      y: c.y,
      net: c.net,
      bbox: absBBox(c),
      pins: absPins(c).map((p) => ({ x: p.x, y: p.y, net: p.net, number: p.number, name: p.name })),
    })),
    { clearance },
  );
  const outOfSheet = [];
  if (usable) {
    for (const c of comps) {
      const bb = absBBox(c);
      if (bb && (bb.x < usable.x || bb.y < usable.y || bb.x + bb.w > usable.x + usable.w || bb.y + bb.h > usable.y + usable.h)) {
        outOfSheet.push({ designator: c.designator || c.id });
      }
    }
  }
  // 通道校验：相邻 part 间隙 < 阈值 → 布线会被堵死，报 routing-blocked 让 AI 先疏散
  const ROUTING_CHANNEL = 12;
  const partList = comps.filter((c) => c.kind === 'part').map((c) => ({ c, bbox: absBBox(c) })).filter((x) => x.bbox);
  const routingBlocked = [];
  for (let i = 0; i < partList.length; i++) {
    for (let j = i + 1; j < partList.length; j++) {
      const a = partList[i];
      const b = partList[j];
      const gap = partGap(a.bbox, b.bbox);
      if (gap < ROUTING_CHANNEL) {
        routingBlocked.push({ a: a.c.designator, b: b.c.designator, gap: Math.round(gap * 10) / 10 });
      }
    }
  }
  const violations = {
    ok: finalLint.overlaps.length === 0 && finalLint.netflagsInsideParts.length === 0 && finalLint.pinOverlaps.length === 0 && outOfSheet.length === 0,
    overlaps: finalLint.overlaps,
    netflagsInsideParts: finalLint.netflagsInsideParts,
    pinOverlaps: finalLint.pinOverlaps,
    outOfSheet,
    routingBlocked,
  };

  return {
    placements: outPlacements,
    violations,
    notes,
    mode: effectiveMode,
    movedCount: comps.filter((c) => {
      const orig = components.find((o) => o.id === c.id);
      return orig && (orig.x !== c.x || orig.y !== c.y || (orig.rotation ?? 0) !== c.rotation);
    }).length,
  };
}
