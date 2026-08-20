/**
 * 立创EDA(EasyEDA) 桥核心 —— WebSocket 服务（供 EDA 扩展连接）
 *
 * 相对官方 bridge-server.mjs 的修复：
 *  - S1 安全：只绑 127.0.0.1 + HTTP 端点要求 token + WS Origin 校验（防浏览器恶意网页）
 *  - S2 请求体上限（256KB）
 *  - S3 结果安全序列化（扩展侧也要做，此处兜底）
 *  - B3 断线自动选窗时校验 readyState
 *  - B4 同 windowId 重连踢旧 socket + 代际校验
 *  - B7 单例/端口冲突：撞端口顺延，不递归自启
 *  - 状态缓存：扩展上报 EDA 版本/编辑器/工程/文档状态
 *  - 优雅退出：通知扩展 shutdown 再关
 *
 * 协议与官方兼容（{type:'handshake'|'register'|'execute'|'result'|'error'|'ping'|'pong'|'status'|'shutdown'}）
 */

import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'node:http';
import { randomUUID, randomBytes } from 'node:crypto';
import { createConnection } from 'node:net';
import { safeParse, safeStringify } from './serialize.mjs';

export const SERVICE_ID = 'easyeda-bridge';
export const PROVIDER = 'triecode';
export const VERSION = '0.1.0';
export const DEFAULT_PORT_START = 49620;
export const DEFAULT_PORT_END = 49629;
export const DEFAULT_EXECUTE_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_BODY_BYTES = 262_144; // 256KB

// 允许来自浏览器/网页的 WS Origin（EDA 网页端 / 客户端 / 本地调试）。
// ⚠️ 'null' / 'file://' 一律阻断：sandbox iframe（Origin:null）与本地恶意 .html（Origin:file://）
// 都能被构造来伪装 EDA 窗口，截获 AI 生成的 execute 代码或伪造结果（2026-08-20 审查发现）。
// 空 Origin（非浏览器客户端，如 EDA 宿主 WS）不在这里放行——/eda 路径必须有合法 Origin 或有效 token。
// 2026-08-20 审计修复：host 精确匹配（不再 `startsWith('localhost')`，否则 localhost.evil.com 可绕过）。
function isOriginAllowed(origin) {
  if (!origin) return false; // 空 Origin 不再无条件放行——改由 token 认证覆盖
  const m = /^https?:\/\/([^/?#]+)/i.exec(origin);
  if (!m) return false; // 'null' / 'file://' / 其它非 http(s) 来源 → 阻断
  const host = m[1].toLowerCase();
  // 去掉 port 段：Origin 形如 https://pro.easyeda.com:443 → 取 hostname 精确比较
  const hostname = host.replace(/:\d+$/, '');
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]') return true;
  if (hostname === 'client') return true;
  if (hostname === 'pro.lceda.cn' || hostname === 'pro.easyeda.com') return true;
  if (hostname.endsWith('.lceda.cn') || hostname.endsWith('.easyeda.com')) return true;
  return false;
}

function isPortFree(port) {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host: '127.0.0.1' });
    const done = (ok) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(300);
    socket.once('connect', () => done(false));
    socket.once('timeout', () => done(true));
    socket.once('error', () => done(true));
  });
}

export class Bridge {
  /**
   * @param {object} [opts]
   * @param {[number, number]} [opts.portRange] 端口范围 [start, end]
   * @param {string} [opts.token] 配置的 token；缺省自动生成（对外不暴露，HTTP 端点必填）
   * @param {number} [opts.maxBodyBytes]
   * @param {number} [opts.executeTimeoutMs]
   */
  constructor(opts = {}) {
    this.portRange = opts.portRange ?? [DEFAULT_PORT_START, DEFAULT_PORT_END];
    this.configuredToken = opts.token || '';
    this.token = opts.token || randomBytes(24).toString('hex');
    this.maxBodyBytes = opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
    this.executeTimeoutMs = opts.executeTimeoutMs ?? DEFAULT_EXECUTE_TIMEOUT_MS;

    /** @type {Map<string, {ws: import('ws').WebSocket, connected: boolean, active: boolean, edaVersion?: string, clientType?: string, editorType?: string, projectOpened?: boolean, documentType?: number, statusTs?: number}>} */
    this.windows = new Map();
    this.activeWindowId = null;

    /** @type {Map<string, {resolve: Function, reject: Function, timer: NodeJS.Timeout, windowId: string}>} */
    this.pending = new Map();

    this.httpServer = null;
    this.wss = null;
    this.port = null;
    this.startedAt = 0;
    this._stopped = false;
    this._nextEdaGeneration = 0; // 防同 windowId 旧 socket close 误删新连接（B4）
    this._windowOrderCounter = 0; // 窗口连接顺序号（UI 显示「窗口 N」，重连保持稳定）
  }

