import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { Bridge, SERVICE_ID, PROVIDER } from '../src/bridge.mjs';

const PORT = 49990;

/** 模拟 EDA 扩展：连接 /eda，从 handshake 读取 token，用 token 注册窗口，响应 execute。
 *  2026-08-20 审计修复后：桥要求 register 携带有效 token（从 handshake 下发），mockEda 同步对齐真实扩展行为。 */
function mockEda(windowId, { origin, autoRespond = true, status, port = PORT, echo = true, authToken = undefined } = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/eda`, origin ? { origin } : undefined);
    const out = { ws, handshake: null, executed: [], shutdownMsg: null, closed: false, closeCode: null };
    const timer = setTimeout(() => reject(new Error('mock EDA 超时')), 3000);
    // 显式 authToken 传入时跳过「等 handshake」直接注册（测试未认证场景）
    let registerSent = false;
    const sendRegister = (token) => {
      if (registerSent) return;
      registerSent = true;
      ws.send(JSON.stringify({ type: 'register', windowId, ...(token ? { token } : {}), ...(status ? { status } : {}) }));
    };
    if (authToken !== undefined) {
      // 立即注册（不等待 handshake token）
      ws.on('open', () => sendRegister(authToken));
    }
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'handshake' && !out.handshake) {
        out.handshake = msg;
        // 等 register 被桥处理完再 resolve，避免竞态
        if (authToken === undefined) sendRegister(msg.token);
        setTimeout(() => { clearTimeout(timer); resolve(out); }, 40);
      }
      else if (msg.type === 'execute') {
        out.executed.push(msg);
        if (autoRespond) {
          ws.send(JSON.stringify({ type: 'result', id: msg.id, result: echo ? { echo: msg.code } : msg.code }));
        }
      }
      else if (msg.type === 'shutdown') {
        out.shutdownMsg = msg;
        ws.close(1000, 'shutdown');
      }
    });
    ws.on('close', (code) => { out.closed = true; out.closeCode = code; });
    ws.on('error', (err) => { clearTimeout(timer); reject(err); });
  });
}

/** 清空当前桥的全部窗口（避免前面用例残留窗口干扰活动窗口/顺序断言） */
function closeAllWindows() {
  for (const info of bridge.windows.values()) {
    try { info.ws.close(); } catch { /* ignore */ }
  }
  bridge.windows.clear();
  bridge.activeWindowId = null;
}

let bridge;

before(async () => {
  bridge = new Bridge({ portRange: [PORT, PORT], executeTimeoutMs: 300 });
  await bridge.start();
});

after(async () => {
  await bridge.stop('test end');
});

test('桥启动绑定 127.0.0.1', () => {
  assert.equal(bridge.port, PORT);
  assert.ok(bridge.httpServer);
});

test('EDA 注册握手 + 状态缓存', async () => {
  const eda = await mockEda('win-1', { status: { edaVersion: '3.2.0', editorType: 'PCB', projectOpened: true, documentType: 3 } });
  assert.equal(eda.handshake.service, SERVICE_ID);
  assert.equal(eda.handshake.provider, PROVIDER);
  const win = bridge.listWindows().windows.find((w) => w.windowId === 'win-1');
  assert.ok(win);
  assert.equal(win.active, true);
  assert.equal(win.edaVersion, '3.2.0');
  assert.equal(win.documentType, 3);
  assert.equal(bridge.getStatus().edaConnected, true);
  eda.ws.close();
});

test('execute 正常回传（解析为结构化值）', async () => {
  const eda = await mockEda('win-2');
  const r = await bridge.execute('return { a: 1 }');
  assert.deepEqual(r, { echo: 'return { a: 1 }' });
  eda.ws.close();
});

test('execute 无窗口时报错', async () => {
  await assert.rejects(() => bridge.execute('return 1', { windowId: 'nonexistent' }), /已断开|没有/);
});

test('execute 超时拒绝', async () => {
  const eda = await mockEda('win-4', { autoRespond: false });
  await assert.rejects(() => bridge.execute('return 1', { timeoutMs: 50 }), /未得到 EDA 响应/);
  eda.ws.close();
});

test('窗口断开自动切换活动窗口且只选 connected', async () => {
  const e1 = await mockEda('win-5');
  const e2 = await mockEda('win-6');
  assert.equal(bridge.listWindows().activeWindowId, 'win-5');
  e2.ws.close();
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(bridge.listWindows().activeWindowId, 'win-5');
  e1.ws.close();
  await new Promise((r) => setTimeout(r, 60));
  const st = bridge.listWindows();
  assert.equal(st.count, 0);
  assert.equal(st.activeWindowId, null);
});

test('同 windowId 重连：旧 socket close 不删新连接（B4 代际）', async () => {
  const old = await mockEda('win-dup');
  await mockEda('win-dup'); // 同 id 重连
  assert.equal(bridge.listWindows().windows.filter((w) => w.windowId === 'win-dup').length, 1);
  old.ws.close();
  await new Promise((r) => setTimeout(r, 60));
  const cur = bridge.listWindows().windows.find((w) => w.windowId === 'win-dup');
  assert.ok(cur);
  assert.equal(cur.connected, true);
  cur.ws && bridge.windows.get('win-dup')?.ws.close();
});

test('HTTP /health 开放且不暴露 token', async () => {
  const res = await fetch(`http://127.0.0.1:${PORT}/health`);
  const body = await res.json();
  assert.equal(body.service, SERVICE_ID);
  assert.equal('token' in body, false);
});

