// Modified in the Mobile Remote derivative (2026): mobile UI, media transport or recovery changes; see MODIFICATIONS.md.
'use strict'
const crypto = require('node:crypto')
const { networkOptions } = require('./rtc-network')
const { splitNals, packetize, iceCredentials } = require('./rtc-packetizer')
// 每个浏览器只持有独立传输对象 编码源仍归既有温会话管理
function createRtcMedia({ config, signal, control, requestKey, failed, readOnly = false }) {
  const rtc = require('werift')
  const iceServers = iceCredentials(config)
  const pc = new rtc.RTCPeerConnection({
    codecs: { video: [new rtc.RTCRtpCodecParameters({ mimeType: 'video/H264', clockRate: 90000, payloadType: 96,
      parameters: 'level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e02a',
      rtcpFeedback: [{ type: 'nack' }, { type: 'nack', parameter: 'pli' }, { type: 'goog-remb' }] })] },
    bundlePolicy: 'max-bundle',
    iceServers, ...networkOptions(config),
  })
  const track = new rtc.MediaStreamTrack({ kind: 'video' })
  pc.addTransceiver(track, { direction: 'sendonly' })
  const channel = readOnly ? null : pc.createDataChannel('control', { ordered: true })
  const state = { seq: crypto.randomBytes(2).readUInt16BE(), ssrc: crypto.randomBytes(4).readUInt32BE() }
  let closed = false, connected = false, offered = false, awaitingKey = true, sps, pps, lastKey = 0
  let closing, offering, startupRetry
  const stages = {}
  let clientReported = false, firstPacket = false
  let lastTimestamp = 0
  let receiveLevel = 42
  let lastReport = 0
  // 固定窗口只累计数字 不保留编码数据或画面
  let metricAt = Date.now(), metricFrames = 0, metricBytes = 0, metricKeys = 0, metricKeyBytes = 0, metricMax = 0
  let previousKeyAt = 0, metricGaps = 0, metricGapSum = 0
  const started = process.hrtime.bigint()
  // 使用同一单调时钟记录首屏各阶段 不记录地址或媒体
  function mark(name) { if (stages[name] == null) stages[name] = Math.round(Number(process.hrtime.bigint() - started) / 1e6) }
  // 对关键帧请求限频 避免丢包反馈反复重启编码器
  function needKey() {
    awaitingKey = true
    if (Date.now() - lastKey < 1000) return
    if (requestKey() === false) return false
    lastKey = Date.now()
    mark('keyRequested')
    return true
  }
  track.onReceiveRtcp.subscribe(packet => {
    if (packet.feedback instanceof rtc.PictureLossIndication) needKey()
  })
  channel?.onMessage.subscribe(data => {
    if (closed || !connected || !Buffer.isBuffer(data) || data.length > 65536) return
    control(data)
  })
  pc.connectionStateChange.subscribe(value => {
    connected = value === 'connected'
    if (connected) {
      mark('connected')
      if (needKey() === false && !firstPacket) {
        let attempts = 0
        clearInterval(startupRetry)
        // 设置命令尚未就绪时有限重试 不反复重建已发出请求的编码器
        startupRetry = setInterval(() => {
          if (closed || !connected || firstPacket || ++attempts > 8 || needKey() !== false) clearInterval(startupRetry)
        }, 125)
      }
    }
    if (value === 'failed' && !closed) failed('webrtc-connection-failed')
  })
  // 完整收集候选后发送一次协商 避免浏览器晚到候选竞态
  async function offer() {
    if (offered || closed) return
    offered = true
    try {
      offering = (async () => { await pc.setLocalDescription(await pc.createOffer()) })()
      await offering
      mark('offerReady')
      if (!closed) signal({ rtc: 'offer', sdp: pc.localDescription.sdp, iceServers })
    } catch (_) { if (!closed) failed('webrtc-offer-failed') }
  }
  // 仅接受当前认证连接的有限协商消息
  async function receive(message) {
    if (closed) return
    if (message.rtc === 'startup' && !clientReported && message.phases && typeof message.phases === 'object') {
      clientReported = true
      const client = {}
      for (const key of ['socketCreated', 'socketOpen', 'offerReceived', 'answerSent', 'transportConnected', 'firstFrame']) {
        const value = message.phases[key]
        if (Number.isFinite(value) && value >= 0 && value <= 120000) client[key] = Math.round(value)
      }
      console.info('[rtc-startup]', JSON.stringify({ server: stages, client }))
      return
    }
    // 限频记录数值诊断 不保存地址 令牌或媒体内容
    if (message.rtc === 'stats' && Date.now() - lastReport >= 9000) {
      lastReport = Date.now()
      const number = (value, maximum) => Number.isFinite(value) && value >= 0 && value <= maximum ? value : null
      console.info('[rtc-path]', JSON.stringify({ network: ['lan', 'direct', 'wan', 'unknown'].includes(message.network) ? message.network : 'unknown', rtt: number(message.rtt, 60000), loss: number(message.loss, 1), fps: number(message.fps, 240) }))
      return
    }
    if (message.rtc === 'answer' && typeof message.sdp === 'string' && message.sdp.length <= 65536) {
      mark('answerReceived')
      receiveLevel = require('../public/adaptive-quality').negotiatedLevel(message.sdp)
      await pc.setRemoteDescription({ type: 'answer', sdp: message.sdp })
    }
    else if (message.rtc === 'ice' && message.candidate && JSON.stringify(message.candidate).length < 4096) await pc.addIceCandidate(message.candidate)
  }
  // 旧引擎提供完整图像边界 本机单调时钟用于无源时间戳的 RTP 时钟
  function video(data) {
    if (closed) return
    const nals = splitNals(data)
    for (const nal of nals) {
      const type = nal[0] & 31
      if (type === 7) sps = Buffer.from(nal)
      if (type === 8) pps = Buffer.from(nal)
    }
    // 协商的约束基线必须由真实码流确认 不将旧 High 流冒充基线
    if (!sps || !pps || sps[1] !== 66 || sps[3] > receiveLevel) return
    mark('sourceReady')
    const key = nals.some(nal => (nal[0] & 31) === 5)
    const picture = nals.some(nal => [1,5].includes(nal[0] & 31))
    if (!connected || !picture || (awaitingKey && !key)) return
    if (key) awaitingKey = false
    if (!firstPacket) { firstPacket = true; clearInterval(startupRetry); mark('firstRtp') }
    // 统计实际发送的视频帧 用于区分平均负载与关键帧突发
    const metricNow = Date.now()
    metricFrames++; metricBytes += data.length; metricMax = Math.max(metricMax, data.length)
    if (key) {
      metricKeys++; metricKeyBytes += data.length
      if (previousKeyAt) { metricGaps++; metricGapSum += metricNow - previousKeyAt }
      previousKeyAt = metricNow
    }
    if (metricNow - metricAt >= 10000) {
      const elapsed = metricNow - metricAt
      console.info('[rtc-frames]', JSON.stringify({ ms: elapsed, frames: metricFrames, kbps: Math.round(metricBytes * 8 / elapsed),
        keys: metricKeys, keyPercent: Math.round(metricKeyBytes / metricBytes * 1000) / 10, maxFrameBytes: metricMax,
        keyIntervalMs: metricGaps ? Math.round(metricGapSum / metricGaps) : null }))
      metricAt = metricNow; metricFrames = 0; metricBytes = 0; metricKeys = 0; metricKeyBytes = 0; metricMax = 0; metricGaps = 0; metricGapSum = 0
    }
    const timestamp = Math.max(lastTimestamp + 1, Number((process.hrtime.bigint() - started) * 9n / 100000n))
    lastTimestamp = timestamp
    const payload = key ? [sps, pps, ...nals.filter(nal => ![7,8].includes(nal[0] & 31))] : nals
    for (const packet of packetize(payload, timestamp >>> 0, state, rtc)) track.writeRtp(packet)
  }
  // 传输关闭立即释放 UDP 与中继分配 迟到异步回调不复活旧会话
  function close() {
    if (closing) return closing
    closed = true
    connected = false
    clearInterval(startupRetry)
    closing = (async () => {
      await offering?.catch(() => {})
      // 主动归还中继配额 不等待服务器端分配超时
      const turns = new Set(pc.iceTransports.flatMap(transport => transport.connection.protocols.map(protocol => protocol.turn).filter(Boolean)))
      await Promise.allSettled([...turns].map(turn => turn.request(new rtc.Message(rtc.methods.REFRESH, rtc.classes.REQUEST).setAttribute('LIFETIME', 0), turn.server, undefined, 0)))
      await pc.close()
    })()
    return closing
  }
  // 认证绑定完成即协商 与上游启动和编码参数准备并行
  queueMicrotask(offer)
  return { video, receive, close, pc }
}
module.exports = { createRtcMedia }
