// Modified in the Mobile Remote derivative (2026): mobile UI, media transport or recovery changes; see MODIFICATIONS.md.
'use strict';

// 投屏模块 管理 iframe 的加载卸载 构造 ws-scrcpy 的 stream/proxy URL
// 用序号作废并发切换，准备阶段仅复用或启动设备侧视频服务
// 生命周期全收拢在此 避免切换 释放 新标签打开互相踩状态

// 显示轻量首屏提示 加载序号避免旧页面隐藏新连接的动画
function showStreamLoading(token) {
  let box = document.querySelector('#stream-loading-indicator')
  if (!box) {
    const style = document.createElement('style')
    style.textContent = '@keyframes stream-loading-spin{to{transform:rotate(360deg)}}#stream-loading-indicator{position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);z-index:2147483400;display:flex;align-items:center;flex-direction:column;gap:14px;padding:24px 30px;border-radius:22px;background:rgba(28,28,30,.88);color:#f5f5f7;font:14px -apple-system,BlinkMacSystemFont,sans-serif;box-shadow:0 8px 32px #0003;pointer-events:none;backdrop-filter:blur(16px)}#stream-loading-indicator[hidden]{display:none}#stream-loading-indicator .spinner{width:26px;height:26px;border:2px solid #ffffff26;border-top-color:#ffffffd9;border-radius:50%;animation:stream-loading-spin .85s linear infinite}@media(prefers-reduced-motion:reduce){#stream-loading-indicator .spinner{animation:none}}'
    document.head.appendChild(style)
    box = document.createElement('div')
    box.id = 'stream-loading-indicator'
    box.setAttribute('role', 'status')
    box.setAttribute('aria-live', 'polite')
    box.innerHTML = '<span class="spinner" aria-hidden="true"></span><span>正在连接设备…</span>'
    document.body.appendChild(box)
  }
  box.dataset.token = String(token)
  box.hidden = false
}
// 首帧或错误就绪后立即移除提示 不给播放增加等待时间
function hideStreamLoading(token) {
  const box = document.querySelector('#stream-loading-indicator')
  if (box && (token == null || box.dataset.token === String(token))) box.hidden = true
}
window.scrcpyNasStartupIndicator = { show: showStreamLoading, hide: hideStreamLoading }

// 构造 ws-scrcpy 的 adb 代理地址 action=proxy-adb 是 ws-scrcpy 的 adb 代理端点
// remote 指向 scrcpy server 监听的本机端口 udid 标识目标设备
function buildWsProxyUrl(serial) {
  const url = new URL(SCRCPY_BASE, window.location.href);
  url.protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('action', 'proxy-adb');
  url.searchParams.set('remote', `tcp:${SCRCPY_SERVER_PORT}`);
  url.searchParams.set('udid', serial);
  return url.toString();
}

// 构造投屏页面地址 ws-scrcpy 前端是 hash 路由 SPA 参数挂在 #! 后
// scrcpyNasTs 既防缓存又承载加载序号 captureKeyboard 默认开让键盘事件透传到设备
function buildStreamUrl(serial, token = Date.now(), maxSize = '') {
  const params = new URLSearchParams({
    action: 'stream',
    udid: serial,
    player: DEFAULT_PLAYER,
    ws: buildWsProxyUrl(serial),
    captureKeyboard: 'true',
    scrcpyNasTs: String(token),
  });
  if (maxSize) params.set('scrcpyNasMaxSize', String(maxSize));
  return `${SCRCPY_BASE}#!${params.toString()}`;
}

// 读取当前选中的分辨率限制
function getSelectedMaxSize() {
  const btn = document.querySelector('#maxSizeSeg .seg-btn.active');
  return btn ? btn.dataset.maxsize || '' : '';
}

// 优先用记录里保存的分辨率 没有才回退到当前分段按钮的选中值
function getMaxSizeFor(serial) {
  const record = records.find((r) => r.serial === serial || r.id === serial);
  if (record && record.maxSize) return record.maxSize;
  return getSelectedMaxSize();
}

