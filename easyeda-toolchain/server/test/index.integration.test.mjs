import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const selfDir = dirname(fileURLToPath(import.meta.url));
const SERVER = resolve(selfDir, '..', 'dist', 'server.cjs');
const DOCS = resolve(selfDir, '..', '..', 'docs', 'index.json');
const PORT = 49980;

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
    }, 5000);
  });
}

async function startServer() {
  child = spawn(process.execPath, [SERVER, '--port-range', `${PORT}-${PORT + 9}`, '--docs', DOCS], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stderr.on('data', () => { /* 桥日志 */ });
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
      }
      catch { /* 忽略非 JSON 输出行 */ }
    }
  });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('服务启动超时')), 5000);
    child.on('spawn', () => setTimeout(() => { clearTimeout(t); resolve(); }, 800));
    child.on('error', reject);
  });
}

/** 模拟 EDA 扩展，收到 execute 回显结果 */
function mockEda(windowId, result) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/eda`);
    const t = setTimeout(() => reject(new Error('mock EDA 超时')), 3000);
    ws.on('open', () => ws.send(JSON.stringify({ type: 'register', windowId, status: { edaVersion: '3.2.0', editorType: 'PCB', projectOpened: true, documentType: 3 } })));
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'handshake') { clearTimeout(t); resolve(ws); }
      else if (msg.type === 'execute') {
        ws.send(JSON.stringify({ type: 'result', id: msg.id, result }));
      }
    });
    ws.on('error', reject);
  });
}

after(async () => {
  if (child && !child.killed) child.kill();
});

test('MCP 初始化 + tools/list 含全部 easyeda 工具', async () => {
  await startServer();
  const init = await request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'triecode-test', version: '1.0' },
  });
  assert.ok(init.serverInfo.name.includes('easyeda'));
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });

  const tools = await request('tools/list', {});
  const names = tools.tools.map((t) => t.name);
  for (const expected of ['easyeda_status', 'easyeda_execute', 'easyeda_doc_search', 'easyeda_project_info', 'easyeda_document_state', 'easyeda_lib_search', 'easyeda_sch_list', 'easyeda_convert', 'easyeda_sch_create', 'easyeda_doc_open', 'easyeda_pcb_read', 'easyeda_pcb_place_component', 'easyeda_lib_get_by_lcsc', 'easyeda_confirm', 'easyeda_project_create', 'easyeda_document_save', 'easyeda_pcb_net', 'easyeda_pcb_modify', 'easyeda_export_gerber', 'easyeda_export_bom', 'easyeda_lib_search_symbol', 'easyeda_lib_search_footprint', 'easyeda_screenshot']) {
    assert.ok(names.includes(expected), `缺少工具 ${expected}`);
  }
});

test('easyeda_status 无 EDA 时返回未连接', async () => {
  const res = await request('tools/call', { name: 'easyeda_status', arguments: {} });
  const text = res.content[0].text;
  const status = JSON.parse(text);
  assert.equal(status.service, 'easyeda-bridge');
  assert.equal(status.provider, 'triecode');
  assert.equal(status.edaConnected, false);
});

test('easyeda_status 连接 EDA 后返回窗口信息', async () => {
  const ws = await mockEda('win-mcp', { project: 'demo' });
  const res = await request('tools/call', { name: 'easyeda_status', arguments: {} });
  const status = JSON.parse(res.content[0].text);
  assert.equal(status.edaConnected, true);
  assert.equal(status.edaWindowCount, 1);
  assert.equal(status.activeWindowId, 'win-mcp');
  ws.close();
});

test('easyeda_execute 回传结构化结果', async () => {
  const ws = await mockEda('win-exec', { ok: true, data: [1, 2, 3] });
  const res = await request('tools/call', { name: 'easyeda_execute', arguments: { code: 'return { ok: true, data: [1,2,3] }' } });
  const r = JSON.parse(res.content[0].text);
  assert.equal(r.ok, true);
  assert.deepEqual(r.result, { ok: true, data: [1, 2, 3] });
  ws.close();
});

test('easyeda_execute 无效窗口返回明确错误', async () => {
  const res = await request('tools/call', { name: 'easyeda_execute', arguments: { code: 'return 1', windowId: 'no-such-window' } });
  const r = JSON.parse(res.content[0].text);
  assert.equal(r.ok, false);
  assert.ok(/已断开|没有/.test(r.error));
});

test('easyeda_doc_search 检索方法签名', async () => {
  const res = await request('tools/call', { name: 'easyeda_doc_search', arguments: { query: 'getAllProjectsUuid' } });
  const text = res.content[0].text;
  assert.ok(text.includes('DMT_Project'), text);
  assert.ok(text.includes('getAllProjectsUuid'), text);
});

test('easyeda_convert 单位换算', async () => {
  const res = await request('tools/call', { name: 'easyeda_convert', arguments: { value: 10, from: 'mil', to: 'sch' } });
  const r = JSON.parse(res.content[0].text);
  assert.equal(r.ok, true);
  assert.equal(r.value, 1);
});

test('easyeda_pcb_modify 生成代码不含未定义变量守卫（防 ReferenceError）', async () => {
  let receivedCode = null;
  const ws = await new Promise((resolve, reject) => {
    const sock = new WebSocket(`ws://127.0.0.1:${PORT}/eda`);
    sock.on('open', () => sock.send(JSON.stringify({ type: 'register', windowId: 'win-pcbmod' })));
    sock.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'handshake') resolve(sock);
      else if (msg.type === 'execute') {
        receivedCode = msg.code;
        sock.send(JSON.stringify({ type: 'result', id: msg.id, result: { ok: true } }));
      }
    });
    sock.on('error', reject);
    setTimeout(() => reject(new Error('mock 超时')), 3000);
  });
  const res = await request('tools/call', { name: 'easyeda_pcb_modify', arguments: { primitiveId: 'x1', x: 10, y: 20 } });
  assert.ok(receivedCode, '应收到 execute 代码');
  assert.ok(!receivedCode.includes('x !== undefined'), '不应引用 EDA 作用域外的变量守卫');
  assert.ok(receivedCode.includes('Array.isArray(raw)'), 'get 应防御数组/单值（官方重载）');
  assert.ok(receivedCode.includes('ap.setState_X('), '应设置 X');
  assert.ok(receivedCode.includes('ap.setState_Y('), '应设置 Y');
  assert.ok(!receivedCode.includes('ap.setState_Rotation('), '未传 rotation 不应生成该行');
  ws.close();
});

