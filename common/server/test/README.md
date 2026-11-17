# 移动投屏回归测试

测试不连接真实设备，也不启动应用服务：它使用真实 HTTP 代理、现有引擎 CSS、新增静态资源和隔离的本机临时 HTTP 夹具。按 TDD 验证过缺失悬浮球、缩放菜单、拖动、全屏/断开、PWA、独立窗口行为、动态视口居中和持久化标签的失败，再逐项实现。

## 运行

需要 Node.js 与 Playwright Chromium。将测试依赖和浏览器下载到仓库之外，例如：

```sh
npm install --prefix "$TMPDIR/scrcpynas-mobile-tests" playwright
PLAYWRIGHT_BROWSERS_PATH="$TMPDIR/scrcpynas-mobile-tests/browsers" \
  "$TMPDIR/scrcpynas-mobile-tests/node_modules/.bin/playwright" install chromium
NODE_PATH="$TMPDIR/scrcpynas-mobile-tests/node_modules" \
PLAYWRIGHT_BROWSERS_PATH="$TMPDIR/scrcpynas-mobile-tests/browsers" \
  node --test common/server/test/mobile.test.cjs
```

可选 `MOBILE_SCREENSHOT=/绝对路径/menu.png` 保存菜单截图。测试结束会关闭浏览器和全部临时服务器，并断言无未捕获浏览器异常、无外部资源请求。

## 验证范围

- 触摸打开菜单；导航键的请求体、设备 hash 解码与非法输入拒绝
- 拖动后吸边、位置持久化、自动淡化、旋转后仍可达
- contain/cover 在横竖屏下视频和触摸层矩形完全一致
- 真实浏览器触摸命中触摸层，再执行从原引擎 bundle 提取的 `buildTouchOnClient`，验证 cover 非中心触摸映射，不仅检查 CSS
- 动态视觉视口缩小时的居中与安全区菜单避让
- 全屏请求被拒时的可退出 CSS 回退；断开失败保留页面、成功返回主页
- 本地 manifest、iPhone meta、无 service worker；桌面新标签与独立窗口同页跳转

## 限制

这里的 API 响应是明确的测试夹具，不代表真实 ADB 操作验证。导航白名单现包含 BACK/HOME/APP_SWITCH（187）；`navigation.test.cjs` 使用隔离路由依赖夹具验证 APP_SWITCH 映射，以及任意按键和文本仍被拒绝。真实设备、认证和锁屏测试与该夹具分开执行，不在这里输入密码。

未在实体 iPhone/Safari 上验证主屏幕安装、系统状态栏和原生全屏支持。CSS 回退不能隐藏 Safari 的系统地址栏；加入主屏幕后使用 standalone 可减少浏览器 UI。SVG 为自制本地图标，未增加 iOS PNG 图标。未增加 `/mobile` 或离线缓存。
