// Modified in the Mobile Remote derivative (2026): mobile UI, media transport or recovery changes; see MODIFICATIONS.md.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

// 加载实际交付核心，调度单测不冒充原生解码验收
function loadCore(clock = performance) {
  const window = {}
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../public/low-latency-core.js'), 'utf8'), { window, performance: clock, setTimeout, clearTimeout, Map, Uint8Array })
  return window.scrcpyNasLowLatencyCore
}
const { LowLatencyDecoder, LegacyAccessUnitAdapter } = loadCore()
const { legacyVideoFixture } = require('./legacy-video-fixture.cjs')

// 已证实的编码器消息边界必须即时交付 High 多切片图像，不等下一包
 test('legacy complete-buffer contract delivers High CABAC multislice immediately without lookahead', t => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR, 'wc-packet-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const fixture = legacyVideoFixture(dir)
  const output = []
  const adapter = new LegacyAccessUnitAdapter(au => output.push(au))
  adapter.push(fixture.configuration)
  assert.equal(output.length, 0, 'codec config is not a picture')
  adapter.push(fixture.pictures[0])
  assert.equal(output.length, 1, 'final live AU must not wait for another message')
  assert.equal(output[0].key, true)
  assert.equal(output[0].slices, 3)
  assert.match(output[0].config.codec, /^avc1\.64/)
  adapter.push(fixture.pictures[1])
  assert.equal(output.length, 2)
  assert.equal(output[1].key, false)
  assert.deepEqual(Buffer.from(output[1].data), fixture.pictures[1])
 })

// 同 codec 的参数集改变仍须切换解码世代，不能让旧尺寸和依赖链漏过门禁
 test('parameter-only messages preserve split SPS PPS and reconfigure same-codec resolution generations', async t => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR, 'wc-config-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const a = legacyVideoFixture(dir)
  const b = legacyVideoFixture(dir, { width: 240, height: 320 })
  const output = []
  const adapter = new LegacyAccessUnitAdapter(au => output.push(au))
  for (const parameter of a.parameterSets) adapter.push(parameter)
  adapter.push(a.pictures[0])
  adapter.push(a.configuration)
  adapter.push(a.pictures[1])
  assert.equal(output[0].configurationId, output[1].configurationId)
  adapter.push(b.configuration)
  adapter.push(b.pictures[1])
  adapter.push(b.pictures[0])
  assert.notEqual(output[2].configurationId, output[1].configurationId)
  assert.equal(output[2].config.codec, output[1].config.codec)
  const d = new LowLatencyDecoder({ Decoder, Chunk: class { constructor(x) { Object.assign(this,x) } }, requestFrame: () => 1, cancelFrame: () => {} })
  await d.accept(output[0], 1)
  const old = d.decoder
  await d.accept(output[1], 2)
  await d.accept(output[2], 3)
  assert.equal(old.state, 'closed', 'changed parameter sets invalidate even identical codec strings')
  assert.equal(d.needsKey, true)
  await d.accept(output[3], 4)
  assert.equal(d.decoder.chunks.length, 1)
  assert.equal(d.decoder.chunks[0].type, 'key')
  d.close()
 })

// 参数集不是图像，且其独立存储不能借视频缓冲上限膨胀
 test('complete-buffer adapter bounds configuration and rejects malformed message framing', () => {
  const adapter = new LegacyAccessUnitAdapter(() => {})
  assert.throws(() => adapter.push(new Uint8Array([0, 0, 0, 1, 0x67, ...new Array(65536).fill(0xff)])), /configuration-byte-limit/)
  for (const bytes of [[1,2,3], [0,0,1,0x80,1], [0,0,1], [0,0,1,0x62,1]]) assert.throws(() => adapter.push(Uint8Array.from(bytes)))
  assert.throws(() => adapter.push(new Uint8Array(4 * 1024 * 1024 + 1)), /byte-limit/)
  assert.doesNotThrow(() => adapter.push(Uint8Array.from([0,0,1,0x65,1])))
 })

