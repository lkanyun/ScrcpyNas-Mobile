// Modified in the Mobile Remote derivative (2026): mobile UI, media transport or recovery changes; see MODIFICATIONS.md.
'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const { execFileSync } = require('node:child_process')
const { PassThrough } = require('node:stream')
const { createPhoneAudio } = require('../lib/phone-audio')
// 从独立合成声音中拆出编码帧 不录制设备声音
function syntheticPackets() {
  const ogg = execFileSync('ffmpeg', ['-v','error','-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-t','2','-ac','2','-c:a','libopus','-b:a','96k','-f','opus','pipe:1'])
  const packets = [], parts = []
  let offset = 0
  while (offset < ogg.length) {
    assert.equal(ogg.toString('ascii', offset, offset + 4), 'OggS')
    const segments = ogg[offset + 26]
    let cursor = offset + 27 + segments
    for (let index = 0; index < segments; index++) {
      const length = ogg[offset + 27 + index]
      parts.push(ogg.subarray(cursor, cursor + length)); cursor += length
      if (length < 255) { packets.push(Buffer.concat(parts)); parts.length = 0 }
    }
    offset = cursor
  }
  return packets.filter(data => data.toString('ascii',0,8) !== 'OpusTags')
}
// 包装官方时间戳帧以覆盖真实传输解析路径
function frame(data, index) {
  const header = Buffer.alloc(12)
  header.writeBigUInt64BE(index ? BigInt(index * 20000) : 1n << 63n)
  header.writeUInt32BE(data.length, 8)
  return Buffer.concat([header, data])
}
test('real WebKit decodes Opus in Worker, plays nonzero audio and releases capture', async t => {
  const packets = syntheticPackets()
  let audio, starts = 0, stops = 0
  const server = http.createServer((req,res) => {
    if (req.url === '/session/check') { res.writeHead(req.headers.cookie === 'fixture=valid' ? 204 : 401); return res.end() }
    if (['/phone-audio.js','/vendor/opus-decoder.min.js'].includes(req.url)) {
      res.setHeader('Content-Type','application/javascript; charset=utf-8')
      return res.end(fs.readFileSync(path.join(__dirname,'../public',req.url)))
    }
    res.setHeader('Content-Type','text/html; charset=utf-8');res.setHeader('Set-Cookie','fixture=valid; SameSite=Strict; Path=/')
    res.end('<section id="media-panel"></section><script charset="utf-8" src="/vendor/opus-decoder.min.js"></script><script src="/phone-audio.js"></script>')
  })
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve))
  const origin = 'http://127.0.0.1:' + server.address().port
  audio = createPhoneAudio({ origin, codec:'opus',sessionCheckUrl:origin+'/session/check',selectTarget:async()=> 'fixture',
    // 定时发送合成帧以检验真实浏览器工作线程和播放图
    startCapture: async options => {
      assert.equal(options.codec,'opus'); starts++
      const stream = new PassThrough();let index=0
      const timer=setInterval(()=>{stream.write(frame(packets[index],index));index++;if(index===packets.length)index=1},20)
      return {stream,async stop(){clearInterval(timer);stream.destroy();stops++}}
    }
  })
  server.on('upgrade',(req,socket,head)=>{if(!audio.handleUpgrade(req,socket,head))socket.destroy()})
  t.after(async()=>{await audio.stop();server.closeAllConnections();await new Promise(resolve=>server.close(resolve))})
  // 旧页面未重置放大倍数时不能连接满幅源
  await new Promise((resolve, reject) => {
    const WebSocket = require('ws')
    const old = new WebSocket(origin.replace('http:', 'ws:') + '/phone-audio', { origin, headers: { Cookie: 'fixture=valid' } })
    old.once('unexpected-response', (_request, response) => { assert.equal(response.statusCode, 403); response.resume(); old.terminate(); resolve() })
    old.once('open', () => { old.close(); reject(new Error('legacy gain accepted')) })
    old.on('error', () => {})
  })
  const {webkit}=require('playwright')
  const browser=await webkit.launch({executablePath:process.env.PHONE_AUDIO_WEBKIT_EXECUTABLE})
  t.after(()=>browser.close())
  const page=await browser.newPage()
  const errors=[];page.on('pageerror',error=>errors.push(error.message))
  await page.addInitScript(()=>{
    const Original=window.AudioContext
    window.decodedPeak=0;window.sources=0
    window.AudioContext=class extends Original {
      createBufferSource(){window.sources++;return super.createBufferSource()}
      createBuffer(...args){const buffer=super.createBuffer(...args);const get=buffer.getChannelData.bind(buffer);buffer.getChannelData=channel=>{const samples=get(channel);const set=samples.set.bind(samples);samples.set=data=>{for(const value of data)window.decodedPeak=Math.max(window.decodedPeak,Math.abs(value));set(data)};return samples};return buffer}
    }
  })
  await page.goto(origin);assert.equal(starts,0)
  await page.locator('#phone-audio-toggle').click()
  await page.waitForFunction(()=>window.sources>10 && window.decodedPeak>0.01)
  assert.match(await page.locator('#media-audio-status').innerText(),/Opus/)
  await page.locator('#phone-audio-volume').fill('0.25')
  await page.locator('#phone-audio-toggle').click()
  await new Promise(resolve=>setTimeout(resolve,100))
  assert.equal(stops,1)
  const previous = await page.evaluate(() => window.sources)
  await page.locator('#phone-audio-toggle').click()
  await page.waitForFunction(count => window.sources > count + 10, previous, { timeout: 5000 })
  assert.equal(starts,2)
  await page.locator('#phone-audio-toggle').click()
  await new Promise(resolve=>setTimeout(resolve,100))
  assert.equal(stops,2);assert.deepEqual(errors,[])
  t.diagnostic('Synthetic Opus decoded through real WebKit Worker and WebAudio; no physical speaker claim')
})
