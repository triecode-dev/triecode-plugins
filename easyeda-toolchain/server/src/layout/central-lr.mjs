/**
 * 中央芯片左右布局（tscircuit central-LR 思想 + 真实 bbox + 占用图）
 *
 * 核心芯片放中位，未锚定的外设围绕核心摆放：
 * - 优先核心右侧列（信号从左进右出惯例），用 findFreeSpot 沿右侧逐格找空位
 * - 右侧放满 → 左侧；两侧都满 → 上/下
 * 已被 AI 锚定（anchors）的外设由 attach 细化，这里跳过。
 */
import { snapToGrid } from './geometry.mjs';
import { findFreeSpot } from './occupancy.mjs';

/**
 * @param {Array<{id,designator,x,y,rotation,bbox:{x,y,w,h}|null}>} components 全部器件
 * @param {string} coreDesignator 核心芯片位号
 * @param {{usable?:{x,y,w,h}, clearance?:number, fixed?:Set<string>, skip?:Set<string>}} opts
 *   skip = 已被锚定的外设（attach 细化），不在此铺散
 * @returns {{placements:Array<{id,designator,x,y,rotation,side}>}}
 */
export function planCentralLR(components, coreDesignator, opts = {}) {
  const { usable = null, clearance = 10, fixed = new Set(), skip = new Set() } = opts;
  const core = components.find((c) => c.designator === coreDesignator);
  if (!core) return { placements: [], notes: ['中央件不存在'] };

  const notes = [];
  const placements = [];
  // 已占用：固定件 + 核心
  const placedObstacles = [];
  for (const c of components) {
    if (c === core || fixed.has(c.designator)) {
      if (c.bbox) placedObstacles.push(c.bbox);
    }
  }

  // 核心位置：fixed 则原位，否则让**本体中心**落在可用区中心（锚点 = 本体中心 − bboxRel−半宽）
  let coreX = core.x;
  let coreY = core.y;
  if (!fixed.has(coreDesignator) && usable) {
    const cbbox = core.bbox || { x: core.x - 10, y: core.y - 8, w: 20, h: 16 };
    const rel = { dx: cbbox.x - core.x, dy: cbbox.y - core.y };
    const bodyCenter = { x: rel.dx + cbbox.w / 2, y: rel.dy + cbbox.h / 2 }; // 相对 anchor
    coreX = snapToGrid(usable.x + usable.w / 2 - bodyCenter.x, 5);
    coreY = snapToGrid(usable.y + usable.h / 2 - bodyCenter.y, 5);
    placements.push({ id: core.id, designator: core.designator, x: coreX, y: coreY, rotation: core.rotation || 0, side: 'center' });
    if (core.bbox) placedObstacles.push({ x: coreX + (core.bbox.x - core.x), y: coreY + (core.bbox.y - core.y), w: core.bbox.w, h: core.bbox.h });
  } else {
    placements.push({ id: core.id, designator: core.designator, x: core.x, y: core.y, rotation: core.rotation || 0, side: 'center', fixed: true });
  }

  const coreBox = placedObstacles[placedObstacles.length - 1] || (core.bbox ? core.bbox : null);

  // 外设：右侧列优先，逐格找空位
  const others = components.filter(
    (c) => c !== core && !fixed.has(c.designator) && !skip.has(c.designator),
  );
  // 排序：确定性（按设计符）
  others.sort((a, b) => String(a.designator).localeCompare(String(b.designator)));

  // 外设基于**真实本体矩形**放置：锚点 = 本体位置 − bboxRel（本体不以锚点为中心，Y1 即反例）
  const sideCursor = {
    right: coreBox ? { x: coreBox.x + coreBox.w + clearance, y: coreBox.y } : { x: core.x + 100, y: core.y },
    left: coreBox ? { x: coreBox.x - clearance, y: coreBox.y } : { x: core.x - 100, y: core.y },
  };

  for (const c of others) {
    const bbox = c.bbox || { x: c.x - 10, y: c.y - 8, w: 20, h: 16 };
    const bboxRel = { dx: bbox.x - c.x, dy: bbox.y - c.y, w: bbox.w, h: bbox.h };
    // 候选 = 本体膨胀 clearance 后的矩形（findFreeSpot 返回其 min 角）
    const size = { w: bboxRel.w + clearance * 2, h: bboxRel.h + clearance * 2 };
    let spot = null;
    let side = 'right';
    if (coreBox) {
      spot = findFreeSpot(sideCursor.right, size, placedObstacles, usable, { preference: 'center', grid: 5, step: 40 });
    }
    if (!spot) {
      side = 'left';
      if (coreBox) {
        spot = findFreeSpot(sideCursor.left, size, placedObstacles, usable, { preference: 'center', grid: 5, step: 40 });
      }
    }
    if (!spot) {
      spot = findFreeSpot({ x: core.x, y: core.y }, size, placedObstacles, usable, { preference: 'upper-right', grid: 5, step: 60 });
      side = 'around';
    }
    if (!spot) {
      notes.push(`${c.designator}: 中央布局无空位`);
      continue;
    }
    // spot 是膨胀本体矩形的 min 角 → 本体 min 角 = spot + clearance → 锚点 = 本体 − bboxRel
    const bodyMin = { x: spot.x + clearance, y: spot.y + clearance };
    const anchor = { x: snapToGrid(bodyMin.x - bboxRel.dx), y: snapToGrid(bodyMin.y - bboxRel.dy) };
    placements.push({ id: c.id, designator: c.designator, x: anchor.x, y: anchor.y, rotation: c.rotation || 0, side });
    // 更新占用（真实本体）+ 该侧游标
    const bb = { x: bodyMin.x, y: bodyMin.y, w: bboxRel.w, h: bboxRel.h };
    placedObstacles.push(bb);
    if (side === 'right') sideCursor.right.y += size.h + clearance;
    else if (side === 'left') sideCursor.left.y += size.h + clearance;
  }

  return { placements, notes };
}
