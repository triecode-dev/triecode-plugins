/**
 * TrieCode EDA 桥 —— 立创EDA(EasyEDA) 扩展
 *
 * 基于立创官方 run-api-gateway（Apache-2.0，作者 JLCEDA）fork 改进：
 *  - S3 修复：执行结果安全序列化（深度/循环/数量受限），不再因 JSON.stringify 抛异常而丢结果
 *  - B5 修复：重试改为指数退避（2s→30s 封顶）+ 不设 5 次死上限（60 次，手动可恢复）
 *  - B6 修复：心跳 pong 按序号匹配，迟到 pong 不再误取消重连
 *  - 新增：注册后主动上报 EDA 版本/客户端/工程/文档状态，桥缓存供 AI 免逐次查询
 *  - 新增：收到桥 {type:'shutdown'} 优雅停止连接
 *  - 保留：与官方 easyeda-bridge 协议完全兼容（握手 service=“easyeda-bridge”）
 *
 * 协议消息：handshake / register / status / execute / result / error / ping / pong / shutdown
 */

import * as extensionConfig from '../extension.json';

// ─── 配置 ───────────────────────────────────────────────────
const WS_ID = 'ai-bridge';
const PORT_START = 49620;
const PORT_END = 49629;
const SERVICE_ID = 'easyeda-bridge';
const RETRY_DELAY_BASE_MS = 2000;
const RETRY_DELAY_MAX_MS = 30_000;
const MAX_RETRIES = 60; // 官方为 5（永久停摆）；这里放宽到 60 次指数退避，仍可手动停止
const HEARTBEAT_INTERVAL_MS = 15_000;
// 心跳超时放宽到 30s：EDA 后台标签节流 setInterval、或桥/扩展一侧忙（execute 长调用）时，
// 5s 太紧会周期性误判断连 → 反复重连 → 弹"已连接" + 软件端窗口虚增。
// 30s 远超 execute 典型时长，仍能检测真断连（桥死/网络断）。
const HEARTBEAT_TIMEOUT_MS = 30_000;
const CONNECTION_TIMEOUT_MS = 1_500; // 每端口连接+握手超时
const STATUS_REPORT_INTERVAL_MS = 10_000; // 周期上报状态（缩短：工程/文档变化更快反映到面板）
const STORAGE_KEY_AUTO_CONNECT = 'autoConnectEnabled';
const STORAGE_KEY_TOKEN = 'gatewayToken';
const STORAGE_KEY_WINDOW_ID = 'bridgeWindowId'; // 固定窗口标识：重连复用同一 UUID，避免软件端窗口列表递增
const MBUS_TOPIC_STATUS = 'api-gateway-status';
const MBUS_TOPIC_CONTROL = 'api-gateway-control';

// ─── 状态 ───────────────────────────────────────────────────
let currentPort: number | null = null;
let handshakeVerified = false;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let heartbeatPendingSeq = -1;
let autoConnectEnabled = true;
let retryCount = 0;
let windowId: string | null = null;
let isConnecting = false;
let connectionSessionId = 0;
let messageBusRegistered = false;
let statusReportTimer: ReturnType<typeof setInterval> | null = null;
let heartbeatSeq = 0;

interface GatewayControlRequest {
	command: 'reconnect' | 'stop';
}

interface GatewayControlResponse {
	handled: boolean;
	connected: boolean;
	windowId: string | null;
}

interface BridgeMessage {
	type: 'execute' | 'ping' | 'pong' | 'handshake' | 'result' | 'error' | 'shutdown' | 'status';
	id?: string;
	code?: string;
	service?: string;
	result?: unknown;
	error?: string;
	token?: string;
	reason?: string;
	timestamp?: number;
}

/**
 * 获取当前连接状态（供 messageBus RPC 调用）
 */
function getConnectionStatus(): {
	connected: boolean;
	connecting: boolean;
	port: number | null;
	windowId: string | null;
} {
	return {
		connected: handshakeVerified,
		connecting: isConnecting,
		port: currentPort,
		windowId,
	};
}