// 使用可控制的解码端验证调度门禁，真实解码另由 WebKit 覆盖
class Decoder {
  static supports = true
  static async isConfigSupported(config) { return { supported: this.supports, config } }
  constructor(cb) { this.cb = cb; this.state = 'unconfigured'; this.decodeQueueSize = 0; this.chunks = [] }
  configure(config) { this.config = config; this.state = 'configured' }
  decode(chunk) { this.chunks.push(chunk); this.decodeQueueSize++ }
  close() { this.state = 'closed'; this.decodeQueueSize = 0 }
}
// 旧原生解码器的迟到错误也不得关闭替代世代
 test('late native error callbacks cannot fail a replacement decoder generation', () => {
  const d = new LowLatencyDecoder({ Decoder, requestFrame: () => 1, cancelFrame: () => {} })
  const old = d.decoder
  d.resync()
  old.cb.error(new Error('late old decoder error'))
  assert.equal(d.closed,false)
  d.close()
})
// 原生能力探测首次启动可异步，有限排队避免无故丢整组依赖图像
 test('bounded initial configuration admission preserves deltas without a needless GOP reset', async () => {
  let resolve, idr = 0
  class Slow extends Decoder { static isConfigSupported(config) { return new Promise(r => { resolve = () => r({ supported: true, config }) }) } }
  const d = new LowLatencyDecoder({ Decoder: Slow, Chunk: class { constructor(x) { Object.assign(this,x) } }, onIDR: () => idr++, requestFrame: () => 1, cancelFrame: () => {} })
  const pending = d.accept(au(true), 1)
  await d.accept(au(false), 2)
  await d.accept(au(false), 3)
  resolve()
  await pending
  assert.equal(idr, 0)
  assert.equal(d.stats.submitted, 3)
  assert.deepEqual(d.decoder.chunks.map(c => c.type), ['key', 'delta', 'delta'])
  d.close()
 })

// 验证异步能力探测期间丢帧也必须进入有界 IDR 等待
 test('concurrent configuration drop requests recovery and unsupported probe falls back exactly once', async () => {
  let resolve, idr = 0, fallback = 0
  class Slow extends Decoder { static isConfigSupported(config) { return new Promise(r => { resolve = () => r({ supported: true, config }) }) } }
  const d = new LowLatencyDecoder({ Decoder: Slow, maxQueue: 1, maxPending: 1, Chunk: class { constructor(x) { Object.assign(this,x) } }, onIDR: () => idr++, onFallback: () => fallback++, timeoutMs: 30, requestFrame: () => 1, cancelFrame: () => {} })
  const pending = d.accept(au(true), 1)
  await d.accept(au(false), 2)
  await d.accept(au(false), 3)
  resolve()
  await pending
  assert.equal(idr,1)
  assert.ok(d.stats.dropped > 0)
  await new Promise(r => setTimeout(r,60))
  assert.equal(fallback,1)
  d.fail('again')
  assert.equal(fallback,1)
})
// 验证能力失败不会循环，异步探测完成也不能复活关闭实例
 test('unsupported config fails once and close during async support cannot configure', async () => {
  let fallback = 0
  class Unsupported extends Decoder { static async isConfigSupported(config) { return { supported: false, config } } }
  const opts = { Chunk: class { constructor(x) { Object.assign(this,x) } }, onFallback: () => fallback++, requestFrame: () => 1, cancelFrame: () => {} }
  const u = new LowLatencyDecoder({ ...opts, Decoder: Unsupported })
  await u.accept(au(true),1)
  await u.accept(au(true),2)
  assert.equal(fallback,1)
  assert.equal(u.decoder.state,'closed')
  let resolve
  class Slow extends Decoder { static isConfigSupported(config) { return new Promise(r=>{ resolve=()=>r({supported:true,config}) }) } }
  const d = new LowLatencyDecoder({ ...opts, Decoder: Slow })
  const p = d.accept(au(true),1)
  d.close(); resolve(); await p
  assert.equal(d.decoder.state,'closed')
  assert.equal(d.decoder.chunks.length,0)
})
// 验证最多保留一张原生帧且替换、绘制、关闭都释放句柄
 test('latest-only output closes displaced and late frames', async () => {
  let closed = 0, raf
  const d = new LowLatencyDecoder({ Decoder, requestFrame: cb => { raf=cb;return 1 }, cancelFrame: () => {} })
  const frame = timestamp => ({ timestamp, close: () => closed++, displayWidth: 2, displayHeight: 2 })
  d.decoder.cb.output(frame(1));d.decoder.cb.output(frame(2))
  assert.equal(closed,1)
  raf()
  assert.equal(closed,2)
  assert.equal(d.stats.drawn,1)
  d.close();d.decoder.cb.output(frame(3))
  assert.equal(closed,3)
})
const au = key => ({ key, data: new Uint8Array([0,0,0,1,key?101:65]), config: { codec: 'avc1.42C01F', codedWidth: 1280, codedHeight: 720, optimizeForLatency: true } })
// 验证关键帧语义、接收时钟单调性与队列超限后不喂损坏依赖链
 test('bounded queue resets dependency chain, requests IDR once and uses receiver-only monotonic timestamps', async () => {
  let idr = 0, fallback = 0
  const d = new LowLatencyDecoder({ Decoder, Chunk: class { constructor(x) { Object.assign(this,x) } }, maxQueue: 2, onIDR: () => idr++, onFallback: () => fallback++, requestFrame: () => 1, cancelFrame: () => {} })
  await d.accept(au(true), 10)
  await d.accept(au(false), 10)
  const chunks = d.decoder.chunks.slice()
  assert.deepEqual(chunks.map(x=>x.type), ['key','delta'])
  assert.ok(chunks[1].timestamp > chunks[0].timestamp)
  await d.accept(au(false), 11)
  for (let i=0;i<20;i++) await d.accept(au(false),12+i)
  assert.equal(idr,1)
  assert.equal(d.stats.queueMax,2)
  assert.equal(d.decoder.chunks.length,0)
  await d.accept(au(true), 40)
  assert.equal(d.decoder.chunks[0].type,'key')
  assert.equal(fallback,0)
  d.close()
  await d.accept(au(true), 41)
  assert.equal(d.decoder.state,'closed')
})


