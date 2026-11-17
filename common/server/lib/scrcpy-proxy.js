// Modified in the Mobile Remote derivative (2026): mobile UI, media transport or recovery changes; see MODIFICATIONS.md.
'use strict';

const http = require('http');
const net = require('net');
const { patchEngineMedia } = require('./engine-media');
const { patchScreenPower } = require('./screen-power');
const { patchLowLatency } = require('./engine-low-latency');
const { createWarmScrcpyUpgradeProxy, releaseWarmScreen } = require('./warm-stream');

const SCRCPY_STREAM_CSS = `

html,
body.stream {
    width: 100%;
    height: 100%;
    overflow: hidden;
    margin: 0;
    padding: 0;
    background: #05070b;
}

body.stream {
    display: flex;
    align-items: center;
    justify-content: center;
}

body.stream .control-buttons-list,
body.stream .more-box {
    display: none !important;
}

/* 视频容器会被引擎设置为设备原始分辨率（内联 px），这里覆盖为
   铺满窗口的透明层；视频/触摸层按比例自适应宽高并绝对居中 */
body.stream .video {
    position: fixed !important;
    left: var(--stream-left, 0px) !important;
    top: var(--stream-top, 0px) !important;
    float: none !important;
    /* 动态视口由原有自适应循环统一更新，避免与移动端再建缩放循环 */
    width: var(--stream-width, 100vw) !important;
    height: var(--stream-height, 100dvh) !important;
    max-width: none !important;
    max-height: none !important;
    background: transparent !important;
}

body.stream .video .video-layer,
body.stream .video .touch-layer {
    position: absolute !important;
    left: 50% !important;
    top: 50% !important;
    transform: translate(-50%, -50%);
    max-width: none !important;
    max-height: none !important;
    box-sizing: content-box !important;
    border: 0 !important;
    padding: 0 !important;
    margin: 0 !important;
    object-fit: contain;
}
`;