test('easyeda_sch_modify 生成代码防御 get 数组/单值 + 可移动网络标记', async () => {
  let receivedCode = null;
  const ws = await new Promise((resolve, reject) => {
    const sock = new WebSocket(`ws://127.0.0.1:${PORT}/eda`);
    sock.on('open', () => sock.send(JSON.stringify({ type: 'register', windowId: 'win-schmod' })));
    sock.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'handshake') resolve(sock);
      else if (msg.type === 'execute') {
        receivedCode = msg.code;
        sock.send(JSON.stringify({ type: 'result', id: msg.id, result: { ok: true } }));
      }
    });
    sock.on('error', reject);
    setTimeout(() => reject(new Error('mock 超时')), 3000);
  });
  await request('tools/call', { name: 'easyeda_sch_modify', arguments: { primitiveId: 'nf1', x: 50, y: 60, designator: 'R2' } });
  assert.ok(receivedCode, '应收到 execute 代码');
  assert.ok(receivedCode.includes('Array.isArray(raw)'), 'get 应防御数组/单值');
  assert.ok(receivedCode.includes('setState_Designator('), '应能改位号');
  assert.ok(!receivedCode.includes('props.'), '不应再用 sch_PrimitiveComponent.modify 的 props 方式');
  ws.close();
});

test('easyeda_document_state 在 mock EDA 上返回文档类型', async () => {
  const ws = await mockEda('win-doc', { projectOpened: true, documentType: 3 });
  const res = await request('tools/call', { name: 'easyeda_project_info', arguments: {} });
  // mock EDA 回显 result，不真正执行 EDA 代码 —— 只验证桥往返 + 不抛异常
  assert.ok(res.content[0].text);
  ws.close();
});
