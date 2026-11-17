// Modified in the Mobile Remote derivative (2026): mobile UI, media transport or recovery changes; see MODIFICATIONS.md.
'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { chromium, webkit } = require('playwright')
const mobile = fs.readFileSync(path.resolve(__dirname, '../public/mobile.js'), 'utf8')

// 使用同源控制端文档和真实控制层，替代仅浏览器无法可靠模拟的系统锁屏 API
async function fixture(run, mode = 'mock') {
  const browser = process.env.GESTURE_WEBKIT_EXECUTABLE
    ? await webkit.launch({ executablePath: process.env.GESTURE_WEBKIT_EXECUTABLE })
    : await chromium.launch({ args: ['--no-sandbox'] })
  try {
    const page = await browser.newPage()
    if (mode === 'native') await page.context().grantPermissions(['screen-wake-lock'])
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.route('https://wake.test/**', route => route.fulfill({ contentType: 'text/html', body: '<body><div class="app-shell"><iframe id="mirrorFrame"></iframe></div></body>' }))
    await page.goto('https://wake.test/')
    await page.evaluate(mode => {
      window.calls = []; window.locks = []; window.pending = []; window.deferred = false; window.denied = false
      document.documentElement.requestFullscreen = () => Promise.reject(new Error('CSS fallback'))
      if (mode === 'native') {
        const request = navigator.wakeLock.request.bind(navigator.wakeLock)
        navigator.wakeLock.request = async type => {
          calls.push(type)
          const lock = await request(type)
          locks.push(lock)
          return lock
        }
      }
      if (mode === 'unsupported') Object.defineProperty(navigator, 'wakeLock', { value: undefined, configurable: true })
      if (mode === 'mock') Object.defineProperty(navigator, 'wakeLock', { configurable: true, value: {
        // 模拟系统可延迟、拒绝和主动释放的 sentinel 契约
        request(type) {
          window.calls.push(type)
          if (window.denied) return Promise.reject(new Error('system denied'))
          const sentinel = new EventTarget()
          sentinel.released = false; sentinel.releases = 0
          sentinel.release = async () => { sentinel.releases++; sentinel.released = true; sentinel.dispatchEvent(new Event('release')) }
          window.locks.push(sentinel)
          return window.deferred ? new Promise(resolve => window.pending.push(() => resolve(sentinel))) : Promise.resolve(sentinel)
        }
      } })
    }, mode)
    const frame = page.frames()[1]
    await frame.setContent('<body class="stream"><div class="video"></div></body>')
    await frame.evaluate(() => {
      Object.defineProperty(navigator, 'wakeLock', { configurable: true, value: { request() { throw new Error('must request in host document') } } })
    })
    await frame.addScriptTag({ content: mobile })
    // 不引入布局夹具，通过 DOM click 测试完整按钮行为
    const toggle = () => frame.locator('[data-mobile-action="fullscreen"]').evaluate(button => button.click())
    await run({ page, frame, toggle, errors })
    assert.deepEqual(errors, [])
  } finally { await browser.close() }
}

// Chromium 原生 API 的真实 sentinel 验证不代表实体手机的系统防锁屏验收
 test('Chromium native Screen Wake Lock acquires and releases in CSS immersive', { skip: !!process.env.GESTURE_WEBKIT_EXECUTABLE }, async () => {
  await fixture(async ({ page, frame, toggle }) => {
    await toggle()
    await page.waitForFunction(() => locks.length === 1, null, { timeout: 2000 })
    assert.equal(await page.evaluate(() => locks[0].released), false)
    assert.match(await frame.locator('#mobile-wake-status').textContent(), /常亮已开启/)
    await toggle()
    await page.waitForFunction(() => locks[0].released)
  }, 'native')
})

// CSS 沉浸同样需要控制端顶层文档常亮，退出立即释放且重复布局不重复请求
 test('CSS immersive holds one host screen wake lock only until fullscreen exit', async () => {
  await fixture(async ({ page, frame, toggle }) => {
    assert.equal(await page.evaluate(() => calls.length), 0)
    await toggle()
    await page.waitForFunction(() => calls.length === 1)
    assert.deepEqual(await page.evaluate(() => calls), ['screen'])
    assert.match(await frame.locator('#mobile-wake-status').textContent(), /常亮已开启/)
    await toggle()
    assert.equal(await page.evaluate(() => locks[0].releases), 1)
  })
})

