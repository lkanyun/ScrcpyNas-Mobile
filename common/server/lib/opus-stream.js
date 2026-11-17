// Modified in the Mobile Remote derivative (2026): mobile UI, media transport or recovery changes; see MODIFICATIONS.md.
'use strict'

// 增量解析官方音频帧并限制异常声明长度 防止等待无限缓存
function createOpusParser(onFormat, onPacket) {
  let pending = Buffer.alloc(0)
  let formatted = false
  // 配置帧只用于初始化 不进入音频解码器
  function push(data) {
    pending = pending.length ? Buffer.concat([pending, data]) : data
    while (pending.length >= 12) {
      const flags = pending.readBigUInt64BE()
      const config = Boolean(flags & (1n << 63n))
      const length = pending.readUInt32BE(8)
      if (!length || length > (config ? 128 : 8192)) throw new Error('无效的 Opus 帧长度')
      if (pending.length < length + 12) break
      const frame = pending.subarray(0, length + 12)
      const payload = frame.subarray(12)
      pending = pending.subarray(length + 12)
      if (config) {
        if (payload.length !== 19 || payload.toString('ascii', 0, 8) !== 'OpusHead' || payload[8] !== 1 || ![1, 2].includes(payload[9]) || payload[18] !== 0) throw new Error('不支持的 Opus 配置')
        formatted = true
        onFormat({ type: 'format', codec: 'opus', sampleRate: 48000, channels: payload[9], preSkip: payload.readUInt16LE(10), bitrate: 96000 })
      } else {
        if (!formatted) throw new Error('缺少 Opus 配置')
        onPacket(frame)
      }
    }
    pending = Buffer.from(pending)
  }
  return { push }
}

module.exports = { createOpusParser }
