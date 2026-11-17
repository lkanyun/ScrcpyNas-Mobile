// Modified in the Mobile Remote derivative (2026): mobile UI, media transport or recovery changes; see MODIFICATIONS.md.
'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { chromium } = require('playwright')

// 静态手机画面可能低帧率，稳定观察允许短采样间隙但仍需真实解码进展
 test('low-frame-rate decoded progress can reset the recovery budget', async () => {
  const b = await chromium.launch({ args: ['--no-sandbox'] })
  try {
    const page = await b.newPage()
    await page.goto('about:blank#!action=stream')
    await page.clock.install()
    await page.evaluate(() => {
      const video = document.createElement('video')
      video.className = 'video-layer'
      document.body.append(video)
      window.playTime = 1
      Object.defineProperties(video, { videoWidth: { value: 576 }, readyState: { value: 4 }, paused: { value: false }, currentTime: { get: () => window.playTime } })
      window.stableCount = 0
      window.addEventListener('scrcpynas:decoded-stable', () => window.stableCount++)
      setInterval(() => window.playTime += 0.1, 1000)
    })
    await page.addScriptTag({ content: fs.readFileSync(path.resolve(__dirname, '../public/safari-media.js'), 'utf8') })
    await page.clock.runFor(18000)
    assert.equal(await page.evaluate(() => window.stableCount), 1)
  } finally { await b.close() }
})

// 解码就绪但停帧或后台均不算稳定，必须连续前台推进后才开放恢复预算
 test('stable decode requires sustained advancing playback rather than readyState or elapsed time', async () => {
  const b = await chromium.launch({ args: ['--no-sandbox'] })
  try {
    const page = await b.newPage()
    await page.goto('about:blank#!action=stream')
    await page.clock.install()
    await page.evaluate(() => {
      const video = document.createElement('video')
      video.className = 'video-layer'
      document.body.append(video)
      window.playTime = 1
      window.hiddenTest = false
      Object.defineProperty(document, 'visibilityState', { get: () => window.hiddenTest ? 'hidden' : 'visible' })
      Object.defineProperties(video, { videoWidth: { value: 576 }, readyState: { value: 4 }, paused: { value: false }, currentTime: { get: () => window.playTime } })
      window.stableCount = 0
      window.addEventListener('scrcpynas:decoded-stable', () => window.stableCount++)
    })
    await page.addScriptTag({ content: fs.readFileSync(path.resolve(__dirname, '../public/safari-media.js'), 'utf8') })
    await page.clock.runFor(20000)
    assert.equal(await page.evaluate(() => window.stableCount), 0)
    await page.evaluate(() => { setInterval(() => window.playTime += 0.5, 500); window.hiddenTest = true })
    await page.clock.runFor(20000)
    assert.equal(await page.evaluate(() => window.stableCount), 0)
    await page.evaluate(() => { window.hiddenTest = false })
    await page.clock.runFor(10000)
    assert.equal(await page.evaluate(() => window.stableCount), 0)
    await page.clock.runFor(6500)
    assert.equal(await page.evaluate(() => window.stableCount), 1)
  } finally { await b.close() }
})

// 已播放后的解码器错误也必须上报，不能因首帧成功停止观察
 test('E3 after initial playback requests automatic recovery without a click', async () => {
  const b = await chromium.launch({ args: ['--no-sandbox'] })
  try {
    const page = await b.newPage()
    await page.goto('about:blank#!action=stream')
    await page.clock.install()
    await page.evaluate(() => {
      const video = document.createElement('video')
      video.className = 'video-layer'
      document.body.append(video)
      Object.defineProperties(video, { videoWidth: { value: 576 }, readyState: { value: 4 }, paused: { value: false } })
      window.decodeErrors = 0
      window.addEventListener('scrcpynas:decode-error', () => window.decodeErrors++)
    })
    await page.addScriptTag({ content: fs.readFileSync(path.resolve(__dirname, '../public/safari-media.js'), 'utf8') })
    await page.clock.runFor(1000)
    await page.evaluate(() => Object.defineProperty(document.querySelector('video'), 'error', { value: { code: 3 } }))
    await page.clock.runFor(2000)
    assert.equal(await page.evaluate(() => window.decodeErrors), 1)
    assert.match(await page.locator('#stream-start-status').textContent(), /E3/)
  } finally { await b.close() }
})