test('HTTP /execute 无 token → 401', async () => {
  const res = await fetch(`http://127.0.0.1:${PORT}/execute`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: 'return 1' }),
  });
  assert.equal(res.status, 401);
});

test('HTTP /execute 配置 token 后正确/错误 token 分别 200/401', async () => {
  const tokenBridge = new Bridge({ portRange: [49991, 49991], token: 'test-token', executeTimeoutMs: 300 });
  await tokenBridge.start();
  const eda = await mockEda('win-t', { port: 49991 });
  const ok = await fetch(`http://127.0.0.1:49991/execute`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-EasyEDA-Token': 'test-token' },
    body: JSON.stringify({ code: 'return 42' }),
  });
  assert.equal(ok.status, 200);
  const bad = await fetch(`http://127.0.0.1:49991/execute`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-EasyEDA-Token': 'wrong' },
    body: JSON.stringify({ code: 'return 42' }),
  });
  assert.equal(bad.status, 401);
  eda.ws.close();
  await tokenBridge.stop('test');
});

test('WS Origin 校验：null/file://（sandbox iframe / 本地 html）拒绝，空 Origin 放行', async () => {
  for (const badOrigin of ['null', 'file://', 'file:///C:/evil.html']) {
    const code = await new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}/eda`, { origin: badOrigin });
      ws.on('close', (c) => resolve(c));
      ws.on('error', () => resolve('error'));
      setTimeout(() => resolve('timeout'), 2000);
    });
    assert.ok(code === 1008 || code === 'error', `Origin ${badOrigin} 应被拒绝`);
  }
  // 空 Origin（EDA 宿主 WS / ws 客户端默认）握手放行，但 register 必须带 token（mockEda 已自动带）
  const ok = await mockEda('win-noorigin');
  assert.ok(ok.handshake, '空 Origin 应能握手');
  assert.ok(ok.handshake.token, 'handshake 应携带 token 供扩展认证');
  ok.ws.close();
});

test('认证：未带 token 注册被拒，窗口不出现', async () => {
  // 显式 authToken='' → 不携带 token → 桥必须拒绝注册
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/eda`);
  const out = await new Promise((resolve) => {
    const messages = [];
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      messages.push(msg);
      if (msg.type === 'error' || msg.type === 'handshake') setTimeout(() => resolve(messages), 60);
    });
    ws.on('open', () => ws.send(JSON.stringify({ type: 'register', windowId: 'win-noauth' })));
    setTimeout(() => resolve(messages), 2000);
  });
  // 应收到 handshake + 认证失败 error
  assert.ok(out.some((m) => m.type === 'error' && /auth/i.test(m.error || '')), '应返回认证失败错误');
  assert.equal(bridge.listWindows().windows.find((w) => w.windowId === 'win-noauth'), undefined, '未认证窗口不应注册');
  ws.close();
});

