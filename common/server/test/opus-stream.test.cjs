// Modified in the Mobile Remote derivative (2026): mobile UI, media transport or recovery changes; see MODIFICATIONS.md.
'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { createOpusParser } = require('../lib/opus-stream')
const { audioCommand } = require('../lib/phone-audio')
const { createOpusPlayback } = require('../public/phone-audio')
// 构造不包含真实采集的官方格式测试帧
function frame(payload, config = false) {
  const header = Buffer.alloc(12)
  header.writeBigUInt64BE(config ? 1n << 63n : 20000n)
  header.writeUInt32BE(payload.length, 8)
  return Buffer.concat([header, payload])
}
// 构造标准立体声配置
function head() {
  const data = Buffer.alloc(19)
  data.write('OpusHead'); data[8] = 1; data[9] = 2; data.writeUInt16LE(312, 10)
  return data
}
test('Opus framing survives every split and never forwards config as media', () => {
  const audio = frame(Buffer.from([0xf8, 0xff, 0xfe]))
  const source = Buffer.concat([frame(head(), true), audio, audio])
  for (let split = 1; split < source.length; split++) {
    const formats = [], packets = []
    const parser = createOpusParser(value => formats.push(value), value => packets.push(value))
    parser.push(source.subarray(0, split)); parser.push(source.subarray(split))
    assert.equal(formats.length, 1); assert.equal(formats[0].preSkip, 312)
    assert.deepEqual(packets, [audio, audio])
  }
})
test('Opus parser rejects impossible lengths and missing or unsupported config', () => {
  assert.throws(() => createOpusParser(() => {}, () => {}).push(frame(Buffer.from([1]))), /配置/)
  const oversized = Buffer.alloc(12); oversized.writeUInt32BE(8193, 8)
  assert.throws(() => createOpusParser(() => {}, () => {}).push(oversized), /长度/)
  const invalid = head(); invalid[18] = 1
  assert.throws(() => createOpusParser(() => {}, () => {}).push(frame(invalid, true)), /配置/)
})
test('Opus capture command preserves frame metadata and uses a bounded audio rate', () => {
  const command = audioCommand('1234abcd', 'opus')
  for (const part of ['audio_codec=opus','audio_bit_rate=96000','send_frame_meta=true','send_dummy_byte=false','video=false','control=false']) assert.ok(command.includes(part))
  assert.ok(!command.includes('raw_stream=true'))
})
test('Worker audio queue stays bounded and ignores late completion after stop', async () => {
  let release, count = 0, outputs = 0, freed = 0
  class Decoder {
    constructor() { this.ready = Promise.resolve() }
    // 模拟主线程繁忙时尚未返回的解码
    decodeFrame() { count++; return new Promise(resolve => { release = resolve }) }
    // 记录资源回收而不创建真实工作线程
    free() { freed++ }
  }
  const pipeline = createOpusPlayback(Decoder, { channels: 2, preSkip: 0 }, { pushChannels() { outputs++ } }, () => {}, error => { throw error })
  await Promise.resolve()
  const data = frame(Buffer.from([0xf8,0xff,0xfe]))
  for (let i = 0; i < 50; i++) pipeline.push(Uint8Array.from(data).buffer)
  assert.equal(count, 1)
  pipeline.stop(); release({ channelData: [new Float32Array(960)], sampleRate: 48000, errors: [] })
  await Promise.resolve(); await Promise.resolve()
  assert.equal(outputs, 0); assert.equal(freed, 1); assert.equal(count, 1)
})
