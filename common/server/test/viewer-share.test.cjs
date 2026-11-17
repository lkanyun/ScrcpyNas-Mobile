// Modified in the Mobile Remote derivative (2026): mobile UI, media transport or recovery changes; see MODIFICATIONS.md.
'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http')
const express = require('express'), { WebSocket, WebSocketServer } = require('ws')
const { registerPrivateSession } = require('../lib/private-session')
const { registerViewerShare, createShareStore, viewerSettings } = require('../lib/viewer-share')
// 使用真实持久会话和模拟视频上游覆盖分享授权与密码变更边界
 test('viewer capability cannot become an owner and password changes revoke old sessions', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'share-test-'))
  const configFile = path.join(dir, 'config.json'), recordsFile = path.join(dir, 'devices.json')
  const config = { username: 'shun', password: 'old-password', secret: 'fixture-secret-with-sufficient-entropy', origin: 'https://fixture', dir: path.join(dir, 'sessions') }
  fs.writeFileSync(configFile, JSON.stringify(config)); fs.writeFileSync(recordsFile, JSON.stringify([{ serial: 'fixture' }]))
  const app = express(); app.set('trust proxy', 'loopback'); app.use(express.json())
  const owner = registerPrivateSession(app, config, () => {}, configFile)
  const engine = new WebSocketServer({ port: 0, host: '127.0.0.1' }); await new Promise(resolve => engine.once('listening', resolve))
  const writes = []; engine.on('connection', client => client.on('message', data => writes.push(Buffer.from(data))))
  const share = registerViewerShare(app, { config, isOwner: owner.isOwner, recordsFile, wsHost: '127.0.0.1', wsPort: engine.address().port, prepare: async () => {}, rtcConfig: { secret: 'fixture', urls: [], origin: config.origin } })
  app.use((_req, res) => res.sendStatus(401))
  const server = http.createServer(app); server.on('upgrade', (req, socket, head) => { if (!share.handleUpgrade(req, socket, head)) socket.destroy() })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = 'http://127.0.0.1:' + server.address().port
  // 仅夹具通过可信 loopback 请求模拟 HTTPS 代理
  async function request(url, method = 'GET', body, cookie = '', origin = config.origin) {
    return fetch(base + url, { method, headers: { Origin: origin, 'X-Forwarded-Proto': 'https', Cookie: cookie, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
  }
  try {
    assert.equal((await request('/api/shares')).status, 401)
    const login = await request('/session/login', 'POST', { username: 'shun', password: 'old-password' })
    const cookie = login.headers.get('set-cookie').split(';')[0]
    assert.equal((await request('/session/check', 'GET', null, cookie)).status, 204)
    assert.equal((await request('/api/shares', 'POST', { serial: 'fixture', minutes: 60 }, cookie, 'https://evil')).status, 403)
    assert.equal((await request('/api/shares', 'POST', { serial: 'other', minutes: 60 }, cookie)).status, 400)
    assert.equal((await request('/api/shares', 'POST', { serial: 'fixture', minutes: 0 }, cookie)).status, 400)
    const created = await (await request('/api/shares', 'POST', { serial: 'fixture', minutes: 60 }, cookie)).json()
    const token = new URL(created.url).hash.slice(1)
    assert.equal(token.length, 64)
    assert.ok(!fs.readFileSync(path.join(dir, 'shares.json'), 'utf8').includes(token))
    assert.equal((await request('/session/check', 'GET', null, 'phone_share=' + token)).status, 401)
    assert.equal((await request('/api/shares', 'GET', null, 'phone_share=' + token)).status, 401)
    assert.equal((await request('/share/check?serial=other', 'GET', null, 'phone_share=' + token)).status, 401)
    assert.equal((await request('/share/check?serial=fixture', 'GET', null, 'phone_share=' + token)).status, 204)
    const ws = new WebSocket(base.replace('http:', 'ws:') + '/share/video?token=' + token, { origin: config.origin })
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) })
    const closed = new Promise(resolve => ws.once('close', resolve))
    ws.send(Buffer.from([0, 1, 2]))
    await closed
    assert.ok(writes.every(data => data.equals(viewerSettings())), 'only server-generated encoding commands may reach Android')
    const watching = new WebSocket(base.replace('http:', 'ws:') + '/share/video?token=' + token, { origin: config.origin })
    await new Promise((resolve, reject) => { watching.once('open', resolve); watching.once('error', reject) })
    const revoked = new Promise(resolve => watching.once('close', resolve))
    assert.equal((await request('/api/shares/' + created.id, 'DELETE', null, cookie)).status, 200)
    await revoked
    assert.equal((await request('/share/check?serial=fixture', 'GET', null, 'phone_share=' + token)).status, 401)
    assert.equal((await request('/session/password', 'POST', { currentPassword: 'wrong', newPassword: 'simple6' }, cookie)).status, 400)
    assert.equal((await request('/session/password', 'POST', { currentPassword: 'old-password', newPassword: 'simple6' }, cookie)).status, 200)
    assert.equal((await request('/session/check', 'GET', null, cookie)).status, 401)
    assert.equal((await request('/session/login', 'POST', { username: 'shun', password: 'old-password' })).status, 401)
    assert.equal((await request('/session/login', 'POST', { username: 'shun', password: 'simple6' })).status, 200)
    const saved = JSON.parse(fs.readFileSync(configFile)); assert.ok(saved.passwordHash); assert.equal(saved.password, undefined)
    assert.ok(!fs.readFileSync(configFile, 'utf8').includes('simple6'))
  } finally {
    for (const ws of engine.clients) ws.terminate()
    await new Promise(resolve => engine.close(resolve))
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve))
    await new Promise(resolve => setTimeout(resolve, 100))
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
// 重新加载后仍拒绝已到期的能力，链接无授权延续能力
 test('expired share is rejected after store reload', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'share-expiry-')), file = path.join(dir, 'shares.json')
  try { const store = createShareStore(file), { token } = store.create('fixture', 1); const rows = JSON.parse(fs.readFileSync(file)); rows[0].expiresAt = Date.now() - 1; fs.writeFileSync(file, JSON.stringify(rows)); assert.equal(createShareStore(file).resolve(token), null) } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
