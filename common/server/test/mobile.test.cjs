// Modified in the Mobile Remote derivative (2026): mobile UI, media transport or recovery changes; see MODIFICATIONS.md.
'use strict'

const assert = require('node:assert/strict')
const { test, before, after } = require('node:test')
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const { chromium, webkit } = require('playwright')
const express = require('../../engine/node_modules/express')
const { registerScrcpyProxyRoutes } = require('../lib/scrcpy-proxy')

// 使用真实代理与静态资源启动隔离浏览器夹具，不连接设备
const publicDir = path.resolve(__dirname, '../public')
const servers = []
let browser, page, origin
const requests = []
const browserErrors = []
const externalRequests = []

// 监听本机临时端口并记录待关闭的测试服务器
async function listen(app) {
  const server = http.createServer(app)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  servers.push(server)
  return server.address().port
}

before(async () => {
  const upstream = express()
  upstream.get('/', (_req, res) => res.send('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="main.css"><script defer="defer" src="bundle.js"></script></head><body class="stream"><div class="video"><canvas class="video-layer" width="1080" height="1920"></canvas><div class="touch-layer"></div></div></body></html>'))
  upstream.get('/main.css', (_req, res) => res.type('css').send(fs.readFileSync(path.resolve(__dirname, '../../engine/public/main.css'), 'utf8')))
  upstream.get('/bundle.js', (_req, res) => res.type('js').send(''))
  const wsScrcpyPort = await listen(upstream)
  const app = express()
  app.use(express.json())
  app.post('/api/:area/:action', (req, res) => { requests.push({ url: req.path, body: req.body }); res.json({ ok: true }) })
  app.post('/api/disconnect', (req, res) => { requests.push({ url: req.path, body: req.body }); res.json({ ok: true }) })
  registerScrcpyProxyRoutes(app, {
    wsScrcpyHost: '127.0.0.1', wsScrcpyPort,
    buildProxyPath: url => url.replace(/^\/scrcpy/, '') || '/',
    routeBases: [''], appPath: value => value,
    escapeRegExp: value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  })
  app.use(express.static(publicDir))
  origin = `http://127.0.0.1:${await listen(app)}`
  browser = process.env.GESTURE_WEBKIT_EXECUTABLE ? await webkit.launch({ executablePath: process.env.GESTURE_WEBKIT_EXECUTABLE }) : await chromium.launch({ args: ['--no-sandbox'] })
  page = await browser.newPage({ viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true })
  page.on('pageerror', error => browserErrors.push(error.message))
  page.on('request', request => {
    if (/^https?:/.test(request.url()) && new URL(request.url()).origin !== origin) externalRequests.push(request.url())
  })
})

after(async () => {
  if (browser) await browser.close()
  await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))))
  assert.ok(servers.every(server => !server.listening), 'all fixture ports must be released')
  assert.deepEqual(browserErrors, [], 'browser must not have uncaught script errors')
  assert.deepEqual(externalRequests, [], 'all assets must stay on the local origin')
})

// 通过代理加载真实扩展脚本并等待引擎画面
async function stream() {
  requests.length = 0
  await page.goto(`${origin}/scrcpy/#!action=stream&udid=test-device%3A5555`)
  await page.reload()
  await page.waitForTimeout(100)
}

test('proxy injects a draggable orb with accessible hitbox and compact key menu', async () => {
  await stream()
  const orb = page.locator('#mobile-orb')
  assert.equal(await orb.count(), 1, 'stream should mount the mobile orb through injected mobile.js')
  const box = await orb.boundingBox()
  assert.ok(box.width >= 44 && box.height >= 44)
  await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2)
  assert.equal(await page.locator('#mobile-menu').isVisible(), true)
  for (const key of ['BACK', 'HOME', 'APP_SWITCH']) await page.locator(`[data-mobile-key="${key}"]`).click()
  assert.deepEqual(requests.map(item => item.body), ['BACK', 'HOME', 'APP_SWITCH'].map(key => ({ serial: 'test-device:5555', type: 'key', key })))
  assert.ok(requests.every(item => item.url === '/api/device/input' && !('text' in item.body)))
  if (process.env.MOBILE_SCREENSHOT) await page.screenshot({ path: process.env.MOBILE_SCREENSHOT })
})

