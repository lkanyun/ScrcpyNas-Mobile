// Modified in the Mobile Remote derivative (2026): mobile UI, media transport or recovery changes; see MODIFICATIONS.md.
'use strict'

const crypto = require('node:crypto')
const { WebSocket, WebSocketServer } = require('ws')

// 温会话只保留现有代理连接，离线视频直接丢弃，不缓存录像
const WARM_STREAM_TIMEOUT_MS = 10 * 60 * 1000
const INITIAL_PREFIX = Buffer.from('scrcpy_initial')
const MAX_PENDING_BYTES = 256 * 1024
const MAX_INITIAL_BYTES = 1024 * 1024
// 保存本进程的撤销入口，供成功退出登录时同步关闭现有连接
const revokers = new Set()
// 退出接口只释放既有页面租约，不能创建连接或提交任意输入
const screenReleasers = new Set()

// 在经过现有认证与同源校验后查找精确标签页和页面租约
async function releaseWarmScreen(req, body) {
  const owner = identity(req)
  for (const release of screenReleasers) {
    const result = release(owner, body)
    if (result) return await result
  }
  return { status: 404, ok: false, error: '投屏会话不存在' }
}

// 按现有请求认证材料隔离温会话，不保存或输出原始认证内容
function identity(req) {
  return crypto.createHash('sha256').update(req.headers.cookie || '').update('\0').update(req.headers.authorization || '').digest('hex')
}

// 撤销当前浏览器认证范围内的温会话与活动投屏
function revokeWarmStreams(req) {
  const owner = identity(req)
  for (const revoke of revokers) revoke(owner)
}

