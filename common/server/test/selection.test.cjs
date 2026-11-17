// Modified in the Mobile Remote derivative (2026): mobile UI, media transport or recovery changes; see MODIFICATIONS.md.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

// 使用隔离设备和接口夹具，测试实际设备选择函数而不接触手机
function fixture(online, record, connection = { ok: false, error: '测试连接被拒绝' }) {
  const empty = { textContent: '', classList: { remove() {}, add() {} } };
  const calls = [];
  const ctx = vm.createContext({
    records: [record], currentDevices: online, selectedRecordId: '', selectedSerial: '', selectedIsUsb: false,
    apiUrl: x => x, $: () => empty,
    api: async () => ({ ok: true, devices: online }),
    postJson: async (url, payload) => { calls.push({ url, payload }); return connection; },
  });
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../public/app-devices.js'), 'utf8'), ctx);
  ctx.renderSelectedDevice = () => {};
  ctx.renderRecordListSelection = () => {};
  ctx.loadDevices = async () => {};
  ctx.loadLogs = async () => {};
  ctx.openMirror = async serial => calls.push({ open: serial });
  return { ctx, calls, empty };
}

// 已连接的发现设备应直接打开投屏，不能向缺IP的网络连接接口发请求
 test('selecting online mDNS record opens stream without empty-IP connect', async () => {
  const record = { id: 'r1', transport: 'usb', serial: 'test._adb-tls-connect._tcp', ip: '' };
  const f = fixture([{ serial: record.serial, state: 'device' }], record);
  await f.ctx.connectRecord(record.id);
  assert.equal(f.calls.some(x => x.url === '/api/connect'), false);
  assert.equal(f.calls.some(x => x.open === record.serial), true);
});

// 发现设备离线时应有明确提示而不是静默保留占位文本
 test('offline discovery record shows actionable error without bogus connect', async () => {
  const record = { id: 'r1', transport: 'usb', serial: 'test._adb-tls-connect._tcp', ip: '' };
  const f = fixture([], record);
  await f.ctx.connectRecord(record.id);
  assert.equal(f.calls.length, 0);
  assert.match(f.empty.textContent, /离线|未在线/);
});

// 普通网络设备依然通过原生连接接口并将失败展示给用户
 test('network connection failure is visible', async () => {
  const record = { id: 'r1', transport: 'network', serial: 'test:1234', ip: 'test', port: '1234' };
  const f = fixture([], record);
  await f.ctx.connectRecord(record.id);
  assert.match(f.empty.textContent, /测试连接被拒绝/);
});
