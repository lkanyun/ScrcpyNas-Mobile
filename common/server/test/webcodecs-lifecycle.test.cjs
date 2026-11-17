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
}


// 生成本地合成码流，复用真实引擎、代理与完整前端，不访问手机
async function fixture(t, preference = true, mode = '', options = {}) {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR, 'wc-lifecycle-'))
  const video = legacyVideoFixture(dir, { profile: mode || !preference ? 'baseline' : 'high', slices: mode && mode !== 'baseline' || !preference ? 1 : 3, ...options })
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
  const stats = { sockets: 0, sent: 0, commands: [], releases: 0, auth: 200, starts: 0, stops: 0 }
  app.use(express.json())
  app.use((_q,s,next)=>{s.setHeader('Set-Cookie','fixture=valid; SameSite=Strict; Path=/');next()})
  app.get('/session/check',(_q,s)=>s.sendStatus(204))
  app.post('/api/screen-power/release',(q,s)=>{stats.releases++;stats.release=q.body;s.json({ok:true,shared:false})})
  app.get('/synthetic-client.js', (_q,s) => s.type('js').send('(' + bootClient.toString() + ')()'))
  app.get('/api/auth', (_q,s) => s.status(stats.auth).json({ ok: stats.auth === 200 }))
  app.get('/', (_q,s) => s.send('<body><iframe id="mirrorFrame" style="width:393px;height:700px;border:0" src="/scrcpy/#!action=stream&udid=fixture"></iframe></body>'))

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
  server.on('upgrade',(req,socket,head)=>{if(req.url==='/phone-audio')audio.handleUpgrade(req,socket,head);else wss.handleUpgrade(req,socket,head,ws=>wss.emit('connection',ws))})
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
    for(const client of wss.clients)client.terminate()
    await new Promise(r=>wss.close(r))
    for(const srv of [server,up]) { srv.closeAllConnections();await new Promise(r=>srv.close(r)) }
    fs.rmSync(dir,{ recursive:true,force:true })
    for(const port of ports) await new Promise((resolve,reject)=> { const socket=net.connect(port,'127.0.0.1');socket.on('error',resolve);socket.on('connect',()=>{socket.destroy();reject(Error('listener still open'))}) })
    assert.deepEqual(errors,[])
  })
  await page.goto(origin)
  const frame = page.frames()[1]
  await frame.waitForFunction(()=>!!window.auditRequire)
  // 单个既有接收器和单路合成 WebSocket 交给真实 StreamClient，控制命令走同一路
  await frame.waitForFunction(()=>!!window.client)
  return { page,frame,stats,origin,video, rotate:()=>{
    stats.next=legacyVideoFixture(dir,{width:240,height:320})
  } }

}

// frame meta 开启会增加独立头消息，不能误按 AU 或悄悄宣称优化生效
 test('metadata-enabled legacy protocol fails explicitly before native AU admission', async t => {
  const { frame, stats } = await fixture(t, true, 'frame-meta')
  await frame.waitForFunction(() => scrcpyNasPlayerStatus.mode === 'failed', {}, { timeout: 3000 })
  assert.equal(await frame.evaluate(() => scrcpyNasPlayerStatus.reason), 'frame-metadata-unsupported')
  assert.equal(await frame.evaluate(() => scrcpyNasPlayerStatus.fallbackCount), 0)
  assert.equal(stats.sockets, 1)
 })

// 只发送一张 High 图像后保持静默，验证最后一个实时 AU 无需下一包或 flush
 test('one final High CABAC multislice AU draws natively while the transport stays silent', async t => {
  const { frame, stats } = await fixture(t, true, '', { once: true })
  await frame.waitForFunction(() => window.scrcpyNasProgress?.read().drawnSeq === 1, {}, { timeout: 4000 })
  assert.equal(stats.sent, 1)
  const result = await frame.evaluate(() => ({ status: scrcpyNasPlayerStatus, core: client.player.lowLatencyCore.stats }))
  assert.equal(result.status.mode, 'webcodecs')
  assert.equal(result.status.fallbackCount, 0)
  assert.equal(result.core.submitted, 1)
  assert.equal(result.core.output, 1)
  assert.equal(result.core.drawn, 1)
  assert.equal(result.core.resets, 0)
 })

