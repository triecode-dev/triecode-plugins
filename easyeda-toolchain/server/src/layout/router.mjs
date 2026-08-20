/**
 * 确定性正交布线器（A* 绕障）
 *
 * 输入 start/end 引脚点 + 障碍矩形（元器件本体膨胀 clearance + 其它引脚小方框），
 * 输出一条正交折线（横平竖直），绝不穿过障碍。确定性（同输入同输出）。
 *
 * 流程：页面栅格化 → 障碍格标记 → 4 方向 A*（Manhattan 启发）→ 路径 → 共线合并 → 网格吸附。
 * start/end 引脚格自身不设障（线必须到达它）。
 */
import { snapToGrid, segmentIntersectsRect } from './geometry.mjs';

/**
 * 栅格化 A* 正交路由（可选 Hanan 网格 + 拥塞权重）。
 *
 * - Hanan 网格：在"所有引脚/端点横纵坐标"的交点上布格（opt.hanan=true），格数从 O(面积) 降到
 *   O(引脚数²)，路径更贴引脚。
 * - 拥塞权重：opt.wires 里的已有导线段按格统计占用，A* 边代价 = 1 + α×占用率，软优先穿低拥塞通道
 *   （硬障碍仍拦截；α 建议 0.05–0.2，太大单线绕远路变丑）。
 *
 * @param {{x:number,y:number}} start
 * @param {{x:number,y:number}} end
 * @param {Array<{x,y,w,h}>} obstacles
 * @param {{grid?:number, hanan?:boolean, wires?:Array<{line:number[]}>, congestionAlpha?:number, allPoints?:Array<{x,y}>}} opts
 *   allPoints：Hanan 网格要纳入的全部引脚/端点（含 start/end 之外的多端点网络）
 * @returns {Array<{x,y}>|null} 折线（首尾为精确引脚点，中间为格点）；null=不可达
 */