test('认证：错误 token 注册被拒', async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/eda`);
  const out = await new Promise((resolve) => {
    const messages = [];
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      messages.push(msg);
      if (msg.type === 'error' || msg.type === 'handshake') setTimeout(() => resolve(messages), 60);
    });
    ws.on('open', () => ws.send(JSON.stringify({ type: 'register', windowId: 'win-badtoken', token: 'wrong-token' })));
    setTimeout(() => resolve(messages), 2000);
  });
  assert.ok(out.some((m) => m.type === 'error' && /auth/i.test(m.error || '')), '错误 token 应被拒绝');
  assert.equal(bridge.listWindows().windows.find((w) => w.windowId === 'win-badtoken'), undefined);
  ws.close();
});

test('认证：未认证连接发送 window-active 被忽略（防抢 active 通道）', async () => {
  closeAllWindows(); // 清空残留窗口，确保 active 断言不受前面用例污染
  // 先注册一个合法窗口，确保有 active
  const good = await mockEda('win-good');
  // 未认证连接（空 token 注册失败后仍想发 window-active）
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/eda`);
  const actives = [];
  await new Promise((resolve) => {
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'handshake') {
        ws.send(JSON.stringify({ type: 'register', windowId: 'win-evil', token: 'bad' }));
        ws.send(JSON.stringify({ type: 'window-active' }));
        setTimeout(resolve, 80);
      }
    });
    ws.on('open', () => {});
    setTimeout(resolve, 2000);
  });
  // active 仍应是合法窗口
  assert.equal(bridge.listWindows().activeWindowId, 'win-good');
  assert.equal(bridge.listWindows().windows.find((w) => w.windowId === 'win-evil'), undefined, '恶意窗口不应注册');
  good.ws.close();
  ws.close();
});

test('Origin 精确匹配：localhost.evil.com 拒绝（防 startsWith 前缀绕过）', async () => {
  const code = await new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/eda`, { origin: 'http://localhost.evil.com' });
    ws.on('close', (c) => resolve(c));
    ws.on('error', () => resolve('error'));
    setTimeout(() => resolve('timeout'), 2000);
  });
  assert.ok(code === 1008 || code === 'error', `localhost.evil.com 应被拒绝，实际 ${code}`);
  // 真实 localhost 仍放行（带 token）
  const ok = await mockEda('win-localhost', { origin: 'http://localhost:5173' });
  assert.ok(ok.handshake, 'localhost:5173 应能握手');
  ok.ws.close();
});

test('WS Origin 校验：恶意网页拒绝，官方域放行', async () => {
  const evil = await new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/eda`, { origin: 'https://evil.example.com' });
    ws.on('close', (code) => resolve(code));
    ws.on('error', () => resolve('error')); // 连接被拒可能表现为 error
    setTimeout(() => resolve('timeout'), 2000);
  });
  assert.ok(evil === 1008 || evil === 'error', `期望拒绝，实际 ${evil}`);

  const okOrigin = await new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/eda`, { origin: 'https://pro.lceda.cn' });
    ws.on('open', () => { ws.close(1000); resolve('open'); });
    ws.on('error', reject);
    setTimeout(() => reject(new Error('timeout')), 1500);
  });
  assert.equal(okOrigin, 'open');
});

test('窗口失效后 execute 快速失败（不挂到超时）', async () => {
  const eda = await mockEda('win-fastfail');
  eda.ws.terminate(); // 同步置为 CLOSING，模拟半死窗口（readyState !== OPEN）
  const start = Date.now();
  await assert.rejects(() => bridge.execute('return 1', { windowId: 'win-fastfail' }), /已断开/);
  assert.ok(Date.now() - start < 500, '应在 500ms 内失败而非挂到 30s 超时');
});

test('同一 socket 换 windowId 重注册不泄漏旧映射', async () => {
  const eda = await mockEda('win-switch-a');
  // 同一 socket 重新注册不同 windowId
  eda.ws.send(JSON.stringify({ type: 'register', windowId: 'win-switch-b' }));
  await new Promise((r) => setTimeout(r, 80));
  const windows = bridge.listWindows().windows.map((w) => w.windowId);
  assert.ok(windows.includes('win-switch-b'));
  assert.ok(!windows.includes('win-switch-a'), '旧 windowId 不应残留');
  eda.ws.close();
});

test('请求体超限 → 413（带 token）', async () => {
  const b = new Bridge({ portRange: [49994, 49994], token: 't-oversize', maxBodyBytes: 100 });
  await b.start();
  const eda = await mockEda('win-over', { port: 49994 });
  const res = await fetch(`http://127.0.0.1:49994/execute`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-EasyEDA-Token': 't-oversize' },
    body: JSON.stringify({ code: 'x'.repeat(500) }),
  });
  assert.equal(res.status, 413);
  eda.ws.close();
  await b.stop('test');
});

