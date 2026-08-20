/**
 * 布局 lint —— 判定与生成同一把尺（easyeda-agent 铁律）
 *
 * L1（sch_list 检测）与 L2（planner 验证/verify 工具）共用：
 * - 归一化 bbox {x,y,w,h}（见 bbox.mjs）
 * - 所有"可放置图元"（part + netflag）两两相交 = overlap（带 clearance）
 * - 网络标记引脚点压在器件本体上 = netflagsInsideParts（标签错位信号）
 */
import { rectsOverlap, pointInsideRect, inflateRect } from './geometry.mjs';

/** 默认最小间距（sch 单位 = 0.05 inch） */
export const DEFAULT_CLEARANCE = 5;

/**
 * 分类：netflag = 无位号 + 有网络名；part = 有位号；other = 其它（如零 bbox 异常图元）
 */
export function classifyComponent(c) {
  const hasDesignator = typeof c.designator === 'string' && c.designator.trim().length > 0;
  const hasNet = typeof c.net === 'string' && c.net.trim().length > 0;
  if (!hasDesignator && hasNet) return 'netflag';
  if (hasDesignator) return 'part';
  return 'other';
}

/** 引脚点压本体容差（小于本体重叠余量，避免误报正常靠近的引脚） */
const PIN_BODY_TOLERANCE = 1;
/** 引脚端点重合容差（sch 单位） */
const PIN_COINCIDE_TOLERANCE = 2;

/**
 * 同尺 lint。components 每项：
 *   {id, designator, name, x, y, rotation, net?, bbox: {x,y,w,h}|null, pins?: [{x,y,net?,number?,name?}]}
 * 返回 {overlaps, netflagsInsideParts, pinOverlaps, partCount, flagCount, otherCount}
 * pinOverlaps：引脚级重叠——引脚连接点压其它器件本体 / 两器件引脚端点重合（非同网潜在短路）
 */
export function lintLayout(components, { clearance = DEFAULT_CLEARANCE } = {}) {
  const placeables = [];
  const flags = [];
  for (const c of components || []) {
    if (!c.bbox) continue; // 无 bbox（异常图元）不参与
    const kind = classifyComponent(c);
    if (kind === 'netflag') flags.push(c);
    if (kind === 'part' || kind === 'netflag') placeables.push(c);
  }
  const overlaps = [];
  for (let i = 0; i < placeables.length; i++) {
    for (let j = i + 1; j < placeables.length; j++) {
      const a = placeables[i];
      const b = placeables[j];
      if (rectsOverlap(a.bbox, b.bbox, clearance)) {
        overlaps.push({ a: a.designator || a.id, b: b.designator || b.id });
      }
    }
  }
  // 网络标记引脚点压在器件本体上（用标记的 x/y 作为引脚点代理）
  const netflagsInsideParts = [];
  for (const f of flags) {
    if (!Number.isFinite(f.x) || !Number.isFinite(f.y)) continue;
    for (const p of placeables) {
      if (p === f) continue;
      if (p.bbox && pointInsideRect(f.x, f.y, inflateRect(p.bbox, clearance))) {
        netflagsInsideParts.push({
          flag: f.designator || f.id,
          flagNet: f.net || '',
          part: p.designator || p.id,
        });
      }
    }
  }
  // 引脚级重叠（需组件带 pins）
  const pinOverlaps = [];
  const pinList = [];
  for (const c of placeables) {
    for (const pin of c.pins || []) {
      if (!Number.isFinite(pin.x) || !Number.isFinite(pin.y)) continue;
      pinList.push({ comp: c, pin });
    }
  }
  // ① 引脚连接点压其它器件本体（伸出本体的端点覆盖到别的元器件上）
  for (const { comp, pin } of pinList) {
    for (const p of placeables) {
      if (p === comp) continue;
      if (p.bbox && pointInsideRect(pin.x, pin.y, inflateRect(p.bbox, PIN_BODY_TOLERANCE))) {
        pinOverlaps.push({
          kind: 'pin-on-body',
          comp: comp.designator || comp.id,
          pin: pin.number || pin.name || `${Math.round(pin.x)},${Math.round(pin.y)}`,
          overlapsBody: p.designator || p.id,
        });
      }
    }
  }
  // ② 两器件引脚端点直接重合（非同网 → 潜在短路；同网/未知网不误报）
  for (let i = 0; i < pinList.length; i++) {
    for (let j = i + 1; j < pinList.length; j++) {
      const a = pinList[i];
      const b = pinList[j];
      if (a.comp === b.comp) continue;
      const d = Math.hypot(a.pin.x - b.pin.x, a.pin.y - b.pin.y);
      if (d > PIN_COINCIDE_TOLERANCE) continue;
      const netA = a.pin.net;
      const netB = b.pin.net;
      if (netA && netB && netA !== netB) {
        pinOverlaps.push({
          kind: 'pin-coincide',
          a: a.comp.designator || a.comp.id,
          aPin: a.pin.number || a.pin.name,
          b: b.comp.designator || b.comp.id,
          bPin: b.pin.number || b.pin.name,
        });
      }
    }
  }
  return {
    overlaps,
    netflagsInsideParts,
    pinOverlaps,
    partCount: placeables.filter((c) => classifyComponent(c) === 'part').length,
    flagCount: flags.length,
    otherCount: (components || []).length - placeables.length,
  };
}
