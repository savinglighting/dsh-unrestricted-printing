/**
 * gateway/test/num.test.mjs — 数值归一（本项目踩过三次的坑，单独钉住）
 *
 * 关键断言：`0` 是**合法值**必须保留，而 `null / '' / 布尔 / 数组` 是"没给值"必须回落默认。
 */

'use strict'

import test from 'node:test'
import assert from 'node:assert/strict'
import { numOr, intOr, clamp } from '../lib/num.js'

test('numOr：0 是合法值；null / 空串 / 布尔 / 数组 一律回落默认', () => {
  assert.equal(numOr(0), 0, 'Number(null) === 0 的老坑：显式 0 不能被当成"没给值"')
  assert.equal(numOr(0, 500), 0)
  assert.equal(numOr(null, 500), 500)
  assert.equal(numOr(undefined, 500), 500)
  assert.equal(numOr('', 500), 500)
  assert.equal(numOr('   ', 500), 500)
  assert.equal(numOr(true, 500), 500)
  assert.equal(numOr(false, 500), 500)
  assert.equal(numOr([], 500), 500)
  assert.equal(numOr([3], 500), 500)
})

test('numOr：可解析字符串与数字正常转换，不可解析回落', () => {
  assert.equal(numOr('12'), 12)
  assert.equal(numOr(' 4.5 '), 4.5)
  assert.equal(numOr(7.25), 7.25)
  assert.equal(numOr('abc', -1), -1)
  assert.equal(numOr(NaN, -1), -1)
  assert.equal(numOr(Infinity, -1), -1, 'Infinity 不是可用参数')
  assert.equal(numOr(undefined), null, '默认回落值是 null')
})

test('intOr：整数化（四舍五入），不可解析回落', () => {
  assert.equal(intOr('12.6'), 13)
  assert.equal(intOr(11.4), 11)
  assert.equal(intOr(null, 8), 8)
  assert.equal(intOr('x', 8), 8)
})

test('clamp：区间夹取，不可解析返回 null（不猜）', () => {
  assert.equal(clamp(32, 4, 12), 12)
  assert.equal(clamp(1, 4, 12), 4)
  assert.equal(clamp(8, 4, 12), 8)
  assert.equal(clamp(null, 4, 12), null)
  assert.equal(clamp('', 4, 12), null)
  assert.equal(clamp(5, null, null), 5, '无界时原样返回')
  assert.equal(clamp(0, 0, 10), 0)
})