function ensureMessageBusServices(): void {
	if (messageBusRegistered)
		return;

	eda.sys_MessageBus.rpcService(MBUS_TOPIC_STATUS, () => getConnectionStatus());
	eda.sys_MessageBus.rpcService(MBUS_TOPIC_CONTROL, (request?: GatewayControlRequest): GatewayControlResponse => {
		if (request?.command === 'reconnect') {
			performReconnect();
		}
		else if (request?.command === 'stop') {
			performStopConnection(false);
		}

		return {
			handled: true,
			connected: handshakeVerified,
			windowId,
		};
	});

	messageBusRegistered = true;
}

function nextConnectionSessionId(): number {
	connectionSessionId += 1;
	return connectionSessionId;
}

function isConnectionSessionActive(sessionId: number): boolean {
	return sessionId === connectionSessionId;
}

function closeWebSocket(): void {
	try {
		eda.sys_WebSocket.close(WS_ID);
	}
	catch { /* ignore */ }
}

function clearRetryTimer(): void {
	if (retryTimer) {
		clearTimeout(retryTimer);
		retryTimer = null;
	}
}

function stopHeartbeat(): void {
	if (heartbeatTimer) {
		clearInterval(heartbeatTimer);
		heartbeatTimer = null;
	}
	heartbeatPendingSeq = -1;
}

function stopStatusReport(): void {
	if (statusReportTimer) {
		clearInterval(statusReportTimer);
		statusReportTimer = null;
	}
}

function cancelConnectionFlow(resetRetryCount = true): void {
	nextConnectionSessionId();
	isConnecting = false;
	clearRetryTimer();
	stopHeartbeat();
	stopStatusReport();
	handshakeVerified = false;
	currentPort = null;
	// windowId 不置空：保留固定标识（首次生成后持久化，重连复用避免窗口列表递增）
	if (resetRetryCount) {
		retryCount = 0;
	}
	closeWebSocket();
}

function performReconnect(): void {
	eda.sys_Message.showToastMessage(eda.sys_I18n.text('Reconnecting...'));
	cancelConnectionFlow();
	void scanAndConnect();
}

function performStopConnection(showToast = true): void {
	cancelConnectionFlow();
	if (showToast) {
		eda.sys_Message.showToastMessage(eda.sys_I18n.text('Connection stopped'));
	}
}

async function dispatchControlCommand(command: GatewayControlRequest['command']): Promise<void> {
	try {
		const response = await eda.sys_MessageBus.rpcCall(MBUS_TOPIC_CONTROL, { command }, 500) as GatewayControlResponse;
		if (response?.handled) {
			if (command === 'stop') {
				eda.sys_Message.showToastMessage(eda.sys_I18n.text('Connection stopped'));
			}
			return;
		}
	}
	catch { /* ignore */ }

	ensureMessageBusServices();
	if (command === 'reconnect') {
		performReconnect();
	}
	else {
		performStopConnection();
	}
}

// ─── 安全序列化（S3：官方 JSON.stringify 抛异常丢结果的修复）───

interface SerializeResult {
	value: unknown;
	truncated: boolean;
}

/**
 * Uint8Array → base64（分块 String.fromCharCode，避免大缓冲一次性展开触发 RangeError）。
 */
function bytesToBase64(view: Uint8Array): string {
	let bin = '';
	const CHUNK = 0x8000; // 32KB/块，单次 apply 参数远低于调用栈上限
	for (let i = 0; i < view.length; i += CHUNK) {
		bin += String.fromCharCode(...Array.from(view.subarray(i, i + CHUNK)));
	}
	return btoa(bin);
}

/**
 * 把任意 EDA 返回值转成可 JSON 化的普通值。
 * 处理循环引用、深度、数量、函数/symbol/undefined、BigInt、NaN/Infinity。
 */
