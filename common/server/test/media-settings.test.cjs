// Modified in the Mobile Remote derivative (2026): mobile UI, media transport or recovery changes; see MODIFICATIONS.md.
'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { chromium } = require('playwright')

const { registerScrcpyProxyRoutes } = require('../lib/scrcpy-proxy')
const express = require('../../engine/node_modules/express')
const http = require('node:http')

// 使用实际代理生成的脚本验证设备偏好不会被旧分辨率参数覆盖
test('injected startup loads saved video settings for both orientations without enabling fit-to-window encoding', async () => {
  const app = express()
  registerScrcpyProxyRoutes(app, { routeBases: [''], appPath: value => value, escapeRegExp: value => value, wsScrcpyHost: '127.0.0.1', wsScrcpyPort: 1, buildProxyPath: value => value })
  const server = http.createServer(app)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const browser = await chromium.launch({ args: ['--no-sandbox'] })
  try {
    const origin = 'http://127.0.0.1:' + server.address().port
    const script = await (await fetch(origin + '/scrcpy-official-controls.js')).text()
    const page = await browser.newPage({ viewport: { width: 430, height: 932 } })
    await page.route(origin + '/fixture', route => route.fulfill({ body: '<body></body>' }))
    await page.goto(origin + '/fixture#!action=stream&udid=fixture&scrcpyNasMaxSize=720')
    await page.evaluate(() => {
      localStorage.setItem('scrcpyNas.media.fixture', JSON.stringify({ maxSize: 1280, bitrate: 4000000, maxFps: 30 }))
      localStorage.setItem('MseDecoder:fixture:430x932:0:1080x2400', '{"bitrate":123}')
      localStorage.setItem('MseDecoder:fixture:430x932:0:1080x2400:fit', 'true')
    })
    await page.addScriptTag({ content: script })
    for (const key of ['MseDecoder:fixture:430x932', 'MseDecoder:fixture:430x932:0:1080x2400']) {
      const value = await page.evaluate(key => JSON.parse(localStorage.getItem(key)), key)
      assert.equal(value.bitrate, 4000000)
      assert.equal(value.maxFps, 30)
      assert.deepEqual(value.bounds, { width: 1280, height: 1280 })
      assert.equal(await page.evaluate(key => localStorage.getItem(key + ':fit'), key), 'false')
    }
  } finally {
    await browser.close()
    await new Promise(resolve => server.close(resolve))
    assert.equal(server.listening, false)
  }
})

// 用真实原生设置结构验证移动面板传递参数与校验，而不连接生产手机
test('mobile media settings apply bounded values through native settings and retain per-device preferences', async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox'] })
  try {
    const page = await browser.newPage({ viewport: { width: 430, height: 932 }, hasTouch: true, isMobile: true })
    await page.route('http://fixture/**', route => route.fulfill({ contentType: 'text/html', body: '<meta name="viewport" content="width=device-width, initial-scale=1"><body class="stream"><div id="mobile-menu"></div><div class="more-box"><div class="spoiler"><div class="box"><button>Reset</button><button>Fit</button><input value="7340032"><input value="60"><input value="10"><input value="720"><input value="720"><button id="native-apply">Set video settings</button></div></div></div></body>' }))
    await page.goto('http://fixture/scrcpy/#!action=stream&udid=fixture')
    await page.evaluate(() => {
      window.applied = []
      document.querySelector('#native-apply').onclick = () => window.applied.push(Array.from(document.querySelectorAll('.box input')).map(input => Number(input.value)))
    })
    const script = path.resolve(__dirname, '../public/media-settings.js')
    assert.ok(fs.existsSync(script), 'mobile settings extension must exist')
    await page.addStyleTag({ path: path.resolve(__dirname, '../public/mobile.css') })
    await page.addScriptTag({ path: script })
    await page.locator('[data-mobile-action="settings"]').click()
    await page.locator('[data-settings-tab=video]').click()
    await page.locator('#media-resolution').selectOption('1280')
    await page.locator('#media-bitrate').selectOption('4000000')
    await page.locator('#media-fps').selectOption('30')
    await page.locator('#media-apply').click()
    assert.deepEqual(await page.evaluate(() => window.applied), [[4000000, 30, 10, 1280, 1280]])
    assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('scrcpyNas.media.fixture'))), { maxSize: 1280, bitrate: 4000000, maxFps: 30 })
    await page.evaluate(() => { document.querySelector('#media-fps').innerHTML = '<option value="999" selected>invalid</option>' })
    await page.locator('#media-apply').click()
    assert.equal(await page.evaluate(() => window.applied.length), 1)
    assert.match(await page.locator('#media-feedback').innerText(), /无效/)
    const panel = await page.locator('#media-panel').boundingBox()
    assert.ok(panel.x >= 0 && panel.y >= 0 && panel.x + panel.width <= 430 && panel.y + panel.height <= 932)
    await page.locator('#media-close').click()
    assert.equal(await page.locator('#media-panel').isVisible(), false)
  } finally { await browser.close() }
})
