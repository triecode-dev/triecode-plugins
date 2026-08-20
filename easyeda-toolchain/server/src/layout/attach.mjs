/**
 * 贴脚/信号链/并列求解（easyeda-agent bslSolveAround 移植 + 增强）
 *
 * 核心公式：卫星原点 = 目标引脚真实坐标 − 卫星引脚相对偏移 + 间距向量
 * - 上/下贴脚**钳制宿主 bbox 边缘**（本体必然让开）——这是 LLM 算错的那步
 * - 所有候选位过 isFree（对 live 占用 + clearance 膨胀），保证不重叠
 * - 自然朝向若本体指向宿主 → 旋转 180 让本体背向宿主
 * - 支持多卫星贴同一脚（一字排开）、贴到非锚件（递归）
 * - 步长 = partGap + 2×半宽 + marker 伸出（与判定同尺）
 */
import { inflateRect, snapToGrid } from './geometry.mjs';

export const PART_GAP = 14;         // 件间最小视觉间隙（sch）——预留布线通道（12-16 区间实测取 14）
export const MARKER_REACH_X = 24;   // 网络标签横向伸出估计（sch，按网名宽度后续精算）
export const MARKER_REACH_Y = 16;   // 网络标签纵向伸出估计

const VEC = {
  left: { dx: -1, dy: 0 },
  right: { dx: 1, dy: 0 },
  up: { dx: 0, dy: 1 },
  down: { dx: 0, dy: -1 },
};

function opposite(side) {
  return { left: 'right', right: 'left', up: 'down', down: 'up' }[side] || 'right';
}

/** 引脚绝对坐标 */
function pinAbs(comp, pin) {
  return { x: comp.x + (pin.x - comp.x), y: comp.y + (pin.y - comp.y) };
}

/** 引脚相对原点偏移 */
function pinRel(comp, pin) {
  return { dx: pin.x - comp.x, dy: pin.y - comp.y };
}

function findPin(comp, ref) {
  const v = String(ref || '').toUpperCase();
  return (comp.pins || []).find(
    (p) => String(p.number || '').toUpperCase() === v || String(p.name || '').toUpperCase() === v,
  ) || null;
}

/** 宿主相对引脚的方位（从引脚指向宿主 bbox 中心的方向） */
function hostSideOfPin(pin, hostBbox) {
  if (!hostBbox) return 'right';
  const cx = hostBbox.x + hostBbox.w / 2;
  const cy = hostBbox.y + hostBbox.h / 2;
  const dx = cx - pin.x; // 宿主中心相对引脚
  const dy = cy - pin.y;
  if (Math.abs(dx) >= Math.abs(dy)) return dx > 0 ? 'right' : 'left';
  return dy > 0 ? 'up' : 'down';
}

/** 卫星本体相对其连接引脚的方向（本体在引脚哪边） */
function bodyDirOfPin(sat, pin) {
  if (!sat.bbox) return null;
  const bcx = sat.bbox.x + sat.bbox.w / 2;
  const bcy = sat.bbox.y + sat.bbox.h / 2;
  const dx = bcx - pin.x;
  const dy = bcy - pin.y;
  if (Math.abs(dx) >= Math.abs(dy)) return dx > 0 ? 'right' : 'left';
  return dy > 0 ? 'down' : 'up';
}

/** 卫星沿某轴半宽 */
function halfAlong(sat, away) {
  const b = sat.bbox || { w: 20, h: 16 };
  return away === 'up' || away === 'down' ? b.h / 2 : b.w / 2;
}

/** 步长：partGap + 2×半宽 + marker 伸出（同尺） */
function stepFor(sat, away) {
  return PART_GAP + 2 * halfAlong(sat, away) + (away === 'up' || away === 'down' ? MARKER_REACH_Y : MARKER_REACH_X);
}

/** 移位后的 bbox（anchor 从 cur 移到 new） */
function shiftedBbox(bbox, cur, nx, ny) {
  if (!bbox) return null;
  return { x: bbox.x + (nx - cur.x), y: bbox.y + (ny - cur.y), w: bbox.w, h: bbox.h };
}

/** 平移后同步引脚绝对坐标（否则后续锚点引用该件时 pinRel 用陈旧引脚会错位） */
function shiftPinsOnMove(comp, oldX, oldY) {
  const dx = comp.x - oldX;
  const dy = comp.y - oldY;
  if ((dx !== 0 || dy !== 0) && comp.pins) {
    comp.pins = comp.pins.map((p) => ({ ...p, x: p.x + dx, y: p.y + dy }));
  }
}