function safeSerialize(input: unknown, maxDepth = 8, maxItems = 500): SerializeResult {
	const seen = new WeakSet<object>();
	let truncated = false;

	const convert = (value: unknown, depth: number): unknown => {
		if (value === null)
			return null;
		if (typeof value === 'string' || typeof value === 'boolean')
			return value;
		if (typeof value === 'number')
			return Number.isFinite(value) ? value : String(value);
		if (typeof value === 'bigint')
			return value.toString();
		if (typeof value === 'undefined' || typeof value === 'symbol' || typeof value === 'function')
			return undefined;
		if (depth > maxDepth) {
			truncated = true;
			return '[深度超限]';
		}
		if (value instanceof Date)
			return value.toISOString();
		if (value instanceof ArrayBuffer) {
			return { __type: 'bytes', base64: bytesToBase64(new Uint8Array(value)) };
		}
		if (ArrayBuffer.isView(value)) {
			return { __type: 'bytes', base64: bytesToBase64(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)) };
		}
		if (seen.has(value as object)) {
			truncated = true;
			return '[循环引用]';
		}
		seen.add(value as object);
		try {
			if (Array.isArray(value)) {
				const arr: unknown[] = [];
				for (let i = 0; i < value.length; i++) {
					if (arr.length >= maxItems) {
						truncated = true;
						break;
					}
					arr.push(convert(value[i], depth + 1));
				}
				return arr;
			}
			const obj: Record<string, unknown> = {};
			let count = 0;
			for (const key of Object.keys(value as object)) {
				if (count >= maxItems) {
					truncated = true;
					break;
				}
				obj[key] = convert((value as Record<string, unknown>)[key], depth + 1);
				count++;
			}
			return obj;
		}
		finally {
			seen.delete(value as object);
		}
	};

	return { value: convert(input, 0), truncated };
}

function sendJson(payload: Record<string, unknown>): void {
	try {
		eda.sys_WebSocket.send(WS_ID, JSON.stringify(payload));
	}
	catch { /* 发送失败忽略，心跳会触发重连 */ }
}

// ─── 状态上报 ───────────────────────────────────────────────

/**
 * 尽力收集当前 EDA 状态（各 API 在 try/catch 内，失败不阻塞连接）。
 */
async function buildStatus(): Promise<Record<string, unknown>> {
	const status: Record<string, unknown> = {};
	try {
		const env = eda.sys_Environment;
		status.edaVersion = env?.getEditorCurrentVersion?.();
		if (env?.isClient?.())
			status.clientType = 'client';
		else if (env?.isWeb?.())
			status.clientType = 'web';
	}
	catch { /* ignore */ }
	try {
		const project = await eda.dmt_Project?.getCurrentProjectInfo?.();
		status.projectOpened = Boolean(project);
	}
	catch { /* ignore */ }
	try {
		const doc = await eda.dmt_SelectControl?.getCurrentDocumentInfo?.();
		if (doc) {
			status.documentType = doc.documentType;
			status.documentUuid = doc.uuid;
		}
	}
	catch { /* ignore */ }
	return status;
}

async function reportStatus(): Promise<void> {
	if (!handshakeVerified)
		return;
	try {
		const status = await buildStatus();
		sendJson({ type: 'status', windowId, status, timestamp: Date.now() });
	}
	catch { /* ignore */ }
}

// ─── 生命周期 ───────────────────────────────────────────────

/**
 * 扩展激活入口（支持 onStartupFinished 自动启动）
 */
// eslint-disable-next-line unused-imports/no-unused-vars
export function activate(status?: 'onStartupFinished', arg?: string): void {
	ensureMessageBusServices();
	registerWindowFocusListener();
	const storedValue = eda.sys_Storage.getExtensionUserConfig(STORAGE_KEY_AUTO_CONNECT);
	autoConnectEnabled = storedValue !== false;

	if (autoConnectEnabled) {
		void scanAndConnect();
	}
}

/**
 * 监听 EDA 窗口获得焦点 → 通知桥把该窗口设为活动窗口（多窗口时反映真实活动）。
 */
