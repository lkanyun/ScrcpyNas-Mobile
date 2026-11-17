// Modified in the Mobile Remote derivative (2026): mobile UI, media transport or recovery changes; see MODIFICATIONS.md.
'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const { PassThrough } = require('node:stream')
const { createPhoneAudio } = require('../lib/phone-audio')
const { webkit } = require('playwright')
const { execFileSync } = require('node:child_process')

// 将合成正弦波编码为标准 Opus 并拆出 Ogg 数据包验证实际非静音解码
function tonePackets() {
  const data = execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-ac', '2', '-t', '0.4', '-c:a', 'libopus', '-b:a', '96k', '-f', 'opus', 'pipe:1'])
  const packets = []; let chunks = []
  for (let offset = 0; offset < data.length;) {
    assert.equal(data.toString('ascii', offset, offset + 4), 'OggS')
    const count = data[offset + 26], sizes = data.subarray(offset + 27, offset + 27 + count)
    let cursor = offset + 27 + count
    for (const size of sizes) {
      chunks.push(data.subarray(cursor, cursor + size)); cursor += size
      if (size < 255) { packets.push(Buffer.concat(chunks)); chunks = [] }
    }
    offset = cursor
  }
  return packets.slice(2)
}

// 合成静音 Opus 使用真实采样时间 不读取用户音频
function packet(payload, pts) {
  const h = Buffer.alloc(12); h.writeBigUInt64BE(pts); h.writeUInt32BE(payload.length, 8)
  return Buffer.concat([h, payload])
}
// 真实浏览器验证原生解码 直连 强制中转 回退与鉴权撤销
for (const relay of [false, true, 'ui']) test('native Opus receives ' + (relay === 'ui' ? 'production UI' : relay ? 'TURN relay' : 'direct') + ' and falls back without restarting capture', { skip: !process.env.RTC_TEST_CONFIG, timeout: 60000 }, async t => {
  let authorized = true, starts = 0, stops = 0
  const tone = tonePackets()
  const server = http.createServer((req, res) => {
    if (req.url === '/session/check') { res.writeHead(authorized && req.headers.cookie === 'test=owner' ? 204 : 401); return res.end() }
    if (req.url === '/opus.js') { res.setHeader('Content-Type', 'application/javascript; charset=utf-8'); return res.end(fs.readFileSync(path.join(__dirname, '../public/vendor/opus-decoder.min.js'))) }
    if (req.url === '/audio.js') { res.setHeader('Content-Type', 'application/javascript; charset=utf-8'); return res.end(fs.readFileSync(path.join(__dirname, '../public/phone-audio.js'))) }
    res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end('<!doctype html><body>' + (relay === 'ui' ? '<section id="media-panel"><p id="media-audio-status"></p></section>' : '') + '<button id="start">play</button><script>window.module={exports:{}}</script><script src="/opus.js"></script><script src="/audio.js"></script>')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = 'http://127.0.0.1:' + server.address().port
  const audio = createPhoneAudio({ origin, sessionCheckUrl: origin + '/session/check', codec: 'opus', sessionRecheckMs: 500,
    rtcConfig: JSON.parse(fs.readFileSync(process.env.RTC_TEST_CONFIG)), selectTarget: async () => 'fixture',
    // 模拟共享安卓采集器 并在停止时释放定时器
    async startCapture() {
      starts++
      const stream = new PassThrough()
      const head = Buffer.alloc(19); head.write('OpusHead'); head[8] = 1; head[9] = 2
      let pts = 0n, frameIndex = 0
      const init = setTimeout(() => stream.write(packet(head, 1n << 63n)), 5)
      const timer = setInterval(() => { pts += 20000n; stream.write(packet(tone[frameIndex++ % tone.length], pts + (frameIndex % 10 === 0 ? 19000n : 0n))) }, 20)
      return { stream, async stop() { stops++; clearTimeout(init); clearInterval(timer); stream.destroy() } }
    }
  })
  server.on('upgrade', (req, socket, head) => audio.handleUpgrade(req, socket, head))
  const browser = await webkit.launch({ executablePath: process.env.PHONE_AUDIO_WEBKIT_EXECUTABLE })
  t.after(async () => { await browser.close(); await audio.stop(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) })
  const context = await browser.newContext()
  await context.addCookies([{ name: 'test', value: 'owner', url: origin }])
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.addInitScript(() => {
    const Native = RTCPeerConnection
    window.RTCPeerConnection = class extends Native { constructor(options) { super(options); window.uiPeer = this } }
  })
  await page.goto(origin)
  if (relay === 'ui') {
    await page.click('#phone-audio-toggle')
    try { await page.waitForFunction(() => document.querySelector('#media-audio-status').textContent.includes('WebRTC Opus')) } catch (error) { t.diagnostic(JSON.stringify({ status: await page.locator('#media-audio-status').textContent(), errors })); throw error }
    await page.waitForFunction(async () => [...(await uiPeer.getStats()).values()].some(value => value.type === 'inbound-rtp' && value.totalAudioEnergy > 0))
    await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')) })
    await new Promise(resolve => setTimeout(resolve, 300))
    assert.equal(stops, 0)
    await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: false }); document.dispatchEvent(new Event('visibilitychange')) })
    await page.click('#phone-audio-toggle')
    await page.waitForFunction(() => uiPeer.connectionState === 'closed')
    assert.equal(starts, 1)
    assert.deepEqual(errors, [])
    return
  }
  await page.evaluate(forceRelay => {
    document.querySelector('#start').onclick = async () => {
      const ctx = new AudioContext()
      const player = window.player = module.exports.createPcmPlayer(ctx, document)
      await Promise.all([ctx.resume(), player.resumeOutput()])
      window.result = { bytes: 0, fallback: 0, binary: 0 }
      const ws = window.ws = new WebSocket(location.origin.replace('http:', 'ws:') + '/phone-audio?sourceVolume=unity&rtc=1')
      class Peer extends RTCPeerConnection { constructor(options) { super({ ...options, iceTransportPolicy: forceRelay ? 'relay' : 'all' }); window.peer = this } }
      const receiver = window.receiver = module.exports.createRtcAudioReceiver({ socket: ws, player, Peer, onStats: value => Object.assign(result, value), onFallback: () => result.fallback++ })
      ws.onmessage = event => { if (typeof event.data === 'string') { const data = JSON.parse(event.data); if (data.rtc) receiver.receive(data) } else result.binary++ }
      ws.onclose = () => { receiver.close(); result.closed = true }
    }
  }, relay)
  await page.click('#start')
  try { await page.waitForFunction(() => window.result?.bytes > 100 && window.result?.concealed !== undefined, {}, { timeout: 25000 }) } catch (error) { t.diagnostic(JSON.stringify(await page.evaluate(() => ({ result: window.result, state: window.peer?.connectionState, ice: window.peer?.iceConnectionState, candidates: window.peer?.localDescription?.sdp.match(/typ \w+/g) })))); throw error }
  await page.waitForFunction(() => window.player.getOutputPeak() > 100)
  const stats = await page.evaluate(async () => {
    const reports = [...(await peer.getStats()).values()]
    const pair = reports.find(v => v.type === 'candidate-pair' && v.nominated && v.state === 'succeeded')
    return { ...result, relay: reports.some(v => (v.id === pair?.localCandidateId || v.id === pair?.remoteCandidateId) && v.candidateType === 'relay'), samples: reports.find(v => v.type === 'inbound-rtp')?.totalSamplesReceived }
  })
  assert.equal(stats.relay, relay)
  assert.equal(stats.binary, 0)
  assert.equal(stats.fallback, 0)
  assert.ok(stats.samples > 0)
  assert.ok(stats.concealed / stats.samples < 0.1, JSON.stringify(stats))
  if (relay) await page.evaluate(() => {
    const original = peer.getStats.bind(peer)
    let count = 0
    peer.getStats = async () => {
      const reports = await original(); count++
      for (const value of reports.values()) if (value.type === 'inbound-rtp') { value.totalSamplesReceived = 48000 * count; value.concealedSamples = 16000 * count }
      return reports
    }
  })
  else await page.evaluate(() => receiver.fallback())
  await page.waitForFunction(() => result.binary > 3)
  assert.equal(starts, 1)
  authorized = false
  await page.waitForFunction(() => result.closed)
  assert.equal(await page.evaluate(() => peer.connectionState), 'closed')
  t.diagnostic(JSON.stringify({ relay, samples: stats.samples, bytes: stats.bytes, starts, stops }))
})
