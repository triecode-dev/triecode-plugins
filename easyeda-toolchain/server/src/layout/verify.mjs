/**
 * 布局验证（同尺门禁）
 *
 * - verifyPlacements：用与生成同一套 lint 检查预测布局（归一化 bbox + clearance）
 * - fingerprintNetlist / netsChanged：连通性指纹，移动后读回网表比对，变了就回滚
 *   （easyeda-agent「判定与生成同一把尺」+ autodraw round-trip）
 */
import { lintLayout } from './lint.mjs';
import { rectFromMinMax } from './geometry.mjs';

/**
 * 校验一组带新位姿的器件（placements 合并到原位置）。
 * @param {Array<{id,designator,x,y,rotation,net?,bboxMinMax?:{minX,minY,maxX,maxY}|null,bbox?:{x,y,w,h}|null}>} components
 * @param {Array<{id,designator,x,y,rotation}>} placements 新位姿（覆盖对应器件的 x/y/rotation）
 * @param {{clearance?:number, usable?:{x,y,w,h}}} opts
 * @returns {{ok:boolean, overlaps:Array, netflagsInsideParts:Array, outOfSheet:Array}}
 */
export function verifyPlacements(components, placements, opts = {}) {
  const { clearance = 5, usable = null } = opts;
  const byId = new Map(placements.map((p) => [p.id, p]));
  const predicted = components.map((c) => {
    const mv = byId.get(c.id);
    const x = mv ? mv.x : c.x;
    const y = mv ? mv.y : c.y;
    const rotation = mv ? mv.rotation : c.rotation;
    // bbox 随移动平移
    let bbox = c.bbox || null;
    if (bbox && mv) bbox = { ...bbox, x: bbox.x + (mv.x - c.x), y: bbox.y + (mv.y - c.y) };
    return { id: c.id, designator: c.designator, x, y, rotation, net: c.net, bbox };
  });
  const lint = lintLayout(predicted, { clearance });
  const outOfSheet = [];
  if (usable) {
    for (const c of predicted) {
      if (c.bbox) {
        if (c.bbox.x < usable.x || c.bbox.y < usable.y || c.bbox.x + c.bbox.w > usable.x + usable.w || c.bbox.y + c.bbox.h > usable.y + usable.h) {
          outOfSheet.push({ designator: c.designator || c.id });
        }
      }
    }
  }
  return {
    ok: lint.overlaps.length === 0 && lint.netflagsInsideParts.length === 0 && outOfSheet.length === 0,
    overlaps: lint.overlaps,
    netflagsInsideParts: lint.netflagsInsideParts,
    outOfSheet,
  };
}

/**
 * 连通性指纹：netlist = [{net, pins: [{comp, pin}]}]。
 * 对每个网络，生成有序的 "comp.pin" 列表，整体稳定哈希。
 */
export function fingerprintNetlist(netlist) {
  const nets = {};
  for (const n of netlist || []) {
    const refs = (n.pins || []).map((p) => `${p.comp}.${p.pin}`).sort();
    nets[n.net] = refs;
  }
  return Object.keys(nets)
    .sort()
    .map((k) => `${k}=${nets[k].join(',')}`)
    .join(';');
}

/** 指纹是否变化 */
export function netsChanged(fpBefore, fpAfter) {
  return fpBefore !== fpAfter;
}

/** 归一化 bbox 供 lint 用（兜底：直接给 rect） */
export function bboxRect(raw) {
  return rectFromMinMax(raw.minX, raw.minY, raw.maxX, raw.maxY);
}