export function routeWire(start, end, obstacles = [], opts = {}) {
  const grid = opts.grid ?? 10;
  if (!Number.isFinite(start.x) || !Number.isFinite(start.y) || !Number.isFinite(end.x) || !Number.isFinite(end.y)) return null;
  if (Math.abs(start.x - end.x) < 1 && Math.abs(start.y - end.y) < 1) return [{ ...start }, { ...end }];

  // 栅格范围：以 start/end 为中心 ±MARGIN 格（防大障碍把栅格撑爆；范围外障碍不可达自然绕过）
  const MARGIN = 60;
  const minX = Math.floor(Math.min(start.x, end.x) / grid) - MARGIN;
  const minY = Math.floor(Math.min(start.y, end.y) / grid) - MARGIN;
  const maxX = Math.ceil(Math.max(start.x, end.x) / grid) + MARGIN;
  const maxY = Math.ceil(Math.max(start.y, end.y) / grid) + MARGIN;
  const W = maxX - minX + 1;
  const H = maxY - minY + 1;

  // Hanan 网格：X/Y 轴对齐到"全部引脚/端点横纵坐标 + 障碍边缘"（网格线贴在引脚列/行上，能绕障）
  let gridX = null;
  let gridY = null;
  if (opts.hanan) {
    const xs = new Set();
    const ys = new Set();
    for (const p of [start, end, ...(opts.allPoints || [])]) {
      xs.add(Math.round(p.x / grid) * grid);
      ys.add(Math.round(p.y / grid) * grid);
    }
    for (const o of obstacles) {
      xs.add(Math.round(o.x / grid) * grid);
      xs.add(Math.round((o.x + o.w) / grid) * grid);
      ys.add(Math.round(o.y / grid) * grid);
      ys.add(Math.round((o.y + o.h) / grid) * grid);
    }
    gridX = [...xs].sort((a, b) => a - b);
    gridY = [...ys].sort((a, b) => a - b);
  }

  // 障碍格判定：格矩形与任一障碍相交
  const blocked = new Set();
  const cellBlocked = (cx, cy) => blocked.has(cx * H + cy);
  for (let cx = 0; cx < W; cx++) {
    for (let cy = 0; cy < H; cy++) {
      const x = (minX + cx) * grid;
      const y = (minY + cy) * grid;
      for (const o of obstacles) {
        // 贴边也算挡（<=）：线不得沿障碍边缘走，否则精确自检会报穿障
        if (o.x <= x + grid && x <= o.x + o.w && o.y <= y + grid && y <= o.y + o.h) {
          blocked.add(cx * H + cy);
          break;
        }
      }
    }
  }

  const toCell = (px, py) => {
    if (gridX && gridY) {
      // Hanan：映射到最近的网格线交点
      const gx = gridX.find((v) => v >= px - grid / 2) ?? gridX[gridX.length - 1];
      const gy = gridY.find((v) => v >= py - grid / 2) ?? gridY[gridY.length - 1];
      return { x: Math.round(gx / grid) - minX, y: Math.round(gy / grid) - minY };
    }
    return { x: Math.round((px - minX * grid) / grid), y: Math.round((py - minY * grid) / grid) };
  };
  const sc = toCell(start.x, start.y);
  const ec = toCell(end.x, end.y);
  const sKey = sc.x * H + sc.y;
  const eKey = ec.x * H + ec.y;
  if (sKey === eKey) return [{ ...start }, { ...end }];

  // 起始/目标格不设障（引脚必须可达）
  blocked.delete(sKey);
  blocked.delete(eKey);

  // 拥塞占用：已有导线段经过的格计数
  let congestion = null;
  const alpha = opts.congestionAlpha ?? 0;
  if (alpha > 0 && opts.wires) {
    congestion = new Map();
    for (const w of opts.wires) {
      const line = w.line || [];
      for (let i = 0; i + 3 < line.length; i += 2) {
        const x1 = line[i], y1 = line[i + 1], x2 = line[i + 2], y2 = line[i + 3];
        if (!Number.isFinite(x1) || !Number.isFinite(y1) || !Number.isFinite(x2) || !Number.isFinite(y2)) continue;
        // 正交段栅格化：水平/垂直扫过格
        const c1 = toCell(x1, y1);
        const c2 = toCell(x2, y2);
        if (c1.x === c2.x) {
          for (let cy = Math.min(c1.y, c2.y); cy <= Math.max(c1.y, c2.y); cy++) {
            const k = c1.x * H + cy;
            congestion.set(k, (congestion.get(k) || 0) + 1);
          }
        } else {
          for (let cx = Math.min(c1.x, c2.x); cx <= Math.max(c1.x, c2.x); cx++) {
            const k = cx * H + c1.y;
            congestion.set(k, (congestion.get(k) || 0) + 1);
          }
        }
      }
    }
  }

  // A*：open 按 f 排序（插入排序，网格小足够快）
  const gScore = new Map([[sKey, 0]]);
  const cameFrom = new Map();
  const open = [{ x: sc.x, y: sc.y, g: 0, f: Math.abs(sc.x - ec.x) + Math.abs(sc.y - ec.y) }];
  const openSet = new Set([sKey]);
  const closed = new Set();
  const key = (x, y) => x * H + y;
  let found = false;

  const stepCost = (nk) => {
    if (!congestion) return 1;
    const occ = congestion.get(nk) || 0;
    return 1 + alpha * occ;
  };

  while (open.length) {
    // 取 f 最小
    let bi = 0;
    for (let i = 1; i < open.length; i++) if (open[i].f < open[bi].f) bi = i;
    const cur = open.splice(bi, 1)[0];
    const ck = key(cur.x, cur.y);
    openSet.delete(ck);
    if (ck === eKey) { found = true; break; }
    if (closed.has(ck)) continue;
    closed.add(ck);

    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    for (const [dx, dy] of dirs) {
      const nx = cur.x + dx;
      const ny = cur.y + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      if (cellBlocked(nx, ny)) continue;
      const nk = key(nx, ny);
      if (closed.has(nk)) continue;
      const ng = cur.g + stepCost(nk);
      const old = gScore.get(nk);
      if (old === undefined || ng < old) {
        gScore.set(nk, ng);
        cameFrom.set(nk, ck);
        if (!openSet.has(nk)) {
          open.push({ x: nx, y: ny, g: ng, f: ng + Math.abs(nx - ec.x) + Math.abs(ny - ec.y) });
          openSet.add(nk);
        }
      }
    }
  }

  if (!found) return null;

  // 重建路径（单元格序列）
  const cells = [];
  let ck = eKey;
  while (ck !== undefined) {
    cells.unshift({ x: Math.floor(ck / H), y: ck % H });
    ck = cameFrom.get(ck);
  }

  // 单元格 → 折线：首尾用精确引脚点，中间用格点（Hanan 时用实际网格线坐标）
  const pts = [];
  pts.push({ x: start.x, y: start.y });
  for (let i = 1; i < cells.length - 1; i++) {
    const cellX = (minX + cells[i].x) * grid;
    const cellY = (minY + cells[i].y) * grid;
    const px = gridX && gridY ? gridX.find((v) => Math.round(v / grid) - minX === cells[i].x) ?? cellX : cellX;
    const py = gridY && gridX ? gridY.find((v) => Math.round(v / grid) - minY === cells[i].y) ?? cellY : cellY;
    pts.push({ x: px, y: py });
  }
  pts.push({ x: end.x, y: end.y });

  return simplifyPolyline(pts);
}

