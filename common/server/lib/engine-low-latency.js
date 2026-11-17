// Modified in the Mobile Remote derivative (2026): mobile UI, media transport or recovery changes; see MODIFICATIONS.md.
'use strict'

// 只在已知引擎入口插入可选工厂和控制通道绑定，原 MSE 创建路径保持原样
function patchLowLatency(bundle) {
  const factory = 't.createPlayer=function(e,t,r){var n=this.getPlayerClass(e);if(n)return new n(t,r)}'
  // 使用模块自身的 require 闭包，不向全局泄露整个第三方引擎
  const replacement = 't.createPlayer=function(e,t,n){var p=window.scrcpyNasCreatePlayer&&window.scrcpyNasCreatePlayer(r,e,t,n);if(p)return p;var i=this.getPlayerClass(e);if(i)return new i(t,n)}'
  const binding = 'this.player=i,this.setTouchListeners(i)'
  const bound = 'this.player=i,i.bindLowLatencyClient&&i.bindLowLatencyClient(this),this.setTouchListeners(i)'
  for (const [original, next] of [[factory, replacement], [binding, bound]]) {
    if (bundle.includes(next)) continue
    if (bundle.split(original).length !== 2) throw new Error('Unknown engine low-latency anchor')
    bundle = bundle.replace(original, next)
  }
  return bundle
}
module.exports = { patchLowLatency }