// 原 Baseline 多切片仍按完整图像计数，最后一张图像不需要 finish 或 AUD
 test('legacy Baseline multislice buffers emit every picture including the final live AU', t => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR, 'wc-baseline-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const fixture = legacyVideoFixture(dir, { profile: 'baseline', frames: 30 })
  const output = []
  const adapter = new LegacyAccessUnitAdapter(au => output.push(au))
  adapter.push(fixture.configuration)
  for (const picture of fixture.pictures) adapter.push(picture)
  assert.equal(output.length, 30)
  assert.equal(output.filter(au => au.key).length, 1)
  assert.ok(output.every(au => au.slices === 3 && au.config.codec.startsWith('avc1.42')))
 })

// 恢复预算约束连续失败，成功持续绘制后不能因历史网络抖动永久停播
 test('sustained real draw progress renews recovery budget while lifetime counters remain cumulative', async () => {
  let now = 0, failures = 0, requests = 0
  const { LowLatencyDecoder: Native } = loadCore({ now: () => now })
  const d = new Native({ Decoder, Chunk: class { constructor(x) { Object.assign(this, x) } }, onIDR: () => requests++, onFallback: () => failures++, requestFrame: () => 1, cancelFrame: () => {} })
  for (let recovery = 0; recovery < 4; recovery++) {
    d.resync()
    assert.equal(d.closed, false, 'old successful recoveries must not consume the next recovery budget')
    for (let i = 0; i < 25; i++) {
      now += 250
      await d.accept(au(i === 0), now)
      d.decoder.decodeQueueSize = 0
      d.decoder.cb.output({ timestamp: d.lastTimestamp, displayWidth: 2, displayHeight: 2, close() {} })
      d.draw()
    }
  }
  assert.equal(failures, 0)
  assert.equal(requests, 4)
  assert.equal(d.stats.idrRequests, 4)
  d.close()
 })

// 只收到关键帧但没有持续绘制时不能刷新预算或形成无界恢复循环
 test('repeated unsuccessful recovery stays bounded without sustained draw progress', async () => {
  let failures = 0
  const d = new LowLatencyDecoder({ Decoder, Chunk: class { constructor(x) { Object.assign(this, x) } }, onFallback: () => failures++, requestFrame: () => 1, cancelFrame: () => {} })
  for (let i = 0; i < 3; i++) { d.resync(); await d.accept(au(true), i + 1) }
  assert.equal(failures, 1)
  assert.equal(d.closed, true)
 })

