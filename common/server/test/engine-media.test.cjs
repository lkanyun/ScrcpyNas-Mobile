// Modified in the Mobile Remote derivative (2026): mobile UI, media transport or recovery changes; see MODIFICATIONS.md.
'use strict'
const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

// 从实际交付包提取原播放器检查函数，以可控时钟验证断流后的追赶
function recoveryHarness(bundle, { current = 1.5, end = 3.9, maxBuffer = 2 } = {}) {
  const start = 't.prototype.checkForBadState='
  const stop = ',t.prototype.checkForIFrame='
  const source = bundle.split(start)[1].split(stop)[0]
  let now = 1000
  const seeks = []
  const listeners = new Map()
  const tag = {
    buffered: { length: 1, end() { return end } },
    // 记录播放器注册的媒体事件
    addEventListener(type, callback) { listeners.set(type, callback) },
    // 清理恢复完成的媒体事件
    removeEventListener(type) { listeners.delete(type) },
    // 隔离仅与追赶无关的播放承诺
    play() {},
    // 提供模拟媒体时钟
    get currentTime() { return current },
    // 记录实际播放器请求的 seek 位置
    set currentTime(value) { current = value; seeks.push(value) },
  }
  const player = { tag, lastTime: -1, noDecodedFramesSince: -1, currentTimeNotChangedSince: -1, bigBufferSince: -1, aheadOfBufferSince: -1, seekingSince: -1, MAX_TIME_TO_RECOVER: 200, MAX_BUFFER: maxBuffer, MAX_AHEAD: -0.2 }
  const warnings = []
  const check = vm.runInNewContext('(' + source + ')', { Date: { now: () => now }, console: { warn(...args) { warnings.push(args.join(' ')) } } })
  return {
    player, seeks, warnings,
    // 推进媒体时钟以排除独立的静止画面恢复条件
    tick(ms, progress = 0.001) { now += ms; current += progress; check.call(player) },
    // 模拟真实 seeked 事件完成原有恢复周期
    seeked() { listeners.get('seeked')?.() },
  }
}

// 保留 Safari 容差和等待时间，仅消除缓冲末端的小数截断
test('engine catches fractional buffered lead after the existing recovery grace', () => {
  const { patchEngineMedia } = require('../lib/engine-media')
  const original = fs.readFileSync(path.resolve(__dirname, '../../engine/public/bundle.js'), 'utf8')
  const old = recoveryHarness(original)
  old.tick(0, 0); old.tick(201)
  assert.deepEqual(old.seeks, [], 'baseline reproduces delayed fractional catch-up')
  const fixed = recoveryHarness(patchEngineMedia(original))
  fixed.tick(0, 0)
  fixed.tick(200)
  assert.deepEqual(fixed.seeks, [], 'retain recovery grace')
  fixed.tick(1)
  assert.deepEqual(fixed.seeks, [3.9], 'catch up inside buffered media without truncating the lead')
})

// 拒绝未知或重复函数，避免引擎升级时静默应用局部补丁
test('engine patch rejects ambiguous and changed compatibility targets', () => {
  const { patchEngineMedia } = require('../lib/engine-media')
  const original = fs.readFileSync(path.resolve(__dirname, '../../engine/public/bundle.js'), 'utf8')
  const target = 'var i=this.tag.buffered.end(0),o=i-t;if((0|i)-t>this.MAX_BUFFER?'
  assert.throws(() => patchEngineMedia(original.replace(target, target.replace('(0|i)', '(i|0)'))), /Unsupported engine/)
  assert.throws(() => patchEngineMedia(original + target), /Unsupported engine/)
  const patched = patchEngineMedia(original)
  assert.equal(patchEngineMedia(patched), patched)
  assert.throws(() => patchEngineMedia(patched + 'e.sourceBuffer.addEventListener("updateend",function(){'), /Unsupported engine/)
})

// 验证追赶仍受原有阈值、连续等待和进行中 seek 的保护约束
test('engine catch-up retains threshold grace reset and seek cooldown bounds', () => {
  const { patchEngineMedia } = require('../lib/engine-media')
  const bundle = patchEngineMedia(fs.readFileSync(path.resolve(__dirname, '../../engine/public/bundle.js'), 'utf8'))
  for (const maxBuffer of [2, 0.9, 0.2]) {
    const within = recoveryHarness(bundle, { current: 1.5, end: 1.5 + maxBuffer, maxBuffer })
    within.tick(0, 0); within.tick(201)
    assert.deepEqual(within.seeks, [], 'no seek at or below the existing threshold')
    const excess = recoveryHarness(bundle, { current: 1.5, end: 1.5 + maxBuffer + 0.05, maxBuffer })
    excess.tick(0, 0); excess.tick(201)
    assert.deepEqual(excess.seeks, [1.5 + maxBuffer + 0.05])
  }
  const reset = recoveryHarness(bundle)
  reset.tick(0, 0)
  reset.tick(100, 0.5)
  reset.tick(100, -0.5)
  reset.tick(200)
  assert.deepEqual(reset.seeks, [], 'brief recovery resets continuous excess timer')
  reset.tick(1)
  assert.deepEqual(reset.seeks, [3.9])
  const busy = recoveryHarness(bundle)
  busy.player.seekingSince = 900
  busy.tick(0, 0); busy.tick(201)
  assert.deepEqual(busy.seeks, [], 'do not interrupt pending seek')
  busy.tick(1198)
  assert.deepEqual(busy.seeks, [], 'retain original seek protection interval')
  busy.tick(1)
  assert.deepEqual(busy.seeks, [3.9])
  assert.equal(busy.warnings.length, 1, 'retain original warning for an expired pending seek')
  busy.seeked()
  busy.tick(1, -2.4); busy.tick(201)
  assert.deepEqual(busy.seeks, [3.9, 3.9], 'seeked releases the original protection lifecycle')
})

// 用引擎真实回调验证改画质后已移除缓冲区不会继续访问和抛错
test('engine ignores stale updateend after switching media sources but retains live callbacks', () => {
  const { patchEngineMedia } = require('../lib/engine-media')
  const original = fs.readFileSync(path.resolve(__dirname, '../../engine/public/bundle.js'), 'utf8')
  const patched = patchEngineMedia(original)
  const marker = 'e.sourceBuffer.addEventListener("updateend",function(){'
  const callback = patched.split(marker)[1].split('}),e.sourceBuffer.')[0]
  let reads = 0
  const e = { sourceBuffer: { get buffered() { reads++; throw new Error('detached SourceBuffer') } }, mediaSource: { readyState: 'closed', sourceBuffers: [] } }
  new Function('e', 'o', callback)(e, { log() {} })
  assert.equal(reads, 0)
  assert.equal(patchEngineMedia(patched), patched)
})
