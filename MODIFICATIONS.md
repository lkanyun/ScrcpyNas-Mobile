# 衍生修改说明

基于 zgcwkjOpenProject/ScrcpyNas，保留原作者与许可证。下面文件相对本地保留的上游基线 011cb5d 有增改；此清单不是对所有原始代码的著作权声明。

主要改动为移动交互、WebRTC/Opus、画质适应、会话与分享、音画恢复、统计及测试。最近失败的增量 ICE/控制队列组合已撤回。

本次公开整理另改 README、忽略规则、通知文件、测试环境路径与登录表单的个人预填值，隔离来源未核验的产物；没有部署到线上。

## 带修改提示的源码

- `common/server/lib/api.js`
- `common/server/lib/engine-low-latency.js`
- `common/server/lib/engine-media.js`
- `common/server/lib/opus-stream.js`
- `common/server/lib/phone-audio-process.js`
- `common/server/lib/phone-audio.js`
- `common/server/lib/private-session.js`
- `common/server/lib/rtc-audio.js`
- `common/server/lib/rtc-media.js`
- `common/server/lib/rtc-network.js`
- `common/server/lib/rtc-packetizer.js`
- `common/server/lib/scrcpy-proxy.js`
- `common/server/lib/screen-power.js`
- `common/server/lib/viewer-share.js`
- `common/server/lib/warm-stream.js`
- `common/server/public/adaptive-quality.js`
- `common/server/public/app-core.js`
- `common/server/public/app-devices.js`
- `common/server/public/app-stream.js`
- `common/server/public/app-ui.js`
- `common/server/public/app.js`
- `common/server/public/index.html`
- `common/server/public/low-latency-core.js`
- `common/server/public/low-latency.js`
- `common/server/public/manage.html`
- `common/server/public/manage.js`
- `common/server/public/media-settings.js`
- `common/server/public/mobile.css`
- `common/server/public/mobile.js`
- `common/server/public/phone-audio.js`
- `common/server/public/phone-rtc.js`
- `common/server/public/player-progress.js`
- `common/server/public/reconnect.js`
- `common/server/public/safari-media.js`
- `common/server/public/screen-power.js`
- `common/server/public/share-view.html`
- `common/server/public/share-view.js`
- `common/server/rtc/apply-werift-fixes.cjs`
- `common/server/server.js`
- `common/server/test/adaptive-quality.test.cjs`
- `common/server/test/adaptive-settings.test.cjs`
- `common/server/test/audio-continuity.test.cjs`
- `common/server/test/audio-process-fixture.cjs`
- `common/server/test/audio-process.test.cjs`
- `common/server/test/decode-recovery.test.cjs`
- `common/server/test/device-home.test.cjs`
- `common/server/test/engine-low-latency.test.cjs`
- `common/server/test/engine-media.test.cjs`
- `common/server/test/fullscreen.test.cjs`
- `common/server/test/gesture.test.cjs`
- `common/server/test/legacy-video-contract.test.cjs`
- `common/server/test/legacy-video-fixture.cjs`
- `common/server/test/media-settings.test.cjs`
- `common/server/test/mobile.test.cjs`
- `common/server/test/navigation.test.cjs`
- `common/server/test/opus-stream.test.cjs`
- `common/server/test/opus-webkit.test.cjs`
- `common/server/test/phone-audio-preferences.test.cjs`
- `common/server/test/phone-audio.test.cjs`
- `common/server/test/player-progress.test.cjs`
- `common/server/test/reconnect.test.cjs`
- `common/server/test/recovery-transition.test.cjs`
- `common/server/test/rtc-audio.test.cjs`
- `common/server/test/rtc-engine.test.cjs`
- `common/server/test/rtc-transport.test.cjs`
- `common/server/test/safari-ui.test.cjs`
- `common/server/test/safari.test.cjs`
- `common/server/test/screen-power.test.cjs`
- `common/server/test/selection.test.cjs`
- `common/server/test/session.test.cjs`
- `common/server/test/settings-panel.test.cjs`
- `common/server/test/share-ui.test.cjs`
- `common/server/test/viewer-share.test.cjs`
- `common/server/test/wake-lock.test.cjs`
- `common/server/test/warm-stream.test.cjs`
- `common/server/test/webcodecs-core.test.cjs`
- `common/server/test/webcodecs-lifecycle.test.cjs`

## 其他调整

根 LICENSE 原样保留；包锁、第三方声明不改作者归属。版本与隔离范围见 docs/PUBLICATION.md 和 THIRD_PARTY_NOTICES.md。
