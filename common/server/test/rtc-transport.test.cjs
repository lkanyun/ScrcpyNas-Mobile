// Modified in the Mobile Remote derivative (2026): mobile UI, media transport or recovery changes; see MODIFICATIONS.md.
'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { splitNals, packetize, iceCredentials } = require('../lib/rtc-packetizer')
// 重组分片以验证单元边界 序号回绕与尾标记
 test('RTP fragments preserve NAL bytes and mark only the final fragment', () => {
  class Header { constructor(values) { Object.assign(this,values) } }
  class Packet { constructor(header,payload) { this.header=header;this.payload=payload } }
  const nal=Buffer.alloc(4000,7);nal[0]=0x65
  const state={seq:65535,ssrc:7}
  const packets=packetize([Buffer.from([0x67,1,2,3]),nal],123,state,{RtpHeader:Header,RtpPacket:Packet})
  assert.equal(packets[0].header.sequenceNumber,65535);assert.equal(packets[1].header.sequenceNumber,0)
  assert.equal(packets.filter(packet=>packet.header.marker).length,1)
  assert.equal(packets.at(-1).header.marker,true)
  assert.ok(packets.every(packet=>packet.payload.length<=1100))
  assert.deepEqual(Buffer.concat([Buffer.from([0x65]),...packets.slice(1).map(packet=>packet.payload.subarray(2))]),nal)
 })
 test('AnnexB parser rejects invalid and oversized input',()=>{
  assert.throws(()=>splitNals(Buffer.from([1,2,3])),/AnnexB/)
  assert.throws(()=>splitNals(Buffer.alloc(4*1024*1024+1)),/buffer/)
  assert.equal(splitNals(Buffer.from([0,0,0,1,0x67,1,0,0,1,0x68,2])).length,2)
 })
 test('TURN credentials expire and do not expose the secret',()=>{
  const [credential]=iceCredentials({host:'relay.example',port:3478,secret:'test-secret'},0)
  assert.match(credential.username,/^3600:/)
  assert.equal(credential.credential,require('node:crypto').createHmac('sha1','test-secret').update(credential.username).digest('base64'))
  assert.ok(!JSON.stringify(credential).includes('test-secret'))
 })

// 不同帧长共用采样时钟 拒绝零帧或超过标准上限的包
 test('Opus sample clock supports frame durations and rejects impossible counts', () => {
  const { opusSamples } = require('../lib/rtc-audio')
  assert.equal(opusSamples(Buffer.from([0xf8, 0xff, 0xfe])), 960)
  assert.equal(opusSamples(Buffer.from([0x80, 1])), 120)
  assert.equal(opusSamples(Buffer.from([0x18, 1])), 2880)
  assert.equal(opusSamples(Buffer.from([0xfb, 3, 1])), 2880)
  assert.throws(() => opusSamples(Buffer.from([0xfb, 0])), /无效/)
  assert.throws(() => opusSamples(Buffer.from([0xfb, 7])), /无效/)
 })