test('standalone stream respects nonzero iOS safe areas for both video and touch', async () => {
  await stream()
  await page.evaluate(() => {
    const canvas = document.querySelector('.video-layer')
    canvas.width = 360
    canvas.height = 900
    document.documentElement.style.setProperty('--phone-safe-top', '54px')
    document.documentElement.style.setProperty('--phone-safe-bottom', '34px')
    document.documentElement.style.setProperty('--phone-safe-left', '0px')
    document.documentElement.style.setProperty('--phone-safe-right', '0px')
  })
  await page.waitForTimeout(80)
  const boxes = await page.evaluate(() => {
    const video = document.querySelector('.video-layer').getBoundingClientRect()
    const touch = document.querySelector('.touch-layer').getBoundingClientRect()
    return { video: video.toJSON(), touch: touch.toJSON(), height: innerHeight }
  })
  assert.ok(boxes.video.top >= 54, JSON.stringify(boxes.video))
  assert.ok(boxes.video.bottom <= boxes.height - 34, JSON.stringify(boxes.video))
  assert.deepEqual(boxes.video, boxes.touch)
})

test('automatic page recovery restores CSS immersive mode without requesting native fullscreen', async () => {
  await stream()
  await page.evaluate(() => { document.documentElement.requestFullscreen = undefined })
  await page.locator('[data-mobile-action="fullscreen"]').evaluate(button => button.click())
  assert.equal(await page.locator('body').evaluate(body => body.classList.contains('mobile-immersive')), true)
  await page.reload()
  await page.waitForTimeout(150)
  assert.equal(await page.locator('body').evaluate(body => body.classList.contains('mobile-immersive')), true)
  await page.locator('#mobile-orb').click()
  assert.equal(await page.locator('[data-mobile-action="fullscreen"]').innerText(), '退出全屏')
  await page.locator('[data-mobile-action="fullscreen"]').click()
})

test('overlay rejects non-navigation input and a missing serial, and surfaces backend rejection', async () => {
  await stream()
  await page.locator('#mobile-orb').click()
  await page.evaluate(() => {
    const button = document.querySelector('[data-mobile-key="BACK"]')
    button.dataset.mobileKey = 'PASSWORD'
    button.click()
    button.dataset.mobileKey = 'BACK'
    location.hash = '!action=stream'
    button.click()
  })
  await page.waitForTimeout(50)
  assert.deepEqual(requests, [])
  await page.evaluate(() => { location.hash = '!action=stream&udid=test-device%3A5555' })
  await page.route('**/api/device/input', route => route.fulfill({ status: 400, contentType: 'application/json', body: '{"ok":false}' }), { times: 1 })
  if (!await page.locator('#mobile-menu').isVisible()) await page.locator('#mobile-orb').click()
  await page.locator('[data-mobile-key="APP_SWITCH"]').click()
  await page.waitForFunction(() => document.querySelector('#mobile-status').textContent.includes('失败'))
})

