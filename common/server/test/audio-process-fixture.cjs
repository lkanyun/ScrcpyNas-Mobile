// Modified in the Mobile Remote derivative (2026): mobile UI, media transport or recovery changes; see MODIFICATIONS.md.
'use strict'

const { PassThrough } = require('node:stream')
const { createPhoneAudio } = require('../lib/phone-audio')
const { runAudioWorker } = require('../lib/phone-audio-process')

// 独立观察进程记录真实到达时间 不让测试主进程的阻塞污染观察结果
if (process.argv[2] === 'observer') {
  process.once('message', config => {
    const WebSocket = require('ws')
    const ws = new WebSocket(config.url, { origin: config.origin, headers: { Cookie: config.cookie } })
    const arrivals = []
    ws.on('error', () => {})
    ws.on('message', (_data, binary) => {
      if (!binary) return
      arrivals.push(Date.now())
      if (arrivals.length === 1) process.send({ type: 'streaming' })
    })
    process.on('message', message => {
      if (message.type === 'report') process.send({ type: 'report', arrivals })
      if (message.type === 'stop') ws.terminate()
    })
    ws.on('close', () => process.exit(0))
    process.on('disconnect', () => { ws.terminate(); process.exit(0) })
  })
} else {
  // 用周期 PCM 代替安卓设备 其余升级 认证 分发和回收均走生产代码
  runAudioWorker(config => createPhoneAudio({
    ...config,
    selectTarget: async () => 'fixture-only',
    startCapture: async () => {
      const stream = new PassThrough()
      const packet = Buffer.alloc(3840)
      packet.writeUInt32BE(process.pid)
      const timer = setInterval(() => stream.write(packet), 20)
      return { stream, async stop() { clearInterval(timer); stream.destroy() } }
    }
  }))
}
