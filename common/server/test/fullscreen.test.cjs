// Modified in the Mobile Remote derivative (2026): mobile UI, media transport or recovery changes; see MODIFICATIONS.md.
'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { chromium, webkit } = require('playwright')
const publicDir = path.resolve(__dirname, '../public')

// 测试真实同源 iframe 与外层布局，不以内部 class 或按钮文字代替尺寸验收
 test('embedded immersive button expands outer viewer and exit restores dashboard without reloading stream', async () => {
  const browser = process.env.GESTURE_WEBKIT_EXECUTABLE
    ? await webkit.launch({ executablePath: process.env.GESTURE_WEBKIT_EXECUTABLE })
    : await chromium.launch({ args: ['--no-sandbox'] })
  try {
    const page = await browser.newPage({ viewport: { width: 393, height: 700 }, isMobile: true, hasTouch: true })
    await page.setContent('<meta name="viewport" content="width=device-width,initial-scale=1"><body><div class="app-shell"><aside class="sidebar">devices</aside><main class="stage"><header class="stage-head" style="height:120px">toolbar</header><section class="viewer"><iframe id="mirrorFrame"></iframe></section></main></div></body>')
    for (const f of ['css/style.css','css/page-index.css','mobile.css']) await page.addStyleTag({ content: fs.readFileSync(path.join(publicDir,f),'utf8') })
    const frame = page.frames()[1]
    await frame.setContent('<body class="stream"><div class="video"><canvas class="video-layer" width="300" height="600"></canvas><div class="touch-layer"></div></div></body>')
    await frame.addStyleTag({ content: fs.readFileSync(path.join(publicDir,'mobile.css'),'utf8') })
    await page.evaluate(() => { document.documentElement.requestFullscreen = () => Promise.reject(new Error('fixture unsupported')) })
    await frame.evaluate(() => { document.documentElement.requestFullscreen = () => Promise.reject(new Error('fixture unsupported')); window.streamMarker = 'same-stream' })
    await frame.addScriptTag({ content: fs.readFileSync(path.join(publicDir,'mobile.js'),'utf8') })
    await frame.locator('#mobile-orb').click()
    await frame.locator('[data-mobile-action="fullscreen"]').click()
    await page.waitForTimeout(80)
    assert.equal(await page.locator('.stage-head').isVisible(), false)
    const box = await page.locator('#mirrorFrame').boundingBox()
    assert.ok(Math.abs(box.y)<2 && Math.abs(box.x)<2 && Math.abs(box.width-393)<2 && Math.abs(box.height-700)<2,JSON.stringify(box))
    await page.evaluate(() => {
      document.documentElement.style.setProperty('--phone-safe-top', '54px')
      document.documentElement.style.setProperty('--phone-safe-bottom', '34px')
    })
    const safeBox = await page.locator('#mirrorFrame').boundingBox()
    assert.ok(Math.abs(safeBox.y-54)<2 && Math.abs(safeBox.height-612)<2, JSON.stringify(safeBox))
    await frame.locator('[data-mobile-action="fullscreen"]').click()
    assert.equal(await page.locator('.stage-head').isVisible(), true)
    assert.equal(await frame.evaluate(() => window.streamMarker), 'same-stream')
    assert.ok((await page.locator('#mirrorFrame').boundingBox()).height < 700)
    await frame.evaluate(() => dispatchEvent(new CustomEvent('scrcpynas:source-orientation', { detail: { landscape: true, mobile: true } })))
    const autoBox = await page.locator('#mirrorFrame').boundingBox()
    assert.ok(Math.abs(autoBox.y - 54) < 2 && Math.abs(autoBox.height - 612) < 2, JSON.stringify(autoBox))
    assert.equal(await page.locator('.stage-head').isVisible(), false)
  } finally { await browser.close() }
})
