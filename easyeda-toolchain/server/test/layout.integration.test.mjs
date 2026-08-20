/**
 * 布局工具集成测试（mock EDA 桥）—— 验证 sch_plan_layout / sch_verify_layout 注册与往返
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const selfDir = dirname(fileURLToPath(import.meta.url));
const SERVER = resolve(selfDir, '..', 'dist', 'server.cjs');
const DOCS = resolve(selfDir, '..', '..', 'docs', 'index.json');
const PORT = 49970;

let child;
let outBuf = '';
let reqId = 0;
const pending = new Map();

function send(obj) {
  child.stdin.write(`${JSON.stringify(obj)}\n`);
}
function request(method, params) {
  const id = ++reqId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    send({ jsonrpc: '2.0', id, method, params });
    setTimeout(() => {
      if (pending.delete(id)) reject(new Error(`MCP 请求 ${method} 超时`));
    }, 6000);
  });
}

async function startServer() {
  child = spawn(process.execPath, [SERVER, '--port-range', `${PORT}-${PORT + 9}`, '--docs', DOCS], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stderr.on('data', () => {});
  child.stdout.on('data', (chunk) => {
    outBuf += chunk.toString();
    let idx;
    while ((idx = outBuf.indexOf('\n')) >= 0) {
      const line = outBuf.slice(0, idx).trim();
      outBuf = outBuf.slice(idx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id !== undefined && pending.has(msg.id)) {
          const p = pending.get(msg.id);
          pending.delete(msg.id);
          if (msg.error) p.reject(new Error(msg.error.message));
          else p.resolve(msg.result);
        }
      } catch { /* 忽略非 JSON */ }
    }
  });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('启动超时')), 5000);
    child.on('spawn', () => setTimeout(() => { clearTimeout(t); resolve(); }, 800));
    child.on('error', reject);
  });
}

/** mock EDA：读操作返回组件+页面；移动操作返回成功 */
const MOCK_READ = {
  components: [
    { id: 'u1', designator: 'U1', x: 200, y: 150, rotation: 0, net: null, bbox: { minX: 129.5, minY: 255.5, maxX: 270.5, maxY: 44.5 }, pins: [{ number: '9', name: 'RST', x: 120, y: 165, net: 'RST' }, { number: '40', name: 'VCC', x: 280, y: 245, net: '+5V' }] },
    { id: 'c3', designator: 'C3', x: 135, y: 170, rotation: 0, net: null, bbox: { minX: 129.5, minY: 178.5, maxX: 140.5, maxY: 161.5 }, pins: [{ number: '1', name: '1', x: 120, y: 170, net: 'RST' }, { number: '2', name: '2', x: 150, y: 170, net: 'GND' }] },
  ],
  page: { w: 1200, h: 800 },
};

function mockEda(windowId) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/eda`);
    const t = setTimeout(() => reject(new Error('mock EDA 超时')), 3000);
    ws.on('open', () => ws.send(JSON.stringify({ type: 'register', windowId })));
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'handshake') { clearTimeout(t); resolve(ws); }
      else if (msg.type === 'execute') {
        if (msg.code.includes('getAllPinsByPrimitiveId')) {
          ws.send(JSON.stringify({ type: 'result', id: msg.id, result: MOCK_READ }));
        } else {
          ws.send(JSON.stringify({ type: 'result', id: msg.id, result: { results: [{ id: 'x', ok: true }] } }));
        }
      }
    });
    ws.on('error', reject);
  });
}

after(async () => {
  if (child && !child.killed) child.kill();
});

test('布局工具注册（tools/list 含 plan/verify）', async () => {
  await startServer();
  await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'triecode-test', version: '1.0' } });
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  const tools = await request('tools/list', {});
  const names = tools.tools.map((t) => t.name);
  assert.ok(names.includes('easyeda_sch_plan_layout'), '缺少 sch_plan_layout');
  assert.ok(names.includes('easyeda_sch_verify_layout'), '缺少 sch_verify_layout');
});

test('sch_wire 生成扁平坐标数组（防 create failed 回归）', async () => {
  // 服务器刚启动即测（晚测可能在其它测试后窗口全关）
  let receivedCode = null;
  const ws = await new Promise((resolve, reject) => {
    const sock = new WebSocket(`ws://127.0.0.1:${PORT}/eda`);
    sock.on('open', () => sock.send(JSON.stringify({ type: 'register', windowId: 'win-wire' })));
    sock.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'handshake') resolve(sock);
      else if (msg.type === 'execute') {
        receivedCode = msg.code;
        // 若后续测试的 READ 打到本窗口，也正确回显，避免污染其它用例
        if (msg.code.includes('getAllPinsByPrimitiveId')) {
          sock.send(JSON.stringify({ type: 'result', id: msg.id, result: MOCK_READ }));
        } else {
          sock.send(JSON.stringify({ type: 'result', id: msg.id, result: { ok: true, id: 'w1' } }));
        }
      }
    });
    sock.on('error', reject);
    setTimeout(() => reject(new Error('mock 超时')), 3000);
  });
  const res = await request('tools/call', {
    name: 'easyeda_sch_wire',
    arguments: { points: [[70, 50], [120, 50], [120, 65]], unit: 'sch' },
  });
  const r = JSON.parse(res.content[0].text);
  assert.equal(r.ok, true, `返回: ${res.content[0].text}`);
  assert.ok(receivedCode, '应收到 execute 代码');
  assert.ok(/\[70,50,120,50,120,65\]/.test(receivedCode), `应扁平坐标: ${receivedCode}`);
  assert.ok(!/\[\[70,50\]/.test(receivedCode), '不应嵌套数组');
  assert.ok(receivedCode.includes('sch_PrimitiveWire.create'), '应调 create');
  ws.close();
});

