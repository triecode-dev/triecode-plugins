/**
 * 功能分区铺散（smart-hardware-engineer planLayout 移植 + 增强）
 *
 * 可用区按信号流切成互不重叠 zone（电源←主控←模拟/RF←接口，无源底带），
 * 器件按角色归 zone，每个 zone 内按角色 cell 尺寸 + gap 网格摆放 → 天然不重叠。
 * zone 满 → 自动溢出下一页（自动分页）。
 *
 * 与参考的差异（超越）：
 * - 用真实 bbox 尺寸归一化 cell（参考用固定 cell），更贴合实际
 * - 支持 intent.groups 修正（参考纯猜角色，我们用 AI 意图）
 * - 输出含 zone 归属，供后续贴脚细化用
 */
import { rectsOverlap, snapToGrid } from './geometry.mjs';

/** 图纸尺寸（sch 单位；EasyEDA 默认 1200×800，可被 pageRect 覆盖） */
const SHEETS = {
  A4: { w: 1200, h: 800 },
  A3: { w: 1700, h: 1150 },
  custom: { w: 1200, h: 800 },
};

/** 角色 → 功能分区（覆盖 51 单片机/常用电路；未命中 → misc） */
export const ROLE_ZONE = {
  // core：主控/时钟/调试（居中）
  mcu: 'core', soc: 'core', fpga: 'core', cpu: 'core', mpu: 'core', dsp: 'core',
  clock: 'core', crystal: 'core', oscillator: 'core', osc: 'core', xtal: 'core',
  debug: 'core', swd: 'core', jtag: 'core', boot: 'core', reset: 'core', memory: 'core', flash: 'core',
  // power：电源进/保护/稳压（左）
  power: 'power', vreg: 'power', regulator: 'power', ldo: 'power', buck: 'power', boost: 'power',
  dcdc: 'power', pmic: 'power', battery: 'power', charger: 'power', protection: 'power',
  tvs: 'power', fuse: 'power', ferrite: 'power', inductor: 'power',
  // analog / rf / io / misc
  analog: 'analog', opamp: 'analog', adc: 'analog', dac: 'analog', sensor: 'analog',
  afe: 'analog', amplifier: 'analog', filter: 'analog', reference: 'analog', comparator: 'analog',
  rf: 'rf', antenna: 'rf', balun: 'rf', wifi: 'rf', ble: 'rf', bt: 'rf', lora: 'rf', gps: 'rf', nfc: 'rf',
  connector: 'io', conn: 'io', header: 'io', usb: 'io', jack: 'io', terminal: 'io',
  io: 'io', gpio: 'io', led: 'io', button: 'io', switch: 'io', relay: 'io', display: 'io',
  passive: 'misc', res: 'misc', cap: 'misc', resistor: 'misc', capacitor: 'misc',
  diode: 'misc', transistor: 'misc', mosfet: 'misc',
  // 去耦/负载/上拉 就近宿主，由 attach 细化，这里归 misc 底带不抢位置
  decoupling: 'misc',
};

/** refdes 前缀 → 角色兜底 */
const PREFIX_ROLE = {
  U: 'mcu', IC: 'mcu', Q: 'mosfet', D: 'diode', R: 'res', C: 'cap', L: 'inductor',
  J: 'connector', P: 'connector', CN: 'connector', SW: 'switch', K: 'relay',
  Y: 'crystal', X: 'crystal', LED: 'led', BT: 'battery', F: 'fuse', FB: 'ferrite', ANT: 'rf',
};

export function guessRole(designator, explicit) {
  const r = explicit ? String(explicit).toLowerCase() : '';
  if (r) return r;
  const prefix = (String(designator || '').match(/^[A-Za-z]+/)?.[0] || '').toUpperCase();
  return PREFIX_ROLE[prefix] || 'passive';
}

/** zone 相对可用区的模板（互不重叠铺满） */
const ZONE_TEMPLATE = {
  power: { x0: 0.00, x1: 0.20, y0: 0.00, y1: 0.62 },
  core: { x0: 0.20, x1: 0.60, y0: 0.00, y1: 0.62 },
  analog: { x0: 0.60, x1: 0.82, y0: 0.00, y1: 0.34 },
  rf: { x0: 0.60, x1: 0.82, y0: 0.34, y1: 0.62 },
  io: { x0: 0.82, x1: 1.00, y0: 0.00, y1: 0.62 },
  misc: { x0: 0.00, x1: 1.00, y0: 0.62, y1: 1.00 },
};
const DEFAULT_ZONE_ORDER = ['power', 'core', 'analog', 'rf', 'io', 'misc'];

