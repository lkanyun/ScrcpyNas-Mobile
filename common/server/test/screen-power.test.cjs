// Modified in the Mobile Remote derivative (2026): mobile UI, media transport or recovery changes; see MODIFICATIONS.md.
'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const http = require('node:http')
const { once } = require('node:events')
const { WebSocket, WebSocketServer } = require('ws')
const { setTimeout: delay } = require('node:timers/promises')

// 以真实回环协议代替手机，不启动采集或使用生产端口
async function fixture(t, timeoutMs = 100, initial = true) {
  const { createWarmScrcpyUpgradeProxy } = require('../lib/warm-stream')
  const upstream = http.createServer((req, res) => {
    const bundle = req.url.split('?')[0] === '/bundle.js'
    res.setHeader('Content-Type', bundle ? 'application/javascript' : 'text/html')
    res.end(bundle ? fs.readFileSync(path.resolve(__dirname, '../../engine/public/bundle.js')) : '<head><script defer="defer" src="bundle.js"></script></head><body></body>')
  })
  const device = new WebSocketServer({ server: upstream })
  const received = []
  const remotes = []
  device.on('connection', socket => {
    remotes.push(socket)
    if (initial) socket.send(Buffer.from('scrcpy_initial:test-only'))
    socket.on('message', data => received.push([...data]))
  })
  upstream.listen(0, '127.0.0.1')
  await once(upstream, 'listening')
  const relay = createWarmScrcpyUpgradeProxy({ buildProxyPath: value => value.replace(/^\/scrcpy/, ''), wsScrcpyHost: '127.0.0.1', wsScrcpyPort: upstream.address().port, timeoutMs, fallback: (_req, socket) => socket.destroy() })
  const express = require('../../engine/node_modules/express')
  const app = express()
  app.use(express.json())
  const { registerScrcpyProxyRoutes } = require('../lib/scrcpy-proxy')
  registerScrcpyProxyRoutes(app, { appPath: value => value, routeBases: [''], escapeRegExp: value => value, wsScrcpyHost: '127.0.0.1', wsScrcpyPort: upstream.address().port, buildProxyPath: value => value.replace(/^\/scrcpy/, '') })
  const server = http.createServer(app)
  server.on('upgrade', relay)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(async () => {
    relay.close()
    for (const socket of device.clients) socket.terminate()
    await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => device.close(() => upstream.close(resolve)))])
    assert.equal(server.listening, false)
    assert.equal(upstream.listening, false)
  })
  // 独立令牌模拟同一认证范围内不同控制标签页
  async function connect(token = 'a'.repeat(32), lease = 'c'.repeat(32)) {
    const socket = new WebSocket(`ws://127.0.0.1:${server.address().port}/?action=proxy-adb&remote=tcp%3A8886&udid=fixture&warmSession=${token}&screenLease=${lease}`, { headers: { cookie: 'test-only' } })
    await once(socket, initial ? 'message' : 'open')
    return socket
  }
  // 退出接口只能释放当前身份和当前页面租约，不能透传任何设备命令
  function release(body = {}, headers = {}) {
    const origin = 'http://127.0.0.1:' + server.address().port
    return fetch(origin + '/api/screen-power/release', { method: 'POST', signal: AbortSignal.timeout(4000), headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: 'test-only', ...headers }, body: JSON.stringify({ token: 'a'.repeat(32), lease: 'c'.repeat(32), serial: 'fixture', ...body }) })
  }
  const origin = 'http://127.0.0.1:' + server.address().port
  return { connect, release, received, remotes, origin, socketUrl: origin.replace('http:', 'ws:') + '/?action=proxy-adb&remote=tcp%3A8886&udid=fixture&warmSession=' + 'a'.repeat(32) }
}

