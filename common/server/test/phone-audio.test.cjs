// Modified in the Mobile Remote derivative (2026): mobile UI, media transport or recovery changes; see MODIFICATIONS.md.
'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { selectFixedTarget, audioCommand, startRawCapture, createPhoneAudio, sendPcm } = require('../lib/phone-audio')
const { PassThrough } = require('node:stream')
const { once } = require('node:events')
const path = require('node:path')

// 真实设备使用相同接口 测试仅替换无法在单元测试启动的安卓端
 test('raw capture pushes pinned jar, opens isolated socket and kills only its scid', async () => {
  const calls = []
  const stream = new PassThrough()
  const shell = new PassThrough()
  const adb = {
    async push(serial, jar, remote) { calls.push(['push', serial, remote]); const transfer = new PassThrough(); process.nextTick(() => transfer.emit('end')); return transfer },
    async shell(serial, command) { calls.push(['shell', serial, command]); if (command.includes('app_process /')) return shell; const cleanup = new PassThrough(); process.nextTick(() => cleanup.end()); return cleanup },
    async openLocal(serial, address) { calls.push(['local', serial, address]); return stream },
  }
  const capture = await startRawCapture({ adb, serial: 'fixed', jarPath: path.resolve(__dirname, '../../../services/phone-remote/audio/scrcpy-server-v3.3.3'), scid: '1234abcd' })
  const data = once(capture.stream, 'data')
  stream.write(Buffer.from([1, 0, 2, 0]))
  assert.deepEqual((await data)[0], Buffer.from([1, 0, 2, 0]))
  await capture.stop()
  assert.ok(stream.destroyed)
  assert.ok(shell.destroyed)
  assert.deepEqual(calls.find(call => call[0] === 'local'), ['local', 'fixed', 'localabstract:scrcpy_1234abcd'])
  assert.ok(calls.some(call => call[0] === 'shell' && call[2].includes('scid=1234abcd') && call[2].includes('kill "$p"')))
  const cleanup = calls.find(call => call[0] === 'shell' && call[2].includes('kill "$p"'))[2]
  assert.ok(cleanup.includes('com.genymobile.scrcpy.Server 3.3.3 '), 'cleanup matches actual app_process argv by version, not CLASSPATH environment')
  assert.ok(!cleanup.includes("grep -F '/data/local/tmp/phone-audio-3.3.3.jar'"))
})

// 取消可能发生在安卓 shell 尚未完成握手时 晚到资源也必须精确回收
 test('abort during shell handshake destroys late shell and retries scoped cleanup', async () => {
  const controller = new AbortController()
  const lateShell = new PassThrough()
  let finishShell
  let shellRequested
  const ready = new Promise(resolve => { shellRequested = resolve })
  const gate = new Promise(resolve => { finishShell = resolve })
  let cleanups = 0
  const adb = {
    async push() { const transfer = new PassThrough(); process.nextTick(() => transfer.emit('end')); return transfer },
    async shell(_serial, command) { if (command.includes('app_process /')) { shellRequested(); return gate } cleanups++; const cleanup = new PassThrough(); process.nextTick(() => cleanup.end()); return cleanup },
    async openLocal() { throw new Error('must not open after abort') },
  }
  const pending = startRawCapture({ adb, serial: 'fixture', jarPath: path.resolve(__dirname, '../../../services/phone-remote/audio/scrcpy-server-v3.3.3'), scid: '1234abcd', signal: controller.signal })
  await ready
  controller.abort()
  finishShell(lateShell)
  await assert.rejects(pending, /abort/i)
  assert.ok(lateShell.destroyed)
  assert.equal(cleanups, 2)
})

