/**
 * 包围盒处理：归一化 + 从引脚估算兜底
 *
 * - EasyEDA getPrimitivesBBox 返回的 minY/maxY 顺序不保证（常见反转），
 *   必须归一化后再用。
 * - getPrimitivesBBox 可能抛错/返回空 → 用 estimateComponentBox（autodraw
 *   同款思路：从引脚真实坐标估算本体 box，PIN_MARGIN 兜底）。
 */
import { rectFromMinMax } from './geometry.mjs';

/** 归一化原始 bbox（{minX,minY,maxX,maxY}，可反转）→ 归一化 {minX,minY,maxX,maxY}；null 透传 */
export function normBBoxMinMax(raw) {
  if (!raw) return null;
  const r = rectFromMinMax(raw.minX, raw.minY, raw.maxX, raw.maxY);
  return { minX: r.x, minY: r.y, maxX: r.x + r.w, maxY: r.y + r.h };
}

/** 归一化原始 bbox → {x,y,w,h}；null 透传 */
export function normBBoxRect(raw) {
  if (!raw) return null;
  return rectFromMinMax(raw.minX, raw.minY, raw.maxX, raw.maxY);
}

/**
 * 从引脚坐标估算包围盒（getPrimitivesBBox 失败时兜底）。
 * 引脚间距决定本体方向：pin 横向排 → 本体竖立（ySpan<2 时 marginY=bodyPerp）；
 * pin 纵向排 → 本体横置（xSpan<2 时 marginX=bodyPerp）；否则双向 bodyPerp。
 * bodyPerp = max(14, 最远引脚距离*0.85)，PIN_MARGIN=5。
 * @param {{x:number,y:number}[]} pins 引脚绝对坐标
 * @param {{x?:number,y?:number}} anchor 器件原点（缺省用引脚中心）
 */
export function estimateComponentBox(pins = [], anchor = {}) {
  const usable = (pins || []).filter((p) => Number.isFinite(Number(p.x)) && Number.isFinite(Number(p.y)));
  let cx = anchor.x != null ? Number(anchor.x) : null;
  let cy = anchor.y != null ? Number(anchor.y) : null;
  if (cx == null || cy == null) {
    if (usable.length === 1) {
      cx = Number(usable[0].x);
      cy = Number(usable[0].y);
    } else if (usable.length > 1) {
      const xs = usable.map((p) => Number(p.x));
      const ys = usable.map((p) => Number(p.y));
      cx = (Math.min(...xs) + Math.max(...xs)) / 2;
      cy = (Math.min(...ys) + Math.max(...ys)) / 2;
    }
  }
  if (cx == null || cy == null) {
    // 完全无信息：给个 25×18 兜底（对齐原实现）
    return { x: 0 - 25, y: 0 - 18, w: 50, h: 36 };
  }
  if (usable.length === 0) {
    return { x: cx - 25, y: cy - 18, w: 50, h: 36 };
  }
  const pinXs = usable.map((p) => Number(p.x));
  const pinYs = usable.map((p) => Number(p.y));
  const xSpan = Math.max(...pinXs) - Math.min(...pinXs);
  const ySpan = Math.max(...pinYs) - Math.min(...pinYs);
  let maxD = 12;
  for (const pin of usable) {
    const d = Math.hypot(Number(pin.x) - cx, Number(pin.y) - cy);
    if (d > maxD) maxD = d;
  }
  const derived = Math.max(14, maxD * 0.85);
  const bodyPerp = Math.min(20, derived);
  const PIN_MARGIN = 5;
  if (usable.length === 1) {
    const rr = Math.max(16, maxD + 2);
    return { x: cx - rr, y: cy - rr, w: rr * 2, h: rr * 2 };
  }
  const allXs = [cx, ...pinXs];
  const allYs = [cy, ...pinYs];
  let marginX;
  let marginY;
  if (ySpan < 2) {
    marginX = PIN_MARGIN;
    marginY = bodyPerp;
  } else if (xSpan < 2) {
    marginX = bodyPerp;
    marginY = PIN_MARGIN;
  } else {
    marginX = bodyPerp;
    marginY = bodyPerp;
  }
  return {
    x: Math.min(...allXs) - marginX,
    y: Math.min(...allYs) - marginY,
    w: Math.max(...allXs) - Math.min(...allXs) + marginX * 2,
    h: Math.max(...allYs) - Math.min(...allYs) + marginY * 2,
  };
}