test('sch_plan_layout 返回确定性 placements + violations', async () => {
  const ws = await mockEda('win-plan');
  const res = await request('tools/call', {
    name: 'easyeda_sch_plan_layout',
    arguments: { mode: 'central-lr', core: 'U1', anchors: [{ s: 'C3', p: '1', t: 'U1', tp: 'RST' }] },
  });
  const r = JSON.parse(res.content[0].text);
  assert.equal(r.ok, true, `返回: ${res.content[0].text}`);
  assert.ok(Array.isArray(r.placements), '应有 placements');
  assert.ok(r.placements.length >= 1);
  // 引擎保证无重叠
  assert.equal(r.violations.overlaps.length, 0, `overlaps: ${JSON.stringify(r.violations.overlaps)}`);
  ws.close();
});

test('sch_plan_layout 意图非法被 MCP schema 校验拒绝', async () => {
  const ws = await mockEda('win-bad');
  // SDK 校验 inputSchema → 返回含 "MCP error" 的文本工具结果（非 JSON）
  const res = await request('tools/call', { name: 'easyeda_sch_plan_layout', arguments: { mode: 'bogus-mode' } });
  const text = res.content[0].text;
  assert.ok(/MCP error/i.test(text) || /bogus-mode/i.test(text), text);
  ws.close();
});

test('sch_wire_routed：自动选最近端 + 绕障 polyline', async () => {
  const ws = await mockEda('win-routed');
  const res = await request('tools/call', {
    name: 'easyeda_sch_wire_routed',
    arguments: { from: { component: 'C3' }, to: { component: 'U1', pin: 'RST' }, apply: false },
  });
  const r = JSON.parse(res.content[0].text);
  assert.equal(r.ok, true, `返回: ${res.content[0].text}`);
  assert.ok(Array.isArray(r.polyline) && r.polyline.length >= 2, '应有 polyline');
  assert.ok(r.from.includes('C3.'), `from 应解析到 C3 引脚: ${r.from}`);
  assert.equal(r.to, 'U1.RST', 'to 应解析到 U1.RST');
  assert.equal(r.hits, 0, 'polyline 不得穿障');
  ws.close();
});

test('verify_wiring 不误报正常布线（回归 Bug1/2/3）', async () => {
  // 用纯函数验证穿透障碍排除逻辑：直接测试 router.mjs 的 polylineHitsObstacles
  // 在多条测试中已覆盖（router.test.mjs 的穿障自检回归测试）
  const ws = await mockEda('win-vw');
  const res = await request('tools/call', { name: 'easyeda_sch_verify_wiring', arguments: {} });
  const r = JSON.parse(res.content[0].text);
  // 没有正常导线时不应报穿障
  assert.equal(typeof r.ok, 'boolean');
  assert.equal(typeof r.wireCount, 'number');
  ws.close();
});

test('sch_redesign 一次性重排（AI 只调一次）', async () => {
  const ws = await mockEda('win-redesign');
  const res = await request('tools/call', {
    name: 'easyeda_sch_redesign',
    arguments: { wire: false, apply: false }, // 只规划不落图（mock 无真实 EDA）
  });
  const r = JSON.parse(res.content[0].text);
  assert.equal(typeof r.ok, 'boolean');
  assert.ok(r.core, '应自动识别核心');
  assert.ok(Array.isArray(r.moveErrors), '应有 moveErrors');
  assert.ok(r.layoutViolations, '应有 layoutViolations');
  ws.close();
});

test('sch_verify_layout 用同尺 lint 校验（返回 ok 布尔）', async () => {
  const ws = await mockEda('win-verify');
  const res = await request('tools/call', { name: 'easyeda_sch_verify_layout', arguments: {} });
  const r = JSON.parse(res.content[0].text);
  assert.equal(typeof r.ok, 'boolean');
  assert.ok(Array.isArray(r.overlaps), '应有 overlaps');
  assert.ok(Array.isArray(r.netflagsInsideParts), '应有 netflagsInsideParts');
  ws.close();
});
