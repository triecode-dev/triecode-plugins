/**
 * 布局几何纯函数（同尺核心）—— L1 检测 / L2 引擎共用同一套判定
 *
 * 统一用归一化矩形 `{x, y, w, h}`（w/h 恒正）表示包围盒，彻底规避
 * EasyEDA getPrimitivesBBox 返回 minY>maxY 的反转问题。
 *
 * 坐标系统（立创EDA 原理图，用户确认）：
 *   - 默认单位 inch，1 sch = 0.01 inch（1 inch = 100 sch）
 *   - 默认 0 点在图纸**左下角**，Y 轴**向上**（y 大 = 视觉上方）
 *   - 默认网格 0.05 inch = 5 sch
 *   - A4 图纸 11.7 × 8.25 inch = 1170 × 825 sch；刃带宽 0.1 inch = 10 sch
 *   - 归一化 bbox：x/minY = 下边，y + h/maxY = 上边
 */

/** 由 {minX,minY,maxX,maxY}（可反转）转归一化 {x,y,w,h} */
export function rectFromMinMax(minX, minY, maxX, maxY) {
  const x = Math.min(minX, maxX);
  const y = Math.min(minY, maxY);
  return { x, y, w: Math.abs(maxX - minX), h: Math.abs(maxY - minY) };
}

/** 由归一化 {x,y,w,h} 转 {minX,minY,maxX,maxY}（顺序保证 min<max） */
export function rectToMinMax(r) {
  return { minX: r.x, minY: r.y, maxX: r.x + r.w, maxY: r.y + r.h };
}

/** 矩形是否相交（带可选 clearance 余量，>=0 即含边缘相触） */
export function rectsOverlap(a, b, clearance = 0) {
  return (
    a.x < b.x + b.w + clearance &&
    a.x + a.w + clearance > b.x &&
    a.y < b.y + b.h + clearance &&
    a.y + a.h + clearance > b.y
  );
}

/** 矩形相交面积（>=0，用于评分"多严重"） */
export function rectsOverlapArea(a, b) {
  const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  if (ox <= 0 || oy <= 0) return 0;
  return ox * oy;
}

/** 按 clearance 膨胀矩形 */
export function inflateRect(r, amount) {
  return { x: r.x - amount, y: r.y - amount, w: r.w + amount * 2, h: r.h + amount * 2 };
}

/** 点是否在矩形内（含边，可选内缩 tolerance） */
export function pointInsideRect(px, py, r, tolerance = 0) {
  return (
    px >= r.x - tolerance && px <= r.x + r.w + tolerance &&
    py >= r.y - tolerance && py <= r.y + r.h + tolerance
  );
}

/** 矩形是否完全落在 outer 内 */
export function rectInside(inner, outer) {
  return (
    inner.x >= outer.x && inner.y >= outer.y &&
    inner.x + inner.w <= outer.x + outer.w &&
    inner.y + inner.h <= outer.y + outer.h
  );
}

/** 多个矩形合并（undefined 若空） */
export function combineRects(rects) {
  if (!rects || rects.length === 0) return undefined;
  const left = Math.min(...rects.map((r) => r.x));
  const top = Math.min(...rects.map((r) => r.y));
  const right = Math.max(...rects.map((r) => r.x + r.w));
  const bottom = Math.max(...rects.map((r) => r.y + r.h));
  return { x: left, y: top, w: right - left, h: bottom - top };
}

/** 网格吸附（四舍五入到 grid 整数倍） */
export function snapToGrid(value, grid = 5) {
  if (!Number.isFinite(grid) || grid <= 0) return value;
  return Math.round(value / grid) * grid;
}

/** 网格吸附到 <= value 的最近格（不许越过，用于推让上限） */
export function snapToGridFloor(value, grid = 5) {
  if (!Number.isFinite(grid) || grid <= 0) return value;
  return Math.floor(value / grid) * grid;
}

/** 线段与矩形是否相交（Liang-Barsky，用于导线/本体防交叉） */
export function segmentIntersectsRect(x1, y1, x2, y2, r, inflate = 0) {
  const Xmin = r.x - inflate;
  const Xmax = r.x + r.w + inflate;
  const Ymin = r.y - inflate;
  const Ymax = r.y + r.h + inflate;
  if (Math.max(x1, x2) < Xmin || Math.min(x1, x2) > Xmax) return false;
  if (Math.max(y1, y2) < Ymin || Math.min(y1, y2) > Ymax) return false;
  const dx = x2 - x1;
  const dy = y2 - y1;
  const p = [-dx, dx, -dy, dy];
  const q = [x1 - Xmin, Xmax - x1, y1 - Ymin, Ymax - y1];
  let u1 = 0;
  let u2 = 1;
  for (let i = 0; i < 4; i++) {
    if (Math.abs(p[i]) < 1e-9) {
      if (q[i] < 0) return false;
    } else {
      const t = q[i] / p[i];
      if (p[i] < 0) {
        if (t > u2) return false;
        if (t > u1) u1 = t;
      } else {
        if (t < u1) return false;
        if (t < u2) u2 = t;
      }
    }
  }
  return u1 <= u2;
}

/** 点到线段距离 */
export function pointDistToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((px - x1) * dx + (py - y1) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const cx = x1 + t * dx;
  const cy = y1 + t * dy;
  return Math.hypot(px - cx, py - cy);
}
