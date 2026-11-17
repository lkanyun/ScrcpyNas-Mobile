// Modified in the Mobile Remote derivative (2026): mobile UI, media transport or recovery changes; see MODIFICATIONS.md.
'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const { PassThrough } = require('node:stream')
const { chromium, webkit } = require('playwright')
const { createPhoneAudio } = require('../lib/phone-audio')

// 使用真实传输和播放器，仅替换安卓采集与可控的浏览器授权门槛
async function fixture(t, policy = 'native') {
  const stats = { starts: 0, stops: 0, bytes: 0 }
  const server = http.createServer((req, res) => {
    if (req.url === '/session/check') { res.writeHead(204); return res.end() }
    if (req.url === '/phone-audio.js') { res.setHeader('Content-Type', 'application/javascript'); return res.end(fs.readFileSync(path.resolve(__dirname, '../public/phone-audio.js'))) }
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    res.setHeader('Set-Cookie', 'fixture=valid; SameSite=Strict; Path=/')
    res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><body><div id="picture" style="height:200px">远程画面</div><section id="media-panel"><p id="media-audio-status"></p></section><script src="/phone-audio.js"></script>')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = 'http://127.0.0.1:' + server.address().port
  const audio = createPhoneAudio({ origin, sessionCheckUrl: origin + '/session/check', selectTarget: async () => 'fixture', startCapture: async () => {
    stats.starts++
    const stream = new PassThrough()
    const timer = setInterval(() => { const pcm = Buffer.alloc(3840); pcm.writeInt16LE(1000); stats.bytes += pcm.length; stream.write(pcm) }, 20)
    return { stream, async stop() { clearInterval(timer); stream.destroy(); stats.stops++ } }
  } })
  server.on('upgrade', audio.handleUpgrade)
  const browser = process.env.PHONE_AUDIO_WEBKIT_EXECUTABLE ? await webkit.launch({ executablePath: process.env.PHONE_AUDIO_WEBKIT_EXECUTABLE }) : await chromium.launch({ args: ['--no-sandbox'] })
  const page = await browser.newPage({ hasTouch: true })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.addInitScript(policy => {
    const Native = window.AudioContext || window.webkitAudioContext
    window.audioContexts = []
    window.played = 0
    window.gestureSeen = false
    window.remoteTouches = 0
    // 独立观察可信事件是否仍送达远程控制区域
    document.addEventListener('pointerdown', event => { if (event.target.id === 'picture') window.remoteTouches++ })
    for (const name of ['pointerdown', 'touchstart', 'click']) document.addEventListener(name, event => { if (event.isTrusted) window.gestureSeen = true }, true)
    window.AudioContext = class extends Native {
      constructor(...args) { super(...args); window.audioContexts.push(this) }
      createGain() { const gain = super.createGain(); if (!this.testVolumeGain) { this.testVolumeGain = gain; window.audioGain = gain }; return gain }
      createBufferSource() { window.played++; return super.createBufferSource() }
      resume() {
        window.resumeCalls = (window.resumeCalls || 0) + 1
        if (policy !== 'native' && !navigator.userActivation?.isActive && !window.gestureSeen) {
          if (policy === 'hang') return new Promise(resolve => { window.releaseResume = () => { if (this.state === 'closed') resolve(); else super.resume().then(resolve) } })
          return Promise.reject(new DOMException('gesture required', 'NotAllowedError'))
        }
        return super.resume()
      }
    }
  }, policy)
  t.after(async () => {
    await browser.close()
    await audio.stop()
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    assert.equal(server.listening, false)
    assert.deepEqual(errors, [])
  })
  // 通过实际页面导航保留同源设备偏好
  async function open(device = 'one') { await page.goto(origin + '/?device=' + device + '#!action=stream&udid=' + device); await page.locator('#phone-audio-toggle').waitFor() }
  // 等待非静音测试采样真正进入 WebAudio
  async function playing() { await page.waitForFunction(() => window.played > 0) }
  // 用公开生命周期事件模拟浏览器前后台切换
  async function hidden(value) { await page.evaluate(value => { Object.defineProperty(document, 'hidden', { configurable: true, value }); document.dispatchEvent(new Event('visibilitychange')) }, value) }
  return { page, stats, open, playing, hidden, disconnect() { audio.disconnectSession({ headers: { cookie: 'fixture=valid' } }) } }
}

// 系统媒体播放须在创建上下文之前声明用途，避免 iOS 将其视为服从静音开关的环境音
 test('explicit audio requests playback session before creating the real audio context', async t => {
  const f = await fixture(t)
  await f.page.addInitScript(() => {
    const session = { type: 'auto' }
    Object.defineProperty(navigator, 'audioSession', { configurable: true, value: session })
    const Native = window.AudioContext
    window.AudioContext = class extends Native {
      constructor(...args) { window.sessionAtContextCreation = navigator.audioSession.type; super(...args) }
    }
  })
  await f.open()
  assert.equal(await f.page.evaluate(() => navigator.audioSession.type), 'auto')
  await f.page.locator('#phone-audio-toggle').click()
  await f.playing()
  assert.equal(await f.page.evaluate(() => window.sessionAtContextCreation), 'playback')
  assert.equal(await f.page.evaluate(() => navigator.audioSession.type), 'playback')
})

// 音频诊断区分源采样、浏览器图输出与硬件可听性，不把建立节点冒充有声
 test('audio status exposes live source and browser output measurements without claiming hardware audibility', async t => {
  const f = await fixture(t)
  await f.open()
  await f.page.locator('#phone-audio-toggle').click()
  await f.playing()
  await f.page.waitForFunction(() => /源峰值 [1-9]/.test(document.querySelector('#media-audio-status').textContent) && /图输出峰值 [1-9]/.test(document.querySelector('#media-audio-status').textContent), null, { timeout: 5000 })
  const text = await f.page.locator('#media-audio-status').innerText()
  assert.match(text, /播放器 running/)
  assert.match(text, /网页音量 100%/)
  assert.match(text, /接收 [1-9]\d* KB/)
  assert.match(text, /不代表扬声器已出声/)
})

// 系统暂停只恢复既有输出 不结束已确认稳定的温采集
 test('native audio suspension retains capture and trusted touch restores the saved intent', async t => {
  const f = await fixture(t)
  await f.open()
  await f.page.locator('#phone-audio-toggle').click()
  await f.playing()
  await f.page.evaluate(() => window.audioContexts[0].suspend())
  await f.page.waitForFunction(() => window.audioContexts[0].state === 'suspended', null, { timeout: 1800 })
  const bytes = f.stats.bytes
  await new Promise(resolve => setTimeout(resolve, 120))
  assert.ok(f.stats.bytes > bytes)
  assert.equal(f.stats.stops, 0)
  assert.equal(await f.page.evaluate(() => JSON.parse(localStorage.getItem('scrcpyNas.audio.unity.one')).enabled), true)
  await f.page.locator('#phone-audio-gesture').waitFor({ state: 'visible' })
  const before = await f.page.evaluate(() => window.played)
  await f.page.locator('#picture').tap()
  await f.page.waitForFunction(before => window.audioContexts.length === 1 && window.audioContexts[0].state === 'running' && window.played > before, before)
  assert.equal(f.stats.starts, 1)
})

// 已获浏览器授权时重载可直接恢复，不要求打开设置
 test('reload attempts native resume and restores saved volume without settings', async t => {
  const f = await fixture(t)
  await f.open()
  await f.page.locator('#phone-audio-toggle').click()
  await f.playing()
  await f.page.locator('#phone-audio-volume').fill('0.53')
  await f.page.reload()
  await f.page.waitForFunction(() => window.resumeCalls === 1)
  assert.equal(await f.page.locator('#phone-audio-toggle').getAttribute('aria-pressed'), 'true')
  assert.equal(await f.page.locator('#phone-audio-volume').inputValue(), '0.53')
  // 原生引擎自行决定重载授权，受限时仅补充真实画面触摸
  if (await f.page.evaluate(() => window.audioContexts[0].state !== 'running')) await f.page.locator('#picture').tap()
  await f.playing()
  assert.equal(f.stats.starts, 2)
  assert.equal(await f.page.evaluate(() => window.audioContexts.length), 1)
  assert.ok(Math.abs(await f.page.evaluate(() => window.audioGain.gain.value) - 0.53) < 0.0001)
  t.diagnostic('native reload resume calls: ' + await f.page.evaluate(() => window.resumeCalls))
})

// 手动关闭撤销悬挂授权，之后的触摸与晚到结果都不能再采集
 test('manual off cancels a pending resume across gestures and reload', async t => {
  const f = await fixture(t, 'hang')
  await f.open()
  await f.page.evaluate(() => localStorage.setItem('scrcpyNas.audio.unity.one', JSON.stringify({ enabled: true, volume: 0.2 })))
  await f.page.reload()
  await f.page.locator('#phone-audio-toggle').click()
  await f.page.waitForFunction(() => window.audioContexts[0].state === 'closed')
  await f.page.locator('#picture').tap()
  await f.page.evaluate(() => window.releaseResume?.())
  await f.hidden(true)
  await f.hidden(false)
  await new Promise(resolve => setTimeout(resolve, 650))
  assert.equal(f.stats.starts, 0)
  assert.equal(await f.page.evaluate(() => window.audioContexts.length), 1)
  assert.equal(await f.page.locator('#phone-audio-gesture').isVisible(), false)
  await f.page.reload()
  assert.equal(await f.page.locator('#phone-audio-toggle').getAttribute('aria-pressed'), 'false')
  assert.equal(await f.page.locator('#phone-audio-volume').inputValue(), '0.2')
  assert.equal(await f.page.evaluate(() => window.audioContexts.length), 0)
})

// 格式错误或越界偏好不能意外开启采集，也不能影响其他设备
 test('corrupt or invalid storage stays safely opt-in', async t => {
  const f = await fixture(t)
  await f.open()
  for (const value of ['{broken', 'null', '[]', '{"enabled":"true","volume":1}', '{"enabled":true,"volume":10.01}', '{"enabled":true,"volume":-1}', '{"enabled":true,"volume":"0.3"}']) {
    await f.page.evaluate(value => localStorage.setItem('scrcpyNas.audio.unity.one', value), value)
    await f.page.reload()
    assert.equal(await f.page.locator('#phone-audio-toggle').getAttribute('aria-pressed'), 'false')
    assert.equal(await f.page.locator('#phone-audio-volume').inputValue(), '1')
    assert.equal(await f.page.evaluate(() => window.audioContexts.length), 0)
    assert.equal(f.stats.starts, 0)
  }
})

// 浏览器拒绝持久存储仍可在当前页手势开启和调整音量
 test('unavailable storage does not break browser audio controls', async t => {
  const f = await fixture(t)
  await f.page.addInitScript(() => {
    Storage.prototype.getItem = Storage.prototype.setItem = () => { throw new DOMException('blocked', 'SecurityError') }
  })
  await f.open()
  assert.equal(f.stats.starts, 0)
  await f.page.locator('#phone-audio-toggle').click()
  await f.playing()
  await f.page.locator('#phone-audio-volume').fill('0.15')
  assert.ok(Math.abs(await f.page.evaluate(() => window.audioGain.gain.value) - 0.15) < 0.0001)
})

// 网络错误只关闭运行资源，重载时仍可从保存的意愿恢复
 test('connection error preserves enabled preference and reload handles rejected autoplay', async t => {
  const f = await fixture(t, 'reject')
  await f.open()
  await f.page.locator('#phone-audio-toggle').click()
  await f.playing()
  await f.page.locator('#phone-audio-volume').fill('0.6')
  f.disconnect()
  await f.page.waitForFunction(() => window.audioContexts[0].state === 'suspended')
  assert.deepEqual(await f.page.evaluate(() => JSON.parse(localStorage.getItem('scrcpyNas.audio.unity.one'))), { enabled: true, volume: 0.6 })
  await f.page.reload()
  await f.page.locator('#phone-audio-gesture').waitFor({ state: 'visible' })
  assert.equal(f.stats.starts, 1)
  await f.page.locator('#picture').tap()
  await f.playing()
  assert.equal(f.stats.starts, 2)
  assert.equal(await f.page.evaluate(() => window.audioContexts.length), 1)
  assert.ok(Math.abs(await f.page.evaluate(() => window.audioGain.gain.value) - 0.6) < 0.0001)
})

// 不等待超时才监听，刚进入页面的首个真实触摸也能解锁
 test('first trusted pointer during initial pending resume is not lost', async t => {
  const f = await fixture(t, 'hang')
  await f.open()
  await f.page.evaluate(() => localStorage.setItem('scrcpyNas.audio.unity.one', JSON.stringify({ enabled: true, volume: 1 })))
  await f.page.reload()
  await f.page.mouse.click(30, 30)
  assert.equal(await f.page.evaluate(() => window.resumeCalls), 2)
  await f.playing()
  assert.equal(f.stats.starts, 1)
})

// 退出页必须撤销等待手势、生命周期监听和晚到的恢复结果
 test('pagehide permanently cancels pending restore and removes lifecycle listeners', async t => {
  const f = await fixture(t, 'hang')
  await f.open()
  await f.page.evaluate(() => localStorage.setItem('scrcpyNas.audio.unity.one', JSON.stringify({ enabled: true, volume: 0.4 })))
  await f.page.reload()
  await f.page.locator('#phone-audio-gesture').waitFor({ state: 'visible' })
  await f.page.evaluate(() => window.dispatchEvent(new Event('pagehide')))
  await f.page.waitForFunction(() => window.audioContexts[0].state === 'closed')
  await f.hidden(true)
  await f.hidden(false)
  await f.page.locator('#picture').tap()
  await new Promise(resolve => setTimeout(resolve, 650))
  assert.equal(await f.page.evaluate(() => window.audioContexts.length), 1)
  assert.equal(f.stats.starts, 0)
  assert.equal(await f.page.locator('#phone-audio-gesture').isVisible(), false)
  assert.equal(await f.page.evaluate(() => JSON.parse(localStorage.getItem('scrcpyNas.audio.unity.one')).enabled), true)
})

// 重载时遇到悬挂授权，及时提示且首个可信画面触摸可恢复
 test('reload with pending Safari resume waits without capture then trusted touch restores once', async t => {
  const f = await fixture(t, 'hang')
  await f.open()
  await f.page.evaluate(() => localStorage.setItem('scrcpyNas.audio.unity.one', JSON.stringify({ enabled: true, volume: 0.42 })))
  await f.page.reload()
  await f.page.locator('#phone-audio-toggle').waitFor()
  assert.equal(await f.page.locator('#phone-audio-toggle').getAttribute('aria-pressed'), 'true')
  await f.page.evaluate(() => { document.querySelector('#media-panel').hidden = true })
  await f.page.locator('#phone-audio-gesture').waitFor({ state: 'visible', timeout: 1800 })
  assert.match(await f.page.locator('#phone-audio-gesture').innerText(), /轻触画面恢复声音/)
  assert.equal(f.stats.starts, 0)
  assert.equal(await f.page.evaluate(() => window.audioContexts.length), 1)
  await f.page.evaluate(() => document.querySelector('#picture').dispatchEvent(new Event('pointerdown', { bubbles: true })))
  await new Promise(resolve => setTimeout(resolve, 60))
  assert.equal(f.stats.starts, 0)
  await f.page.locator('#picture').tap()
  await f.playing()
  assert.equal(f.stats.starts, 1)
  assert.ok(await f.page.evaluate(() => window.remoteTouches > 0))
  assert.equal(await f.page.evaluate(() => window.audioContexts.length), 1)
  assert.ok(Math.abs(await f.page.evaluate(() => window.audioGain.gain.value) - 0.42) < 0.0001)
  await f.page.locator('#picture').tap()
  await f.page.evaluate(() => window.releaseResume?.())
  await new Promise(resolve => setTimeout(resolve, 80))
  assert.equal(f.stats.starts, 1)
  assert.equal(await f.page.locator('#phone-audio-gesture').isVisible(), false)
  t.diagnostic('PCM observed: ' + JSON.stringify(f.stats))
})

// 后台保持采集与输出 前台重用授权 明确关闭后不得自动复活
 test('background keeps the warm capture and foreground reuses it only while enabled', async t => {
  const f = await fixture(t)
  await f.open()
  await f.page.locator('#phone-audio-toggle').click()
  await f.playing()
  await f.page.locator('#phone-audio-volume').fill('0.39')
  await f.hidden(true)
  const bytes = f.stats.bytes
  await new Promise(resolve => setTimeout(resolve, 120))
  assert.ok(f.stats.bytes > bytes)
  assert.equal(f.stats.stops, 0)
  assert.equal(await f.page.evaluate(() => window.audioContexts[0].state), 'running')
  assert.equal(await f.page.evaluate(() => JSON.parse(localStorage.getItem('scrcpyNas.audio.unity.one')).enabled), true)
  await f.hidden(false)
  await f.page.waitForFunction(() => window.audioContexts.length === 1 && window.audioContexts[0].state === 'running')
  assert.ok(Math.abs(await f.page.evaluate(() => window.audioGain.gain.value) - 0.39) < 0.0001)
  assert.equal(f.stats.starts, 1)
  await f.page.locator('#phone-audio-toggle').click()
  await f.hidden(true)
  await f.hidden(false)
  await new Promise(resolve => setTimeout(resolve, 100))
  assert.equal(f.stats.starts, 1)
  assert.equal(f.stats.stops, 1)
  assert.equal(await f.page.locator('#phone-audio-toggle').getAttribute('aria-pressed'), 'false')
})

// 开关及音量独立即时持久化，不依赖视频应用按钮
 test('audio switch and browser-only volume save immediately per device', async t => {
  const f = await fixture(t)
  await f.open()
  assert.equal(f.stats.starts, 0)
  await f.page.locator('#phone-audio-toggle').click()
  await f.playing()
  await f.page.locator('#phone-audio-volume').fill('0.37')
  assert.deepEqual(await f.page.evaluate(() => JSON.parse(localStorage.getItem('scrcpyNas.audio.unity.one'))), { enabled: true, volume: 0.37 })
  assert.match(await f.page.locator('label[for="phone-audio-volume"]').innerText(), /37%/)
  assert.ok(Math.abs(await f.page.evaluate(() => window.audioGain.gain.value) - 0.37) < 0.0001)
  await f.page.locator('#phone-audio-toggle').click()
  assert.deepEqual(await f.page.evaluate(() => JSON.parse(localStorage.getItem('scrcpyNas.audio.unity.one'))), { enabled: false, volume: 0.37 })
  await f.open('two')
  assert.equal(await f.page.locator('#phone-audio-volume').inputValue(), '1')
  assert.equal(await f.page.locator('#phone-audio-toggle').getAttribute('aria-pressed'), 'false')
  await f.open()
  assert.equal(await f.page.locator('#phone-audio-volume').inputValue(), '0.37')
  assert.equal(await f.page.locator('#phone-audio-toggle').getAttribute('aria-pressed'), 'false')
})

// 增强档位也必须实时保存 并在刷新后继续生效
 test('boosted volume up to ten times is retained without starting capture', async t => {
  const f = await fixture(t)
  await f.open()
  await f.page.locator('#phone-audio-volume').fill('10')
  assert.match(await f.page.locator('#phone-audio-volume-value').innerText(), /1000%/)
  await f.page.reload()
  assert.equal(await f.page.locator('#phone-audio-volume').inputValue(), '10')
  assert.equal(f.stats.starts, 0)
  await f.page.locator('[data-audio-volume="0.25"]').click()
  assert.equal(await f.page.locator('#phone-audio-volume').inputValue(), '0.25')
  await f.page.locator('#phone-audio-toggle').click()
  await f.page.waitForFunction(() => window.audioContexts.length > 0 && window.audioContexts[0].state === 'running')
  await f.page.locator('#phone-audio-volume').fill('10')
  assert.equal(JSON.parse(await f.page.evaluate(() => localStorage.getItem('scrcpyNas.audio.unity.one'))).volume, 10)
 })

// 源音量校准后只继承声音开关，旧网页放大倍数必须清零
 test('legacy boosted gain migrates to unity without losing enabled preference', async t => {
  const f = await fixture(t)
  await f.open()
  await f.page.evaluate(() => localStorage.setItem('scrcpyNas.audio.one', JSON.stringify({ enabled: true, volume: 6 })))
  await f.page.reload()
  assert.equal(await f.page.locator('#phone-audio-volume').inputValue(), '1')
  assert.equal(await f.page.locator('#phone-audio-toggle').getAttribute('aria-pressed'), 'true')
 })

// WebRTC 改写会话后恢复媒体声明，手动修复必须新建上下文且不更改音量
 test('RTC negotiation restores playback and explicit repair replaces the audio context', async t => {
  const f = await fixture(t)
  await f.page.addInitScript(() => Object.defineProperty(navigator, 'audioSession', { configurable: true, value: { type: 'auto' } }))
  await f.open()
  await f.page.locator('#phone-audio-toggle').click()
  await f.playing()
  await f.page.evaluate(() => { navigator.audioSession.type = 'play-and-record'; dispatchEvent(new Event('scrcpynas:rtc-connected')) })
  assert.equal(await f.page.evaluate(() => navigator.audioSession.type), 'playback')
  const before = await f.page.evaluate(() => audioContexts.length)
  await f.page.locator('#phone-audio-route-repair').click()
  await f.page.waitForFunction(count => audioContexts.length > count && audioContexts.at(-1).state === 'running', before)
  assert.equal(await f.page.evaluate(() => audioContexts[0].state), 'closed')
  assert.equal(await f.page.evaluate(() => navigator.audioSession.type), 'playback')
  assert.equal(await f.page.locator('#phone-audio-volume').inputValue(), '1')
 })

// 实际媒体输出必须推进时间且关闭后释放轨道，避免只有 WebAudio 图非零却未播放
 test('media element renders audio once and releases its track on disable', async t => {
  const f = await fixture(t)
  await f.open()
  await f.page.locator('#phone-audio-toggle').click()
  await f.playing()
  await f.page.waitForFunction(() => { const audio = document.querySelector('#phone-audio-output'); return audio && !audio.paused && audio.currentTime > 0.1 })
  assert.equal(await f.page.locator('#phone-audio-output').count(), 1)
  await f.page.evaluate(() => { window.outputTrack = document.querySelector('#phone-audio-output').srcObject.getAudioTracks()[0] })
  await f.page.locator('#phone-audio-toggle').click()
  assert.equal(await f.page.locator('#phone-audio-output').count(), 0)
  assert.equal(await f.page.evaluate(() => outputTrack.readyState), 'ended')
 })

// 输出元素独立暂停时重用原连接恢复 不影响共享采集
 test('paused media output recovers without restarting capture or changing enabled preference', async t => {
  const f = await fixture(t)
  await f.open()
  await f.page.locator('#phone-audio-toggle').click()
  await f.playing()
  await f.page.evaluate(() => document.querySelector('#phone-audio-output').pause())
  await f.page.waitForFunction(() => !document.querySelector('#phone-audio-output').paused, null, { timeout: 4000 })
  assert.equal(f.stats.starts, 1)
  assert.equal(f.stats.stops, 0)
  assert.equal(await f.page.evaluate(() => JSON.parse(localStorage.getItem('scrcpyNas.audio.unity.one')).enabled), true)
 })

// 输出播放被拦截时保留采集 真实点击后只恢复当前客户端
 test('blocked output resume offers a gesture retry without dropping shared capture', async t => {
  const f = await fixture(t)
  await f.open()
  await f.page.locator('#phone-audio-toggle').click()
  await f.playing()
  await f.page.evaluate(() => {
    const media = document.querySelector('#phone-audio-output')
    const play = media.play.bind(media)
    window.blockOutput = true
    media.play = () => window.blockOutput ? Promise.reject(new DOMException('gesture required', 'NotAllowedError')) : play()
    media.pause()
  })
  await f.page.locator('#phone-audio-gesture').waitFor({ state: 'visible', timeout: 4000 })
  assert.equal(f.stats.starts, 1)
  assert.equal(f.stats.stops, 0)
  await f.page.evaluate(() => { window.blockOutput = false })
  await f.page.locator('#picture').tap()
  await f.page.waitForFunction(() => !document.querySelector('#phone-audio-output').paused)
  assert.equal(f.stats.starts, 1)
 })
