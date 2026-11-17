// Modified in the Mobile Remote derivative (2026): mobile UI, media transport or recovery changes; see MODIFICATIONS.md.
'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const fs = require('node:fs')
const { webkit } = require('playwright')

// 使用真实首页脚本和合成设备验证首屏入口 连接失败提示与返回列表
test('device home is immediately visible and opens a stream only after a card click', async () => {
  const browser = await webkit.launch({ executablePath: process.env.PHONE_AUDIO_WEBKIT_EXECUTABLE })
  const root = path.resolve(__dirname, '../public')
  try {
    const page = await browser.newPage({ viewport: { width: 393, height: 852 }, hasTouch: true })
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    let online = true, preparations = 0
    const record = { id: 'usb:fixture', serial: 'fixture', name: '我的安卓手机', model: 'Android', transport: 'usb' }
    await page.route('http://fixture/**', route => {
      const pathname = new URL(route.request().url()).pathname
      if (pathname.startsWith('/api/')) {
        if (pathname === '/api/stream/prepare') preparations++
        const devices = online ? [{ serial: 'fixture', state: 'device', transport: 'usb' }] : []
        return route.fulfill({ json: { ok: true, ready: true, records: [record], devices, usb: devices, logs: '' } })
      }
      if (pathname.startsWith('/scrcpy/')) return route.fulfill({ body: '<body>测试远控画面</body>' })
      const file = path.join(root, pathname === '/' ? 'index.html' : pathname)
      if (!fs.existsSync(file)) return route.fulfill({ status: 404 })
      const ext = path.extname(file)
      return route.fulfill({ body: fs.readFileSync(file), contentType: ext === '.js' ? 'application/javascript' : ext === '.css' ? 'text/css' : ext === '.html' ? 'text/html' : 'application/octet-stream' })
    })
    await page.goto('http://fixture/')
    await page.waitForSelector('#devices .device')
    assert.equal(preparations, 0)
    assert.equal(await page.locator('.stage').isVisible(), false)
    assert.equal(await page.locator('.device-enter').isVisible(), true)
    for (const viewport of [{ width: 393, height: 852 }, { width: 375, height: 667 }, { width: 844, height: 390 }, { width: 1280, height: 800 }]) {
      await page.setViewportSize(viewport)
      const card = await page.locator('#devices .device').boundingBox()
      assert.ok(card.x >= 0 && card.x + card.width <= viewport.width)
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
    }
    await page.setViewportSize({ width: 393, height: 852 })
    if (process.env.UI_SHOTS) await page.screenshot({ path: path.join(process.env.UI_SHOTS, 'device-home.png') })
    online = false
    await page.locator('#devices .device').click()
    await page.waitForFunction(() => document.querySelector('#device-home-feedback').textContent.includes('USB'))
    assert.equal(await page.locator('#devices .device').isVisible(), true)
    online = true
    await page.locator('#devices .device').click()
    await page.waitForFunction(() => !document.body.classList.contains('device-home'))
    assert.equal(preparations, 1)
    assert.match(await page.locator('#mirrorFrame').getAttribute('src'), /action=stream/)
    await page.evaluate(() => unloadMirror(true))
    assert.equal(await page.locator('#devices .device').isVisible(), true)
    assert.equal(await page.locator('.stage').isVisible(), false)
    assert.deepEqual(errors, [])
  } finally { await browser.close() }
})
