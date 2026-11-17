// Modified in the Mobile Remote derivative (2026): mobile UI, media transport or recovery changes; see MODIFICATIONS.md.
// 只在引擎投屏页面挂载控制层，不向输入接口传递文本或认证信息
;(function () {
  'use strict'

  // 投屏区域内取消浏览器默认滚动，不阻止引擎收到原始触摸序列
  function keepRemoteGesture(event) {
    const target = event.target
    if (!target || !target.closest || !target.closest('body.stream .video')) return
    if (event.cancelable) event.preventDefault()
  }
  document.addEventListener('touchstart', keepRemoteGesture, { passive: false, capture: true })
  document.addEventListener('touchmove', keepRemoteGesture, { passive: false, capture: true })

  // 等待引擎异步切换到投屏视图
  function mount() {
    if (!document.body.classList.contains('stream') || document.getElementById('mobile-controls')) return
    const controls = document.createElement('div')
    controls.id = 'mobile-controls'
    controls.innerHTML = `<button id="mobile-orb" type="button" aria-label="投屏控制" aria-controls="mobile-menu" aria-expanded="false"><span aria-hidden="true">—</span></button>
      <div id="mobile-menu-backdrop" hidden></div><div id="mobile-menu" role="group" aria-label="投屏操作" hidden>
        <button type="button" data-mobile-key="BACK">返回</button>
        <button type="button" data-mobile-key="HOME">主页</button>
        <button type="button" data-mobile-key="APP_SWITCH">多任务</button>
        <button type="button" data-mobile-action="scale" hidden>裁切铺满</button>
        <button type="button" data-mobile-action="fullscreen">沉浸全屏</button>
        <button type="button" data-mobile-action="disconnect" hidden>退出投屏</button>
        <button type="button" data-mobile-action="exit-fullscreen">退出全屏</button>
        <p id="mobile-status" role="status" aria-live="polite"></p>
      </div>`
    document.body.appendChild(controls)
    const orb = controls.querySelector('#mobile-orb')
    const menu = controls.querySelector('#mobile-menu')
    const latencyLabel = orb.querySelector('span')
    let latencySample = null, smoothedLatency = null, latencyExpiry = null
    let latencyActive = true
    // 仅消费既有 RTC 统计，不发请求，不改变悬浮球的唤醒或手势状态
    function clearLatency() {
      clearTimeout(latencyExpiry)
      smoothedLatency = null
      latencyLabel.textContent = '—'
      orb.title = '网络往返延迟暂无数据'
      orb.setAttribute('aria-label', '投屏控制，网络延迟暂无数据')
    }
    function updateLatency() {
      const stats = window.scrcpyNasRtcStats
      if (!latencyActive || !stats || stats === latencySample) return
      latencySample = stats
      if (stats.path === 'connecting' || typeof stats.rtt !== 'number' || !Number.isFinite(stats.rtt) || stats.rtt < 0) { clearLatency(); return }
      smoothedLatency = smoothedLatency === null ? stats.rtt : smoothedLatency * 0.6 + stats.rtt * 0.4
      const value = Math.round(smoothedLatency)
      latencyLabel.textContent = stats.rtt > 99 ? '99+' : String(Math.min(99, value))
      orb.title = '网络往返延迟 ' + Math.round(stats.rtt) + ' ms'
      orb.setAttribute('aria-label', '投屏控制，' + orb.title)
      clearTimeout(latencyExpiry)
      latencyExpiry = setTimeout(clearLatency, 8000)
    }
    // 失联时清空旧数字，新的连接统计到来后再显示
    function stopLatency() { latencyActive = false; clearLatency() }
    window.addEventListener('scrcpynas:quality-state', updateLatency)
    window.addEventListener('scrcpynas:rtc-connected', () => { latencyActive = true })
    for (const name of ['scrcpynas:recovering', 'scrcpynas:disconnect', 'scrcpynas:auth-denied', 'pagehide']) window.addEventListener(name, stopLatency)
    clearLatency()
    updateLatency()

    // 仅识别画面外侧黑边起始的单指手势，不改动真实画面内的引擎触摸
    let marginSwipe = null
    document.addEventListener('pointerdown', event => {
      marginSwipe = null
      if (event.isPrimary === false || !['touch', 'pen'].includes(event.pointerType)) return
      const host = event.target.closest && event.target.closest('body.stream .video')
      const picture = host && host.querySelector('.video-layer')
      if (!picture) return
      const bounds = picture.getBoundingClientRect()
      if (bounds.width <= 0 || event.clientY < bounds.top || event.clientY > bounds.bottom) return
      const direction = event.clientX >= bounds.right ? -1 : event.clientX < bounds.left ? 1 : 0
      if (!direction) return
      marginSwipe = { id: event.pointerId, x: event.clientX, y: event.clientY, direction, began: Date.now() }
      // 捕获只用于黑边起始的指针，确保滑进画面后仍收到结束事件
      try { host.setPointerCapture(event.pointerId) } catch (_) { /* 合成事件不持有活动指针 */ }
    }, true)
    document.addEventListener('pointercancel', () => { marginSwipe = null }, true)
    document.addEventListener('pointerup', event => {
      const swipe = marginSwipe
      marginSwipe = null
      if (!swipe || swipe.id !== event.pointerId) return
      const inward = (event.clientX - swipe.x) * swipe.direction
      const vertical = Math.abs(event.clientY - swipe.y)
      if (Date.now() - swipe.began > 1200 || inward < 44 || vertical > inward * 0.65) return
      // 复用已有导航白名单与错误反馈，一次完成手势只提交一次返回
      menu.querySelector('[data-mobile-key="BACK"]').click()
    }, true)
    // 阻止控制层的指针事件泄露给引擎
    controls.addEventListener('pointerdown', event => event.stopPropagation())
    controls.addEventListener('pointerup', event => event.stopPropagation())
    // 位置只保存边缘方向与纵向比例，以适应横竖屏和安全区域
    let position = { side: 'right', y: 0.35 }
    try {
      const saved = JSON.parse(localStorage.getItem('scrcpyNas.mobile.orb'))
      if (saved && ['left', 'right'].includes(saved.side) && Number.isFinite(saved.y)) {
        position = { side: saved.side, y: Math.max(0, Math.min(1, saved.y)) }
      }
    } catch (_) { /* 存储被禁用或损坏时使用默认位置 */ }
    let drag = null
    let suppressClick = false
    let tapTimer = null
    let dimTimer
    // 读取控制层内边距，将系统安全区域纳入拖拽边界
    function bounds() {
      const style = getComputedStyle(controls)
      return {
        left: parseFloat(style.paddingLeft), top: parseFloat(style.paddingTop),
        right: controls.clientWidth - parseFloat(style.paddingRight) - orb.offsetWidth,
        bottom: controls.clientHeight - parseFloat(style.paddingBottom) - orb.offsetHeight
      }
    }
    // 将菜单与悬浮球限制在当前可见安全区域
    function place() {
      const area = bounds()
      const x = position.side === 'left' ? area.left : area.right
      const y = area.top + position.y * Math.max(0, area.bottom - area.top)
      orb.style.left = x + 'px'
      orb.style.top = y + 'px'
      const right = area.right + orb.offsetWidth, bottom = area.bottom + orb.offsetHeight
      menu.style.width = Math.min(340, right - area.left) + 'px'
      menu.style.maxHeight = Math.max(0, bottom - area.top) + 'px'
      menu.style.left = area.left + Math.max(0, (right - area.left - menu.offsetWidth) / 2) + 'px'
      menu.style.top = area.top + Math.max(0, (bottom - area.top - menu.offsetHeight) / 2) + 'px'

    }
    // 交互时恢复可见度，空闲后仅淡化可见圆点
    function wake() {
      clearTimeout(dimTimer)
      orb.classList.remove('is-dim')
      if (menu.hidden) dimTimer = setTimeout(() => orb.classList.add('is-dim'), 2200)
    }
    // 统一菜单显隐、无障碍状态与安全区位置
    function showMenu(open) {
      menu.hidden = !open
      controls.querySelector('#mobile-menu-backdrop').hidden = !open
      orb.setAttribute('aria-expanded', String(open))
      place()
      wake()
    }
    controls.querySelector('#mobile-menu-backdrop').addEventListener('click', () => showMenu(false))
    window.addEventListener('scrcpynas:close-menu', () => showMenu(false))
    // 捕获拖动指针，避免手指移出热区后丢失拖动
    orb.addEventListener('pointerdown', event => {
      if (event.button !== 0 || event.isPrimary === false) return
      const rect = orb.getBoundingClientRect()
      drag = { id: event.pointerId, x: event.clientX, y: event.clientY, left: rect.left, top: rect.top, moved: false }
      suppressClick = false
      orb.setPointerCapture(event.pointerId)
      wake()
    })
    // 拖动时只移动控制层，不修改设备触摸坐标
    orb.addEventListener('pointermove', event => {
      if (!drag || drag.id !== event.pointerId) return
      const dx = event.clientX - drag.x, dy = event.clientY - drag.y
      if (Math.hypot(dx, dy) > 6) drag.moved = true
      if (!drag.moved) return
      clearTimeout(tapTimer); tapTimer = null
      showMenu(false)
      const area = bounds(), rect = controls.getBoundingClientRect()
      orb.style.left = Math.max(area.left, Math.min(area.right, drag.left + dx - rect.left)) + 'px'
      orb.style.top = Math.max(area.top, Math.min(area.bottom, drag.top + dy - rect.top)) + 'px'
    })
    // 松手或取消时吸附最近边缘并保存相对位置
    function finishDrag(event) {
      if (!drag || drag.id !== event.pointerId) return
      suppressClick = drag.moved
      if (drag.moved) {
        const area = bounds()
        const x = parseFloat(orb.style.left), y = parseFloat(orb.style.top)
        position.side = x < (area.left + area.right) / 2 ? 'left' : 'right'
        position.y = (y - area.top) / Math.max(1, area.bottom - area.top)
        try { localStorage.setItem('scrcpyNas.mobile.orb', JSON.stringify(position)) } catch (_) { /* 保留本次会话位置 */ }
      }
      drag = null
      place()
      wake()
    }
    orb.addEventListener('pointerup', finishDrag)
    orb.addEventListener('pointercancel', finishDrag)
    // 单击延迟展开，双击只切换全屏；拖动兼容点击不触发快捷操作
    orb.addEventListener('click', () => {
      if (suppressClick) { suppressClick = false; return }
      if (tapTimer !== null) {
        clearTimeout(tapTimer); tapTimer = null
        changeFullscreen(!(hostDocument.fullscreenElement || document.body.classList.contains('mobile-immersive')))
      } else tapTimer = setTimeout(() => { tapTimer = null; showMenu(menu.hidden) }, 260)
    })
    orb.addEventListener('dblclick', event => event.preventDefault())
    window.addEventListener('pagehide', () => clearTimeout(tapTimer), { once: true })
    // 点击画面只关闭菜单，不截获设备操作
    document.addEventListener('pointerdown', event => {
      if (!controls.contains(event.target)) { clearTimeout(tapTimer); tapTimer = null; showMenu(false) }
    }, true)
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && !menu.hidden) { showMenu(false); orb.focus() }
    })
    window.addEventListener('resize', place)
    if (window.visualViewport) window.visualViewport.addEventListener('resize', place)
    place()
    wake()
    // 持久化缩放选择，由原有引擎适配循环统一更新图层
    const scaleButton = controls.querySelector('[data-mobile-action="scale"]')
    try {
      scaleButton.textContent = localStorage.getItem('scrcpyNas.mobile.scale') === 'cover' ? '完整画面' : '裁切铺满'
    } catch (_) { /* 存储不可用时沿用完整画面 */ }
    scaleButton.addEventListener('click', event => {
      let mode = 'cover'
      try {
        mode = localStorage.getItem('scrcpyNas.mobile.scale') === 'cover' ? 'contain' : 'cover'
        localStorage.setItem('scrcpyNas.mobile.scale', mode)
      } catch (_) { /* 隐私模式下保留默认完整画面 */ }
      event.target.textContent = mode === 'cover' ? '完整画面' : '裁切铺满'
      window.dispatchEvent(new Event('scrcpynas:scale'))
    })
    // 同源内嵌投屏必须同时展开外层容器，单改 iframe 内部无法覆盖管理栏
    const fullscreen = controls.querySelector('[data-mobile-action="fullscreen"]')
    let hostDocument = document
    try {
      if (window.frameElement && window.frameElement.id === 'mirrorFrame' && window.parent.document.querySelector('.app-shell')) hostDocument = window.parent.document
    } catch (_) { /* 非本站嵌入时不访问外层文档 */ }
    // 常亮只申请控制端文档的原生锁，不触碰被控安卓的电源设置
    const wakeStatus = document.createElement('p')
    wakeStatus.id = 'mobile-wake-status'
    menu.appendChild(wakeStatus)
    let screenLock = null
    // 代次隔离已失效的异步请求，待决标记合并重复同步
    let wakeGeneration = 0
    let wakePending = false
    let wakeAttempted = false
    let wakeStopped = false
    // 只允许前台有效投屏的沉浸状态持有常亮锁
    function wantsScreenLock() {
      return !wakeStopped && document.body.classList.contains('stream') && document.body.classList.contains('mobile-immersive')
        && document.visibilityState === 'visible' && hostDocument.visibilityState === 'visible'
    }
    // 退出时先清除引用，避免释放回调影响后续锁
    function releaseScreenLock() {
      wakeGeneration++
      wakePending = false
      wakeAttempted = false
      const lock = screenLock
      screenLock = null
      if (lock) Promise.resolve(lock.release()).catch(() => {})
    }
    // CSS 沉浸与原生全屏共用控制端屏幕常亮生命周期
    function syncScreenLock() {
      if (!wantsScreenLock()) {
        releaseScreenLock()
        wakeStatus.textContent = ''
        return
      }
      const api = hostDocument.defaultView.navigator.wakeLock
      if (!api || typeof api.request !== 'function') {
        wakeStatus.textContent = '当前浏览器不支持屏幕常亮'
        return
      }
      if (screenLock || wakePending || wakeAttempted) return
      const generation = wakeGeneration
      wakePending = true
      wakeAttempted = true
      Promise.resolve().then(() => api.request('screen')).then(lock => {
        if (generation !== wakeGeneration || !wantsScreenLock()) {
          Promise.resolve(lock.release()).catch(() => {})
          return
        }
        wakePending = false
        screenLock = lock
        // 系统撤销只更新当前锁，不重试也不让旧锁回调覆盖新会话
        lock.addEventListener('release', () => {
          if (screenLock !== lock) return
          screenLock = null
          wakeStatus.textContent = wantsScreenLock() ? '系统已释放常亮，当前不能保证屏幕常亮' : ''
        }, { once: true })
        wakeStatus.textContent = lock.released ? '系统已释放常亮，当前不能保证屏幕常亮' : '控制端屏幕常亮已开启'
      }).catch(() => {
        if (generation !== wakeGeneration) return
        wakePending = false
        wakeStatus.textContent = '常亮未开启：低电量模式或系统限制可能阻止常亮'
      })
    }
    // 隐藏暂停而不改变沉浸意愿，恢复前台时只同步一次
    document.addEventListener('visibilitychange', syncScreenLock)
    if (hostDocument !== document) hostDocument.addEventListener('visibilitychange', syncScreenLock)
    // 页面离开永久停止旧文档拿锁，不让迟到请求或前台事件复活
    function stopScreenWake() {
      wakeStopped = true
      releaseScreenLock()
      wakeStatus.textContent = ''
      document.removeEventListener('visibilitychange', syncScreenLock)
      hostDocument.removeEventListener('visibilitychange', syncScreenLock)
      for (const target of new Set([window, hostDocument.defaultView])) {
        for (const type of ['pagehide', 'popstate', 'hashchange', 'scrcpynas:disconnect']) target.removeEventListener(type, stopScreenWake)
      }
      streamExitObserver.disconnect()
    }
    window.addEventListener('pagehide', stopScreenWake, { once: true })
    window.addEventListener('popstate', stopScreenWake, { once: true })
    window.addEventListener('hashchange', stopScreenWake, { once: true })
    window.addEventListener('scrcpynas:disconnect', stopScreenWake, { once: true })
    if (hostDocument !== document) {
      hostDocument.defaultView.addEventListener('pagehide', stopScreenWake, { once: true })
      hostDocument.defaultView.addEventListener('popstate', stopScreenWake, { once: true })
      hostDocument.defaultView.addEventListener('hashchange', stopScreenWake, { once: true })
    }
    // 引擎离开投屏视图时立即回收，不依赖下一次导航
    const streamExitObserver = new MutationObserver(() => {
      if (!document.body.classList.contains('stream')) stopScreenWake()
    })
    streamExitObserver.observe(document.body, { attributes: true, attributeFilter: ['class'] })
    const immersiveKey = 'scrcpyNas.mobile.immersive.' + (new URLSearchParams(location.hash.replace(/^#!/, '')).get('udid') || '')
    // 同步外层布局与内层按钮，重载恢复 CSS 沉浸但不擅自请求原生全屏
    function setImmersive(enabled) {
      try { sessionStorage.setItem(immersiveKey, String(enabled)) } catch (_) { /* 浏览器禁用存储时仅当前页面有效 */ }
      document.body.classList.toggle('mobile-immersive', enabled)
      if (hostDocument !== document) hostDocument.body.classList.toggle('phone-immersive', enabled)
      fullscreen.setAttribute('aria-pressed', String(enabled))
      syncScreenLock()
      requestAnimationFrame(place)
    }
    try { if (sessionStorage.getItem(immersiveKey) === 'true') setImmersive(true) } catch (_) { /* 首次加载不改变当前布局 */ }
    // 安卓切入横屏时自动展开宿主页，手动退出后不在每帧重复强制进入
    window.addEventListener('scrcpynas:source-orientation', event => {
      if (event.detail.mobile && event.detail.landscape) setImmersive(true)
    })
    // 监听器挂载前已经收到横屏帧时补齐首次展开
    const initialVideo = document.querySelector('.video-layer')
    if (matchMedia('(pointer: coarse)').matches && initialVideo && (initialVideo.videoWidth || initialVideo.width) > (initialVideo.videoHeight || initialVideo.height)) setImmersive(true)
    // 菜单和双击共用全屏状态，原生全屏失败时仍可 CSS 展开
    async function changeFullscreen(enabled) {
      setImmersive(enabled)
      showMenu(false)
      try {
        if (enabled && !hostDocument.fullscreenElement && hostDocument.documentElement.requestFullscreen) await hostDocument.documentElement.requestFullscreen()
        else if (!enabled && hostDocument.fullscreenElement && hostDocument.exitFullscreen) await hostDocument.exitFullscreen()
      } catch (_) { /* 不支持原生全屏时保留 CSS 布局 */ }
    }
    fullscreen.addEventListener('click', () => changeFullscreen(true))
    controls.querySelector('[data-mobile-action="exit-fullscreen"]').addEventListener('click', () => changeFullscreen(false))
    // 原生全屏由系统退出时同时恢复两层布局
    function syncFullscreenExit() {
      if (!hostDocument.fullscreenElement && !document.fullscreenElement) setImmersive(false)
    }
    hostDocument.addEventListener('fullscreenchange', syncFullscreenExit)
    window.addEventListener('pagehide', () => {
      // 同地址 iframe 重载沿用沉浸意愿，实际换页或移除才恢复外层布局
      const frame = window.frameElement
      const reloadingImmersive = frame && frame.isConnected && document.body.classList.contains('mobile-immersive')
        && new URL(frame.getAttribute('src') || 'about:blank', hostDocument.location.href).href === location.href
      if (hostDocument !== document && !reloadingImmersive) hostDocument.body.classList.remove('phone-immersive')
      hostDocument.removeEventListener('fullscreenchange', syncFullscreenExit)
    }, { once: true })
    // 退出只关闭浏览器投屏，不执行 ADB disconnect；保留设备连接以便再次进入
    controls.querySelector('[data-mobile-action="disconnect"]').addEventListener('click', event => {
      event.target.disabled = true
      window.dispatchEvent(new Event('scrcpynas:disconnect'))
      hostDocument.defaultView.location.assign(new URL('../', location.href).href)
    })
    // 仅允许固定导航键，设备序列号从引擎路由读取
    menu.addEventListener('click', async event => {
      const key = event.target.dataset.mobileKey
      if (!['BACK', 'HOME', 'APP_SWITCH'].includes(key)) return
      const serial = new URLSearchParams(location.hash.replace(/^#!/, '')).get('udid')
      if (!serial) return
      try {
        const response = await fetch('../api/device/input', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ serial, type: 'key', key })
        })
        const result = await response.json()
        if (!response.ok || result.ok === false) throw new Error('操作失败，请重试')
        controls.querySelector('#mobile-status').textContent = ''
      } catch (_) {
        controls.querySelector('#mobile-status').textContent = '操作失败，请重试'
      }
    })
  }
  new MutationObserver(mount).observe(document.body, { attributes: true, childList: true, subtree: true })
  mount()
})()
