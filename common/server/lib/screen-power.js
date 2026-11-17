// Modified in the Mobile Remote derivative (2026): mobile UI, media transport or recovery changes; see MODIFICATIONS.md.
'use strict'

// 已核对随包旧引擎和同哈希安卓服务端，正常面板模式不是布尔真值
const ORIGINAL_POWER = 'i=o.writeInt8(r.type,i),o.writeUInt8(e?1:0,i),r.buffer=o,r'
const FIXED_POWER = 'i=o.writeInt8(r.type,i),o.writeUInt8(e?2:0,i),r.buffer=o,r'

// 仅修复原生屏幕电源序列化器，不改消息类型或其他输入命令
function patchScreenPower(source) {
  const original = source.split(ORIGINAL_POWER).length - 1
  const fixed = source.split(FIXED_POWER).length - 1
  if (original + fixed !== 1) throw new Error('Unsupported engine screen power serializer')
  return original ? source.replace(ORIGINAL_POWER, FIXED_POWER) : source
}

module.exports = { patchScreenPower }
