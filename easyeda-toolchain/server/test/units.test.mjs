import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Units, normalizeUnitName } from '../src/units.mjs';

test('mm ↔ mil（PCB 单位）', () => {
  assert.ok(Math.abs(Units.mmToMil(1) - 39.3701) < 0.001);
  assert.ok(Math.abs(Units.milToMm(39.3701) - 1) < 0.001);
  assert.equal(Units.convert(10, { from: 'mm', to: 'mil' }), Units.mmToMil(10));
});

test('mm ↔ sch（原理图单位 0.01inch）', () => {
  // 1mm ≈ 3.937 原理图单位
  assert.ok(Math.abs(Units.mmToSch(1) - 3.937) < 0.01);
  assert.ok(Math.abs(Units.schToMm(3.937) - 1) < 0.01);
});

test('mil ↔ sch（10 倍关系）', () => {
  assert.equal(Units.milToSch(10), 1);
  assert.equal(Units.schToMil(1), 10);
});

test('convert 支持合法组合与非法报错', () => {
  assert.equal(Units.convert(5, { from: 'mil', to: 'sch' }), 0.5);
  assert.throws(() => Units.convert(1, { from: 'mm', to: 'unknown' }), /未知单位换算/);
});

test('round 保留 4 位', () => {
  assert.equal(Units.round(3.1415926), 3.1416);
  assert.equal(Units.round(10), 10);
});

test('normalizeUnitName 别名归一', () => {
  assert.equal(normalizeUnitName('mm'), 'mm');
  assert.equal(normalizeUnitName('MIL'), 'mil');
  assert.equal(normalizeUnitName('0.01inch'), 'sch');
  assert.equal(normalizeUnitName('μm'), 'um');
  assert.equal(normalizeUnitName('nope'), 'nope');
});
