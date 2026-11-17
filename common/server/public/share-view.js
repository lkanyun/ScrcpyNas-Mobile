// Modified in the Mobile Remote derivative (2026): mobile UI, media transport or recovery changes; see MODIFICATIONS.md.
;(async function () {
  'use strict'
  const token = location.hash.slice(1), status = document.querySelector('#status'), video = document.querySelector('video'), sound = document.querySelector('#sound')
  const endpoint = name => (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/share/' + name + '?token=' + encodeURIComponent(token)
  let ws, pc, audioSocket, context, player, playback, ended = false, timer, audioGeneration = 0
  // 停止解码与实际输出，失效页面不保留最后画面
  function stopAudio() { audioGeneration++; audioSocket?.close(); audioSocket = null; playback?.stop(); playback = null; player?.dispose(); player = null; context?.close(); context = null; sound.textContent = '开启声音' }
  function finish(message) { if (ended) return; ended = true; clearTimeout(timer); ws?.close(); pc?.close(); stopAudio(); video.srcObject = null; status.textContent = message; sound.disabled = true; document.querySelector('#retry').hidden = false }
  document.querySelector('#retry').onclick = () => location.reload()
  try {
    const response = await fetch('/share/info', { headers: { 'X-Share-Token': token }, cache: 'no-store' })
    if (!response.ok) throw new Error('分享已关闭或已过期')
    const info = await response.json()
    status.textContent = '正在连接画面…'
    timer = setTimeout(() => finish('分享已到期'), Math.max(0, info.expiresAt - Date.now()))
    ws = new WebSocket(endpoint('video'))
    ws.onmessage = async event => {
      try {
        const message = JSON.parse(event.data)
        if (message.rtc !== 'offer' || pc || ended) return
        pc = new RTCPeerConnection({ iceServers: message.iceServers, bundlePolicy: 'max-bundle' })
        pc.onicecandidate = event => { if (event.candidate && ws.readyState === 1) ws.send(JSON.stringify({ rtc: 'ice', candidate: event.candidate.toJSON() })) }
        pc.ontrack = event => { video.srcObject = new MediaStream([event.track]); video.play().catch(() => {}); sound.disabled = false; status.textContent = '仅观看 · 有效至 ' + new Date(info.expiresAt).toLocaleString() }
        pc.onconnectionstatechange = () => { if (pc.connectionState === 'failed') finish('连接中断，请重新连接') }
        await pc.setRemoteDescription({ type: 'offer', sdp: message.sdp })
        await pc.setLocalDescription(await pc.createAnswer())
        if (!ended) ws.send(JSON.stringify({ rtc: 'answer', sdp: pc.localDescription.sdp }))
      } catch (_) { finish('视频连接失败，请重新连接') }
    }
    ws.onclose = () => finish('分享已结束或连接中断')
    ws.onerror = () => finish('无法连接，请确认分享仍有效')
    // 音频复用已经验证的 Opus 解码与短队列，只在用户点击后打开
    sound.onclick = async () => {
      if (context) { stopAudio(); return }
      const generation = ++audioGeneration
      try {
        const Context = window.AudioContext || window.webkitAudioContext
        context = new Context({ sampleRate: 48000 })
        player = window.shareAudio.createPcmPlayer(context, document)
        await Promise.all([context.resume(), player.resumeOutput()])
        if (ended || generation !== audioGeneration) return
        audioSocket = new WebSocket(endpoint('audio')); audioSocket.binaryType = 'arraybuffer'
        audioSocket.onmessage = event => {
          if (typeof event.data === 'string') {
            const format = JSON.parse(event.data)
            if (format.codec !== 'opus') return stopAudio()
            playback?.stop()
            playback = window.shareAudio.createOpusPlayback(window['opus-decoder'].OpusDecoderWebWorker, format, player, () => {}, () => { stopAudio(); status.textContent = '声音中断，可重新开启' })
          } else playback?.push(event.data)
        }
        const currentSocket = audioSocket
        audioSocket.onclose = () => { if (audioSocket !== currentSocket) return; stopAudio(); if (!ended) status.textContent = '声音已断开，可重新开启' }
        sound.textContent = '关闭声音'
      } catch (_) { stopAudio(); status.textContent = '声音启动失败，请重试' }
    }
  } catch (error) { finish(error.message) }
  window.addEventListener('pagehide', () => finish('观看已结束'), { once: true })
})()
