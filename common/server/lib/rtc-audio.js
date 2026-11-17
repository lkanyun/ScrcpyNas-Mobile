// Modified in the Mobile Remote derivative (2026): mobile UI, media transport or recovery changes; see MODIFICATIONS.md.
'use strict'
const crypto = require('node:crypto')
const { networkOptions } = require('./rtc-network')
const { iceCredentials } = require('./rtc-packetizer')

// 从 Opus 包头计算采样数 RTP 时钟不能沿用安卓带有调度抖动的时间戳
function opusSamples(payload) {
  if (!payload.length) throw new Error('空 Opus 包')
  const config = payload[0] >> 3, code = payload[0] & 3
  const frame = config >= 16 ? 120 << (config & 3) : config >= 12 ? 480 << (config & 1) : [480, 960, 1920, 2880][config & 3]
  const count = code === 0 ? 1 : code === 3 ? (payload[1] || 0) & 63 : 2
  const samples = frame * count
  if (!samples || samples > 5760) throw new Error('无效 Opus 帧时长')
  return samples
}

// 独立音频进程直接封装已编码 Opus 不把实时声音送回视频进程
function createRtcAudio({ config, signal, failed }) {
  const rtc = require('werift')
  const pc = new rtc.RTCPeerConnection({
    codecs: { audio: [new rtc.RTCRtpCodecParameters({ mimeType: 'audio/opus', clockRate: 48000, channels: 2, payloadType: 111, parameters: 'minptime=10;stereo=1;sprop-stereo=1' })] },
    bundlePolicy: 'max-bundle', iceServers: iceCredentials(config), ...networkOptions(config),
  })
  const track = new rtc.MediaStreamTrack({ kind: 'audio' })
  pc.addTransceiver(track, { direction: 'sendonly' })
  let closed = false, ready = false, offered = false, closing, offering
  let sequence = crypto.randomBytes(2).readUInt16BE()
  const ssrc = crypto.randomBytes(4).readUInt32BE()
  const baseTimestamp = crypto.randomBytes(4).readUInt32BE()
  let elapsedSamples = 0, reportedAt = 0
  pc.connectionStateChange.subscribe(state => {
    ready = state === 'connected'
    if (state === 'failed' && !closed) failed()
  })
  // 等待源格式确认后协商 浏览器与服务端共享标准 ICE 回退
  async function offer() {
    if (closed || offered) return
    offered = true
    try {
      offering = (async () => { await pc.setLocalDescription(await pc.createOffer()) })()
      await offering
      if (!closed) signal({ rtc: 'audio-offer', sdp: pc.localDescription.sdp, iceServers: iceCredentials(config) })
    } catch (_) { if (!closed) failed() }
  }
  // 限定协商消息 防止音频端点成为任意控制通道
  async function receive(message) {
    if (closed) return
    // 只记录有界数值 用于区分网络丢包补偿和播放器暂停
    if (message.rtc === 'audio-stats' && Date.now() - reportedAt >= 9000) {
      reportedAt = Date.now()
      // 缺失或越界指标保留为空 不把浏览器上报当作可信控制参数
      const number = value => Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER ? value : null
      console.info('[rtc-audio]', JSON.stringify({ path: ['lan', 'direct', 'wan', 'unknown'].includes(message.path) ? message.path : 'unknown', bytes: number(message.bytes), concealed: number(message.concealed), jitterMs: number(message.jitterMs) }))
      return
    }
    if (message.rtc === 'audio-answer' && typeof message.sdp === 'string' && message.sdp.length <= 65536) await pc.setRemoteDescription({ type: 'answer', sdp: message.sdp })
    else if (message.rtc === 'audio-ice' && message.candidate && JSON.stringify(message.candidate).length < 4096) await pc.addIceCandidate(message.candidate)
  }
  // 每包按照编码帧实际采样数推进时钟 避免源时间戳抖动触发重叠丢弃和电音
  function packet(frame) {
    if (closed || !ready || frame.length < 13 || frame.length > 8204 || frame.readUInt32BE(8) !== frame.length - 12 || frame[0] & 128) return
    const payload = frame.subarray(12)
    let samples
    try { samples = opusSamples(payload) } catch (_) { failed(); return }
    const timestamp = (baseTimestamp + elapsedSamples) >>> 0
    track.writeRtp(new rtc.RtpPacket(new rtc.RtpHeader({ payloadType: 111, sequenceNumber: sequence, timestamp, ssrc, marker: elapsedSamples === 0 }), Buffer.from(payload)))
    elapsedSamples = (elapsedSamples + samples) >>> 0
    sequence = (sequence + 1) & 65535
  }
  // 释放独立媒体连接和中继分配 不关闭共享安卓采集器
  function close() {
    if (closing) return closing
    closed = true; ready = false
    closing = (async () => {
      await offering?.catch(() => {})
      const turns = new Set(pc.iceTransports.flatMap(transport => transport.connection.protocols.map(protocol => protocol.turn).filter(Boolean)))
      await Promise.allSettled([...turns].map(turn => turn.request(new rtc.Message(rtc.methods.REFRESH, rtc.classes.REQUEST).setAttribute('LIFETIME', 0), turn.server, undefined, 0)))
      await pc.close()
    })()
    return closing
  }
  return { offer, receive, packet, close, pc }
}
module.exports = { createRtcAudio, opusSamples }