// 临时回环服务器验证真实升级与会话校验 完成后关闭监听
 test('authenticated websocket starts only on demand, shares PCM and stops after last listener', async t => {
  const http = require('node:http')
  const WebSocket = require('ws')
  const { setTimeout: delay } = require('node:timers/promises')
  const stream = new PassThrough()
  let starts = 0
  let stops = 0
  const server = http.createServer((req, res) => { res.writeHead(req.url === '/session/check' && req.headers.cookie === 'fixture=valid' ? 204 : 401); res.end() })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = 'http://127.0.0.1:' + server.address().port
  const audio = createPhoneAudio({ origin: 'https://fixture.test', sessionCheckUrl: address + '/session/check', selectTarget: async () => 'fixed-server-target', startCapture: async ({ serial }) => { assert.equal(serial, 'fixed-server-target'); starts++; return { stream, async stop() { stops++; stream.destroy() } } } })
  server.on('upgrade', (req, socket, head) => { if (!audio.handleUpgrade(req, socket, head)) socket.destroy() })
  t.after(async () => { await audio.stop(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) })
  assert.equal(starts, 0)
  // 裸升级 伪造来源及任何查询参数均不能触发安卓采集
  for (const [suffix, origin, cookie] of [['', 'https://fixture.test', ''], ['', 'https://evil.test', 'fixture=valid'], ['?serial=attacker', 'https://fixture.test', 'fixture=valid']]) {
    const rejected = new WebSocket(address.replace('http:', 'ws:') + '/phone-audio' + suffix, { origin, headers: { Cookie: cookie } })
    const error = await new Promise(resolve => rejected.on('error', resolve))
    assert.ok(error)
    assert.equal(starts, 0)
  }
  const first = new WebSocket(address.replace('http:', 'ws:') + '/phone-audio', { origin: 'https://fixture.test', headers: { Cookie: 'fixture=valid' } })
  t.after(() => first.terminate())
  const format = JSON.parse((await once(first, 'message'))[0].toString())
  assert.deepEqual(format, { type: 'format', codec: 'pcm-s16le', sampleRate: 48000, channels: 2, bitrate: 1536000 })
  const second = new WebSocket(address.replace('http:', 'ws:') + '/phone-audio', { origin: 'https://fixture.test', headers: { Cookie: 'fixture=valid' } })
  t.after(() => second.terminate())
  await once(second, 'message')
  assert.equal(starts, 1)
  const received = once(first, 'message')
  stream.write(Buffer.from([1, 0, 2, 0]))
  assert.deepEqual((await received)[0], Buffer.from([1, 0, 2, 0]))
  first.close()
  await once(first, 'close')
  assert.equal(stops, 0)
  // 传输分片不保证落在立体声采样边界
  const aligned = once(second, 'message')
  stream.write(Buffer.from([3]))
  stream.write(Buffer.from([0, 4, 0]))
  assert.deepEqual((await aligned)[0], Buffer.from([3, 0, 4, 0]))
  const disconnected = once(second, 'close')
  audio.disconnectSession({ headers: { cookie: 'fixture=valid' } })
  await disconnected
  await delay(20)
  assert.equal(stops, 1)
})

// 过慢连接不能把后端音频累计成延迟回放
 test('slow PCM listeners are closed instead of queued indefinitely', () => {
  let sent = 0
  let closeCode
  const client = { readyState: 1, bufferedAmount: 40000, send() { sent++ }, close(code) { closeCode = code } }
  assert.equal(sendPcm(client, Buffer.alloc(4)), false)
  assert.equal(sent, 0)
  assert.equal(closeCode, 1013)
  client.bufferedAmount = 0
  assert.equal(sendPcm(client, Buffer.alloc(4)), true)
  assert.equal(sent, 1)
})

// 已建立连接也必须响应服务端会话撤销 不仅在握手时检查
 test('session revocation rechecks established audio websocket and releases capture', async t => {
  const http = require('node:http')
  const WebSocket = require('ws')
  let valid = true
  let stopped = false
  const server = http.createServer((_req, res) => { res.writeHead(valid ? 204 : 401); res.end() })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = 'http://127.0.0.1:' + server.address().port
  const audio = createPhoneAudio({ origin, sessionCheckUrl: origin + '/session/check', sessionRecheckMs: 25, selectTarget: async () => 'fixture', startCapture: async () => ({ stream: new PassThrough(), async stop() { stopped = true } }) })
  server.on('upgrade', audio.handleUpgrade)
  t.after(async () => { await audio.stop(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) })
  const client = new WebSocket(origin.replace('http:', 'ws:') + '/phone-audio', { origin, headers: { Cookie: 'fixture=valid' } })
  t.after(() => client.terminate())
  await once(client, 'message')
  valid = false
  let timeout
  await Promise.race([once(client, 'close'), new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('revoked session retained audio access')), 700) })]).finally(() => clearTimeout(timeout))
  assert.ok(stopped)
})

