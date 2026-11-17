// Modified in the Mobile Remote derivative (2026): mobile UI, media transport or recovery changes; see MODIFICATIONS.md.
'use strict'
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { WebSocket, WebSocketServer } = require('ws')
const { createRtcMedia } = require('./rtc-media')
// 分享能力只保存摘要，原始链接只在创建时返回
function createShareStore(file) {
  let entries = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : []
  const listeners = new Set()
  const digest = token => crypto.createHash('sha256').update(token).digest('hex')
  // 原子替换防止中断留下半份授权文件
  function save() { fs.writeFileSync(file + '.new', JSON.stringify(entries), { mode: 0o600 }); fs.renameSync(file + '.new', file) }
  // 每次使用都校验期限和撤销状态
  function resolve(token) { if (!/^[a-f0-9]{64}$/.test(token || '')) return null; return entries.find(item => item.hash === digest(token) && !item.revoked && item.expiresAt > Date.now()) || null }
  function create(serial, minutes) {
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 10080) throw new Error('有效期应为 1 分钟至 7 天')
    entries = entries.filter(item => item.expiresAt > Date.now())
    if (entries.filter(item => !item.revoked).length >= 20) throw new Error('请先关闭不再使用的分享')
    const token = crypto.randomBytes(32).toString('hex')
    const item = { id: crypto.randomBytes(12).toString('hex'), serial, hash: digest(token), createdAt: Date.now(), expiresAt: Date.now() + minutes * 60000, revoked: false }
    entries.push(item); save(); return { item, token }
  }
  function revoke(id) { const item = entries.find(value => value.id === id); if (!item) return false; item.revoked = true; save(); for (const fn of listeners) fn(id); return true }
  return { resolve, create, revoke, list: () => entries.map(({ hash, ...item }) => item), onRevoke: fn => listeners.add(fn) }
}
// 编码参数只由服务端构造，不接受观看者提供的任何控制二进制
function viewerSettings() {
  const codec = Buffer.from('profile=1,level=512')
  const data = Buffer.alloc(36 + codec.length)
  data[0] = 101; data.writeInt32BE(1600000, 1); data.writeInt32BE(30, 5); data[9] = 1
  data.writeInt16BE(960, 10); data.writeInt16BE(960, 12); data.writeInt8(-1, 23)
  data.writeInt32BE(codec.length, 28); codec.copy(data, 32)
  return data
}
// 独立只读入口不代理设备 API，不创建可用控制数据通道
function registerViewerShare(app, options) {
  const { config, isOwner, recordsFile, wsHost, wsPort, prepare, audio, rtcConfig } = options
  const store = createShareStore(path.join(config.dir, '../shares.json'))
  const wss = new WebSocketServer({ noServer: true, maxPayload: 70000, perMessageDeflate: false })
  const viewers = new Set()
  const pending = new Set()
  const publicDir = path.join(__dirname, '../public')
  const files = { '': 'share-view.html', 'viewer.js': 'share-view.js', 'audio.js': 'phone-audio.js', 'opus.js': 'vendor/opus-decoder.min.js' }
  // 分享页和播放器脚本均不包含设备标识或管理凭据
  app.use('/share', (_req, res, next) => { res.set('Cache-Control', 'no-store'); res.set('Referrer-Policy', 'no-referrer'); next() })
  app.get('/share/check', (req, res) => {
    const token = /(?:^|;\s*)phone_share=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie || '')?.[1]
    const item = store.resolve(token)
    res.sendStatus(item && item.serial === req.query.serial ? 204 : 401)
  })
  for (const [name, file] of Object.entries(files)) app.get('/share/' + name, (_req, res) => res.sendFile(path.join(publicDir, file)))
  app.get('/share/info', (req, res) => {
    const item = store.resolve(req.get('x-share-token'))
    if (!item) return res.status(410).json({ error: '分享已关闭或已过期' })
    res.json({ expiresAt: item.expiresAt })
  })
  // 管理接口同时要求真实所有者会话与同源修改请求
  app.use('/api/shares', (req, res, next) => {
    if (!isOwner(req)) return res.sendStatus(401)
    if (req.method !== 'GET' && req.get('origin') !== config.origin) return res.sendStatus(403)
    next()
  })
  app.get('/api/shares', (_req, res) => res.json({ shares: store.list() }))
  app.post('/api/shares', (req, res) => {
    try {
      const records = JSON.parse(fs.readFileSync(recordsFile, 'utf8'))
      if (!Array.isArray(records) || !records.some(item => item.serial === req.body?.serial)) return res.status(400).json({ error: '请选择已保存的设备' })
      const { item, token } = store.create(req.body.serial, req.body.minutes)
      res.json({ id: item.id, expiresAt: item.expiresAt, url: config.origin + '/share/#' + token })
    } catch (error) { res.status(400).json({ error: error.message }) }
  })
  app.delete('/api/shares/:id', (req, res) => res.status(store.revoke(req.params.id) ? 200 : 404).json({ ok: true }))
  // 撤销时立即关闭媒体连接，音频进程同步收到撤销通知
  function closeViewer(viewer) {
    if (viewer.closed) return
    viewer.closed = true; viewers.delete(viewer); clearTimeout(viewer.expiry); clearInterval(viewer.heartbeat)
    viewer.upstream?.terminate(); viewer.rtc?.close().catch(() => {}); viewer.browser.close(4003, '分享已结束')
    audio?.disconnectSession({ headers: { cookie: 'phone_share=' + viewer.token } })
  }
  store.onRevoke(id => { for (const viewer of viewers) if (viewer.id === id) closeViewer(viewer); audio?.recheckShares?.() })
  // 固定端点认证完成后才启动固定设备的只读视频
  async function upgrade(req, socket, head) {
    const url = new URL(req.url, 'http://localhost')
    const token = url.searchParams.get('token'), item = store.resolve(token)
    if (!item || req.headers.origin !== config.origin || viewers.size + pending.size >= 3 || !rtcConfig) return socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
    pending.add(socket)
    socket.once('close', () => pending.delete(socket))
    try { await prepare(item.serial) } finally { pending.delete(socket) }
    if (!store.resolve(token) || socket.destroyed || viewers.size >= 3) return socket.destroy()
    wss.handleUpgrade(req, socket, head, browser => {
      const viewer = { id: item.id, token, browser, closed: false }
      viewers.add(viewer)
      viewer.alive = true
      browser.on('pong', () => { viewer.alive = true })
      viewer.heartbeat = setInterval(() => {
        if (!viewer.alive || !store.resolve(token)) return closeViewer(viewer)
        viewer.alive = false; browser.ping()
      }, 15000)
      viewer.heartbeat.unref()
      viewer.expiry = setTimeout(() => closeViewer(viewer), Math.min(2147483647, item.expiresAt - Date.now()))
      const upstream = viewer.upstream = new WebSocket(`ws://${wsHost}:${wsPort}/?` + new URLSearchParams({ action: 'proxy-adb', remote: 'tcp:8886', udid: item.serial }), { maxPayload: 8 * 1024 * 1024, perMessageDeflate: false })
      const settings = viewerSettings()
      // 唯一上游写入是本服务生成的视频编码参数
      const key = () => { if (!viewer.closed && upstream.readyState === 1) upstream.send(settings) }
      viewer.rtc = createRtcMedia({ config: rtcConfig, readOnly: true, control: () => {}, requestKey: key, failed: () => closeViewer(viewer), signal: message => { if (!viewer.closed && browser.readyState === 1) browser.send(JSON.stringify(message)) } })
      upstream.on('open', key)
      upstream.on('message', (data, binary) => {
        if (binary && data.length > 4 && data[0] === 0 && data[1] === 0 && (data[2] === 1 || data[2] === 0 && data[3] === 1)) viewer.rtc.video(data)
      })
      upstream.on('error', () => closeViewer(viewer)); upstream.on('close', () => closeViewer(viewer))
      let messages = 0
      browser.on('message', (data, binary) => {
        if (viewer.closed) return
        if (binary || ++messages > 100 || !store.resolve(token)) return closeViewer(viewer)
        try { const value = JSON.parse(data); if (!['answer', 'ice'].includes(value.rtc)) return closeViewer(viewer); viewer.rtc.receive(value).catch(() => closeViewer(viewer)) } catch (_) { closeViewer(viewer) }
      })
      browser.on('close', () => closeViewer(viewer)); browser.on('error', () => closeViewer(viewer))
    })
  }
  return { store, handleUpgrade(req, socket, head) { if (req.url.split('?')[0] !== '/share/video') return false; upgrade(req, socket, head).catch(() => socket.destroy()); return true } }
}
module.exports = { createShareStore, viewerSettings, registerViewerShare }
