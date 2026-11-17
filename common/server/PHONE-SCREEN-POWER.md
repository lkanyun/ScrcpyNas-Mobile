# 安卓物理屏幕电源

## 行为

- 音画设置新增“控制时关闭安卓屏幕”，默认开启，按设备保存在 `scrcpyNas.screenOff.<udid>`，切换立即记忆
- 只在当前同源投屏通道收到数据且视频实际解码后，点击引擎已有的隐藏屏幕电源控件；不新增采集、不改变网页画面、触控映射或控制端 iPhone 常亮逻辑
- 关闭选项提交 NORMAL；如其他控制标签页仍要求黑屏，则保持 OFF，不互相争抢面板
- 短暂后台、恢复重载保留 OFF；显式退出、非恢复卸载、温会话到期、退出登录释放本页请求，最后一个 OFF 请求离开后，通过仍存在的旧上游提交 NORMAL，再释放上游
- 不发送电源键、解锁、系统休眠超时或亮度设置，不调用通用 ADB/shell/text 接口。NORMAL 只恢复物理显示电源模式，不解除安卓锁屏

## 固定版本证据

随仓库 JAR：`common/engine/vendor/Genymobile/scrcpy/scrcpy-server.jar`

SHA256：`baae6ce9db8379ccd820277739f5005876564f4744f97756107445439813a920`

该文件逐字节匹配 [NetrisTV/ws-scrcpy 的固定提交](https://github.com/NetrisTV/ws-scrcpy/blob/49d26231840cafcde77a3e778b804d8af498a5ac/vendor/Genymobile/scrcpy/scrcpy-server.jar)。对本地 `classes.dex` 直接反汇编确认：

- `ControlMessage.TYPE_SET_SCREEN_POWER_MODE = 10`
- `ControlMessageReader.parseSetScreenPowerMode` 读取一个原始字节，未把布尔值转换为电源模式
- `Device.POWER_MODE_OFF = 0`，`Device.POWER_MODE_NORMAL = 2`
- `Device.setScreenPowerMode` 最终调用 `SurfaceControl.setDisplayPowerMode`；面板操作不是按电源键

旧前端的 `createSetScreenPowerModeCommand` 错误地输出布尔 `0/1`，因此不能不经审查直接复用“ON”按钮。`lib/screen-power.js` 只把该原生序列化器的真值改为 NORMAL 2，明确校验唯一补丁锚点并支持重复应用。不改第三方 JAR 或 vendor bundle 原文件。

## 租约与退出接口

原温会话代理只拦截已初始化连接中的精确 `[10,0]` 和 `[10,2]`，拒绝未知电源模式或长度。其他既有引擎输入仍走原路径。

`POST /api/screen-power/release` 只接受字符串 `serial`、标签页 `token` 和每次文档创建的新 `lease`，拒绝额外字段、跨 Origin、错误认证范围及旧页面租约；不能创建上游、选择远程目标或执行任意输入。释放后的页面租约不可再次提交 OFF，新页面须通过新的租约接管。响应的 `submitted` 只表示帧已写入原有 WebSocket。

## 验证与边界

`test/screen-power.test.cjs` 使用真实回环 WebSocket、Chromium 及从实际引擎提取的序列化器，覆盖默认值、保存值、未连/未初始化不执行、原生 0/2 消息、即时切换、多个标签页、明确退出、后台保温、卸载恢复、通道故障及退出/重连竞态。浏览器真实解码媒体夹具使用 canvas captureStream，不连接手机。

旧 scrcpy 协议没有面板执行结果 ACK。网页不会把“命令已提交”冒充物理面板已经关闭；OEM 不支持时必须如实报告，不以锁屏或亮度替代。设备物理面板、电源/显示诊断和原投屏仍推进的联合验收需通过当前既有控制通道完成。

静态文件能独立访问不代表功能已激活：代理注入、原生 NORMAL 修复和跨标签页租约仲裁需要运行中的后端载入新代码。用户仍在使用时，必须先协调后端重启，不能自行重启或启动第二路手机采集。