test('contain and crop share exact video/touch bounds and engine pointer mapping after resize and replacement', async () => {
  await stream()
  await page.evaluate(() => localStorage.removeItem('scrcpyNas.mobile.scale'))
  await page.reload()
  await page.locator('#mobile-orb').click()
  const scale = page.locator('[data-mobile-action="scale"]')
  assert.equal(await scale.count(), 1, 'menu should expose the scale mode toggle')
  await page.locator('#mobile-menu-close').click()
  // 使用引擎原始坐标换算函数，仅替代承载结果的数据对象
  const bundle = fs.readFileSync(path.resolve(__dirname, '../../engine/public/bundle.js'), 'utf8')
  const mapping = bundle.split('e.buildTouchOnClient=')[1].split(',e.validateMessage=')[0]
  for (const size of [{ width: 393, height: 852 }, { width: 852, height: 393 }]) {
    await page.setViewportSize(size)
    for (const mode of ['contain', 'cover']) {
      await page.evaluate(mode => {
        localStorage.setItem('scrcpyNas.mobile.scale', mode)
        window.dispatchEvent(new Event('scrcpynas:scale'))
      }, mode)
      await page.waitForTimeout(80)
      const result = await page.evaluate(({ mapping }) => {
        const video = document.querySelector('.video-layer')
        const touch = document.querySelector('.touch-layer')
        const v = video.getBoundingClientRect(), t = touch.getBoundingClientRect()
        const Size = function (width, height) { this.width = width; this.height = height }
        const Point = function (x, y) { this.x = x; this.y = y }
        const Position = function (point, screenSize) { this.point = point; this.screenSize = screenSize }
        const map = new Function('s', 'u', 'c', `return (${mapping})`)({ default: Size }, { default: Point }, { default: Position })
        const x = innerWidth / 2, y = innerHeight / 2
        const point = map.call({ mapTypeToAction: () => 0 }, { type: 'pointerdown', target: touch, clientX: x, clientY: y, buttons: 1 }, { videoSize: { width: 1080, height: 1920 } }).touch
        window.touchSamples = []
        touch.addEventListener('pointerdown', event => window.touchSamples.push({
          x: event.clientX, y: event.clientY,
          mapped: map.call({ mapTypeToAction: () => 0 }, event, { videoSize: { width: 1080, height: 1920 } }).touch
        }))
        return { video: v.toJSON(), touch: t.toJSON(), point, viewport: { width: innerWidth, height: innerHeight } }
      }, { mapping })
      assert.deepEqual(result.video, result.touch)
      const { video, viewport, point } = result
      if (mode === 'contain') assert.ok(video.width <= viewport.width + 1 && video.height <= viewport.height + 1)
      else assert.ok(video.width >= viewport.width - 1 && video.height >= viewport.height - 1)
      assert.equal(point.invalid, false)
      assert.ok(Math.abs(point.position.point.x - 540) < 2, JSON.stringify(result))
      assert.ok(Math.abs(point.position.point.y - 960) < 2)
      // 浏览器真实触摸穿过命中测试，再执行引擎原始换算，覆盖裁切画面的非中心位置
      const left = Math.max(0, video.x), right = Math.min(viewport.width, video.x + video.width)
      for (const ratio of [0.25, 0.5]) await page.touchscreen.tap(left + (right - left) * ratio, viewport.height / 2)
      const samples = await page.evaluate(() => window.touchSamples)
      assert.equal(samples.length, 2, `${mode}: both taps must reach the touch layer`)
      for (const sample of samples) {
        assert.equal(sample.mapped.invalid, false)
        assert.ok(Math.abs(sample.mapped.position.point.x - (sample.x - video.x) * 1080 / video.width) < 2)
        assert.ok(Math.abs(sample.mapped.position.point.y - (sample.y - video.y) * 1920 / video.height) < 2)
      }
      await page.evaluate(() => document.querySelector('.touch-layer').replaceWith(document.querySelector('.touch-layer').cloneNode(false)))
      await page.waitForTimeout(50)
      assert.deepEqual(await page.locator('.video-layer').boundingBox(), await page.locator('.touch-layer').boundingBox())
    }
  }
  await page.locator('#mobile-orb').click()
  await scale.click()
  assert.equal(await page.evaluate(() => localStorage.getItem('scrcpyNas.mobile.scale')), 'contain')
  await page.setViewportSize({ width: 393, height: 852 })
})

test('orb drag snaps to edge, persists, dims, and stays reachable after rotation', async () => {
  await stream()
  const orb = page.locator('#mobile-orb')
  const initial = await orb.boundingBox()
  await page.mouse.move(initial.x + 22, initial.y + 22)
  await page.mouse.down()
  await page.mouse.move(90, 650, { steps: 10 })
  await page.mouse.up()
  const moved = await orb.boundingBox()
  assert.ok(moved.x < 20, 'drag must snap orb to the left edge')
  assert.ok(moved.y > 550)
  assert.equal(await page.locator('#mobile-menu').isVisible(), false, 'drag must not toggle menu')
  await page.reload()
  assert.deepEqual(await orb.boundingBox(), moved)
  await page.waitForTimeout(2500)
  assert.equal(await orb.evaluate(element => element.classList.contains('is-dim')), true)
  await orb.click()
  assert.equal(await orb.evaluate(element => element.classList.contains('is-dim')), false)
  await page.setViewportSize({ width: 852, height: 393 })
  await page.waitForTimeout(100)
  const rotated = await orb.boundingBox()
  assert.ok(rotated.x >= 0 && rotated.y >= 0 && rotated.y + rotated.height <= 393)
  const menu = await page.locator('#mobile-menu').boundingBox()
  assert.ok(menu.x >= 0 && menu.y >= 0 && menu.x + menu.width <= 852 && menu.y + menu.height <= 393)
  await page.keyboard.press('Escape')
  assert.equal(await page.locator('#mobile-menu').isVisible(), false)
  await page.setViewportSize({ width: 393, height: 852 })
})

