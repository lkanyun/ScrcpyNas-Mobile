// Modified in the Mobile Remote derivative (2026): mobile UI, media transport or recovery changes; see MODIFICATIONS.md.
'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { webkit } = require('playwright')
const { createOpusPlayback, createPcmPlayer } = require('../public/phone-audio')

// 冷启动与重连分别建立新解码器 积压只用于追赶状态而不触发播放清队列
test('startup backlog catches up before first sound without changing steady playback', async t => {
  let now = 0
  t.mock.method(performance, 'now', () => now * 1000)
  for (const connection of ['initial', 'reconnected']) {
    let release
    const decoded = [], scheduled = []
    const context = {
      get currentTime() { return now }, destination: {},
      createGain() { return { connect() {}, disconnect() {}, gain: { setValueAtTime() {}, linearRampToValueAtTime() {}, cancelScheduledValues() {} } } },
      createBuffer(channels, frames, rate) { return { duration: frames / rate, getChannelData() { return new Float32Array(frames) } } },
      createBufferSource() { return { connect() {}, disconnect() {}, stop() {}, start(time) { scheduled.push(time) } } }
    }
    class Decoder {
      // 模拟新工作线程尚未完成初始化
      constructor() { this.ready = new Promise(resolve => { release = resolve }) }
      // 每帧都推进状态 首帧模拟被 preSkip 完全消耗
      async decodeFrame(bytes) { decoded.push(bytes[0]); return { channelData: [new Float32Array(bytes[0] ? 960 : 0)], sampleRate: 48000 } }
      // 测试解码器没有外部资源
      free() {}
    }
    const player = createPcmPlayer(context)
    const playback = createOpusPlayback(Decoder, { channels: 1 }, player, () => {}, error => { throw error })
    // 构造独立帧标记以核实启动阶段没有跳过解码状态
    function push(index) {
      const bytes = new Uint8Array(13)
      new DataView(bytes.buffer).setUint32(8, 1)
      bytes[12] = index
      playback.push(bytes.buffer)
    }
    for (let index = 0; index < 6; index++) push(index)
    release()
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(decoded, [0, 1, 2, 3, 4, 5], connection)
    assert.deepEqual(scheduled, [now + 0.04], 'start latest audio with the existing lead, without an extra timer')
    assert.deepEqual(player.getQueueStats(), { underruns: 0, resets: 0, queuedMs: 60 })
    now += 0.02
    push(6)
    push(7)
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(scheduled.length, 3, 'steady playback must keep both decoded frames')
    assert.ok(Math.abs(scheduled[1] - scheduled[0] - 0.02) < 1e-9)
    assert.ok(Math.abs(scheduled[2] - scheduled[1] - 0.02) < 1e-9)
    assert.equal(player.getQueueStats().resets, 0)
    playback.stop()
    player.dispose()
    now += 1
  }
})

// 使用真实离线音频渲染验证迟到但未断粮的帧仍连续，首尾淡变不产生阶跃
 test('WebKit audio remains continuous with only ten milliseconds queued', async () => {
  const browser = await webkit.launch({ executablePath: process.env.PHONE_AUDIO_WEBKIT_EXECUTABLE })
  try {
    const page = await browser.newPage()
    await page.evaluate(() => { window.module = { exports: {} } })
    await page.addScriptTag({ content: fs.readFileSync(path.resolve(__dirname, '../public/phone-audio.js'), 'utf8') })
    const result = await page.evaluate(async () => {
      const offline = new OfflineAudioContext(1, 14400, 48000)
      let now = 0
      const context = { get currentTime() { return now }, destination: offline.destination, createGain: offline.createGain.bind(offline), createBuffer: offline.createBuffer.bind(offline), createBufferSource: offline.createBufferSource.bind(offline) }
      const player = module.exports.createPcmPlayer(context)
      const samples = new Float32Array(960).fill(0.5)
      player.pushChannels([samples], 48000)
      now = 0.05
      player.pushChannels([samples], 48000)
      const continuous = player.getQueueStats()
      now = 0.15
      player.pushChannels([samples], 48000)
      const recovered = player.getQueueStats()
      const rendered = (await offline.startRendering()).getChannelData(0)
      let error = 0, step = 0
      for (let i = 2112; i < 3696; i++) error = Math.max(error, Math.abs(rendered[i] - 0.5))
      for (let i = 1; i < rendered.length; i++) step = Math.max(step, Math.abs(rendered[i] - rendered[i - 1]))
      return { error, step, continuous, recovered }
    })
    assert.ok(result.error < 0.0001, JSON.stringify(result))
    assert.ok(result.step < 0.005, JSON.stringify(result))
    assert.equal(result.continuous.underruns, 0)
    assert.equal(result.recovered.underruns, 1)
    assert.ok(result.recovered.queuedMs <= 60)
  } finally { await browser.close() }
 })

// 过期播放帧仍经过解码器，避免把预测状态与播放丢弃混为一谈
 test('late Opus frames advance decoder state without playing stale audio', async t => {
  let now = 0, decoded = 0, played = 0, gaps = 0
  t.mock.method(performance, 'now', () => now)
  let release
  class Decoder {
    constructor() { this.ready = new Promise(resolve => { release = resolve }) }
    async decodeFrame() { decoded++; return { channelData: [new Float32Array(960)], sampleRate: 48000 } }
    free() {}
  }
  const playback = createOpusPlayback(Decoder, { channels: 1 }, { pushChannels() { played++ }, discontinuity() { gaps++ } }, () => {}, error => { throw error })
  const packet = new Uint8Array(13); new DataView(packet.buffer).setUint32(8, 1)
  playback.push(packet.buffer)
  now = 200
  release()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(decoded, 1)
  assert.equal(played, 0)
  assert.equal(gaps, 1)
  playback.stop()
 })
