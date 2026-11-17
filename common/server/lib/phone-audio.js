// Modified in the Mobile Remote derivative (2026): mobile UI, media transport or recovery changes; see MODIFICATIONS.md.
'use strict'

// 固定版本音频服务不覆盖旧视频引擎的服务文件
const VERSION = '3.3.3'
const REMOTE_JAR = '/data/local/tmp/phone-audio-3.3.3.jar'
const JAR_SHA256 = '7e70323ba7f259649dd4acce97ac4fefbae8102b2c6d91e2e7be613fd5354be0'

// 仅从服务端保存记录和在线设备中选择唯一目标
function selectFixedTarget(records, devices) {
  const online = devices.filter(item => (item.state || item.type) === 'device')
  const saved = online.filter(item => records.some(record => record.serial === item.serial))
  const candidates = saved.length ? saved : online
  if (candidates.length !== 1) throw new Error('无法确定唯一在线音频设备')
  return candidates[0].serial
}

// 构造不启用视频 控制或麦克风的独立音频实例命令
function audioCommand(scid, codec = 'raw') {
  if (!/^[0-7][a-f0-9]{7}$/.test(scid)) throw new Error('Invalid scid')
  if (!['raw', 'opus'].includes(codec)) throw new Error('Invalid audio codec')
  const options = codec === 'opus' ? 'audio_codec=opus audio_bit_rate=96000 send_device_meta=false send_dummy_byte=false send_codec_meta=false send_frame_meta=true' : 'audio_codec=raw raw_stream=true'
  return `CLASSPATH=${REMOTE_JAR} app_process / com.genymobile.scrcpy.Server ${VERSION} scid=${scid} video=false control=false audio=true audio_source=output ${options} tunnel_forward=true cleanup=false log_level=warn`
}

// 只在远控输出路由生效后校准媒体音量，不修改扬声器或通话音量
async function normalizeRemoteVolume(adb, serial, signal) {
  signal?.throwIfAborted()
  // 部分厂商忽略直接设置，回读失败时在正常媒体路由下使用音量键逐档校准
  const command = `for n in 1 2 3 4 5 6 7 8 9 10; do
music=$(dumpsys audio | sed -n '/^- STREAM_MUSIC:/,/^- STREAM_ALARM:/p')
if printf '%s' "$music" | grep -q 'Devices: remote_submix(8000)'; then
maximum=$(printf '%s' "$music" | sed -n 's/^ *Max: *\\([0-9][0-9]*\\).*$/\\1/p' | head -1)
case "$maximum" in ''|*[!0-9]*) exit 1;; esac
cmd media_session volume --stream 3 --set "$maximum" >/dev/null 2>&1
for attempt in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
if cmd media_session volume --stream 3 --get | grep -q "volume is $maximum in range"; then echo REMOTE_VOLUME_READY; exit; fi
state=$(dumpsys audio)
printf '%s' "$state" | sed -n '/^- STREAM_MUSIC:/,/^- STREAM_ALARM:/p' | grep -q 'Devices: remote_submix(8000)' || exit 1
printf '%s' "$state" | grep -q 'mMode=MODE_NORMAL' || exit 1
input keyevent 24
sleep 0.1
done
exit 1
fi
sleep 0.2
done`
  const stream = await adb.shell(serial, command)
  // 有界读取校准结果，取消或超时不遗留后台采集
  await new Promise((resolve, reject) => {
    let output = ''
    const timer = setTimeout(() => finish(new Error('远控源音量校准超时')), 12000)
    // 集中回收命令流与取消监听
    function finish(error) {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      stream.removeAllListeners('end')
      stream.destroy()
      error ? reject(error) : resolve()
    }
    // 退出音频时同步取消校准
    function abort() { finish(new Error('音频已关闭')) }
    stream.on('data', chunk => { output = (output + chunk.toString()).slice(-4096) })
    stream.once('error', finish)
    stream.once('end', () => finish(output.includes('REMOTE_VOLUME_READY') ? null : new Error('远控源音量校准失败')))
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
  })
}

