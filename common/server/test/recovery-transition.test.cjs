// Modified in the Mobile Remote derivative (2026): mobile UI, media transport or recovery changes; see MODIFICATIONS.md.
'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const { execFileSync } = require('node:child_process')
const { chromium, webkit } = require('playwright')
const { PassThrough } = require('node:stream')
const { createPhoneAudio } = require('../lib/phone-audio')
const publicDir = path.resolve(__dirname, '../public')

// 合成颜色视频仅在隔离本地夹具播放，不连接真实投屏或音频
async function fixture(t) {
  const clip = path.join(process.env.TMPDIR, 'recovery-fixture-' + process.pid + '.mp4')
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x40a060:s=160x320:r=30', '-t', '8', '-c:v', 'libx264', '-profile:v', 'baseline', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', clip])
  const server = http.createServer((req, res) => {
    if (req.url === '/session/check') { res.writeHead(204); return res.end() }
    res.setHeader('Set-Cookie', 'fixture=valid; SameSite=Strict; Path=/')
    if (req.url === '/clip.mp4') { res.setHeader('Content-Type', 'video/mp4'); return res.end(fs.readFileSync(clip)) }
    if (req.url.endsWith('.js')) { res.setHeader('Content-Type', 'text/javascript'); return res.end(fs.readFileSync(path.join(publicDir, req.url.slice(1)))) }
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    if (req.url === '/') return res.end('<body><a id="navigation" href="#navigation">导航</a><iframe id="mirrorFrame" style="position:absolute;left:30px;top:50px;width:300px;height:460px;border:0" src="/scrcpy/#!action=stream&udid=fixture"></iframe></body>')
    res.end('<body class="stream" style="margin:0"><script src="/reconnect.js"></script><div class="video"><video class="video-layer" style="position:absolute;left:-10px;top:0;width:320px;height:640px;object-fit:contain" muted autoplay loop playsinline src="/clip.mp4"></video><div class="touch-layer"></div></div><div id="media-panel" style="position:relative;z-index:5"></div><script src="/phone-audio.js"></script></body>')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = 'http://127.0.0.1:' + server.address().port
  const stats = { starts: 0, stops: 0 }
  const audio = createPhoneAudio({ origin, sessionCheckUrl: origin + '/session/check', selectTarget: async () => 'fixture', startCapture: async () => {
    stats.starts++
    const stream = new PassThrough()
    const timer = setInterval(() => { const pcm = Buffer.alloc(3840); pcm.writeInt16LE(1000); stream.write(pcm) }, 20)
    return { stream, async stop() { clearInterval(timer); stream.destroy(); stats.stops++ } }
  } })
  server.on('upgrade', audio.handleUpgrade)
  const browser = process.env.RECOVERY_WEBKIT_EXECUTABLE ? await webkit.launch({ executablePath: process.env.RECOVERY_WEBKIT_EXECUTABLE }) : await chromium.launch({ args: ['--no-sandbox'] })
  const page = await browser.newPage({ viewport: { width: 500, height: 700 } })
  const errors = []
  page.setDefaultTimeout(10000)
  page.on('pageerror', e => errors.push(e.message))
  page.on('requestfailed', req => t.diagnostic('fixture request failed: ' + req.url() + ' ' + req.failure()?.errorText))
  t.after(async () => {
    await browser.close()
    await audio.stop()
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    fs.unlinkSync(clip)
    assert.equal(server.listening, false)
    assert.deepEqual(errors, [])
  })
  await page.goto(origin)
  const frame = page.frames()[1]
  await frame.waitForFunction(() => document.querySelector('video').currentTime > 0.15)
  return { page, frame, stats }
}

// 重载前抓到的画面留在同源外层，只有新视频持续前进才撤遮罩
 test('last-frame cover survives iframe reload and waits for fresh advancing video', async t => {
  const { page, frame } = await fixture(t)
  await frame.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  assert.equal(await page.locator('#scrcpynas-recovery-cover').count(), 0)
  await frame.evaluate(() => window.dispatchEvent(new Event('scrcpynas:recovering')))
  await page.locator('#scrcpynas-recovery-cover').waitFor({ state: 'visible', timeout: 1500 })
  const snapshot = await page.evaluate(() => {
    const canvas = document.querySelector('#scrcpynas-recovery-cover canvas')
    return { pixel: Array.from(canvas.getContext('2d').getImageData(0, 0, 1, 1).data), rect: canvas.getBoundingClientRect().toJSON(), text: document.querySelector('#scrcpynas-recovery-cover').textContent }
  })
  assert.ok(snapshot.pixel[1] > snapshot.pixel[0], JSON.stringify(snapshot))
  assert.ok(Math.abs(snapshot.rect.width - 320) < 1 && Math.abs(snapshot.rect.height - 640) < 1, JSON.stringify(snapshot))
  assert.match(snapshot.text, /重新连接/)
  await frame.evaluate(() => { window.staleTouches = 0; document.addEventListener('pointerdown', () => window.staleTouches++) })
  await page.mouse.click(100, 140)
  assert.equal(await frame.evaluate(() => window.staleTouches), 0)
  assert.equal(await page.locator('#scrcpynas-recovery-cover button').isEnabled(), true)
  await frame.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await page.waitForTimeout(1300)
  assert.equal(await page.locator('#scrcpynas-recovery-cover').isVisible(), true, 'old document progress cannot release reload cover')
  await frame.evaluate(() => window.dispatchEvent(new Event('scrcpynas:recovering')))
  await Promise.all([frame.waitForNavigation(), frame.evaluate(() => location.reload())])
  await frame.evaluate(() => document.querySelector('video').pause())
  await page.waitForTimeout(1200)
  assert.equal(await page.locator('#scrcpynas-recovery-cover').isVisible(), true)
  assert.equal(await page.locator('#navigation').isVisible(), true)
  await frame.evaluate(() => document.querySelector('video').play())
  await page.locator('#scrcpynas-recovery-cover').waitFor({ state: 'detached', timeout: 5000 }).catch(async error => {
    t.diagnostic(JSON.stringify(await frame.evaluate(() => { const v = document.querySelector('video'); return { time: v.currentTime, paused: v.paused, ready: v.readyState, width: v.videoWidth, visibility: document.visibilityState, error: v.error?.code } })))
    throw error
  })
  assert.ok(await frame.evaluate(() => document.querySelector('video').currentTime > 0.5))
})

// 上下文属于稳定宿主，后台保持播放，真实重连跨内页复用已授权播放器
 test('unlocked host audio context survives reconnect reload without another click', async t => {
  const { page, frame, stats } = await fixture(t)
  await page.evaluate(() => {
    window.hostContexts = []
    Object.defineProperty(navigator, 'audioSession', { configurable: true, value: { type: 'auto' } })
    const Native = window.AudioContext
    window.AudioContext = class extends Native {
      constructor(...args) { super(...args); window.hostContexts.push(this) }
    }
  })
  await frame.locator('#phone-audio-toggle').click()
  await frame.waitForFunction(() => /接收 [1-9]/.test(document.querySelector('#media-audio-status').textContent))
  assert.equal(await page.evaluate(() => window.hostContexts.length), 1)
  assert.equal(await page.evaluate(() => navigator.audioSession.type), 'playback')
  await frame.locator('#phone-audio-volume').fill('0.43')
  await frame.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true })
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
    document.dispatchEvent(new Event('visibilitychange'))
    window.dispatchEvent(new Event('scrcpynas:recovering'))
  })
  assert.equal(await page.evaluate(() => window.hostContexts[0].state), 'running')
  assert.equal(stats.stops, 0)
  await Promise.all([frame.waitForNavigation(), frame.evaluate(() => location.reload())])
  await page.waitForFunction(() => window.hostContexts[0].state === 'suspended')
  for (let i = 0; stats.stops < 1 && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(stats.stops, 1)
  await frame.evaluate(() => document.querySelector('video').pause())
  await page.waitForTimeout(1200)
  assert.equal(stats.starts, 1, 'audio capture must wait for fresh video stability')
  await frame.evaluate(() => document.querySelector('video').play())
  await frame.waitForFunction(() => /接收 [1-9]/.test(document.querySelector('#media-audio-status').textContent))
  assert.equal(await page.evaluate(() => window.hostContexts.length), 1)
  assert.equal(await page.evaluate(() => window.hostContexts[0].state), 'running')
  assert.equal(await frame.locator('#phone-audio-volume').inputValue(), '0.43')
  assert.equal(stats.starts, 2)
  t.diagnostic('synthetic PCM starts/stops: ' + JSON.stringify(stats))
  await frame.evaluate(() => window.dispatchEvent(new Event('scrcpynas:auth-denied')))
  await page.waitForFunction(() => window.hostContexts[0].state === 'closed', null, { timeout: 1500 })
  assert.equal(await page.evaluate(() => !!document.querySelector('#scrcpynas-recovery-cover')), false)
  await frame.evaluate(() => {
    document.dispatchEvent(new Event('visibilitychange'))
    window.dispatchEvent(new Event('scrcpynas:video-restored'))
  })
  await page.waitForTimeout(100)
  assert.equal(stats.starts, 2)
})