// 从实际引擎取出原生序列化器，验证修复只影响屏幕电源参数
function serializer(source) {
  const match = source.match(/t\.createSetScreenPowerModeCommand=function\(e\)\{[^}]+\}/g)
  assert.equal(match.length, 1)
  const context = { Buffer, result: null }
  vm.runInNewContext(`var n=Buffer,a={ControlMessage:{TYPE_SET_SCREEN_POWER_MODE:10}};function t(type){this.type=type};${match[0]};result=t.createSetScreenPowerModeCommand`, context)
  return context.result
}

// 安卓面板正常模式必须为原生 NORMAL，不能发送旧布尔值代表的 DOZE
 test('native serializer uses verified OFF 0 and NORMAL 2 and patches idempotently', () => {
  const { patchScreenPower } = require('../lib/screen-power')
  const original = fs.readFileSync(path.resolve(__dirname, '../../engine/public/bundle.js'), 'utf8')
  const patched = patchScreenPower(original)
  assert.deepEqual([...serializer(patched)(false).buffer], [10, 0])
  assert.deepEqual([...serializer(patched)(true).buffer], [10, 2])
  assert.equal(patchScreenPower(patched), patched)
  assert.throws(() => patchScreenPower('unknown engine'), /screen power/)
  assert.throws(() => patchScreenPower(original + original), /screen power/)
})

// 验证浏览器实际收到的代理资源，而不只验证独立的补丁函数
 test('proxy delivers patched native modes and installs screen observer before engine initialization', async t => {
  const f = await fixture(t)
  const bundle = await (await fetch(f.origin + '/scrcpy/bundle.js')).text()
  assert.deepEqual([...serializer(bundle)(true).buffer], [10, 2])
  const html = await (await fetch(f.origin + '/scrcpy/')).text()
  assert.ok(html.includes('src="../screen-power.js"'))
  assert.ok(html.indexOf('src="../screen-power.js"') < html.indexOf('src="bundle.js"'))
  assert.ok(html.includes('src="../reconnect.js"'))
  assert.ok(html.includes('src="../mobile.js"'))
})

// 任一控制者要求黑屏时，其他标签页不能抢先点亮共享物理面板
 test('screen power intents aggregate per device without tabs fighting', async t => {
  const f = await fixture(t)
  const first = await f.connect()
  first.send(Buffer.from([10, 0]))
  await delay(15)
  const second = await f.connect('b'.repeat(32))
  second.send(Buffer.from([10, 0]))
  await delay(15)
  first.send(Buffer.from([10, 2]))
  await delay(15)
  assert.deepEqual(f.received, [[10, 0]])
  second.send(Buffer.from([10, 2]))
  await delay(15)
  assert.deepEqual(f.received, [[10, 0], [10, 2]])
})

// 只有真实初始化后的明确 OFF 或 NORMAL 才可通过，不排队未知或早到的面板命令
 test('relay drops uninitialized and malformed screen power packets without queuing', async t => {
  const f = await fixture(t, 500, false)
  const browser = await f.connect()
  browser.send(Buffer.from([10, 0]))
  await delay(30)
  assert.deepEqual(f.received, [])
  f.remotes[0].send(Buffer.from('scrcpy_initial:test-only'))
  await once(browser, 'message')
  browser.send(Buffer.from([10, 1]))
  browser.send(Buffer.from([10, 2, 0]))
  browser.send(Buffer.from([10]))
  await delay(15)
  assert.deepEqual(f.received, [])
  browser.send(Buffer.from([10, 0]))
  await delay(15)
  assert.deepEqual(f.received, [[10, 0]])
})

// 后台短暂保温保持黑屏，最后控制者到期时在原通道恢复面板而不重开采集
 test('warm detach retains off and expiry restores NORMAL on the original upstream', async t => {
  const f = await fixture(t, 70)
  const browser = await f.connect()
  browser.send(Buffer.from([10, 0]))
  await delay(15)
  browser.close()
  await once(browser, 'close')
  await delay(25)
  assert.deepEqual(f.received, [[10, 0]])
  await delay(100)
  assert.deepEqual(f.received, [[10, 0], [10, 2]])
  assert.equal(f.remotes.length, 1)
})

