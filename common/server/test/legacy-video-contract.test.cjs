// Modified in the Mobile Remote derivative (2026): mobile UI, media transport or recovery changes; see MODIFICATIONS.md.
'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { createHash } = require('node:crypto')

// JAR 改版必须重新审计发送合同，不能沿用当前完整编码缓冲假设
 test('legacy encoder binary stays pinned to the audited MediaCodec message contract', () => {
  const jar = fs.readFileSync(path.resolve(__dirname, '../../engine/vendor/Genymobile/scrcpy/scrcpy-server.jar'))
  assert.equal(createHash('sha256').update(jar).digest('hex'), 'baae6ce9db8379ccd820277739f5005876564f4744f97756107445439813a920')
 })

// 执行交付引擎的原接收回调，验证它没有分割或合并编码器消息
 test('shipped receiver preserves each complete binary video message byte-for-byte', () => {
  const bundle = fs.readFileSync(path.resolve(__dirname, '../../engine/public/bundle.js'), 'utf8')
  const callback = bundle.match(/t\.prototype\.onSocketMessage=(function\(e\)\{.+?\}),t\.prototype\.onSocketOpen=/)?.[1]
  assert.ok(callback, 'known actual receiver callback')
  const initial = new TextEncoder().encode('scrcpy_initial')
  const device = new TextEncoder().encode('scrcpy_message')
  const context = { ArrayBuffer, Uint8Array, d: initial, t: { EqualArrays: (a, b) => a.length === b.length && a.every((v, i) => v === b[i]) }, a: { default: { MAGIC_BYTES_MESSAGE: device } } }
  const receive = vm.runInNewContext('(' + callback + ')', context)
  const events = []
  const receiver = { emit: (event, data) => events.push({ event, data }), handleInitialInfo: () => events.push({ event: 'initial' }) }
  const buffers = [Uint8Array.from([0, 0, 0, 1, 0x67, 100, 0, 31]), Uint8Array.from([0, 0, 0, 1, 0x65, 1, 2, 3, 0, 0, 1, 0x65, 4])]
  for (const bytes of buffers) receive.call(receiver, { data: bytes.buffer })
  assert.equal(events.length, 2)
  for (let i = 0; i < buffers.length; i++) {
    assert.equal(events[i].event, 'video')
    assert.deepEqual([...events[i].data], [...buffers[i]])
  }
  const metadata = new Uint8Array(initial.length + 64)
  metadata.set(initial)
  receive.call(receiver, { data: metadata.buffer })
  assert.equal(events.at(-1).event, 'initial')
 })
