// Modified in the Mobile Remote derivative (2026): mobile UI, media transport or recovery changes; see MODIFICATIONS.md.
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const session = require('express-session');
const scrypt = require('node:util').promisify(crypto.scrypt);
const FileStore = require('session-file-store')(session);
const { revokeWarmStreams } = require('./warm-stream');

// 比较定长摘要避免凭据比较泄露前缀信息
function same(a, b) {
  const digest = value => crypto.createHash('sha256').update(String(value || '')).digest();
  return crypto.timingSafeEqual(digest(a), digest(b));
}

// 凭据摘要变化会使所有旧持久会话失效
function credentialRevision(config) { return crypto.createHash('sha256').update(config.username + '\0' + (config.passwordHash?.hash || config.password)).digest('hex'); }
// 兼容旧配置，修改后仅保存带随机盐的密码摘要
async function verifyPassword(password, config) {
  if (typeof password !== 'string' || password.length > 128) return false;
  if (!config.passwordHash) return same(password, config.password);
  return same((await scrypt(password, config.passwordHash.salt, 64)).toString('hex'), config.passwordHash.hash);
}

// 注册持久会话与供可信反向代理调用的鉴权接口
function registerPrivateSession(app, config, onLogout = () => {}, configFile) {
  const duration = 30 * 24 * 60 * 60 * 1000;
  const cookieName = '__Host-phone_session';
  let revision = credentialRevision(config);
  const isOwner = req => req.session?.revision === revision;
  const failures = new Map();
  fs.mkdirSync(config.dir, { recursive: true, mode: 0o700 });
  app.use(session({
    name: cookieName,
    secret: config.secret,
    store: new FileStore({ path: config.dir, ttl: duration / 1000, reapInterval: -1, retries: 0, logFn: () => {} }),
    resave: false,
    rolling: true,
    saveUninitialized: false,
    cookie: { httpOnly: true, secure: true, sameSite: 'strict', path: '/', maxAge: duration },
  }));
  // 兼容旧长效凭证，按最后使用时间拒绝过期会话并统一续期窗口
  app.use((req, _res, next) => {
    if (req.session?.revision && Number(req.session.__lastAccess) < Date.now() - duration) {
      return req.session.destroy(next);
    }
    if (req.session) req.session.cookie.maxAge = duration;
    next();
  });
  app.get('/session/check', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.sendStatus(isOwner(req) ? 204 : 401);
  });
  app.post('/session/login', async (req, res, next) => {
    if (req.get('origin') !== config.origin) return res.status(403).json({ ok: false });
    const attempts = failures.get(req.ip) || { count: 0, until: 0 };
    if (attempts.until > Date.now() && attempts.count >= 10) return res.status(429).json({ error: '尝试过于频繁，请稍后重试' });
    if (!same(req.body && req.body.username, config.username) || !await verifyPassword(req.body?.password, config)) {
      failures.set(req.ip, { count: attempts.until > Date.now() ? attempts.count + 1 : 1, until: Date.now() + 60000 });
      return res.status(401).json({ ok: false, error: '账号或密码不正确，请重新输入' });
    }
    failures.delete(req.ip);
    req.session.regenerate(error => {
      if (error) return next(error);
      req.session.revision = revision;
      req.session.save(error => error ? next(error) : res.json({ ok: true, days: 30 }));
    });
  });
  app.post('/session/logout', (req, res, next) => {
    if (req.get('origin') !== config.origin) return res.status(403).json({ ok: false });
    req.session.destroy(error => {
      if (error) return next(error);
      revokeWarmStreams(req);
      onLogout(req);
      res.clearCookie(cookieName, { secure: true, httpOnly: true, sameSite: 'strict', path: '/' });
      res.json({ ok: true });
    });
  });
  // 修改密码必须持有所有者会话并验证旧密码，写入成功后轮换所有登录状态
  let changing = false;
  app.post('/session/password', async (req, res, next) => {
    if (!isOwner(req)) return res.sendStatus(401);
    if (req.get('origin') !== config.origin) return res.sendStatus(403);
    if (changing) return res.status(409).json({ error: '密码正在更新，请稍后重试' });
    const { currentPassword, newPassword } = req.body || {};
    if (typeof newPassword !== 'string' || newPassword.length < 6 || newPassword.length > 128) return res.status(400).json({ error: '新密码请使用 6 至 128 个字符，无需复杂组合' });
    changing = true;
    try {
      if (!await verifyPassword(currentPassword, config)) return res.status(400).json({ error: '当前密码不正确' });
      if (!configFile) throw new Error('密码存储尚未配置');
      const salt = crypto.randomBytes(16).toString('hex');
      const hash = (await scrypt(newPassword, salt, 64)).toString('hex');
      const updated = { ...config, passwordHash: { salt, hash } }; delete updated.password;
      fs.writeFileSync(configFile + '.new', JSON.stringify(updated), { mode: 0o600 });
      fs.renameSync(configFile + '.new', configFile);
      const oldRequest = { headers: { cookie: req.headers.cookie } };
      revokeWarmStreams(req); onLogout(oldRequest);
      Object.assign(config, updated); delete config.password; revision = credentialRevision(config);
      req.session.destroy(error => {
        if (error) return next(error);
        res.clearCookie(cookieName, { secure: true, httpOnly: true, sameSite: 'strict', path: '/' });
        res.json({ ok: true, username: config.username });
      });
    } catch (error) { next(error); } finally { changing = false; }
  });
  // 浏览器直接访问账户接口以接收续期 Cookie，代理内部鉴权无法代替此响应
  app.get('/session/account', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    return isOwner(req) ? res.json({ username: config.username }) : res.sendStatus(401);
  });
  app.get('/login', (_req, res) => res.type('html').send(loginPage));
  app.get('/logout', (_req, res) => res.type('html').send(logoutPage));
  return { isOwner };
}

