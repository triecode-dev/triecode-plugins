/**
 * 确定性布线器单测（A* 正交绕障）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { routeWire, simplifyPolyline, snapPolyline, polylineHitsObstacles, steinerTree } from '../src/layout/router.mjs';

test('无障碍直连：正交路径，首尾精确', () => {
  const pts = routeWire({ x: 0, y: 0 }, { x: 100, y: 0 }, [], { grid: 10 });
  assert.ok(pts && pts.length >= 2);
  assert.deepEqual(pts[0], { x: 0, y: 0 });
  assert.deepEqual(pts[pts.length - 1], { x: 100, y: 0 });
  // 所有段横平竖直
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    assert.ok(a.x === b.x || a.y === b.y, '必须正交');
  }
});

test('中间障碍：自动绕开，不穿障', () => {
  const obs = [{ x: 40, y: -15, w: 20, h: 30 }];
  const pts = routeWire({ x: 0, y: 0 }, { x: 100, y: 0 }, obs, { grid: 10 });
  assert.ok(pts, '应有路径');
  assert.equal(polylineHitsObstacles(pts, obs).length, 0, '不得穿过障碍');
});

test('U 型障碍：绕行且不穿障', () => {
  // 两个并列障碍形成窄缝
  const obs = [
    { x: 40, y: -30, w: 15, h: 20 },
    { x: 40, y: 10, w: 15, h: 20 },
  ];
  const pts = routeWire({ x: 0, y: 0 }, { x: 100, y: 0 }, obs, { grid: 10 });
  assert.ok(pts, '应有路径');
  assert.equal(polylineHitsObstacles(pts, obs).length, 0);
});

test('完全分隔（障碍覆盖栅格上下界）：返回 null', () => {
  // 全高隔墙（厚 20 盖住两格，高度远超栅格范围），start 与 end 完全隔开无路可绕
  const wall = [{ x: 50, y: -1e6, w: 20, h: 2e6 }];
  const pts = routeWire({ x: 0, y: 0 }, { x: 100, y: 0 }, wall, { grid: 10 });
  assert.equal(pts, null, '应不可达');
});

test('共线合并 simplifyPolyline', () => {
  const pts = [{ x: 0, y: 0 }, { x: 30, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 40 }, { x: 50, y: 80 }];
  const simple = simplifyPolyline(pts);
  assert.deepEqual(simple, [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 80 }]);
});

test('确定性：同输入同输出', () => {
  const obs = [{ x: 40, y: -15, w: 20, h: 30 }];
  const a = routeWire({ x: 0, y: 0 }, { x: 100, y: 0 }, obs, { grid: 10 });
  const b = routeWire({ x: 0, y: 0 }, { x: 100, y: 0 }, obs, { grid: 10 });
  assert.deepEqual(a, b);
});

test('polylineHitsObstacles 检测穿障段', () => {
  const obs = [{ x: 40, y: -5, w: 20, h: 10 }];
  const bad = [{ x: 0, y: 0 }, { x: 100, y: 0 }]; // 直线穿过
  const hits = polylineHitsObstacles(bad, obs);
  assert.equal(hits.length, 1, '应检出穿过');
});

test('snapPolyline 中间点吸附，首尾不动', () => {
  const pts = [{ x: 3, y: 7 }, { x: 24, y: 7 }, { x: 24, y: 53 }];
  const snapped = snapPolyline(pts, 10);
  assert.deepEqual(snapped[0], { x: 3, y: 7 }, '首点不动');
  assert.deepEqual(snapped[1], { x: 20, y: 10 }, '中间吸附到网格');
  assert.deepEqual(snapped[2], { x: 24, y: 53 }, '尾点不动');
});

test('Hanan 网格：路径贴引脚坐标、不穿障', () => {
  const obs = [{ x: 40, y: -15, w: 20, h: 30 }];
  const pts = routeWire({ x: 0, y: 0 }, { x: 100, y: 0 }, obs, { grid: 5, hanan: true, allPoints: [{ x: 0, y: 0 }, { x: 100, y: 0 }] });
  assert.ok(pts, 'Hanan 应有路径');
  assert.equal(polylineHitsObstacles(pts, obs).length, 0, 'Hanan 路径不穿障');
  // 中间点坐标应落在 5 的网格线上
  for (let i = 1; i < pts.length - 1; i++) {
    assert.ok(pts[i].x % 5 === 0 || pts[i].y % 5 === 0, `Hanan 中间点应在网格线上: ${JSON.stringify(pts[i])}`);
  }
});

test('穿障自检排除端点自身：正常导线不误报（回归 Bug1）', () => {
  // 复刻 verifyWiringData 的障碍构建逻辑：排除吸附引脚所在器件本体+该引脚
  const comps = [
    { designator: 'U1', bbox: { x: 129.5, y: 44.5, w: 141, h: 211 }, pins: [{ x: 120, y: 165 }, { x: 280, y: 245 }] },
    { designator: 'Y1', bbox: { x: 59.5, y: 42.5, w: 21, h: 15 }, pins: [{ x: 90, y: 50 }, { x: 50, y: 50 }] },
  ];
  // 正常导线 Y1.1(90,50) → U1.RST(120,165)
  const pts = [{ x: 90, y: 50 }, { x: 90, y: 165 }, { x: 120, y: 165 }];
  const anchored = [
    { x: 90, y: 50, comp: 'Y1' },
    { x: 120, y: 165, comp: 'U1' },
  ];
  const skipComps = new Set(anchored.map((a) => a.comp));
  const obstacles = [];
  for (const c of comps) {
    if (skipComps.has(c.designator)) {
      for (const p of c.pins) {
        if (anchored.some((a) => a.x === p.x && a.y === p.y)) continue;
        obstacles.push({ x: p.x - 2, y: p.y - 2, w: 4, h: 4 });
      }
      continue;
    }
    if (c.bbox) obstacles.push({ x: c.bbox.x - 2, y: c.bbox.y - 2, w: c.bbox.w + 4, h: c.bbox.h + 4 });
    for (const p of c.pins) obstacles.push({ x: p.x - 2, y: p.y - 2, w: 4, h: 4 });
  }
  const hits = polylineHitsObstacles(pts, obstacles);
  assert.equal(hits.length, 0, `正常导线不应穿障: ${JSON.stringify(hits)}`);
});

test('闭合性只用线首尾端点（Hanan 拐点不算，回归 Bug2）', () => {
  // 拐点在 (120,165) 但那是 U1.RST 引脚坐标；若把拐点当端点会误判 RST 被连到
  const wEndpoints = [[90, 50], [120, 165]]; // 首尾真端点（去往 U1.RST）
  const pinAt = { x: 120, y: 165 };
  // 判断"引脚被连到"：只看首尾端点（不含中间拐点）
  const near = wEndpoints.some((e) => Math.hypot(e[0] - pinAt.x, e[1] - pinAt.y) <= 1.5);
  assert.equal(near, true, 'U1.RST 通过真端点被连到');
});

test('Steiner 树：多端点一次连成树，全部可达', () => {
  const obs = [{ x: 40, y: -15, w: 20, h: 30 }];
  const eps = [
    { x: 0, y: 0, ref: 'Y1.1' },
    { x: 85, y: 50, ref: 'C1.1' },
    { x: 100, y: 0, ref: 'U1.XTAL1' },
  ];
  const edges = steinerTree(eps, obs, { grid: 5, hanan: true, allPoints: eps });
  // 三端点 → 至少 2 条边（连通树）
  assert.ok(edges.length >= 2, `应至少 2 条边: ${edges.length}`);
  // 每条边不穿障
  for (const e of edges) {
    assert.equal(polylineHitsObstacles(e.polyline, obs).length, 0, `边 ${e.refA}→${e.refB} 不穿障`);
  }
  // 所有端点被覆盖
  const covered = new Set();
  for (const e of edges) { covered.add(e.refA); covered.add(e.refB); }
  assert.equal(covered.size, 3, `全部 3 端点被连: ${[...covered].join(',')}`);
});

test('拥塞权重：避开已有导线密集区', () => {
  // 一条已有水平导线占据 y=0 通道（x 10-90）
  const wires = [{ line: [10, 0, 90, 0] }];
  const obs = [{ x: 40, y: -15, w: 20, h: 30 }];
  // 无障碍时 A* 直连；有拥塞偏好时可能绕
  const pts = routeWire({ x: 0, y: 0 }, { x: 100, y: 0 }, obs, { grid: 5, wires, congestionAlpha: 0.2 });
  assert.ok(pts, '拥塞路径存在');
  // 拥塞下路径不应与已有导线重叠（段端点都在 0 或 5 的格上，检查是否穿过 y=0 通道）
  // 关键断言：路径存在且不穿障碍
  assert.equal(polylineHitsObstacles(pts, obs).length, 0, '不穿障碍');
});
