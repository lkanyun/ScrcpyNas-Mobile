# 旧 JAR 视频消息合同与 High 原生解码

## 已审计的边界

- 仓库 `common/engine/vendor/Genymobile/scrcpy/scrcpy-server.jar` SHA256：`baae6ce9db8379ccd820277739f5005876564f4744f97756107445439813a920`
- 对该二进制实际 DEX 的 `ScreenEncoder.encode` 审计：`dequeueOutputBuffer` → `getOutputBuffer(outputBufferId)` → `Connection.send(codecBuffer)` → `releaseOutputBuffer`。每次完整输出 ByteBuffer 调用一次 send，没有按 NAL、slice 或 TCP 大小拆包，也没有拼接相邻输出缓冲
- 实际 DEX 的 `WebSocketConnection.send(ByteBuffer)` 对连接直接调用 `WebSocket.send(data)`；`WebSocketImpl.send(ByteBuffer)` 经过 `Draft_6455.createFrames(ByteBuffer, boolean)` 创建一个 `BinaryFrame` 和 singleton list。网络/TCP 分段不改变浏览器 WebSocket message 终点
- `sendFrameMeta=true` 时，`writeFrameMeta` 先另发一个头消息，然后才发送编码缓冲。当前原生路径只接受 `false`，否则显式停止，状态为 `frame-metadata-unsupported`，不假装低延迟已生效
- 配置输出缓冲同样发送，不含图像时不能当作帧。可能含 SPS+PPS，也可分开发送；完整图像可能含多个 VCL NAL/slice，不等于每个 NAL 一张图像
- `scrcpy_initial` 和 `scrcpy_message` 是其他协议消息，原引擎 `StreamReceiver.onSocketMessage` 先分流，再将每条视频消息完整交给 `StreamClient`。暖流代理逐 message 转发，普通升级代理逐字节转发 WebSocket framing，都没有重组应用层媒体消息

### 原始来源

二进制是本次边界结论的依据；以下 fork 源码仅交叉核对，不将修改过的仓库 JAR 等同于上游构建：

- [NetrisTV ScreenEncoder，固定提交](https://github.com/NetrisTV/scrcpy/blob/a965ae33362d061ac83b697ba6b7df25d1dc00fc/server/src/main/java/com/genymobile/scrcpy/ScreenEncoder.java)，`encode`、`writeFrameMeta`
- [NetrisTV WebSocketConnection，固定提交](https://github.com/NetrisTV/scrcpy/blob/a965ae33362d061ac83b697ba6b7df25d1dc00fc/server/src/main/java/com/genymobile/scrcpy/WebSocketConnection.java)，`send`
- [AOSP MediaCodec.java](https://android.googlesource.com/platform/frameworks/base/+/refs/heads/main/media/java/android/media/MediaCodec.java)，Compressed Buffers：编码器视频输出正常是一张完整压缩图像，缓冲以帧/AU 边界结束，不是任意字节片段；明确存在 `BUFFER_FLAG_PARTIAL_FRAME` 例外
- [AOSP MediaCodecInfo.java](https://android.googlesource.com/platform/frameworks/base/+/refs/heads/main/media/java/android/media/MediaCodecInfo.java)，`AVCProfileHigh = 0x08`。Android profile 枚举不是 SPS profile_idc；High SPS profile_idc 是 100（0x64）

## 适用范围与不能声称的保证

此适配器用于已审计旧 JAR 的普通 AVC 编码器完整输出、`sendFrameMeta=false`，不是通用 Annex-B 连续流解析器。它不根据定时器或“看起来像包”猜 AU，不支持任意第三方代理重新分割应用层消息。

旧协议没有传递 BufferInfo flags/PTS，因而浏览器不能检测生产者的 `BUFFER_FLAG_PARTIAL_FRAME`，也不能恢复 B 帧捕获 PTS。这次验证覆盖 no-B 的 High/CABAC 和 Baseline 多切片，不宣称任意编码器、partial-frame、batched-output 或 B 帧重排序都受支持。若现场出现上述例外，不能再加受限 slice parser 猜边界；应切换官方现代 scrcpy 标准 framed 协议以携带 flags/PTS。当前修改没有悄悄更换 Android JAR，也没有新开手机采集来测这些例外。

## 生产实现

`LegacyAccessUnitAdapter` 在每条消息末尾结束最后一个 NAL，缓存有界 SPS/PPS，按 SPS 固定头派生 `avc1.PPCCLL`，按 IDR NAL 判断 key/delta。High、CABAC、多切片的完整 H264 语法由原生 VideoDecoder 处理；无需自写完整 SPS/PPS/slice 解析器，也没有引入 Tango 的不完整 scaling-list 解析副本。

尺寸不是靠手写 SPS parser 猜测，来自原生 VideoFrame 的真实 displayWidth/displayHeight，再进入原有触控几何层。没有 `description` 的 AVC WebCodecs 配置使用 Annex-B，在 IDR 前附带缓存参数集。配置内容变化即使 codec 字符串相同，也使解码和进展观察器换代，并重新等待 IDR。

保留原生提交深度上限、有限异步配置排队、整条依赖链重同步、有限 IDR 请求和单张待绘 VideoFrame。初始化 isConfigSupported 稍慢不再无故扔掉一个 GOP；真正溢出仍丢整条依赖链，不跳着提交损坏 delta。参数集、单 AU 均有字节限制。后台/退出/认证/恢复沿用既有清理和租约边界。

## 回归验收

- 二进制 SHA 变化会使 `legacy-video-contract.test.cjs` 失败，必须重新审计合同；执行真实 vendor 接收回调验证 message 字节不被拆合
- `webcodecs-core.test.cjs` 覆盖 High 即时交付、配置专用消息、分开发送 SPS/PPS、同 codec 参数变更、Baseline 多切片末图、畸形消息、字节限制、背压、异步关闭及迟到回调
- `webcodecs-lifecycle.test.cjs` 的正常原生场景改用 High/CABAC/no-B 三切片；合成配置用 ffprobe 与 FFmpeg trace_headers 验证，不用 profile 参数名代替真实码流检查
- 单张 High 图像后输入保持静默，必须在没有下一图、没有 flush 时真正解码和绘制
- 持续 High 576×1280 与 Baseline 320×240 各提交约 120 张完整图像，要求原生输出完整、真实绘制比例不低于 90%、无 MSE 回退、无依赖链重置，分别报告提交/输出/绘制和队列深度
- 接收端入队到 draw 的合成延迟只是浏览器段测量，不包括手机捕获、编码、无线 ADB、真实 iPhone 显示或触控到光子

完整测试命令和当前机器的可执行路径见交接记录；生产不依赖测试机浏览器路径。默认路径、发布步骤和当前实机反馈见 `WEB-CODECS-TRIAL.md`。
