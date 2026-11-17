// Modified in the Mobile Remote derivative (2026): mobile UI, media transport or recovery changes; see MODIFICATIONS.md.
'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const net = require('node:net')
const { PassThrough } = require('node:stream')
const { createPhoneAudio } = require('../lib/phone-audio')
const { webkit } = require('playwright')
const express = require('../../engine/node_modules/express')
const { WebSocketServer } = require('../../engine/node_modules/ws')
const { createWarmScrcpyUpgradeProxy } = require('../lib/warm-stream')
const { registerScrcpyProxyRoutes } = require('../lib/scrcpy-proxy')
const root = path.resolve(__dirname, '..')
const { legacyVideoFixture } = require('./legacy-video-fixture.cjs')

// 重载后使用同一真实引擎客户端重新订阅本地合成流
function bootClient() {
    const req=window.auditRequire
    req(2598).StreamClientScrcpy.registerPlayer(req(8154).MsePlayer)
    req(2598).StreamClientScrcpy.registerPlayer(req(5692).WebCodecsPlayer)
    const socket=new WebSocket('ws://'+location.host+'/scrcpy/?action=proxy-adb&remote=tcp:8886&udid=fixture')
    socket.binaryType='arraybuffer'
    const receiver=new (req(8068).TypedEmitter)()
    receiver.sendEvent=command=>{if(socket.readyState===1)socket.send(command.toBuffer())}
    receiver.stop=()=>socket.close()
    receiver.getDisplayInfo=()=>undefined
    socket.addEventListener('message',event=>receiver.emit('video',event.data))
    const settings=new (req(5598).default)({ lockedVideoOrientation:-1,bitrate:4000000,maxFps:30,iFrameInterval:1,bounds:new (req(7407).default)(1280,1280),sendFrameMeta:window.fixtureFrameMeta===true })
    const loaded=req(9214).BasePlayer.getVideoSettingFromStorage(settings,'MseDecoder','fixture',undefined)
    window.client=req(2598).StreamClientScrcpy.start({ action:'stream',udid:'fixture',player:'webcodecs',ws:socket.url },receiver,undefined,false,loaded)
    const info=new (req(3422).default)(new (req(9880).default)(0,0,320,240),new (req(7407).default)(320,240),0)
    client.player.resizeVideoToBounds=true
    client.player.emit('input-video-resize',info)
    client.player.setScreenInfo(info)
    socket.addEventListener('open',()=>receiver.sendEvent(req(4888).CommandControlMessage.createSetVideoSettingsCommand(client.player.getVideoSettings())))
}