// 真 WebKit 同时报告提交、输出和绘制，不能通过丢掉大多数图像伪造低延迟
for (const profile of ['high', 'baseline']) {
 test('sustained native complete-buffer decoding reports real output and draw queues: ' + profile, async t => {
  const { page, frame, stats, video } = await fixture(t, true, '', { profile, width: profile === 'high' ? 576 : 320, height: profile === 'high' ? 1280 : 240, frames: 120 })
  await frame.waitForFunction(() => window.scrcpyNasProgress?.read().drawnSeq > 5)
  await frame.evaluate(() => {
    window.drawLatency = []
    const core = client.player.lowLatencyCore
    const draw = core.onDraw
    core.onDraw = event => { if (drawLatency.length < 180) drawLatency.push(event.at - event.arrival); draw(event) }
  })
  await frame.waitForFunction(() => client.player.lowLatencyCore.stats.output >= 120, {}, { timeout: 8000 })
  stats.paused = true
  await page.waitForTimeout(100)
  const result = await frame.evaluate(() => {
    const samples = drawLatency.sort((a, b) => a - b)
    return { status: scrcpyNasPlayerStatus, core: client.player.lowLatencyCore.stats, samples: samples.length, p95: samples[Math.floor(samples.length * .95)], width: client.player.tag.width, height: client.player.tag.height }
  })
  assert.equal(result.status.mode, 'webcodecs')
  assert.equal(result.status.fallbackCount, 0)
  assert.equal(result.core.resets, 0)
  assert.equal(result.core.idrRequests, 0)
  assert.ok(result.core.output >= stats.sent - 1, JSON.stringify(result))
  assert.ok(result.core.drawn >= stats.sent * .9, JSON.stringify(result))
  assert.ok(result.samples >= 90 && result.p95 < 150, JSON.stringify(result))
  assert.ok(result.core.queueMax <= 4 && result.core.displayQueueMax === 1)
  assert.equal(result.width, video.probe.width)
  assert.equal(result.height, video.probe.height)
  t.diagnostic('synthetic receiver-ingress-to-draw only, not phone latency: ' + JSON.stringify({ sent: stats.sent, profile: video.probe.profile, cabac: video.cabac, slices: video.slices, ...result }))
 })
}

// 没有原生帧的画布只有默认尺寸，不能被当作已捕获画面
 test('canvas without a native draw never creates a pretend retained picture',async t=>{
  const {page,frame}=await fixture(t,true,'no-data')
  await frame.evaluate(()=>window.dispatchEvent(new Event('scrcpynas:recovering')))
  assert.equal(await page.locator('#scrcpynas-recovery-cover canvas').evaluate(c=>c.width),0)
 })

// 新画布真实输出稳定前保留宿主像素，不能由旧文档清除
 test('canvas cover retains real pixels across reload until a fresh generation is stable', async t => {
  const { page,frame,stats } = await fixture(t)
  await frame.waitForFunction(()=>window.scrcpyNasProgress?.read().drawnSeq>5)
  await frame.evaluate(()=>window.dispatchEvent(new Event('scrcpynas:recovering')))
  const pixel=await page.locator('#scrcpynas-recovery-cover canvas').evaluate(c=>({width:c.width,pixel:[...c.getContext('2d').getImageData(20,20,1,1).data]}))
  assert.equal(pixel.width,320,'canvas must be captured, not an empty video-only cover')
  assert.ok(pixel.pixel[3]>0)
  await page.waitForTimeout(1100)
  assert.equal(await page.locator('#scrcpynas-recovery-cover').count(),1)
  await frame.evaluate(()=>location.reload())
  await frame.waitForFunction(()=>window.scrcpyNasProgress?.read().drawnSeq>1)
  assert.equal(await page.locator('#scrcpynas-recovery-cover').count(),1,'a first frame is not stable playback')
  await page.locator('#scrcpynas-recovery-cover').waitFor({state:'detached',timeout:5000})
  assert.equal(stats.sockets,2,'only one socket per document, none for decoder migration')
 })