// 抓帧拒绝时仍显示温和过渡，退出、鉴权拒绝与离页均擦除易失像素
 test('capture denial degrades safely and lifecycle events erase canvas pixels', async t => {
  const { page, frame } = await fixture(t)
  await frame.evaluate(() => { parent.CanvasRenderingContext2D.prototype.drawImage = () => { throw new DOMException('tainted', 'SecurityError') } })
  for (const name of ['scrcpynas:disconnect', 'scrcpynas:auth-denied', 'pagehide']) {
    if (name !== 'scrcpynas:disconnect') await Promise.all([frame.waitForNavigation(), frame.evaluate(() => location.reload())])
    await frame.waitForFunction(() => document.querySelector('video').currentTime > 0.1)
    await frame.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
      document.dispatchEvent(new Event('visibilitychange'))
    })
    await frame.evaluate(() => window.dispatchEvent(new Event('scrcpynas:recovering')))
    const cover = page.locator('#scrcpynas-recovery-cover')
    await cover.waitFor({ state: 'visible' })
    assert.equal(await cover.locator('canvas').evaluate(c => c.width), 0)
    await page.evaluate(() => { window.erasedCanvas = document.querySelector('#scrcpynas-recovery-cover canvas') })
    await frame.evaluate(name => window.dispatchEvent(new Event(name)), name)
    if (name === 'pagehide') await page.evaluate(() => window.dispatchEvent(new Event('pagehide')))
    await cover.waitFor({ state: 'detached' })
    assert.equal(await page.evaluate(() => window.erasedCanvas.width + window.erasedCanvas.height), 0)
    if (name !== 'pagehide') {
      await frame.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
      assert.equal(await cover.count(), 0, 'stopped recovery must not recreate retained pixels')
    }
  }
})