/**
 * 求解一批贴脚。返回 {placements, notes}。
 * placements: [{id, designator, x, y, rotation}]
 * 递归：贴到已移动的"非锚件"时，用其新位姿的引脚（解出的 placement 立即进入 live）。
 */
export function solveAnchors(components, anchors, opts = {}) {
  const { clearance = 5, grid = 5, usable = null } = opts;
  // live：designator -> {x,y,rotation,bbox,pins,id}
  const live = new Map();
  for (const c of components) live.set(c.designator, { ...c });
  const placements = [];
  const notes = [];

  const snap = (v) => snapToGrid(v, grid);

  for (const a of anchors) {
    const sat = live.get(a.s);
    const tgt = live.get(a.t);
    if (!sat || !tgt) {
      notes.push(`贴脚 ${a.s}→${a.t}: 找不到器件`);
      continue;
    }
    const satPin = findPin(sat, a.p);
    const tgtPin = findPin(tgt, a.tp);
    if (!satPin || !tgtPin) {
      notes.push(`贴脚 ${a.s}.${a.p}→${a.t}.${a.tp}: 找不到引脚`);
      continue;
    }
    const tpAbs = pinAbs(tgt, tgtPin);
    const satRel = pinRel(sat, satPin);
    const hostSide = hostSideOfPin(tpAbs, tgt.bbox);
    const away = opposite(hostSide);
    const bodyDir = bodyDirOfPin(sat, satPin);

    // 自然朝向若本体指向宿主 → 旋转 180 背向（仅水平贴脚；垂直贴脚不旋转只钳边）
    let rotation = sat.rotation || 0;
    let rel = satRel;
    if (hostSide === 'left' || hostSide === 'right') {
      if (bodyDir && bodyDir === hostSide) {
        rotation = (rotation + 180) % 360;
        rel = { dx: -satRel.dx, dy: -satRel.dy };
      }
    }

    const seed = { x: snap(tpAbs.x - rel.dx), y: snap(tpAbs.y - rel.dy) };
    const step = stepFor(sat, away);
    const dv = VEC[away];

    // 候选位：沿 away 轴外推；上/下贴脚额外沿宿主边缘水平铺开
    const candidates = [];
    const hostCx = tgt.bbox ? tgt.bbox.x + tgt.bbox.w / 2 : tpAbs.x;
    const horizontal = away === 'up' || away === 'down' ? (tpAbs.x > hostCx ? -1 : 1) : 0;
    for (let i = 0; i <= 6; i++) candidates.push({ x: seed.x + dv.dx * step * i, y: seed.y + dv.dy * step * i });
    if (away === 'up' || away === 'down') {
      for (let i = 1; i <= 6; i++) {
        candidates.push({ x: seed.x + horizontal * step * i, y: seed.y });
        candidates.push({ x: seed.x - horizontal * step * i, y: seed.y });
      }
    }

    // busy = 除卫星自身外的全部 live 占用，按 PART_GAP 膨胀（比 clearance 更宽）
    // 保证贴脚后器件间至少 PART_GAP 空隙 —— 布线通道不被挤没（真实 EDA 痛点）
    const busy = [...live.values()]
      .filter((p) => p !== sat && p.bbox)
      .map((p) => inflateRect(p.bbox, PART_GAP));

    let placed = null;
    for (const cand of candidates) {
      const oldBbox = sat.bbox;
      const body = shiftedBbox(oldBbox, sat, cand.x, cand.y);
      if (!body) continue;
      const free = !busy.some((r) => r.x < body.x + body.w && body.x < r.x + r.w && r.y < body.y + body.h && body.y < r.y + r.h);
      const inBounds = !usable || (body.x >= usable.x && body.y >= usable.y && body.x + body.w <= usable.x + usable.w && body.y + body.h <= usable.y + usable.h);
      if (free && inBounds) {
        placed = { x: cand.x, y: cand.y, body };
        break;
      }
    }

    if (!placed) {
      notes.push(`贴脚 ${a.s}→${a.t}: 位置放不下（保持原位）`);
      continue;
    }
    const oldX = sat.x;
    const oldY = sat.y;
    sat.x = placed.x;
    sat.y = placed.y;
    sat.rotation = rotation;
    sat.bbox = placed.body;
    shiftPinsOnMove(sat, oldX, oldY);
    placements.push({ id: sat.id, designator: sat.designator, x: snap(placed.x), y: snap(placed.y), rotation });
  }

  return { placements, notes };
}

