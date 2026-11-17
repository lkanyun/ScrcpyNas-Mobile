// Modified in the Mobile Remote derivative (2026): mobile UI, media transport or recovery changes; see MODIFICATIONS.md.
'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { patchLowLatency } = require('../lib/engine-low-latency')

// 原生路径的可用性不能被无关的 MSE 能力状态强行关闭
 test('native WebCodecs capability remains independent of MSE support', () => {
  const window = { scrcpyMediaBoot: { mode: 'unsupported' }, addEventListener() {}, dispatchEvent() {} }
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../public/low-latency.js'), 'utf8'), {
    window, location: { hash: '#!action=stream&udid=fixture' }, URLSearchParams,
    localStorage: { getItem: () => 'true' }, isSecureContext: true,
    VideoDecoder: class { static isConfigSupported() {} }, EncodedVideoChunk: class {}, Event
  })
  assert.equal(window.scrcpyNasLowLatency.capable, true)
 })

// 用实际引擎锚点验证补丁幂等，未知或重复入口不能被半修补
 test('low-latency engine hook is unique idempotent and retains native default construction', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../../engine/public/bundle.js'), 'utf8')
  const fixed = patchLowLatency(source)
  assert.equal(patchLowLatency(fixed), fixed)
  assert.throws(() => patchLowLatency(source + source), /anchor/)
  assert.throws(() => patchLowLatency(source.replace('this.player=i,this.setTouchListeners(i)', 'unknown')), /anchor/)
  const factory = fixed.match(/t\.createPlayer=(function\(e,t,n\)\{.+?\}),t\.getFitToScreen=/)[1]
  const playerClass = class { constructor(udid, display) { Object.assign(this, { udid, display }) } }
  const create = vm.runInNewContext('(' + factory + ')', { r: {}, window: {} })
  const native = create.call({ getPlayerClass: () => playerClass }, 'mse', 'fixture', 3)
  assert.equal(native.udid, 'fixture')
  assert.equal(native.display, 3)
})