function registerWindowFocusListener(): void {
	try {
		eda.sys_Window.addEventListener(ESYS_WindowEventType.FOCUS, () => {
			if (handshakeVerified && windowId) {
				sendJson({ type: 'window-active', windowId, timestamp: Date.now() });
			}
		});
	}
	catch { /* 无焦点事件支持时忽略（不影响连接） */ }
}

/**
 * 扩展停用时清理资源
 */
export function deactivate(): void {
	cancelConnectionFlow(false);
}

// ─── 菜单操作 ───────────────────────────────────────────────

/**
 * 手动重新连接（菜单项）
 */
export function reconnect(): void {
	void dispatchControlCommand('reconnect');
}

/**
 * 关于对话框（菜单项）
 */
export async function about(): Promise<void> {
	let status: string;

	let statusInfo = { connected: false, connecting: false, port: 0, windowId: null };
	try {
		statusInfo = await eda.sys_MessageBus.rpcCall(MBUS_TOPIC_STATUS, undefined, 300);
	}
	// eslint-disable-next-line unused-imports/no-unused-vars
	catch (e) {}

	if (statusInfo?.connected) {
		const portInfo = `Connected (port ${statusInfo.port})`;
		const windowInfo = statusInfo.windowId ? `\nWindow ID: ${statusInfo.windowId}` : '\nWindow ID: (not registered)';
		status = `${portInfo}${windowInfo}`;
	}
	else if (statusInfo?.connecting) {
		status = 'Connecting...';
	}
	else {
		status = 'Disconnected';
	}

	eda.sys_Dialog.showInformationMessage(
		`TrieCode EDA 桥 v${extensionConfig.version}\n${status}`,
		'About',
	);
}

/**
 * 切换自动连接开关（菜单项）
 */
export async function toggleAutoConnect(): Promise<void> {
	const current = eda.sys_Storage.getExtensionUserConfig(STORAGE_KEY_AUTO_CONNECT);
	const newValue = current !== false;
	await eda.sys_Storage.setExtensionUserConfig(STORAGE_KEY_AUTO_CONNECT, !newValue);

	const msgKey = !newValue
		? 'Auto-Connect enabled'
		: 'Auto-Connect disabled';
	eda.sys_Message.showToastMessage(eda.sys_I18n.text(msgKey));
}

/**
 * 停止连接并取消重试（菜单项）
 */
export function stopConnection(): void {
	void dispatchControlCommand('stop');
}

// ─── 端口扫描与连接 ─────────────────────────────────────────

/**
 * 扫描端口范围，通过 WebSocket 连接 + 握手验证找到 Bridge Server。
 * （B5：指数退避重试，不再 5 次后永久停摆）
 */
async function scanAndConnect(): Promise<void> {
	if (isConnecting) {
		return;
	}

	const sessionId = nextConnectionSessionId();
	isConnecting = true;
	clearRetryTimer();

	try {
		if (retryCount >= MAX_RETRIES) {
			eda.sys_Message.showToastMessage(eda.sys_I18n.text('Max retries reached'), ESYS_ToastMessageType.ERROR);
			return;
		}

		for (let port = PORT_START; port <= PORT_END; port++) {
			if (!isConnectionSessionActive(sessionId)) {
				return;
			}

			const found = await tryConnectToPort(port, sessionId);
			if (!isConnectionSessionActive(sessionId)) {
				return;
			}

			if (found) {
				currentPort = port;
				retryCount = 0;
				startHeartbeat(sessionId);
				startStatusReport();
				void reportStatus(); // 连接后立即上报一次
				return;
			}
		}

		retryCount++;
		const delay = Math.min(RETRY_DELAY_BASE_MS * (2 ** Math.min(retryCount, 8)), RETRY_DELAY_MAX_MS);
		console.warn(`[TrieCode-EDA] 未找到桥，${delay / 1000}s 后重试（${retryCount}/${MAX_RETRIES}）`);
		eda.sys_Message.showToastMessage(
			`${eda.sys_I18n.text('Bridge not found, retrying in ', undefined, undefined, String(delay / 1000))} (${retryCount}/${MAX_RETRIES})`,
			ESYS_ToastMessageType.INFO,
		);
		scheduleRetry(sessionId, delay);
	}
	finally {
		if (isConnectionSessionActive(sessionId)) {
			isConnecting = false;
		}
	}
}