// 快速关闭再开启不能复用已取消的启动任务而留下无声连接
 test('a listener joining during cancelled startup gets a fresh capture', async t => {
  const http = require('node:http')
  const WebSocket = require('ws')
  const { setTimeout: delay } = require('node:timers/promises')
  const server = http.createServer((_req, res) => { res.writeHead(204); res.end() })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = 'http://127.0.0.1:' + server.address().port
  let starts = 0
  let finishFirst
  const gate = new Promise(resolve => { finishFirst = resolve })
  const audio = createPhoneAudio({ origin, sessionCheckUrl: origin + '/session/check', selectTarget: async () => 'fixture', startCapture: async () => { starts++; if (starts === 1) await gate; const stream = new PassThrough(); return { stream, async stop() { stream.destroy() } } } })
  server.on('upgrade', audio.handleUpgrade)
  t.after(async () => { finishFirst(); await audio.stop(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) })
  const options = { origin, headers: { Cookie: 'fixture=valid' } }
  const first = new WebSocket(origin.replace('http:', 'ws:') + '/phone-audio', options)
  t.after(() => first.terminate())
  await once(first, 'message')
  first.close()
  await once(first, 'close')
  await delay(10)
  const second = new WebSocket(origin.replace('http:', 'ws:') + '/phone-audio', options)
  t.after(() => second.terminate())
  await once(second, 'message')
  finishFirst()
  await delay(30)
  assert.equal(starts, 2)
})

// 前端采样转换使用真实字节值 并在拥塞时停止已排队旧样本
 test('browser PCM player decodes stereo little endian, bounds latency and controls gain', () => {
  const { createPcmPlayer } = require('../public/phone-audio')
  const sources = []
  const context = { currentTime: 0, destination: {}, createGain() { return { gain: { value: 1, setValueAtTime() {}, linearRampToValueAtTime() {}, cancelScheduledValues() {} }, connect() {} } }, createBuffer(channels, length, rate) { const arrays = Array.from({ length: channels }, () => new Float32Array(length)); return { sampleRate: rate, length, duration: length / rate, getChannelData(channel) { return arrays[channel] } } }, createBufferSource() { const source = { connect() {}, start(time) { this.time = time }, stop() { this.stopped = true } }; sources.push(source); return source } }
  const player = createPcmPlayer(context)
  const samples = new Uint8Array([0, 128, 255, 127, 0, 0, 0, 64]).buffer
  player.push(samples)
  assert.equal(sources[0].buffer.getChannelData(0)[0], -1)
  assert.equal(sources[0].buffer.getChannelData(1)[0], 32767 / 32768)
  assert.equal(sources[0].buffer.getChannelData(1)[1], 0.5)
  assert.equal(sources[0].buffer.sampleRate, 48000)
  player.setVolume(0.25)
  assert.equal(player.gain.gain.value, 0.25)
  player.setVolume(10)
  assert.equal(player.gain.gain.value, 10)
  assert.throws(() => player.setVolume(10.01), /音量/)
  for (let i = 0; i < 100; i++) player.push(new ArrayBuffer(3840))
  assert.ok(sources.some(source => source.stopped), 'old audio must be discarded')
  assert.ok(sources.filter(source => !source.stopped).length <= 10)
  assert.ok(Math.max(...sources.filter(source => !source.stopped).map(source => source.time)) < 0.25)
  player.stop()
  assert.ok(sources.every(source => source.stopped))
})