// 默认播放器不变，实验启用后必须从原生输出到画布真实绘制
 test('native default decodes through the real client with full controls and a generation-scoped canvas', async t => {
  const { frame,stats } = await fixture(t)
  await frame.waitForFunction(()=>window.scrcpyNasProgress?.read().mode==='webcodecs' && window.scrcpyNasProgress.read().drawnSeq>5,{},{ timeout:7000 })
  assert.equal(stats.sockets,1)
  assert.equal(await frame.locator('#mobile-orb').count(),1)
  assert.equal(await frame.locator('#media-panel').count(),1)
  const result=await frame.evaluate(()=>{const p=scrcpyNasProgress.read();return { ready:p.ready,decoded:p.decodedSeq,drawn:p.drawnSeq,pixel:[...p.drawable.getContext('2d').getImageData(20,20,1,1).data],core:client.player.lowLatencyCore.stats }})
  assert.ok(result.ready && result.decoded>=result.drawn && result.drawn>5,JSON.stringify(result))
  assert.ok(result.pixel[3]>0)
  assert.equal(result.core.timestampKind,'receiver-monotonic-us-not-capture-PTS')
  assert.ok(result.core.supports.every(s => s.supported && s.config.codec.startsWith('avc1.64')))
  assert.equal(await frame.evaluate(()=>scrcpyNasPlayerStatus.fallbackCount),0)
  t.diagnostic('native synthetic output: ' + JSON.stringify(result))
  assert.equal(await frame.evaluate(()=>scrcpyNasPlayerStatus.reason),'drawing')
  await frame.evaluate(()=>window.dispatchEvent(new Event('scrcpynas:disconnect')))
  assert.equal(await frame.evaluate(()=>client.player.lowLatencyCore.closed),true)
  assert.equal(await frame.evaluate(()=>scrcpyNasPlayerStatus.mode),'stopped')
 })


// 默认原生播放不读取旧实验偏好，也不创建 MSE 媒体转换器
for (const mode of ['fresh', 'old-disabled']) {
 test('native-only default ignores absent or disabled legacy preference: ' + mode, async t => {
  const { frame, stats } = await fixture(t, false, mode)
  await frame.waitForFunction(() => scrcpyNasProgress.read().drawnSeq > 5)
  assert.equal(await frame.evaluate(() => scrcpyNasPlayerStatus.mode), 'webcodecs')
  assert.equal(await frame.evaluate(() => !!client.player.converter), false)
  assert.equal(await frame.locator('video.video-layer').count(), 0)
  await frame.locator('[data-mobile-action="settings"]').evaluate(b => b.click())
  assert.equal(await frame.locator('#media-low-latency').count(), 0)
  assert.equal(await frame.locator('#media-player-switch').count(), 0)
  assert.match(await frame.locator('#media-player-status').textContent(), /WebCodecs.*播放中/)
  assert.equal(stats.sockets, 1)
 })
}

// 能力或原生解码错误必须清理并停播，不新开连接、不进入 MSE 或自动重载
for (const mode of ['no-api', 'unsupported', 'decode-error']) {
 test('native-only failure is explicit and terminal: ' + mode, async t => {
  const { page, frame, stats } = await fixture(t, true, mode)
  if (mode === 'decode-error') {
    await frame.waitForFunction(() => scrcpyNasProgress.read().drawnSeq > 5)
    await frame.evaluate(() => client.player.lowLatencyCore.decoder.reset())
  }
  await frame.waitForFunction(() => scrcpyNasPlayerStatus.mode === 'failed')
  await page.waitForTimeout(1700)
  const state = await frame.evaluate(() => scrcpyNasPlayerStatus)
  assert.equal(state.mode, 'failed')
  assert.equal(state.fallbackCount, 0)
  assert.equal(stats.sockets, 1)
  assert.equal(await frame.evaluate(() => !!client.player.converter), false)
  assert.equal(await frame.locator('video.video-layer').count(), 0)
  assert.equal(await frame.locator('#stream-start-status').isVisible(), true)
  assert.equal(await frame.evaluate(() => client.player.lowLatencyCore?.closed ?? true), true)
 })
}

