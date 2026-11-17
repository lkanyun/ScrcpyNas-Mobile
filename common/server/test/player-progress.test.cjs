// Modified in the Mobile Remote derivative (2026): mobile UI, media transport or recovery changes; see MODIFICATIONS.md.
'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const path = require('node:path')

// 只测试进展登记与世代隔离，不把登记调用冒充浏览器真实解码
function fixture() {
  const listeners = new Map()
  const window = { addEventListener(name, fn) { listeners.set(name, fn) }, dispatchEvent() {} }
  const document = { querySelector() { return null } }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/player-progress.js'), 'utf8'), { window, document, performance: { now: () => 1 }, Object, Event })
  return { api: window.scrcpyNasProgress, listeners }
}

test('canvas progress needs native output plus actual draw and retires old owners', () => {
  const { api } = fixture()
  const canvas = { width: 320, height: 240 }
  const first = api.register(canvas, 'webcodecs')
  assert.equal(api.read().ready, false)
  first.output()
  assert.equal(api.read().ready, false)
  first.draw()
  assert.equal(api.read().ready, true)
  assert.equal(api.read().drawnSeq, 1)
  first.output(); first.output(); first.draw(); first.draw()
  assert.equal(api.read().drawnSeq, 2, 'dropped native outputs cannot authorize duplicate draw progress')
  const second = api.register(canvas, 'webcodecs')
  first.draw()
  assert.equal(api.read().ready, false)
  assert.notEqual(second.owner, first.owner)
  second.output(); second.draw()
  assert.equal(api.read().drawable, canvas)
  second.close()
  assert.equal(api.read().ready, false)
})

test('terminal lifecycle permanently retires a canvas generation', () => {
  for (const name of ['scrcpynas:recovering', 'scrcpynas:disconnect', 'scrcpynas:auth-denied', 'pagehide']) {
    const { api, listeners } = fixture()
    const first = api.register({ width: 320, height: 240 }, 'webcodecs')
    first.output(); first.draw()
    listeners.get(name)()
    first.output(); first.draw()
    assert.equal(api.read().ready, false, name)
  }
})
