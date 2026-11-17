// Modified in the Mobile Remote derivative (2026): mobile UI, media transport or recovery changes; see MODIFICATIONS.md.
'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { chromium, webkit } = require('playwright')
const publicDir = path.resolve(__dirname, '../public')

// 可选使用真实 WebKit 二进制重复同一组布局与事件契约测试
async function launchBrowser() {
  if (process.env.GESTURE_WEBKIT_EXECUTABLE) return webkit.launch({ executablePath: process.env.GESTURE_WEBKIT_EXECUTABLE })
  return chromium.launch({ args: ['--no-sandbox'] })
}

// 合成可取消触摸验证默认滚动被抑制，事件仍完整到达投屏输入层
 test('embedded stream cancels browser gestures without swallowing remote touch events', async () => {
  const browser = await launchBrowser()
  try {
    const page = await browser.newPage({ viewport: { width: 393, height: 700 }, isMobile: true, hasTouch: true })
    await page.setContent('<body class="stream"><div class="video"><div class="touch-layer" style="width:300px;height:600px"></div></div><div id="outside">outside</div></body>')
    await page.addStyleTag({ content: fs.readFileSync(path.join(publicDir, 'mobile.css'), 'utf8') })
    await page.addScriptTag({ content: fs.readFileSync(path.join(publicDir, 'mobile.js'), 'utf8') })
    const result = await page.evaluate(() => {
      const layer = document.querySelector('.touch-layer'), outside = document.querySelector('#outside')
      const seen = []
      ;['touchstart', 'touchmove', 'touchend'].forEach(type => layer.addEventListener(type, e => seen.push(e.type)))
      const prevented = ['touchstart', 'touchmove'].map(type => {
        const e = new Event(type, { bubbles: true, cancelable: true })
        layer.dispatchEvent(e)
        return e.defaultPrevented
      })
      layer.dispatchEvent(new Event('touchend', { bubbles: true, cancelable: true }))
      const e = new Event('touchmove', { bubbles: true, cancelable: true })
      outside.dispatchEvent(e)
      return { prevented, outside: e.defaultPrevented, seen, overscroll: getComputedStyle(document.body).overscrollBehavior }
    })
    assert.deepEqual(result.prevented, [true, true])
    assert.equal(result.outside, false)
    assert.deepEqual(result.seen, ['touchstart', 'touchmove', 'touchend'])
    assert.equal(result.overscroll, 'none')
  } finally { await browser.close() }
})

// 黑边起滑只发一次受限返回，画面内拖动与取消手势不能误触
 test('inward black-margin swipe sends BACK once and leaves picture gestures unchanged', async () => {
  const browser = await launchBrowser()
  try {
    const page = await browser.newPage({ viewport: { width: 393, height: 700 }, isMobile: true, hasTouch: true })
    await page.goto('about:blank#!action=stream&udid=fixture-device')
    await page.setContent('<body class="stream"><div class="video" style="position:fixed;inset:0"><canvas class="video-layer" style="position:absolute;left:46px;top:50px;width:300px;height:600px"></canvas><div class="touch-layer" style="position:absolute;left:46px;top:50px;width:300px;height:600px"></div></div></body>')
    const requests = []
    await page.route('**/api/device/input', async route => { requests.push(route.request().postDataJSON()); await route.fulfill({ json: { ok: true } }) })
    // 使用实际相对路径解析所需的隔离 HTTP 基址，不访问真实设备
    await page.evaluate(() => { const base = document.createElement('base'); base.href = 'http://fixture.invalid/scrcpy/'; document.head.appendChild(base) })
    await page.addScriptTag({ content: fs.readFileSync(path.join(publicDir, 'mobile.js'), 'utf8') })
    // 仅合成指针序列验证边缘识别与请求契约，不声称真机系统手势通过
    async function swipe(x, y, endX, endY, cancelled = false) {
      await page.evaluate(({ x, y, endX, endY, cancelled }) => {
        const target = document.elementFromPoint(x, y)
        for (const [type, px, py] of [['pointerdown',x,y],['pointermove',endX,endY],[cancelled?'pointercancel':'pointerup',endX,endY]]) {
          target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerType: 'touch', pointerId: 7, isPrimary: true, button: 0, clientX: px, clientY: py }))
        }
      }, { x,y,endX,endY,cancelled })
      await page.waitForTimeout(70)
    }
    await swipe(360, 350, 280, 350)
    assert.deepEqual(requests, [{ serial: 'fixture-device', type: 'key', key: 'BACK' }])
    await swipe(30, 350, 110, 350)
    assert.equal(requests.length, 2)
    await swipe(330, 350, 230, 350) // 画面内起滑
    await swipe(360, 350, 360, 230) // 黑边纵向滑动
    await swipe(360, 350, 350, 350) // 微动
    await swipe(360, 350, 280, 350, true) // 系统取消
    assert.equal(requests.length, 2)
  } finally { await browser.close() }
})

// 检查移动端外层没有可滚动根节点，列表仍独立滚动
 test('mobile dashboard root is locked but device list remains scrollable', async () => {
  const browser = await launchBrowser()
  try {
    const page = await browser.newPage({ viewport: { width: 393, height: 700 }, isMobile: true, hasTouch: true })
    await page.setContent('<body><div class="app-shell"><aside class="sidebar"><div class="devices"><div style="height:2000px">records</div></div></aside><main class="stage">viewer</main></div></body>')
    for (const file of ['css/style.css','css/page-index.css','mobile.css']) await page.addStyleTag({ content: fs.readFileSync(path.join(publicDir,file), 'utf8') })
    const result = await page.evaluate(() => {
      const list = document.querySelector('.devices')
      list.scrollTop = 100
      return { body: getComputedStyle(document.body).position, overflow: getComputedStyle(document.documentElement).overflowY, list: getComputedStyle(list).overflowY }
    })
    assert.equal(result.body, 'fixed')
    assert.equal(result.overflow, 'hidden')
    assert.equal(result.list, 'auto')
  } finally { await browser.close() }
})