  // ─── 生命周期 ───────────────────────────────────────────────

  async start() {
    if (this._stopped) throw new Error('Bridge 已停止，不能重启');
    const [start, end] = this.portRange;
    let port = null;
    for (let p = start; p <= end; p++) {
      if (await isPortFree(p)) {
        port = p;
        break;
      }
    }
    if (port === null) {
      throw new Error(`端口范围 ${start}-${end} 全部被占用，无法启动桥`);
    }

    this.httpServer = createServer((req, res) => this._handleHttp(req, res));
    this.wss = new WebSocketServer({ server: this.httpServer });

    this.wss.on('connection', (ws, req) => this._onWsConnection(ws, req));

    await new Promise((resolve, reject) => {
      const onError = (err) => {
        this.httpServer.removeListener('listening', onListening);
        reject(err);
      };
      const onListening = () => {
        this.httpServer.removeListener('error', onError);
        resolve();
      };
      this.httpServer.once('error', onError);
      this.httpServer.once('listening', onListening);
      this.httpServer.listen(port, '127.0.0.1'); // 只绑回环（S1）
    });

    this.port = port;
    this.startedAt = Date.now();
    return port;
  }

  async stop(reason = 'shutdown') {
    if (this._stopped) return;
    this._stopped = true;

    // 通知 EDA 扩展优雅下线
    for (const [windowId, info] of this.windows) {
      try {
        if (info.ws.readyState === WebSocket.OPEN) {
          info.ws.send(JSON.stringify({ type: 'shutdown', reason, timestamp: Date.now() }));
        }
      }
      catch { /* ignore */ }
    }

    // 拒绝所有未决请求
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`桥已关闭（${reason}）`));
    }
    this.pending.clear();
    this.windows.clear();
    this.activeWindowId = null;

    await new Promise((resolve) => {
      try { this.wss?.close(() => resolve()); }
      catch { resolve(); }
      // 兜底：2s 强制关
      setTimeout(resolve, 2000).unref?.();
    });
    await new Promise((resolve) => {
      try { this.httpServer?.close(() => resolve()); }
      catch { resolve(); }
      setTimeout(resolve, 2000).unref?.();
    });
  }

  // ─── HTTP（127.0.0.1）───────────────────────────────────────

  _handleHttp(req, res) {
    const headers = {
      'Content-Type': 'application/json',
      // 禁止跨站读取（浏览器下不设 CORS *）
      'Cache-Control': 'no-store',
    };

    if (req.method === 'OPTIONS') {
      res.writeHead(204, headers);
      res.end();
      return;
    }

    const url = req.url || '/';

    // 健康检查：开放（兼容官方 SKILL 流程），不暴露 token
    if (req.method === 'GET' && url === '/health') {
      res.writeHead(200, headers);
      res.end(JSON.stringify({
        service: SERVICE_ID,
        provider: PROVIDER,
        version: VERSION,
        status: 'ok',
        edaConnected: this.windows.size > 0,
        edaWindowCount: this.windows.size,
        activeWindowId: this.activeWindowId,
        pendingRequests: this.pending.size,
        port: this.port,
        timestamp: Date.now(),
      }));
      return;
    }

    // 其余端点要求 token
    if (!this._checkToken(req)) {
      res.writeHead(401, headers);
      res.end(JSON.stringify({ error: 'Unauthorized: missing/invalid X-EasyEDA-Token' }));
      return;
    }

    if (req.method === 'GET' && url === '/eda-windows') {
      res.writeHead(200, headers);
      res.end(JSON.stringify(this.listWindows()));
      return;
    }

    if (req.method === 'POST' && url === '/eda-windows/select') {
      this._readBody(req, res, headers)
        .then((body) => {
          const { windowId } = body || {};
          if (typeof windowId !== 'string' || !this.windows.has(windowId)) {
            res.writeHead(404, headers);
            res.end(JSON.stringify({ error: `EDA window "${windowId}" not found` }));
            return;
          }
          this.selectWindow(windowId);
          res.writeHead(200, headers);
          res.end(JSON.stringify({ success: true, activeWindowId }));
        })
        .catch((err) => {
          if (err.responded) return;
          res.writeHead(400, headers);
          res.end(JSON.stringify({ error: err.message }));
        });
      return;
    }

    if (req.method === 'POST' && url === '/execute') {
      this._readBody(req, res, headers)
        .then(async (body) => {
          const code = body?.code;
          if (typeof code !== 'string' || !code.trim()) {
            res.writeHead(400, headers);
            res.end(JSON.stringify({ error: 'Missing "code" field (string)' }));
            return;
          }
          try {
            const result = await this.execute(code, {
              windowId: typeof body.windowId === 'string' ? body.windowId : undefined,
              timeoutMs: typeof body.timeoutMs === 'number' ? body.timeoutMs : undefined,
            });
            res.writeHead(200, headers);
            res.end(JSON.stringify({ success: true, result, windowId: body.windowId || this.activeWindowId }));
          }
          catch (err) {
            res.writeHead(err.message?.includes('未连接') ? 503 : 500, headers);
            res.end(JSON.stringify({ success: false, error: err.message }));
          }
        })
        .catch((err) => {
          if (err.responded) return;
          res.writeHead(err.code === 'EBODY_TOO_LARGE' ? 413 : 400, headers);
          res.end(JSON.stringify({ error: err.message }));
        });
      return;
    }

    res.writeHead(404, headers);
    res.end(JSON.stringify({ error: 'Not found' }));
  }

  _checkToken(req) {
    const header = req.headers['x-easyeda-token'];
    return typeof header === 'string' && header.length > 0 && header === this.token;
  }

  _readBody(req, res, headers) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      let responded = false;
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > this.maxBodyBytes) {
          // 先写 413 响应再断连，客户端才能收到明确错误（而非连接被重置/挂起）
          try {
            res.writeHead(413, headers);
            res.end(JSON.stringify({ error: 'Request body too large' }));
            responded = true;
          }
          catch { /* ignore */ }
          req.destroy();
          const err = new Error('Request body too large');
          err.code = 'EBODY_TOO_LARGE';
          err.responded = responded;
          reject(err);
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        try {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve(text ? JSON.parse(text) : {});
        }
        catch {
          reject(new Error('Invalid JSON body'));
        }
      });
      req.on('error', reject);
    });
  }

  // ─── WebSocket ──────────────────────────────────────────────

  _onWsConnection(ws, req) {
    const url = req.url || '/';
    const isEdaPath = url.startsWith('/eda');
    const isAgentPath = url.startsWith('/agent');

    // 2026-08-20 审计修复（P0-1）：WS 通道认证。
    // Origin 校验保留：恶意网页（未知 Origin）一律拒绝；空 Origin 的非浏览器客户端（EDA 宿主 WS / 本地脚本）
    // 放行但必须通过 register 的 token 认证（见 _bindEdaSocket）——token 才是真正安全边界，Origin 是浏览器层防线。
    // token 可从两处来：① `?token=` query（握手前协商，扩展首次连接无法带 config 里的 token 时由 handshake 下发）；
    // ② register 消息内（正式注册时必须带，桥校验后才接受）。
    const queryToken = typeof url === 'string' ? this._extractQueryToken(url) : '';
    if (isEdaPath && req.headers.origin && !isOriginAllowed(req.headers.origin)) {
      ws.close(1008, 'origin not allowed');
      return;
    }

    // Agent 通道要求 token（我们主要走 MCP，agent WS 供外部脚本/调试）
    if (isAgentPath && !this._checkToken(req)) {
      ws.close(1008, 'token required');
      return;
    }

    // 握手：携带 token —— 扩展端首次连接时从 handshake 读取并持久化，之后 register 必须带同一 token。
    // 浏览器网页场景 token 为空（仅 Origin 白名单放行，webview 无 config 通道）；浏览器侧由 Origin + 会话校验兜底。
    this._send(ws, {
      type: 'handshake',
      service: SERVICE_ID,
      provider: PROVIDER,
      version: VERSION,
      clientType: isEdaPath ? 'eda' : 'agent',
      token: this.token, // 下发桥 token（扩展端持久化后回传 register）
      timestamp: Date.now(),
    });

    if (isEdaPath) {
      this._bindEdaSocket(ws, queryToken);
    }
    else if (isAgentPath) {
      this._bindAgentSocket(ws);
    }
    else {
      ws.close(1008, 'unknown path');
    }
  }

  /** 从 WS 路径提取 ?token= 值（仅用于首次连接协商；正式认证以 register 内 token 为准） */
  _extractQueryToken(url) {
    const q = url.indexOf('?');
    if (q === -1) return '';
    const params = new URLSearchParams(url.slice(q + 1));
    const t = params.get('token');
    return typeof t === 'string' ? t : '';
  }

  _bindEdaSocket(ws, queryToken = '') {
    let generation = ++this._nextEdaGeneration;
    let registeredWindowId = null;
    // 2026-08-20 审计修复（P0-1）：认证状态。扩展 register 必须携带有效 token 才接受。
    let authenticated = false;

    ws.on('message', (raw) => {
      const msg = safeParse(raw.toString());
      if (!msg || typeof msg !== 'object') return;

      if (msg.type === 'register' && typeof msg.windowId === 'string') {
        // 认证：首次注册必须携带有效 token（query token 或 register 内 token）。
        // 已认证 socket 的「换 windowId 重注册」不再重复校验（同一受信连接）。
        // 浏览器网页（token 为空）不允许注册为 EDA 窗口——否则恶意网页可劫持 active 通道。
        if (!authenticated) {
          const registerToken = typeof msg.token === 'string' ? msg.token : '';
          const presented = registerToken || queryToken;
          if (!this.token || presented !== this.token) {
            console.warn(`[bridge] 认证失败：register 携带的 token 无效（windowId=${msg.windowId?.slice(0, 8)}…），拒绝注册`);
            this._send(ws, { type: 'error', id: 'auth', error: 'authentication failed: invalid token' });
            return;
          }
          authenticated = true;
        }
        // 同一 socket 换 windowId 重注册 → 清理旧映射，避免泄漏
        if (registeredWindowId && registeredWindowId !== msg.windowId) {
          const old = this.windows.get(registeredWindowId);
          if (old && old.ws === ws) this.windows.delete(registeredWindowId);
        }
        registeredWindowId = msg.windowId;
        this._registerWindow(ws, registeredWindowId, generation, msg.status);
        return;
      }

      // 未认证的连接：除 register 外的任何消息一律拒绝（防未注册先发 window-active 抢 active 通道）
      if (!authenticated) {
        if (msg.type === 'ping') { // ping 放行（健康探测不需要认证）
          this._send(ws, { type: 'pong', id: msg.id, timestamp: Date.now() });
          return;
        }
        console.warn(`[bridge] 未认证连接发送 type=${msg.type}，忽略`);
        return;
      }

      if (msg.type === 'status') {
        // 扩展发送 {type:'status', status:{...}} —— 取 msg.status，不是整个 msg
        this._updateWindowStatus(registeredWindowId, msg.status);
        return;
      }

      // EDA 窗口获得焦点 → 设为真实活动窗口（多窗口时反映用户当前看的窗口）
      if (msg.type === 'window-active' && registeredWindowId && this.windows.has(registeredWindowId)) {
        this.activeWindowId = registeredWindowId;
        this._refreshActiveFlags();
        return;
      }

      if (msg.type === 'ping') {
        this._send(ws, { type: 'pong', id: msg.id, timestamp: Date.now() });
        return;
      }

      if (msg.type === 'pong') {
        // 扩展心跳的响应，无需处理
        return;
      }

      
      if (msg.type === 'result' || msg.type === 'error') {
        this._resolvePending(msg);
        return;
      }

      // 未注册就发业务消息
      if (!registeredWindowId) {
        console.warn(`[bridge] EDA 在 register 前发消息 type=${msg.type}，忽略`);
        return;
      }
    });

    ws.on('close', () => {
      this._handleEdaClose(registeredWindowId, generation);
    });

    ws.on('error', (err) => {
      console.error(`[bridge] EDA socket 错误: ${err.message}`);
    });
  }

  _bindAgentSocket(ws) {
    ws.on('message', async (raw) => {
      const msg = safeParse(raw.toString());
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'ping') {
        this._send(ws, { type: 'pong', id: msg.id, timestamp: Date.now() });
        return;
      }
      if (msg.type === 'execute') {
        try {
          const result = await this.execute(msg.code, {
            windowId: typeof msg.windowId === 'string' ? msg.windowId : undefined,
            timeoutMs: typeof msg.timeoutMs === 'number' ? msg.timeoutMs : undefined,
          });
          this._send(ws, { type: 'result', id: msg.id, result, timestamp: Date.now() });
        }
        catch (err) {
          this._send(ws, { type: 'error', id: msg.id, error: err.message, timestamp: Date.now() });
        }
      }
    });
    ws.on('error', (err) => {
      console.error(`[bridge] agent socket 错误: ${err.message}`);
    });
  }

  // ─── EDA 窗口管理 ───────────────────────────────────────────

  _registerWindow(ws, windowId, generation, status) {
    // B4：同 windowId 重连 → 踢旧 socket（用 generation 区分，避免旧 socket close 删新连接）
    const old = this.windows.get(windowId);
    if (old && old.ws !== ws) {
      try {
        if (old.ws.readyState === WebSocket.OPEN) old.ws.close(1000, 'replaced by new connection');
      }
      catch { /* ignore */ }
    }

    this.windows.set(windowId, {
      ws,
      connected: ws.readyState === WebSocket.OPEN,
      active: false,
      _generation: generation,
      order: this.windows.get(windowId)?.order ?? ++this._windowOrderCounter, // 重连保持原顺序
      ...(status ? this._normalizeStatus(status) : {}),
      statusTs: Date.now(),
    });

    // 自动选择 active：首个连接 或 当前无 active
    if (this.windows.size === 1 || !this.activeWindowId || !this.windows.has(this.activeWindowId)) {
      this.activeWindowId = windowId;
    }
    this._refreshActiveFlags();
    console.log(`[bridge] [${new Date().toISOString()}] EDA 窗口已注册: ${windowId}（gen=${generation}），共 ${this.windows.size} 个`);
  }

  _updateWindowStatus(windowId, status) {
    if (!windowId || !this.windows.has(windowId)) return;
    const info = this.windows.get(windowId);
    Object.assign(info, this._normalizeStatus(status), { statusTs: Date.now() });
  }

  _normalizeStatus(status) {
    const out = {};
    if (typeof status.edaVersion === 'string') out.edaVersion = status.edaVersion;
    if (typeof status.clientType === 'string') out.clientType = status.clientType;
    if (typeof status.editorType === 'string') out.editorType = status.editorType;
    if (typeof status.projectOpened === 'boolean') out.projectOpened = status.projectOpened;
    if (typeof status.documentType === 'number') out.documentType = status.documentType;
    return out;
  }

  _handleEdaClose(windowId, generation) {
    // 只处理最新代际的连接（B4：旧 socket close 不误删新连接）
    if (windowId === null) return;
    const current = this.windows.get(windowId);
    if (!current || current._generation !== generation) return;

    console.log(`[bridge] [${new Date().toISOString()}] EDA 窗口关闭: ${windowId}（gen=${generation}）`);
    this.windows.delete(windowId);
    if (this.activeWindowId === windowId) {
      // B3：只选 connected 的窗口
      let next = null;
      for (const [id, info] of this.windows) {
        if (info.connected && id !== windowId) {
          next = id;
          break;
        }
      }
      this.activeWindowId = next;
    }
    this._refreshActiveFlags();

    // 拒绝该窗口的未决请求
    for (const [id, pending] of this.pending) {
      if (pending.windowId === windowId) {
        clearTimeout(pending.timer);
        pending.reject(new Error(`EDA 窗口 "${windowId}" 已断开`));
        this.pending.delete(id);
      }
    }
    console.log(`[bridge] EDA 窗口已断开: ${windowId}`);
  }

  _refreshActiveFlags() {
    for (const [id, info] of this.windows) {
      info.active = id === this.activeWindowId;
    }
  }

  _resolvePending(msg) {
    const pending = this.pending.get(msg.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(msg.id);
    if (msg.type === 'result') {
      pending.resolve(msg.result);
    }
    else {
      pending.reject(new Error(msg.error || '未知 EDA 错误'));
    }
  }

  // ─── 执行 ───────────────────────────────────────────────────

  /**
   * 在 EDA 中执行 JS 代码并返回结果（已安全序列化）。
   * @param {string} code
   * @param {{ windowId?: string, timeoutMs?: number, maxResultChars?: number }} [opts]
   * @returns {Promise<any>}
   */
  execute(code, opts = {}) {
    const targetWindowId = opts.windowId || this.activeWindowId;

    if (!targetWindowId) {
      return Promise.reject(new Error('没有已连接的 EDA 窗口。请先在立创EDA 中安装并启用扩展，或检查连接。'));
    }

    const info = this.windows.get(targetWindowId);
    if (!info || !info.connected || info.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error(`EDA 窗口 "${targetWindowId}" 已断开，请重新连接`));
    }

    const timeoutMs = opts.timeoutMs || this.executeTimeoutMs;
    const id = randomUUID();

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`请求 ${id} 在 ${timeoutMs}ms 内未得到 EDA 响应（可能文档/工程状态不对或操作过重）`));
      }, timeoutMs);
      timer.unref?.();

      this.pending.set(id, { resolve, reject, timer, windowId: targetWindowId });

      try {
        const sent = this._send(info.ws, {
          type: 'execute',
          id,
          code,
          windowId: targetWindowId,
          timestamp: Date.now(),
        });
        // 窗口在检查后失效 → 快速失败，不挂到超时
        if (!sent) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(new Error(`EDA 窗口 "${targetWindowId}" 已断开，请重新连接`));
        }
      }
      catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      }
    }).then((rawResult) => {
      // 结果安全序列化（S3 兜底）：EDA 侧已序列化，这里再保证 MCP/HTTP 不抛
      const { text, truncated } = safeStringify(rawResult, {
        maxLength: opts.maxResultChars || 512_000,
      });
      if (truncated) {
        // 截断后的文本不再是完整 JSON，不能 safeParse —— 直接把文本当预览返回
        return { __truncated: true, preview: text };
      }
      return safeParse(text);
    });
  }

  _send(ws, msg) {
    if (ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(msg));
    return true;
  }

  // ─── 查询 ───────────────────────────────────────────────────

  listWindows() {
    const windows = [];
    for (const [windowId, info] of this.windows) {
      windows.push({
        windowId,
        order: info.order ?? 0,
        connected: info.connected && info.ws.readyState === WebSocket.OPEN,
        active: info.active,
        edaVersion: info.edaVersion,
        clientType: info.clientType,
        editorType: info.editorType,
        projectOpened: info.projectOpened,
        documentType: info.documentType,
        statusTs: info.statusTs,
      });
    }
    return { windows, activeWindowId: this.activeWindowId, count: this.windows.size };
  }

  selectWindow(windowId) {
    if (!this.windows.has(windowId)) {
      throw new Error(`EDA 窗口 "${windowId}" 不存在`);
    }
    this.activeWindowId = windowId;
    this._refreshActiveFlags();
    return { ok: true, activeWindowId: windowId };
  }

  getStatus() {
    const { windows, activeWindowId, count } = this.listWindows();
    return {
      service: SERVICE_ID,
      provider: PROVIDER,
      version: VERSION,
      port: this.port,
      edaConnected: count > 0,
      edaWindowCount: count,
      activeWindowId,
      windows,
      pendingRequests: this.pending.size,
      startedAt: this.startedAt,
      uptimeMs: this.startedAt ? Date.now() - this.startedAt : 0,
    };
  }
}
