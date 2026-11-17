// Modified in the Mobile Remote derivative (2026): mobile UI, media transport or recovery changes; see MODIFICATIONS.md.
// 只通过引擎原生屏幕电源控件关闭安卓物理面板，不改网页画面或控制端常亮策略
;(function () {
  'use strict'
  const params = new URLSearchParams(window.location.hash.replace(/^#!/, ''))
  const serial = params.get('udid')
  if (params.get('action') !== 'stream' || !serial) return
  // 页面租约与标签页温令牌分离，旧页面的迟到退出不能覆盖重连
  const bytes = new Uint8Array(16)
  window.crypto.getRandomValues(bytes)
  const lease = Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('')
  const storageKey = 'scrcpyNas.screenOff.' + serial
  const NativeSocket = window.WebSocket
  let enabled = true
  let tracked = null
  let token = ''
  let ready = false
  let received = false
  let stopped = false
  let recovering = false
  let releaseStarted = false
  let applied = null
  let status = '等待投屏画面就绪后关闭安卓物理屏幕'
  try { enabled = localStorage.getItem(storageKey) !== 'false' } catch (_) { /* 存储不可用仍默认关闭物理屏幕 */ }

  // 同步独立设置字段，不暴露原生 More 内的剪贴板或文本命令
  function mount() {
    const panel = document.querySelector('#media-panel')
    if (!panel) return
    let checkbox = panel.querySelector('#media-screen-off')
    if (!checkbox) {
      const label = document.createElement('label')
      label.className = 'settings-switch-row'
      label.innerHTML = '安卓息屏<input id="media-screen-off" type="checkbox">'
      checkbox = label.querySelector('input')
      checkbox.className = 'ios-switch'
      const feedback = document.createElement('p')
      feedback.id = 'media-screen-status'
      feedback.setAttribute('role', 'status')
      feedback.setAttribute('aria-live', 'polite')
      ;(panel.querySelector('#media-screen-controls') || panel).append(label)
      ;(panel.querySelector('#media-diagnostics') || panel).append(feedback)
      checkbox.addEventListener('change', () => {
        enabled = checkbox.checked
        let saved = true
        try { localStorage.setItem(storageKey, String(enabled)) } catch (_) { saved = false }
        apply()
        if (!saved) { status += '；浏览器禁止保存偏好'; mount() }
      })
    }
    checkbox.checked = enabled
    const feedback = panel.querySelector('#media-screen-status')
    if (feedback.textContent !== status) feedback.textContent = status
  }

  // 复用已审查的原生按钮，序列化器由代理精确修复为 OFF 与 NORMAL
  function apply() {
    if (stopped || !ready || !tracked || tracked.readyState !== NativeSocket.OPEN || document.visibilityState === 'hidden') {
      status = '偏好已记录；等待投屏画面就绪后应用'
      mount()
      return
    }
    const input = document.querySelector('.more-box input[id^="screen_power_mode_"]')
    const button = input && input.parentElement.querySelector('button')
    if (!input || !button) { status = '当前引擎屏幕电源控件尚未就绪，未执行'; mount(); return }
    if (applied === enabled) return
    input.checked = !enabled
    input.dispatchEvent(new Event('change', { bubbles: true }))
    button.click()
    applied = enabled
    status = enabled ? '已提交关闭物理面板；网页画面和触控不变' : '已提交恢复正常面板模式；其他控制者仍可保持黑屏'
    status += '（旧引擎不回报硬件执行结果）'
    mount()
  }

  // 仅观察当前同源同设备的既有投屏通道，不创建第二路采集
  function ScreenPowerSocket(address, protocols) {
    const url = new URL(address, window.location.href)
    const stream = url.host === window.location.host && ['ws:', 'wss:'].includes(url.protocol)
      && url.searchParams.get('action') === 'proxy-adb' && url.searchParams.get('remote') === 'tcp:8886' && url.searchParams.get('udid') === serial
    if (stream) url.searchParams.set('screenLease', lease)
    const socket = protocols === undefined ? new NativeSocket(stream ? url.toString() : address) : new NativeSocket(stream ? url.toString() : address, protocols)
    if (stream) {
      tracked = socket
      token = new URL(socket.url, window.location.href).searchParams.get('warmSession') || ''
      ready = received = false
      applied = null
      socket.addEventListener('message', () => { if (tracked === socket) received = true })
      socket.addEventListener('close', () => { if (tracked === socket) { ready = false; status = '投屏暂断；短暂后台保留屏幕偏好，温会话到期恢复'; mount() } })
    }
    return socket
  }
  Object.setPrototypeOf(ScreenPowerSocket, NativeSocket)
  ScreenPowerSocket.prototype = NativeSocket.prototype
  window.WebSocket = ScreenPowerSocket

  // 明确退出仅释放当前页面租约，后端通过仍存在的原通道恢复而不解锁手机
  function release() {
    stopped = true
    ready = false
    if (releaseStarted || !/^[a-f0-9]{32}$/.test(token)) return
    releaseStarted = true
    fetch(new URL('../api/screen-power/release', window.location.href), {
      method: 'POST', credentials: 'same-origin', keepalive: true, redirect: 'error',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ serial, token, lease })
    }).then(async response => {
      if (!response.ok) throw new Error('release unavailable')
      const result = await response.json()
      if (!result.ok) throw new Error('release unavailable')
      status = result.shared ? '已退出本页控制；其他控制者仍保持物理屏幕关闭' : '已提交退出恢复；保持原有锁屏状态'
      mount()
    }).catch(() => { status = '退出恢复未确认；原温会话到期将尝试恢复，请检查设备屏幕'; mount() })
  }

  // 媒体层出现真实解码进展后即可应用，不借用长期稳定事件充当首次就绪
  document.addEventListener('timeupdate', event => {
    const video = event.target
    if (stopped || !received || !tracked || tracked.readyState !== NativeSocket.OPEN || document.visibilityState === 'hidden') return
    if (video.dataset?.transport === 'webrtc') return
    if (!video.matches || !video.matches('video.video-layer') || video.paused || video.error || video.readyState < 2 || !video.videoWidth || video.currentTime <= 0) return
    ready = true
    apply()
  }, true)
  // 画布分支必须由真实原生输出后的 draw 事件放行，收到字节本身不算就绪
  window.addEventListener('scrcpynas:frame-drawn', () => {
    const picture = window.scrcpyNasProgress?.read()
    if (stopped || !received || !tracked || tracked.readyState !== NativeSocket.OPEN || document.visibilityState === 'hidden' || !picture?.ready || !['webcodecs', 'webrtc'].includes(picture.mode)) return
    ready = true
    apply()
  })
  window.addEventListener('scrcpynas:decoded-stable', () => {
    if (stopped || !received || !tracked || tracked.readyState !== NativeSocket.OPEN || document.visibilityState === 'hidden') return
    if (window.scrcpyNasProgress && !window.scrcpyNasProgress.read().ready) return
    ready = true
    apply()
  })
  window.addEventListener('scrcpynas:disconnect', release)
  window.addEventListener('scrcpynas:auth-denied', release)
  window.addEventListener('hashchange', release)
  window.addEventListener('popstate', release)
  window.addEventListener('scrcpynas:recovering', () => { recovering = true; ready = false })
  window.addEventListener('pagehide', event => { if (!recovering && !event.persisted) release() })
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') ready = false })
  new MutationObserver(mount).observe(document.documentElement, { childList: true, subtree: true })
  mount()
})()