// 画布必须走真实 draw 门禁，首包或构造控件本身不能提交物理黑屏
 test('canvas screen power waits for draw and stable diagnostics observes genuine frames', async t => {
  const { frame,stats }=await fixture(t)
  await frame.waitForFunction(()=>trace.includes('command:10'),{},{timeout:4000})
  const trace=await frame.evaluate(()=>window.trace)
  assert.ok(trace.indexOf('draw')>=0 && trace.indexOf('draw')<trace.indexOf('command:10'),JSON.stringify(trace))
  assert.ok(stats.commands.some(command=>command[0]===10 && command[1]===0))
  await frame.waitForFunction(()=>trace.includes('stable'),{},{timeout:19000})
  assert.equal(await frame.locator('#stream-start-status').isVisible(),false)
 })


// 使用真实触屏输入和原引擎序列化坐标，覆盖裁切、横竖视口与真实编码尺寸变化
 test('native canvas touch mapping stays congruent in contain cover and decoded rotation',async t=>{
  const {page,frame,stats,rotate}=await fixture(t)
  await frame.waitForFunction(()=>scrcpyNasProgress.read().drawnSeq>5)
  for(const source of [[320,240],[240,320]]) {
    if(source[0]===240){rotate();await frame.waitForFunction(()=>client.player.tag.width===240 && client.player.tag.height===320)}
    for(const size of [[393,700],[700,393]]) {
      await page.setViewportSize({width:800,height:850})
      await page.locator('#mirrorFrame').evaluate((el,size)=>{el.style.width=size[0]+'px';el.style.height=size[1]+'px'},size)
      for(const mode of ['contain','cover']) {
        await frame.evaluate(mode=>{localStorage.setItem('scrcpyNas.mobile.scale',mode);dispatchEvent(new Event('scrcpynas:scale'))},mode)
        await page.waitForTimeout(80)
        const rect=await frame.locator('.touch-layer').boundingBox()
        const video=await frame.locator('.video-layer').boundingBox()
        assert.deepEqual(rect,video)
        const host=await page.locator('#mirrorFrame').boundingBox()
        const x=Math.round((Math.max(host.x,rect.x)+Math.min(host.x+size[0],rect.x+rect.width))/2+15)
        const y=Math.round((Math.max(host.y,rect.y)+Math.min(host.y+size[1],rect.y+rect.height))/2+20)
        const before=stats.commands.length
        await page.touchscreen.tap(x,y)
        for(let i=0;stats.commands.length===before && i<30;i++)await page.waitForTimeout(20)
        const command=stats.commands.slice(before).find(c=>c[0]===2 && c[1]===0)
        assert.ok(command,'real engine must send touch DOWN')
        const b=Buffer.from(command)
        const tx=b.readInt32BE(10),ty=b.readInt32BE(14)
        assert.ok(Math.abs(tx-(x-rect.x)*source[0]/rect.width)<3,JSON.stringify({source,size,mode,tx,rect,x}))
        assert.ok(Math.abs(ty-(y-rect.y)*source[1]/rect.height)<3,JSON.stringify({source,size,mode,ty,rect,y}))
      }
    }
  }
  assert.equal(stats.sockets,1)
 })