// 明确退出恢复面板但保留原投屏与 ADB，延迟到达的旧页面退出不能覆盖新页面
 test('explicit release is identity and lease scoped and never opens a device channel', async t => {
  const f = await fixture(t, 500)
  const old = await f.connect()
  old.send(Buffer.from([10, 0]))
  await delay(15)
  old.close()
  await once(old, 'close')
  const current = await f.connect('a'.repeat(32), 'd'.repeat(32))
  assert.equal((await f.release()).status, 409)
  assert.equal((await f.release({ lease: 'd'.repeat(32) }, { Origin: 'http://evil.invalid' })).status, 403)
  assert.equal((await f.release({ lease: 'd'.repeat(32) }, { Cookie: 'other' })).status, 404)
  assert.equal((await f.release({ lease: 'd'.repeat(32), command: 'shell' })).status, 400)
  assert.equal((await f.release({ token: ['a'.repeat(32)], lease: 'd'.repeat(32) })).status, 400)
  assert.equal((await f.release({ lease: ['d'.repeat(32)] })).status, 400)
  assert.deepEqual(f.received, [[10, 0]])
  current.close()
  await once(current, 'close')
  const response = await f.release({ lease: 'd'.repeat(32) })
  assert.equal(response.status, 200)
  assert.equal((await response.json()).submitted, true)
  await delay(15)
  assert.deepEqual(f.received, [[10, 0], [10, 2]])
  assert.equal(f.remotes.length, 1)
  assert.equal(f.remotes[0].readyState, WebSocket.OPEN)
})

// 设备通道已丢失时不能用成功响应冒充面板已经恢复
 test('missing device transport reports failure rather than fake restoration', async t => {
  const warnings = []
  t.mock.method(console, 'warn', message => warnings.push(message))
  const f = await fixture(t, 500)
  const browser = await f.connect()
  browser.send(Buffer.from([10, 0]))
  await delay(15)
  f.remotes[0].terminate()
  await once(browser, 'close')
  assert.notEqual((await f.release()).status, 200)
  assert.notEqual((await f.release()).status, 200)
  assert.equal(f.remotes.length, 1)
  assert.ok(warnings.some(message => message.includes('state unconfirmed')))
})

// 恢复帧写失败必须保留待恢复状态，重复退出不能伪报成功
 test('failed NORMAL writes remain failures on repeated release', async t => {
  const f = await fixture(t, 500)
  const browser = await f.connect()
  browser.send(Buffer.from([10, 0]))
  await delay(15)
  const send = WebSocket.prototype.send
  t.mock.method(WebSocket.prototype, 'send', function (data, options, callback) {
    if (Buffer.isBuffer(data) && data.length === 2 && data[0] === 10 && data[1] === 2 && typeof callback === 'function') return process.nextTick(callback, new Error('fixture transport failure'))
    return send.call(this, data, options, callback)
  })
  assert.equal((await f.release()).status, 503)
  assert.equal((await f.release()).status, 503)
  t.mock.restoreAll()
})

// 同一退出的并发请求共享真实写结果，挂起写入必须有界失败而不是提前报成功
 test('concurrent releases wait for bounded NORMAL write failure', async t => {
  const f = await fixture(t, 5000)
  const browser = await f.connect()
  browser.send(Buffer.from([10, 0]))
  await delay(15)
  const send = WebSocket.prototype.send
  t.mock.method(WebSocket.prototype, 'send', function (data, options, callback) {
    if (Buffer.isBuffer(data) && data.length === 2 && data[0] === 10 && data[1] === 2 && typeof callback === 'function') return
    return send.call(this, data, options, callback)
  })
  const first = f.release().catch(() => ({ status: 599 }))
  await delay(20)
  const second = f.release()
  assert.equal((await second).status, 503)
  assert.equal((await first).status, 503)
  t.mock.restoreAll()
})