// 浏览器使用真实 WebSocket 与 WebAudio 验证手势启动 音量和离开回收
 test('mobile audio UI stays opt-in and gesture starts real WebAudio, gain and pagehide cleanup', async t => {
  const { chromium, webkit } = require('playwright')
  const http = require('node:http')
  const fs = require('node:fs')
  let audio
  let starts = 0
  let stops = 0
  const server = http.createServer((req, res) => {
    if (req.url === '/session/check') { res.writeHead(req.headers.cookie === 'fixture=valid' ? 204 : 401); return res.end() }
    if (req.url === '/phone-audio.js') { res.setHeader('Content-Type', 'application/javascript'); return res.end(fs.readFileSync(path.resolve(__dirname, '../public/phone-audio.js'))) }
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    res.setHeader('Set-Cookie', 'fixture=valid; SameSite=Strict; Path=/')
    res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><body><section id="media-panel"><p id="media-audio-status"></p></section><script src="/phone-audio.js"></script></body>')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => { await audio?.stop(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) })
  const origin = 'http://127.0.0.1:' + server.address().port
  // 只有显式设备验证模式才连接手机 默认全套测试完全隔离设备
  const realAdb = process.env.PHONE_AUDIO_REAL_DEVICE === '1' ? require('@dead50f7/adbkit').createClient({ host: '127.0.0.1', port: 5037 }) : null
  const measured = { bytes: 0, nonzeroSamples: 0, peak: 0 }
  audio = createPhoneAudio({
    origin,
    sessionCheckUrl: origin + '/session/check',
    selectTarget: async () => realAdb ? selectFixedTarget([], (await realAdb.listDevices()).map(device => ({ serial: device.id, state: device.type }))) : 'fixture',
    // 实测复用生产采集器 不把测试静音包冒充设备音频
    startCapture: async options => {
      starts++
      if (realAdb) {
        const capture = await startRawCapture({ ...options, adb: realAdb, jarPath: path.resolve(__dirname, '../../../services/phone-remote/audio/scrcpy-server-v3.3.3') })
        capture.stream.on('data', data => { measured.bytes += data.length; for (let offset = 0; offset + 1 < data.length; offset += 2) { const sample = data.readInt16LE(offset); if (sample) measured.nonzeroSamples++; measured.peak = Math.max(measured.peak, Math.abs(sample)) } })
        return { stream: capture.stream, async stop() { await capture.stop(); stops++ } }
      }
      const stream = new PassThrough()
      const timer = setInterval(() => stream.write(Buffer.alloc(3840)), 20)
      return { stream, async stop() { clearInterval(timer); stream.destroy(); stops++ } }
    },
  })
  server.on('upgrade', (req, socket, head) => { if (!audio.handleUpgrade(req, socket, head)) socket.destroy() })
  t.after(() => audio.stop())
  const browser = process.env.PHONE_AUDIO_WEBKIT_EXECUTABLE ? await webkit.launch({ executablePath: process.env.PHONE_AUDIO_WEBKIT_EXECUTABLE }) : await chromium.launch({ args: ['--no-sandbox'] })
  t.after(() => browser.close())
  const page = await browser.newPage({ viewport: { width: 430, height: 932 }, hasTouch: true })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.addInitScript(() => {
    const Original = window.AudioContext || window.webkitAudioContext
    window.contexts = []
    window.audioSources = 0
    window.AudioContext = class extends Original {
      constructor(...args) { super(...args); window.contexts.push(this) }
      createGain() { const gain = super.createGain(); if (!this.testVolumeGain) { this.testVolumeGain = gain; window.lastGain = gain }; return gain }
      createBufferSource() { window.audioSources++; return super.createBufferSource() }
    }
  })
  await page.goto(origin)
  assert.equal(starts, 0)
  assert.equal(await page.evaluate(() => window.contexts.length), 0)
  assert.match(await page.locator('#media-audio-status').innerText(), /96 kbps/)
  assert.equal(await page.locator('#phone-audio-toggle').count(), 1)
  await page.locator('#phone-audio-toggle').click()
  await page.waitForFunction(() => window.audioSources > 0)
  assert.equal(starts, 1)
  assert.equal(await page.evaluate(() => window.contexts[0].state), 'running')
  const beforeBackground = await page.evaluate(() => window.audioSources)
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable:true, value:true }); document.dispatchEvent(new Event('visibilitychange')) })
  await page.waitForFunction(previous => window.audioSources > previous, beforeBackground)
  assert.equal(stops, 0)
  await page.evaluate(() => window.contexts[0].suspend())
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable:true, value:false }); document.dispatchEvent(new Event('visibilitychange')) })
  await page.waitForFunction(() => window.contexts[0].state === 'running')
  assert.equal(starts, 1)
  assert.equal(stops, 0)
  await page.locator('#phone-audio-volume').fill('0.25')
  assert.equal(await page.evaluate(() => window.lastGain.gain.value), 0.25)
  assert.equal(await page.locator('#phone-audio-toggle').innerText(), '关闭声音')
  await page.locator('#phone-audio-toggle').click()
  await page.waitForFunction(() => window.contexts[0].state === 'closed')
  await new Promise(resolve => setTimeout(resolve, 40))
  assert.equal(stops, 1)
  const previousSources = await page.evaluate(() => window.audioSources)
  await page.locator('#phone-audio-toggle').click()
  await page.waitForFunction(previous => window.contexts.length === 2 && window.contexts[1].state === 'running' && window.audioSources > previous, previousSources)
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')))
  await page.waitForFunction(() => window.contexts[1].state === 'closed')
  await new Promise(resolve => setTimeout(resolve, 40))
  assert.equal(stops, 2)
  assert.deepEqual(errors, [])
  if (realAdb) { assert.ok(measured.bytes > 0); t.diagnostic('real device PCM via authenticated WS → real WebAudio: ' + JSON.stringify(measured)) }
})

