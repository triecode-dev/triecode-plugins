import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toPlain, safeStringify, safeParse } from '../src/serialize.mjs';

test('safeStringify 处理循环引用（官方 S3 丢结果根因）', () => {
  const a = { name: 'a' };
  a.self = a;
  const { text, truncated } = safeStringify(a);
  assert.ok(truncated); // 循环引用被替换 = 有损，应标记
  const parsed = JSON.parse(text);
  assert.equal(parsed.name, 'a');
  assert.equal(parsed.self, '[循环引用]');
});

test('safeStringify 跳过函数/symbol/undefined，不抛异常', () => {
  const v = { fn: () => {}, sym: Symbol('x'), undef: undefined, ok: 1 };
  const { text } = safeStringify(v);
  const parsed = JSON.parse(text);
  assert.equal(parsed.ok, 1);
  assert.equal('fn' in parsed, false);
  assert.equal('sym' in parsed, false);
  assert.equal('undef' in parsed, false);
});

test('safeStringify 处理 BigInt/NaN/Infinity 不抛异常', () => {
  const v = { big: 123n, nan: NaN, inf: Infinity, neg: -Infinity };
  const { text } = safeStringify(v);
  const parsed = JSON.parse(text);
  assert.equal(parsed.big, '123');
  assert.equal(parsed.nan, 'NaN');
  assert.equal(parsed.inf, 'Infinity');
});

test('safeStringify 深度超限标记 truncated', () => {
  const deep = { l1: { l2: { l3: { l4: { l5: { l6: { l7: { l8: { l9: 'x' } } } } } } } } };
  const { text, truncated } = safeStringify(deep, { maxDepth: 4 });
  assert.ok(truncated);
  assert.ok(text.includes('深度超限'));
});

test('safeStringify 超长截断', () => {
  const v = { data: 'x'.repeat(10_000) };
  const { text, truncated } = safeStringify(v, { maxLength: 1000 });
  assert.ok(truncated);
  assert.ok(text.length <= 1000 + 6); // 含后缀标记
  assert.ok(text.endsWith('…[已截断]'));
});

test('safeStringify 数量超限截断数组', () => {
  const arr = Array.from({ length: 1000 }, (_, i) => i);
  const { value, truncated } = toPlain(arr, { maxItems: 10 });
  assert.ok(truncated);
  assert.equal(value.length, 10);
});

test('toPlain 把 Buffer 转 base64，不丢二进制语义', () => {
  const buf = Buffer.from([0x01, 0x02, 0xff]);
  const { value } = toPlain({ b: buf });
  assert.equal(value.b.__type, 'bytes');
  assert.equal(Buffer.from(value.b.base64, 'base64').length, 3);
});

test('toPlain 处理 Date', () => {
  const { value } = toPlain({ d: new Date('2026-01-01T00:00:00Z') });
  assert.equal(value.d, '2026-01-01T00:00:00.000Z');
});

test('safeParse 不抛异常（坏 JSON 返回 undefined）', () => {
  assert.equal(safeParse('{bad json'), undefined);
  assert.equal(safeParse(''), undefined);
  assert.equal(safeParse('{"a":1}').a, 1);
});

test('safeStringify 对 undefined/顶层非对象也安全', () => {
  const { text } = safeStringify(undefined);
  assert.equal(typeof text, 'string');
  const { text: text2 } = safeStringify(42);
  assert.equal(JSON.parse(text2), 42);
});
