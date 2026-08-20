/**
 * 布局引擎单测 —— 同尺 lint / bbox / 几何（L1 检测 + L2 引擎共用）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normBBoxMinMax, estimateComponentBox } from '../src/layout/bbox.mjs';
import { lintLayout, classifyComponent } from '../src/layout/lint.mjs';
import {
  rectFromMinMax, rectsOverlap, inflateRect, pointInsideRect,
  rectInside, combineRects, snapToGrid, snapToGridFloor, segmentIntersectsRect, pointDistToSegment,
} from '../src/layout/geometry.mjs';
import { solveAnchors, solveFlows, solvePairs } from '../src/layout/attach.mjs';
import { planCentralLR } from '../src/layout/central-lr.mjs';
import { planZones } from '../src/layout/zones.mjs';
import { planLabels } from '../src/layout/labels.mjs';
import { planLayout } from '../src/layout/planner.mjs';
import { verifyPlacements, fingerprintNetlist, netsChanged } from '../src/layout/verify.mjs';

// ─── 真实会话 mt0p48rfv8okqw 的最终 bbox（用户报告的 C3 压 U1 / Y1 与 GND 重叠）───
const REAL = {
  // sch_list 原样返回（minY>maxY 反转）
  U1: { minX: 129.5, maxX: 270.5, minY: 255.5, maxY: 44.5 },
  C3: { minX: 129.5, maxX: 140.5, minY: 161.5, maxY: 178.5 },
  Y1: { minX: 59.5, maxX: 80.5, minY: 57.5, maxY: 42.5 },
  GND_Y1: { minX: 67.5, maxX: 88.5, minY: 45.5, maxY: 35.5 },
};

test('normBBoxMinMax 归一化反转 Y（min<max 保证）', () => {
  const u1 = normBBoxMinMax(REAL.U1);
  assert.equal(u1.minX, 129.5);
  assert.equal(u1.maxX, 270.5);
  assert.equal(u1.minY, 44.5);   // 之前是 255.5（反转）
  assert.equal(u1.maxY, 255.5);  // 之前是 44.5
  assert.ok(u1.minY < u1.maxY);
});

test('rectFromMinMax 转 {x,y,w,h} 恒正', () => {
  const r = rectFromMinMax(129.5, 255.5, 270.5, 44.5); // 反转输入
  assert.deepEqual(r, { x: 129.5, y: 44.5, w: 141, h: 211 });
});

function rectOf(v) {
  return rectFromMinMax(v.minX, v.minY, v.maxX, v.maxY);
}

test('lintLayout 检出真实重叠（回归：C3 压 U1、Y1 与 GND）', () => {
  const comps = [
    { id: 'u1', designator: 'U1', x: 200, y: 150, net: null, bbox: rectOf(REAL.U1) },
    { id: 'c3', designator: 'C3', x: 135, y: 170, net: null, bbox: rectOf(REAL.C3) },
    { id: 'y1', designator: 'Y1', x: 70, y: 50, net: null, bbox: rectOf(REAL.Y1) },
    { id: 'gnd', designator: '', x: 78, y: 55, net: 'GND', bbox: rectOf(REAL.GND_Y1) },
  ];
  const lint = lintLayout(comps, { clearance: 0 });
  const pairSet = new Set(lint.overlaps.map((o) => [o.a, o.b].sort().join('|')));
  assert.ok(pairSet.has(['C3', 'U1'].sort().join('|')), '应检出 C3 压 U1');
  assert.ok(pairSet.has(['Y1', 'gnd'].sort().join('|')), '应检出 Y1 与 GND 重叠');
  // GND 标记引脚 (78,55) 压在 Y1 本体上
  assert.ok(lint.netflagsInsideParts.some((n) => n.flag === 'gnd' && n.part === 'Y1'));
});

test('lintLayout 无重叠时返回空（正常布局不误报）', () => {
  const comps = [
    { id: 'u1', designator: 'U1', x: 200, y: 150, net: null, bbox: { x: 300, y: 300, w: 100, h: 100 } },
    { id: 'c1', designator: 'C1', x: 100, y: 100, net: null, bbox: { x: 100, y: 100, w: 10, h: 10 } },
  ];
  const lint = lintLayout(comps, { clearance: 5 });
  assert.deepEqual(lint.overlaps, []);
  assert.deepEqual(lint.netflagsInsideParts, []);
});

test('lintLayout pinOverlaps：引脚点压其它本体（端点伸出覆盖到别的器件）', () => {
  // C3 的 pin2 (150,170) 落在 U1 本体上（真实场景：C3 压进 U1 时其右侧引脚也压进去）
  const comps = [
    { id: 'u1', designator: 'U1', x: 200, y: 150, net: null, bbox: { x: 129.5, y: 44.5, w: 141, h: 211 }, pins: [] },
    { id: 'c3', designator: 'C3', x: 135, y: 170, net: null, bbox: { x: 129.5, y: 161.5, w: 11, h: 17 }, pins: [{ number: '2', name: '2', x: 150, y: 170, net: 'GND' }] },
  ];
  // U1 本体 x 129.5-270.5，C3 pin2 (150,170) 在内
  const lint = lintLayout(comps, { clearance: 0 });
  assert.ok(lint.pinOverlaps.some((p) => p.kind === 'pin-on-body' && p.comp === 'C3' && p.overlapsBody === 'U1'), '应检出 C3 引脚压 U1 本体');
});

test('lintLayout pinOverlaps：两器件引脚端点重合（非同网潜在短路）', () => {
  const comps = [
    { id: 'a', designator: 'C1', x: 100, y: 100, net: null, bbox: { x: 94.5, y: 91.5, w: 11, h: 17 }, pins: [{ number: '1', name: '1', x: 120, y: 100, net: 'XTAL1' }] },
    { id: 'b', designator: 'C2', x: 100, y: 100, net: null, bbox: { x: 94.5, y: 91.5, w: 11, h: 17 }, pins: [{ number: '1', name: '1', x: 120, y: 100, net: 'GND' }] },
  ];
  const lint = lintLayout(comps, { clearance: 0 });
  assert.ok(lint.pinOverlaps.some((p) => p.kind === 'pin-coincide' && p.a === 'C1' && p.b === 'C2'), '应检出引脚重合');
});

test('lintLayout pinOverlaps：正常布局不误报（引脚在自身旁/同网连接）', () => {
  const comps = [
    { id: 'u1', designator: 'U1', x: 200, y: 150, net: null, bbox: { x: 129.5, y: 44.5, w: 141, h: 211 }, pins: [{ number: '9', name: 'RST', x: 120, y: 165, net: 'RST' }] },
    { id: 'c3', designator: 'C3', x: 100, y: 160, net: null, bbox: { x: 94.5, y: 151.5, w: 11, h: 17 }, pins: [{ number: '1', name: '1', x: 85, y: 160, net: 'RST' }] },
  ];
  // U1 引脚 (120,165) 在自己的本体边缘；C3 引脚 (85,160) 在自己的本体边缘 —— 都不压对方本体
  const lint = lintLayout(comps, { clearance: 0 });
  assert.equal(lint.pinOverlaps.filter((p) => p.kind === 'pin-on-body').length, 0, '不应误报引脚压本体');
});

test('classifyComponent 区分 part/netflag/other', () => {
  assert.equal(classifyComponent({ designator: 'U1', net: null }), 'part');
  assert.equal(classifyComponent({ designator: '', net: 'GND' }), 'netflag');
  assert.equal(classifyComponent({ designator: '', net: '' }), 'other');
});

test('estimateComponentBox 从引脚估算（含引脚跨距，中心在锚点）', () => {
  // 电容 C3 现状：pin1(120,170) pin2(150,170)，锚点 (135,170)
  const box = estimateComponentBox(
    [{ x: 120, y: 170 }, { x: 150, y: 170 }],
    { x: 135, y: 170 },
  );
  assert.ok(box.w >= 30, `宽应覆盖引脚跨距 120~150（实际 ${box.w}）`);
  assert.ok(box.h >= 14, `本体高 ${box.h}`);
  // 包围盒必须包含两个引脚点
  assert.ok(pointInsideRect(120, 170, box), '应包含 pin1');
  assert.ok(pointInsideRect(150, 170, box), '应包含 pin2');
  // 中心大致在锚点 (135,170)
  assert.ok(Math.abs((box.x + box.w / 2) - 135) < 1, `中心 x 应≈135（实际 ${box.x + box.w / 2}）`);
});

test('rectsOverlap 带 clearance', () => {
  const a = { x: 0, y: 0, w: 10, h: 10 };
  const b = { x: 12, y: 0, w: 10, h: 10 };
  assert.equal(rectsOverlap(a, b, 0), false);
  assert.equal(rectsOverlap(a, b, 3), true);    // 间距 2 < clearance 3 → 违规
  assert.equal(rectsOverlap(a, b, 2), false);   // 间距恰好 = clearance → 允许
  assert.equal(rectsOverlap(a, b, 1), false);
});

test('inflateRect / pointInsideRect / rectInside / combineRects', () => {
  const r = { x: 10, y: 20, w: 30, h: 40 };
  assert.deepEqual(inflateRect(r, 5), { x: 5, y: 15, w: 40, h: 50 });
  assert.equal(pointInsideRect(11, 21, r), true);
  assert.equal(pointInsideRect(9, 21, r), false);
  assert.equal(pointInsideRect(11, 21, r, 2), true);
  assert.equal(rectInside({ x: 15, y: 25, w: 10, h: 10 }, r), true);
  assert.equal(rectInside({ x: 5, y: 25, w: 10, h: 10 }, r), false);
  assert.deepEqual(combineRects([{ x: 0, y: 0, w: 5, h: 5 }, { x: 10, y: 10, w: 5, h: 5 }]), { x: 0, y: 0, w: 15, h: 15 });
});

test('snapToGrid / snapToGridFloor', () => {
  assert.equal(snapToGrid(12.4, 5), 10);
  assert.equal(snapToGrid(12.6, 5), 15);
  assert.equal(snapToGridFloor(14, 5), 10);   // 下取整（推让上限用）
  assert.equal(snapToGridFloor(16, 5), 15);
});

test('segmentIntersectsRect（导线穿本体检测）', () => {
  const body = { x: 10, y: 10, w: 20, h: 20 };
  assert.equal(segmentIntersectsRect(0, 15, 40, 15, body), true);   // 横穿
  assert.equal(segmentIntersectsRect(0, 5, 40, 5, body), false);    // 上方经过
  assert.equal(segmentIntersectsRect(15, 0, 15, 40, body), true);   // 竖穿
});

test('pointDistToSegment', () => {
  assert.equal(pointDistToSegment(0, 0, 0, 0, 10, 0), 0);       // 在线上
  assert.equal(pointDistToSegment(0, 5, 0, 0, 10, 0), 5);       // 上方
  assert.equal(pointDistToSegment(20, 0, 0, 0, 10, 0), 10);     // 端点外
});

// ─── L2 布局引擎 ────────────────────────────────────────────

// 真实会话数据（51 最小系统）
const U1 = {
  id: 'u1', designator: 'U1', x: 200, y: 150, rotation: 0,
  bbox: rectOf(REAL.U1),
  pins: [
    { number: '9', name: 'RST', x: 120, y: 165 },
    { number: '18', name: 'XTAL2', x: 120, y: 75 },
    { number: '19', name: 'XTAL1', x: 120, y: 65 },
    { number: '20', name: 'GND', x: 120, y: 55 },
    { number: '40', name: 'VCC', x: 280, y: 245 },
    { number: '31', name: 'EA#', x: 280, y: 155 },
  ],
};
const C3 = {
  id: 'c3', designator: 'C3', x: 135, y: 170, rotation: 0,
  bbox: rectOf(REAL.C3),
  pins: [{ number: '1', name: '1', x: 120, y: 170 }, { number: '2', name: '2', x: 150, y: 170 }],
};

test('solveAnchors: C3 贴 U1.RST（pin1 命中 + 本体让开，回归用户 bug）', () => {
  const { placements, notes } = solveAnchors(
    [U1, C3],
    [{ s: 'C3', p: '1', t: 'U1', tp: 'RST' }],
    { clearance: 5, grid: 5 },
  );
  assert.equal(notes.length, 0);
  const p = placements.find((x) => x.designator === 'C3');
  assert.ok(p, '应产出 C3 的 placement');
  // 旋转 180 → pin1 rel 翻转为 +15，pin1 应命中 (120,165)
  const pin1X = p.x + 15;
  const pin1Y = p.y;
  assert.equal(pin1X, 120, 'pin1 X 应命中 U1.RST');
  assert.equal(pin1Y, 165, 'pin1 Y 应命中 U1.RST');
  // 本体平移后不得与 U1 重叠
  const body = { x: C3.bbox.x + (p.x - C3.x), y: C3.bbox.y + (p.y - C3.y), w: C3.bbox.w, h: C3.bbox.h };
  const u1 = U1.bbox;
  const overlap = body.x < u1.x + u1.w && body.x + body.w > u1.x && body.y < u1.y + u1.h && body.y + body.h > u1.y;
  assert.equal(overlap, false, 'C3 本体应让开 U1');
  assert.equal(p.rotation, 180, '应背向宿主旋转 180°');
});

test('solveAnchors: 多卫星贴同一脚（一字排开不重叠）', () => {
  const c4 = { ...C3, id: 'c4', designator: 'C4' };
  const { placements, notes } = solveAnchors(
    [U1, C3, c4],
    [
      { s: 'C3', p: '1', t: 'U1', tp: 'RST' },
      { s: 'C4', p: '1', t: 'U1', tp: 'RST' },
    ],
    { clearance: 5, grid: 5 },
  );
  assert.equal(notes.length, 0, `notes: ${JSON.stringify(notes)}`);
  const p1 = placements.find((x) => x.designator === 'C3');
  const p2 = placements.find((x) => x.designator === 'C4');
  assert.ok(p1 && p2);
  // 两个卫星本体不得重叠
  const b1 = { x: C3.bbox.x + (p1.x - C3.x), y: C3.bbox.y + (p1.y - C3.y), w: C3.bbox.w, h: C3.bbox.h };
  const b2 = { x: C3.bbox.x + (p2.x - C3.x), y: C3.bbox.y + (p2.y - C3.y), w: C3.bbox.w, h: C3.bbox.h };
  assert.equal(b1.x < b2.x + b2.w && b1.x + b1.w > b2.x && b1.y < b2.y + b2.h && b1.y + b1.h > b2.y, false, '两卫星不得重叠');
});

test('solveAnchors: 贴到非锚件（递归，C3 贴 R1 引脚）', () => {
  const r1 = {
    id: 'r1', designator: 'R1', x: 110, y: 165, rotation: 0,
    bbox: { x: 99.5, y: 160.5, w: 21, h: 9 },
    pins: [{ number: '1', name: '1', x: 90, y: 165 }, { number: '2', name: '2', x: 130, y: 165 }],
  };
  const { placements, notes } = solveAnchors(
    [U1, r1, C3],
    [
      { s: 'R1', p: '2', t: 'U1', tp: 'RST' },
      { s: 'C3', p: '1', t: 'R1', tp: '1' },
    ],
    { clearance: 5, grid: 5 },
  );
  // R1 贴 RST，C3 再贴到 R1（非锚件）——两条都应解出且不重叠
  assert.equal(notes.length, 0, `notes: ${JSON.stringify(notes)}`);
  assert.equal(placements.length, 2);
});

test('solveFlows: 信号链沿 +x 顺排且不重叠', () => {
  const a = { id: 'a', designator: 'Y1', x: 70, y: 50, rotation: 180, bbox: { x: 59.5, y: 42.5, w: 21, h: 15 }, pins: [] };
  const b = { id: 'b', designator: 'C1', x: 100, y: 55, rotation: 0, bbox: { x: 94.5, y: 46.5, w: 11, h: 17 }, pins: [] };
  const c = { id: 'c', designator: 'C2', x: 100, y: 95, rotation: 0, bbox: { x: 94.5, y: 91.5, w: 11, h: 17 }, pins: [] };
  const { placements, notes } = solveFlows([a, b, c], [{ members: ['Y1', 'C1', 'C2'], direction: 1 }], { clearance: 5, grid: 5, spacing: 8 });
  assert.equal(notes.length, 0);
  const pb = placements.find((p) => p.designator === 'C1');
  const pc = placements.find((p) => p.designator === 'C2');
  assert.ok(pb.x > 70, 'C1 应在 Y1 右侧');
  assert.ok(pc.x > pb.x, 'C2 应在 C1 右侧');
  assert.equal(pb.y, pc.y, '应共线');
});

test('solvePairs: 等距并列', () => {
  const a = { id: 'a', designator: 'C1', x: 100, y: 100, rotation: 0, bbox: { x: 94.5, y: 91.5, w: 11, h: 17 }, pins: [] };
  const b = { id: 'b', designator: 'C2', x: 200, y: 300, rotation: 0, bbox: { x: 194.5, y: 291.5, w: 11, h: 17 }, pins: [] };
  const c = { id: 'c', designator: 'C3', x: 300, y: 400, rotation: 0, bbox: { x: 294.5, y: 391.5, w: 11, h: 17 }, pins: [] };
  const { placements } = solvePairs([a, b, c], [{ members: ['C1', 'C2', 'C3'] }], { clearance: 5, grid: 5, spacing: 8 });
  assert.equal(placements.length, 2);
  const pb = placements.find((p) => p.designator === 'C2');
  const pc = placements.find((p) => p.designator === 'C3');
  const pitch1 = pb.x - 100;
  const pitch2 = pc.x - pb.x;
  assert.ok(Math.abs(pitch1 - pitch2) < 1, `等距（${pitch1} vs ${pitch2}）`);
});

test('planCentralLR: 核心居中，外设左右不重叠', () => {
  const comps = [
    U1,
    { ...C3, designator: 'C3' },
    { id: 'y1', designator: 'Y1', x: 70, y: 50, rotation: 180, bbox: { x: 59.5, y: 42.5, w: 21, h: 15 }, pins: [] },
    { id: 'c1', designator: 'C1', x: 100, y: 55, rotation: 0, bbox: { x: 94.5, y: 46.5, w: 11, h: 17 }, pins: [] },
  ];
  const { placements } = planCentralLR(comps, 'U1', { usable: { x: 0, y: 0, w: 1200, h: 800 }, clearance: 10 });
  const core = placements.find((p) => p.designator === 'U1');
  assert.ok(core, '核心应放置');
  const bodies = placements.map((p) => {
    const c = comps.find((x) => x.id === p.id);
    return c.bbox ? { ...c.bbox, x: c.bbox.x + (p.x - c.x), y: c.bbox.y + (p.y - c.y) } : null;
  }).filter(Boolean);
  for (let i = 0; i < bodies.length; i++) {
    for (let j = i + 1; j < bodies.length; j++) {
      const a = bodies[i], b = bodies[j];
      assert.equal(a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y, false, '中央布局不得重叠');
    }
  }
});

test('planZones: 功能分区铺散不重叠', () => {
  const comps = [
    { id: 'u1', designator: 'U1', x: 200, y: 150, rotation: 0, bbox: { x: 129.5, y: 44.5, w: 141, h: 211 } },
    { id: 'c1', designator: 'C1', x: 100, y: 55, rotation: 0, bbox: { x: 94.5, y: 46.5, w: 11, h: 17 } },
    { id: 'r1', designator: 'R1', x: 110, y: 165, rotation: 0, bbox: { x: 99.5, y: 160.5, w: 21, h: 9 } },
    { id: 'j1', designator: 'J1', x: 500, y: 400, rotation: 0, bbox: { x: 490, y: 380, w: 40, h: 40 } },
  ];
  const { placements, unplaced } = planZones(comps, { pageRect: { x: 0, y: 0, w: 1200, h: 800 } });
  assert.equal(unplaced.length, 0, '全部放置');
  assert.equal(placements.length, 4);
  const bodies = placements.map((p) => {
    const c = comps.find((x) => x.id === p.id);
    return c.bbox ? { ...c.bbox, x: c.bbox.x + (p.x - c.x), y: c.bbox.y + (p.y - c.y) } : null;
  }).filter(Boolean);
  for (let i = 0; i < bodies.length; i++) {
    for (let j = i + 1; j < bodies.length; j++) {
      const a = bodies[i], b = bodies[j];
      assert.equal(a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y, false, '分区铺散不得重叠');
    }
  }
});

test('planLabels: 标记从器件本体中拉出且不压本体', () => {
  const flag = { id: 'g', designator: '', x: 78, y: 55, rotation: 0, net: 'GND', bbox: rectOf(REAL.GND_Y1) };
  const partBody = { x: 59.5, y: 42.5, w: 21, h: 15 }; // Y1 本体（标记原压在它上面）
  const { placements } = planLabels([flag], [partBody], { clearance: 5, grid: 5 });
  const p = placements[0];
  assert.ok(p, '应产出放置');
  // 图形不得压 Y1 本体
  const rel = { dx: flag.bbox.x - flag.x, dy: flag.bbox.y - flag.y, w: flag.bbox.w, h: flag.bbox.h };
  const graphic = { x: p.x + rel.dx, y: p.y + rel.dy, w: rel.w, h: rel.h };
  assert.equal(rectsOverlap(graphic, partBody, 5), false, '标记图形不得压器件本体');
});

test('planLayout 端到端：51 最小系统重排 → 0 重叠 0 标记压件 0 越界', () => {
  const comps = [
    U1,
    { id: 'y1', designator: 'Y1', x: 70, y: 50, rotation: 180, bbox: rectOf(REAL.Y1), pins: [{ number: '1', name: '1', x: 90, y: 50 }, { number: '2', name: '2', x: 50, y: 50 }] },
    { id: 'c1', designator: 'C1', x: 100, y: 55, rotation: 0, bbox: { x: 94.5, y: 46.5, w: 11, h: 17 }, pins: [{ number: '1', name: '1', x: 85, y: 55 }, { number: '2', name: '2', x: 115, y: 55 }] },
    { id: 'c2', designator: 'C2', x: 100, y: 95, rotation: 0, bbox: { x: 94.5, y: 91.5, w: 11, h: 17 }, pins: [{ number: '1', name: '1', x: 85, y: 95 }, { number: '2', name: '2', x: 115, y: 95 }] },
    C3,
    { id: 'r1', designator: 'R1', x: 110, y: 165, rotation: 0, bbox: { x: 99.5, y: 160.5, w: 21, h: 9 }, pins: [{ number: '1', name: '1', x: 90, y: 165 }, { number: '2', name: '2', x: 130, y: 165 }] },
    { id: 'c4', designator: 'C4', x: 300, y: 265, rotation: 0, bbox: { x: 289.5, y: 256.5, w: 21, h: 17 }, pins: [{ number: '1', name: '1', x: 280, y: 265 }, { number: '2', name: '2', x: 320, y: 265 }] },
    { id: 'g1', designator: '', x: 78, y: 55, rotation: 0, net: 'GND', bbox: rectOf(REAL.GND_Y1), pins: [] },
    { id: 'g2', designator: '', x: 158, y: 170, rotation: 0, net: 'GND', bbox: { x: 147.5, y: 150.5, w: 21, h: 10 }, pins: [] },
    { id: 'p1', designator: '', x: 292, y: 245, rotation: 0, net: '+5V', bbox: { x: 286.5, y: 249.5, w: 11, h: 6 }, pins: [] },
  ];
  const intent = {
    mode: 'central-lr',
    core: 'U1',
    anchors: [
      { s: 'C3', p: '1', t: 'U1', tp: 'RST' },
      { s: 'C4', p: '1', t: 'U1', tp: 'VCC' },
      { s: 'R1', p: '2', t: 'U1', tp: 'RST' },
    ],
    groups: [{ name: '晶振', members: ['Y1', 'C1', 'C2'], kind: 'flow', direction: 1 }],
    netFlags: [{ net: 'GND', dir: 'down' }, { net: '+5V', dir: 'up' }],
    layout: { clearance: 5 },
  };
  const r = planLayout({ components: comps, intent, sheet: { x: 0, y: 0, w: 1200, h: 800 } });
  assert.equal(r.violations.ok, true, `violations: ${JSON.stringify(r.violations)}`);
  assert.equal(r.violations.overlaps.length, 0);
  assert.equal(r.violations.netflagsInsideParts.length, 0);
  assert.equal(r.violations.outOfSheet.length, 0);
});

test('坐标系统 Y-up：贴顶部引脚 → 上方（更大 y）；贴底部引脚 → 下方（更小 y）', () => {
  // 立创EDA 默认 0 点在左下角，Y 向上：宿主 bbox y 44.5(底)-255.5(顶)
  const host = {
    id: 'h', designator: 'U1', x: 200, y: 150, rotation: 0,
    bbox: { x: 129.5, y: 44.5, w: 141, h: 211 },
    pins: [
      { number: '1', name: 'TOP', x: 280, y: 245 }, // 顶部引脚（y 大）
      { number: '2', name: 'BOT', x: 280, y: 55 },  // 底部引脚（y 小）
    ],
  };
  const capA = { id: 'a', designator: 'CA', x: 300, y: 245, rotation: 0, bbox: { x: 294.5, y: 236.5, w: 11, h: 17 }, pins: [{ number: '1', name: '1', x: 280, y: 245 }, { number: '2', name: '2', x: 310, y: 245 }] };
  const capB = { id: 'b', designator: 'CB', x: 300, y: 55, rotation: 0, bbox: { x: 294.5, y: 46.5, w: 11, h: 17 }, pins: [{ number: '1', name: '1', x: 280, y: 55 }, { number: '2', name: '2', x: 310, y: 55 }] };
  const r = solveAnchors(
    [host, capA, capB],
    [
      { s: 'CA', p: '1', t: 'U1', tp: 'TOP' },
      { s: 'CB', p: '1', t: 'U1', tp: 'BOT' },
    ],
    { clearance: 5, grid: 5 },
  );
  const pa = r.placements.find((p) => p.designator === 'CA');
  const pb = r.placements.find((p) => p.designator === 'CB');
  assert.ok(pa && pb, '两电容都应放置');
  assert.ok(pa.y > pb.y, `CA 应在上方（y=${pa.y}），CB 应在下方（y=${pb.y}）`);
});

test('无网表连通性推断：GND 标记反推引脚网络，去耦电容贴到 GND 引脚', () => {
  const mkPin = (number, name, x, y, net) => ({ number, name, x, y, net });
  // U1 有 VCC(顶) 和 GND(底) 引脚（无 net，模拟无网表）
  const comps = [
    { id: 'u1', designator: 'U1', x: 200, y: 150, rotation: 0, net: null, bbox: { minX: 129.5, minY: 255.5, maxX: 270.5, maxY: 44.5 }, pins: [mkPin('20', 'GND', 120, 55, null), mkPin('40', 'VCC', 280, 245, null)] },
    // 去耦电容 C4：pin1(+5V) pin2(GND)，但都没有 net —— 靠近 GND 标记的引脚被反推
    { id: 'c4', designator: 'C4', x: 300, y: 265, rotation: 0, net: null, bbox: { minX: 289.5, minY: 273.5, maxX: 310.5, maxY: 256.5 }, pins: [mkPin('1', '1', 280, 265, null), mkPin('2', '2', 320, 265, null)] },
    // GND 标记：连接点在 (120,55) 附近（U1.GND 引脚旁）
    { id: 'g1', designator: '', x: 118, y: 56, rotation: 0, net: 'GND', bbox: { minX: 107.5, minY: 46.5, maxX: 128.5, maxY: 65.5 }, pins: [] },
  ];
  const r = planLayout({ components: comps, intent: { mode: 'central-lr', core: 'U1', layout: { clearance: 5 } }, sheet: { x: 10, y: 10, w: 1150, h: 805 } });
  // C4 应被放置（inferPinNetsFromFlags 给 U1.GND 引脚反推 net 后 autoDetect 生效）
  assert.ok(r.placements.some((p) => p.designator === 'C4'), 'C4 应放置');
});

test('solveAnchors 强制间距：贴脚后器件间隙 ≥ PART_GAP（布线通道不挤没）', () => {
  const host = {
    id: 'h', designator: 'U1', x: 200, y: 150, rotation: 0,
    bbox: { x: 129.5, y: 44.5, w: 141, h: 211 },
    pins: [{ number: '40', name: 'VCC', x: 280, y: 245 }, { number: '9', name: 'RST', x: 120, y: 165 }],
  };
  const c1 = { id: 'a', designator: 'C1', x: 300, y: 265, rotation: 0, bbox: { x: 289.5, y: 256.5, w: 21, h: 17 }, pins: [{ number: '1', name: '1', x: 280, y: 265 }, { number: '2', name: '2', x: 320, y: 265 }] };
  const c2 = { id: 'b', designator: 'C2', x: 300, y: 300, rotation: 0, bbox: { x: 289.5, y: 291.5, w: 21, h: 17 }, pins: [{ number: '1', name: '1', x: 280, y: 300 }, { number: '2', name: '2', x: 320, y: 300 }] };
  const r = solveAnchors(
    [host, c1, c2],
    [{ s: 'C1', p: '1', t: 'U1', tp: 'VCC' }, { s: 'C2', p: '1', t: 'U1', tp: 'RST' }],
    { clearance: 5, grid: 5 },
  );
  const p1 = r.placements.find((x) => x.designator === 'C1');
  const p2 = r.placements.find((x) => x.designator === 'C2');
  assert.ok(p1 && p2, '两电容都应放置');
  // 两电容间隙应 ≥ PART_GAP（14）
  const b1 = { x: c1.bbox.x + (p1.x - c1.x), y: c1.bbox.y + (p1.y - c1.y), w: c1.bbox.w, h: c1.bbox.h };
  const b2 = { x: c2.bbox.x + (p2.x - c2.x), y: c2.bbox.y + (p2.y - c2.y), w: c2.bbox.w, h: c2.bbox.h };
  const xGap = Math.max(b2.x - (b1.x + b1.w), b1.x - (b2.x + b2.w));
  const yGap = Math.max(b2.y - (b1.y + b1.h), b1.y - (b2.y + b2.h));
  const gap = Math.max(xGap, yGap);
  assert.ok(gap >= 14 - 1, `电容间隙 ${gap} 应 ≥ PART_GAP(14)`);
});

test('planLayout 确定性：同输入同输出', () => {
  const intent = { mode: 'central-lr', core: 'U1', anchors: [{ s: 'C3', p: '1', t: 'U1', tp: 'RST' }] };
  const input = { components: [U1, C3], intent, sheet: { x: 0, y: 0, w: 1200, h: 800 } };
  const r1 = planLayout(input);
  const r2 = planLayout(input);
  assert.deepEqual(r1.placements, r2.placements, '两次运行结果一致');
});

test('planLayout 无 anchors 自动推断贴脚：相关器件按网表连通性分组', () => {
  // 51 最小系统 + 引脚网络（生产格式 min/max bbox）
  const mkPin = (number, name, x, y, net) => ({ number, name, x, y, net });
  const comps = [
    { id: 'u1', designator: 'U1', x: 200, y: 150, rotation: 0, net: null, bbox: { minX: 129.5, minY: 255.5, maxX: 270.5, maxY: 44.5 }, pins: [
      mkPin('9', 'RST', 120, 165, 'RST'), mkPin('19', 'XTAL1', 120, 65, 'XTAL1'), mkPin('18', 'XTAL2', 120, 75, 'XTAL2'),
      mkPin('20', 'GND', 120, 55, 'GND'), mkPin('40', 'VCC', 280, 245, '+5V'), mkPin('31', 'EA#', 280, 155, '+5V') ] },
    { id: 'y1', designator: 'Y1', x: 70, y: 50, rotation: 180, net: null, bbox: { minX: 59.5, minY: 57.5, maxX: 80.5, maxY: 42.5 }, pins: [mkPin('1', '1', 90, 50, 'XTAL1'), mkPin('2', '2', 50, 50, 'XTAL2')] },
    { id: 'c1', designator: 'C1', x: 100, y: 55, rotation: 0, net: null, bbox: { minX: 94.5, minY: 63.5, maxX: 105.5, maxY: 46.5 }, pins: [mkPin('1', '1', 85, 55, 'XTAL1'), mkPin('2', '2', 115, 55, 'GND')] },
    { id: 'c2', designator: 'C2', x: 100, y: 95, rotation: 0, net: null, bbox: { minX: 94.5, minY: 103.5, maxX: 105.5, maxY: 91.5 }, pins: [mkPin('1', '1', 85, 95, 'XTAL2'), mkPin('2', '2', 115, 95, 'GND')] },
    { id: 'c3', designator: 'C3', x: 135, y: 170, rotation: 0, net: null, bbox: { minX: 129.5, minY: 178.5, maxX: 140.5, maxY: 161.5 }, pins: [mkPin('1', '1', 120, 170, 'RST'), mkPin('2', '2', 150, 170, 'GND')] },
    { id: 'r1', designator: 'R1', x: 110, y: 165, rotation: 0, net: null, bbox: { minX: 99.5, minY: 169.5, maxX: 120.5, maxY: 160.5 }, pins: [mkPin('1', '1', 90, 165, '+5V'), mkPin('2', '2', 130, 165, 'RST')] },
    { id: 'c4', designator: 'C4', x: 300, y: 265, rotation: 0, net: null, bbox: { minX: 289.5, minY: 273.5, maxX: 310.5, maxY: 256.5 }, pins: [mkPin('1', '1', 280, 265, '+5V'), mkPin('2', '2', 320, 265, 'GND')] },
    { id: 'g1', designator: '', x: 78, y: 55, rotation: 0, net: 'GND', bbox: { minX: 67.5, minY: 45.5, maxX: 88.5, maxY: 35.5 }, pins: [mkPin('1', 'Pin1', 78, 55, 'GND')] },
    { id: 'p1', designator: '', x: 292, y: 245, rotation: 0, net: '+5V', bbox: { minX: 286.5, minY: 255.5, maxX: 297.5, maxY: 249.5 }, pins: [mkPin('1', 'Pin1', 292, 245, '+5V')] },
  ];
  // 只传 mode+core，不传 anchors —— 引擎自动推断贴脚
  const r = planLayout({ components: comps, intent: { mode: 'central-lr', core: 'U1', layout: { clearance: 5 } }, sheet: { x: 0, y: 0, w: 1169, h: 827 } });
  assert.ok(r.notes.some((n) => n.includes('自动推断贴脚')), `应自动推断: ${JSON.stringify(r.notes)}`);
  assert.equal(r.violations.ok, true, `violations: ${JSON.stringify(r.violations)}`);
  const get = (d) => r.placements.find((p) => p.designator === d);
  const u = get('U1');
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const rst = { x: u.x - 80, y: u.y + 15 };
  const xtal1 = { x: u.x - 80, y: u.y - 85 };
  const vcc = { x: u.x + 80, y: u.y + 95 };
  // 相关器件应贴近其引脚
  assert.ok(dist(get('C3'), rst) < 40, `C3 应贴近 RST（距 ${dist(get('C3'), rst).toFixed(0)}）`);
  assert.ok(dist(get('Y1'), xtal1) < 60, `Y1 应贴近 XTAL1（距 ${dist(get('Y1'), xtal1).toFixed(0)}）`);
  assert.ok(dist(get('C4'), vcc) < 60, `C4 应贴近 VCC（距 ${dist(get('C4'), vcc).toFixed(0)}）`);
});

test('autoDetectAnchors 多 IC 分簇：无源件归到其连接的 IC，非核心', () => {
  // 双 IC：U1（核心）+ U2，各自带 2 脚无源件
  const mkP = (number, name, x, y, net) => ({ number, name, x, y, net });
  const comps = [
    { id: 'u1', designator: 'U1', x: 200, y: 150, rotation: 0, net: null, bbox: { minX: 129.5, minY: 255.5, maxX: 270.5, maxY: 44.5 }, pins: [mkP('9', 'RST', 120, 165, 'RST'), mkP('40', 'VCC', 280, 245, '+5V')] },
    { id: 'u2', designator: 'U2', x: 500, y: 150, rotation: 0, net: null, bbox: { minX: 429.5, minY: 255.5, maxX: 570.5, maxY: 44.5 }, pins: [mkP('1', 'IN', 480, 245, 'SIG2'), mkP('2', 'OUT', 560, 245, 'OUT2')] },
    { id: 'c3', designator: 'C3', x: 135, y: 170, rotation: 0, net: null, bbox: { minX: 129.5, minY: 178.5, maxX: 140.5, maxY: 161.5 }, pins: [mkP('1', '1', 120, 170, 'RST'), mkP('2', '2', 150, 170, 'GND')] },
    { id: 'c1', designator: 'C1', x: 500, y: 245, rotation: 0, net: null, bbox: { minX: 494.5, minY: 236.5, maxX: 505.5, maxY: 253.5 }, pins: [mkP('1', '1', 480, 245, 'SIG2'), mkP('2', '2', 520, 245, 'GND')] },
  ];
  const intent = { mode: 'central-lr', core: 'U1', layout: { clearance: 5 } };
  const r = planLayout({ components: comps, intent, sheet: { x: 0, y: 0, w: 1170, h: 825 } });
  // C3 贴 U1.RST（核心簇）；C1 贴 U2.IN（第二 IC 簇）
  const c3 = r.placements.find((p) => p.designator === 'C3');
  const c1 = r.placements.find((p) => p.designator === 'C1');
  const u1 = r.placements.find((p) => p.designator === 'U1');
  const u2 = r.placements.find((p) => p.designator === 'U2');
  assert.ok(u1 && u2 && c3 && c1, '全部应放置');
  const rst = { x: u1.x - 80, y: u1.y + 15 };
  const u2in = { x: u2.x - 20, y: u2.y + 95 };
  // C3 应贴 U1.RST 近，C1 应贴 U2.IN 近
  assert.ok(Math.hypot(c3.x - rst.x, c3.y - rst.y) < Math.hypot(c1.x - rst.x, c1.y - rst.y), 'C3 应属 U1 簇');
  assert.ok(Math.hypot(c1.x - u2in.x, c1.y - u2in.y) < Math.hypot(c3.x - u2in.x, c3.y - u2in.y), 'C1 应属 U2 簇');
});

test('planLayout 生产格式（min/max bbox）：violations 必须真实检出重叠（回归：原假通过）', () => {
  // 生产：index.mjs normalizeCompsForPlan 输出 {minX,minY,maxX,maxY}，反转 Y 也常见
  const compsMinMax = [
    { id: 'u1', designator: 'U1', x: 200, y: 150, rotation: 0, net: null, bbox: { minX: 129.5, minY: 255.5, maxX: 270.5, maxY: 44.5 }, pins: [] },
    { id: 'c3', designator: 'C3', x: 135, y: 170, rotation: 0, net: null, bbox: { minX: 129.5, minY: 178.5, maxX: 140.5, maxY: 161.5 }, pins: [] },
  ];
  // rearrange 模式不移动 → 验证必须报出这俩的重叠
  const r = planLayout({ components: compsMinMax, intent: { mode: 'rearrange' }, sheet: { x: 0, y: 0, w: 1200, h: 800 } });
  assert.equal(r.violations.ok, false, `应检出重叠: ${JSON.stringify(r.violations)}`);
  assert.ok(r.violations.overlaps.length >= 1, '应至少一对重叠');
});

test('planLayout 生产格式：正常布局 violations.ok=true（不误报）', () => {
  const compsMinMax = [
    { id: 'u1', designator: 'U1', x: 200, y: 150, rotation: 0, net: null, bbox: { minX: 129.5, minY: 255.5, maxX: 270.5, maxY: 44.5 }, pins: [] },
    { id: 'c1', designator: 'C1', x: 320, y: 160, rotation: 0, net: null, bbox: { minX: 314.5, minY: 168.5, maxX: 325.5, maxY: 151.5 }, pins: [] },
  ];
  const r = planLayout({ components: compsMinMax, intent: { mode: 'rearrange' }, sheet: { x: 0, y: 0, w: 1200, h: 800 } });
  assert.equal(r.violations.ok, true, `不应误报: ${JSON.stringify(r.violations)}`);
});

test('递归贴非锚件：C3 pin1 精确命中 R1 移动后 pin1 新位置（回归：引脚未平移错位）', () => {
  const r1 = {
    id: 'r1', designator: 'R1', x: 110, y: 165, rotation: 0,
    bbox: { x: 99.5, y: 160.5, w: 21, h: 9 },
    pins: [{ number: '1', name: '1', x: 90, y: 165 }, { number: '2', name: '2', x: 130, y: 165 }],
  };
  const c3 = {
    id: 'c3', designator: 'C3', x: 135, y: 170, rotation: 0,
    bbox: { x: 129.5, y: 161.5, w: 11, h: 17 },
    pins: [{ number: '1', name: '1', x: 120, y: 170 }, { number: '2', name: '2', x: 150, y: 170 }],
  };
  const { placements, notes } = solveAnchors(
    [U1, r1, c3],
    [
      { s: 'R1', p: '2', t: 'U1', tp: 'RST' },   // R1 先贴 U1.RST（会被移动）
      { s: 'C3', p: '1', t: 'R1', tp: '1' },      // C3 再贴 R1 移动后的 pin1
    ],
    { clearance: 5, grid: 5 },
  );
  assert.equal(notes.length, 0, `notes: ${JSON.stringify(notes)}`);
  const pR1 = placements.find((p) => p.designator === 'R1');
  const pC3 = placements.find((p) => p.designator === 'C3');
  assert.ok(pR1 && pC3);
  // R1 pin1 新位置（R1 移动后 pin1 相对 + pin1 rel）
  const r1Pin1X = pR1.x + (90 - 110);   // pin1 rel = (90-110, 165-165) = (-20, 0)
  const r1Pin1Y = pR1.y + (165 - 165);
  // C3 贴到 R1.pin1：C3 pin1 相对 C3 锚点（旋转 180 后 +15）
  const c3Pin1X = pC3.x + 15;
  const c3Pin1Y = pC3.y;
  assert.equal(c3Pin1X, r1Pin1X, `C3 pin1 X 应命中 R1 pin1 新 X（${r1Pin1X}）`);
  assert.equal(c3Pin1Y, r1Pin1Y, `C3 pin1 Y 应命中 R1 pin1 新 Y（${r1Pin1Y}）`);
});

test('verifyPlacements: 检出重叠', () => {
  const comps = [
    { id: 'u1', designator: 'U1', x: 200, y: 150, rotation: 0, bbox: { x: 129.5, y: 44.5, w: 141, h: 211 } },
    { id: 'c3', designator: 'C3', x: 135, y: 170, rotation: 0, bbox: { x: 129.5, y: 161.5, w: 11, h: 17 } },
  ];
  const v = verifyPlacements(comps, [], { clearance: 0 });
  assert.equal(v.ok, false);
  assert.equal(v.overlaps.length, 1);
});

test('fingerprintNetlist / netsChanged', () => {
  const netlist = [
    { net: 'GND', pins: [{ comp: 'C1', pin: '2' }, { comp: 'U1', pin: '20' }] },
    { net: 'VCC', pins: [{ comp: 'U1', pin: '40' }] },
  ];
  const fp1 = fingerprintNetlist(netlist);
  const fp2 = fingerprintNetlist([
    { net: 'GND', pins: [{ comp: 'C1', pin: '2' }, { comp: 'U1', pin: '20' }] },
    { net: 'VCC', pins: [{ comp: 'U1', pin: '40' }] },
  ]);
  const fp3 = fingerprintNetlist([
    { net: 'GND', pins: [{ comp: 'C1', pin: '2' }, { comp: 'U1', pin: '19' }] }, // pin 变了
    { net: 'VCC', pins: [{ comp: 'U1', pin: '40' }] },
  ]);
  assert.equal(netsChanged(fp1, fp2), false, '相同网表指纹一致');
  assert.equal(netsChanged(fp1, fp3), true, '网表变化指纹变化');
});
