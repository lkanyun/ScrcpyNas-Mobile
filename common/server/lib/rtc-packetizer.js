// Modified in the Mobile Remote derivative (2026): mobile UI, media transport or recovery changes; see MODIFICATIONS.md.
'use strict'
const crypto = require('node:crypto')
// 拆分已审计编码缓冲的 AnnexB 单元 不拼接相邻图像
function splitNals(data) {
  if (!data.length || data.length > 4 * 1024 * 1024) throw Error('Invalid video buffer')
  const starts = []
  for (let index = 0; index + 2 < data.length; index++) {
    if (!data[index] && !data[index + 1] && data[index + 2] === 1) {
      starts.push({ start: index > 0 && !data[index - 1] ? index - 1 : index, data: index + 3 })
      index += 2
    }
  }
  if (!starts.length || starts[0].start !== 0) throw Error('Invalid AnnexB')
  return starts.map((start,index) => {
    const nal = data.subarray(start.data, starts[index + 1]?.start)
    if (nal.length < 2 || nal[0] & 128) throw Error('Invalid NAL')
    return nal
  })
}
// 使用标准单包和分片包 尾标记只放在完整图像的最后一包
function packetize(nals, timestamp, state, { RtpHeader, RtpPacket }) {
  const packets = []
  // 分配每条流独立的序列号并在边界回绕
  function append(payload, marker) {
    packets.push(new RtpPacket(new RtpHeader({ payloadType: 96, sequenceNumber: state.seq, ssrc: state.ssrc, timestamp, marker }), Buffer.from(payload)))
    state.seq = (state.seq + 1) & 65535
  }
  nals.forEach((nal, index) => {
    const last = index === nals.length - 1
    if (nal.length <= 1100) return append(nal, last)
    for (let offset = 1; offset < nal.length; offset += 1098) {
      const end = Math.min(offset + 1098, nal.length)
      const header = Buffer.from([(nal[0] & 224) | 28, (nal[0] & 31) | (offset === 1 ? 128 : 0) | (end === nal.length ? 64 : 0)])
      append(Buffer.concat([header, nal.subarray(offset, end)]), last && end === nal.length)
    }
  })
  return packets
}
// 为短期中继认证生成标准 REST 凭据 不向客户端泄露共享密钥
function iceCredentials(config, now = Date.now()) {
  const username = Math.floor(now / 1000 + 3600) + ':' + crypto.randomBytes(8).toString('hex')
  const credential = crypto.createHmac('sha1', config.secret).update(username).digest('base64')
  const servers = [{ urls: `turn:${config.host}:${config.port}?transport=udp`, username, credential }, { urls: `stun:${config.host}:${config.port}` }]
  // 补齐浏览器公网地址发现 不移除原有中转凭据
  if (require('./rtc-network').ipv6State(config)) servers.push({ urls: 'stun:[2606:4700:49::]:3478' }, { urls: 'stun:[2001:4860:4864:5:8000::1]:19302' })
  return servers
}
module.exports = { splitNals, packetize, iceCredentials }
