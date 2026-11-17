// Modified in the Mobile Remote derivative (2026): mobile UI, media transport or recovery changes; see MODIFICATIONS.md.
'use strict';

// 页面入口只负责按顺序加载前端模块，业务逻辑分散在相邻文件中维护
(function loadAppScripts() {
  const scripts = [
    'app-core.js',
    'app-stream.js',
    'app-devices.js',
    'app-ui.js',
  ];
  const currentScript = document.currentScript && document.currentScript.src;
  const baseUrl = currentScript ? new URL('.', currentScript).toString() : './';

  function loadScript(name) {
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = new URL(name, baseUrl).toString();
      script.onload = resolve;
      script.onerror = () => reject(new Error(`加载 ${name} 失败`));
      document.head.appendChild(script);
    });
  }

  scripts
    .reduce((chain, name) => chain.then(() => loadScript(name)), Promise.resolve())
    .catch((e) => {
      const target = document.getElementById('device-home-feedback') || document.getElementById('mirrorEmpty') || document.body;
      target.textContent = e && e.message ? e.message : '页面脚本加载失败';
    });
})();

// 在前台低频续期浏览器凭证，不参与音视频处理，也不保存账号密码
(function keepLogin() {
  let lastAttempt = 0;
  let pending = false;
  // 恢复前台时补充续期，隐藏页面不主动延长登录期限
  async function renew() {
    if (document.hidden || pending || Date.now() - lastAttempt < 5 * 60 * 1000) return;
    pending = true;
    lastAttempt = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      await fetch('/session/account', { credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: controller.signal });
    } catch (_) {
      // 网络恢复后再续期，不中断当前播放
    } finally { clearTimeout(timeout); pending = false; }
  }
  window.addEventListener('pageshow', renew);
  document.addEventListener('visibilitychange', renew);
  setInterval(renew, 60 * 60 * 1000);
  renew();
})();
