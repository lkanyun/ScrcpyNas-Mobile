// Modified in the Mobile Remote derivative (2026): mobile UI, media transport or recovery changes; see MODIFICATIONS.md.
// 实时视频与控制复用已认证信令 媒体通过浏览器原生 WebRTC 接收
;(function () {
  'use strict'
  if (new URLSearchParams(location.hash.replace(/^#!/, '')).get('action') !== 'stream') return
  const NativeSocket = window.WebSocket
  let current = null
  // 只为同源固定投屏通道添加实时传输 不接管音频或其他 WebSocket
  function RtcSocket(address, protocols) {
    const url = new URL(address, location.href)
    const stream = url.host === location.host && url.searchParams.get('action') === 'proxy-adb' && url.searchParams.get('remote') === 'tcp:8886'
    if (!stream) return protocols === undefined ? new NativeSocket(address) : new NativeSocket(address, protocols)
    url.searchParams.set('rtc', '1')
    const socket = protocols === undefined ? new NativeSocket(url.href) : new NativeSocket(url.href, protocols)
    const send = socket.send.bind(socket)
    let statsTimer
    let lastFrames = 0, lastStatsTime = 0
    let previousInbound = null
    let stalledSamples = 0
    let lastReport = 0
    const state = { lastSignalAt: 0, idleDecodeFailures: 0, socket, pc: null, channel: null, media: null, video: null, closed: false }
    // 浏览器阶段相对本次文档导航开始 只在真实首帧时提交一次
    state.startup = { socketCreated: Math.round(performance.now()) }
    window.scrcpyNasStartup = state.startup
    socket.addEventListener('open', () => { state.startup.socketOpen = Math.round(performance.now()) })
    current = state
    // 断开或后台立即关闭媒体 UDP 不能继续接收旧页面画面
    state.close = () => { if (state.closed) return; state.closed = true; clearInterval(statsTimer); state.onClose?.(); state.pc?.close(); if (state.video) state.video.srcObject = null }
    socket.addEventListener('close', state.close)
    socket.addEventListener('message', async event => {
      if (typeof event.data !== 'string' || state.closed) return
      try {
        const message = JSON.parse(event.data)
        state.lastSignalAt = Date.now()
        if (message.rtc !== 'offer' || state.pc) return
        state.startup.offerReceived = Math.round(performance.now())
        const pc = state.pc = new RTCPeerConnection({ iceServers: message.iceServers, bundlePolicy: 'max-bundle' })
        pc.onicecandidate = event => { if (event.candidate && !state.closed && socket.readyState === 1) send(JSON.stringify({ rtc: 'ice', candidate: event.candidate.toJSON() })) }
        pc.ondatachannel = event => { if (event.channel.label === 'control') state.channel = event.channel }
        pc.ontrack = event => {
          state.media = new MediaStream([event.track])
          if (state.video) { state.video.srcObject = state.media; state.video.play().catch(() => {}) }
          // 实时远控偏向最小播放等待 浏览器不支持时沿用原生算法
          try { if ('jitterBufferTarget' in event.receiver) event.receiver.jitterBufferTarget = 0 } catch (_) {}
        }
        pc.onconnectionstatechange = () => {
          if (pc.connectionState === 'connected' && !state.closed) {
            if (state.startup.transportConnected == null) state.startup.transportConnected = Math.round(performance.now())
            window.dispatchEvent(new Event('scrcpynas:rtc-connected'))
          }
          if (pc.connectionState === 'failed' && !state.closed) socket.close(4001, '实时视频连接失败')
        }
        // 仅展示连接方式与解码统计 不读取或记录画面
        statsTimer = setInterval(async () => {
          if (state.closed) return
          if (document.hidden) { previousInbound = null; lastStatsTime = 0; stalledSamples = 0; return }
          try {
            const reports = [...(await pc.getStats()).values()]
            if (state.closed) return
            const transport = reports.find(value => value.type === 'transport' && value.selectedCandidatePairId)
            const pair = reports.find(value => value.id === transport?.selectedCandidatePairId) || reports.find(value => value.type === 'candidate-pair' && value.state === 'succeeded' && value.nominated)
            const candidates = reports.filter(value => value.id === pair?.localCandidateId || value.id === pair?.remoteCandidateId)
            const inbound = reports.find(value => value.type === 'inbound-rtp' && (value.kind === 'video' || value.mediaType === 'video'))
            const now = performance.now()
            const fps = lastStatsTime && inbound ? Math.max(0, Math.round((inbound.framesDecoded - lastFrames) * 1000 / (now - lastStatsTime))) : null
            const intervalMs = lastStatsTime ? now - lastStatsTime : 0
            lastFrames = inbound?.framesDecoded || 0
            lastStatsTime = now
            const rtt = pair?.currentRoundTripTime == null ? null : Math.round(pair.currentRoundTripTime * 1000)
            // 使用同一接收流的增量 避免重连计数归零或静止画面触发误降档
            const previous = previousInbound?.id === inbound?.id ? previousInbound : null
            const delta = key => previous && Number.isFinite(inbound?.[key]) && Number.isFinite(previous[key]) ? Math.max(0, inbound[key] - previous[key]) : null
            const packets = delta('packetsReceived'), lost = delta('packetsLost'), decoded = delta('framesDecoded'), dropped = delta('framesDropped')
            state.idleDecodeFailures = packets > 0 && decoded === 0 ? state.idleDecodeFailures + 1 : 0
            const decodeTime = delta('totalDecodeTime')
            // 实测码率按同一接收流的字节增量计算 不把目标码率当成实际用量
            const bytes = delta('bytesReceived')
            const bitrate = intervalMs > 0 && bytes != null ? Math.round(bytes * 8000 / intervalMs) : null
            const sample = {
              network: window.scrcpyNasAdaptiveQuality.networkPath(pair, candidates, pc.remoteDescription?.sdp),
              active: packets > 0,
              loss: packets > 0 && lost != null ? lost / (packets + lost) : null,
              drop: decoded + dropped > 0 && dropped != null && decoded != null ? dropped / (decoded + dropped) : null,
              decodeMs: decoded > 0 && decodeTime != null ? decodeTime * 1000 / decoded : null,
              jitterMs: inbound?.jitter == null ? null : inbound.jitter * 1000,
              available: pair?.availableIncomingBitrate > 0 ? pair.availableIncomingBitrate : null,
              rtt
            }
            // 诊断只回传路径与增量指标 不包含候选地址或媒体内容
            if (socket.readyState === 1 && now - lastReport >= 10000) {
              lastReport = now
              send(JSON.stringify({ rtc: 'stats', network: sample.network, rtt, loss: sample.loss, fps }))
            }
            previousInbound = inbound ? { ...inbound } : null
            // 能力声明通过后仍以真实解码为准 高清连续收包却不出图时在本页回退
            stalledSamples = state.quality?.snapshot().level >= 42 && state.quality.settings().maxSize > 960 && packets > 0 && decoded === 0 ? stalledSamples + 1 : 0
            if (stalledSamples >= 2) {
              state.quality.setLevel(31)
              try { sessionStorage.setItem('scrcpyNas.h264.compat.' + state.serial, '1') } catch (_) {}
              state.applyQuality?.()
              stalledSamples = 0
            }
            if (state.quality?.observe(sample, now)) state.applyQuality?.()
            window.scrcpyNasRtcStats = { path: pair ? candidates.some(value => value.candidateType === 'relay') ? 'relay' : 'direct' : 'connecting', fps, bitrate, rtt, loss: sample.loss, quality: state.quality?.snapshot() }
            window.dispatchEvent(new Event('scrcpynas:quality-state'))
            window.dispatchEvent(new Event('scrcpynas:player-state'))
          } catch (_) {}
        }, 2000)
        await pc.setRemoteDescription({ type: 'offer', sdp: message.sdp })
        let compatible = false
        try { compatible = sessionStorage.getItem('scrcpyNas.h264.compat.' + state.serial) === '1' } catch (_) {}
        await window.scrcpyNasAdaptiveQuality.setReceiveAnswer(pc, navigator.mediaCapabilities, { compatible })
        window.dispatchEvent(new Event('scrcpynas:rtc-connected'))
        if (!state.closed) { state.startup.answerSent = Math.round(performance.now()); send(JSON.stringify({ rtc: 'answer', sdp: pc.localDescription.sdp })) }
        state.quality?.setLevel(compatible ? 31 : window.scrcpyNasAdaptiveQuality.negotiatedLevel(pc.localDescription.sdp))
        state.applyQuality?.()
      } catch (_) { if (!state.closed) socket.close(4001, '实时视频协商失败') }
    })
    // 控制与大视频帧分离 屏幕电源仍经过原租约管理入口
    socket.send = data => {
      if (state.normalizeControl) data = state.normalizeControl(data)
      const bytes = ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : data instanceof ArrayBuffer ? new Uint8Array(data) : null
      if (bytes && bytes[0] !== 10 && bytes.length <= 65536 && state.channel?.readyState === 'open') {
        if (state.channel.bufferedAmount > 65536) { socket.close(4001, '控制通道拥塞'); return }
        state.channel.send(data)
      } else send(data)
    }
    return socket
  }
  Object.setPrototypeOf(RtcSocket, NativeSocket)
  RtcSocket.prototype = NativeSocket.prototype
  window.WebSocket = RtcSocket
  // 对外只报告真实协商和视频播放状态
  function status(reason) {
    window.scrcpyNasPlayerStatus = { mode: 'webrtc', reason, fallbackCount: 0 }
    window.dispatchEvent(new Event('scrcpynas:player-state'))
  }
  // 保留引擎触控与工具栏 只替换视频接收及显示对象
  function createPlayer(req, name, udid, displayInfo) {
    const player = new (req(8154).MsePlayer)(udid, displayInfo)
    const Base = req(9214).BasePlayer
    const video = document.createElement('video')
    video.className = 'video-layer'
    video.dataset.transport = 'webrtc'
    video.muted = true
    video.autoplay = true
    video.playsInline = true
    player.tag = video
    let stopped = false
    const stop = player.stop.bind(player)
    const getSettings = player.getVideoSettings.bind(player)
    let preference = {}
    try { preference = JSON.parse(localStorage.getItem('scrcpyNas.quality.' + udid) || '{}') || {} } catch (_) {}
    const quality = window.scrcpyNasAdaptiveQuality.createController(preference)
    // 自动参数不沿用旧的统一低码率偏好 手动参数仍受当前链路与解码能力约束
    function boundedSettings(settings) {
      const value = req(5598).default.copy(settings)
      const target = quality.settings()
      value.codecOptions = target.maxSize > (target.maxFps > 30 ? 960 : 1280) ? 'profile=1,level=8192' : 'profile=1,level=512'
      // 仅降低没有新画面时的重复编码频率 新内容仍立即送入编码器
      value.codecOptions += ',repeat-previous-frame-after:long=1000000'
      value.sendFrameMeta = false
      value.bitrate = target.bitrate
      value.maxFps = target.maxFps
      value.bounds = new (req(7407).default)(target.maxSize, target.maxSize)
      // 减少静态背景的周期性完整刷新 首次连接与丢包仍沿用主动关键帧请求
      value.iFrameInterval = 2
      return value
    }
    player.getVideoSettings = () => boundedSettings(getSettings())
    player.setVideoSettings = (settings, fit, save) => Base.prototype.setVideoSettings.call(player, boundedSettings(settings), false, save)
    player.needScreenInfoBeforePlay = () => false
    player.play = () => { if (!stopped) { Base.prototype.play.call(player); video.play().catch(() => {}) } }
    player.pause = () => Base.prototype.pause.call(player)
    player.pushFrame = () => {}
    player.bindLowLatencyClient = () => {}
    // 真实解码尺寸驱动原触控坐标计算 不从 CSS 猜手机分辨率
    function resize() {
      if (stopped || !video.videoWidth) return
      const Size = req(7407).default, Rect = req(9880).default, ScreenInfo = req(3422).default
      const info = new ScreenInfo(new Rect(0, 0, video.videoWidth, video.videoHeight), new Size(video.videoWidth, video.videoHeight), 0)
      player.emit('input-video-resize', info)
      Base.prototype.setScreenInfo.call(player, info)
      player.videoWidth = video.videoWidth
      player.videoHeight = video.videoHeight
    }
    video.addEventListener('resize', resize)
    video.addEventListener('playing', resize)
    const state = current
    if (state) {
      state.video = video
      state.serial = udid
      state.quality = quality
      // 复用既有认证控制通道提交编码参数 不重建浏览器媒体会话
      state.applyQuality = () => {
        if (stopped || state.closed || state.socket.readyState !== 1) return
        const settings = boundedSettings(getSettings())
        Base.prototype.setVideoSettings.call(player, settings, false, false)
        state.socket.send(req(4888).CommandControlMessage.createSetVideoSettingsCommand(settings).toBuffer())
        window.dispatchEvent(new Event('scrcpynas:quality-state'))
      }
      // 引擎加入已有流时可能直接复用旧配置 在发送边界统一应用实时编码约束
      state.normalizeControl = data => {
        const bytes = ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : data instanceof ArrayBuffer ? new Uint8Array(data) : null
        if (!bytes || bytes[0] !== 101 || bytes.length < 36) return data
        const settings = req(5598).default.fromBuffer(req(8287).Buffer.from(bytes.subarray(1)))
        return req(4888).CommandControlMessage.createSetVideoSettingsCommand(boundedSettings(settings)).toBuffer()
      }
      if (state.media) video.srcObject = state.media
    }
    const progress = window.scrcpyNasProgress.register(video, 'webrtc')
    let frameCallback
    let firstFrame = false
    if (state) state.onClose = () => progress.close()
    // 原生合成器报告真实视频帧后才放行恢复门禁 不用播放时钟冒充出图
    function presented() {
      if (stopped || state?.closed) return
      progress.output()
      progress.draw()
      if (!firstFrame) {
        firstFrame = true; status('drawing')
        if (state) {
          state.startup.firstFrame = Math.round(performance.now())
          if (state.socket.readyState === 1) state.socket.send(JSON.stringify({ rtc: 'startup', phases: state.startup }))
        }
      }
      frameCallback = video.requestVideoFrameCallback(presented)
    }
    if (typeof video.requestVideoFrameCallback === 'function') frameCallback = video.requestVideoFrameCallback(presented)
    status('waiting')
    // 页面终止同时回收媒体和控制通道 不能只停止显示
    player.stop = event => {
      if (event?.type === 'pagehide' && event.persisted) return
      if (stopped) return
      stopped = true
      progress.close()
      if (frameCallback != null) video.cancelVideoFrameCallback?.(frameCallback)
      state?.close()
      state?.socket.close()
      video.srcObject = null
      stop()
      if (player.qualityAnimationId) cancelAnimationFrame(player.qualityAnimationId)
      for (const event of events) window.removeEventListener(event, player.stop)
      document.removeEventListener('visibilitychange', visible)
    }
    // 标签页隐藏不终止播放器，系统暂停后恢复实际媒体播放
    function visible() { if (!document.hidden && !stopped) video.play().catch(() => {}) }
    const events = ['scrcpynas:recovering', 'scrcpynas:disconnect', 'scrcpynas:auth-denied', 'pagehide', 'hashchange', 'popstate']
    for (const event of events) window.addEventListener(event, player.stop)
    document.addEventListener('visibilitychange', visible)
    return player
  }
  // 设置页只在保存时更新模式 自动降档不会反写用户保存的偏好
  function setQualityPreference(preference) {
    if (!current?.quality || current.closed) return false
    current.quality.setPreference(preference)
    current.applyQuality?.()
    return true
  }
  // 静态画面依靠独立信令心跳和传输状态判活 不要求不断收到新视频帧
  function healthyIdle() {
    return !!current && !current.closed && current.socket.readyState === 1 && current.pc?.connectionState === 'connected'
      && Date.now() - current.lastSignalAt < 15000 && current.idleDecodeFailures < 2
      && !!current.video && !current.video.error && !current.video.paused
  }
  window.scrcpyNasRtc = { healthyIdle, createPlayer, setQualityPreference, getQuality: () => current?.quality?.snapshot() }
})()