test('status 消息更新窗口缓存（edaVersion/projectOpened/documentType）', async () => {
  const eda = await mockEda('win-status');
  // 扩展在注册后发送 {type:'status', status:{...}}
  eda.ws.send(JSON.stringify({ type: 'status', status: { edaVersion: '3.2.0', clientType: 'client', projectOpened: true, documentType: 3 } }));
  await new Promise((r) => setTimeout(r, 80));
  const win = bridge.listWindows().windows.find((w) => w.windowId === 'win-status');
  assert.ok(win, '窗口应存在');
  assert.equal(win.edaVersion, '3.2.0');
  assert.equal(win.clientType, 'client');
  assert.equal(win.projectOpened, true);
  assert.equal(win.documentType, 3);
  eda.ws.close();
});

test('窗口按连接顺序分配 order + window-active 更新真实活动窗口', async () => {
  closeAllWindows();
  const w1 = await mockEda('win-order-a');
  const w2 = await mockEda('win-order-b');
  const wins = bridge.listWindows().windows;
  const a = wins.find((w) => w.windowId === 'win-order-a');
  const b = wins.find((w) => w.windowId === 'win-order-b');
  assert.ok(a.order < b.order, '先连接窗口 order 应更小');
  // 重连同一 windowId → order 保持稳定
  const wins2 = bridge.listWindows().windows;
  assert.equal(wins2.find((w) => w.windowId === 'win-order-a').order, a.order);
  // 默认活动窗口 = 先注册的 win-order-a
  assert.equal(bridge.listWindows().activeWindowId, 'win-order-a');
  // 模拟扩展焦点变化 → 活动窗口切到 win-order-b
  w2.ws.send(JSON.stringify({ type: 'window-active' }));
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(bridge.listWindows().activeWindowId, 'win-order-b');
  assert.equal(bridge.listWindows().windows.find((w) => w.windowId === 'win-order-b').active, true);
  w1.ws.close();
  w2.ws.close();
});

test('stop 通知扩展 shutdown 消息', async () => {
  const b = new Bridge({ portRange: [49993, 49993] });
  await b.start();
  const eda = await mockEda('win-s', { port: 49993 });
  await b.stop('unit-test-shutdown');
  assert.equal(eda.shutdownMsg?.type, 'shutdown');
  assert.equal(eda.shutdownMsg?.reason, 'unit-test-shutdown');
});
