/**
 * 网络标记（VCC/GND flag）防重叠放置
 *
 * 问题：标记压进器件本体（C3 的 GND 压在 U1 上）、标记互相重叠。
 * 机制：
 * - 标记的连接点（pin/anchor）应对准目标引脚（期望位来自 follow-pin）
 * - 标记的**图形本体**相对连接点有固定偏移 bboxRel（如 GND 图形挂在连接点下方）
 * - 候选位 = 连接点坐标；判定用**图形 rect**（bboxRel 偏移）不压任何器件本体
 *   （膨胀 clearance）——autodraw netflag-in-part 检查反向用
 * - 冲突则沿方向外扫描 + 四象限轮询，取第一个图形合法的位
 * - 标签占用（图形 rect）防标记互相重叠（easyeda-agent marker lane 思想）
 */
import { rectsOverlap, snapToGrid } from './geometry.mjs';

/** 标记方向（按网络名推断；可被 intent 覆盖） */
export function flagDirByNet(net) {
  const n = String(net || '').toUpperCase();
  if (n === 'GND' || n.endsWith('_GND') || n.includes('GND')) return 'down';
  if (n.startsWith('+') || n.includes('VCC') || n.includes('POWER') || n === 'VDD' || n === 'VSS') return 'up';
  return 'right';
}

const DIR_VEC = {
  up: { dx: 0, dy: 1 },
  down: { dx: 0, dy: -1 },
  left: { dx: -1, dy: 0 },
  right: { dx: 1, dy: 0 },
};

/**
 * 规划标记放置。
 * @param {Array<{id,designator,net,x,y,rotation,bbox:{x,y,w,h}|null}>} flags 待重排的标记
 * @param {Array<{x,y,w,h}>} partBodies 器件本体（障碍）
 * @param {{usable?:{x,y,w,h}, clearance?:number, grid?:number, dirs?:Array<string>, maxScan?:number}} opts
 * @returns {{placements:Array<{id,designator,x,y,rotation,dir}>, notes:Array}}
 */
export function planLabels(flags, partBodies, opts = {}) {
  const { usable = null, clearance = 5, grid = 5, maxScan = 12 } = opts;
  const notes = [];
  const placements = [];
  // 标记图形占用 —— 防互相重叠
  const flagRects = [];

  for (const f of flags) {
    // 图形相对连接点偏移（bbox - anchor）
    const rel = f.bbox && Number.isFinite(f.x)
      ? { dx: f.bbox.x - f.x, dy: f.bbox.y - f.y, w: f.bbox.w, h: f.bbox.h }
      : { dx: -8, dy: -8, w: 16, h: 16 };
    const overrideDir = f._dirOverride;
    const dir = DIR_VEC[overrideDir || flagDirByNet(f.net)] || DIR_VEC.right;
    const step = Math.max(rel.w, rel.h) + clearance;
    // 基准 = 期望位置（连接点对准引脚）或原位置
    const bx = Number.isFinite(f._desiredX) ? f._desiredX : f.x;
    const by = Number.isFinite(f._desiredY) ? f._desiredY : f.y;

    // 判断连接点候选是否合法：图形不压器件本体、不压其它标记、在界内
    const legal = (cx, cy) => {
      const rect = { x: cx + rel.dx, y: cy + rel.dy, w: rel.w, h: rel.h };
      if (partBodies.some((b) => rectsOverlap(rect, b, clearance))) return false;
      if (flagRects.some((r) => rectsOverlap(rect, r, clearance))) return false;
      if (usable && (rect.x < usable.x || rect.y < usable.y || rect.x + rect.w > usable.x + usable.w || rect.y + rect.h > usable.y + usable.h)) return false;
      return true;
    };

    // 先试期望位（不压本体时直接落位）
    let placed = legal(bx, by) ? { x: bx, y: by } : null;
    let placedDir = f._dirOverride || flagDirByNet(f.net);
    // 沿首选方向外扫（小步长，就近）
    if (!placed) {
      for (let i = 1; i <= maxScan; i++) {
        const cx = bx + dir.dx * step * i;
        const cy = by + dir.dy * step * i;
        if (legal(cx, cy)) { placed = { x: cx, y: cy }; break; }
      }
    }
    // 四象限轮询兜底
    if (!placed) {
      for (const d of ['up', 'down', 'right', 'left']) {
        const v = DIR_VEC[d];
        for (let i = 1; i <= maxScan; i++) {
          const cx = bx + v.dx * step * i;
          const cy = by + v.dy * step * i;
          if (legal(cx, cy)) { placed = { x: cx, y: cy }; placedDir = d; break; }
        }
        if (placed) break;
      }
    }
    if (!placed) {
      notes.push(`标记 ${f.net || f.id}: 找不到合法位置（保留期望位，lint 会标记）`);
      // 保留期望位（不丢失跟随引脚的语义），lint 兜底
      placed = { x: bx, y: by };
    }
    placements.push({
      id: f.id,
      designator: f.designator,
      x: snapToGrid(placed.x, grid),
      y: snapToGrid(placed.y, grid),
      rotation: f.rotation || 0,
      dir: placedDir,
    });
    flagRects.push({ x: placed.x + rel.dx, y: placed.y + rel.dy, w: rel.w, h: rel.h });
  }
  return { placements, notes };
}