test('fullscreen fallback is reversible and exiting viewer never disconnects underlying ADB', async () => {
  await stream()
  await page.evaluate(() => {
    window.fullscreenAttempts = 0
    document.documentElement.requestFullscreen = async () => { window.fullscreenAttempts++; throw new Error('unsupported') }
  })
  await page.locator('#mobile-orb').click()
  const full = page.locator('[data-mobile-action="fullscreen"]')
  assert.equal(await full.count(), 1, 'menu should expose immersive/fullscreen action')
  await full.click()
  assert.equal(await page.evaluate(() => window.fullscreenAttempts), 1)
  assert.equal(await page.locator('body').evaluate(element => element.classList.contains('mobile-immersive')), true)
  await full.click()
  assert.equal(await page.locator('body').evaluate(element => element.classList.contains('mobile-immersive')), false)
  await page.locator('[data-mobile-action="disconnect"]').click()
  await page.waitForURL(origin + '/')
  assert.deepEqual(requests, [], 'leaving a viewer must not call ADB disconnect or prepare')
})

test('embedded exit returns the top-level page to the dashboard without disconnecting ADB', async () => {
  await stream()
  await page.setContent(`<div class="app-shell"><iframe id="mirrorFrame" src="${origin}/scrcpy/#!action=stream&udid=test-device%3A5555"></iframe></div>`)
  const embedded = page.frameLocator('#mirrorFrame')
  await embedded.locator('#mobile-orb').click()
  await embedded.locator('[data-mobile-action="disconnect"]').click()
  await page.waitForURL(origin + '/', { timeout: 1500 })
  assert.deepEqual(requests, [])
})

test('dashboard and proxied stream share a local standalone manifest and iPhone metadata without a service worker', async () => {
  for (const url of [origin + '/', origin + '/scrcpy/']) {
    await page.goto(url)
    const link = page.locator('link[rel="manifest"]')
    assert.equal(await link.count(), 1, 'both entry points must link the manifest')
    assert.equal(await page.locator('meta[name="viewport"]').count(), 1)
    assert.match(await page.locator('meta[name="viewport"]').getAttribute('content'), /viewport-fit=cover/)
    assert.equal(await page.locator('meta[name="apple-mobile-web-app-capable"]').getAttribute('content'), 'yes')
    assert.equal(await page.locator('meta[name="apple-mobile-web-app-status-bar-style"]').getAttribute('content'), 'black-translucent')
    const manifestUrl = await link.evaluate(element => element.href)
    assert.equal(new URL(manifestUrl).origin, origin)
    const manifest = await (await fetch(manifestUrl)).json()
    assert.equal(manifest.start_url, '/')
    assert.equal(manifest.display, 'standalone')
    for (const icon of manifest.icons) {
      const response = await fetch(new URL(icon.src, manifestUrl))
      assert.equal(response.status, 200)
      assert.match(await response.text(), /<svg/)
    }
    assert.equal(await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length), 0)
  }
})

test('saved crop mode is reflected by menu and dashboard loads safe-area styles', async () => {
  await stream()
  await page.evaluate(() => localStorage.setItem('scrcpyNas.mobile.scale', 'cover'))
  await page.reload()
  assert.equal(await page.locator('[data-mobile-action="scale"]').textContent(), '完整画面')
  await page.goto(origin + '/')
  assert.equal(await page.locator('link[rel="stylesheet"][href="mobile.css"]').count(), 1)
})

test('dynamic visual viewport centers the menu within safe areas and retains its bottom close control', async () => {
  await stream()
  await page.evaluate(() => {
    Object.defineProperty(visualViewport, 'height', { configurable: true, value: 500 })
    visualViewport.dispatchEvent(new Event('resize'))
  })
  await page.waitForTimeout(100)
  const video = await page.locator('.video-layer').boundingBox()
  assert.ok(Math.abs(video.y + video.height / 2 - 250) < 1, 'video must center in visible rather than layout viewport')
  await page.evaluate(() => document.querySelector('#mobile-controls').style.padding = '40px 35px 30px 25px')
  const orb = page.locator('#mobile-orb'), initial = await orb.boundingBox()
  await page.mouse.move(initial.x + 22, initial.y + 22)
  await page.mouse.down()
  await page.mouse.move(30, 490, { steps: 10 })
  await page.mouse.up()
  await orb.click()
  const ball = await orb.boundingBox(), menu = await page.locator('#mobile-menu').boundingBox()
  assert.ok(menu.y >= 40 && menu.y + menu.height <= 470)
  assert.ok(menu.x >= 25 && menu.x + menu.width <= 358)
  assert.ok(Math.abs(menu.y + menu.height / 2 - 255) < 1, 'menu centers in the safe visible area')
  await page.locator('#mobile-menu-close').click()
  assert.equal(await page.locator('#mobile-menu').isVisible(), false)
})