// 验证官方固定摘要后上传独立文件并启动按需系统音频
async function startRawCapture({ adb, serial, jarPath, scid, signal, codec = 'raw' }) {
  const fs = require('fs')
  const crypto = require('crypto')
  const { once } = require('events')
  const { setTimeout: delay } = require('timers/promises')
  const command = audioCommand(scid, codec)
  if (crypto.createHash('sha256').update(fs.readFileSync(jarPath)).digest('hex') !== JAR_SHA256) throw new Error('音频服务文件校验失败')
  let shell
  let stream
  let stopped = false
  let cleanedShell
  // 仅结束属于当前随机实例的进程 不影响旧视频或其他会话
  async function stop() {
    stream?.destroy()
    shell?.destroy()
    if (stopped && cleanedShell === shell) return
    stopped = true
    cleanedShell = shell
    signal?.removeEventListener('abort', onAbort)
    const cleanup = await adb.shell(serial, `for p in $(pidof app_process app_process32 app_process64 2>/dev/null); do if tr '\\000' ' ' < /proc/$p/cmdline 2>/dev/null | grep -F 'com.genymobile.scrcpy.Server ${VERSION} ' | grep -qF 'scid=${scid} '; then kill "$p" 2>/dev/null; fi; done`)
    cleanup.resume()
    const timer = setTimeout(() => cleanup.destroy(), 2000)
    cleanup.once('close', () => clearTimeout(timer))
    cleanup.on('error', () => {})
  }
  // 中途取消也回收已经启动的安卓实例
  function onAbort() { stop().catch(() => {}) }
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    signal?.throwIfAborted()
    const transfer = await adb.push(serial, jarPath, REMOTE_JAR)
    await once(transfer, 'end')
    signal?.throwIfAborted()
    shell = await adb.shell(serial, command)
    shell.on('error', () => {})
    shell.resume()
    for (let attempt = 0; attempt < 60; attempt++) {
      signal?.throwIfAborted()
      if (stopped) throw new Error('音频已关闭')
      try { stream = await adb.openLocal(serial, 'localabstract:scrcpy_' + scid); break } catch (_) { await delay(100, undefined, { signal }) }
    }
    if (!stream) throw new Error('系统音频启动失败 应用可能不允许采集')
    if (stopped || signal?.aborted) { stream.destroy(); throw new Error('音频已关闭') }
    if (codec === 'opus') await normalizeRemoteVolume(adb, serial, signal)
    if (stopped || signal?.aborted) throw new Error('音频已关闭')
    return { stream, stop }
  } catch (error) {
    await stop().catch(() => {})
    throw error
  }
}

// 通过本机私有会话端点核实升级请求 不信任代理传入的身份头
function checkSession(sessionCheckUrl, cookie) {
  const http = require('http')
  return new Promise(resolve => {
    if (!cookie) return resolve(false)
    const request = http.get(sessionCheckUrl, { headers: { Cookie: cookie }, timeout: 2500, agent: false }, response => {
      response.resume()
      resolve(response.statusCode === 204)
    })
    request.on('timeout', () => request.destroy())
    request.on('error', () => resolve(false))
  })
}

// 达到实时延迟上限时断开慢消费者 不在服务端囤积音频
function sendPcm(client, data, limit = 38400) {
  if (client.readyState !== 1) return false
  if (client.bufferedAmount > limit) { client.close(1013, '音频网络拥塞 请降低视频码率后重试'); return false }
  client.send(data, { binary: true })
  return true
}