// 在现有鉴权之后接入温连接代理，其他请求仍交由原始代理处理
function createWarmScrcpyUpgradeProxy({ buildProxyPath, wsScrcpyHost, wsScrcpyPort, fallback, timeoutMs = WARM_STREAM_TIMEOUT_MS }) {
  const rtcConfig = process.env.PHONE_RTC_CONFIG ? JSON.parse(require('node:fs').readFileSync(process.env.PHONE_RTC_CONFIG, 'utf8')) : null
  const sessions = new Map()
  const closingRtc = new Set()
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: MAX_PENDING_BYTES })

  // 等待异步 UDP 回收便于关闭服务和测试时确认无遗留监听
  function closeRtc(session) {
    const rtc = session.rtc
    session.rtc = null
    if (!rtc) return
    const pending = Promise.resolve(rtc.close()).catch(() => {}).finally(() => closingRtc.delete(pending))
    closingRtc.add(pending)
  }

  // 合并同一设备的物理屏幕偏好，只有最后一个黑屏请求释放时才恢复正常模式
  function setScreenPower(session, mode) {
    if (session.powerPending && session.powerPending.mode === mode) return session.powerPending.promise
    const others = Array.from(sessions.values()).filter(item => item.target === session.target && item !== session && !item.disposed)
    const before = session.screenMode === 0 || others.some(item => item.screenMode === 0)
    const previous = session.screenMode
    const revision = (session.powerRevision || 0) + 1
    session.powerRevision = revision
    session.screenMode = mode
    const after = mode === 0 || others.some(item => item.screenMode === 0)
    if (before === after) return Promise.resolve({ submitted: false, shared: after })
    const channel = [session, ...others].find(item => item.upstream.readyState === WebSocket.OPEN)
    const sent = channel ? new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Screen power write timeout')), 2000)
      timer.unref()
      try {
        channel.upstream.send(Buffer.from([10, after ? 0 : 2]), { binary: true }, error => {
          clearTimeout(timer)
          if (error) reject(error)
          else resolve({ submitted: true, mode: after ? 0 : 2 })
        })
      } catch (error) { clearTimeout(timer); reject(error) }
    }) : Promise.reject(new Error('Screen power channel unavailable'))
    const operation = sent.catch(error => {
      if (session.powerRevision === revision) session.screenMode = previous
      throw error
    }).finally(() => { if (session.powerPending && session.powerPending.revision === revision) session.powerPending = null })
    session.powerPending = { mode, promise: operation, revision }
    return operation
  }

  // 关闭唯一上游并从注册表移除，避免设备离线或退出后遗留连接
  function dispose(session) {
    if (session.disposed) return
    const restored = setScreenPower(session, undefined)
    session.disposed = true
    clearTimeout(session.timer)
    clearInterval(session.rtcHeartbeat)
    closeRtc(session)
    sessions.delete(session.key)
    if (session.browser) session.browser.terminate()
    // 等恢复帧写入原通道后再释放，避免 terminate 丢掉最后的 NORMAL 命令
    restored.catch(() => console.warn('[screen-power] restore unavailable; physical panel state unconfirmed')).finally(() => session.upstream.terminate())
    session.pending.length = 0
    session.initial = null
  }

  // 按认证范围撤销全部标签页，不依赖浏览器发送断开事件
  function revoke(owner) {
    for (const session of sessions.values()) if (session.owner === owner) dispose(session)
  }
  revokers.add(revoke)

  // 页面随机租约使旧文档的延迟退出无法释放已经重连的新控制者
  function releaseScreen(owner, body) {
    const session = Array.from(sessions.values()).find(item => item.owner === owner && item.token === body.token && item.target === body.serial)
    if (!session) return null
    if (session.lease !== body.lease) return { status: 409, ok: false, error: '页面已被新投屏接管' }
    session.releasedLease = body.lease
    return setScreenPower(session, undefined).then(result => ({ status: 200, ok: true, ...result })).catch(() => ({ status: 503, ok: false, error: '投屏通道不可用，屏幕恢复未确认' }))
  }
  screenReleasers.add(releaseScreen)

  // 接收初始化元数据，其余离线媒体包不保留
  function forward(session, data, binary) {
    if (binary && data.subarray(0, INITIAL_PREFIX.length).equals(INITIAL_PREFIX)) {
      if (data.length > MAX_INITIAL_BYTES) return dispose(session)
      session.initial = Buffer.from(data)
    }
    if (session.rtcMode && binary && data.length > 4 && data[0] === 0 && data[1] === 0 && (data[2] === 1 || (data[2] === 0 && data[3] === 1))) {
      try { session.rtc?.video(data) } catch (_) { session.browser?.close(1011, '视频流格式异常') }
      return
    }
    const browser = session.browser
    if (browser && browser.readyState === WebSocket.OPEN) {
      if (browser.bufferedAmount > MAX_INITIAL_BYTES) return browser.terminate()
      browser.send(data, { binary })
    }
  }

  // 将已通过外层鉴权的新页面绑定到同一上游，初始化由原生控制消息重新协商
  function attach(session, browser) {
    clearTimeout(session.timer)
    if (session.browser) session.browser.terminate()
    session.browser = browser
    if (session.initial) browser.send(session.initial, { binary: true })
    browser.on('error', () => browser.terminate())
    // 原 WebSocket 和数据通道共用同一租约与屏幕控制边界
    function receiveControl(data, binary) {
      if (session.disposed || session.browser !== browser) return
      if (!binary && session.rtcMode) {
        try { session.rtc?.receive(JSON.parse(data.toString())).catch(() => browser.close(1008, '协商失败')) } catch (_) { browser.close(1008, '协商格式异常') }
        return
      }
      if (binary && data[0] === 101 && data.length <= 1024) session.rtcSettings = Buffer.from(data)
      if (binary && data[0] === 10) {
        if (data.length === 2 && [0, 2].includes(data[1]) && session.lease !== session.releasedLease && session.initial && session.upstream.readyState === WebSocket.OPEN) setScreenPower(session, data[1]).catch(() => console.warn('[screen-power] command unavailable; physical panel state unconfirmed'))
        return
      }
      if (session.upstream.readyState === WebSocket.OPEN) session.upstream.send(data, { binary })
      else if (session.upstream.readyState === WebSocket.CONNECTING) {
        session.pendingBytes += data.length
        if (session.pendingBytes > MAX_PENDING_BYTES) return dispose(session)
        session.pending.push({ data, binary })
      }
    }
    browser.on('message', receiveControl)
    if (session.rtcMode) {
      closeRtc(session)
      clearInterval(session.rtcHeartbeat)
      try { session.rtc = require('./rtc-media').createRtcMedia({
        config: rtcConfig,
        signal: message => { if (session.browser === browser && browser.readyState === WebSocket.OPEN) browser.send(JSON.stringify(message)) },
        control: data => receiveControl(data, true),
        requestKey: () => {
          if (!session.rtcSettings || session.upstream.readyState !== WebSocket.OPEN) return false
          session.upstream.send(session.rtcSettings)
          return true
        },
        failed: () => browser.close(1011, '实时视频连接失败')
      }) } catch (_) { dispose(session); return }
      // 持续核实私有会话 认证失效时立即切断媒体而非只切断信令
      session.rtcHeartbeat = setInterval(async () => {
        const valid = await require('./phone-audio').checkSession(rtcConfig.sessionCheckUrl, session.cookie)
        if (session.browser !== browser) return
        if (!valid) return dispose(session)
        if (browser.readyState === WebSocket.OPEN) browser.send(JSON.stringify({ rtc: 'ping' }))
      }, 5000)
      session.rtcHeartbeat.unref()
    }
    browser.on('close', () => {
      if (session.disposed || session.browser !== browser) return
      session.browser = null
      closeRtc(session)
      clearInterval(session.rtcHeartbeat)
      session.timer = setTimeout(() => dispose(session), timeoutMs)
      session.timer.unref()
    })
  }

  // 只接受原生投屏端点与标签页随机令牌，不能用于保温任意远程服务
  function upgradeAccepted(req, socket, head) {
    const proxyPath = buildProxyPath(req.url)
    const url = new URL(proxyPath, 'http://localhost')
    const token = url.searchParams.get('warmSession') || ''
    const lease = url.searchParams.get('screenLease') || ''
    if (url.searchParams.get('action') !== 'proxy-adb' || url.searchParams.get('remote') !== 'tcp:8886'
      || !url.searchParams.get('udid') || url.searchParams.get('path') || !/^[a-f0-9]{32}$/.test(token)) {
      return fallback(req, socket, head)
    }
    const owner = identity(req)
    // 去除令牌只影响本机转发地址，客户端仍保留原标签页标识
    url.searchParams.delete('warmSession')
    url.searchParams.delete('screenLease')
    const rtcMode = url.searchParams.get('rtc') === '1'
    url.searchParams.delete('rtc')
    const key = owner + '\0' + token + '\0' + url.pathname + url.search + (rtcMode ? '\0rtc' : '')
    let session = sessions.get(key)
    if (!session && sessions.size >= 128) {
      socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n')
      return
    }
    wss.handleUpgrade(req, socket, head, browser => {
      if (!session) {
        const upstream = new WebSocket(`ws://${wsScrcpyHost}:${wsScrcpyPort}${url.pathname}${url.search}`, { perMessageDeflate: false, maxPayload: 8 * 1024 * 1024 })
        session = { owner, key, rtcMode, cookie: req.headers.cookie, target: url.searchParams.get('udid'), upstream, browser: null, initial: null, pending: [], pendingBytes: 0, disposed: false }
        sessions.set(key, session)
        upstream.on('message', (data, binary) => forward(session, data, binary))
        upstream.on('open', () => {
          for (const pending of session.pending) upstream.send(pending.data, { binary: pending.binary })
          session.pending.length = 0
          session.pendingBytes = 0
        })
        upstream.on('close', () => dispose(session))
        upstream.on('error', () => dispose(session))
      }
      session.token = token
      session.lease = lease
      attach(session, browser)
    })
  }

  // 新的 UDP 媒体入口独立检查精确来源和有效私有会话
  function proxy(req, socket, head) {
    const url = new URL(req.url, 'http://localhost')
    if (url.searchParams.get('rtc') !== '1') return upgradeAccepted(req, socket, head)
    if (!rtcConfig || req.headers.origin !== rtcConfig.origin) return socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
    require('./phone-audio').checkSession(rtcConfig.sessionCheckUrl, req.headers.cookie).then(valid => {
      if (socket.destroyed) return
      if (!valid) return socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
      upgradeAccepted(req, socket, head)
    }).catch(() => socket.destroy())
  }

  // 释放隔离夹具或关闭应用时的所有资源
  proxy.close = () => {
    revokers.delete(revoke)
    screenReleasers.delete(releaseScreen)
    for (const session of sessions.values()) dispose(session)
    wss.close()
    return Promise.allSettled([...closingRtc])
  }
  return proxy
}

module.exports = { createWarmScrcpyUpgradeProxy, revokeWarmStreams, releaseWarmScreen, WARM_STREAM_TIMEOUT_MS }