// 解码器报错时重建流会话，普通重试仍复用温连接
 test('decode failure retry discards only its device warm token before reload', async () => {
  const b = await chromium.launch({ args: ['--no-sandbox'] })
  try {
    const page = await b.newPage()
    await page.route('https://fixture.invalid/**', route => route.fulfill({ contentType: 'text/html', body: '<body><video class="video-layer"></video></body>' }))
    await page.goto('https://fixture.invalid/scrcpy/#!action=stream&udid=test-only')
    await page.evaluate(() => {
      sessionStorage.setItem('scrcpyNas.warm.test-only', 'a'.repeat(32))
      sessionStorage.setItem('scrcpyNas.warm.other', 'b'.repeat(32))
      Object.defineProperty(document.querySelector('video'), 'error', { value: { code: 3 } })
    })
    await page.addScriptTag({ content: fs.readFileSync(path.resolve(__dirname, '../public/safari-media.js'), 'utf8') })
    const status = page.locator('#stream-start-status')
    await status.waitFor({ state: 'visible', timeout: 2500 })
    assert.match(await status.textContent(), /E3/)
    await Promise.all([page.waitForEvent('load'), status.getByRole('button', { name: '重新连接', exact: true }).click()])
    assert.equal(await page.evaluate(() => sessionStorage.getItem('scrcpyNas.warm.test-only')), null)
    assert.equal(await page.evaluate(() => sessionStorage.getItem('scrcpyNas.warm.other')), 'b'.repeat(32))
  } finally { await b.close() }
})

// 仅验证本地诊断与用户手势控件，不将夹具标记为真实媒体解码
 test('unsupported media displays actionable error instead of silent blank', async () => {
  const b = await chromium.launch({ args: ['--no-sandbox'] })
  try {
    const page = await b.newPage()
    await page.goto('about:blank#!action=stream')
    await page.evaluate(() => { window.MediaSource = undefined; window.ManagedMediaSource = undefined })
    await page.addScriptTag({ content: fs.readFileSync(path.resolve(__dirname, '../public/safari-media.js'), 'utf8') })
    const status = page.locator('#stream-start-status')
    await status.waitFor({ state: 'visible', timeout: 2500 })
    assert.match(await status.textContent(), /浏览器|系统/)
    assert.match(await status.textContent(), /不支持|升级/)
    assert.equal(await status.locator('button').count() > 0, true)
  } finally { await b.close() }
})

// 静态远控可长时间无新帧 失联与首帧失败仍必须提示
 test('healthy static RTC stays visible while dead transport and missing first frame still warn', async () => {
  const b = await chromium.launch({ args: ['--no-sandbox'] })
  try {
    const page = await b.newPage()
    await page.goto('about:blank#!action=stream')
    await page.clock.install()
    await page.evaluate(() => {
      window.idleHealthy = true
      window.pictureReady = true
      const owner = {}
      window.scrcpyNasLowLatency = { capable: true }
      window.scrcpyNasRtc = { healthyIdle: () => window.idleHealthy }
      window.scrcpyNasProgress = { read: () => ({ mode: 'webrtc', ready: window.pictureReady, owner, position: 1 }) }
    })
    await page.addScriptTag({ content: fs.readFileSync(path.resolve(__dirname, '../public/safari-media.js'), 'utf8') })
    await page.clock.runFor(60000)
    assert.equal(await page.locator('#stream-start-status').isVisible(), false)
    await page.evaluate(() => { window.idleHealthy = false })
    await page.clock.runFor(1000)
    assert.equal(await page.locator('#stream-start-status').isVisible(), true)
    await page.evaluate(() => { window.idleHealthy = true; window.pictureReady = false })
    await page.clock.runFor(1000)
    assert.equal(await page.locator('#stream-start-status').isVisible(), true)
  } finally { await b.close() }
})
