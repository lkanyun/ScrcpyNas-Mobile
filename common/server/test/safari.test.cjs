// Modified in the Mobile Remote derivative (2026): mobile UI, media transport or recovery changes; see MODIFICATIONS.md.
'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const vm = require('node:vm')
const fs = require('node:fs')
const path = require('node:path')

// 以隔离 DOM 夹具验证启动前媒体接口适配，不模拟真实视频解码
function boot(native, managed) {
  const document = { readyState: 'loading', createElement: name => ({ tagName: name.toUpperCase(), setAttribute() {} }), addEventListener() {} }
  const window = { MediaSource: native, ManagedMediaSource: managed, addEventListener() {}, location: { hash: '#!action=stream' } }
  const context = vm.createContext({ window, document, location: window.location, URLSearchParams, setTimeout, clearTimeout })
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../public/safari-media.js'), 'utf8'), context)
  return { window, document }
}

// iPhone 只暴露托管媒体接口时必须在引擎注册播放器前提供兼容入口
 test('managed-only browser registers old engine MSE player and configures inline video', () => {
  function Managed() {}
  Managed.isTypeSupported = () => true
  const { window, document } = boot(undefined, Managed)
  assert.equal(window.MediaSource, Managed)
  const video = document.createElement('video')
  assert.equal(video.playsInline, true)
  assert.equal(video.disableRemotePlayback, true)
  assert.equal(video.muted, true)
  assert.equal(document.createElement('canvas').playsInline, undefined)
})

// 已可播放的浏览器必须保留原媒体实现
 test('supported native MSE is never replaced', () => {
  function Native() {}
  Native.isTypeSupported = () => true
  function Managed() {}
  Managed.isTypeSupported = () => true
  const { window } = boot(Native, Managed)
  assert.equal(window.MediaSource, Native)
})
