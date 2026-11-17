// Modified in the Mobile Remote derivative (2026): mobile UI, media transport or recovery changes; see MODIFICATIONS.md.
// 原生低延迟为唯一视频路径，保留设备画质与控制偏好
;(function () {
  'use strict'
  const params = new URLSearchParams(location.hash.replace(/^#!/, ''))
  if (params.get('action') !== 'stream') return
  const serial = params.get('udid') || ''
  // 原生低延迟是唯一视频路径，忽略旧版实验开关但保留其他设备偏好
  const capable = isSecureContext && typeof VideoDecoder === 'function' && typeof VideoDecoder.isConfigSupported === 'function' && typeof EncodedVideoChunk === 'function'

  // 对外显示真实播放状态，不将能力探测当作已出图
  function status(mode, reason = '') {
    window.scrcpyNasPlayerStatus = { mode, reason, fallbackCount: 0 }
    if (window.scrcpyMediaBoot) window.scrcpyMediaBoot.player = mode
    window.dispatchEvent(new Event('scrcpynas:player-state'))
  }
  // 固定失败分类便于现场定位，不回显浏览器异常中的地址或设备信息
  const reasons = {
    'webcodecs-unavailable': '浏览器不支持原生解码',
    'unsupported-config': '当前编码配置不受支持',
    'decoder-error': '原生解码器报错',
    'decode-submit-error': '图像提交失败',
    'no-first-frame': '首帧等待超时',
    'configuration-no-frame': '编码配置切换超时',
    'idr-timeout': '关键帧等待超时',
    'idr-budget-exhausted': '连续恢复未成功',
    'unsupported-or-malformed-annexb': '视频消息格式异常',
    'frame-metadata-unsupported': '视频协议参数不匹配',
    'decoder-not-loaded': '解码组件未加载'
  }
  window.scrcpyNasVideoFailureText = reason => reasons[reason] || '未知解码错误'
  status('webcodecs', 'waiting')
  window.scrcpyNasLowLatency = { capable, enabled: true, mount }

  // 设置面板只提供当前播放器状态，不再切换解码路径或重载页面
  function mount(panel) {
    if (panel.querySelector('#media-player-status')) return
    const section = document.createElement('section')
    section.innerHTML = '<p id="media-player-status" role="status"></p>'
    panel.appendChild(section)
    // 固定文案避免将内部异常或设备信息显示到界面
    function renderStatus() {
      const current = window.scrcpyNasPlayerStatus
      const reason = current.reason === 'webcodecs-unavailable' ? '此浏览器不支持，请使用支持原生视频解码的 Safari' : '请手动重新连接'
      const rtc = window.scrcpyNasRtcStats
      const rtcDetail = rtc ? ' · ' + (rtc.path === 'relay' ? '云中继' : rtc.path === 'direct' ? '直连' : '连接中') + (rtc.fps == null ? '' : ' · 实测 ' + rtc.fps + ' fps') + (rtc.bitrate == null ? '' : ' · ' + (rtc.bitrate / 1000000).toFixed(2) + ' Mbps') + (rtc.rtt == null ? '' : ' · 网络往返 ' + rtc.rtt + ' ms') : ''
      section.querySelector('#media-player-status').textContent = '实际播放器：' + (current.mode === 'webrtc' ? 'WebRTC 实时视频' + (current.reason === 'drawing' ? '（播放中）' : '（连接中）') + rtcDetail : current.mode === 'webcodecs' ? '低延迟 WebCodecs' + (current.reason === 'drawing' ? '（播放中）' : '（等待画面）') : current.mode === 'failed' ? '播放失败：' + window.scrcpyNasVideoFailureText(current.reason) + '，' + reason : '已停止')
    }
    window.addEventListener('scrcpynas:player-state', renderStatus)
    renderStatus()
  }

  // 复用原播放器的控制外壳和设置存储，视频只交原生解码画布
  window.scrcpyNasCreatePlayer = function (req, name, udid, displayInfo) {
    if (udid !== serial) return null
    if (window.scrcpyNasRtc) return window.scrcpyNasRtc.createPlayer(req, name, udid, displayInfo)
    const player = new (req(8154).MsePlayer)(udid, displayInfo)
    if (!window.scrcpyNasLowLatencyCore || !window.scrcpyNasProgress) {
      status('failed', 'decoder-not-loaded')
      throw Error('Native video decoder not loaded')
    }
    const Base = req(9214).BasePlayer
    const native = {}
    native.stop = player.stop.bind(player)
    const canvas = document.createElement('canvas')
    canvas.className = 'video-layer'
    player.tag = canvas
    const mode = 'webcodecs'
    let stopped = false
    let core = null
    let assembler = null
    let client = null
    let progress = window.scrcpyNasProgress.register(canvas, mode)
    let firstDraw = false
    status(mode, 'waiting')

    // 使用当前原生视频设置命令失效编码器，不创建新连接或改变设置
    function requestIDR() {
      if (!client || stopped) return
      client.sendMessage(req(4888).CommandControlMessage.createSetVideoSettingsCommand(player.getVideoSettings()))
    }
    // 工厂创建后绑定原客户端，不另建控制 WebSocket
    player.bindLowLatencyClient = value => { client = value }

    // 原生解码失败时停止同一会话并释放资源，不静默回退到高延迟播放器
    function failPlayback(reason) {
      if (stopped) return
      player.stop()
      status('failed', reason)
      window.dispatchEvent(new CustomEvent('scrcpynas:disconnect', { detail: { reason: 'playback-failed' } }))
    }

    // 原生输出尺寸驱动引擎既有触控事件，不引入 CSS 缩放变换
    function resize(width, height) {
      const Size = req(7407).default
      const Rect = req(9880).default
      const ScreenInfo = req(3422).default
      const info = new ScreenInfo(new Rect(0, 0, width, height), new Size(width, height), 0)
      player.emit('input-video-resize', info)
      Base.prototype.setScreenInfo.call(player, info)
      player.videoWidth = width
      player.videoHeight = height
    }

    // 首次直播字节才创建解码器，初始 UI pause 不销毁未启动的实例
    function startCore() {
      const { LowLatencyDecoder, LegacyAccessUnitAdapter } = window.scrcpyNasLowLatencyCore
      core = new LowLatencyDecoder({ canvas, onResize: resize, onIDR: requestIDR, onFallback: failPlayback,
        onOutput: () => progress.output(),
        onDraw: () => {
          if (!firstDraw) status(mode, 'drawing')
          firstDraw = true
          progress.draw()
        }
      })
      const resync = core.resync.bind(core)
      // 重同步也创建新的可观察身份，旧帧不能放行恢复门禁
      core.resync = (...args) => { progress.close(); progress = window.scrcpyNasProgress.register(canvas, mode); firstDraw = false; status(mode, 'recovering'); resync(...args) }
      assembler = new LegacyAccessUnitAdapter(au => { void core.accept(au) }, () => { if (!core.awaitingIDR) core.resync() })
      player.lowLatencyCore = core
    }
    // 画布固有尺寸由原生帧给出，不用服务端元数据冒充首次解码
    player.needScreenInfoBeforePlay = () => false
    // 沿用原播放器状态机，画布不创建 MSE 转换器
    player.play = () => { if (!stopped) Base.prototype.play.call(player) }
    // 初始化的暂停仅变更状态，真正后台退出由终止边界回收
    player.pause = () => Base.prototype.pause.call(player)
    // 沿用原设置存储和显式参数，避免更换解码路径时丢失画质偏好
    player.setVideoSettings = (settings, fit, save) => {
      Base.prototype.setVideoSettings.call(player, settings, false, save)
    }
    // 已审计旧 JAR 每条消息是一完整编码缓冲，配置消息不当作图像提交
    player.pushFrame = bytes => {
      if (stopped) return
      if (player.getVideoSettings().sendFrameMeta) { failPlayback('frame-metadata-unsupported'); return }
      if (!capable) { failPlayback('webcodecs-unavailable'); return }
      if (!core) startCore()
      try { assembler.push(bytes) } catch (_) { failPlayback('unsupported-or-malformed-annexb') }
    }
    // 释放解码和观察器，旧实例不能被前台事件重新启用
    player.stop = () => {
      if (stopped) return
      stopped = true
      core?.close()
      progress.close()
      assembler = null
      native.stop()
      status('stopped', 'lifecycle')
      if (player.qualityAnimationId) cancelAnimationFrame(player.qualityAnimationId)
      for (const name of terminalEvents) window.removeEventListener(name, player.stop)
      document.removeEventListener('visibilitychange', hidden)
    }
    // 后台先由既有过渡层复制真实画布，随后停止本地解码，恢复必须创建新文档
    function hidden() { if (document.visibilityState === 'hidden') player.stop() }
    const terminalEvents = ['scrcpynas:recovering', 'scrcpynas:disconnect', 'scrcpynas:auth-denied', 'pagehide', 'hashchange', 'popstate']
    for (const name of terminalEvents) window.addEventListener(name, player.stop)
    document.addEventListener('visibilitychange', hidden)
    return player
  }
})()