// 固定目标只能来自服务端记录且不能在多设备时猜测
 test('audio target is server-selected and ambiguous devices fail closed', async () => {
  assert.equal(selectFixedTarget([{ serial: 'saved' }], [{ serial: 'saved', state: 'device' }, { serial: 'other', state: 'device' }]), 'saved')
  assert.equal(selectFixedTarget([], [{ serial: 'only', state: 'device' }]), 'only')
  assert.throws(() => selectFixedTarget([], [{ serial: 'one', state: 'device' }, { serial: 'two', state: 'device' }]), /唯一/)
  assert.throws(() => selectFixedTarget([{ serial: 'offline' }], []), /唯一/)
})

// 启动参数固定为独立实例和系统输出 不接受浏览器参数
 test('audio command is pinned raw system output and keeps old jar untouched', () => {
  const command = audioCommand('1234abcd')
  for (const value of ['3.3.3', 'scid=1234abcd', 'video=false', 'control=false', 'audio=true', 'audio_source=output', 'audio_codec=raw', 'raw_stream=true', 'tunnel_forward=true', 'cleanup=false', '/data/local/tmp/phone-audio-3.3.3.jar']) assert.ok(command.includes(value), value)
  assert.throws(() => audioCommand('x;id'), /scid/)
})

// 校准结果必须可确认，命令限制在已生效的远控路由且不使用固定音量档位
 test('remote source normalization requires confirmed remote route and volume result', async () => {
  const { normalizeRemoteVolume } = require('../lib/phone-audio')
  const { PassThrough } = require('stream')
  let command
  const adb = { shell: async (_serial, value) => { command = value; const stream = new PassThrough(); setImmediate(() => stream.end('REMOTE_VOLUME_READY\n')); return stream } }
  await normalizeRemoteVolume(adb, 'fixture')
  assert.ok(command.includes('Devices: remote_submix(8000)'))
  assert.ok(command.includes('--set "$maximum"'))
  assert.ok(command.includes('volume is $maximum in range'))
  await assert.rejects(normalizeRemoteVolume({ shell: async () => { const stream = new PassThrough(); setImmediate(() => stream.end('')); return stream } }, 'fixture'), /校准失败/)
 })

// 短暂失联复用采集器，主动关闭、登出与保留期结束仍释放源
 test('audio warm grace reuses capture without replaying backlog and honors explicit stop', async t => {
  const http = require('node:http'), WebSocket = require('ws'), { setTimeout: delay } = require('node:timers/promises')
  let starts = 0, stops = 0
  const stream = new PassThrough()
  const server = http.createServer((_req, res) => { res.writeHead(204); res.end() })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = 'http://127.0.0.1:' + server.address().port
  const audio = createPhoneAudio({ origin, sessionCheckUrl: origin + '/session/check', warmIdleMs: 180, selectTarget: async () => 'fixture', startCapture: async () => { starts++; return { stream, async stop() { stops++ } } } })
  server.on('upgrade', audio.handleUpgrade)
  t.after(async () => { await audio.stop(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) })
  async function connect() { const client = new WebSocket(origin.replace('http:', 'ws:') + '/phone-audio', { origin, headers: { Cookie: 'fixture=valid' } }); await once(client, 'message'); return client }
  const first = await connect(); first.terminate(); await once(first, 'close'); await delay(30)
  assert.equal(stops, 0)
  stream.write(Buffer.from([7,0,7,0]))
  const second = await connect(); assert.equal(starts, 1)
  const fresh = once(second, 'message'); stream.write(Buffer.from([2,0,2,0])); assert.deepEqual((await fresh)[0], Buffer.from([2,0,2,0]))
  second.close(4000, 'stop'); await once(second, 'close'); await delay(30); assert.equal(stops, 1)
  const third = await connect(); third.terminate(); await once(third, 'close'); await delay(230); assert.equal(stops, 2)
  const fourth = await connect(); fourth.terminate(); await once(fourth, 'close'); await delay(20)
  audio.disconnectSession({ headers: { cookie: 'fixture=valid' } }); await delay(20); assert.equal(stops, 3)
})
