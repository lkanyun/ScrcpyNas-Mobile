// Modified in the Mobile Remote derivative (2026): mobile UI, media transport or recovery changes; see MODIFICATIONS.md.
// 独立系统音频遵循浏览器播放授权并记住设备偏好 不修改视频或采集麦克风
;(function () {
  'use strict'

  // 将固定格式采样分声道播放 并对实时队列设置严格上限
  function createPcmPlayer(context, outputDocument) {
    const gain = context.createGain()
    // 通过媒体元素输出解码声音，让系统使用媒体播放通道；不同时直连硬件以免重复出声
    const destination = outputDocument ? context.createMediaStreamDestination() : context.destination
    const media = outputDocument ? outputDocument.createElement('audio') : null
    if (media) {
      media.id = 'phone-audio-output'
      media.setAttribute('playsinline', '')
      media.setAttribute('aria-hidden', 'true')
      media.style.cssText = 'position:fixed;width:1px;height:1px;opacity:0;pointer-events:none'
      media.srcObject = destination.stream
      media.volume = 1
      media.muted = false
      outputDocument.body.append(media)
    }
    let nativeSource = null
    // 原生接收轨道经过既有增益与媒体输出 保留系统音量和播放授权
    function setMediaStream(stream) {
      nativeSource?.disconnect()
      nativeSource = stream ? context.createMediaStreamSource(stream) : null
      nativeSource?.connect(gain)
    }
    gain.connect(destination)
    // 播放授权必须与用户手势中的 AudioContext 恢复一起发起
    function resumeOutput() { return media ? media.play() : Promise.resolve() }
    // 最终媒体输出可能独立暂停 不能仅凭音频图运行判断正在播放
    function getOutputState() { return media ? { paused: media.paused, ended: media.ended, error: !!media.error } : null }
    // 关闭时完整回收媒体元素与输出轨道，保留队列清理函数用于正常丢弃过期声音
    function dispose() {
      stop()
      setMediaStream(null)
      gain.disconnect?.()
      analyser?.disconnect?.()
      if (media) {
        media.pause()
        media.srcObject = null
        media.remove()
        for (const track of destination.stream.getTracks()) track.stop()
      }
    }
    // 旁接只读电平计，不把浏览器音频图非零等同于硬件扬声器可听
    const analyser = context.createAnalyser?.()
    const outputSamples = analyser ? new Float32Array(analyser.fftSize) : null
    if (analyser) gain.connect(analyser)
    // 返回当前增益后的图输出峰值，用于区分采样输入与浏览器播放链
    function getOutputPeak() {
      if (!analyser) return null
      analyser.getFloatTimeDomainData(outputSamples)
      let peak = 0
      for (const sample of outputSamples) peak = Math.max(peak, Math.abs(sample))
      return Math.round(peak * 32768)
    }
    const sources = new Set()
    let nextTime = 0
    let tail = null
    let broken = false
    const stats = { underruns: 0, resets: 0 }
    // 平滑追赶时仅淡出正在播放的波形，关闭时立即释放全部音源
    function stop(smooth = false) {
      const now = context.currentTime
      for (const source of sources) {
        const active = smooth && source.audioStart <= now && source.audioEnd > now
        if (active) {
          const envelope = source.audioEnvelope.gain
          if (envelope.cancelAndHoldAtTime) envelope.cancelAndHoldAtTime(now)
          else { envelope.cancelScheduledValues(now); envelope.setValueAtTime(1, now) }
          envelope.linearRampToValueAtTime(0, now + 0.003)
        }
        try { source.stop(active ? now + 0.003 : now) } catch (_) { /* 已结束采样无需处理 */ }
        if (!active) { source.disconnect?.(); source.audioEnvelope.disconnect?.() }
      }
      sources.clear()
      nextTime = 0
      tail = null
      broken = false
    }
    // 压缩包丢弃或过期后让下一批采样经过平滑重接，不拼接不连续波形
    function discontinuity() { broken = true }
    // 诊断只暴露队列时长与恢复次数，不记录声音内容
    function getQueueStats() { return { ...stats, queuedMs: Math.max(0, Math.round((nextTime - context.currentTime) * 1000)) } }
    // 不依赖本机字节序 将交错立体声转换为浏览器浮点声道
    function push(bytes) {
      if (!(bytes instanceof ArrayBuffer) || !bytes.byteLength || bytes.byteLength % 4 || bytes.byteLength > 19200) return
      const view = new DataView(bytes)
      const frames = bytes.byteLength / 4
      const buffer = context.createBuffer(2, frames, 48000)
      for (let channel = 0; channel < 2; channel++) {
        const samples = buffer.getChannelData(channel)
        for (let frame = 0; frame < frames; frame++) samples[frame] = view.getInt16(frame * 4 + channel * 2, true) / 32768
      }
      schedule(buffer)
    }
    // 将解码后的平面浮点采样送入同一音量和有界播放队列
    function pushChannels(channels, sampleRate) {
      if (sampleRate !== 48000 || !channels.length || channels.length > 2 || !channels[0].length) return
      const buffer = context.createBuffer(channels.length, channels[0].length, sampleRate)
      channels.forEach((samples, channel) => buffer.getChannelData(channel).set(samples))
      schedule(buffer)
    }
    // 共享音源调度保持浏览器播放授权和音量生命周期一致
    function schedule(buffer) {
      const now = context.currentTime
      if (broken || nextTime - now > 0.12) { stats.resets++; stop(true) }
      const contiguous = nextTime > now + 0.003
      if (!contiguous && nextTime) stats.underruns++
      const time = contiguous ? nextTime : now + 0.04
      const fade = Math.min(0.003, buffer.duration / 2)
      // 后续帧及时到达时撤销前帧尾部淡出，正常连续播放不重复调制音量
      const joined = contiguous && tail && tail.audioEnd - 0.003 > now
      if (joined) {
        const boundary = Math.max(tail.audioStart, tail.audioEnd - 0.003)
        tail.audioEnvelope.gain.cancelScheduledValues(boundary)
        tail.audioEnvelope.gain.setValueAtTime(1, boundary)
      }
      const source = context.createBufferSource()
      const envelope = context.createGain()
      source.buffer = buffer
      source.audioStart = time
      source.audioEnd = time + buffer.duration
      source.audioEnvelope = envelope
      envelope.gain.setValueAtTime(joined ? 1 : 0, time)
      if (!joined) envelope.gain.linearRampToValueAtTime(1, time + fade)
      envelope.gain.setValueAtTime(1, time + buffer.duration - fade)
      envelope.gain.linearRampToValueAtTime(0, time + buffer.duration)
      source.connect(envelope)
      envelope.connect(gain)
      source.onended = () => { sources.delete(source); source.disconnect?.(); envelope.disconnect?.() }
      sources.add(source)
      source.start(time)
      nextTime = source.audioEnd
      tail = source
    }
    // 音量仅调整当前浏览器播放 不更改手机系统音量
    function setVolume(value) {
      if (!Number.isFinite(value) || value < 0 || value > 10) throw new Error('音量无效')
      gain.gain.value = value
    }
    return { push, pushChannels, setMediaStream, stop, dispose, resumeOutput, getOutputState, discontinuity, getQueueStats, setVolume, gain, getOutputPeak }
  }

  // 独立工作线程解码压缩音频 丢弃过期任务以免操作时积累延迟
  function createOpusPlayback(Decoder, format, player, onPeak, onError) {
    const decoder = new Decoder({ sampleRate: 48000, channels: format.channels, preSkip: format.preSkip })
    const queue = []
    let closed = false
    let busy = false
    let ready = false
    // 只在新解码器首次出声前追上已到达的包 不把初始化积压灌进播放队列
    let priming = true
    // 串行提交有界任务 不在工作线程消息队列中无限积压
    async function drain() {
      if (closed || busy || !ready) return
      busy = true
      try {
        while (!closed && queue.length) {
          const item = queue.shift()
          // 已排队的过期包仍解码以维持 Opus 状态，只丢弃迟到的播放样本
          if (item.gap) player.discontinuity?.()
          const decoded = await decoder.decodeFrame(item.bytes)
          if (closed) return
          if (decoded.errors?.length) throw new Error('Opus decode failed')
          if (performance.now() - item.time > 150) { player.discontinuity?.(); continue }
          if (priming && (queue.length || !decoded.channelData[0]?.length)) continue
          priming = false
          let peak = 0
          for (const channel of decoded.channelData) for (const sample of channel) peak = Math.max(peak, Math.abs(sample))
          onPeak(Math.round(peak * 32768))
          player.pushChannels(decoded.channelData, decoded.sampleRate)
        }
      } catch (error) { if (!closed) onError(error) } finally { busy = false }
    }
    decoder.ready.then(() => { ready = true; drain() }).catch(error => { if (!closed) onError(error) })
    // 严重拥塞保留有界新包，并标记缺口以平滑恢复播放
    function push(bytes) {
      if (closed || bytes.byteLength < 13 || bytes.byteLength > 8204) return
      const view = new DataView(bytes)
      if (view.getUint32(8) !== bytes.byteLength - 12 || (view.getUint8(0) & 128)) return onError(new Error('Invalid Opus packet'))
      if (queue.length >= 6) { queue.shift(); if (queue[0]) queue[0].gap = true }
      queue.push({ bytes: new Uint8Array(bytes, 12), time: performance.now() })
      drain()
    }
    // 停止后异步结果不能再触碰旧页面或旧播放上下文
    function stop() {
      if (closed) return
      closed = true
      queue.length = 0
      Promise.resolve(decoder.free()).catch(() => {})
    }
    return { push, stop }
  }

  // 音频独立协商 保留视频进程隔离且失败只回退这一条音频链路
  function createRtcAudioReceiver({ socket, player, onStats, onFallback, Peer = window.RTCPeerConnection }) {
    let pc = null, closed = false, polling = false
    let bytes = 0, timer = null, reportedAt = 0
    let previousAudio = null, damaged = 0
    const deadline = setTimeout(fallback, 12000)
    // 同一连接只回退一次 先拆掉原生音源以免两路重复播放
    function fallback() {
      if (closed) return
      close()
      if (socket.readyState === 1) socket.send(JSON.stringify({ rtc: 'audio-fallback' }))
      onFallback()
    }
    // 关闭不修改声音偏好 不停止共享采集器
    function close() {
      if (closed) return
      closed = true
      clearTimeout(deadline); clearInterval(timer)
      pc?.close()
      player.setMediaStream(null)
    }
    // 原生接收统计用于超时检测 不把连接成功当成已经收到音频
    async function poll() {
      if (closed || polling || !pc || document.hidden) return
      polling = true
      try {
        const reports = [...(await pc.getStats()).values()]
        if (closed) return
        const inbound = reports.find(value => value.type === 'inbound-rtp' && (value.kind === 'audio' || value.mediaType === 'audio'))
        const transport = reports.find(value => value.type === 'transport' && value.selectedCandidatePairId)
        const pair = reports.find(value => value.id === transport?.selectedCandidatePairId) || reports.find(value => value.type === 'candidate-pair' && value.nominated && value.state === 'succeeded')
        const candidates = reports.filter(value => value.id === pair?.localCandidateId || value.id === pair?.remoteCandidateId)
        // 连续异常补偿时恢复已验证的旧播放通道 防止有包但持续失真的假正常
        if (inbound && previousAudio?.id === inbound.id) {
          const samples = inbound.totalSamplesReceived - previousAudio.totalSamplesReceived
          const concealed = inbound.concealedSamples - previousAudio.concealedSamples
          damaged = samples > 0 && concealed >= 0 && concealed / samples > 0.1 ? damaged + 1 : 0
          if (damaged >= 3) return fallback()
        }
        previousAudio = inbound ? { ...inbound } : null
        const delta = Math.max(0, (inbound?.bytesReceived || 0) - bytes)
        bytes = inbound?.bytesReceived || bytes
        if (delta) clearTimeout(deadline)
        const path = window.scrcpyNasAdaptiveQuality?.networkPath(pair, candidates, pc.remoteDescription?.sdp) || 'unknown'
        const sample = { delta, bytes, path, concealed: inbound?.concealedSamples ?? null, jitterMs: inbound?.jitter == null ? null : Math.round(inbound.jitter * 1000) }
        onStats(sample)
        // 诊断沿既有信令限频发送 不记录媒体或候选地址
        if (socket.readyState === 1 && performance.now() - reportedAt >= 10000) {
          reportedAt = performance.now()
          socket.send(JSON.stringify({ rtc: 'audio-stats', ...sample }))
        }
      } catch (_) { /* 暂缺统计不打断正在播放的音频 */ } finally { polling = false }
    }
    // 有界 SDP 与 ICE 来自已经认证的同源音频信令
    async function receive(message) {
      if (closed) return
      if (message.rtc === 'audio-fallback') return fallback()
      if (message.rtc !== 'audio-offer' || pc) return
      try {
        pc = new Peer({ iceServers: message.iceServers, bundlePolicy: 'max-bundle' })
        pc.onicecandidate = event => { if (!closed && event.candidate && socket.readyState === 1) socket.send(JSON.stringify({ rtc: 'audio-ice', candidate: event.candidate.toJSON() })) }
        pc.ontrack = event => { if (!closed && event.track.kind === 'audio') player.setMediaStream(new MediaStream([event.track])) }
        pc.onconnectionstatechange = () => { if (pc.connectionState === 'failed') fallback() }
        await pc.setRemoteDescription({ type: 'offer', sdp: message.sdp })
        if (closed) return
        await pc.setLocalDescription(await pc.createAnswer())
        if (closed || socket.readyState !== 1) return
        socket.send(JSON.stringify({ rtc: 'audio-answer', sdp: pc.localDescription.sdp }))
        timer = setInterval(poll, 1000)
      } catch (_) { fallback() }
    }
    return { receive, close, fallback }
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = { createPcmPlayer, createOpusPlayback, createRtcAudioReceiver }
  if (typeof document === 'undefined') return
  if (location.pathname.startsWith('/share/')) { window.shareAudio = { createPcmPlayer, createOpusPlayback }; return }

  let disposed = false
  // 面板可以晚于脚本出现 仅挂载一次而不重复启动音频采集
  function mount() {
    const panel = document.querySelector('#media-panel')
    if (disposed || !panel || document.querySelector('#phone-audio-toggle')) return
    const status = panel.querySelector('#media-audio-status') || document.createElement('p')
    status.id = 'media-audio-status'
    status.setAttribute('role', 'status')
    status.setAttribute('aria-live', 'polite')
    const controls = document.createElement('div')
    controls.className = 'audio-settings-controls'
    controls.innerHTML = '<div class="settings-switch-row"><span>远程声音</span><button id="phone-audio-toggle" class="ios-switch" type="button" role="switch" aria-checked="false" aria-pressed="false">开启声音</button></div><label class="audio-volume-label" for="phone-audio-volume">网页播放音量 <output id="phone-audio-volume-value">100%</output><input id="phone-audio-volume" type="range" min="0" max="10" step="0.01" value="1"></label><div class="audio-volume-scale"><span>静音</span><span>增强 1000%</span></div><div class="audio-volume-presets"><button type="button" data-audio-volume="0.25">25%</button><button type="button" data-audio-volume="0.5">50%</button><button type="button" data-audio-volume="1">原声 100%</button></div><p class="settings-note">建议保持原声，用 iPhone 音量键调节。</p>'
    ;(panel.querySelector('#media-audio-controls') || panel).appendChild(controls)
    if (!status.isConnected) (panel.querySelector('#media-diagnostics') || panel).appendChild(status)
    const button = controls.querySelector('#phone-audio-toggle')
    const volume = controls.querySelector('#phone-audio-volume')
    let formatText = 'Opus · 48 kHz · 96 kbps（另计视频流量）'
    // 设备标识只用于本地偏好，不传给固定音频端点
    const serial = new URLSearchParams(location.hash.replace(/^#!/, '')).get('udid')
    const storageKey = serial ? 'scrcpyNas.audio.unity.' + serial : null
    let preference = { enabled: false, volume: 1 }
    try {
      const legacy = serial && JSON.parse(localStorage.getItem('scrcpyNas.audio.' + serial))
      if (legacy && typeof legacy.enabled === 'boolean') preference.enabled = legacy.enabled
    } catch (_) { /* 旧偏好损坏不影响新版设置 */ }
    try {
      const saved = storageKey && JSON.parse(localStorage.getItem(storageKey))
      if (saved && typeof saved.enabled === 'boolean' && typeof saved.volume === 'number' && Number.isFinite(saved.volume) && saved.volume >= 0 && saved.volume <= 10) preference = { enabled: saved.enabled, volume: saved.volume }
    } catch (_) { /* 存储不可用或损坏时保持安全默认 */ }
    volume.value = String(preference.volume)
    // 独立保存音频偏好，不依赖视频参数提交
    function savePreference() {
      try { if (storageKey) localStorage.setItem(storageKey, JSON.stringify(preference)) } catch (_) { /* 存储受限时仍允许本页播放 */ }
    }
    // 明确显示网页音量，不暗示可控制手机系统音量
    function showVolume() {
      const percent = Math.round(Number(volume.value) * 100)
      controls.querySelector('#phone-audio-volume-value').textContent = percent + '%'
      volume.setAttribute('aria-valuetext', percent + '%')
      volume.style.setProperty('--volume-fill', (Number(volume.value) / 10 * 100) + '%')
      for (const preset of controls.querySelectorAll('[data-audio-volume]')) preset.setAttribute('aria-pressed', String(Number(preset.dataset.audioVolume) === Number(volume.value)))
    }
    showVolume()
    // 仅识别本站稳定 iframe 宿主，上下文不随内层文档销毁
    let audioHost = window
    let audioFrame = null
    let recovering = false
    let stopped = false
    let authDenied = false
    try {
      if (window.frameElement?.id === 'mirrorFrame' && window.parent.document.querySelector('#mirrorFrame') === window.frameElement) {
        audioHost = window.parent
        audioFrame = window.frameElement
      }
    } catch (_) { /* 跨源嵌入保持当前文档播放 */ }
    // 内层 WebRTC 与外层 WebAudio 都声明媒体播放，避免仅设置宿主而遗漏投屏文档
    function requestPlayback(reset = false) {
      for (const host of new Set([window, audioHost])) {
        try {
          const session = host.navigator.audioSession
          if (!session) continue
          if (reset) session.type = 'auto'
          session.type = 'playback'
        } catch (_) { /* 浏览器未实现或拒绝会话请求时保留声音开关重试 */ }
      }
    }
    // 视频协商可能重建系统音频会话，连接完成后重新声明媒体用途
    function restorePlaybackRoute() {
      if (!disposed && preference.enabled) requestPlayback()
    }
    window.addEventListener('scrcpynas:rtc-connected', restorePlaybackRoute)
    const retained = audioFrame?.scrcpyNasAudio
    let context = retained?.serial === serial && retained.context.state !== 'closed' ? retained.context : null
    if (retained) audioHost.clearTimeout(retained.expiry)
    let player
    let opusPlayback
    let socket
    let rtcAudio = null, rtcStats = null, rtcFallback = false
    let generation = 0
    let enabled = false
    let outputResumeAttempted = false
    let watchdog
    let lastPacket = 0
    let received = false
    let inputPeak = 0
    let receivedBytes = 0
    let recoveryTimer
    let resumeTimer
    // 宿主只持有原生上下文，不保留旧文档 UI 或音频采集连接
    function rememberContext() {
      if (!audioFrame || audioFrame.scrcpyNasAudio?.context === context) return
      audioFrame.scrcpyNasAudio?.clear()
      const state = { context, serial, expiry: null, clear: null, loaded: null }
      // 精确释放当前宿主上下文，不影响其他投屏标签页
      state.clear = () => {
        audioHost.clearTimeout(state.expiry)
        audioHost.removeEventListener('pagehide', state.clear)
        audioFrame.removeEventListener('load', state.loaded)
        state.context.onstatechange = null
        if (state.context.state !== 'closed') state.context.close().catch(() => {})
        if (audioFrame.scrcpyNasAudio === state) delete audioFrame.scrcpyNasAudio
      }
      // 离开原设备或鉴权页时不保留播放授权资源
      state.loaded = () => {
        try {
          const url = new URL(audioFrame.contentWindow.location.href)
          const p = new URLSearchParams(url.hash.replace(/^#!/, ''))
          if (!url.pathname.includes('/scrcpy/') || p.get('action') !== 'stream' || p.get('udid') !== serial) state.clear()
        } catch (_) { state.clear() }
      }
      audioFrame.scrcpyNasAudio = state
      audioHost.addEventListener('pagehide', state.clear, { once: true })
      audioFrame.addEventListener('load', state.loaded)
    }
    // 提示独立于默认隐藏的设置面板，并不拦截远程画面触控
    const gestureHint = document.createElement('p')
    gestureHint.id = 'phone-audio-gesture'
    gestureHint.setAttribute('role', 'status')
    gestureHint.style.cssText = 'position:fixed;left:12px;right:12px;bottom:calc(24px + env(safe-area-inset-bottom,0px));z-index:10040;text-align:center;background:#111d;color:white;padding:10px;border-radius:8px;pointer-events:none'
    gestureHint.hidden = true
    document.body.appendChild(gestureHint)
    // 只在等待授权期间监听可信手势，不取消默认行为或事件传播
    function clearGesture() {
      clearTimeout(resumeTimer)
      resumeTimer = null
      gestureHint.hidden = true
      for (const name of ['pointerdown', 'touchstart', 'click']) document.removeEventListener(name, resumeGesture, true)
    }
    // 显示画面恢复入口，不要求用户重新打开设置
    function waitForGesture() {
      if (!preference.enabled || document.hidden) return
      gestureHint.textContent = '轻触画面恢复声音'
      gestureHint.hidden = false
      status.textContent = '轻触画面恢复声音 · ' + formatText
      for (const name of ['pointerdown', 'touchstart', 'click']) document.addEventListener(name, resumeGesture, { capture: true, passive: true })
    }
    // 可信输入在原调用栈恢复浏览器播放授权，开关本身仍只负责用户意愿
    function resumeGesture(event) {
      if (!event.isTrusted || button.contains(event.target)) return
      restoreAudio(true)
    }
    status.textContent = '声音未开启 · ' + formatText + '。仅系统音频，不采集麦克风；应用禁止采集时可能静音。'
    // 用户关闭或终止时销毁上下文，后台只暂停并保留已解锁授权
    function disable(message, preserveContext = false) {
      generation++
      clearTimeout(recoveryTimer)
      enabled = false
      clearGesture()
      clearInterval(watchdog)
      watchdog = null
      if (socket) { const previous = socket; socket = null; previous.onclose = previous.onerror = previous.onmessage = null; previous.close(preserveContext ? 1000 : 4000, preserveContext ? 'recover' : 'stop') }
      rtcAudio?.close(); rtcAudio = null; rtcStats = null
      opusPlayback?.stop()
      opusPlayback = null
      player?.dispose()
      player = null
      if (context) {
        context.onstatechange = null
        if (preserveContext && context.state !== 'closed') context.suspend().catch(() => {})
        else {
          const previous = context
          context = null
          previous.close().catch(() => {})
          if (audioFrame?.scrcpyNasAudio?.context === previous) audioFrame.scrcpyNasAudio.clear()
        }
      }
      button.textContent = preference.enabled ? '关闭声音' : '开启声音'
      button.setAttribute('aria-pressed', String(preference.enabled))
      button.setAttribute('aria-checked', String(preference.enabled))
      status.textContent = (message || '声音已关闭') + ' · ' + formatText
    }
    // 仅明确点击开关才改变用户意愿，内部暂停不覆盖偏好
    function toggle() {
      preference.enabled = !preference.enabled
      savePreference()
      if (!preference.enabled) { disable(); return }
      start()
    }
    // 在手势调用栈内恢复 WebAudio，也允许已获授权的前台恢复
    async function start(fromGesture = false) {
      if (disposed || stopped || authDenied || socket || (enabled && !fromGesture) || !preference.enabled || document.hidden) return
      if (audioFrame?.scrcpyNasRecovery || window.scrcpyNasRecovery) {
        status.textContent = '等待新视频稳定后恢复声音 · ' + formatText
        return
      }
      clearGesture()
      const Context = audioHost.AudioContext || audioHost.webkitAudioContext
      if (!Context) { status.textContent = '当前浏览器不支持 WebAudio 系统音频播放'; return }
      enabled = true
      const current = ++generation
      outputResumeAttempted = false
      button.textContent = '关闭声音'
      button.setAttribute('aria-pressed', 'true')
      button.setAttribute('aria-checked', 'true')
      status.textContent = '正在连接系统音频… · ' + formatText
      try {
        // 系统媒体使用播放会话，避免 iOS 将 WebAudio 当作受静音拨片控制的环境音
        requestPlayback(fromGesture)
        if (!context || context.state === 'closed') context = new Context({ latencyHint: 'interactive' })
        rememberContext()
        // resume 可能一直悬挂，先准备手势恢复且授权前绝不连接采集
        // 自动恢复立即监听首个触摸，手势重试期间合并同次触摸派生事件
        if (fromGesture) resumeTimer = setTimeout(waitForGesture, 500)
        else waitForGesture()
        const resume = context.resume()
        if (!player) player = createPcmPlayer(context, audioHost.document)
        player.setVolume(Number(volume.value))
        await Promise.all([resume, player.resumeOutput()])
        if (current !== generation) return
        requestPlayback()
        if (context.state !== 'running') { waitForGesture(); return }
        clearGesture()
        let formatted = false
        received = false
        inputPeak = receivedBytes = 0
        lastPacket = performance.now()
        const useRtc = !rtcFallback && typeof window.RTCPeerConnection === 'function'
        socket = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/phone-audio?sourceVolume=unity' + (useRtc ? '&rtc=1' : ''))
        if (useRtc) rtcAudio = createRtcAudioReceiver({ socket, player,
          onFallback: () => { rtcFallback = true; rtcAudio = null; rtcStats = null; lastPacket = performance.now(); player?.discontinuity() },
          onStats: value => {
            if (current !== generation) return
            rtcStats = value
            if (value.delta) { received = true; lastPacket = performance.now(); receivedBytes += value.delta }
          }
        })
        socket.binaryType = 'arraybuffer'
        // 不向后端发送设备标识或任意控制参数
        socket.onmessage = event => {
          if (current !== generation) return
          if (typeof event.data === 'string') {
            try {
              const data = JSON.parse(event.data)
              if (data.rtc) { rtcAudio?.receive(data); return }
              if (formatted || data.type !== 'format' || data.sampleRate !== 48000) throw new Error('format')
              if (data.codec === 'opus') {
                if (![1, 2].includes(data.channels) || data.bitrate !== 96000 || !Number.isInteger(data.preSkip) || data.preSkip < 0 || data.preSkip > 65535) throw new Error('format')
                const Decoder = window['opus-decoder']?.OpusDecoderWebWorker
                if (!Decoder) throw new Error('decoder')
                opusPlayback = createOpusPlayback(Decoder, data, player, peak => { inputPeak = Math.max(inputPeak, peak) }, () => { if (current === generation) disable('Opus 音频解码失败 请重新开启声音') })
                formatText = 'Opus · 48 kHz · ' + (data.channels === 2 ? '立体声' : '单声道') + ' · 96 kbps'
              } else if (data.codec === 'pcm-s16le' && data.channels === 2 && data.bitrate === 1536000) {
                formatText = 'PCM · 48 kHz · 立体声 · 1.536 Mbps'
              } else throw new Error('format')
              formatted = true
            } catch (error) { disable(error.message === 'decoder' ? '音频解码组件未加载 请刷新页面' : '音频格式不受支持') }
            return
          }
          if (!formatted || !(event.data instanceof ArrayBuffer)) return
          if (context?.state !== 'running') { player?.discontinuity(); return }
          lastPacket = performance.now()
          received = true
          receivedBytes += event.data.byteLength
          if (opusPlayback) { opusPlayback.push(event.data); return }
          const view = new DataView(event.data)
          for (let offset = 0; offset + 1 < view.byteLength; offset += 2) inputPeak = Math.max(inputPeak, Math.abs(view.getInt16(offset, true)))
          player.push(event.data)
        }
        socket.onerror = () => recoverAudio('音频连接中断，正在自动恢复')
        socket.onclose = () => recoverAudio('音频连接中断，正在自动恢复')
        // 系统挂起输出不等于关闭采集，回前台恢复同一上下文
        context.onstatechange = () => {
          if (current !== generation || context.state === 'running') return
          player?.stop(true)
          if (!document.hidden) waitForGesture()
        }
        watchdog = setInterval(() => {
          if (document.hidden || context?.state !== 'running') return
          if (performance.now() - lastPacket > (rtcAudio ? 15000 : 7000)) { if (rtcAudio) { rtcAudio.fallback(); return }; recoverAudio('音频流超时，正在自动恢复'); return }
          if (!received) return
          const output = player.getOutputState()
          if (output?.error) { recoverAudio('声音输出异常，正在恢复'); return }
          if (output?.paused || output?.ended) {
            if (!outputResumeAttempted) { outputResumeAttempted = true; restoreAudio() }
            else waitForGesture()
            return
          }
          outputResumeAttempted = false
          let sessionType = '默认（iPhone 静音模式可能无声）'
          try { if (audioHost.navigator.audioSession) sessionType = audioHost.navigator.audioSession.type } catch (_) { /* 诊断读取受限不影响音频 */ }
          if (rtcStats) {
            const route = { lan: '局域网直连', direct: '外网直连', wan: '腾讯云中转', unknown: '识别中' }[rtcStats.path]
            status.textContent = `WebRTC Opus · ${route} · 96 kbps · 接收 ${Math.round(receivedBytes / 1024)} KB · 抖动 ${rtcStats.jitterMs ?? '—'} ms · 丢包补偿 ${rtcStats.concealed ?? '—'} 采样 · 网页音量 ${Math.round(player.gain.gain.value * 100)}%`
            return
          }
          status.textContent = (inputPeak ? '已收到非零系统音频' : '已连接，当前采样静音（应用暂停或禁止采集）') + ' · 源峰值 ' + inputPeak + '/32768 · 图输出峰值 ' + player.getOutputPeak() + '/32768 · 播放器 ' + context.state + ' · 网页音量 ' + Math.round(player.gain.gain.value * 100) + '% · 接收 ' + Math.round(receivedBytes / 1024) + ' KB · 输出会话 ' + sessionType + '（不代表扬声器已出声） · ' + formatText
          inputPeak = 0
        }, 500)
      } catch (_) { if (current === generation) { clearGesture(); waitForGesture() } }
    }
    // 音量变化立即写入当前设备偏好并应用于网页增益
    function changeVolume() {
      preference.volume = Number(volume.value)
      savePreference()
      showVolume()
      player?.setVolume(preference.volume)
    }
    // 意外断线保留已解锁上下文，复核登录后有界重试
    function recoverAudio(message) {
      disable(message, true)
      if (disposed || stopped || authDenied || !preference.enabled || document.hidden) return
      recoveryTimer = setTimeout(async () => {
        try {
          const response = await fetch('../api/auth', { credentials: 'same-origin', cache: 'no-store' })
          if (response.status === 401 || response.status === 403) { window.dispatchEvent(new Event('scrcpynas:auth-denied')); return }
          if (response.ok) start()
          else recoverAudio(message)
        } catch (_) { recoverAudio(message) }
      }, 1200)
    }
    // 前台重用连接并清理过期输出，只在连接已失效时重新建立音频
    async function restoreAudio(fromGesture = false) {
      if (document.hidden || disposed || stopped || authDenied || !preference.enabled) return
      lastPacket = performance.now()
      if (context?.state === 'closed') disable('正在恢复音频输出', true)
      if (socket?.readyState === 1 && context && player) {
        player.discontinuity()
        clearGesture()
        resumeTimer = setTimeout(waitForGesture, 700)
        try { await Promise.all([context.resume(), player.resumeOutput()]); if (context?.state === 'running') clearGesture() } catch (_) { waitForGesture() }
        return
      }
      if (socket && socket.readyState > 1) disable('正在恢复系统音频', true)
      start(fromGesture)
    }
    // 隐藏时不主动关闭采集，桌面后台继续播放，手机由系统决定是否暂停输出
    function visibilityChanged() { if (!document.hidden) restoreAudio() }
    // 退出时撤销观察器及全部监听，晚到授权结果不能复活连接
    function pageHidden(event) {
      if (event?.persisted) return
      disposed = true
      observer.disconnect()
      disable(undefined, recovering && !!audioFrame)
      if (recovering && audioFrame?.scrcpyNasAudio) {
        const state = audioFrame.scrcpyNasAudio
        state.expiry = audioHost.setTimeout(state.clear, 30000)
      }
      button.removeEventListener('click', toggle)
      volume.removeEventListener('input', changeVolume)
      document.removeEventListener('visibilitychange', visibilityChanged)
      window.removeEventListener('pagehide', pageHidden)
      window.removeEventListener('pageshow', visibilityChanged)
      window.removeEventListener('scrcpynas:rtc-connected', restorePlaybackRoute)
      window.removeEventListener('scrcpynas:recovering', reconnecting)
      window.removeEventListener('scrcpynas:video-restored', videoRestored)
      window.removeEventListener('scrcpynas:disconnect', stopRecovery)
      window.removeEventListener('scrcpynas:auth-denied', stopRecovery)
      window.removeEventListener('scrcpynas:reconnect', allowRecovery)
    }
    // 明确退出或认证拒绝立即停采，后续生命周期事件不能复活声音
    function stopRecovery(event) {
      if (event.type === 'scrcpynas:auth-denied') authDenied = true
      stopped = true
      recovering = false
      disable(authDenied ? '登录已失效，采集已停止' : '投屏已退出，采集已停止')
    }
    // 只有手动退出失败才允许恢复，认证拒绝保持终止状态
    function allowRecovery() { stopped = false; start() }
    window.addEventListener('scrcpynas:disconnect', stopRecovery)
    window.addEventListener('scrcpynas:auth-denied', stopRecovery)
    window.addEventListener('scrcpynas:reconnect', allowRecovery)
    // 视频过渡结束后独立尝试恢复，音频授权失败不会重新遮挡画面
    function videoRestored() { start() }
    window.addEventListener('scrcpynas:video-restored', videoRestored)
    // 只有通过原恢复鉴权的重载允许借用宿主上下文
    function reconnecting() { recovering = true }
    window.addEventListener('scrcpynas:recovering', reconnecting)
    // 用户手势下丢弃旧音频上下文，重新激活媒体会话；网页不能读取实际硬件路由
    const repair = document.createElement('button')
    repair.type = 'button'
    repair.textContent = '恢复媒体外放'
    repair.id = 'phone-audio-route-repair'
    ;(panel.querySelector('#media-diagnostics') || controls).append(repair)
    repair.addEventListener('click', () => {
      if (disposed) return
      preference.enabled = true
      savePreference()
      disable('正在重新激活媒体播放…')
      requestPlayback(true)
      start(true)
    })
    button.addEventListener('click', toggle)
    volume.addEventListener('input', changeVolume)
    controls.querySelector('.settings-switch-row').addEventListener('click', event => { if (!button.contains(event.target)) button.click() })
    // 常用音量直接复用实时增益和偏好保存路径
    for (const preset of controls.querySelectorAll('[data-audio-volume]')) preset.addEventListener('click', () => { volume.value = preset.dataset.audioVolume; changeVolume() })
    window.addEventListener('pagehide', pageHidden)
    window.addEventListener('pageshow', visibilityChanged)
    document.addEventListener('visibilitychange', visibilityChanged)
    button.textContent = preference.enabled ? '关闭声音' : '开启声音'
    button.setAttribute('aria-pressed', String(preference.enabled))
    button.setAttribute('aria-checked', String(preference.enabled))
    start()
  }
  const observer = new MutationObserver(mount)
  observer.observe(document.body, { childList: true, subtree: true })
  mount()
})()
