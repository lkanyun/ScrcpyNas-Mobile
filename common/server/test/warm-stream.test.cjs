// Modified in the Mobile Remote derivative (2026): mobile UI, media transport or recovery changes; see MODIFICATIONS.md.
'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const { once } = require('node:events')
const { WebSocket, WebSocketServer } = require('ws')
const { setTimeout: delay } = require('node:timers/promises')

// 建立仅监听回环的真实协议夹具，不调用 ADB 或生产服务
async function fixture(t, timeoutMs = 100) {
  const { createWarmScrcpyUpgradeProxy } = require('../lib/warm-stream')
  const upstream = http.createServer()
  const device = new WebSocketServer({ server: upstream })
  let connections = 0
  const remotes = []
  device.on('connection', socket => {
    connections++
    remotes.push(socket)
    socket.send(Buffer.from('scrcpy_initial:test-only'))
    socket.on('message', data => socket.send(data))
  })
  upstream.listen(0, '127.0.0.1')
  await once(upstream, 'listening')
  const relay = createWarmScrcpyUpgradeProxy({
    wsScrcpyHost: '127.0.0.1', wsScrcpyPort: upstream.address().port,
    buildProxyPath: url => url.replace('/scrcpy/', '/'), timeoutMs,
    fallback: (_req, socket) => socket.destroy(),
  })
  const server = http.createServer()
  // 鉴权在温会话代理之前执行，模拟现有外层认证边界
  server.on('upgrade', (req, socket, head) => {
    if (!['test-a', 'test-b'].includes(req.headers.cookie)) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
      return
    }
    relay(req, socket, head)
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(async () => {
    relay.close()
    for (const socket of device.clients) socket.terminate()
    await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => device.close(() => upstream.close(resolve)))])
    assert.equal(server.listening, false)
    assert.equal(upstream.listening, false)
  })
  // 每个客户端使用相同的标签页令牌与测试身份
  function connect(cookie = 'test-a', token = '0123456789abcdef0123456789abcdef') {
    return new WebSocket(`ws://127.0.0.1:${server.address().port}/scrcpy/?action=proxy-adb&remote=tcp%3A8886&udid=test-only&warmSession=${token}`, { headers: { cookie } })
  }
  return { connect, relay, remotes, connections: () => connections }
}

// 缩短超时验证断开期间仍保留原上游且接管后重放初始化而不重开视频连接
 test('warm stream reuses one upstream and expires after the last browser leaves', async t => {
  const f = await fixture(t)
  let browser = f.connect()
  const [initial] = await once(browser, 'message')
  assert.equal(initial.toString(), 'scrcpy_initial:test-only')
  browser.close()
  await once(browser, 'close')
  await delay(25)
  assert.equal(f.remotes[0].readyState, WebSocket.OPEN)
  browser = f.connect()
  const [replayed] = await once(browser, 'message')
  assert.equal(replayed.toString(), initial.toString())
  assert.equal(f.connections(), 1)
  const response = once(browser, 'message')
  browser.send(Buffer.from([101, 1, 2, 3]))
  assert.deepEqual((await response)[0], Buffer.from([101, 1, 2, 3]))
  await delay(110)
  assert.equal(f.remotes[0].readyState, WebSocket.OPEN)
  const closed = once(f.remotes[0], 'close')
  browser.close()
  await once(browser, 'close')
  await closed
  assert.equal(f.remotes[0].readyState, WebSocket.CLOSED)
})

// 认证、标签页与设备范围共同隔离，未授权升级不能接触已保温连接
 test('warm sessions are scoped to authentication and cannot bypass the outer guard', async t => {
  const f = await fixture(t)
  const first = f.connect()
  await once(first, 'message')
  const second = f.connect('test-b')
  await once(second, 'message')
  assert.equal(f.connections(), 2)
  const denied = f.connect('not-authorized')
  const [error] = await once(denied, 'error')
  assert.match(error.message, /401/)
  assert.equal(f.connections(), 2)
})

// 退出需立即关闭活动与闲置连接，而不是等待温会话超时
 test('logout revocation closes only the matching authentication scope', async t => {
  const { revokeWarmStreams, WARM_STREAM_TIMEOUT_MS } = require('../lib/warm-stream')
  assert.equal(WARM_STREAM_TIMEOUT_MS, 600000)
  const f = await fixture(t)
  const first = f.connect()
  await once(first, 'message')
  const second = f.connect('test-b')
  await once(second, 'message')
  const closed = once(first, 'close')
  const upstreamClosed = once(f.remotes[0], 'close')
  revokeWarmStreams({ headers: { cookie: 'test-a' } })
  await Promise.all([closed, upstreamClosed])
  assert.equal(f.remotes[0].readyState, WebSocket.CLOSED)
  assert.equal(second.readyState, WebSocket.OPEN)
  assert.equal(f.remotes[1].readyState, WebSocket.OPEN)
})

// 后台媒体被丢弃，接管时仅重放固定上限的初始化信息
 test('detached media is dropped rather than recorded or replayed', async t => {
  const f = await fixture(t)
  const first = f.connect()
  await once(first, 'message')
  first.close()
  await once(first, 'close')
  await delay(10)
  for (let i = 0; i < 12; i++) f.remotes[0].send(Buffer.from('offline-frame-' + i))
  await delay(10)
  const second = f.connect()
  const messages = []
  second.on('message', data => messages.push(data.toString()))
  await once(second, 'message')
  await delay(10)
  assert.deepEqual(messages, ['scrcpy_initial:test-only'])
  assert.equal(f.connections(), 1)
})