// 判断当前 iframe 是否已加载指定设备
function isMirrorLoadedFor(serial) {
  const src = $('#mirrorFrame').src || '';
  return src.includes(`udid=${encodeURIComponent(serial)}`) || src.includes(`udid=${serial}`);
}

// 保留历史调用名称，但不再清理活跃进程，避免破坏其他页面和音频旁路
// 浏览器连接由 iframe 卸载和温会话到期释放，ADB 仅在用户明确断开时释放
async function cleanupStream(serial) {
  if (!serial) return { ok: true };
  return postJson(apiUrl('/api/stream/prepare'), { serial });
}

// 开始加载前先做准备工作
async function prepareStream(serial) {
  return cleanupStream(serial);
}

// 先指向 about:blank 再等 IFRAME_RELEASE_DELAY_MS 直接换 src 会让旧 ws-scrcpy
// 实例的 WebSocket 来不及关闭 需要先指空白页等浏览器回收连接
async function unloadMirror(showEmpty = false) {
  if (showEmpty) hideStreamLoading()
  if (showEmpty) {
    document.body.classList.add('device-home')
    document.body.classList.remove('phone-immersive')
    const feedback = $('#device-home-feedback')
    if (feedback) feedback.textContent = ''
  }
  $('#mirrorFrame').src = 'about:blank';
  mirrorSerial = '';
  if (showEmpty) {
    $('#mirrorEmpty').classList.remove('hidden');
  }
  await sleep(IFRAME_RELEASE_DELAY_MS);
}

// 在当前页打开投屏 用序号 seq 作废并发切换 每次开始新加载递增 openMirrorSeq
// 每个 await 之后比对 seq 不一致说明用户中途又点了别的设备 当前流程直接返回
async function openMirror(serial = selectedSerial) {
  const seq = ++openMirrorSeq;
  if (!serial) return;

  const previousSerial = mirrorSerial;
  if (previousSerial === serial && isMirrorLoadedFor(serial)) {
    return;
  }

  showStreamLoading(seq)
  if (previousSerial) {
    await unloadMirror(false);
    await cleanupStream(previousSerial).catch(error => { hideStreamLoading(seq); throw error });
    if (seq !== openMirrorSeq) return;
  }

  await prepareStream(serial).catch(error => { hideStreamLoading(seq); throw error });
  if (seq !== openMirrorSeq) return;
  $('#mirrorEmpty').classList.add('hidden');
  document.body.classList.remove('device-home')
  $('#mirrorFrame').src = buildStreamUrl(serial, seq, getMaxSizeFor(serial));
  mirrorSerial = serial;
}

// 在新标签打开当前选中设备 若本页 iframe 正在播同一设备 要先卸载本页并清理资源
// 否则两个 scrcpy 实例会同时连同一设备
async function openSelectedInNewTab() {
  if (!selectedSerial) return;

  // 主屏幕应用留在同一窗口，桌面继续提前打开标签以避免弹窗拦截
  const standalone = (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches)
    || window.navigator.standalone === true
  const tab = standalone ? null : window.open('about:blank', '_blank');
  if (mirrorSerial === selectedSerial) {
    ++openMirrorSeq;
    await unloadMirror(true);
    await cleanupStream(selectedSerial);
  }

  const streamUrl = buildStreamUrl(selectedSerial, Date.now(), getMaxSizeFor(selectedSerial));
  if (standalone) {
    window.location.href = streamUrl
  } else if (tab) {
    tab.location.href = streamUrl;
  } else {
    window.open(streamUrl, '_blank', 'noopener');
  }
}

// 断开当前选中设备 USB 设备只清理不 disconnect USB 直连不走 adb connect/disconnect
async function disconnectSelectedDevice() {
  if (!selectedSerial) return;

  ++openMirrorSeq;
  const loadedSerial = mirrorSerial;
  if (loadedSerial) {
    await unloadMirror(true);
    await cleanupStream(loadedSerial);
  }

  if (!selectedIsUsb) {
    await postJson(apiUrl('/api/disconnect'), { serial: selectedSerial });
  }
  selectedSerial = '';
  selectedIsUsb = false;
  await loadDevices();
}
