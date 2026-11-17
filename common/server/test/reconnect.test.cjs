// Modified in the Mobile Remote derivative (2026): mobile UI, media transport or recovery changes; see MODIFICATIONS.md.
'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

// 用可控页面时钟验证恢复决策，真实协议接管另由温会话测试覆盖
function boot(status = 200, stored = new Map()) {
  let now = 100000
  let reloads = 0
  let authCalls = 0
  let id = 0
  const timers = new Map()
  const sockets = []
  const document = new EventTarget()
  document.visibilityState = 'visible'
  const window = new EventTarget()
  window.location = { hash: '#!action=stream&udid=test-only', href: 'https://test.invalid/scrcpy/#!action=stream&udid=test-only', origin: 'https://test.invalid', reload: () => reloads++ }
  window.navigator = { onLine: true }
  window.sessionStorage = { getItem: key => stored.get(key) || null, setItem: (key, value) => stored.set(key, value), removeItem: key => stored.delete(key) }
  window.crypto = require('node:crypto').webcrypto
  // 浏览器原生套接字边界只模拟事件，脚本自身逻辑真实执行
  class Socket extends EventTarget {
    constructor(url) { super(); this.url = String(url); this.readyState = 0; sockets.push(this) }
    close() { this.readyState = 3; this.dispatchEvent(new Event('close')) }
  }
  Object.assign(Socket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 })
  window.WebSocket = Socket
  const DateClock = class extends Date { static now() { return now } }
  const context = vm.createContext({ window, document, location: window.location, navigator: window.navigator, URL, URLSearchParams, Date: DateClock, Uint8Array, Reflect, Object, Event, CustomEvent,
    setTimeout: (callback, ms) => { timers.set(++id, { callback, at: now + ms }); return id }, clearTimeout: key => timers.delete(key),
    fetch: async () => { authCalls++; return { status, ok: status === 200, redirected: false, json: async () => ({ ok: true }) } },
  })
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../public/reconnect.js'), 'utf8'), context)
  // 推进页面定时器并排空鉴权任务
  async function tick(ms) {
    now += ms
    for (const [key, timer] of [...timers]) if (timer.at <= now) { timers.delete(key); timer.callback() }
    for (let i = 0; i < 8; i++) await Promise.resolve()
  }
  return { window, document, sockets, tick, stored, reloads: () => reloads, authCalls: () => authCalls }
}

// 用户主动断开优先于恢复策略，不能在设备断开较慢时抢先重连
 test('manual disconnect suppresses pending recovery and failure can re-enable it', async () => {
  const f = boot()
  const socket = new f.window.WebSocket('wss://test.invalid/scrcpy/?action=proxy-adb&remote=tcp%3A8886&udid=test-only')
  socket.close()
  f.window.dispatchEvent(new Event('scrcpynas:disconnect'))
  await f.tick(10000)
  assert.equal(f.authCalls(), 0)
  assert.equal(f.reloads(), 0)
  f.window.dispatchEvent(new Event('scrcpynas:reconnect'))
  await f.tick(1000)
  assert.equal(f.reloads(), 1)
})

// 网络关闭后先重新认证，再原页重载，不调用破坏温会话的准备接口
 test('closed stream authenticates before a single automatic reload', async () => {
  const f = boot()
  const socket = new f.window.WebSocket('wss://test.invalid/scrcpy/?action=proxy-adb&remote=tcp%3A8886&udid=test-only')
  const token = new URL(socket.url).searchParams.get('warmSession')
  assert.match(token, /^[a-f0-9]{32}$/)
  socket.close()
  await f.tick(1000)
  assert.equal(f.authCalls(), 1)
  assert.equal(f.reloads(), 1)
  f.window.dispatchEvent(new Event('online'))
  await f.tick(1000)
  assert.equal(f.reloads(), 1)
  const next = boot(200, f.stored)
  const resumed = new next.window.WebSocket('wss://test.invalid/scrcpy/?action=proxy-adb&remote=tcp%3A8886&udid=test-only')
  assert.equal(new URL(resumed.url).searchParams.get('warmSession'), token)
})