// 生成本地合成码流，复用真实引擎、代理与完整前端，不访问手机
async function fixture(t, preference = true, mode = '', options = {}) {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR, 'wc-lifecycle-'))
  const video = legacyVideoFixture(dir, { profile: 'baseline', slices: mode && mode !== 'baseline' || !preference ? 1 : 3, ...options })
  const vendor = fs.readFileSync(path.join(root, '../engine/public/bundle.js'), 'utf8')
  // 仅替换应用自动启动入口，保留所有真实引擎模块供原 StreamClient 构造
  const anchor = vendor.slice(-3000).match(/\}\)\(\),(.+)\}\)\(\);?$/)
  assert.ok(anchor, 'known vendor startup anchor')

  const tested = vendor.replace(anchor[1] + '})();', 'globalThis.auditRequire=r;})();')
  assert.notEqual(tested, vendor)
  const upstream = express()
  upstream.get('/', (_q,s) => s.send('<!doctype html><head><link rel="stylesheet" href="main.css"><script defer="defer" src="bundle.js"></script><script defer src="/synthetic-client.js"></script></head><body></body>'))
  upstream.get('/bundle.js', (_q,s) => s.type('js').send(tested))
  upstream.get('/main.css', (_q,s) => s.type('css').sendFile(path.join(root, '../engine/public/main.css')))
  const up = http.createServer(upstream)
  await new Promise(r => up.listen(0,'127.0.0.1',r))
  const app = express()
  const stats = { sockets: 0, sent: 0, commands: [], releases: 0, auth: 200, starts: 0, stops: 0, paused: !!options.waitForSource }
  app.use(express.json())
  app.use((_q,s,next)=>{s.setHeader('Set-Cookie','fixture=valid; SameSite=Strict; Path=/');next()})
  app.get('/session/check',(q,s)=>s.sendStatus(q.headers.cookie==='fixture=valid' && stats.auth===200 ? 204 : 401))
  app.post('/api/screen-power/release',(q,s)=>{stats.releases++;stats.release=q.body;s.json({ok:true,shared:false})})
  app.get('/synthetic-client.js', (_q,s) => s.type('js').send('(' + bootClient.toString() + ')()'))
  app.get('/api/auth', (_q,s) => s.status(stats.auth).json({ ok: stats.auth === 200 }))
  app.get('/', (_q,s) => s.send('<body><iframe id="mirrorFrame" style="width:393px;height:700px;border:0" src="/scrcpy/#!action=stream&udid=fixture"></iframe></body>'))

  const rtcFile=path.join(dir,'rtc.json')
  const relay=JSON.parse(fs.readFileSync(process.env.RTC_TEST_CONFIG))
  process.env.PHONE_RTC_CONFIG=rtcFile
  registerScrcpyProxyRoutes(app, { routeBases:[''], appPath:v=>v, escapeRegExp:v=>v, wsScrcpyHost:'127.0.0.1', wsScrcpyPort:up.address().port, buildProxyPath:v=>v.replace(/^\/scrcpy/,'') || '/' })
  app.use(express.static(path.join(root,'public')))
  const server = http.createServer(app)
  const wss = new WebSocketServer({ noServer:true })
  wss.on('connection', ws => {
    stats.sockets++

    let current = video
    let parts = current.pictures
    let index = options.warmResume ? 1 : 0
    const timer = setInterval(() => { if(ws.readyState===1) {
      if(mode==='no-data' || stats.paused)return
      if(options.once && stats.sent >= 1)return
      for (let packet = 0; packet < (options.burst || 1); packet++) {
      if(stats.next){current=stats.next;parts=current.pictures;stats.next=null;index=0}
      if(index % parts.length===0)ws.send(current.configuration)
      const au=parts[index++ % parts.length]
      ws.send(au)
      stats.sent++
      }
    } }, 34 * (options.burst || 1))
    // 原生设置失效命令在真实服务端会重建编码器，夹具也立即重新发送配置和 IDR
    ws.on('message', b => { stats.commands.push([...b]); if (b[0] === 101) index = 0 })
    ws.on('close', () => clearInterval(timer))
  })
  await new Promise(r => server.listen(0,'127.0.0.1',r))
  const origin = 'http://127.0.0.1:' + server.address().port
  const audio=createPhoneAudio({origin,sessionCheckUrl:origin+'/session/check',selectTarget:async()=>'fixture',startCapture:async()=>{
    stats.starts++
    const stream=new PassThrough()
    const timer=setInterval(()=>{const pcm=Buffer.alloc(3840);pcm.writeInt16LE(1000);stream.write(pcm)},20)
    return {stream,async stop(){clearInterval(timer);stream.destroy();stats.stops++}}
  }})
  fs.writeFileSync(rtcFile,JSON.stringify({...relay,origin,sessionCheckUrl:origin+'/session/check'}))
  const proxy=createWarmScrcpyUpgradeProxy({buildProxyPath:v=>v.replace(/^\/scrcpy/,'')||'/',wsScrcpyHost:'127.0.0.1',wsScrcpyPort:up.address().port,fallback:(_req,socket)=>socket.destroy(),timeoutMs:100})
  up.on('upgrade',(req,socket,head)=>wss.handleUpgrade(req,socket,head,ws=>wss.emit('connection',ws)))
  server.on('upgrade',(req,socket,head)=>{if(req.url==='/phone-audio')audio.handleUpgrade(req,socket,head);else proxy(req,socket,head)})
  const ports = [server.address().port,up.address().port]
  const browser = await webkit.launch({ executablePath: process.env.WC_WEBKIT_EXECUTABLE })
  const page = await browser.newPage({ viewport:{ width:500,height:800 }, hasTouch:true })
  const errors = []
  page.on('pageerror', e => errors.push(e.message))
  await page.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort())
  await page.addInitScript(({ preference,mode }) => {
    if(!sessionStorage.getItem('fixture.seed')){sessionStorage.setItem('fixture.seed','1');if(mode!=='fresh')localStorage.setItem('scrcpyNas.lowLatency.fixture',String(preference))}
    if(['no-api','no-api-bad'].includes(mode))window.VideoDecoder=undefined
    window.fixtureFrameMeta=mode==='frame-meta'
    // 明确的能力故障注入，不再把本来可解码的 Main 或 High 当作负例
    if(mode==='unsupported')VideoDecoder.isConfigSupported=async config=>({supported:false,config})
    window.trace=[]
    addEventListener('scrcpynas:frame-drawn',()=>trace.push('draw'))
    addEventListener('scrcpynas:decoded-stable',()=>trace.push('stable'))
    const send=WebSocket.prototype.send
    WebSocket.prototype.send=function(data){if(data instanceof ArrayBuffer || ArrayBuffer.isView(data))trace.push('command:'+new Uint8Array(data.buffer || data,data.byteOffset || 0,data.byteLength)[0]);return send.call(this,data)}
  }, { preference,mode })
  t.after(async () => {
    // 浏览器仍存活时完成租约释放，避免夹具关闭把 keepalive 请求体截断
    const current=page.frames()[1]
    if(current)await current.evaluate(()=>window.dispatchEvent(new Event('scrcpynas:disconnect'))).catch(()=>{})
    for(let i=0;stats.releases===0 && i<50;i++)await new Promise(resolve=>setTimeout(resolve,20))
    await browser.close()
    await audio.stop()
    await proxy.close()
    delete process.env.PHONE_RTC_CONFIG
    for(const client of wss.clients)client.terminate()
    await new Promise(r=>wss.close(r))
    for(const srv of [server,up]) { srv.closeAllConnections();await new Promise(r=>srv.close(r)) }
    fs.rmSync(dir,{ recursive:true,force:true })
    for(const port of ports) await new Promise((resolve,reject)=> { const socket=net.connect(port,'127.0.0.1');socket.on('error',resolve);socket.on('connect',()=>{socket.destroy();reject(Error('listener still open'))}) })
    assert.deepEqual(errors,[])
  })
  // UDP 入口不能仅凭路径或伪造来源建立上游采集
  const Socket=require('ws')
  const endpoint=origin.replace('http:','ws:')+'/scrcpy/?action=proxy-adb&remote=tcp:8886&udid=fixture&warmSession='+('a'.repeat(32))+'&rtc=1'
  for(const [requestOrigin,cookie] of [[origin,''],['https://invalid.test','fixture=valid']]) {
    const rejected=new Socket(endpoint,{origin:requestOrigin,headers:{Cookie:cookie}})
    await new Promise(resolve=>rejected.once('error',resolve))
  }
  assert.equal(stats.sockets,0)
  await page.goto(origin)
  const frame = page.frames()[1]
  await frame.waitForFunction(()=>!!window.auditRequire)
  // 单个既有接收器和单路合成 WebSocket 交给真实 StreamClient，控制命令走同一路
  await frame.waitForFunction(()=>!!window.client)
  return { page,frame,stats,origin,video, rotate:()=>{
    stats.next=legacyVideoFixture(dir,{width:240,height:320})
  } }

}


 test('real engine UI receives WebRTC and sends touch through the shared authenticated control lease', { skip: !process.env.RTC_TEST_CONFIG }, async t => {
  const {frame,stats}=await fixture(t)
  await frame.waitForFunction(()=>{const video=document.querySelector('video.video-layer');return video?.videoWidth>0&&video.currentTime>1},{},{timeout:25000})
  assert.equal(await frame.evaluate(()=>window.scrcpyNasPlayerStatus.mode),'webrtc')
  const progress=await frame.evaluate(()=>{const p=scrcpyNasProgress.read();return {mode:p.mode,drawn:p.drawnSeq,width:p.sourceRect.width}})
  assert.equal(progress.mode,'webrtc');assert.ok(progress.drawn>0 && progress.width>0)
  assert.equal(await frame.evaluate(()=>document.querySelectorAll('canvas.video-layer').length),0)
  const backgroundFrame = await frame.evaluate(()=>scrcpyNasProgress.read().drawnSeq)
  await frame.evaluate(()=>{ Object.defineProperty(document,'hidden',{configurable:true,value:true}); Object.defineProperty(document,'visibilityState',{configurable:true,value:'hidden'}); document.dispatchEvent(new Event('visibilitychange')) })
  await frame.waitForFunction(previous=>scrcpyNasProgress.read().drawnSeq>previous,backgroundFrame)
  assert.equal(stats.sockets,1)
  await frame.evaluate(()=>{ Object.defineProperty(document,'hidden',{configurable:true,value:false}); Object.defineProperty(document,'visibilityState',{configurable:true,value:'visible'}); document.dispatchEvent(new Event('visibilitychange')) })
  assert.equal(await frame.evaluate(()=>document.querySelector('video.video-layer').srcObject!==null),true)
  const settings=await frame.evaluate(()=>client.player.getVideoSettings().toJSON())
  assert.ok(['profile=1,level=512,repeat-previous-frame-after:long=1000000','profile=1,level=8192,repeat-previous-frame-after:long=1000000'].includes(settings.codecOptions));assert.ok(settings.bitrate<=2800000)
  const before=stats.commands.filter(data=>data[0]===2).length
  await frame.locator('.touch-layer').tap({position:{x:100,y:100}})
  await new Promise(resolve=>setTimeout(resolve,300))
  assert.ok(stats.commands.filter(data=>data[0]===2).length >= before + 2, 'trusted browser tap must reach the original control channel')
  // 同时验证真实设置序列化器可通过控制通道请求新关键帧
  await frame.evaluate(()=>{const req=auditRequire;client.sendMessage(req(4888).CommandControlMessage.createSetVideoSettingsCommand(client.player.getVideoSettings()))})
  await new Promise(resolve=>setTimeout(resolve,100))
  assert.ok(stats.commands.some(data=>data[0]===101))
  t.diagnostic(JSON.stringify({upstreamSockets:stats.sockets,touchCommands:stats.commands.filter(data=>data[0]===2).length-before}))
  assert.equal(stats.sockets,1)
  const gaming=await frame.evaluate(()=>{
    scrcpyNasRtc.setQualityPreference({mode:'manual',values:{maxSize:1920,bitrate:6000000,maxFps:60}})
    return client.player.getVideoSettings().toJSON()
  })
  assert.equal(gaming.maxFps,60);assert.ok(gaming.bounds.width<=1280 && gaming.bounds.height<=1280)
  stats.auth=401
  await frame.waitForFunction(()=>document.querySelector('video.video-layer')?.srcObject===null,{},{timeout:8000})
 })

// 源未输出时也能完成连接 随后首帧必须由真实解码回调确认
 test('RTC negotiates before source readiness and records a real first frame', { skip: !process.env.RTC_TEST_CONFIG }, async t => {
  const { frame, stats } = await fixture(t, true, '', { waitForSource: true })
  await frame.waitForFunction(() => window.scrcpyNasStartup?.transportConnected != null, {}, { timeout: 15000 })
  assert.equal(stats.sent, 0)
  assert.equal(await frame.evaluate(() => window.scrcpyNasStartup.firstFrame == null), true)
  stats.paused = false
  await frame.waitForFunction(() => window.scrcpyNasStartup?.firstFrame != null, {}, { timeout: 10000 })
  const phases = await frame.evaluate(() => window.scrcpyNasStartup)
  assert.ok(phases.offerReceived < phases.firstFrame)
  assert.ok(phases.answerSent <= phases.transportConnected)
  t.diagnostic(JSON.stringify(phases))
 })