/**
 * 功能分区铺散。
 * @param {Array<{designator, x, y, bbox?:{x,y,w,h}, role?, id}>} components
 * @param {{sheet?:string, pageRect?:{x,y,w,h}, keepouts?:Array<{x,y,w,h}>, margin?:number, gap?:number, zonesOrder?:string[], fixed?:Set<string>}} opts
 * @returns {{placements:Array<{id,designator,x,y,rotation,zone}>, pages:Array, byZone:object}}
 */
export function planZones(components, opts = {}) {
  const sheetName = (opts.sheet || 'A4').toLowerCase();
  const base = SHEETS[sheetName] || SHEETS.A4;
  const pageRect = opts.pageRect || { x: 0, y: 0, w: base.w, h: base.h };
  const margin = opts.margin ?? 40;
  const gap = opts.gap ?? 10;
  const usable = { x: pageRect.x + margin, y: pageRect.y + margin, w: pageRect.w - 2 * margin, h: pageRect.h - 2 * margin };
  const keepouts = opts.keepouts || [];
  const order = opts.zonesOrder || DEFAULT_ZONE_ORDER;
  const fixed = opts.fixed || new Set();

  const zoneRect = (z) => {
    const t = ZONE_TEMPLATE[z] || ZONE_TEMPLATE.misc;
    return {
      x: usable.x + t.x0 * usable.w,
      y: usable.y + t.y0 * usable.h,
      w: (t.x1 - t.x0) * usable.w,
      h: (t.y1 - t.y0) * usable.h,
    };
  };

  // 归类
  const queues = {};
  for (const z of order) queues[z] = [];
  for (const c of components) {
    const role = guessRole(c.designator, c.role);
    const z = ROLE_ZONE[role] || 'misc';
    (queues[z] || (queues[z] = [])).push({ ...c, role });
  }
  const byZone = {};
  for (const z of order) byZone[z] = queues[z].length;

  // cell 尺寸：按真实 bbox（宽高取 max 方向），保底 24×26
  const cellFor = (c) => {
    const b = c.bbox;
    const w = Math.max(24, b ? b.w + 8 : 24);
    const h = Math.max(26, b ? b.h + 8 : 26);
    return { w, h };
  };

  const placements = [];
  const pages = [];
  const remaining = {};
  for (const z of Object.keys(queues)) remaining[z] = queues[z].slice();
  const total = components.length;

  let safety = 0;
  while (Object.values(remaining).some((q) => q.length) && safety < 100) {
    safety++;
    const pageIdx = pages.length + 1;
    let placedThisPage = 0;
    for (const z of order) {
      const q = remaining[z];
      if (!q || !q.length) continue;
      const zr = zoneRect(z);
      // 网格格点
      const cells = [];
      const cell = cellFor(q[0]);
      const stepX = cell.w + gap;
      const stepY = cell.h + gap;
      const cols = Math.max(1, Math.floor((zr.w + gap) / stepX));
      const rows = Math.max(1, Math.floor((zr.h + gap) / stepY));
      for (let r = 0; r < rows; r++) {
        for (let col = 0; col < cols; col++) {
          const cx = zr.x + col * stepX;
          const cy = zr.y + r * stepY;
          const cellRect = { x: cx, y: cy, w: cell.w, h: cell.h };
          if (keepouts.some((k) => rectsOverlap(cellRect, k, 0))) continue;
          cells.push({ x: cx + cell.w / 2, y: cy + cell.h / 2 });
        }
      }
      let i = 0;
      while (i < cells.length && q.length) {
        const c = q.shift();
        const cell = cells[i++];
        if (fixed.has(c.designator)) {
          // 固定件不铺散，保持原位（但计入页）
          placements.push({ id: c.id, designator: c.designator, x: c.x, y: c.y, rotation: c.rotation || 0, zone: z, fixed: true });
        } else {
          // 让**本体中心**落在格心（锚点 = 格心 − bboxRel − 半宽），body 偏移不越格
          const b = c.bbox;
          const bcx = b ? b.x + b.w / 2 - c.x : 0; // 本体中心相对锚点
          const bcy = b ? b.y + b.h / 2 - c.y : 0;
          placements.push({
            id: c.id,
            designator: c.designator,
            x: snapToGrid(cell.x - bcx, 5),
            y: snapToGrid(cell.y - bcy, 5),
            rotation: c.rotation || 0,
            zone: z,
          });
        }
        placedThisPage++;
      }
    }
    pages.push({ page: pageIdx });
    if (placedThisPage === 0) break;
  }

  return {
    placements,
    pages,
    byZone,
    unplaced: Object.values(remaining).flat().map((c) => c.designator),
    total,
  };
}