// 自包含登录表单不依赖受保护静态文件或浏览器原生认证框
const loginPage = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="apple-mobile-web-app-capable" content="yes"><title>手机远控 · 登录</title><style>html{color-scheme:dark}body{margin:0;background:#101114;color:#eee;font:16px -apple-system,sans-serif;display:flex;min-height:100dvh;align-items:center;justify-content:center}main{width:min(320px,80vw);padding:30px;border-radius:26px;background:#1c1e23}h1{font-size:25px}p{color:#a4a9b3;line-height:1.6}label{display:block;margin-top:18px}input,button{box-sizing:border-box;width:100%;padding:14px;margin-top:8px;border-radius:12px;border:1px solid #40444d;font:inherit}input{background:#111318;color:white}button{background:#2979ff;color:white;border:0;margin-top:24px}#status{min-height:24px;color:#ffb3ab;font-size:14px}a{color:#a4a9b3}</style></head><body><main><h1>手机远控</h1><p>仅供本人设备使用<br>自动记住此浏览器<br>连续 30 天未使用后需重新登录</p><form id="form"><label>用户名<input name="username" value="" autocomplete="username" required autocapitalize="none" spellcheck="false"></label><label>密码<input name="password" type="password" autocomplete="current-password" required></label><button>登录并记住设备</button><p id="status" role="status"></p></form></main><script>document.querySelector('#form').addEventListener('submit',async function(e){e.preventDefault();const b=this.querySelector('button'),s=document.querySelector('#status');b.disabled=true;s.textContent='正在登录…';try{const r=await fetch('/session/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(Object.fromEntries(new FormData(this)))});const d=await r.json();if(!d.ok)throw Error(d.error||'暂时无法登录，请稍后重试');s.textContent='登录成功，正在进入…';location.replace('/');}catch(e){s.textContent=e.message;}finally{b.disabled=false;}});</script></body></html>`;

// 退出操作通过同源 POST 撤销服务端会话而非只清除浏览器显示
const logoutPage = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>退出登录</title><body style="background:#101114;color:white;font:18px -apple-system;padding:32px"><h2>退出此设备</h2><p>退出后，下次访问需要重新登录。</p><button id="out" style="padding:16px">退出登录</button><p id="status"></p><script>document.querySelector('#out').onclick=async()=>{try{const r=await fetch('/session/logout',{method:'POST'});if(!r.ok)throw Error('退出失败，请重试');location.replace('/login')}catch(e){document.querySelector('#status').textContent=e.message}}</script></body></html>`;

module.exports = { registerPrivateSession };