// 创建独立升级处理器 首位拦截固定路径后再委托原视频代理
function createPhoneAudio(config) {
  const crypto = require('crypto')
  const { WebSocketServer, WebSocket } = require('ws')
  const endpoint = new URL(config.sessionCheckUrl)
  if (endpoint.protocol !== 'http:' || !['127.0.0.1', '[::1]', 'localhost'].includes(endpoint.hostname) || endpoint.pathname !== '/session/check' || endpoint.search || endpoint.username || endpoint.password) throw new Error('音频认证必须使用固定本机会话接口')
  if (new URL(config.origin).origin !== config.origin) throw new Error('音频来源必须是精确站点来源')
  const wsPath = config.wsPath || '/phone-audio'
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 65536 })
  const listeners = new Set()
  const rtcClosing = new Set()
  // 跟踪异步传输释放 服务停止时等待归还中继和关闭套接字
  function closeRtc(client) {
    const previous = client.rtcAudio
    client.rtcAudio = null
    if (!previous) return
    const closing = previous.close().catch(() => {})
    rtcClosing.add(closing)
    closing.finally(() => rtcClosing.delete(closing))
  }
  const opus = config.codec === 'opus'
  let opusParser
  let format = opus ? null : JSON.stringify({ type: 'format', codec: 'pcm-s16le', sampleRate: 48000, channels: 2, bitrate: 1536000 })
  let capture
  let warmTimer = null
  let warmCookie = null
  let captureSerial
  let starting
  let controller
  let closed = false
  let remainder = Buffer.alloc(0)
  // 心跳探测半开连接并持续复核会话 失联后不在后台采集
  const heartbeat = setInterval(() => {
    const checkingWarmCookie = warmCookie
    if (checkingWarmCookie) checkSession(config.sessionCheckUrl, checkingWarmCookie).then(valid => { if (!valid && warmCookie === checkingWarmCookie) releaseCapture().catch(() => {}) })
    for (const client of listeners) {
      if (!client.audioAlive) { client.terminate(); continue }
      client.audioAlive = false
      client.ping()
      if (!client.audioChecking) {
        client.audioChecking = true
        checkSession(client.audioCheckUrl, client.audioCookie).then(valid => { if (!valid) { client.noWarm = true; client.terminate() } }).finally(() => { client.audioChecking = false })
      }
    }
  }, config.sessionRecheckMs || 10000)
  heartbeat.unref()
  // 只在最后一个听众离开后立即结束采集
  async function releaseCapture() {
    if (listeners.size) return
    clearTimeout(warmTimer); warmTimer = null; warmCookie = null
    controller?.abort()
    const previous = capture
    capture = null
    // 空闲后丢弃旧配置 下次开启只接受新采集器的配置帧
    if (opus) format = null
    if (previous) await previous.stop().catch(() => {})
  }
  // 固定实时流只转发已对齐样本 堵塞连接不积攒旧音频
  function broadcast(data) {
    if (opus) {
      try { opusParser.push(data) } catch (_) { for (const client of listeners) client.close(1011, '系统音频格式异常'); capture?.stream.destroy() }
      return
    }
    const combined = remainder.length ? Buffer.concat([remainder, data]) : data
    const length = combined.length - combined.length % 4
    remainder = Buffer.from(combined.subarray(length))
    for (let offset = 0; offset < length; offset += 3840) {
      const packet = combined.subarray(offset, Math.min(offset + 3840, length))
      for (const client of listeners) sendPcm(client, packet)
    }
  }
  // 所有请求共用一个安卓采集器 并在异步启动期间保持取消能力
  async function ensureCapture() {
    if (capture) return
    if (starting) {
      await starting.catch(() => {})
      if (listeners.size && !closed && !capture) return ensureCapture()
      return
    }
    remainder = Buffer.alloc(0)
    if (opus) {
      format = null
      opusParser = require('./opus-stream').createOpusParser(value => {
        format = JSON.stringify(value)
        for (const client of listeners) { client.send(format); client.rtcAudio?.offer() }
      }, packet => { for (const client of listeners) { if (client.rtcAudio) client.rtcAudio.packet(packet); else sendPcm(client, packet, 4096) } })
    }
    controller = new AbortController()
    const signal = controller.signal
    starting = (async () => {
      const serial = await config.selectTarget()
      captureSerial = serial
      for (const client of listeners) if (client.shareSerial && client.shareSerial !== serial) client.terminate()
      if (signal.aborted) return
      const scid = (crypto.randomBytes(4).readUInt32BE() & 0x7fffffff).toString(16).padStart(8, '0')
      const start = config.startCapture || startRawCapture
      const result = await start({ adb: config.adb, serial, jarPath: config.jarPath, scid, signal, codec: opus ? 'opus' : 'raw' })
      if ((!listeners.size && !warmTimer) || signal.aborted || closed) { await result.stop(); return }
      capture = result
      result.stream.on('data', broadcast)
      // 安卓断开或应用禁止采集时不伪装为仍在播放
      const ended = () => { for (const client of listeners) client.close(1011, '系统音频已中断 应用可能不允许采集') }
      result.stream.once('end', ended)
      result.stream.once('error', ended)
    })().finally(() => { starting = null })
    return starting
  }
  // 在来源与会话都通过后才接受连接和启动安卓采集
  async function upgrade(req, socket, head) {
    const url = new URL(req.url, 'http://localhost')
    const shared = url.pathname === '/share/audio'
    const token = url.searchParams.get('token')
    const wantsRtc = req.url === wsPath + '?sourceVolume=unity&rtc=1'
    const calibrated = req.url === wsPath + '?sourceVolume=unity' || wantsRtc
    let shareSerial = null
    if (shared) {
      if (!/^[a-f0-9]{64}$/.test(token || '')) return socket.destroy()
      shareSerial = await config.selectTarget()
      if (capture && captureSerial !== shareSerial) return socket.destroy()
    }
    const checkUrl = shared ? new URL('/share/check?serial=' + encodeURIComponent(shareSerial), config.sessionCheckUrl).href : config.sessionCheckUrl
    const cookie = shared ? 'phone_share=' + token : req.headers.cookie
    if ((!shared && !calibrated && (opus || req.url !== wsPath)) || req.headers.origin !== config.origin || !await checkSession(checkUrl, cookie) || closed) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
      return
    }
    if (socket.destroyed) return
    wss.handleUpgrade(req, socket, head, client => {
      // 独立音频进程接收的套接字在完成认证和升级后才恢复读取
      socket.resume()
      clearTimeout(warmTimer); warmTimer = null; warmCookie = null
      listeners.add(client)
      client.audioCookie = cookie
      client.audioCheckUrl = checkUrl
      client.shareSerial = shareSerial
      client.audioAlive = true
      client.on('pong', () => { client.audioAlive = true })
      client.on('error', () => {})
      // 协商失败在原采集器上恢复旧音频 不影响视频与其他听众
      function fallback() {
        closeRtc(client)
        if (client.readyState === 1) client.send(JSON.stringify({ rtc: 'audio-fallback' }))
      }
      if (wantsRtc && opus && config.rtcConfig && !shared) {
        try {
          client.rtcAudio = require('./rtc-audio').createRtcAudio({ config: config.rtcConfig, signal: value => { if (client.readyState === 1) client.send(JSON.stringify(value)) }, failed: fallback })
        } catch (_) { fallback() }
      } else if (wantsRtc) fallback()
      let lastSignal = 0, signalCount = 0
      client.on('message', (data, binary) => {
        if (!client.rtcAudio) return
        if (Date.now() - lastSignal > 1000) { lastSignal = Date.now(); signalCount = 0 }
        if (binary || ++signalCount > 64) { client.noWarm = true; return client.close(1008, '无效音频协商') }
        try {
          const value = JSON.parse(data.toString())
          if (value.rtc === 'audio-fallback') fallback()
          else client.rtcAudio.receive(value).catch(fallback)
        } catch (_) { fallback() }
      })
      // 意外离线只保留采集器，直接丢弃无人接收的数据，不缓存旧声音
      client.once('close', code => {
        closeRtc(client)
        listeners.delete(client)
        if (listeners.size) return
        const grace = Math.min(60000, Math.max(0, config.warmIdleMs || 0))
        if (grace && !closed && !client.shareSerial && !client.noWarm && code !== 4000) {
          warmCookie = client.audioCookie
          warmTimer = setTimeout(() => releaseCapture().catch(() => {}), grace)
          warmTimer.unref()
        } else releaseCapture().catch(() => {})
      })
      if (format && (!opus || capture)) { client.send(format); client.rtcAudio?.offer() }
      ensureCapture().catch(() => { for (const current of listeners) current.close(1011, '系统音频启动失败 请确认设备在线及应用允许采集') })
    })
  }
  // 返回是否已接管升级 不让异步认证落入旧视频升级处理器
  function handleUpgrade(req, socket, head) {
    if (req.url.split('?')[0] !== wsPath && req.url.split('?')[0] !== '/share/audio') return false
    upgrade(req, socket, head).catch(() => socket.destroy())
    return true
  }
  // 退出接口可立即撤销相同浏览器的现有音频连接
  function disconnectSession(req) {
    if (warmCookie === req.headers.cookie) releaseCapture().catch(() => {})
    for (const client of listeners) {
      if (client.audioCookie === req.headers.cookie) { client.noWarm = true; client.terminate() }
    }
  }
  // 关闭所有听众并等待正在启动的采集器回收
  async function stop() {
    closed = true
    clearInterval(heartbeat)
    for (const client of listeners) { closeRtc(client); client.terminate() }
    listeners.clear()
    await releaseCapture()
    await starting?.catch(() => {})
    await Promise.allSettled([...rtcClosing])
    wss.close()
  }
  // 分享到期或主动撤销时复核观看者，不打断所有者音频
  function recheckShares() {
    for (const client of listeners) if (client.shareSerial) checkSession(client.audioCheckUrl, client.audioCookie).then(valid => { if (!valid) { client.noWarm = true; client.terminate() } })
  }
  const shareTimer = setInterval(recheckShares, 1000)
  shareTimer.unref()
  const originalStop = stop
  return { handleUpgrade, disconnectSession, recheckShares, stop() { clearInterval(shareTimer); return originalStop() } }
}

module.exports = { normalizeRemoteVolume, VERSION, REMOTE_JAR, JAR_SHA256, selectFixedTarget, audioCommand, startRawCapture, createPhoneAudio, sendPcm, checkSession }