// 退出后旧页面已经排队的 OFF 不能重新夺取租约
 test('released document cannot reapply off but a new page lease can', async t => {
  const f = await fixture(t, 500)
  const old = await f.connect()
  old.send(Buffer.from([10, 0]))
  await delay(15)
  assert.equal((await f.release()).status, 200)
  old.send(Buffer.from([10, 0]))
  await delay(15)
  assert.deepEqual(f.received, [[10, 0], [10, 2]])
  const next = await f.connect('a'.repeat(32), 'e'.repeat(32))
  next.send(Buffer.from([10, 0]))
  await delay(15)
  assert.deepEqual(f.received, [[10, 0], [10, 2], [10, 0]])
})

// 创建真实浏览器与原生序列化器夹具，只使用回环测试通道
async function browserFixture(t, saved) {
  const { chromium } = require('playwright')
  const f = await fixture(t, 2000)
  const browser = await chromium.launch({ args: ['--no-sandbox'] })
  t.after(() => browser.close())
  const context = await browser.newContext({ permissions: ['local-network-access'] })
  await context.addCookies([{ name: 'fixture', value: 'test-only', url: f.origin }])
  const page = await context.newPage()
  const browserErrors = []
  page.on('console', message => { if (message.type() === 'error') browserErrors.push(message.text()) })
  page.on('pageerror', error => browserErrors.push(error.message))
  await page.route(f.origin + '/fixture', route => route.fulfill({ body: '<body><section id="media-panel"></section><div class="more-box"><p><input type="checkbox" id="screen_power_mode_fixture"><button id="native-power">Set screen power mode OFF</button></p></div></body>', contentType: 'text/html' }))
  await page.goto(f.origin + '/fixture#!action=stream&udid=fixture')
  const script = path.resolve(__dirname, '../public/screen-power.js')
  assert.ok(fs.existsSync(script), 'screen power extension must exist')
  if (saved !== undefined) await page.evaluate(value => localStorage.setItem('scrcpyNas.screenOff.fixture', String(value)), saved)
  await page.addScriptTag({ path: script })
  const { patchScreenPower } = require('../lib/screen-power')
  const engine = patchScreenPower(fs.readFileSync(path.resolve(__dirname, '../../engine/public/bundle.js'), 'utf8'))
  const native = engine.match(/t\.createSetScreenPowerModeCommand=function\(e\)\{[^}]+\}/)[0]
  // 模拟原生控件持有已建通道，序列化命令仍取自实际引擎
  async function start() {
  await page.evaluate(({ url, native }) => {
    window.socket = new WebSocket(url)
    // 最小缓冲区适配仅供原生引擎序列化器执行，不重写消息协议
    const n = { alloc(size) { const bytes = new Uint8Array(size); bytes.writeInt8 = bytes.writeUInt8 = function (value, offset) { this[offset] = value; return offset + 1 }; return bytes } }
    const a = { ControlMessage: { TYPE_SET_SCREEN_POWER_MODE: 10 } }
    const t = function (type) { this.type = type }
    eval(native)
    const input = document.querySelector('[id^="screen_power_mode_"]')
    document.querySelector('#native-power').onclick = () => socket.send(t.createSetScreenPowerModeCommand(input.checked).buffer)
  }, { url: f.socketUrl, native })
  await page.waitForFunction(() => window.socket.readyState === WebSocket.OPEN, null, { timeout: 3000 }).catch(async error => { throw new Error(error.message + JSON.stringify({ state: await page.evaluate(() => ({ url: socket.url, state: socket.readyState, open: WebSocket.OPEN })), remotes: f.remotes.length, browserErrors })) })
  await delay(30)
  }
  return { f, page, start, browserErrors }
}

