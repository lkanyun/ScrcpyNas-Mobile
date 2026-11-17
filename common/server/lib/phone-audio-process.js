// Modified in the Mobile Remote derivative (2026): mobile UI, media transport or recovery changes; see MODIFICATIONS.md.
'use strict'

const { fork } = require('node:child_process')
const { IncomingMessage } = require('node:http')

// 把音频连接的所有权交给独立进程 避免视频处理阻塞逐帧音频发送
function createPhoneAudioProcess(config, { workerPath = __filename } = {}) {
  let worker = null
  let ready = null
  let stopped = false
  let stopping = null
  const pending = new Set()
  const wsPath = config.wsPath || '/phone-audio'

  // 工作进程按需恢复 启动失败只关闭音频请求而不影响视频服务
  function ensureWorker() {
    if (worker) return { child: worker, ready }
    if (stopped) throw new Error('音频服务已关闭')
    const child = fork(workerPath, [], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'], serialization: 'advanced' })
    worker = child
    ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { reject(new Error('音频进程启动超时')); child.kill() }, 5000)
      // 接收就绪通知并释放启动计时器
      function receive(message) {
        if (message?.type !== 'ready') return
        clearTimeout(timer)
        child.off('message', receive)
        resolve()
      }
      child.on('message', receive)
      child.once('error', reject)
      child.once('exit', () => {
        clearTimeout(timer)
        child.off('message', receive)
        if (worker === child) worker = null
        reject(new Error('音频进程已退出'))
      })
      child.send({ type: 'init', config }, error => { if (error) reject(error) })
    })
    ready.catch(() => {})
    return { child, ready }
  }

  // 仅转交升级握手与套接字 音频数据不再经过父进程或进程间消息队列
  async function handoff(req, socket, head) {
    pending.add(socket)
    socket.pause()
    const timer = setTimeout(() => socket.destroy(), 6000)
    try {
      const state = ensureWorker()
      await state.ready
      if (stopped || socket.destroyed || !state.child.connected) return socket.destroy()
      await new Promise((resolve, reject) => {
        state.child.send({ type: 'upgrade', request: { method: req.method, url: req.url, headers: req.headers, httpVersion: req.httpVersion }, head }, socket, { keepOpen: true },
          error => error ? reject(error) : resolve())
      })
      // 描述符已移交后释放父进程的连接对象 让 HTTP 服务可以正常结束
      socket.destroy()
    } catch (_) {
      socket.destroy()
    } finally {
      clearTimeout(timer)
      pending.delete(socket)
    }
  }

  // 有界接管音频升级 其余端点继续沿用原视频路由
  function handleUpgrade(req, socket, head) {
    if (req.url.split('?')[0] !== wsPath && req.url.split('?')[0] !== '/share/audio') return false
    if (stopped || pending.size >= 16) socket.destroy()
    else handoff(req, socket, head)
    return true
  }

  // 退出登录时立即通知连接所有者撤销该浏览器的音频
  function disconnectSession(req) {
    if (worker?.connected) worker.send({ type: 'logout', cookie: req.headers.cookie }, () => {})
  }

  // 等待子进程精确回收安卓采集 超时后强制释放所有连接
  function stop() {
    if (stopping) return stopping
    stopped = true
    for (const socket of pending) socket.destroy()
    pending.clear()
    const child = worker
    stopping = child ? new Promise(resolve => {
      const timer = setTimeout(() => child.kill('SIGKILL'), 4500)
      child.once('exit', () => { clearTimeout(timer); resolve() })
      if (child.connected) child.send({ type: 'stop' }, () => {})
      else child.kill()
    }) : Promise.resolve()
    return stopping
  }
  return { handleUpgrade, disconnectSession, stop, recheckShares() { if (worker?.connected) worker.send({ type: 'recheck-shares' }, () => {}) } }
}

// 子进程独立创建设备发现与认证配置 不接收浏览器指定的采集目标
function buildAudio(config) {
  const { createPhoneAudio, selectFixedTarget } = require('./phone-audio')
  const { createAdb } = require('./adb')
  const { createRecordStore } = require('./records')
  const { parseDevices } = createAdb(config.adbBin)
  const { readRecords } = createRecordStore(config.recordsFile)
  return createPhoneAudio({
    ...config,
    adb: require('@dead50f7/adbkit').createClient({ host: '127.0.0.1', port: config.adbPort, bin: config.adbBin }),
    selectTarget: async () => selectFixedTarget(readRecords(), await parseDevices())
  })
}

// 子进程只处理父进程交来的连接 不新增任何可访问的监听端口
function runAudioWorker(createAudio = buildAudio) {
  let audio = null
  let closing = false
  // 父进程退出或服务停止时一并关闭采集 防止后台遗留听众
  async function shutdown() {
    if (closing) return
    closing = true
    const timer = setTimeout(() => process.exit(1), 4000)
    try { await audio?.stop() } finally { clearTimeout(timer); process.exit(0) }
  }
  process.on('disconnect', shutdown)
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
  process.on('message', (message, socket) => {
    if (closing) { socket?.destroy(); return }
    if (message?.type === 'init' && !audio) {
      audio = createAudio(message.config)
      process.send({ type: 'ready' })
    } else if (message?.type === 'upgrade' && socket && audio) {
      socket.on('error', () => {})
      const req = new IncomingMessage(socket)
      Object.assign(req, message.request)
      if (!audio.handleUpgrade(req, socket, message.head)) socket.destroy()
    } else if (message?.type === 'logout') {
      audio?.disconnectSession({ headers: { cookie: message.cookie } })
    } else if (message?.type === 'recheck-shares') { audio?.recheckShares()
    } else if (message?.type === 'stop') shutdown()
    else socket?.destroy()
  })
}

if (require.main === module) runAudioWorker()
module.exports = { createPhoneAudioProcess, runAudioWorker }
