// Modified in the Mobile Remote derivative (2026): mobile UI, media transport or recovery changes; see MODIFICATIONS.md.
'use strict'
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path')
const { webkit } = require('playwright')
// 合成账号与设备验证移动端管理流程，不读取真实密码或画面
 test('mobile share management creates and revokes links and validates password confirmation', async () => {
  const browser = await webkit.launch({ executablePath: process.env.PHONE_AUDIO_WEBKIT_EXECUTABLE })
  try {
    const page = await browser.newPage({ viewport: { width: 393, height: 852 }, hasTouch: true })
    let shares = [], passwordCalls = 0
    await page.route('http://fixture/**', route => {
      const url = new URL(route.request().url()), method = route.request().method()
      let json
      if (url.pathname === '/session/account') json = { username: 'shun' }
      else if (url.pathname === '/api/records') json = { records: [{ serial: 'fixture', name: '我的安卓手机' }] }
      else if (url.pathname === '/api/shares' && method === 'GET') json = { shares }
      else if (url.pathname === '/api/shares' && method === 'POST') { shares = [{ id: 'fixture', createdAt: Date.now(), expiresAt: Date.now() + 3600000 }]; json = { ...shares[0], url: 'https://fixture/share/#' + 'a'.repeat(64) } }
      else if (method === 'DELETE') { shares[0].revoked = true; json = { ok: true } }
      else if (url.pathname === '/session/password') { passwordCalls++; json = { ok: true } }
      if (json) return route.fulfill({ json })
      const file = path.join(__dirname, '../public', url.pathname)
      return route.fulfill({ body: fs.readFileSync(file), contentType: file.endsWith('.js') ? 'application/javascript' : 'text/html' })
    })
    await page.goto('http://fixture/manage.html')
    await page.getByRole('button', { name: '生成观看链接' }).click()
    await page.waitForSelector('#result:not([hidden])')
    assert.match(await page.locator('#link').inputValue(), /\/share\/#a+/)
    if (process.env.UI_SHOTS) await page.screenshot({ path: path.join(process.env.UI_SHOTS, 'share-management.png'), fullPage: true })
    await page.getByRole('button', { name: '关闭分享', exact: true }).click()
    await page.waitForFunction(() => document.querySelector('#shares').textContent.includes('已关闭'))
    await page.locator('[name=currentPassword]').fill('old123')
    await page.locator('[name=newPassword]').fill('new123')
    await page.locator('[name=confirm]').fill('other123')
    await page.getByRole('button', { name: '保存新密码' }).click()
    assert.equal(passwordCalls, 0)
    assert.match(await page.locator('#feedback').innerText(), /不一致/)
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
  } finally { await browser.close() }
})
