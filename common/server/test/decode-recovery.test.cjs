// Modified in the Mobile Remote derivative (2026): mobile UI, media transport or recovery changes; see MODIFICATIONS.md.
'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

// 在浏览器边界用可控时钟执行真实恢复脚本，跨文档共用标签页存储
function boot(stored = new Map(), status = 200, authGate) {
  let now = 100000
  let reloads = 0
  let authCalls = 0
  const timers = new Map()
  let id = 0
  const document = new EventTarget()
  document.visibilityState = 'visible'
  const window = new EventTarget()
  window.location = { hash: '#!action=stream&udid=test-only', href: 'https://test.invalid/scrcpy/#!action=stream&udid=test-only', reload: () => reloads++ }
  window.navigator = { onLine: true }
  window.sessionStorage = { getItem: key => stored.get(key) || null, setItem: (key, value) => stored.set(key, value), removeItem: key => stored.delete(key) }
  window.crypto = require('node:crypto').webcrypto
  // 流量不能代替解码成功证据
  class Socket extends EventTarget {
    constructor(url) { super(); this.url = String(url); this.readyState = 1 }
    close() { this.readyState = 3; this.dispatchEvent(new Event('close')) }
  }
  Object.assign(Socket, { CLOSING: 2 })
  window.WebSocket = Socket
  const context = vm.createContext({ window, document, Event, URL, URLSearchParams, Uint8Array, Date: class extends Date { static now() { return now } },
    setTimeout: (callback, ms) => { timers.set(++id, { callback, at: now + ms }); return id }, clearTimeout: key => timers.delete(key),
    fetch: async () => { authCalls++; if (authGate) await authGate; return { status, ok: status === 200, json: async () => ({ ok: true }) } },
  })
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../public/reconnect.js'), 'utf8'), context)
  // 推进鉴权和恢复定时器
  async function tick(ms = 1000) {
    now += ms
    for (const [key, timer] of [...timers]) if (timer.at <= now) { timers.delete(key); timer.callback() }
    for (let i = 0; i < 12; i++) await Promise.resolve()
  }
  return { window, document, stored, tick, reloads: () => reloads, authCalls: () => authCalls,
    decode: () => window.dispatchEvent(new Event('scrcpynas:decode-error')) }
}

// E3 冷恢复先鉴权且只清当前设备令牌，跨重载预算阻止持续坏流循环
 test('decode error authenticates once and cold reloads with a persisted one-shot budget', async () => {
  const stored = new Map([['scrcpyNas.warm.other', 'other-token']])
  const f = boot(stored)
  const oldToken = stored.get('scrcpyNas.warm.test-only')
  let recovering = 0
  f.window.addEventListener('scrcpynas:recovering', () => recovering++)
  f.decode()
  await f.tick()
  assert.equal(recovering, 1)
  assert.equal(f.authCalls(), 1)
  assert.equal(f.reloads(), 1)
  assert.equal(stored.has('scrcpyNas.warm.test-only'), false)
  assert.equal(stored.get('scrcpyNas.warm.other'), 'other-token')
  const next = boot(stored)
  assert.notEqual(stored.get('scrcpyNas.warm.test-only'), oldToken)
  next.decode()
  await next.tick(60000)
  assert.equal(next.authCalls(), 0)
  assert.equal(next.reloads(), 0)
})

// 仅收到网络数据不能解锁预算，解码稳定事件才允许下次故障恢复
 test('only stable decoded playback resets the cold-recovery budget', async () => {
  const f = boot()
  f.decode()
  await f.tick()
  const next = boot(f.stored)
  const socket = new next.window.WebSocket('wss://test.invalid/scrcpy/?action=proxy-adb&remote=tcp%3A8886')
  await next.tick(20000)
  socket.dispatchEvent(new Event('message'))
  assert.equal(next.stored.get('scrcpyNas.warm.test-only.retry'), '1')
  next.window.dispatchEvent(new Event('scrcpynas:decoded-stable'))
  assert.equal(next.stored.has('scrcpyNas.warm.test-only.decodeRetry'), false)
  next.decode()
  await next.tick()
  assert.equal(next.reloads(), 1)
})

// 后台与主动退出均暂停恢复，鉴权拒绝不能清令牌或刷新
 test('decode recovery respects visibility, explicit exit and auth denial', async () => {
  for (const status of [401, 403]) {
    const f = boot(new Map(), status)
    const token = f.stored.get('scrcpyNas.warm.test-only')
    let denied = 0
    f.window.addEventListener('scrcpynas:auth-denied', () => denied++)
    f.decode()
    await f.tick()
    assert.equal(denied, 1)
    f.window.dispatchEvent(new Event('scrcpynas:reconnect'))
    await f.tick(60000)
    assert.equal(f.authCalls(), 1)
    assert.equal(f.reloads(), 0)
    assert.equal(f.stored.get('scrcpyNas.warm.test-only'), token)
  }
  const hidden = boot()
  hidden.document.visibilityState = 'hidden'
  hidden.decode()
  await hidden.tick(60000)
  assert.equal(hidden.authCalls(), 0)
  hidden.document.visibilityState = 'visible'
  hidden.document.dispatchEvent(new Event('visibilitychange'))
  await hidden.tick()
  assert.equal(hidden.reloads(), 1)
  const exited = boot()
  exited.decode()
  exited.window.dispatchEvent(new Event('scrcpynas:disconnect'))
  await exited.tick(60000)
  assert.equal(exited.authCalls(), 0)
})

// 异步鉴权返回后再次检查生命周期，避免切后台或退出时竞态刷新
 test('in-flight decode authentication cannot reload a hidden or exited document', async () => {
  for (const action of ['hidden', 'exit']) {
    let release
    const f = boot(new Map(), 200, new Promise(resolve => { release = resolve }))
    const token = f.stored.get('scrcpyNas.warm.test-only')
    f.decode()
    await f.tick()
    assert.equal(f.authCalls(), 1)
    if (action === 'hidden') f.document.visibilityState = 'hidden'
    else f.window.dispatchEvent(new Event('scrcpynas:disconnect'))
    release()
    await f.tick()
    assert.equal(f.reloads(), 0)
    assert.equal(f.stored.get('scrcpyNas.warm.test-only'), token)
  }
})

// 不能持久化预算时失败关闭，不允许跨文档无限自动冷连接
 test('unavailable session storage leaves decode recovery manual', async () => {
  const f = boot()
  f.window.sessionStorage.setItem = () => { throw new Error('storage unavailable') }
  f.decode()
  await f.tick()
  await f.tick(60000)
  assert.equal(f.authCalls(), 1)
  assert.equal(f.reloads(), 0)
  assert.ok(f.stored.get('scrcpyNas.warm.test-only'))
})

// 持续坏流量及重复错误不应取消冷恢复或并发创建多个刷新
 test('stream traffic does not cancel a scheduled decode recovery', async () => {
  const f = boot()
  const socket = new f.window.WebSocket('wss://test.invalid/scrcpy/?action=proxy-adb&remote=tcp%3A8886')
  f.decode()
  socket.dispatchEvent(new Event('message'))
  f.decode()
  await f.tick()
  assert.equal(f.reloads(), 1)
  assert.equal(f.authCalls(), 1)
})