// 真实浏览器复用提取的原生序列化器，未连或未解码不执行
 test('browser defaults off only after decoded connection and remembers immediate native toggles', async t => {
  const { f, page, start } = await browserFixture(t)
  assert.equal(await page.locator('#media-screen-off').isChecked(), true)
  await page.evaluate(() => window.dispatchEvent(new Event('scrcpynas:decoded-stable')))
  assert.deepEqual(f.received, [])
  await start()
  assert.deepEqual(f.received, [])
  await page.evaluate(() => window.dispatchEvent(new Event('scrcpynas:decoded-stable')))
  await delay(30)
  assert.deepEqual(f.received, [[10, 0]])
  await page.locator('#media-screen-off').uncheck()
  await delay(30)
  assert.deepEqual(f.received, [[10, 0], [10, 2]])
  assert.equal(await page.evaluate(() => localStorage.getItem('scrcpyNas.screenOff.fixture')), 'false')
  await page.locator('#media-screen-off').check()
  await delay(30)
  assert.deepEqual(f.received, [[10, 0], [10, 2], [10, 0]])
  await page.evaluate(() => window.dispatchEvent(new Event('scrcpynas:disconnect')))
  await delay(60)
  assert.deepEqual(f.received, [[10, 0], [10, 2], [10, 0], [10, 2]])
  assert.equal(f.remotes.length, 1)
  assert.match(await page.locator('#media-screen-status').innerText(), /提交|恢复/)
})

// 普通后台只保温，真正卸载即使文档已隐藏也必须释放，不能等到温会话到期
 test('browser hidden background retains off but non-recovery pagehide restores', async t => {
  const { f, page, start } = await browserFixture(t)
  await start()
  await page.evaluate(() => window.dispatchEvent(new Event('scrcpynas:decoded-stable')))
  await delay(30)
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await delay(30)
  assert.deepEqual(f.received, [[10, 0]])
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false })))
  await delay(60)
  assert.deepEqual(f.received, [[10, 0], [10, 2]])
})

// 真实媒体元素已有解码帧即可应用，不等待与恢复预算有关的长期稳定事件
 test('browser applies default after real video frames without waiting for recovery grace', async t => {
  const { f, page, start } = await browserFixture(t)
  await start()
  await page.evaluate(async () => {
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 64
    canvas.getContext('2d').fillRect(0, 0, 64, 64)
    const video = document.createElement('video')
    video.className = 'video-layer'
    video.muted = true
    video.srcObject = canvas.captureStream(10)
    document.body.append(video)
    window.frameTimer = setInterval(() => canvas.getContext('2d').fillRect(0, 0, 32, 32), 100)
    await video.play()
  })
  await page.waitForFunction(() => document.querySelector('video').currentTime > 0.2)
  await delay(100)
  assert.deepEqual(f.received, [[10, 0]])
})

// 读取设备独立保存值，关闭选项不会在初连时无故点亮原本休眠或锁定的面板
 test('saved disabled preference is loaded per device and no initial NORMAL is emitted', async t => {
  const { f, page, start } = await browserFixture(t, false)
  assert.equal(await page.locator('#media-screen-off').isChecked(), false)
  await start()
  await page.evaluate(() => window.dispatchEvent(new Event('scrcpynas:decoded-stable')))
  await delay(30)
  assert.deepEqual(f.received, [])
  await page.locator('#media-screen-off').check()
  await delay(30)
  assert.deepEqual(f.received, [[10, 0]])
  assert.equal(await page.evaluate(() => localStorage.getItem('scrcpyNas.screenOff.other-device')), null)
})

// 恢复重载不能先点亮再熄灭，显式退出仍可在隐藏通道上恢复
 test('recovery pagehide retains off and explicit exit still releases the current lease', async t => {
  const { f, page, start } = await browserFixture(t)
  await start()
  await page.evaluate(() => window.dispatchEvent(new Event('scrcpynas:decoded-stable')))
  await delay(30)
  await page.evaluate(() => {
    window.dispatchEvent(new Event('scrcpynas:recovering'))
    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false }))
  })
  await delay(30)
  assert.deepEqual(f.received, [[10, 0]])
  await page.evaluate(() => window.dispatchEvent(new Event('scrcpynas:disconnect')))
  await delay(60)
  assert.deepEqual(f.received, [[10, 0], [10, 2]])
})
