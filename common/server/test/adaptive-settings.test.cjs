// Modified in the Mobile Remote derivative (2026): mobile UI, media transport or recovery changes; see MODIFICATIONS.md.
'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { webkit } = require('playwright')

// 验证自动模式默认开启 画质草稿只在保存时生效 当前连接状态不覆盖草稿
test('adaptive settings default to auto and preserve the explicit save boundary', async () => {
  const browser = await webkit.launch({ executablePath: process.env.PHONE_AUDIO_WEBKIT_EXECUTABLE })
  try {
    const page = await browser.newPage({ viewport: { width: 375, height: 667 } })
    await page.route('http://fixture/**', route => route.fulfill({ contentType: 'text/html', body: '<body><div id="mobile-menu"></div><button id="mobile-orb">menu</button></body>' }))
    await page.goto('http://fixture/#!action=stream&udid=fixture')
    await page.evaluate(() => {
      window.submitted = []
      window.currentQuality = { mode: 'auto', network: 'lan', level: 42, maxSize: 1920, bitrate: 6000000, maxFps: 60 }
      window.scrcpyNasRtc = { getQuality: () => currentQuality, setQualityPreference(value) { submitted.push(value); currentQuality.mode = value.mode; return true } }
      localStorage.setItem('scrcpyNas.media.fixture', JSON.stringify({ maxSize: 720, bitrate: 1000000, maxFps: 24 }))
    })
    await page.addStyleTag({ path: path.resolve(__dirname, '../public/mobile.css') })
    await page.addScriptTag({ content: fs.readFileSync(path.resolve(__dirname, '../public/media-settings.js'), 'utf8') })
    await page.locator('[data-mobile-action=settings]').click()
    await page.locator('[data-settings-tab=video]').click()
    assert.equal(await page.locator('#media-quality-mode').inputValue(), 'auto')
    assert.equal(await page.locator('#media-resolution').inputValue(), '1920')
    assert.equal(await page.locator('#media-bitrate').isDisabled(), true)
    const card = await page.locator('#media-panel').boundingBox()
    const close = await page.locator('#media-close').boundingBox()
    assert.ok(Math.abs(card.y + card.height / 2 - 667 / 2) < 2)
    assert.ok(close.y >= 0 && close.y + close.height <= 667)
    if(process.env.UI_SHOTS)await page.screenshot({path:path.join(process.env.UI_SHOTS,'settings-auto.png')})
    await page.locator('#media-quality-mode').selectOption('manual')
    await page.locator('#media-bitrate').selectOption('2200000')
    await page.evaluate(() => { currentQuality.network = 'wan'; currentQuality.bitrate = 2800000; dispatchEvent(new Event('scrcpynas:quality-state')) })
    assert.equal(await page.locator('#media-bitrate').inputValue(), '2200000')
    assert.equal(await page.evaluate(() => submitted.length), 0)
    await page.locator('#media-close').click()
    await page.evaluate(() => { document.querySelector('#mobile-menu').hidden = false })
    await page.locator('[data-mobile-action=settings]').click()
    await page.locator('[data-settings-tab=video]').click()
    assert.equal(await page.locator('#media-quality-mode').inputValue(), 'auto')
    await page.locator('#media-quality-mode').selectOption('manual')
    await page.locator('#media-bitrate').selectOption('2200000')
    await page.locator('#media-apply').click()
    assert.equal(await page.evaluate(() => submitted.length), 1)
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('scrcpyNas.quality.fixture')).mode), 'manual')
    await page.locator('#media-quality-mode').selectOption('auto')
    await page.locator('#media-apply').click()
    assert.equal(await page.evaluate(() => submitted[1].mode), 'auto')
  } finally { await browser.close() }
})
