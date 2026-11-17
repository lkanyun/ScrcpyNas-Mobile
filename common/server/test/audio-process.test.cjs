// Modified in the Mobile Remote derivative (2026): mobile UI, media transport or recovery changes; see MODIFICATIONS.md.
'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const path = require('node:path')
const { fork } = require('node:child_process')
const { once } = require('node:events')
const WebSocket = require('ws')
const { createPhoneAudioProcess } = require('../lib/phone-audio-process')

// 等待实际 PCM 数据并从测试载荷读取采集进程身份
function pcm(client) {
  return new Promise((resolve, reject) => {
    // 跳过格式文本 只接受独立采集器产生的二进制帧
    function message(data, binary) {
      if (!binary) return
      client.off('message', message)
      client.off('error', reject)
      resolve(data)
    }
    client.on('message', message)
    client.once('error', reject)
  })
}

// 等待辅助进程的指定报告 避免依赖调度先后或固定睡眠
function report(child, type) {
  return new Promise(resolve => {
    // 忽略辅助进程的其他阶段通知
    function receive(message) {
      if (message.type !== type) return
      child.off('message', receive)
      resolve(message)
    }
    child.on('message', receive)
  })
}

// 真实跨进程套接字验证隔离 登录撤销 崩溃恢复与资源回收
test('audio socket survives a blocked parent, enforces sessions and recovers after worker exit', { timeout: 15000 }, async t => {
  const origin = 'https://fixture.example'
  const cookies = new Set(['fixture=first', 'fixture=second'])
  const server = http.createServer((req, res) => {
    res.writeHead(req.url === '/session/check' && cookies.has(req.headers.cookie) ? 204 : 401)
    res.end()
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = 'http://127.0.0.1:' + server.address().port
  const workerPath = path.join(__dirname, 'audio-process-fixture.cjs')
  const audio = createPhoneAudioProcess({ origin, sessionCheckUrl: base + '/session/check' }, { workerPath })
  server.on('upgrade', (req, socket, head) => { if (!audio.handleUpgrade(req, socket, head)) socket.destroy() })
  const clients = []
  let observer
  t.after(async () => {
    observer?.kill()
    for (const client of clients) client.terminate()
    const closed = server.listening ? new Promise(resolve => server.close(resolve)) : Promise.resolve()
    server.closeAllConnections()
    await audio.stop()
    await closed
  })
  // 建立测试连接并集中回收 真实升级仍经过独立进程认证
  function connect(cookie, source = origin) {
    const client = new WebSocket(base.replace('http:', 'ws:') + '/phone-audio', { origin: source, headers: { Cookie: cookie } })
    client.on('error', () => {})
    clients.push(client)
    return client
  }
  for (const [cookie, source] of [['', origin], ['fixture=first', 'https://untrusted.example']]) {
    const rejected = connect(cookie, source)
    const [error] = await once(rejected, 'error')
    assert.match(error.message, /403/)
  }
  const first = connect('fixture=first')
  const workerPid = (await pcm(first)).readUInt32BE()
  const second = connect('fixture=second')
  assert.equal((await pcm(second)).readUInt32BE(), workerPid)

  observer = fork(workerPath, ['observer'], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] })
  const streaming = report(observer, 'streaming')
  observer.send({ url: base.replace('http:', 'ws:') + '/phone-audio', origin, cookie: 'fixture=first' })
  await streaming
  const start = Date.now()
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 350)
  const end = Date.now()
  const measured = report(observer, 'report')
  observer.send({ type: 'report' })
  const arrivals = (await measured).arrivals.filter(at => at > start && at < end)
  assert.ok(arrivals.length >= 5, 'independent listener must receive PCM while the parent event loop is blocked')

  const firstClosed = once(first, 'close')
  const observerExited = once(observer, 'exit')
  cookies.delete('fixture=first')
  audio.disconnectSession({ headers: { cookie: 'fixture=first' } })
  await firstClosed
  await observerExited
  assert.equal(second.readyState, WebSocket.OPEN, 'logout must not revoke another browser')

  const secondClosed = once(second, 'close')
  process.kill(workerPid, 'SIGKILL')
  await secondClosed
  // 等待父进程收取退出事件 新请求将惰性建立新的采集进程
  await new Promise(resolve => setTimeout(resolve, 100))
  const recovered = connect('fixture=second')
  assert.notEqual((await pcm(recovered)).readUInt32BE(), workerPid)
  const recoveredClosed = once(recovered, 'close')
  // 先停止接受新连接 再回收持有移交连接的工作进程
  const serverClosed = new Promise(resolve => server.close(resolve))
  server.closeAllConnections()
  await audio.stop()
  await recoveredClosed
  await serverClosed
})
