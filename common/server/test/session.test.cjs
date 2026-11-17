// Modified in the Mobile Remote derivative (2026): mobile UI, media transport or recovery changes; see MODIFICATIONS.md.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// 登录后的侧栏提供可见退出入口
 test('dashboard exposes logout confirmation', () => {
  const html = fs.readFileSync(path.resolve(__dirname, '../public/index.html'), 'utf8');
  assert.match(html, /href=['"]\/logout['"]/);
});

// 真实 HTTP 会话测试只使用专用假凭据与隔离目录
 test('persistent login protects checks, survives app restart and logout revokes cookie', async () => {
  const { registerPrivateSession } = require('../lib/private-session');
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'session-test-'));
  const config = { username: 'fixture', password: 'fixture-only-secret', secret: 'fixture-signing-key-not-for-production-123456', origin: 'https://fixture.example', dir };
  let server;
  let logoutCookie;
  // 创建监听回环的真实测试应用
  async function start() {
    const app = express();
    app.set('trust proxy', 'loopback');
    app.use(express.json());
    registerPrivateSession(app, config, req => { logoutCookie = req.headers.cookie; }, path.join(dir, 'credentials.fixture'));
    server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    return 'http://127.0.0.1:' + server.address().port;
  }
  // 关闭真实测试监听
  async function stop() { await new Promise(resolve => server.close(resolve)); }
  let base = await start();
  const headers = { 'Content-Type': 'application/json', 'Origin': config.origin, 'X-Forwarded-Proto': 'https' };
  try {
    let r = await fetch(base + '/session/check');
    assert.equal(r.status, 401);
    assert.equal(r.headers.get('www-authenticate'), null);
    r = await fetch(base + '/session/login', { method: 'POST', headers, body: JSON.stringify({ username: 'fixture', password: 'wrong' }) });
    assert.equal(r.status, 401);
    r = await fetch(base + '/session/login', { method: 'POST', headers: { ...headers, Origin: 'https://evil.example' }, body: JSON.stringify(config) });
    assert.equal(r.status, 403);
    r = await fetch(base + '/session/login', { method: 'POST', headers, body: JSON.stringify(config) });
    assert.equal(r.status, 200);
    const cookieHeader = r.headers.get('set-cookie');
    assert.match(cookieHeader, /HttpOnly/);
    assert.match(cookieHeader, /Secure/);
    assert.match(cookieHeader, /SameSite=Strict/);
    assert.match(cookieHeader, /Expires=/);
    assert.equal((await r.json()).days, 30);
    const expiry = new Date(cookieHeader.match(/Expires=([^;]+)/)[1]).getTime();
    assert.ok(Math.abs(expiry - Date.now() - 30 * 86400000) < 3000);
    const cookie = cookieHeader.split(';')[0];
    // 旧会话续期时保留标识，同时缩短为新的闲置窗口
    const sessionPath = path.join(dir, fs.readdirSync(dir).find(name => name.endsWith('.json')));
    let saved = JSON.parse(fs.readFileSync(sessionPath));
    saved.cookie.originalMaxAge = 90 * 86400000;
    saved.cookie.expires = new Date(Date.now() + 90 * 86400000).toISOString();
    fs.writeFileSync(sessionPath, JSON.stringify(saved));
    r = await fetch(base + '/session/account', { headers: { ...headers, cookie } });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('cache-control'), 'no-store');
    const renewed = r.headers.get('set-cookie');
    assert.equal(renewed.split(';')[0], cookie);
    assert.ok(Math.abs(new Date(renewed.match(/Expires=([^;]+)/)[1]).getTime() - Date.now() - 30 * 86400000) < 3000);
    r = await fetch(base + '/session/check', { headers: { cookie } });
    assert.equal(r.status, 204);
    await stop();
    base = await start();
    r = await fetch(base + '/session/check', { headers: { cookie } });
    assert.equal(r.status, 204);
    r = await fetch(base + '/session/check', { headers: { cookie: cookie + 'tampered' } });
    assert.equal(r.status, 401);
    assert.equal(logoutCookie, undefined, 'login must not invoke media revocation');
    r = await fetch(base + '/session/logout', { method: 'POST', headers: { ...headers, cookie } });
    assert.equal(r.status, 200);
    assert.equal(logoutCookie, cookie, 'successful logout must revoke audio using the same request identity');
    r = await fetch(base + '/session/check', { headers: { cookie } });
    assert.equal(r.status, 401);
    // 模拟长期闲置的旧凭证，不能被续期接口重新激活
    r = await fetch(base + '/session/login', { method: 'POST', headers, body: JSON.stringify(config) });
    const idleCookie = r.headers.get('set-cookie').split(';')[0];
    const idlePath = path.join(dir, fs.readdirSync(dir).find(name => name.endsWith('.json')));
    saved = JSON.parse(fs.readFileSync(idlePath));
    saved.__lastAccess = Date.now() - 31 * 86400000;
    saved.cookie.originalMaxAge = 90 * 86400000;
    saved.cookie.expires = new Date(Date.now() + 59 * 86400000).toISOString();
    fs.writeFileSync(idlePath, JSON.stringify(saved));
    r = await fetch(base + '/session/account', { headers: { ...headers, cookie: idleCookie } });
    assert.equal(r.status, 401);
    // 修改密码撤销当前及其他设备持有的旧凭证
    r = await fetch(base + '/session/login', { method: 'POST', headers, body: JSON.stringify(config) });
    const passwordCookie = r.headers.get('set-cookie').split(';')[0];
    r = await fetch(base + '/session/password', { method: 'POST', headers: { ...headers, cookie: passwordCookie }, body: JSON.stringify({ currentPassword: config.password, newPassword: 'fixture-new-secret' }) });
    assert.equal(r.status, 200);
    r = await fetch(base + '/session/check', { headers: { cookie: passwordCookie } });
    assert.equal(r.status, 401);
  } finally {
    await stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