// 无线到帧突发可以短暂排队，不能把尚未处理的正常帧直接当成坏链
 test('eight-frame arrival bursts drain in order without decoder reset', async t => {
  const d = new LowLatencyDecoder({ Decoder, Chunk: class { constructor(x) { Object.assign(this,x) } }, requestFrame: () => 1, cancelFrame: () => {} })
  t.after(() => d.close())
  await d.accept(au(true), 1)
  for (let i=2;i<=8;i++) await d.accept(au(false), i)
  assert.equal(d.stats.resets, 0)
  const native = d.decoder
  for (let i=0;i<8;i++) {
    const chunk = native.chunks[i]
    assert.ok(chunk, 'queued input resumes as native output frees capacity')
    native.decodeQueueSize--
    native.cb.output({timestamp:chunk.timestamp,displayWidth:2,displayHeight:2,close(){}})
    d.draw()
    await Promise.resolve()
  }
  assert.equal(d.stats.output, 8)
  assert.equal(d.stats.submitted, 8)
  assert.ok(d.stats.queueMax <= 4)
  assert.equal(d.stats.resets, 0)
 })

// 温连接可能从半个 GOP 开始，缺参数的合法图像应请求刷新而不是报格式错误
 test('warm resume before parameter sets requests refresh and waits for complete configuration', t => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR, 'wc-warm-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const fixture = legacyVideoFixture(dir)
  let requests = 0
  const output = []
  const adapter = new LegacyAccessUnitAdapter(au => output.push(au), () => requests++)
  adapter.push(fixture.pictures[1])
  assert.equal(output.length, 0)
  assert.equal(requests, 1)
  adapter.push(fixture.configuration)
  adapter.push(fixture.pictures[0])
  assert.equal(output.length, 1)
  assert.equal(output[0].key, true)
 })

// 原生解码持续阻塞时短队列到期只请求一次刷新，不无限缓存
 test('stalled admission expires and clears compressed bytes before requesting refresh', async t => {
  let requests = 0
  const d = new LowLatencyDecoder({ Decoder, maxQueue: 1, pendingTimeoutMs: 20, onIDR: () => requests++, Chunk: class { constructor(x) { Object.assign(this,x) } }, requestFrame: () => 1, cancelFrame: () => {} })
  t.after(() => d.close())
  await d.accept(au(true))
  await d.accept(au(false))
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.equal(requests, 1)
  assert.equal(d.pendingAUs.length, 0)
  assert.equal(d.pendingBytes, 0)
  assert.equal(d.needsKey, true)
  assert.equal(d.closed, false)
 })

// 总压缩字节也必须受限，不能只以帧数限制异常的大图像
 test('pending compressed byte limit resets without keeping a partial dependency chain', async t => {
  const d = new LowLatencyDecoder({ Decoder, maxQueue: 1, Chunk: class { constructor(x) { Object.assign(this,x) } }, requestFrame: () => 1, cancelFrame: () => {} })
  t.after(() => d.close())
  await d.accept(au(true))
  const large = { ...au(false), data: new Uint8Array(3 * 1024 * 1024) }
  await d.accept(large)
  await d.accept(large)
  assert.equal(d.stats.resets, 1)
  assert.equal(d.pendingBytes, 0)
  assert.equal(d.pendingAUs.length, 0)
 })

// 尚未获得原生输出时关闭页面必须清理等待队列和全部定时器
 test('close during queued admission cannot resume or request refresh later', async () => {
  let requests = 0
  const d = new LowLatencyDecoder({ Decoder, maxQueue: 1, pendingTimeoutMs: 15, onIDR: () => requests++, Chunk: class { constructor(x) { Object.assign(this,x) } }, requestFrame: () => 1, cancelFrame: () => {} })
  await d.accept(au(true))
  await d.accept(au(false))
  d.close()
  await new Promise(resolve => setTimeout(resolve, 35))
  assert.equal(requests, 0)
  assert.equal(d.pendingBytes, 0)
  assert.equal(d.pendingAUs.length, 0)
 })