/**
 * Steiner 树（多端点网络）：Prim 最小生成树（Manhattan 距离）+ 每条边 A* 绕障路由。
 * 一条命令连一个网络的全部端点，替代"多次两点布线 + 手工汇合"。
 * @param {Array<{x:number,y:number,ref?:string}>} endpoints 该网络全部引脚点
 * @param {Array<{x,y,w,h}>} obstacles
 * @param {{grid?:number, hanan?:boolean, wires?:Array, congestionAlpha?:number}} opts
 * @returns {Array<{from,to,refA?,refB?,polyline}>} 树边（含折线）
 */
export function steinerTree(endpoints, obstacles = [], opts = {}) {
  if (!endpoints || endpoints.length === 0) return [];
  if (endpoints.length === 1) return [];
  if (endpoints.length === 2) {
    const a = endpoints[0];
    const b = endpoints[1];
    const polyline = routeWire({ x: a.x, y: a.y }, { x: b.x, y: b.y }, obstacles, opts);
    return polyline ? [{ from: { x: a.x, y: a.y }, to: { x: b.x, y: b.y }, refA: a.ref, refB: b.ref, polyline }] : [];
  }
  // Prim MST：dist 用 Manhattan，优先连最近端点
  const mst = [];
  const used = new Set([0]);
  const pts = endpoints;
  while (used.size < pts.length) {
    let best = null;
    for (const i of used) {
      for (let j = 0; j < pts.length; j++) {
        if (used.has(j)) continue;
        const d = Math.abs(pts[i].x - pts[j].x) + Math.abs(pts[i].y - pts[j].y);
        if (!best || d < best.d) best = { i, j, d };
      }
    }
    if (!best) break;
    used.add(best.j);
    mst.push([best.i, best.j]);
  }
  // 每条 MST 边 A* 路由
  const edges = [];
  for (const [i, j] of mst) {
    const a = pts[i];
    const b = pts[j];
    const polyline = routeWire({ x: a.x, y: a.y }, { x: b.x, y: b.y }, obstacles, opts);
    if (polyline) {
      edges.push({ from: { x: a.x, y: a.y }, to: { x: b.x, y: b.y }, refA: a.ref, refB: b.ref, polyline });
    }
  }
  return edges;
}

/** 合并共线段（去掉中间共线的点），保留首尾 */
export function simplifyPolyline(pts) {
  if (!pts || pts.length < 3) return pts ? pts.map((p) => ({ ...p })) : null;
  const out = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) {
    const a = out[out.length - 1];
    const b = pts[i];
    const c = pts[i + 1];
    const sameX = a.x === b.x && b.x === c.x;
    const sameY = a.y === b.y && b.y === c.y;
    if (sameX || sameY) continue; // 共线，跳过中间点
    out.push(b);
  }
  out.push(pts[pts.length - 1]);
  return out;
}

/** 折线整体网格吸附（首尾不动——引脚精确点；中间吸附） */
export function snapPolyline(pts, grid = 10) {
  return pts.map((p, i) => (i === 0 || i === pts.length - 1 ? { ...p } : { x: snapToGrid(p.x, grid), y: snapToGrid(p.y, grid) }));
}

/**
 * 校验折线是否穿过障碍（同尺，供测试/工具自检，Liang-Barsky 精确判定）
 * @returns {Array<{i:number, from, to, obstacle}>} 违规段
 */
export function polylineHitsObstacles(pts, obstacles = [], inflate = 0) {
  const hits = [];
  if (!pts || pts.length < 2) return hits;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    for (const o of obstacles) {
      if (segmentIntersectsRect(a.x, a.y, b.x, b.y, o, inflate)) {
        hits.push({ i, from: a, to: b, obstacle: o });
        break;
      }
    }
  }
  return hits;
}
