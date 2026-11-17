// Modified in the Mobile Remote derivative (2026): mobile UI, media transport or recovery changes; see MODIFICATIONS.md.
'use strict'

// 仅修补已知旧引擎回调，不修改第三方包文件或改变视频协议
function patchEngineMedia(bundle) {
  const marker = 'e.sourceBuffer.addEventListener("updateend",function(){'
  const guard = 'if(!e.sourceBuffer||e.mediaSource.readyState!=="open"||!Array.prototype.includes.call(e.mediaSource.sourceBuffers,e.sourceBuffer))return;'
  // 同时验证原始和已修补目标的唯一性，避免只应用一半兼容修复
  const lead = 'var i=this.tag.buffered.end(0),o=i-t;if((0|i)-t>this.MAX_BUFFER?'
  const preciseLead = 'var i=this.tag.buffered.end(0),o=i-t;if(o>this.MAX_BUFFER?'
  const originalCount = bundle.split(lead).length - 1
  const patchedCount = bundle.split(preciseLead).length - 1
  if (bundle.split(marker).length !== 2 || originalCount + patchedCount !== 1) {
    throw new Error('Unsupported engine media callback or buffer check; review compatibility patch')
  }
  if (!bundle.includes(marker + guard)) bundle = bundle.replace(marker, marker + guard)
  // 复用原有浮点时差，保留各浏览器阈值、恢复等待与 seek 保护间隔
  // 横屏画面在竖屏手机上顺时针展开时，将指针还原到未旋转的触摸层坐标
  const touchMarker = 'h=e.clientX-l.left,p=e.clientY-l.top,m=!1;'
  const touchRotation = 'if(a.ownerDocument.documentElement.classList.contains("stream-rotated")){h=e.clientY-l.top;p=l.right-e.clientX;}'
  if (bundle.split(touchMarker).length !== 2) throw new Error('Unsupported engine touch mapping; review rotation patch')
  if (!bundle.includes(touchMarker + touchRotation)) bundle = bundle.replace(touchMarker, touchMarker + touchRotation)
  return originalCount ? bundle.replace(lead, preciseLead) : bundle
}

module.exports = { patchEngineMedia }