// 切换设备不能把旧设备家庭画面带入新目标
 test('changing the iframe device erases the previous device snapshot immediately', async t => {
  const { page, frame } = await fixture(t)
  await frame.evaluate(() => window.dispatchEvent(new Event('scrcpynas:recovering')))
  await page.evaluate(() => { window.erasedCanvas = document.querySelector('#scrcpynas-recovery-cover canvas') })
  const target = new URL(frame.url())
  target.hash = '!action=stream&udid=different-fixture'
  await frame.goto(target.href)
  await page.waitForTimeout(100)
  assert.equal(await page.locator('#scrcpynas-recovery-cover').count(), 0)
  assert.equal(await page.evaluate(() => window.erasedCanvas.width + window.erasedCanvas.height), 0)
})

// 恢复超时后清空旧画面，不让家庭画面永久停留在宿主
 test('recovery timeout erases retained pixels and removes the host cover', async t => {
  const { page, frame } = await fixture(t)
  await page.clock.install()
  await frame.evaluate(() => window.dispatchEvent(new Event('scrcpynas:recovering')))
  await page.evaluate(() => { window.erasedCanvas = document.querySelector('#scrcpynas-recovery-cover canvas') })
  assert.ok(await page.evaluate(() => window.erasedCanvas.width > 0))
  await page.clock.fastForward(31000)
  assert.equal(await page.locator('#scrcpynas-recovery-cover').count(), 0)
  assert.equal(await page.evaluate(() => window.erasedCanvas.width + window.erasedCanvas.height), 0)
})