// 唯一播放器保留参数、认证和沉浸，应用设置无需切换或创建第二路流
 test('native default preserves settings and immersion across explicit reload', async t => {
  const { page, frame, stats } = await fixture(t, false)
  await frame.waitForFunction(() => scrcpyNasProgress.read().drawnSeq > 3)
  await frame.evaluate(() => { document.documentElement.requestFullscreen = undefined; document.querySelector('[data-mobile-action="fullscreen"]').click() })
  await frame.locator('[data-mobile-action="settings"]').evaluate(b => b.click())
  await frame.locator('#media-resolution').selectOption('960')
  await frame.locator('#media-bitrate').selectOption('2000000')
  await frame.locator('#media-fps').selectOption('24')
  await frame.locator('#media-apply').click()
  assert.equal(stats.sockets, 1)
  await Promise.all([frame.waitForNavigation(), frame.evaluate(() => location.reload())])
  await frame.waitForFunction(() => scrcpyNasProgress.read().drawnSeq > 3)
  assert.equal(stats.sockets, 2)
  assert.equal(await frame.evaluate(() => document.body.classList.contains('mobile-immersive')), true)
  const saved = await frame.evaluate(() => JSON.parse(localStorage.getItem('scrcpyNas.media.fixture')))
  assert.deepEqual(saved, { maxSize: 960, bitrate: 2000000, maxFps: 24 })
  const actual = await frame.evaluate(() => client.player.getVideoSettings().toJSON())
  assert.equal(actual.bitrate, 2000000)
  assert.equal(actual.maxFps, 24)
  assert.equal(actual.bounds.width, 960)
  assert.equal(await frame.evaluate(() => scrcpyNasPlayerStatus.mode), 'webcodecs')
  assert.equal(await frame.evaluate(() => document.cookie.includes('fixture=valid')), true)
 })

// 原声音模块借用稳定宿主上下文，画布重载恢复必须先通过新画面稳定门禁
 test('host audio resumes only after fresh canvas stability and exit releases the screen lease', async t => {
  const {page,frame,stats}=await fixture(t)
  await frame.waitForFunction(()=>scrcpyNasProgress.read().drawnSeq>5)
  await page.evaluate(()=>{window.hostContexts=[];const Native=AudioContext;window.AudioContext=class extends Native{constructor(...args){super(...args);hostContexts.push(this)}}})
  await frame.locator('[data-mobile-action="settings"]').evaluate(b=>b.click())
  await frame.locator('#phone-audio-toggle').click()
  await frame.waitForFunction(()=>/接收 [1-9]/.test(document.querySelector('#media-audio-status').textContent))
  await frame.locator('#phone-audio-volume').fill('0.43')
  assert.equal(stats.starts,1)
  await frame.evaluate(()=>{
    Object.defineProperty(document,'hidden',{configurable:true,value:true})
    Object.defineProperty(document,'visibilityState',{configurable:true,value:'hidden'})
    document.dispatchEvent(new Event('visibilitychange'))
    window.dispatchEvent(new Event('scrcpynas:recovering'))
  })
  await page.waitForFunction(()=>hostContexts[0].state==='suspended')
  await frame.evaluate(()=>location.reload())
  await frame.waitForFunction(()=>window.scrcpyNasProgress?.read().drawnSeq>1)
  assert.equal(stats.starts,1,'first real output is not sufficient for audio restart')
  await frame.waitForFunction(()=>/接收 [1-9]/.test(document.querySelector('#media-audio-status').textContent))
  assert.equal(stats.starts,2)
  assert.equal(await page.evaluate(()=>hostContexts.length),1)
  assert.equal(await frame.locator('#phone-audio-volume').inputValue(),'0.43')
  assert.equal(await page.locator('#scrcpynas-recovery-cover').count(),0)
  // 显式拒绝恢复授权只测试音频独立门禁，不伪造任何视频时间或画布进展
  await page.evaluate(()=>{hostContexts[0].resume=()=>Promise.reject(new Error('fixture autoplay denial'))})
  await frame.evaluate(()=>{
    Object.defineProperty(document,'hidden',{configurable:true,value:true})
    Object.defineProperty(document,'visibilityState',{configurable:true,value:'hidden'})
    document.dispatchEvent(new Event('visibilitychange'))
    window.dispatchEvent(new Event('scrcpynas:recovering'))
  })
  await frame.evaluate(()=>location.reload())
  await page.locator('#scrcpynas-recovery-cover').waitFor({state:'detached',timeout:6000})
  await frame.locator('#phone-audio-gesture').waitFor({state:'visible'})
  assert.equal(stats.starts,2,'rejected audio resume cannot start capture or re-cover the video')
  await frame.evaluate(()=>window.dispatchEvent(new Event('scrcpynas:disconnect')))
  await page.waitForFunction(()=>hostContexts[0].state==='closed')
  for(let i=0;stats.releases===0 && i<50;i++)await page.waitForTimeout(20)
  assert.equal(stats.releases,1)
  assert.equal(stats.release.serial,'fixture')
  assert.match(stats.release.token,/^[a-f0-9]{32}$/)
  assert.match(stats.release.lease,/^[a-f0-9]{32}$/)
  await frame.evaluate(()=>window.dispatchEvent(new Event('scrcpynas:video-restored')))
  await page.waitForTimeout(100)
  assert.equal(stats.starts,2)
 })

