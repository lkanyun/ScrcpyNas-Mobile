# Third-party notices

本清单适用于当前源码准备目录，不是对原完整运行包的再分发许可证明。主项目 Apache-2.0 不覆盖第三方自己的许可。

| 组件 | 版本 / 来源 | 许可 | 本目录处理 |
| --- | --- | --- | --- |
| ScrcpyNas | zgcwkjOpenProject/ScrcpyNas | Apache-2.0 | 保留原 LICENSE、作者归属与修改说明 |
| ws-scrcpy | 0.9.0-dev；NetrisTV/ws-scrcpy | MIT | 保留 LICENSE、manifest、lock；编译产物隔离 |
| scrcpy 视频派生服务 | 1.19-ws7；来源线索见依赖说明 | Apache-2.0 及内嵌组件各自许可 | 保留邻接 LICENSE，不分发待核验 JAR |
| scrcpy 音频服务 | Genymobile/scrcpy v3.3.3 | Apache-2.0，需核对精确制品 | 外部配置提供，本目录不含 JAR |
| opus-decoder | 0.7.12；eshaz/wasm-audio-decoders | MIT；libopus 为 BSD 式通知 | 保留未修改 min.js 和完整邻接通知；与 npm 原包字节一致 |
| Font Awesome | 4.7.0；Dave Gandy | 字体 SIL OFL 1.1；CSS MIT | 保留原署名，补随附许可 |
| werift | 0.24.3 | MIT；传递依赖各自许可 | lock 固定版本；保留 TURN 取消补丁，不附 node_modules |
| mediabunny | 1.66.0（RTC lock 传递依赖） | MPL-2.0 | 当前不分发实现；未来打包须保留通知并提供覆盖文件对应源码获取方式 |
| node-forge | 1.4.0（engine lock） | BSD-3-Clause OR GPL-2.0 | 如分发选择 BSD-3-Clause 并保留完整通知；不能将 OR 误读为强制 GPL |
| ADB | 两种架构的原制品来源待核验 | 内嵌组件分别核验 | 不分发原 ZIP，不用根 LICENSE 代替其许可证 |

运行依赖以各自 package-lock.json 为准，安装后必须复核随包 LICENSE/NOTICE。删除 node_modules 不会自动解决编入 bundle、WASM、JAR 或可执行文件里的第三方义务。

## 来源与归属

- [原项目](https://github.com/zgcwkjOpenProject/ScrcpyNas) 与 [许可证](https://raw.githubusercontent.com/zgcwkjOpenProject/ScrcpyNas/main/LICENSE)
- [ws-scrcpy](https://github.com/NetrisTV/ws-scrcpy) 与 [MIT](https://github.com/NetrisTV/ws-scrcpy/blob/master/LICENSE)
- [scrcpy](https://github.com/Genymobile/scrcpy) 与 [Apache-2.0](https://github.com/Genymobile/scrcpy/blob/master/LICENSE)
- [Opus 解码器](https://github.com/eshaz/wasm-audio-decoders)：本目录完整通知在 `common/server/public/vendor/opus-decoder.LICENSE.txt`
- [Font Awesome 4.7 许可说明](https://github.com/FortAwesome/Font-Awesome/blob/v4.7.0/src/license.html)：本目录通知位于 `common/server/public/lib/font-awesome/`
- [werift](https://github.com/shinyoshiaki/werift-webrtc)

本目录新绘制的 README 横幅为矢量示意，不是产品截图，也不含原平台图片、商标标识或用户画面。产品名用于描述兼容性，不代表获得官方背书。

## 制品发布前

补齐精确版本及哈希、构建来源、完整许可证和 NOTICE；涉及 MPL/LGPL 等组件时按实际链接与修改方式落实义务。将通知复制进最终安装包后，解包复查。宽松许可证软件缺少 source map 并不自动构成侵权；目前隔离的原因是无法核实完整组件归属，不是已经认定侵权。
