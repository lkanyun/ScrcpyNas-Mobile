# 温会话接入说明（连接生命周期）

已完成接入和部署：scrcpy-proxy 温代理与同步脚本注入、private-session logout 撤销均已合并。公网真实 Linux WebKit 验证后台 detach→自动鉴权恢复、相同初始化元数据、视频持续推进、不调用 prepare/connect、CSS沉浸恢复、logout关闭活跃温流。物理 iPhone 切App仍待用户验收。以下保留维护接入参考。

## 必需接入点

1. `lib/scrcpy-proxy.js` 顶部引入：

```js
const { createWarmScrcpyUpgradeProxy } = require('./warm-stream')
```

在 `createScrcpyUpgradeHandler(options)` 中，将

```js
const proxyScrcpyUpgrade = createScrcpyUpgradeProxy(options)
```

替换为

```js
const proxyScrcpyUpgrade = createWarmScrcpyUpgradeProxy({
  ...options,
  fallback: createScrcpyUpgradeProxy(options),
})
```

其余鉴权顺序不可改变：现有 Synology `runDsmAuth` 或站点外层认证必须先于 `proxyScrcpyUpgrade`，不能新增无认证 upgrade 入口。私有站点仍依赖现有入口代理对每次升级的会话检查。模块自身不实现认证，只按请求 Cookie/Authorization 的 SHA-256 摘要隔离已认证连接。

2. 同文件 HTML 注入字符串中，在任何引擎 `bundle.js` 之前增加**非 defer**脚本：

```html
<script src="../reconnect.js"></script>
```

它必须在引擎创建原生 WebSocket 前运行。不要在 `app-stream.js` 的 `prepareStream()` 流程中恢复；该接口会杀掉保温中的设备进程。

3. `lib/private-session.js` 顶部引入：

```js
const { revokeWarmStreams } = require('./warm-stream')
```

在成功的 `/session/logout` 的 `req.session.destroy` 回调中，`if (error) return next(error)` 之后、清 Cookie/响应之前调用：

```js
revokeWarmStreams(req)
```

必须同一请求 Cookie 尚在时调用。它关闭该认证摘要下的活动与闲置投屏上游，不关闭其他认证摘要。未接这一点不能声称 logout 已完整撤销温连接。

## 行为与取舍

- 当前仓库 `1.19-ws7` Node 引擎没有 `deviceServer kill timeout` 配置：`WebsocketProxy.release()` 直接关闭 Android 上游；Android JAR 的最后一个 socket 离开会释放 encoder。未修改第三方 bundle/JAR。
- 新代理保留唯一现有引擎连接，浏览器隐藏时主动关闭浏览器端，空闲计时默认 `600000 ms`。回来用同一标签页随机令牌接管，不再建立第二条 Android 视频连接；超时关闭上游。
- 只缓存 `scrcpy_initial` 初始化元数据，最多 `1 MiB`，不缓存视频帧、不写磁盘。离线帧直接丢弃。原生新页面发送流设置后，旧 Android WebSocket 服务的 `join()` 会重新失效编码流，使新解码器拿到初始化数据；真实设备/iPhone仍需验收。
- 标签页令牌存 sessionStorage，Cookie/Authorization 摘要、令牌与目标 URL 共同隔离。认证 Cookie 改变后不会接管旧身份连接。
- 只保温 `action=proxy-adb&remote=tcp:8886` 且无额外 path 的原生投屏请求；其他 WebSocket 仍走旧代理。待发送控制消息与浏览器发送积压均有大小上限。
- 前台自动检查 `/api/auth` 后重载原投屏页面；不走 prepare/connect，不猜测旧 ADB 端口。401/403 停止重试；临时故障指数退避至最大 30 秒。重载次数在标签页内保留以避免快速刷新循环。
- Android 设备离线/上游本身断开时不能继续保温；模块不会自动 `adb connect`。服务重启后内存温会话不保留。Safari 若完全杀掉标签页/清掉 sessionStorage，则只能重新建立会话。
- iOS 后台挂起无法保证 JavaScript 继续运行；正常 visibilitychange 会主动断开浏览器使服务器开始计时。若系统直接杀进程且未送达关闭事件，超时起点仍取决于底层 TCP 发现断开，不能承诺从切 App 的绝对时刻精确计时。
- 重新载入 iframe 可能退出原生全屏；CSS 外层沉浸状态是否恢复由现有父页面控制，不声称无闪屏或零延迟。

## 已运行验证

```sh
NODE_PATH=common/engine/node_modules node --test common/server/test/warm-stream.test.cjs common/server/test/reconnect.test.cjs
```

10/10 通过。核心新增行为逐轮先失败再实现：缺失温会话/恢复模块、OPEN 假活、临时故障退避、后台主动 detach、跨重载退避与稳定流恢复退避均见到 RED 后 GREEN。后端使用真实回环 HTTP/WebSocket；100 ms 超时夹具验证原上游复用、活动时不被旧计时器清理、最后浏览器离开才计时、到期确实关闭；额外覆盖元数据重放、离线帧丢弃、认证隔离、401 拒绝与按身份撤销。前端用 VM/事件/可控时钟验证恢复决策，不冒充真实 iPhone 验收。

合并时的全套命令：

```sh
NODE_PATH=./test-deps/node_modules:common/engine/node_modules \
PLAYWRIGHT_BROWSERS_PATH=./test-deps/browsers \
node --test common/server/test/*.test.cjs
```

最后一次运行全套为 41/42 通过，唯一失败是现有 session.test.cjs 缺 `express-session` 依赖，并非断言失败；最新独立连接生命周期测试为 10/10。`git diff --check` 与两个新增生产脚本的 `node --check` 均通过。需父任务具备原会话依赖后重跑全套以及接入后的代理/退出集成测试。
