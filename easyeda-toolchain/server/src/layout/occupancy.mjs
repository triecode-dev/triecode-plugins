/**
 * 占用图 + 空位查找（确定性）
 *
 * - busy rect = 已放置图元 bbox（含 clearance 膨胀）+ 导线 + keepout + 标题块
 * - findFreeSpot：优先 selectSafeRegion（偏好角），冲突则螺旋扫描兜底（a2n 思路）
 * - 所有判定与 lint 同尺（rectsOverlap）
 */
import { rectsOverlap, inflateRect, snapToGrid } from './geometry.mjs';

/**
 * 构建占用矩形集。
 * @param {Array<{bbox?:{x,y,w,h}}>} components 已放置图元（含 bbox）
 * @param {Array<{x,y,w,h}>} [extra] 额外占用（导线/keepout 等）
 * @param {number} clearance 膨胀量
 */
export function buildOccupancy(components = [], extra = [], clearance = 0) {
  const rects = [];
  for (const c of components) {
    if (c.bbox) rects.push(inflateRect(c.bbox, clearance));
  }
  for (const r of extra) {
    if (r) rects.push(r);
  }
  return rects;
}

/** 候选矩形是否与任一占用相交（含 clearance 已膨胀进 busy） */
export function isFreeRect(candidate, busy) {
  return !busy.some((r) => rectsOverlap(candidate, r, 0));
}

/** 候选是否在可用区内且不与占用相交 */
export function isFree(candidate, busy, usable) {
  if (usable) {
    if (candidate.x < usable.x || candidate.y < usable.y) return false;
    if (candidate.x + candidate.w > usable.x + usable.w) return false;
    if (candidate.y + candidate.h > usable.y + usable.h) return false;
  }
  return isFreeRect(candidate, busy);
}

/**
 * 找空闲位。targetRect 是先验位置；先检查它本身，被占则：
 * 1) selectSafeRegion（偏好角 origin），2) 螺旋扫描（网格步进，a2n 思路）
 * @returns {{x,y}|null}
 */
export function findFreeSpot(target, size, busy, usable, opts = {}) {
  const { preference = 'upper-left', grid = 5, maxRadius = 2000, step = 80 } = opts;
  const targetRect = { x: target.x, y: target.y, w: size.w, h: size.h };
  if (isFree(targetRect, busy, usable)) {
    return { x: snapToGrid(target.x, grid), y: snapToGrid(target.y, grid) };
  }
  // selectSafeRegion：偏好角
  const safe = selectSafeRegion(size, busy, usable, { preference, grid });
  if (safe) return safe;
  // 螺旋扫描兜底
  const spiral = spiralSearch(target.x, target.y, size, busy, usable, { step, maxRadius, grid });
  return spiral;
}

/**
 * 偏好角 origin（mcp-pro selectSafeRegion 思路）：左上/右上/左下/右下/居中。
 * 逐角尝试，第一个合法者返回。
 */
export function selectSafeRegion(size, busy, usable, { preference = 'upper-left', grid = 5 } = {}) {
  if (!usable) return null;
  const corners = {
    'upper-left': { x: usable.x, y: usable.y },
    'upper-right': { x: usable.x + usable.w - size.w, y: usable.y },
    'lower-left': { x: usable.x, y: usable.y + usable.h - size.h },
    'lower-right': { x: usable.x + usable.w - size.w, y: usable.y + usable.h - size.h },
    center: { x: usable.x + (usable.w - size.w) / 2, y: usable.y + (usable.h - size.h) / 2 },
  };
  const order = [preference, 'upper-left', 'upper-right', 'lower-left', 'lower-right', 'center'];
  for (const name of order) {
    const o = corners[name];
    if (!o) continue;
    const cand = { x: snapToGrid(o.x, grid), y: snapToGrid(o.y, grid), w: size.w, h: size.h };
    if (isFree(cand, busy, usable)) return { x: cand.x, y: cand.y };
  }
  return null;
}

/**
 * 螺旋扫描：从 target 按 step 半径逐圈，检查环上各格（a2n searchFreePlaceV2 思路）。
 */
export function spiralSearch(cx, cy, size, busy, usable, { step = 80, maxRadius = 2000, grid = 5 } = {}) {
  const targetRect = { x: cx, y: cy, w: size.w, h: size.h };
  for (let radius = step; radius <= maxRadius; radius += step) {
    for (let dx = -radius; dx <= radius; dx += step) {
      for (let dy = -radius; dy <= radius; dy += step) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue;
        const cand = { x: cx + dx, y: cy + dy, w: size.w, h: size.h };
        if (isFree(cand, busy, usable)) {
          return { x: snapToGrid(cand.x, grid), y: snapToGrid(cand.y, grid) };
        }
      }
    }
  }
  return null;
}

/**
 * 一维推让链（easyeda-agent bslPushSolve 思路，简化为单维）：
 * 沿轴 dx/dy 把 target 及其"外侧"的占用矩形一起让开，返回每件的位移。
 * 这里用于把"贴着边界/彼此的件"往一维推开；对布局引擎的贴脚冲突做兜底。
 */
export function pushAlongAxis(mover, obstacles, usable, axis, want) {
  // axis: 'x' | 'y'；mover 是 {x,y,w,h}；obstacles 是要推开的矩形（都在 mover 外侧同轴带）
  const dir = axis === 'x' ? (want >= 0 ? 1 : -1) : (want >= 0 ? 1 : -1);
  const result = [];
  for (const o of obstacles) {
    result.push({ ...o, x: o.x + (axis === 'x' ? dir * want : 0), y: o.y + (axis === 'y' ? dir * want : 0) });
  }
  return result;
}
