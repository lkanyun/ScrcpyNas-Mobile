// Modified in the Mobile Remote derivative (2026): mobile UI, media transport or recovery changes; see MODIFICATIONS.md.
// 根据实际媒体路径与接收统计选择画质 不把同一域名或低 RTT 当成局域网证明
;(function (root) {
  'use strict'
  const profiles = {
    lan: [[1920, 6000000, 60], [1600, 4500000, 60], [1280, 3200000, 60], [960, 2200000, 60], [720, 1400000, 60]],
    direct: [[1920, 6000000, 60], [1600, 4500000, 60], [1280, 2800000, 60], [960, 1600000, 60], [720, 900000, 30]],
    wan: [[1280, 2800000, 60], [960, 2200000, 60], [960, 1600000, 30], [720, 1000000, 30], [720, 600000, 24]]
  }
  // 仅识别确定的私网地址 不把公网直连和隐藏地址误判为内网
  function privateAddress(address) {
    if (typeof address !== 'string') return false
    const parts = address.split('.').map(Number)
    if (/^\d+\.\d+\.\d+\.\d+$/.test(address) && parts.length === 4 && parts.every(value => Number.isInteger(value) && value >= 0 && value <= 255)) {
      return parts[0] === 10 || parts[0] === 192 && parts[1] === 168 || parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31
    }
    return /^(fc|fd)[0-9a-f]{2}:/i.test(address)
  }
  // 只检查选中的候选对 不使用未被采用的内网候选
  function networkPath(pair, candidates, remoteSdp = '') {
    if (!pair) return 'unknown'
    if (candidates.some(value => value.candidateType === 'relay')) return 'wan'
    const remote = candidates.find(value => value.id === pair.remoteCandidateId)
    let address = remote?.address || remote?.ip
    // WebKit 隐藏统计地址时 用已协商 SDP 中相同基础标识 端口和协议的候选补齐
    if (!address && remote?.foundation && remote?.port && remote?.protocol) {
      const candidate = String(remoteSdp).split(/\r?\n/).map(line => line.match(/^a=candidate:(\S+) \d+ (\S+) \d+ (\S+) (\d+) typ (\S+)/i)).find(value => value && value[1] === remote.foundation && Number(value[4]) === remote.port && value[2].toLowerCase() === remote.protocol.toLowerCase() && value[5] === remote.candidateType)
      address = candidate?.[3]
    }
    if (!remote || !address) return 'unknown'
    return privateAddress(address) ? 'lan' : 'direct'
  }
  // 从已协商的视频负载读取接收端支持的级别 缺失信息时保持兼容上限
  function negotiatedLevel(sdp) {
    const video = String(sdp || '').split(/(?=m=)/).find(section => section.startsWith('m=video')) || ''
    const match = video.match(/a=fmtp:96 [^\r\n]*profile-level-id=42[0-9a-f]{2}([0-9a-f]{2})/i)
    return match ? Math.min(42, parseInt(match[1], 16)) : 31
  }
  // 仅当浏览器明确报告实时高清解码流畅时提高接收声明 失败或超时沿用原生回答
  async function setReceiveAnswer(pc, capabilities, { timeoutMs = 600, compatible = false } = {}) {
    const answer = await pc.createAnswer()
    if (!compatible && negotiatedLevel(pc.remoteDescription?.sdp) >= 42 && negotiatedLevel(answer.sdp) < 42 && capabilities?.decodingInfo) {
      let timer
      let info
      try {
        info = await Promise.race([
          capabilities.decodingInfo({ type: 'webrtc', video: { contentType: 'video/H264;profile-level-id=42e02a;packetization-mode=1', width: 1920, height: 1080, bitrate: 6000000, framerate: 60 } }),
          new Promise(resolve => { timer = setTimeout(() => resolve(null), timeoutMs) })
        ])
      } catch (_) { /* 不支持能力查询时继续使用默认协商 */ } finally { clearTimeout(timer) }
      if (info?.supported === true && info?.smooth === true) {
        const sdp = answer.sdp.replace(/(a=fmtp:96 [^\r\n]*profile-level-id=42[0-9a-f]{2})[0-9a-f]{2}/i, '$12a')
        try { await pc.setLocalDescription({ type: answer.type, sdp }); return } catch (_) { /* 浏览器拒绝更高级别时保留原生声明 */ }
      }
    }
    await pc.setLocalDescription(answer)
  }
  // 每个连接独立计数 降档需要连续坏样本 升档要求更长的稳定期
  function createController(preference = {}) {
    let network = 'unknown', level = 31, index = 0, lanSamples = 0
    let goodSince = null, bad = 0, changedAt = -Infinity
    let mode = preference.mode === 'manual' ? 'manual' : 'auto'
    let manual = preference.values || {}
    // 给外网保留音频与协议余量 编码尺寸同时服从真实协商结果
    function settings() {
      const route = network === 'lan' ? 'lan' : network === 'direct' ? 'direct' : 'wan'
      const [maxSize, bitrate, maxFps] = profiles[route][index]
      const value = mode === 'manual' ? {
        maxSize: Number(manual.maxSize) || maxSize,
        bitrate: Number(manual.bitrate) || bitrate,
        maxFps: Number(manual.maxFps) || maxFps
      } : { maxSize, bitrate, maxFps }
      value.maxFps = Math.max(24, Math.min(value.maxFps, 60))
      value.bitrate = Math.max(500000, Math.min(value.bitrate, route !== 'wan' ? 6000000 : 2800000))
      const sizeLimit = level < 42 ? value.maxFps > 30 ? 960 : 1280 : route !== 'wan' ? 1920 : 1280
      value.maxSize = Math.max(720, Math.min(value.maxSize, sizeLimit))
      return value
    }
    // 手动配置与自动决策分开保存 自动调整不覆盖用户输入
    function setPreference(value) {
      mode = value.mode === 'manual' ? 'manual' : 'auto'
      manual = value.values || manual
      index = network === 'direct' ? 2 : 0; bad = 0; goodSince = null
    }
    // 浏览器完成协商后才放开高分辨率高帧率组合
    function setLevel(value) { level = Math.min(42, Number(value) || 31) }
    // 返回是否需要重新提交编码参数 静止画面与缺失统计不当作网络拥塞
    function observe(sample, now) {
      const before = JSON.stringify(settings())
      lanSamples = sample.network === 'lan' ? lanSamples + 1 : 0
      const next = sample.network === 'wan' ? 'wan' : sample.network === 'direct' ? 'direct' : sample.network === 'unknown' ? 'unknown' : lanSamples >= 2 ? 'lan' : network
      if (next !== network) { network = next; index = network === 'direct' ? 2 : 0; bad = 0; goodSince = null; changedAt = now }
      if (mode === 'auto' && sample.active) {
        const target = settings()
        const limited = Number.isFinite(sample.available) && sample.available > 0 && sample.available < target.bitrate * 1.15
        // 带宽估计会随静态画面的实际发送量下降 不能单凭估计低就认定链路拥塞
        const pressure = sample.loss > 0.005 || sample.rtt > (network === 'lan' ? 60 : 150)
        const congested = sample.loss > 0.025 || sample.rtt > (network === 'lan' ? 100 : 220) || sample.drop > 0.05 || pressure && (sample.jitterMs > 40 || limited)
        if (congested) {
          bad++; goodSince = null
          if (bad >= 2 && now - changedAt >= 8000 && index < profiles[network === 'direct' ? 'direct' : network === 'lan' ? 'lan' : 'wan'].length - 1) { index++; bad = 0; changedAt = now }
        } else {
          bad = 0
          const healthy = sample.loss != null && sample.loss < 0.005 && sample.rtt != null && sample.rtt < (network === 'lan' ? 40 : 150) && (sample.drop == null || sample.drop < 0.01)
          if (!healthy) goodSince = null
          else {
            if (goodSince == null) goodSince = now
            if (index > 0 && now - goodSince >= 30000 && now - changedAt >= 30000) { index--; changedAt = now; goodSince = null }
          }
        }
      }
      return before !== JSON.stringify(settings())
    }
    // 提供目标参数与模式供设置页回显 不把目标帧率冒充实测帧率
    function snapshot() { return { mode, network, level, index, ...settings() } }
    return { settings, observe, setPreference, setLevel, snapshot }
  }
  const api = { createController, privateAddress, networkPath, negotiatedLevel, setReceiveAnswer }
  if (typeof module !== 'undefined' && module.exports) module.exports = api
  else root.scrcpyNasAdaptiveQuality = api
})(typeof window === 'undefined' ? globalThis : window)