const SCRCPY_OFFICIAL_CONTROL_JS = `
// 应用连接时选择的分辨率：写入 ws-scrcpy 本地存储，MSE 播放器创建时会读取
(function () {
  'use strict';
  try {
    var hash = window.location.hash || '';
    var params = new URLSearchParams(hash.replace(/^#!/, ''));
    var serial = params.get('udid');
    var maxSize = parseInt(params.get('scrcpyNasMaxSize'), 10);
    if (!serial || !window.localStorage) return;
    var key = 'MseDecoder:' + serial + ':' + window.innerWidth + 'x' + window.innerHeight;
    var saved = JSON.parse(window.localStorage.getItem('scrcpyNas.media.' + serial) || 'null');
    // 用户主动保存的设备偏好优先于首页旧参数，兼容引擎带显示器后缀的存储键
    if (saved && [720, 960, 1280, 1600, 1920].includes(saved.maxSize) && [1000000, 2000000, 4000000, 6000000, 8000000, 12000000].includes(saved.bitrate) && [24, 30, 60].includes(saved.maxFps)) {
      var settings = JSON.stringify({ bounds: { width: saved.maxSize, height: saved.maxSize }, bitrate: saved.bitrate, maxFps: saved.maxFps });
      Object.keys(window.localStorage).filter(function (name) { return name.indexOf(key + ':') === 0 && !name.endsWith(':fit'); }).concat([key]).forEach(function (name) {
        window.localStorage.setItem(name, settings);
        window.localStorage.setItem(name + ':fit', 'false');
      });
    } else if (!isNaN(maxSize) && maxSize > 0) {
      window.localStorage.setItem(key, JSON.stringify({ bounds: { width: maxSize, height: maxSize } }));
    } else {
      window.localStorage.removeItem(key);
    }
  } catch (e) {
    /* ignore */
  }
})();

// 只补充 ws-scrcpy 原生页面没有覆盖好的鼠标操作：右键返回，中键回桌面
(function () {
  'use strict';

  var LONG_PRESS_MS = 650;
  var rightPress = null;

  function getSerial() {
    var hash = window.location.hash || '';
    var query = hash.replace(/^#!/, '');
    var params = new URLSearchParams(query);
    return params.get('udid') || '';
  }

  function sendKey(key, longpress) {
    var serial = getSerial();
    if (!serial) return;
    fetch('../api/device/input', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ serial: serial, type: 'key', key: key, longpress: !!longpress })
    }).catch(function (e) {
      console.warn('[scrcpyNas] input failed:', e && e.message ? e.message : e);
    });
  }

  function stop(e) {
    e.preventDefault();
    e.stopImmediatePropagation();
  }

  function onPointerDown(e) {
    if (e.button === 2) {
      stop(e);
      rightPress = { longSent: false };
      rightPress.timer = setTimeout(function () {
        if (!rightPress) return;
        rightPress.longSent = true;
        sendKey('BACK', true);
      }, LONG_PRESS_MS);
      return;
    }

    if (e.button === 1) {
      stop(e);
      sendKey('HOME');
    }
  }

  function onPointerUp(e) {
    if (e.button === 2) {
      stop(e);
      if (!rightPress) return;
      clearTimeout(rightPress.timer);
      if (!rightPress.longSent) sendKey('BACK');
      rightPress = null;
      return;
    }

    if (e.button === 1) {
      stop(e);
    }
  }

  var downEvent = window.PointerEvent ? 'pointerdown' : 'mousedown';
  var upEvent = window.PointerEvent ? 'pointerup' : 'mouseup';
  document.addEventListener(downEvent, onPointerDown, true);
  document.addEventListener(upEvent, onPointerUp, true);
  document.addEventListener('auxclick', function (e) {
    if (e.button === 1 || e.button === 2) stop(e);
  }, true);
  document.addEventListener('contextmenu', stop, true);
})();

// 自适应画面尺寸：视频和触摸层共享实际尺寸，仅平移而不变换坐标比例
(function () {
  'use strict';

  var lastLandscape = null;
  // 沿用唯一自适应循环，同时兼容动态视口与裁切模式
  function fitToWindow() {
    var viewport = window.visualViewport;
    var vw = viewport ? viewport.width : window.innerWidth;
    var vh = viewport ? viewport.height : window.innerHeight;
    var root = document.documentElement;
    // 内嵌视图由外层 viewer 避让安全区，独立投屏在同一缩放循环中处理以免重复扣除
    var safe = window.top === window ? getComputedStyle(root) : null;
    var top = safe ? parseFloat(safe.getPropertyValue('--phone-safe-top')) || 0 : 0;
    var bottom = safe ? parseFloat(safe.getPropertyValue('--phone-safe-bottom')) || 0 : 0;
    var left = safe ? parseFloat(safe.getPropertyValue('--phone-safe-left')) || 0 : 0;
    var right = safe ? parseFloat(safe.getPropertyValue('--phone-safe-right')) || 0 : 0;
    vw = Math.max(1, vw - left - right);
    vh = Math.max(1, vh - top - bottom);
    if (root.style.getPropertyValue('--stream-top') !== top + 'px') root.style.setProperty('--stream-top', top + 'px');
    if (root.style.getPropertyValue('--stream-left') !== left + 'px') root.style.setProperty('--stream-left', left + 'px');
    if (root.style.getPropertyValue('--stream-width') !== vw + 'px') root.style.setProperty('--stream-width', vw + 'px');
    if (root.style.getPropertyValue('--stream-height') !== vh + 'px') root.style.setProperty('--stream-height', vh + 'px');
    var video = document.querySelector('body.stream .video-layer');
    if (!video) return;
    var iw = video.videoWidth || video.width;
    var ih = video.videoHeight || video.height;
    if (!iw || !ih) return;
    // 手机竖屏观看安卓横屏时旋转画面，并交换缩放空间，触摸层保持相同变换
    var landscape = iw > ih;
    var mobile = window.matchMedia('(pointer: coarse)').matches;
    var rotated = mobile && landscape && vw < vh;
    root.classList.toggle('stream-rotated', rotated);
    if (lastLandscape !== landscape) {
      lastLandscape = landscape;
      window.dispatchEvent(new CustomEvent('scrcpynas:source-orientation', { detail: { landscape: landscape, mobile: mobile } }));
    }
    var availableWidth = rotated ? vh : vw;
    var availableHeight = rotated ? vw : vh;
    var cover = false;
    try { cover = localStorage.getItem('scrcpyNas.mobile.scale') === 'cover'; } catch (_) { /* 存储不可用时使用完整画面 */ }
    var scale = (cover ? Math.max : Math.min)(availableWidth / iw, availableHeight / ih);
    var w = Math.round(iw * scale) + 'px';
    var h = Math.round(ih * scale) + 'px';
    // 每层独立校验，兼容引擎重新创建触摸层或重写内联尺寸
    [video, document.querySelector('body.stream .touch-layer')].forEach(function (layer) {
      if (!layer) return;
      var transform = rotated ? 'translate(-50%, -50%) rotate(90deg)' : 'translate(-50%, -50%)';
      if (layer.style.transform !== transform) layer.style.transform = transform;
      if (layer.style.width !== w) layer.style.width = w;
      if (layer.style.height !== h) layer.style.height = h;
    });
  }

  window.addEventListener('resize', fitToWindow);
  window.addEventListener('scrcpynas:scale', fitToWindow);
  if (window.visualViewport) window.visualViewport.addEventListener('resize', fitToWindow);
  window.addEventListener('orientationchange', function () {
    setTimeout(fitToWindow, 300);
  });

  // 复用原有帧循环以跟随引擎视频固有尺寸变化
  (function loop() {
    fitToWindow();
    requestAnimationFrame(loop);
  })();
})();
`;

