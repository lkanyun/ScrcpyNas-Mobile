// Modified in the Mobile Remote derivative (2026): mobile UI, media transport or recovery changes; see MODIFICATIONS.md.
// 在引擎创建连接前安装观察器，重载仅恢复原页而不触发设备清理或 ADB 重连
;(function () {
  'use strict'

  const params = new URLSearchParams(window.location.hash.replace(/^#!/, ''))
  if (params.get('action') !== 'stream') return
  // 兼容未安装统一接口的旧文档夹具，生产画布不借用媒体时钟
  function readProgress() {
    if (window.scrcpyNasProgress) return window.scrcpyNasProgress.read()
    const video = document.querySelector('video.video-layer')
    return { owner: video, drawable: video, position: video ? video.currentTime : 0,
      sourceRect: { width: video ? video.videoWidth : 0, height: video ? video.videoHeight : 0 },
      ready: !!video && !video.error && !video.paused && video.readyState >= 2 && video.videoWidth > 0 }
  }
  // 外层遮罩只保留易失像素，不写入任何存储或网络
  if (document.createElement) installTransition()

  // 在稳定同源宿主中保留最后画面，内部重载不销毁过渡层
  function installTransition() {
    let host = window
    let frame = null
    try {
      if (window.frameElement && window.frameElement.id === 'mirrorFrame' && window.parent.document.querySelector('#mirrorFrame') === window.frameElement) {
        host = window.parent
        frame = window.frameElement
      }
    } catch (_) { /* 跨源嵌入只使用当前文档的温和提示 */ }
    const doc = host.document
    const key = 'scrcpyNasRecovery'
    // 捕获原始目标，不能在旧闭包中动态读取已指向新文档的 WindowProxy
    const streamPath = window.location.pathname
    const streamHash = window.location.hash
    const owner = {}
    let navigating = false
    let stopped = false
    let authDenied = false
    let sampleTimer = null
    let videoSeen = null
    let lastTime = 0
    let progressSince = null
    let lastSample = 0
    let progressCount = 0

    // 清除画布像素并撤销宿主监听，敏感画面不跨退出或过期保留
    function clearCover() {
      const state = frame ? frame[key] : window[key]
      if (!state) return
      host.clearTimeout(state.expiry)
      host.removeEventListener('pagehide', state.clear)
      if (frame) frame.removeEventListener('load', state.loaded)
      state.canvas.width = state.canvas.height = 0
      state.root.remove()
      if (frame) delete frame[key]
      else delete window[key]
    }

    // 依据实际视频层矩形复制像素，维持 contain 与 cover 的裁切比例
    function showCover() {
      if (stopped || authDenied || (frame ? frame[key] : window[key]) || !document.body) return
      const picture = readProgress()
      const video = picture.drawable
      const bounds = frame ? frame.getBoundingClientRect() : { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight }
      const root = doc.createElement('div')
      root.id = 'scrcpynas-recovery-cover'
      root.style.cssText = 'position:fixed;z-index:2147483500;overflow:hidden;background:#10151d;display:flex;align-items:center;justify-content:center;flex-direction:column;pointer-events:none'
      root.style.left = bounds.left + 'px'
      root.style.top = bounds.top + 'px'
      root.style.width = bounds.width + 'px'
      root.style.height = bounds.height + 'px'
      const canvas = doc.createElement('canvas')
      canvas.style.cssText = 'position:absolute;pointer-events:auto'
      let captured = false
      if (video && picture.sourceRect.width && picture.sourceRect.height && (picture.mode !== 'webcodecs' || picture.drawnSeq > 0)) {
        const rect = video.getBoundingClientRect()
        const computed = window.getComputedStyle(video)
        canvas.width = picture.sourceRect.width
        canvas.height = picture.sourceRect.height
        canvas.style.left = rect.left + 'px'
        canvas.style.top = rect.top + 'px'
        canvas.style.width = rect.width + 'px'
        canvas.style.height = rect.height + 'px'
        canvas.style.objectFit = computed.objectFit
        canvas.style.objectPosition = computed.objectPosition
        try { canvas.getContext('2d').drawImage(video, 0, 0); captured = true } catch (_) { /* 无法读取时不阻断退出或继续恢复 */ }
      }
      if (!captured) {
        canvas.width = canvas.height = 0
        canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:auto'
      }
      const label = doc.createElement('div')
      label.setAttribute('role', 'status')
      label.style.cssText = 'position:relative;color:#fff;background:#111d;padding:16px;border-radius:14px;font:14px/1.6 -apple-system,sans-serif;text-align:center;pointer-events:none'
      label.innerHTML = '<span style="display:inline-block;animation:scrcpynas-recovery-pulse 1s ease-in-out infinite alternate">◌</span> 正在重新连接…<br>等待新画面稳定'
      const style = doc.createElement('style')
      style.textContent = '@keyframes scrcpynas-recovery-pulse{from{opacity:.35;transform:rotate(0deg)}to{opacity:1;transform:rotate(180deg)}}'
      const exit = doc.createElement('button')
      exit.type = 'button'
      exit.textContent = '退出投屏'
      exit.style.cssText = 'position:absolute;right:12px;top:12px;pointer-events:auto;padding:10px;border:0;border-radius:10px;background:#202b3b;color:white'
      // 只退出浏览器投屏，不改变共享设备连接
      exit.onclick = () => {
        window.dispatchEvent(new Event('scrcpynas:disconnect'))
        clearCover()
        host.location.assign(new URL('../', window.location.href).href)
      }
      root.append(canvas, style, label, exit)
      doc.body.appendChild(root)
      const state = { root, canvas, owner, clear: clearCover, loaded: null, expiry: null }
      // 新文档不是原设备投屏时立即擦除，不依赖其脚本配合
      state.loaded = () => {
        try { if (frame.contentWindow.location.hash !== streamHash || frame.contentWindow.location.pathname !== streamPath) clearCover() } catch (_) { clearCover() }
      }
      if (frame) { frame[key] = state; frame.addEventListener('load', state.loaded) }
      else window[key] = state
      state.expiry = host.setTimeout(clearCover, 30000)
      host.addEventListener('pagehide', clearCover, { once: true })
    }

    // 新文档独立观察真实时间推进，旧 readyState 与网络字节不放行遮罩
    function sample() {
      const state = frame ? frame[key] : window[key]
      if (!state || state.owner === owner) return
      const picture = readProgress()
      const now = Date.now()
      const advancing = !stopped && !authDenied && picture.ready && picture.owner === videoSeen && picture.position > lastTime && document.visibilityState !== 'hidden' && now - lastSample <= 700
      if (!advancing) { progressSince = null; progressCount = 0 }
      else {
        if (progressSince === null) progressSince = now
        progressCount++
        if (progressCount >= 4 && now - progressSince >= 750) {
          clearCover()
          window.dispatchEvent(new Event('scrcpynas:video-restored'))
        }
      }
      videoSeen = picture.owner
      lastTime = picture.position
      lastSample = now
    }
    sampleTimer = setInterval(sample, 250)
    document.addEventListener('visibilitychange', () => {
      progressSince = null
      progressCount = 0
      // 健康连接切后台不创建冻结遮罩，只有真实重连才显示过渡画面
    })
    window.addEventListener('scrcpynas:recovering', () => { navigating = true; showCover() })
    // 终止后禁止后续后台事件重新抓取画面，鉴权拒绝不能被手动失败恢复解除
    function stopCover(event) {
      if (event.type === 'scrcpynas:auth-denied') authDenied = true
      stopped = true
      navigating = false
      clearCover()
    }
    window.addEventListener('scrcpynas:disconnect', stopCover)
    window.addEventListener('scrcpynas:auth-denied', stopCover)
    window.addEventListener('hashchange', stopCover)
    window.addEventListener('popstate', stopCover)
    window.addEventListener('scrcpynas:reconnect', () => { if (!authDenied) stopped = false })
    window.addEventListener('pagehide', () => { stopped = true; clearInterval(sampleTimer); if (!navigating) clearCover() }, { once: true })
  }

  const NativeSocket = window.WebSocket
  const storageKey = 'scrcpyNas.warm.' + (params.get('udid') || '')
  let token
  // 标签页内持久化随机令牌，禁止跨源使用，存储不可用时仅当前页面保温
  try { token = window.sessionStorage.getItem(storageKey) } catch (_) {}
  if (!/^[a-f0-9]{32}$/.test(token || '')) {
    const bytes = new Uint8Array(16)
    window.crypto.getRandomValues(bytes)
    token = Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('')
    try { window.sessionStorage.setItem(storageKey, token) } catch (_) {}
  }
  let timer = null
  let reloading = false
  let checking = false
  let returnProbe = null
  let disconnected = false
  let tracked = null
  let lastMessage = Date.now()
  let denied = false
  let manualStop = false
  let attempts = 0
  const retryKey = storageKey + '.retry'
  try { attempts = Math.max(0, Math.min(6, Number(window.sessionStorage.getItem(retryKey)) || 0)) } catch (_) {}
  // 解码冷恢复预算跨重载保留，只能由持续解码成功重新开放
  const decodeKey = storageKey + '.decodeRetry'
  let decodeFailed = false
  let decodeUsed = true
  try { decodeUsed = window.sessionStorage.getItem(decodeKey) !== null } catch (_) {}

  // 合并关闭与网络恢复事件，避免并发重载抢占同一连接
  function schedule() {
    if (document.visibilityState !== 'hidden' && tracked && Date.now() - lastMessage > 12000) disconnected = true
    if (timer !== null || manualStop || denied || reloading || checking || (decodeFailed && decodeUsed) || (!disconnected && !decodeFailed) || document.visibilityState === 'hidden' || window.navigator.onLine === false) return
    timer = setTimeout(recover, Math.min(30000, 750 * Math.pow(2, attempts)))
  }

  // 复查原认证边界后刷新投屏页，不访问设备准备或自动连接接口
  async function recover() {
    timer = null
    if (manualStop || denied || reloading || checking || document.visibilityState === 'hidden' || window.navigator.onLine === false) return
    checking = true
    try {
      const response = await fetch(new URL('../api/auth', window.location.href), { credentials: 'same-origin', cache: 'no-store', redirect: 'error' })
      if (response.status === 401 || response.status === 403) { denied = true; window.dispatchEvent(new Event('scrcpynas:auth-denied')); return }
      if (!response.ok) return
      if (!(await response.json()).ok) { denied = true; window.dispatchEvent(new Event('scrcpynas:auth-denied')); return }
      if (manualStop || document.visibilityState === 'hidden' || window.navigator.onLine === false) return
      if (decodeFailed) {
        if (decodeUsed) return
        // 先持久化预算再清令牌，存储不可用时留给手动按钮而非循环刷新
        decodeUsed = true
        window.sessionStorage.setItem(decodeKey, '1')
        window.sessionStorage.removeItem(storageKey)
      }
      reloading = true
      window.dispatchEvent(new Event('scrcpynas:recovering'))
      try { window.sessionStorage.setItem(retryKey, String(Math.min(6, attempts + 1))) } catch (_) {}
      window.location.reload()
    } catch (_) {
      // 网络故障或登录重定向不会放开原有认证边界
    } finally {
      checking = false
      attempts++
      schedule()
    }
  }

  // 只观察同源的 Android 投屏连接，其他原生 WebSocket 行为保持不变
  function ReconnectingSocket(address, protocols) {
    const url = new URL(address, window.location.href)
    const stream = url.host === new URL(window.location.href).host && ['ws:', 'wss:'].includes(url.protocol)
      && url.searchParams.get('action') === 'proxy-adb' && url.searchParams.get('remote') === 'tcp:8886'
    if (stream) url.searchParams.set('warmSession', token)
    const socket = protocols === undefined ? new NativeSocket(stream ? url.toString() : address) : new NativeSocket(stream ? url.toString() : address, protocols)
    if (stream) {
      tracked = socket
      socket.addEventListener('message', () => {
        if (tracked !== socket) return
        lastMessage = Date.now()
        disconnected = false
        if (!decodeFailed && timer !== null) { clearTimeout(timer); timer = null }
      })
      socket.addEventListener('close', () => {
        if (tracked !== socket) return
        disconnected = true
        schedule()
      })
    }
    return socket
  }
  Object.setPrototypeOf(ReconnectingSocket, NativeSocket)
  ReconnectingSocket.prototype = NativeSocket.prototype
  window.WebSocket = ReconnectingSocket
  // E3 与传输故障共用认证及退出保护，但只允许一次自动冷连接
  window.addEventListener('scrcpynas:decode-error', () => { decodeFailed = true; schedule() })
  // 流量不代表可播放，只有前台连续解码进展才能重置重试预算
  window.addEventListener('scrcpynas:decoded-stable', () => {
    if (manualStop || denied || reloading || decodeFailed || document.visibilityState === 'hidden') return
    attempts = 0
    try {
      window.sessionStorage.removeItem(decodeKey)
      window.sessionStorage.removeItem(retryKey)
      decodeUsed = false
    } catch (_) {}
  })
  // 手动断开期间暂停恢复；接口失败才恢复重试，认证拒绝不能因此被解除
  window.addEventListener('scrcpynas:disconnect', () => {
    manualStop = true
    if (timer !== null) { clearTimeout(timer); timer = null }
  })
  window.addEventListener('scrcpynas:reconnect', () => { manualStop = false; schedule() })
  window.addEventListener('online', schedule)
  window.addEventListener('pageshow', event => { if (event.persisted) disconnected = true; schedule() })
  window.addEventListener('focus', schedule)
  // 后台保持连接，回前台仅对真实断线或无流量连接执行恢复
  function onVisibility() {
    clearTimeout(returnProbe); returnProbe = null
    if (document.visibilityState === 'hidden') {
      if (timer !== null) { clearTimeout(timer); timer = null }
      return
    }
    const returnedAt = Date.now()
    schedule()
    // 系统可能保留 OPEN 外观但停止网络，给现有心跳一次恢复机会
    returnProbe = setTimeout(() => {
      if (tracked && lastMessage <= returnedAt) { disconnected = true; schedule() }
    }, 6000)
  }
  document.addEventListener('visibilitychange', onVisibility)
})()