/**
 * 尝试通过 WebSocket 连接到指定端口，等待握手验证。
 */
function tryConnectToPort(port: number, sessionId: number): Promise<boolean> {
	return new Promise((resolve) => {
		let settled = false;

		let timer: ReturnType<typeof setTimeout>;

		const settle = (success: boolean) => {
			if (settled)
				return;
			settled = true;
			clearTimeout(timer);
			if (!success && isConnectionSessionActive(sessionId)) {
				closeWebSocket();
			}
			resolve(success);
		};

		if (!isConnectionSessionActive(sessionId)) {
			resolve(false);
			return;
		}

		closeWebSocket();

		timer = setTimeout(() => settle(false), CONNECTION_TIMEOUT_MS);

		handshakeVerified = false;

		try {
			eda.sys_WebSocket.register(
				WS_ID,
				`ws://127.0.0.1:${port}/eda`,
				async (event: MessageEvent) => {
					if (!isConnectionSessionActive(sessionId)) {
						settle(false);
						return;
					}

					try {
						const msg = JSON.parse(event.data) as BridgeMessage;

						if (msg.type === 'handshake') {
							if (msg.service === SERVICE_ID) {
								handshakeVerified = true;
								// 固定 windowId：首次生成后持久化，重连复用同一 UUID
								// （否则每次重连都是新 UUID → 软件端窗口列表递增）
								const firstConnect = !windowId;
								if (windowId) {
									// 已固定过，直接复用
								} else {
									const storedWid = eda.sys_Storage.getExtensionUserConfig(STORAGE_KEY_WINDOW_ID);
									if (typeof storedWid === 'string' && storedWid) {
										windowId = storedWid;
									} else {
										windowId = crypto.randomUUID();
										// 异步落盘（set 返回 Promise；await 确保写入完成，重连时能读到）
										void eda.sys_Storage.setExtensionUserConfig(STORAGE_KEY_WINDOW_ID, windowId).catch(() => {});
									}
								}
								// 2026-08-20 审计修复（P0-1）：从 handshake 获取桥 token 并持久化。
								// 桥每次开始都生成一个 token（可用命令行参数 / EASYEDA_TOKEN env 预设）。
								// 扩展必须存储桥下发的 token，register 时携带它，桥校验后才接受注册。
								// 桥重启（新进程新 token）→ 扩展存的新 token 覆盖旧 token，register 带新 token → 校验通过。
								const handshakeToken = typeof msg.token === 'string' && msg.token ? msg.token : '';
								if (handshakeToken) {
									void eda.sys_Storage.setExtensionUserConfig(STORAGE_KEY_TOKEN, handshakeToken).catch(() => {});
								}
								const storedToken = eda.sys_Storage.getExtensionUserConfig(STORAGE_KEY_TOKEN);
								const registerMsg: Record<string, unknown> = {
									type: 'register',
									windowId,
									timestamp: Date.now(),
								};
								const token = typeof storedToken === 'string' && storedToken ? storedToken : handshakeToken;
								if (token) {
									registerMsg.token = token;
								}
								eda.sys_WebSocket.send(WS_ID, JSON.stringify(registerMsg));
								// 只在首次连接弹 toast，重连静默（避免反复弹"已连接"）
								if (firstConnect) {
									eda.sys_Message.showToastMessage(
										`${eda.sys_I18n.text('Bridge connected (port ', undefined, undefined, String(port))})`,
									);
								}
								settle(true);
							}
							else {
								console.warn(`[TrieCode-EDA] 握手失败：非预期服务 "${msg.service}"`);
								settle(false);
							}
							return;
						}

						if (!handshakeVerified)
							return;

						await handleMessage(msg);
					}
					catch (err) {
						console.error('[TrieCode-EDA] 消息处理失败:', err);
					}
				},
				() => {},
			);
		}
		catch (e) {
			console.error('[TrieCode-EDA] WebSocket 注册失败:', e);
			settle(false);
		}
	});
}