// 认证拒绝与手动退出不允许恢复旧世代或声音
for(const response of [401,403,'manual']) {
 test('canvas foreground recovery remains terminal after '+response,async t=>{
  const {page,frame,stats}=await fixture(t)
  await frame.waitForFunction(()=>scrcpyNasProgress.read().drawnSeq>5)
  stats.auth=response==='manual'?200:response
  await frame.evaluate(manual=>{
    if(manual)window.dispatchEvent(new Event('scrcpynas:disconnect'))
    Object.defineProperty(document,'visibilityState',{configurable:true,value:'hidden'})
    document.dispatchEvent(new Event('visibilitychange'))
    Object.defineProperty(document,'visibilityState',{configurable:true,value:'visible'})
    document.dispatchEvent(new Event('visibilitychange'))
    window.dispatchEvent(new Event('focus'))
  },response==='manual')
  await page.waitForTimeout(1600)
  assert.equal(stats.sockets,1)
  assert.equal(await frame.evaluate(()=>scrcpyNasProgress.read().ready),false)
  assert.equal(await page.locator('#scrcpynas-recovery-cover').count(),0)
 })
}

// 模拟温连接先到 delta，真正的设置刷新命令带回配置和关键帧后原生出图
 test('warm mid-GOP arrival recovers on the existing socket without malformed-stream failure', async t => {
  const { frame, stats } = await fixture(t, true, '', { warmResume: true })
  await frame.waitForFunction(() => scrcpyNasProgress.read().drawnSeq > 5)
  assert.equal(stats.sockets, 1)
  assert.ok(stats.commands.some(command => command[0] === 101))
  assert.equal(await frame.evaluate(() => scrcpyNasPlayerStatus.mode), 'webcodecs')
  assert.ok(await frame.evaluate(() => client.player.lowLatencyCore.stats.idrRequests > 0))
 })

// 使用真实 High 多切片突发送帧验证有界排队，不能靠均匀定时器掩盖网络突发
 test('native High eight-frame bursts keep decoding without reset or fallback', async t => {
  const { frame, stats } = await fixture(t, true, '', { burst: 8, width: 576, height: 1280 })
  await frame.waitForFunction(() => client.player.lowLatencyCore?.stats.output >= 120, {}, { timeout: 12000 })
  stats.paused = true
  const result = await frame.evaluate(() => ({ status: scrcpyNasPlayerStatus, stats: client.player.lowLatencyCore.stats, queued: client.player.lowLatencyCore.pendingAUs.length }))
  t.diagnostic(JSON.stringify(result))
  assert.equal(result.status.mode, 'webcodecs')
  assert.equal(result.stats.resets, 0)
  assert.equal(result.stats.idrRequests, 0)
  assert.ok(result.stats.queueMax <= 4)
  assert.ok(result.queued <= 16)
  assert.equal(stats.sockets, 1)
 })
