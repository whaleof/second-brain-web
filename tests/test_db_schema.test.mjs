import { test } from 'node:test';
import assert from 'node:assert/strict';
import pkg from '../db_schema.js';
const { validateRecord, DBError, CODES } = pkg;

test('timeline_logs add: 合法通过', () => {
  const r = validateRecord('timeline_logs', { date: '2026-08-13', hour: 14, content: '写代码' }, 'add');
  assert.equal(r.ok, true);
});

test('timeline_logs add: hour 是字符串被拦（类型错，防 str/int 混写坑）', () => {
  const r = validateRecord('timeline_logs', { date: '2026-08-13', hour: '14', content: '写代码' }, 'add');
  assert.equal(r.ok, false);
  assert.equal(r.code, CODES.TYPE_MISMATCH);
});

test('timeline_logs add: 缺 content 被拦（必填缺失）', () => {
  const r = validateRecord('timeline_logs', { date: '2026-08-13', hour: 14 }, 'add');
  assert.equal(r.ok, false);
  assert.equal(r.code, CODES.MISSING_REQUIRED);
});

test('timeline_logs add: hour 越界被拦', () => {
  const r = validateRecord('timeline_logs', { date: '2026-08-13', hour: 25, content: 'x' }, 'add');
  assert.equal(r.ok, false);
  assert.equal(r.code, CODES.VALUE_OUT_OF_RANGE);
});

test('weight_records add: weight 非数字被拦', () => {
  const r = validateRecord('weight_records', { weight: '70' }, 'add');
  assert.equal(r.ok, false);
  assert.equal(r.code, CODES.TYPE_MISMATCH);
});

test('put 模式：部分更新不查必填（只查传入字段类型）', () => {
  const r = validateRecord('timeline_logs', { content: '只改内容' }, 'put');
  assert.equal(r.ok, true);
});

test('put 模式：传了类型错的字段仍被拦', () => {
  const r = validateRecord('weight_records', { weight: 'abc' }, 'put');
  assert.equal(r.ok, false);
});

test('无专门规则的 store：对象即过（不卡正常功能）', () => {
  const r = validateRecord('thoughts', { ts: 123, text: 'hi' }, 'add');
  assert.equal(r.ok, true);
});

test('非对象输入被拦', () => {
  const r = validateRecord('tasks', null, 'add');
  assert.equal(r.ok, false);
  assert.equal(r.code, CODES.INVALID_INPUT);
});

test('DBError 携带明确 code', () => {
  const e = new DBError(CODES.TYPE_MISMATCH, 'msg');
  assert.equal(e.code, CODES.TYPE_MISMATCH);
  assert.equal(e.name, 'DBError');
});