// 可见性恢复仅在原沉浸会话仍有效时重取锁，其他离开信号永久结束会话
for (const boundary of ['hidden', 'host-hidden', 'pagehide', 'host-pagehide', 'popstate', 'hashchange', 'disconnect', 'stream-exit']) {
  test(`wake lock releases on ${boundary}`, async () => {
    await fixture(async ({ page, frame, toggle }) => {
      await toggle()
      const target = boundary.startsWith('host-') ? page : frame
      await target.evaluate(boundary => {
        if (boundary.endsWith('hidden')) {
          Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
          document.dispatchEvent(new Event('visibilitychange'))
        } else if (boundary === 'stream-exit') document.body.classList.remove('stream')
        else window.dispatchEvent(new Event(boundary === 'disconnect' ? 'scrcpynas:disconnect' : boundary.replace('host-', '')))
      }, boundary)
      await page.waitForFunction(() => locks[0].released, null, { timeout: 1000 })
      await target.evaluate(() => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
        document.dispatchEvent(new Event('visibilitychange'))
      })
      if (boundary.endsWith('hidden')) {
        await page.waitForFunction(() => calls.length === 2)
        await toggle()
        assert.equal(await page.evaluate(() => locks[1].releases), 1)
      } else {
        await page.waitForTimeout(40)
        assert.equal(await page.evaluate(() => calls.length), 1)
      }
    })
  })
}

// 重连只销毁旧 iframe 文档时保留外层沉浸意愿，新文档会自行恢复常亮
 test('iframe reload releases old lock without clearing host immersive layout', async () => {
  await fixture(async ({ page, frame, toggle }) => {
    await toggle()
    await frame.evaluate(() => window.dispatchEvent(new Event('pagehide')))
    assert.equal(await page.evaluate(() => document.body.classList.contains('phone-immersive')), true)
    assert.equal(await page.evaluate(() => locks[0].released), true)
    await frame.goto('https://wake.test/stream')
    await frame.setContent('<body class="stream"></body>')
    await frame.addScriptTag({ content: mobile })
    await page.waitForFunction(() => calls.length === 2)
    assert.equal(await page.evaluate(() => document.body.classList.contains('phone-immersive')), true)
    assert.match(await frame.locator('#mobile-wake-status').textContent(), /常亮已开启/)
  })
})

// 系统主动释放不应自动循环申请，菜单准确反映实际状态
 test('system release updates status without retry until a new foreground period', async () => {
  await fixture(async ({ page, frame, toggle }) => {
    await toggle()
    await page.evaluate(() => locks[0].release())
    assert.match(await frame.locator('#mobile-wake-status').textContent(), /系统.*释放/)
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
    assert.equal(await page.evaluate(() => calls.length), 1)
    await toggle()
    await toggle()
    assert.equal(await page.evaluate(() => calls.length), 2)
  })
})

// 拒绝与 API 缺失均安全退化，不会因可见性噪音不断重试
for (const mode of ['denied', 'unsupported']) {
  test(`wake lock ${mode} is nonfatal and does not retry in the same visible period`, async () => {
    await fixture(async ({ page, frame, toggle }) => {
      if (mode === 'denied') await page.evaluate(() => { denied = true })
      await toggle()
      assert.match(await frame.locator('#mobile-wake-status').textContent(), mode === 'denied' ? /低电量模式.*系统/ : /不支持/)
      await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
      assert.equal(await page.evaluate(() => calls.length), mode === 'denied' ? 1 : 0)
      await toggle()
    }, mode === 'unsupported' ? 'unsupported' : 'mock')
  })
}

// 待决请求跨越退出与重入时，旧锁必须释放且不得覆盖新锁
 test('pending wake request is invalidated on exit and stale release cannot clear new lock', async () => {
  await fixture(async ({ page, frame, toggle }) => {
    await page.evaluate(() => { deferred = true })
    await toggle()
    await toggle()
    await toggle()
    assert.equal(await page.evaluate(() => calls.length), 2)
    await page.evaluate(() => { pending[0]() })
    await page.waitForFunction(() => locks[0].released)
    await page.evaluate(() => { pending[1]() })
    await page.waitForFunction(() => locks.length === 2)
    await page.evaluate(() => locks[0].dispatchEvent(new Event('release')))
    assert.match(await frame.locator('#mobile-wake-status').textContent(), /常亮已开启/)
    await toggle()
    assert.equal(await page.evaluate(() => locks[1].releases), 1)
  })
})