function shouldInjectScrcpyStreamCss(method, proxyPath) {
  return method === 'GET' && proxyPath.split('?')[0] === '/main.css';
}

function shouldInjectScrcpyControls(method, proxyPath) {
  const p = proxyPath.split('?')[0];
  return method === 'GET' && (p === '/' || p === '/index.html');
}

function writeTextProxyResponse(proxyRes, res, transform) {
  const chunks = [];
  proxyRes.on('error', (e) => {
    console.error(`[scrcpy-proxy] response read error: ${e.message}`);
    if (!res.headersSent) res.status(502).send('scrcpy engine proxy error');
    else res.end();
  });
  proxyRes.on('data', (chunk) => chunks.push(chunk));
  proxyRes.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8');
    const nextBody = transform(body);
    const headers = { ...proxyRes.headers };
    delete headers['content-length'];
    headers['content-type'] = headers['content-type'] || 'text/html; charset=utf-8';
    res.writeHead(proxyRes.statusCode || 200, headers);
    res.end(nextBody);
  });
}

function isExpectedSocketError(error) {
  return error && ['EPIPE', 'ECONNRESET', 'ERR_STREAM_PREMATURE_CLOSE'].includes(error.code);
}

function logProxySocketError(scope, error) {
  // Closing a tab or stopping a stream often closes one side of the proxy first
  if (isExpectedSocketError(error)) {
    console.warn(`[scrcpy-proxy] ${scope}: ${error.code}`);
    return;
  }
  console.error(`[scrcpy-proxy] ${scope}: ${error && error.message ? error.message : error}`);
}

function destroyQuietly(stream) {
  try {
    if (stream && !stream.destroyed) stream.destroy();
  } catch (_) {
    /* ignore */
  }
}

