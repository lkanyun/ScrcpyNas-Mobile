// Modified in the Mobile Remote derivative (2026): mobile UI, media transport or recovery changes; see MODIFICATIONS.md.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { registerApiRoutes } = require('../lib/api');

// 使用路由依赖夹具验证白名单，不连接手机或发送任何真实输入
function inputFixture() {
  const routes = new Map();
  const calls = [];
  const app = {
    get() {},
    post(path, handler) { routes.set(path, handler); },
  };
  registerApiRoutes(app, {
    appPath: p => p,
    runAdb: async args => { calls.push(args); return { code: 0, out: '', err: '' }; },
  });
  return { handler: routes.get('/api/device/input'), prepare: routes.get('/api/stream/prepare'), calls };
}

// 准备视频复用现有服务，缺失时才启动，不能杀掉保温中的视频或旁路音频
 test('prepare preserves live video and starts only a missing legacy server', async () => {
  const f = inputFixture();
  await f.prepare({ body: { serial: 'fixture' } }, { json() {} });
  const script = f.calls[0].at(-1);
  assert.equal(f.calls[0].length, 4, 'ADB shell must receive one complete script, not unquoted nested sh -c');
  assert.match(script, /com\.genymobile\.scrcpy\.Server 1\.19-ws7 /);
  assert.match(script, /exit 0/);
  assert.match(script, /CLASSPATH=.*nohup app_process/);
  assert.doesNotMatch(script, /\bkill\b/);
 });

// 验证多任务映射为固定安卓按键而非任意命令
 test('APP_SWITCH sends Android key 187', async () => {
  const f = inputFixture();
  let status = 200;
  let result;
  const res = { status(s) { status = s; return this; }, json(v) { result = v; } };
  await f.handler({ body: { serial: 'test-device', type: 'key', key: 'APP_SWITCH' } }, res);
  assert.equal(status, 200);
  assert.equal(result.ok, true);
  assert.deepEqual(f.calls, [['-s', 'test-device', 'shell', 'input', 'keyevent', '187']]);
});

// 确认扩大导航白名单后仍拒绝文本和任意按键
 test('unsupported key and text never execute ADB', async () => {
  const f = inputFixture();
  for (const body of [
    { serial: 'test-device', type: 'key', key: 'POWER' },
    { serial: 'test-device', type: 'text', text: 'not-a-password' },
  ]) {
    let status = 200;
    const res = { status(s) { status = s; return this; }, json() {} };
    await f.handler({ body }, res);
    assert.equal(status, 400);
  }
  assert.deepEqual(f.calls, []);
});
