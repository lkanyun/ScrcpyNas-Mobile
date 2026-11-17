// Modified in the Mobile Remote derivative (2026): mobile UI, media transport or recovery changes; see MODIFICATIONS.md.
'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createController, networkPath, negotiatedLevel, privateAddress, setReceiveAnswer } = require('../public/adaptive-quality')

// 测试仅使用合成统计 不访问真实设备或网络
const healthy = { network: 'wan', active: true, rtt: 30, loss: 0, jitterMs: 4, drop: 0, decodeMs: 2, available: null }
// 高级别接收声明必须有能力依据 拒绝 超时和已触发兼容回退都不能反复强推
test('HD negotiation requires smooth WebRTC capability and falls back on unsupported answers', async () => {
  const base = 'm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=fmtp:96 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f\r\n'
  for (const variant of ['supported', 'unsupported', 'not-smooth', 'throws', 'timeout', 'reject', 'compatible']) {
    const attempts = []
    const pc = {
      remoteDescription: { sdp: base.replace('42e01f', '42e02a') },
      async createAnswer() { return { type: 'answer', sdp: base } },
      async setLocalDescription(value) { attempts.push(value.sdp); if (variant === 'reject' && negotiatedLevel(value.sdp) === 42) throw Error('not accepted'); this.localDescription = value }
    }
    const capabilities = { async decodingInfo(config) {
      assert.equal(config.type, 'webrtc')
      if (variant === 'throws') throw Error('unavailable')
      if (variant === 'timeout') return new Promise(() => {})
      return { supported: variant !== 'unsupported', smooth: variant !== 'not-smooth' }
    } }
    await setReceiveAnswer(pc, capabilities, { timeoutMs: 5, compatible: variant === 'compatible' })
    assert.equal(negotiatedLevel(pc.localDescription.sdp), variant === 'supported' ? 42 : 31, variant)
    if (variant === 'reject') assert.equal(attempts.length, 2)
  }
})
test('only the selected private host path qualifies as LAN', () => {
  const pair = { remoteCandidateId: 'remote' }
  assert.equal(networkPath(pair, [{ id: 'remote', address: '192.168.9.9', candidateType: 'host' }]), 'lan')
  assert.equal(networkPath(pair, [{ id: 'remote', address: '192.168.9.9', candidateType: 'host' }, { candidateType: 'relay' }]), 'wan')
  assert.equal(networkPath(pair, [{ id: 'unused', address: '192.168.9.9', candidateType: 'host' }, { id: 'remote', address: '203.0.113.9', candidateType: 'srflx' }]), 'direct')
  assert.equal(networkPath(pair, [{ id: 'remote', candidateType: 'host' }]), 'unknown')
  assert.equal(networkPath(null, []), 'unknown')
  assert.equal(privateAddress('10..0.1'), false)
  const hidden = [{ id: 'remote', candidateType: 'host', foundation: 'selected', port: 4567, protocol: 'udp' }]
  const sdp = 'a=candidate:unused 1 udp 1 192.168.9.8 4567 typ host\r\na=candidate:selected 1 udp 1 192.168.9.9 4567 typ host\r\n'
  assert.equal(networkPath(pair, hidden, sdp), 'lan')
  assert.equal(networkPath(pair, hidden, sdp.replace('selected', 'different')), 'unknown')
})