function createScrcpyHttpProxy({ buildProxyPath, wsScrcpyHost, wsScrcpyPort }) {
  return function proxyScrcpyHttp(req, res) {
    const proxyPath = buildProxyPath(req.originalUrl || req.url);
    const injectStreamCss = shouldInjectScrcpyStreamCss(req.method, proxyPath);
    const injectControls = shouldInjectScrcpyControls(req.method, proxyPath);
    const proxyReq = http.request(
      {
        host: wsScrcpyHost,
        port: wsScrcpyPort,
        method: req.method,
        path: proxyPath,
        headers: {
          ...req.headers,
          host: `${wsScrcpyHost}:${wsScrcpyPort}`,
          'accept-encoding': 'identity',
        },
      },
      (proxyRes) => {
        // 旧播放器改分辨率时会留下已移除缓冲区的回调，仅对真实引擎包应用兼容保护
        if (req.method === 'GET' && proxyPath.split('?')[0] === '/bundle.js' && proxyRes.statusCode === 200) {
          writeTextProxyResponse(proxyRes, res, body => {
            const media = body.includes('e.sourceBuffer.addEventListener("updateend",function(){') ? patchEngineMedia(body) : body;
            const power = media.includes('createSetScreenPowerModeCommand=function') ? patchScreenPower(media) : media;
            return power.includes('t.createPlayer=function(e,t,r){var n=this.getPlayerClass(e);if(n)return new n(t,r)}') ? patchLowLatency(power) : power;
          });
          return;
        }
        if (injectControls && proxyRes.statusCode === 200) {
          writeTextProxyResponse(proxyRes, res, (body) => {
            // 移动控制层沿用编排服务静态资源，不加载外部脚本
            const rtcScript = process.env.PHONE_RTC_CONFIG ? '<script src="../adaptive-quality.js"></script><script src="../phone-rtc.js"></script>' : '';
            const script = '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><meta name="mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-status-bar-style" content="black-translucent"><meta name="theme-color" content="#05070b"><link rel="manifest" href="../manifest.webmanifest"><link rel="stylesheet" href="../mobile.css"><script src="../player-progress.js"></script><script src="../reconnect.js"></script><script src="../screen-power.js"></script><script src="../safari-media.js"></script><script src="../low-latency-core.js"></script>' + rtcScript + '<script src="../low-latency.js"></script><script src="../scrcpy-official-controls.js"></script><script defer src="../mobile.js"></script><script defer src="../media-settings.js"></script><script charset="utf-8" defer src="../vendor/opus-decoder.min.js"></script><script defer src="../phone-audio.js"></script>';
            // 替换引擎原视口声明，避免多个 viewport 由浏览器择一生效
            body = body.replace(/<meta\b(?=[^>]*\bname\s*=\s*["']viewport["'])[^>]*>/gi, '');
            if (body.includes('<script defer="defer" src="bundle.js"></script>')) {
              return body.replace('<script defer="defer" src="bundle.js"></script>', `${script}<script defer="defer" src="bundle.js"></script>`);
            }
            return body.includes('</head>') ? body.replace('</head>', `${script}</head>`) : `${script}${body}`;
          });
          return;
        }

        if (!injectStreamCss || proxyRes.statusCode !== 200) {
          res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
          proxyRes.on('error', (e) => logProxySocketError('http upstream response error', e));
          res.on('error', (e) => {
            logProxySocketError('http client response error', e);
            destroyQuietly(proxyRes);
          });
          proxyRes.pipe(res);
          return;
        }

        const headers = { ...proxyRes.headers };
        delete headers['content-length'];
        headers['content-type'] = headers['content-type'] || 'text/css; charset=utf-8';
        res.writeHead(proxyRes.statusCode, headers);
        proxyRes.on('data', (chunk) => {
          if (!res.destroyed) res.write(chunk);
        });
        proxyRes.on('end', () => {
          if (!res.destroyed) res.end(SCRCPY_STREAM_CSS);
        });
        proxyRes.on('error', (e) => {
          logProxySocketError('http css response error', e);
          if (!res.destroyed) res.end();
        });
      }
    );

    proxyReq.on('error', (e) => {
      console.error(`[scrcpy-proxy] http error: ${e.message}`);
      if (!res.headersSent) {
        res.status(502).send('scrcpy engine proxy error');
      } else {
        res.end();
      }
    });

    req.on('aborted', () => destroyQuietly(proxyReq));
    req.on('error', (e) => {
      logProxySocketError('http client request error', e);
      destroyQuietly(proxyReq);
    });
    res.on('error', (e) => {
      logProxySocketError('http client response error', e);
      destroyQuietly(proxyReq);
    });
    req.pipe(proxyReq);
  };
}

function createScrcpyUpgradeProxy({ buildProxyPath, wsScrcpyHost, wsScrcpyPort }) {
  return function proxyScrcpyUpgrade(req, socket, head) {
    let connected = false;
    let closed = false;
    const closeBoth = () => {
      if (closed) return;
      closed = true;
      destroyQuietly(upstream);
      destroyQuietly(socket);
    };

    const upstream = net.connect(wsScrcpyPort, wsScrcpyHost, () => {
      connected = true;
      const proxyPath = buildProxyPath(req.url);
      // Recreate the HTTP upgrade request to proxy raw WebSocket sockets
      const headers = Object.entries({
        ...req.headers,
        host: `${wsScrcpyHost}:${wsScrcpyPort}`,
      })
        .map(([key, value]) => `${key}: ${value}`)
        .join('\r\n');
      upstream.write(`${req.method} ${proxyPath} HTTP/${req.httpVersion}\r\n${headers}\r\n\r\n`);
      if (head && head.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });

    upstream.on('error', (e) => {
      logProxySocketError('websocket upstream error', e);
      if (!connected && socket.writable && !socket.destroyed) {
        try {
          socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
        } catch (_) {
          /* ignore */
        }
      }
      closeBoth();
    });
    socket.on('error', (e) => {
      logProxySocketError('websocket client error', e);
      closeBoth();
    });
    upstream.on('close', closeBoth);
    socket.on('close', closeBoth);
  };
}

function registerScrcpyProxyRoutes(app, options) {
  const proxyScrcpyHttp = createScrcpyHttpProxy(options);

  // 只允许当前同源页面释放已有屏幕租约，不提供 shell、按键或任意模式入口
  app.post(options.appPath('/api/screen-power/release'), async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (req.get('origin') !== `${req.protocol}://${req.get('host')}`) return res.status(403).json({ ok: false });
    const body = req.body;
    if (!body || Object.keys(body).sort().join(',') !== 'lease,serial,token' || typeof body.serial !== 'string' || !body.serial || body.serial.length > 512 || typeof body.token !== 'string' || typeof body.lease !== 'string' || !/^[a-f0-9]{32}$/.test(body.token) || !/^[a-f0-9]{32}$/.test(body.lease)) return res.status(400).json({ ok: false });
    const result = await releaseWarmScreen(req, body);
    const { status, ...payload } = result;
    res.status(status).json(payload);
  });

  for (const base of options.routeBases) {
    app.get(new RegExp(`^${options.escapeRegExp(base)}/scrcpy$`), (_req, res) => {
      res.redirect(`${base}/scrcpy/`);
    });
  }

  app.get(options.appPath('/scrcpy-official-controls.js'), (_req, res) => {
    res.type('application/javascript').send(SCRCPY_OFFICIAL_CONTROL_JS);
  });
  app.use(options.appPath('/scrcpy/'), proxyScrcpyHttp);
}

function createScrcpyUpgradeHandler(options) {
  const proxyScrcpyUpgrade = createWarmScrcpyUpgradeProxy({
    ...options,
    fallback: createScrcpyUpgradeProxy(options),
  });
  return function handleScrcpyUpgrade(req, socket, head) {
    const url = req.url || '';
    if (!options.isScrcpyPath(url)) {
      socket.destroy();
      return;
    }

    if (options.platform !== 'synology') {
      proxyScrcpyUpgrade(req, socket, head);
      return;
    }

    options.runDsmAuth(req).then((auth) => {
      if (auth.ok) return proxyScrcpyUpgrade(req, socket, head);
      try {
        socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      } catch (_) {
        socket.destroy();
      }
    });
  };
}

module.exports = { registerScrcpyProxyRoutes, createScrcpyUpgradeHandler };
