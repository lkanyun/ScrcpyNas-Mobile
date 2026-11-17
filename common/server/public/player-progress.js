// Modified in the Mobile Remote derivative (2026): mobile UI, media transport or recovery changes; see MODIFICATIONS.md.
// 统一真实画面进展，原 MSE 保持媒体时钟，画布只接受原生输出后的绘制登记
;(function () {
  'use strict'
  let active = null
  let generation = 0
  let videoOwner = null
  let videoSeen = null

  // 每个播放器实例使用不可复用身份，关闭或替换后旧回调不能恢复就绪
  function register(drawable, mode) {
    if (active) active.close()
    const state = { owner: {}, generation: ++generation, drawable, mode, decodedSeq: 0, drawnSeq: 0, lastNativeOutput: 0, lastDraw: 0, closed: false }
    let drawnOutput = 0
    // 原生输出回调仅登记解码，不能代替真实绘制
    state.output = () => {
      if (state !== active || state.closed) return
      state.decodedSeq++
      state.lastNativeOutput = performance.now()
    }
    // 仅由成功绘制或原生视频呈现回调调用 不提供可写播放时钟
    state.draw = () => {
      if (state !== active || state.closed || state.decodedSeq <= drawnOutput) return
      drawnOutput = state.decodedSeq
      state.drawnSeq++
      state.lastDraw = performance.now()
      window.dispatchEvent(new Event('scrcpynas:frame-drawn'))
    }
    // 终止当前世代并清除可用状态
    state.close = () => { state.closed = true }
    active = state
    return state
  }

  // 原 MSE 无需改播放器，只读原媒体状态并保留原时钟语义
  function read() {
    if (active) return {
      owner: active.owner, generation: active.generation, mode: active.mode,
      drawable: active.drawable, decodedSeq: active.decodedSeq, drawnSeq: active.drawnSeq,
      lastNativeOutput: active.lastNativeOutput, lastDraw: active.lastDraw,
      sourceRect: { width: active.drawable.videoWidth ?? active.drawable.width, height: active.drawable.videoHeight ?? active.drawable.height },
      position: active.drawnSeq, ready: !active.closed && active.drawnSeq > 0 && active.decodedSeq > 0,
      error: null, paused: active.closed
    }
    const video = document.querySelector('video.video-layer')
    if (video !== videoSeen) { videoSeen = video; videoOwner = {}; generation++ }
    return {
      owner: videoOwner, generation, mode: video?.dataset?.transport === 'webrtc' ? 'webrtc' : 'mse', drawable: video,
      position: video ? video.currentTime : 0,
      sourceRect: { width: video ? video.videoWidth : 0, height: video ? video.videoHeight : 0 },
      ready: !!video && !video.error && !video.paused && video.readyState >= 2 && video.videoWidth > 0,
      error: video ? video.error : null, paused: !video || video.paused
    }
  }

  // MSE 接管时退出画布分支，下一次读取为新视频身份
  function useMse() { if (active) active.close(); active = null; videoSeen = null }
  window.scrcpyNasProgress = { register, read, useMse }
  for (const name of ['scrcpynas:recovering', 'scrcpynas:disconnect', 'scrcpynas:auth-denied', 'pagehide']) {
    window.addEventListener(name, () => { if (active) active.close() })
  }
})()
