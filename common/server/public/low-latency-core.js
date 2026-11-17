// Modified in the Mobile Remote derivative (2026): mobile UI, media transport or recovery changes; see MODIFICATIONS.md.
// 完整编码缓冲直交原生解码，不实现受限切片语法或等待下一张图像
;(function () {
'use strict'
// 限制单张压缩图像的瞬时分配
const LIMIT = 4 * 1024 * 1024

// 合并字节片段并限制瞬时分配
function concat(parts) {
  const n = parts.reduce((s, x) => s + x.length, 0)
  if (n > LIMIT) throw Error('h264-byte-limit')
  const out = new Uint8Array(n)
  let p = 0
  for (const x of parts) { out.set(x, p); p += x.length }
  return out
}

// 将 NAL 重组为解码器要求的 Annex-B 表示
function annex(nals) { return concat(nals.flatMap(x => [new Uint8Array([0, 0, 0, 1]), x])) }

// 原生解码器仅维护解码器有界队列和一张待绘帧，不构造 MP4 时间线
class LowLatencyDecoder {
  // 注入平台原生 API 与生命周期回调，测试时可控调度而不伪造媒体结果
  constructor({ Decoder = globalThis.VideoDecoder, Chunk = globalThis.EncodedVideoChunk, maxQueue = 4, maxPending = maxQueue * 4, pendingTimeoutMs = 250, onIDR = () => {}, onFallback = () => {}, onDraw = () => {}, onOutput = () => {}, onResize = () => {}, canvas, requestFrame = globalThis.requestAnimationFrame?.bind(globalThis), cancelFrame = globalThis.cancelAnimationFrame?.bind(globalThis), timeoutMs = 3000 } = {}) {
    Object.assign(this, { Decoder, Chunk, maxQueue, maxPending, pendingTimeoutMs, onIDR, onFallback, onDraw, onOutput, onResize, canvas, requestFrame, cancelFrame, timeoutMs })
    this.stats = { submitted: 0, output: 0, drawn: 0, dropped: 0, queueMax: 0, displayQueueMax: 0, resets: 0, idrRequests: 0, supports: [], types: { key: 0, delta: 0 }, timestampKind: 'receiver-monotonic-us-not-capture-PTS' }
    // 将连续失败预算与整个会话的累计诊断计数分开
    this.recoveryAttempts = 0
    this.stableDrawSince = null
    this.lastRecoveryDraw = null
    this.lastTimestamp = -1
    this.lastOutput = -1
    this.needsKey = true
    this.closed = false
    this.generation = 0
    this.arrivals = new Map()
    this.pendingAUs = []
    this.pendingBytes = 0
    this.newDecoder()
    this.arm('no-first-frame')
  }
  // 为每个解码器绑定独立世代，拒绝关闭或复位后迟到的输出
  newDecoder() {
    const generation = ++this.generation
    this.decoder = new this.Decoder({ output: frame => {
      if (this.closed || generation !== this.generation || frame.timestamp <= this.lastOutput) { frame.close(); return }
      this.lastOutput = frame.timestamp
      this.stats.output++
      this.onOutput()
      clearTimeout(this.timer)
      if (this.pendingFrame) { this.arrivals.delete(this.pendingFrame.timestamp); this.pendingFrame.close(); this.stats.dropped++ }
      this.pendingFrame = frame
      this.stats.displayQueueMax = 1
      if (!this.raf) this.raf = this.requestFrame(() => this.draw())
      void this.pumpPending()
    }, error: () => { if (!this.closed && generation === this.generation) this.fail('decoder-error') } })
    this.decoder.addEventListener?.('dequeue', () => {
      if (!this.closed && generation === this.generation) void this.pumpPending()
    })
  }
  // 保持一次有界等待，不因收到字节而无限延长
  arm(reason) {
    clearTimeout(this.timer)
    this.timer = setTimeout(() => this.fail(reason), this.timeoutMs)
  }
  // 探测真实 SPS 派生配置且禁止关闭后的异步 configure
  async configure(config, configKey = JSON.stringify(config)) {
    const generation = this.generation
    const result = await this.Decoder.isConfigSupported(config)
    if (this.closed || generation !== this.generation) return false
    this.stats.supports.push({ config, supported: result.supported })
    if (this.stats.supports.length > 16) this.stats.supports.shift()
    if (!result.supported) { this.fail('unsupported-config'); return false }
    this.decoder.configure(config)
    this.configKey = configKey
    this.needsKey = true
    return true
  }
  // 在拥塞时丢弃整个依赖链并用现有控制通道请求刷新，不乱丢单个 delta
  resync(requestIDR = true, discardPending = true) {
    this.stats.resets++
    this.stableDrawSince = null
    this.lastRecoveryDraw = null
    if (this.decoder.state !== 'closed') this.decoder.close()
    this.newDecoder()
    if (discardPending) {
      clearTimeout(this.pendingTimer)
      this.pendingAUs = []
      this.pendingBytes = 0
    }
    this.configKey = null
    this.needsKey = true
    this.arrivals.clear()
    if (this.pendingFrame) { this.pendingFrame.close(); this.pendingFrame = null }
    if (!requestIDR) this.arm('configuration-no-frame')
    if (requestIDR && !this.awaitingIDR) {
      this.awaitingIDR = true
      if (++this.recoveryAttempts > 2) { this.fail('idr-budget-exhausted'); return }
      this.stats.idrRequests++
      this.onIDR()
      this.arm('idr-timeout')
    }
  }
  // 对短时到帧突发进行有界接纳，不等待下一图像才提交当前图像
  async accept(au, arrival = performance.now()) {
    if (this.closed) return false
    if (this.pendingAUs.length >= this.maxPending || this.pendingBytes + au.data.length > LIMIT) {
      this.stats.dropped += this.pendingAUs.length + 1
      this.resync()
      return false
    }
    this.pendingAUs.push({ au, arrival, queuedAt: performance.now() })
    this.pendingBytes += au.data.length
    return this.pumpPending()
  }
  // 原生出队或出帧后按输入顺序提交，等待超时才放弃整条依赖链
  pumpPending() {
    if (this.closed) return false
    clearTimeout(this.pendingTimer)
    const next = this.pendingAUs[0]
    if (!next) return false
    const remaining = this.pendingTimeoutMs - (performance.now() - next.queuedAt)
    if (remaining <= 0) {
      this.stats.dropped += this.pendingAUs.length
      this.resync()
      return false
    }
    this.pendingTimer = setTimeout(() => this.pumpPending(), remaining)
    if (this.busy || this.decoder.decodeQueueSize >= this.maxQueue || this.arrivals.size >= this.maxQueue + 2) return false
    this.pendingAUs.shift()
    this.pendingBytes -= next.au.data.length
    if (!this.pendingAUs.length) clearTimeout(this.pendingTimer)
    return this.submit(next.au, next.arrival)
  }
  // 串行提交完整图像并隔离异步配置，时间戳仅用于接收端排序
  async submit(au, arrival) {
    this.busy = true
    try {
      const configKey = JSON.stringify([au.config, au.configurationId])
      if (this.configKey && this.configKey !== configKey) this.resync(!au.key, false)
      if (this.closed) return false
      if (this.needsKey && !au.key) {
        if (!this.awaitingIDR) this.resync()
        this.stats.dropped++
        return false
      }
      if (this.configKey !== configKey) {
        if (!au.key) { this.resync(); this.stats.dropped++; return false }
        if (!(await this.configure(au.config, configKey))) return false
      }
      if (this.closed) return false
      if (this.needsKey && !au.key) { this.stats.dropped++; return false }
      const timestamp = Math.max(this.lastTimestamp + 1, Math.round(arrival * 1000))
      this.lastTimestamp = timestamp
      const type = au.key ? 'key' : 'delta'
      this.arrivals.set(timestamp, arrival)
      this.decoder.decode(new this.Chunk({ type, timestamp, data: au.data }))
      this.needsKey = false
      if (au.key) this.awaitingIDR = false
      this.stats.submitted++
      this.stats.types[type]++
      this.stats.queueMax = Math.max(this.stats.queueMax, this.decoder.decodeQueueSize)
      return true
    } catch (_) { this.fail('decode-submit-error'); return false }
    finally {
      this.busy = false
      void this.pumpPending()
    }
  }
  // 仅绘制最新帧并立即释放原生资源，尺寸变更交给既有几何层
  draw() {
    this.raf = null
    const frame = this.pendingFrame
    this.pendingFrame = null
    if (!frame) return
    try {
      if (this.closed) return
      if (this.canvas && (this.canvas.width !== frame.displayWidth || this.canvas.height !== frame.displayHeight)) {
        this.onResize(frame.displayWidth, frame.displayHeight)
        this.canvas.width = frame.displayWidth
        this.canvas.height = frame.displayHeight
      }
      this.canvas?.getContext('2d').drawImage(frame, 0, 0)
      this.stats.drawn++
      // 只有连续真实绘制才能恢复预算，单个关键帧或接收字节不能刷新
      const now = performance.now()
      if (this.lastRecoveryDraw === null || now - this.lastRecoveryDraw > 500) this.stableDrawSince = now
      this.lastRecoveryDraw = now
      if (now - this.stableDrawSince >= 5000) this.recoveryAttempts = 0
      this.onDraw({ timestamp: frame.timestamp, arrival: this.arrivals.get(frame.timestamp), at: performance.now(), width: frame.displayWidth, height: frame.displayHeight })
      this.arrivals.delete(frame.timestamp)
      void this.pumpPending()
    } finally { frame.close() }
  }
  // 所有终止失败只通知一次，外部不自动切换播放器或重启后端
  fail(reason) {
    if (this.closed) return
    this.close()
    this.onFallback(reason)
  }
  // 关闭解码与待绘资源，不保留可回放的帧对象
  close() {
    if (this.closed) return
    this.closed = true
    this.generation++
    clearTimeout(this.timer)
    clearTimeout(this.pendingTimer)
    if (this.raf) this.cancelFrame(this.raf)
    this.raf = null
    if (this.pendingFrame) this.pendingFrame.close()
    this.pendingFrame = null
    this.arrivals.clear()
    this.pendingAUs = []
    this.pendingBytes = 0
    if (this.decoder.state !== 'closed') this.decoder.close()
  }
}

// 仅适配已审计旧 JAR 的完整 MediaCodec 缓冲消息，不接收任意网络字节分片
class LegacyAccessUnitAdapter {
  // 参数集由编码器配置缓冲提供，完整语法交给原生 H264 解码器处理
  constructor(output, onNeedKey = () => {}) {
    this.output = output
    this.onNeedKey = onNeedKey
    this.sps = []
    this.pps = []
    this.configurationId = 0
  }
  // 使用消息终点结束最后一个 NAL，不能为旧连续流调用此接口
  push(bytes) {
    if (!bytes.length || bytes.length > LIMIT) throw Error('h264-byte-limit')
    const starts = []
    for (let i = 0; i + 2 < bytes.length; i++) {
      if (bytes[i] === 0 && bytes[i + 1] === 0 && bytes[i + 2] === 1) {
        starts.push({ start: i > 0 && bytes[i - 1] === 0 ? i - 1 : i, data: i + 3 })
        i += 2
      }
    }
    if (!starts.length || starts[0].start !== 0) throw Error('invalid-annexb-message')
    const sets = { 7: [], 8: [] }
    let key = false, delta = false, slices = 0
    for (let i = 0; i < starts.length; i++) {
      const nal = bytes.subarray(starts[i].data, starts[i + 1]?.start)
      if (nal.length < 2 || (nal[0] & 128)) throw Error('invalid-nal')
      const type = nal[0] & 31
      if (type === 7 || type === 8) sets[type].push(nal.slice())
      else if (type === 1 || type === 5) { slices++; key ||= type === 5; delta ||= type === 1 }
      else if (![6, 9, 10, 11, 12].includes(type)) throw Error('unsupported-nal-type')
    }
    if (key && delta) throw Error('mixed-picture-types')
    const nextSps = sets[7].length ? sets[7] : this.sps
    const nextPps = sets[8].length ? sets[8] : this.pps
    if ([...nextSps, ...nextPps].reduce((total, nal) => total + nal.length + 4, 0) > 65536) throw Error('configuration-byte-limit')
    this.sps = nextSps
    this.pps = nextPps
    if (this.sps.length && this.pps.length) {
      const parameters = annex([...this.sps, ...this.pps])
      const signature = [...parameters].join(',')
      if (signature !== this.signature) { this.signature = signature; this.configurationId++ }
      // codec 字符串只需 SPS 规范固定头；尺寸与 CABAC 等完整语法由原生解析
      const nal = this.sps[0]
      if (nal.length < 4 || (nal[2] & 3)) throw Error('invalid-sps-header')
      this.config = { codec: 'avc1.' + [...nal.subarray(1, 4)].map(x => x.toString(16).padStart(2, '0')).join('').toUpperCase(), optimizeForLatency: true }
    }
    if (!slices) return
    if (!this.config) { this.onNeedKey(); return }
    this.output({ key, slices, configurationId: this.configurationId, config: this.config, data: key ? concat([annex([...this.sps, ...this.pps]), bytes]) : bytes.slice() })
  }
}

window.scrcpyNasLowLatencyCore = { LegacyAccessUnitAdapter, LowLatencyDecoder }
})()