// ─── 心跳检测（B6：序号匹配，迟到 pong 不再误取消重连）──────

function startHeartbeat(sessionId: number): void {
	stopHeartbeat();
	heartbeatTimer = setInterval(() => {
		if (!isConnectionSessionActive(sessionId)) {
			stopHeartbeat();
			return;
		}
		if (!handshakeVerified)
			return;
		try {
			const seq = ++heartbeatSeq;
			heartbeatPendingSeq = seq;
			eda.sys_WebSocket.send(WS_ID, JSON.stringify({
				type: 'ping',
				id: `hb-${seq}`,
				timestamp: Date.now(),
			}));
			// 超时未收到对应序号 pong → 判定断线，重连
			setTimeout(() => {
				if (!isConnectionSessionActive(sessionId)) {
					return;
				}
				if (heartbeatPendingSeq === seq) {
					console.warn('[TrieCode-EDA] 心跳超时，重新连接...');
					eda.sys_Message.showToastMessage(eda.sys_I18n.text('Bridge heartbeat timeout, reconnecting...'), ESYS_ToastMessageType.WARNING);
					cancelConnectionFlow();
					void scanAndConnect();
				}
			}, HEARTBEAT_TIMEOUT_MS);
		}
		catch {
			cancelConnectionFlow();
			void scanAndConnect();
		}
	}, HEARTBEAT_INTERVAL_MS);
}

function startStatusReport(): void {
	stopStatusReport();
	statusReportTimer = setInterval(() => {
		void reportStatus();
	}, STATUS_REPORT_INTERVAL_MS);
}

// ─── 重试（指数退避）────────────────────────────────────────

function scheduleRetry(sessionId: number, delay: number): void {
	clearRetryTimer();
	retryTimer = setTimeout(() => {
		if (!isConnectionSessionActive(sessionId) || isConnecting) {
			return;
		}
		void scanAndConnect();
	}, delay);
}

// ─── 消息处理 ───────────────────────────────────────────────

async function handleMessage(msg: BridgeMessage): Promise<void> {
	if (msg.type === 'ping') {
		sendJson({ type: 'pong', id: msg.id, timestamp: Date.now() });
		return;
	}

	if (msg.type === 'pong') {
		// B6：只认当前序号的心跳响应
		const seq = String(msg.id || '').startsWith('hb-') ? Number(String(msg.id).slice(3)) : -1;
		if (seq === heartbeatPendingSeq) {
			heartbeatPendingSeq = -1;
		}
		return;
	}

	// 桥优雅关闭：停止连接并提示
	if (msg.type === 'shutdown') {
		console.warn(`[TrieCode-EDA] 桥关闭（${msg.reason || 'unknown'}），停止连接`);
		performStopConnection(false);
		return;
	}

	if (msg.type === 'execute' && msg.code) {
		try {
			const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
			const fn = new AsyncFunction('eda', msg.code);
			const result = await fn(eda);

			// S3：安全序列化后再回传，不再丢结果
			const { value, truncated } = safeSerialize(result);
			sendJson({
				type: 'result',
				id: msg.id,
				result: value,
				truncated,
				timestamp: Date.now(),
			});
			void reportStatus(); // AI 每次执行后立即刷新状态缓存（工程/文档可能已变）
		}
		catch (err: unknown) {
			sendJson({
				type: 'error',
				id: msg.id,
				error: err instanceof Error ? err.message : String(err),
				timestamp: Date.now(),
			});
		}
	}
}
