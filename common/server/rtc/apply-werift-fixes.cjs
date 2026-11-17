// Modified in the Mobile Remote derivative (2026): mobile UI, media transport or recovery changes; see MODIFICATIONS.md.
'use strict'
const fs = require('node:fs')
const path = require('node:path')
// 固定版本的 TURN 保活取消后仍等待长定时器 此修复让退出立即中止等待
const root = process.argv[2] || path.join(__dirname, 'node_modules/werift')
if (JSON.parse(fs.readFileSync(path.join(root, 'package.json'))).version !== '0.24.3') throw Error('Unaudited werift version')
const file = path.join(root, 'lib/ice/src/turn/protocol.js')
let source = fs.readFileSync(file, 'utf8')
const marker = '// ScrcpyNas cancel TURN refresh timer'
if (!source.includes(marker)) {
  const before = 'let run = true;\n                    onCancel.once(() => {\n                        run = false;\n                    });'
  const after = 'let run = true;\n                    ' + marker + '\n                    const refreshAbort = new AbortController();\n                    onCancel.once(() => {\n                        run = false;\n                        refreshAbort.abort();\n                    });'
  const wait = 'await (0, promises_1.setTimeout)(delay);'
  if (source.split(before).length !== 2 || source.split(wait).length !== 2) throw Error('Unknown TURN refresh implementation')
  source = source.replace(before, after).replace(wait, 'try { await (0, promises_1.setTimeout)(delay, undefined, { signal: refreshAbort.signal }); } catch (error) { if (run) throw error; }\n                        if (!run) break;')
  fs.writeFileSync(file, source)
}
console.log('werift 0.24.3 TURN cancellation patch verified')