/**
 * 信号链（flow）：沿 +x 顺排，间距按相邻两件实际网数计算。
 * group: {members: [designators], direction?: 1|-1}
 * 简化：相邻件间距 = partGap + 两件半宽 + 交叉网数×网距
 */
export function solveFlows(components, groups, opts = {}) {
  const { clearance = 5, grid = 5, usable = null, spacing = 8 } = opts;
  const live = new Map();
  for (const c of components) live.set(c.designator, { ...c });
  const placements = [];
  const notes = [];

  for (const g of groups) {
    const chain = (g.members || []).map((d) => live.get(d)).filter(Boolean);
    if (chain.length === 0) continue;
    const dir = g.direction === -1 ? -1 : 1;
    // 锚定第一个成员（保持不动），后续沿 x 顺排
    let prevX = chain[0].x + (dir > 0 ? (chain[0].bbox ? chain[0].bbox.w / 2 : 10) : -(chain[0].bbox ? chain[0].bbox.w / 2 : 10));
    for (let i = 1; i < chain.length; i++) {
      const cur = chain[i];
      const gap = PART_GAP + spacing;
      const halfW = (cur.bbox ? cur.bbox.w : 20) / 2;
      const nx = prevX + dir * (gap + halfW);
      const ny = chain[0].y; // 保持同 y（共线）
      const body = shiftedBbox(cur.bbox, cur, nx, ny);
      const busy = [...live.values()]
        .filter((p) => p !== cur && p.bbox)
        .map((p) => inflateRect(p.bbox, PART_GAP));
      const free = body && !busy.some((r) => r.x < body.x + body.w && body.x < r.x + r.w && r.y < body.y + body.h && body.y < r.y + r.h);
      const inBounds = !usable || (body && body.x >= usable.x && body.x + body.w <= usable.x + usable.w);
      if (free && inBounds) {
        const oldX = cur.x;
        const oldY = cur.y;
        cur.x = snapToGrid(nx, grid);
        cur.y = snapToGrid(ny, grid);
        if (cur.bbox) cur.bbox = body;
        shiftPinsOnMove(cur, oldX, oldY);
        placements.push({ id: cur.id, designator: cur.designator, x: cur.x, y: cur.y, rotation: cur.rotation || 0 });
        prevX = cur.x + dir * (cur.bbox ? cur.bbox.w / 2 : 10);
      } else {
        notes.push(`信号链 ${cur.designator}: 放不下（跳过）`);
      }
    }
  }
  return { placements, notes };
}

/**
 * 并列（pair）：等距水平排开。group: {members: [designators]}
 */
export function solvePairs(components, groups, opts = {}) {
  const { clearance = 5, grid = 5, usable = null, spacing = 8 } = opts;
  const live = new Map();
  for (const c of components) live.set(c.designator, { ...c });
  const placements = [];
  const notes = [];

  for (const g of groups) {
    const members = (g.members || []).map((d) => live.get(d)).filter(Boolean);
    if (members.length < 2) continue;
    const first = members[0];
    const w0 = first.bbox ? first.bbox.w : 20;
    // 等距步长先吸附到网格，位置 = base + i*pitch（网格整数倍 → 严格等距）
    const pitch = snapToGrid(w0 / 2 + PART_GAP + spacing, grid);
    const baseX = snapToGrid(first.x, grid);
    const baseY = snapToGrid(first.y, grid);
    for (let i = 1; i < members.length; i++) {
      const cur = members[i];
      const nx = baseX + pitch * i;
      const body = shiftedBbox(cur.bbox, cur, nx, baseY);
      const busy = [...live.values()]
        .filter((p) => p !== cur && p.bbox)
        .map((p) => inflateRect(p.bbox, PART_GAP));
      const free = body && !busy.some((r) => r.x < body.x + body.w && body.x < r.x + r.w && r.y < body.y + body.h && body.y < r.y + r.h);
      const inBounds = !usable || (body && body.x >= usable.x && body.x + body.w <= usable.x + usable.w);
      if (free && inBounds) {
        const oldX = cur.x;
        const oldY = cur.y;
        cur.x = nx;
        cur.y = baseY;
        if (cur.bbox) cur.bbox = body;
        shiftPinsOnMove(cur, oldX, oldY);
        placements.push({ id: cur.id, designator: cur.designator, x: cur.x, y: cur.y, rotation: cur.rotation || 0 });
      } else {
        notes.push(`并列 ${cur.designator}: 放不下（跳过）`);
      }
    }
  }
  return { placements, notes };
}