test('openSelectedInNewTab preserves desktop tab behavior but standalone iPhone stays in the same window', async () => {
  const vm = require('node:vm')
  const script = fs.readFileSync(path.join(publicDir, 'app-stream.js'), 'utf8')
  for (const mode of ['desktop', 'standalone', 'ios']) {
    const opened = [], current = { href: origin + '/' }
    const tab = { location: {} }
    const context = {
      URL, URLSearchParams, Date,
      SCRCPY_BASE: '/scrcpy/', SCRCPY_SERVER_PORT: 8886, DEFAULT_PLAYER: 'mse',
      selectedSerial: 'test-device:5555', mirrorSerial: '', records: [],
      document: { querySelector: () => null }, navigator: { standalone: mode === 'ios' },
      window: {
        location: current, navigator: { standalone: mode === 'ios' },
        matchMedia: () => ({ matches: mode === 'standalone' }),
        open: (...args) => { opened.push(args); return tab }
      }
    }
    vm.createContext(context)
    vm.runInContext(script, context)
    await vm.runInContext('openSelectedInNewTab()', context)
    if (mode === 'desktop') {
      assert.equal(opened.length, 1)
      assert.equal(opened[0][1], '_blank')
      assert.match(tab.location.href, /#!action=stream&udid=test-device%3A5555/)
    } else {
      assert.equal(opened.length, 0, 'standalone must not leave the installed app')
      assert.match(current.href, /#!action=stream&udid=test-device%3A5555/)
    }
  }
})

// 横屏源自动展开到竖屏手机并验证旋转后的原始引擎触控换算
 test('landscape source fills portrait phone with rotated and accurate touch mapping', async () => {
  await page.setViewportSize({ width: 393, height: 852 })
  await stream()
  const { patchEngineMedia } = require('../lib/engine-media')
  const bundle = patchEngineMedia(fs.readFileSync(path.resolve(__dirname, '../../engine/public/bundle.js'), 'utf8'))
  const mapping = bundle.split('e.buildTouchOnClient=')[1].split(',e.validateMessage=')[0]
  await page.evaluate(() => {
    localStorage.setItem('scrcpyNas.mobile.scale', 'contain')
    const canvas = document.querySelector('.video-layer')
    canvas.width = 1920
    canvas.height = 1080
  })
  await page.waitForFunction(() => document.documentElement.classList.contains('stream-rotated'))
  assert.equal(await page.locator('body').evaluate(body => body.classList.contains('mobile-immersive')), true)
  const result = await page.evaluate(mapping => {
    const target = document.querySelector('.touch-layer'), video = document.querySelector('.video-layer')
    const rect = target.getBoundingClientRect(), vr = video.getBoundingClientRect()
    const Size = function (width, height) { this.width = width; this.height = height }
    const Point = function (x, y) { this.x = x; this.y = y }
    const Position = function (point, screenSize) { this.point = point; this.screenSize = screenSize }
    const map = new Function('s', 'u', 'c', `return (${mapping})`)({ default: Size }, { default: Point }, { default: Position })
    const points = [[0.1, 0.2], [0.5, 0.5], [0.9, 0.8]].map(([x, y]) => {
      const touch = map.call({ mapTypeToAction: () => 0 }, { type: 'pointerdown', target, clientX: rect.right - y * rect.width, clientY: rect.top + x * rect.height, buttons: 1 }, { videoSize: { width: 1920, height: 1080 } }).touch
      return { expected: [x * 1920, y * 1080], actual: [touch.position.point.x, touch.position.point.y], invalid: touch.invalid }
    })
    return { width: rect.width, height: rect.height, same: rect.width === vr.width && rect.height === vr.height, points }
  }, mapping)
  assert.ok(result.width > 380 && result.height > 680, JSON.stringify(result))
  assert.equal(result.same, true)
  for (const point of result.points) {
    assert.equal(point.invalid, false)
    point.actual.forEach((value, index) => assert.ok(Math.abs(value - point.expected[index]) < 3))
  }
  await page.setViewportSize({ width: 852, height: 393 })
  await page.waitForFunction(() => !document.documentElement.classList.contains('stream-rotated'))
  assert.ok((await page.locator('.video-layer').boundingBox()).width > 680)
  await page.evaluate(() => { const canvas = document.querySelector('.video-layer'); canvas.width = 1080; canvas.height = 1920 })
  await page.setViewportSize({ width: 393, height: 852 })
  await page.waitForTimeout(100)
  assert.equal(await page.locator('html').evaluate(root => root.classList.contains('stream-rotated')), false)
})