// 空闲画面让接收带宽估计变低时 仍以实际丢包与延迟判断拥塞
test('low receiver bandwidth estimate without loss or latency does not lower quality', () => {
  const controller = createController()
  controller.setLevel(42)
  for (let now = 0; now < 90000; now += 2000) controller.observe({ ...healthy, network: 'lan', available: 500000 }, now)
  assert.equal(controller.snapshot().index, 0)
  assert.equal(controller.settings().bitrate, 6000000)
})
test('negotiated codec level gates high resolution and cold start stays within WAN budget', () => {
  const controller = createController()
  assert.deepEqual(controller.settings(), { maxSize: 960, bitrate: 2800000, maxFps: 60 })
  controller.observe({ ...healthy, network: 'lan' }, 0)
  controller.observe({ ...healthy, network: 'lan' }, 2000)
  assert.equal(controller.settings().maxSize, 960)
  controller.setLevel(42)
  assert.deepEqual(controller.settings(), { maxSize: 1920, bitrate: 6000000, maxFps: 60 })
  controller.observe(healthy, 4000)
  assert.deepEqual(controller.settings(), { maxSize: 1280, bitrate: 2800000, maxFps: 60 })
  assert.equal(negotiatedLevel('m=video 9 UDP/TLS/RTP/SAVPF 96\r\na=fmtp:96 packetization-mode=1;profile-level-id=42e02a\r\n'), 42)
  assert.equal(negotiatedLevel('m=video 9 UDP/TLS/RTP/SAVPF 96\r\na=fmtp:96 profile-level-id=42e01f\r\n'), 31)
  assert.equal(negotiatedLevel(''), 31)
})
test('persistent congestion lowers quality, sustained recovery raises one step, static video stays stable', () => {
  const controller = createController()
  controller.setLevel(42)
  controller.observe(healthy, 0)
  controller.observe({ ...healthy, loss: 0.08 }, 8000)
  assert.equal(controller.snapshot().index, 0)
  controller.observe({ ...healthy, loss: 0.08 }, 10000)
  assert.equal(controller.snapshot().index, 1)
  for (let now = 12000; now < 42000; now += 2000) controller.observe(healthy, now)
  assert.equal(controller.snapshot().index, 1)
  controller.observe(healthy, 42000)
  assert.equal(controller.snapshot().index, 0)
  for (let now = 44000; now < 70000; now += 2000) controller.observe({ ...healthy, active: false, rtt: 500, loss: 1 }, now)
  assert.equal(controller.snapshot().index, 0)
})
test('manual choice persists but cannot exceed external link ceiling', () => {
  const controller = createController({ mode: 'manual', values: { maxSize: 1920, bitrate: 6000000, maxFps: 60 } })
  controller.setLevel(42)
  controller.observe(healthy, 0)
  controller.observe({ ...healthy, loss: 0.2 }, 10000)
  controller.observe({ ...healthy, loss: 0.2 }, 12000)
  assert.equal(controller.settings().bitrate, 2800000)
  assert.equal(controller.snapshot().index, 0)
  controller.observe({ ...healthy, network: 'lan' }, 14000)
  controller.observe({ ...healthy, network: 'lan' }, 16000)
  assert.equal(controller.settings().bitrate, 6000000)
  controller.setPreference({ mode: 'auto' })
  assert.equal(controller.snapshot().mode, 'auto')
})

// 内网拥塞先降低分辨率与码率 仍保留交互所需的目标帧率
test('LAN adaptation retains sixty fps and sparse statistics never cause upgrades', () => {
  const controller = createController()
  controller.setLevel(42)
  controller.observe({ ...healthy, network: 'lan' }, 0)
  controller.observe({ ...healthy, network: 'lan' }, 2000)
  for (let now = 4000; now <= 40000; now += 2000) controller.observe({ ...healthy, network: 'lan', loss: 0.1 }, now)
  assert.equal(controller.settings().maxFps, 60)
  assert.equal(controller.snapshot().index, 4)
  for (let now = 42000; now < 100000; now += 2000) controller.observe({ network: 'lan', active: true }, now)
  assert.equal(controller.snapshot().index, 4)
})

// 公网直连从保守档逐步提升 中转或未知路径立即恢复出口预算
test('public direct grows only after sustained health and relay clamps immediately', () => {
  const c = createController()
  c.setLevel(42)
  const sample = { ...healthy, network: 'direct' }
  c.observe(sample, 0)
  assert.equal(c.settings().bitrate, 2800000)
  for (let now = 2000; now <= 30000; now += 2000) c.observe(sample, now)
  assert.equal(c.settings().bitrate, 4500000)
  for (let now = 32000; now <= 64000; now += 2000) c.observe(sample, now)
  assert.equal(c.settings().bitrate, 6000000)
  c.observe({ ...sample, network: 'wan' }, 66000)
  assert.equal(c.settings().bitrate, 2800000)
  c.observe(sample, 68000)
  assert.equal(c.settings().bitrate, 2800000)
  c.observe({ ...sample, network: 'unknown' }, 70000)
  assert.equal(c.settings().bitrate, 2800000)
})
