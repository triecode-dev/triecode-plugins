/**
 * 安全序列化工具
 *
 * EDA 运行时返回的对象常带循环引用、方法、BigInt、深层嵌套等，
 * 官方扩展直接 `JSON.stringify(result)` 会抛异常导致结果丢失。
 * 这里提供：
 *  - toPlain()   循环/深度/数量安全地转为 JSON-safe 普通值（跳过函数/symbol/undefined）
 *  - safeStringify()  绝不抛异常的 JSON.stringify（超长截断）
 *  - safeParse()  绝不抛异常的 JSON.parse
 */

export const DEFAULT_MAX_DEPTH = 8;
export const DEFAULT_MAX_ITEMS = 500;
export const DEFAULT_MAX_LENGTH = 512_000;

/**
 * 把任意值转成 JSON-safe 普通值。
 * @param {unknown} input
 * @param {{ maxDepth?: number, maxItems?: number, seen?: WeakSet<object> }} [opts]
 * @returns {{ value: unknown, truncated: boolean }}
 */
export function toPlain(input, opts = {}) {
  const maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxItems = opts.maxItems ?? DEFAULT_MAX_ITEMS;
  const seen = opts.seen ?? new WeakSet();
  const state = { truncated: false };
  return { value: convert(input, 0, maxDepth, maxItems, seen, state), truncated: state.truncated };
}

function convert(input, depth, maxDepth, maxItems, seen, state) {
  if (input === null) return null;

  const t = typeof input;
  if (t === 'string') return input;
  if (t === 'boolean') return input;
  if (t === 'number') {
    return Number.isFinite(input) ? input : String(input); // NaN / Infinity → 字符串
  }
  if (t === 'bigint') return input.toString();
  if (t === 'undefined' || t === 'symbol' || t === 'function') return undefined;

  if (depth > maxDepth) {
    state.truncated = true;
    return '[深度超限]';
  }

  if (input instanceof Date) return input.toISOString();

  // Buffer / TypedArray → base64（防 JSON 抛错 & 语义保留）
  if (ArrayBuffer.isView(input) || input instanceof ArrayBuffer) {
    const buf = Buffer.from(input.buffer ?? input, input.byteOffset ?? 0, input.byteLength ?? input.byteLength);
    return { __type: 'bytes', base64: buf.toString('base64') };
  }

  if (seen.has(input)) {
    state.truncated = true;
    return '[循环引用]';
  }
  seen.add(input);

  try {
    if (Array.isArray(input)) {
      const arr = [];
      for (let i = 0; i < input.length; i++) {
        if (arr.length >= maxItems) {
          state.truncated = true;
          break;
        }
        arr.push(convert(input[i], depth + 1, maxDepth, maxItems, seen, state));
      }
      return arr;
    }

    const obj = {};
    let count = 0;
    for (const key of Object.keys(input)) {
      if (count >= maxItems) {
        state.truncated = true;
        break;
      }
      obj[key] = convert(input[key], depth + 1, maxDepth, maxItems, seen, state);
      count++;
    }
    return obj;
  }
  finally {
    seen.delete(input);
  }
}

/**
 * 绝不抛异常的 JSON.stringify；超长截断并标记。
 * @param {unknown} input
 * @param {{ maxLength?: number, maxDepth?: number, maxItems?: number }} [opts]
 * @returns {{ text: string, truncated: boolean }}
 */
export function safeStringify(input, opts = {}) {
  const maxLength = opts.maxLength ?? DEFAULT_MAX_LENGTH;
  const { value, truncated } = toPlain(input, opts);

  let text;
  try {
    text = JSON.stringify(value);
  }
  catch {
    try {
      text = JSON.stringify(String(value));
    }
    catch {
      text = '"[无法序列化]"';
    }
  }
  if (text === undefined) text = String(text);

  // 长度截断也要标记 truncated（无论是否经过 toPlain 的深度/数量截断）
  if (text.length > maxLength) {
    text = `${text.slice(0, maxLength)}…[已截断]`;
    return { text, truncated: true };
  }
  return { text, truncated };
}

/**
 * 绝不抛异常的 JSON.parse。
 * @param {string} json
 * @returns {unknown} 解析失败返回 undefined
 */
export function safeParse(json) {
  if (typeof json !== 'string' || json.length === 0) return undefined;
  try {
    return JSON.parse(json);
  }
  catch {
    return undefined;
  }
}
