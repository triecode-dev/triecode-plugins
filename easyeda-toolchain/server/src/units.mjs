/**
 * 立创EDA 坐标单位换算（官方 #1 易错点集中处理，避免 AI 手算 10 倍错位）
 *
 * 规则（官方文档）：
 *  - PCB：1 单位 = 1mil = 0.001 inch = 0.0254 mm   → 1mm ≈ 39.37 单位
 *  - 原理图(SCH)：1 单位 = 0.01 inch = 10mil = 0.254 mm → 1mm ≈ 3.937 单位
 */

const INCH_TO_MM = 25.4;

export const Units = {
  /** mm → mil（PCB 单位） */
  mmToMil(mm) {
    return mm / INCH_TO_MM * 1000;
  },
  /** mil（PCB 单位）→ mm */
  milToMm(mil) {
    return mil / 1000 * INCH_TO_MM;
  },
  /** mm → 原理图单位（0.01inch） */
  mmToSch(mm) {
    return mm / 0.254;
  },
  /** 原理图单位 → mm */
  schToMm(u) {
    return u * 0.254;
  },
  /** mil → 原理图单位 */
  milToSch(mil) {
    return mil / 10;
  },
  /** 原理图单位 → mil */
  schToMil(u) {
    return u * 10;
  },
  /** 保留 digits 位小数（默认 4 位，对齐 sys_Unit 行为） */
  round(v, digits = 4) {
    if (!Number.isFinite(v)) return v;
    const p = 10 ** digits;
    return Math.round(v * p) / p;
  },
  /**
   * 统一换算入口。
   * @param {number} value
   * @param {{from:'mm'|'mil'|'sch', to:'mm'|'mil'|'sch'}} spec
   */
  convert(value, { from, to }) {
    if (from === to) return value;
    const table = {
      mm: { mil: Units.mmToMil, sch: Units.mmToSch },
      mil: { mm: Units.milToMm, sch: Units.milToSch },
      sch: { mm: Units.schToMm, mil: Units.schToMil },
    };
    const fn = table[from]?.[to];
    if (!fn) throw new Error(`未知单位换算: ${from} → ${to}（支持 mm/mil/sch）`);
    return fn(value);
  },
};

/** 单位名别名归一化：mm/mil/um/sch/unit */
export function normalizeUnitName(name) {
  // 微米符号可能用 µ(U+00B5) 或 μ(U+03BC)，统一归一到 'u'
  const n = String(name || '').trim().toLowerCase().replace(/[µμ]/g, 'u');
  switch (n) {
    case 'mm':
    case 'millimeter':
    case 'millimeters':
      return 'mm';
    case 'mil':
    case 'mils':
    case 'thou':
    case 'th':
    case 'thousandth':
      return 'mil';
    case 'sch':
    case 'schunit':
    case '0.01inch':
    case '10mil':
    case 'schematic':
      return 'sch';
    case 'um':
    case 'micrometer':
    case 'micrometers':
    case 'micron':
      return 'um';
    default:
      return n || 'unknown';
  }
}

/** 将统一单位值转成目标显示名 */
export function formatWithUnit(value, unit, digits = 4) {
  return `${Units.round(value, digits)} ${unit}`;
}
