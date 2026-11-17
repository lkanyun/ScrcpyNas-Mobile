// Modified in the Mobile Remote derivative (2026): mobile UI, media transport or recovery changes; see MODIFICATIONS.md.
'use strict'
const fs = require('node:fs')
const os = require('node:os')
const net = require('node:net')
// 仅使用仍在本机且租约有效的专用地址 配置失效自动保留原有传输
function ipv6State(config) {
  if (!config.ipv6StateFile) return null
  try {
    const state = JSON.parse(fs.readFileSync(config.ipv6StateFile, 'utf8'))
    if (!net.isIPv6(state.address) || !/^[23]/.test(state.address) || !Number.isFinite(state.expiresAt) || state.expiresAt <= Date.now()) return null
    if (!Array.isArray(state.portRange) || state.portRange.length !== 2 || !state.portRange.every(Number.isInteger) || state.portRange[0] < 1024 || state.portRange[1] > 65535 || state.portRange[0] > state.portRange[1]) return null
    if (!Object.values(os.networkInterfaces()).flat().some(item => item?.address === state.address)) return null
    return state
  } catch (_) { return null }
}
// 网络选项独立于音视频编码 继续提供内网和中转候选
function networkOptions(config) {
  const state = ipv6State(config)
  const addresses = net.isIPv4(config.bindAddress || '') ? { udp4: config.bindAddress } : {}
  if (state) addresses.udp6 = state.address
  return { iceUseIpv4: true, iceUseIpv6: !!state, iceTransportPolicy: 'all',
    iceInterfaceAddresses: Object.keys(addresses).length ? addresses : undefined,
    ...(state ? { icePortRange: state.portRange } : {}) }
}
module.exports = { ipv6State, networkOptions }
