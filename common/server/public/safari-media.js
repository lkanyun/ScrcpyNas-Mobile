// Modified in the Mobile Remote derivative (2026): mobile UI, media transport or recovery changes; see MODIFICATIONS.md.
// 在旧引擎注册播放器前适配 iPhone 托管媒体接口与内联播放
;(function () {
  'use strict'
  if (new URLSearchParams(location.hash.replace(/^#!/, '')).get('action') !== 'stream') return
  const mime = 'video/mp4; codecs="avc1.42E01E"'
  // 同时检查构造器与编解码能力，避免覆盖已经可用的实现
  function supports(Type) {
    try { return typeof Type === 'function' && Type.isTypeSupported(mime) } catch (_) { return false }
  }
  const nativeSupported = supports(window.MediaSource)
  const managedSupported = supports(window.ManagedMediaSource)
  if (!nativeSupported && managedSupported) window.MediaSource = window.ManagedMediaSource
  window.scrcpyMediaBoot = { mode: nativeSupported ? 'mse' : managedSupported ? 'managed' : 'unsupported' }

  // 只在投屏文档内修饰新视频，必须先禁用远程播放再附加托管媒体源
  const createElement = document.createElement
  document.createElement = function (name, options) {
    const element = createElement.call(this, name, options)
    if (String(name).toLowerCase() === 'video') {
      element.playsInline = true
      element.disableRemotePlayback = true
      element.muted = true
      element.setAttribute('playsinline', '')
      element.setAttribute('webkit-playsinline', '')
      element.setAttribute('disableremoteplayback', '')
    }
    return element
  }

  // 启动诊断独立于引擎视图，播放器未能创建时也能给出反馈
  function installStatus() {
    // 只控制所属父页面的同代加载提示 不跨设备或跨来源清除状态
    const startupToken = new URLSearchParams(location.hash.replace(/^#!/, '')).get('scrcpyNasTs')
    function finishStartup() {
      try {
        if (window.frameElement?.id === 'mirrorFrame' && window.parent.document.querySelector('#mirrorFrame') === window.frameElement) window.parent.scrcpyNasStartupIndicator?.hide(startupToken)
      } catch (_) { /* 独立标签页不访问其他来源的父窗口 */ }
    }
    // 真实绘制事件立即隐藏动画 不等待诊断轮询
    window.addEventListener('scrcpynas:player-state', () => {
      if (window.scrcpyNasPlayerStatus?.reason === 'drawing') finishStartup()
    })
    const box = document.createElement('div')
    box.id = 'stream-start-status'
    box.setAttribute('role', 'status')
    box.style.cssText = 'position:fixed;z-index:2147483600;left:8%;right:8%;bottom:calc(20px + env(safe-area-inset-bottom,0px));padding:16px;border-radius:16px;background:#20242ff2;color:#fff;font:14px/1.6 -apple-system,sans-serif;box-shadow:0 8px 32px #0008'
    box.hidden = true
    const text = document.createElement('p')
    const play = document.createElement('button')
    play.textContent = '点此开始播放'
    play.hidden = true
    const retry = document.createElement('button')
    retry.textContent = '重新连接'
    ;[play, retry].forEach(button => { button.style.cssText = 'padding:10px 14px;margin:4px;border:0;border-radius:10px;background:#387af5;color:white;font:inherit' })
    // 解码错误不能盲目重用原温流，重建当前设备会话但不触碰 ADB 或其他标签页
    retry.onclick = () => {
      const video = document.querySelector('video.video-layer')
      if (video && video.error) {
        const serial = new URLSearchParams(location.hash.replace(/^#!/, '')).get('udid')
        try { sessionStorage.removeItem('scrcpyNas.warm.' + (serial || '')) } catch (_) { /* 存储不可用时仍允许重载 */ }
      }
      window.location.reload()
    }
    play.onclick = () => {
      const video = document.querySelector('video.video-layer')
      if (video) video.play().then(() => { box.hidden = true }).catch(() => show('播放仍被阻止，请再次点击播放或重新连接', true))
    }
    box.append(text, play, retry)
    document.body.appendChild(box)
    // 只展示固定错误说明，不回显异常中的地址或设备信息
    function show(message, allowPlay = false) {
      finishStartup()
      text.textContent = message + '（' + window.scrcpyMediaBoot.mode + '）'
      play.hidden = !allowPlay
      box.hidden = false
    }
    window.addEventListener('unhandledrejection', () => show('播放器启动失败，请重新连接；若仍失败请截图此提示'))
    window.addEventListener('error', () => show('播放器脚本加载失败，请刷新后重试'))
    if (window.scrcpyMediaBoot.mode === 'unsupported' && !window.scrcpyNasLowLatency?.capable) {
      show('当前浏览器不支持此视频接口，请升级 iPhone 系统与 Safari 后重试')
      return
    }
    const began = Date.now()
    let decodeReported = false
    // 连续前台解码进展用于重置恢复预算，后台与定时器长暂停都会打断观察
    let stableSince = null
    let lastSample = 0
    let lastVideo = null
    let lastTime = 0
    let lastProgress = 0
    let stableReported = false
    document.addEventListener('visibilitychange', () => { stableSince = null; lastSample = 0 })
    // 区分已解码、手势阻止和无视频数据，不用标签冒充播放成功
    const timer = setInterval(() => {
      if (window.scrcpyNasPlayerStatus?.mode === 'failed') {
        show('视频播放停止：' + (window.scrcpyNasVideoFailureText?.(window.scrcpyNasPlayerStatus.reason) || '解码失败') + '；请手动重新连接')
        return
      }
      const picture = window.scrcpyNasProgress?.read()
      // 画布只读真实绘制序号，保留原 MSE 的媒体错误与手势播放分支
      if (picture?.mode === 'webcodecs' || picture?.mode === 'webrtc') {
        if (picture.ready) finishStartup()
        const now = Date.now()
        const playable = picture.ready && picture.owner === lastVideo && picture.position >= lastTime
          && document.visibilityState !== 'hidden' && now - lastSample <= 1500
        const advancing = playable && picture.position > lastTime
        if (!playable || now - lastProgress > 2500) stableSince = null
        if (advancing) {
          lastProgress = now
          if (stableSince === null) stableSince = now
          if (!stableReported && now - stableSince >= 15000) {
            stableReported = true
            window.dispatchEvent(new Event('scrcpynas:decoded-stable'))
          }
        }
        lastVideo = picture.owner
        lastTime = picture.position
        lastSample = now
        // 已有画面的静态 WebRTC 会话由心跳判活 保留真正断流和解码失败提示
        const healthyIdle = picture.mode === 'webrtc' && window.scrcpyNasRtc?.healthyIdle?.() === true
        if (picture.ready && (now - lastProgress <= 2500 || healthyIdle)) box.hidden = true
        else if (now - began > 15000) show('播放器暂无新画面，请重新连接')
        return
      }
      const video = document.querySelector('video.video-layer')
      const now = Date.now()
      const playable = video && video === lastVideo && !video.error && !video.paused
        && video.videoWidth > 0 && video.readyState >= 2 && video.currentTime >= lastTime
        && document.visibilityState !== 'hidden' && now - lastSample <= 1500
      const advancing = playable && video.currentTime > lastTime
      if (!playable || now - lastProgress > 2500) stableSince = null
      if (advancing) {
        lastProgress = now
        if (stableSince === null) stableSince = now
        if (!stableReported && now - stableSince >= 15000) {
          stableReported = true
          window.dispatchEvent(new Event('scrcpynas:decoded-stable'))
        }
      }
      lastVideo = video
      lastTime = video ? video.currentTime : 0
      lastSample = now
      if (video && video.error) {
        show('视频解码失败，错误 E' + video.error.code + '，请重新连接')
        if (video.error.code === 3 && !decodeReported) {
          decodeReported = true
          window.dispatchEvent(new Event('scrcpynas:decode-error'))
        }
      } else if (video && video.videoWidth > 0 && video.readyState >= 2) {
        finishStartup()
        if (video.paused) show('视频已就绪，Safari 需要你点击开始播放', true)
        else box.hidden = true
      } else if (Date.now() - began > 15000) {
        show('尚未收到可播放画面，请重新连接；若仍失败请截图此提示')
      }
    }, 500)
    window.addEventListener('pagehide', () => clearInterval(timer), { once: true })
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', installStatus, { once: true })
  else installStatus()
})()