// Safari 前后台切换后可能仍报告 OPEN，但旧连接早已不再传输
 test('foreground recovery replaces a stale OPEN socket but preserves a healthy stream', async () => {
  const f = boot()
  const socket = new f.window.WebSocket('wss://test.invalid/scrcpy/?action=proxy-adb&remote=tcp%3A8886&udid=test-only')
  socket.readyState = 1
  socket.dispatchEvent(new Event('open'))
  f.document.visibilityState = 'hidden'
  f.document.dispatchEvent(new Event('visibilitychange'))
  await f.tick(20000)
  assert.equal(f.reloads(), 0)
  f.document.visibilityState = 'visible'
  f.document.dispatchEvent(new Event('visibilitychange'))
  await f.tick(3000)
  assert.equal(f.reloads(), 1)

  const healthy = boot()
  const active = new healthy.window.WebSocket('wss://test.invalid/scrcpy/?action=proxy-adb&remote=tcp%3A8886&udid=test-only')
  active.readyState = 1
  active.dispatchEvent(new Event('open'))
  // 页面未收到隐藏事件时仍以恢复后的实际流量判断连接存活
  healthy.document.visibilityState = 'hidden'
  await healthy.tick(20000)
  healthy.document.visibilityState = 'visible'
  healthy.document.dispatchEvent(new Event('visibilitychange'))
  active.dispatchEvent(new Event('message'))
  await healthy.tick(3000)
  assert.equal(healthy.reloads(), 0)
})

// 暂时服务不可用时自动退避重试，认证撤销则停止而非绕过登录
 test('temporary auth outage retries with backoff while logout remains blocked', async () => {
  const outage = boot(503)
  new outage.window.WebSocket('wss://test.invalid/scrcpy/?action=proxy-adb&remote=tcp%3A8886&udid=test-only').close()
  await outage.tick(1000)
  assert.equal(outage.authCalls(), 1)
  await outage.tick(5000)
  assert.equal(outage.authCalls(), 2)
  assert.equal(outage.reloads(), 0)
  for (const status of [401, 403]) {
    const denied = boot(status)
    new denied.window.WebSocket('wss://test.invalid/scrcpy/?action=proxy-adb&remote=tcp%3A8886&udid=test-only').close()
    await denied.tick(1000)
    denied.window.dispatchEvent(new Event('focus'))
    await denied.tick(60000)
    assert.equal(denied.reloads(), 0)
    assert.equal(denied.authCalls(), 1)
  }
})

// 非投屏或跨源连接不能附加内部令牌与自动重载策略
 test('unrelated WebSockets remain native and do not trigger reload', async () => {
  const f = boot()
  const foreign = 'wss://other.invalid/scrcpy/?action=proxy-adb&remote=tcp%3A8886&udid=test-only'
  const other = new f.window.WebSocket(foreign)
  assert.equal(other.url, foreign)
  other.close()
  await f.tick(10000)
  assert.equal(f.authCalls(), 0)
  assert.equal(f.reloads(), 0)
})

// 隐藏不会主动关闭连接，仅在返回后确认连接已失效才恢复
 test('background preserves the browser socket and recovers a stale stream on return', async () => {
  const f = boot()
  const socket = new f.window.WebSocket('wss://test.invalid/scrcpy/?action=proxy-adb&remote=tcp%3A8886&udid=test-only')
  socket.readyState = 1
  f.document.visibilityState = 'hidden'
  f.document.dispatchEvent(new Event('visibilitychange'))
  assert.equal(socket.readyState, 1)
  await f.tick(20000)
  assert.equal(f.authCalls(), 0)
  f.document.visibilityState = 'visible'
  f.document.dispatchEvent(new Event('visibilitychange'))
  await f.tick(1000)
  assert.equal(f.reloads(), 1)
})

// 重载与网络数据不能清空退避次数，只有稳定解码才能重置
 test('reload preserves retry backoff until decoded playback is stable', async () => {
  const first = boot()
  new first.window.WebSocket('wss://test.invalid/scrcpy/?action=proxy-adb&remote=tcp%3A8886&udid=test-only').close()
  await first.tick(1000)
  const next = boot(200, first.stored)
  new next.window.WebSocket('wss://test.invalid/scrcpy/?action=proxy-adb&remote=tcp%3A8886&udid=test-only').close()
  await next.tick(1000)
  assert.equal(next.authCalls(), 0)
  await next.tick(1000)
  assert.equal(next.reloads(), 1)
  const stable = boot(200, next.stored)
  const socket = new stable.window.WebSocket('wss://test.invalid/scrcpy/?action=proxy-adb&remote=tcp%3A8886&udid=test-only')
  await stable.tick(16000)
  socket.dispatchEvent(new Event('message'))
  stable.window.dispatchEvent(new Event('scrcpynas:decoded-stable'))
  socket.close()
  await stable.tick(1000)
  assert.equal(stable.reloads(), 1)
})
