// Modified in the Mobile Remote derivative (2026): mobile UI, media transport or recovery changes; see MODIFICATIONS.md.
'use strict'
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const { execFileSync, spawnSync } = require('node:child_process')

// 生成本地合成图像并按编码器输出合同拆分配置缓冲和完整多切片图像
function legacyVideoFixture(dir, { profile = 'high', width = 320, height = 240, frames = 60, slices = 3 } = {}) {
  const file = path.join(dir, `${profile}-${width}-${height}.h264`)
  const high = profile === 'high'
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=size=${width}x${height}:rate=30`, '-frames:v', String(frames), '-an', '-c:v', 'libx264', '-threads', '1', '-preset', high ? 'medium' : 'ultrafast', '-tune', 'zerolatency', '-profile:v', profile, '-bf', '0', '-x264-params', `aud=1:repeat-headers=1:keyint=30:min-keyint=30:scenecut=0:slices=${slices}:sliced-threads=0:cabac=${high ? 1 : 0}:8x8dct=${high ? 1 : 0}`, '-f', 'h264', file])
  const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=profile,has_b_frames,width,height', '-of', 'json', file])).streams[0]
  assert.equal(probe.has_b_frames, 0)
  assert.equal(probe.profile, high ? 'High' : 'Constrained Baseline')
  const trace = spawnSync('ffmpeg', ['-v', 'verbose', '-i', file, '-c:v', 'copy', '-bsf:v', 'trace_headers', '-f', 'null', '-'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  assert.equal(trace.status, 0)
  assert.match(trace.stderr, new RegExp(`entropy_coding_mode_flag[^\\n]*= ${high ? 1 : 0}`))
  const bytes = fs.readFileSync(file)
  const starts = []
  for (let i = 0; i < bytes.length - 3; i++) if (bytes[i] === 0 && bytes[i + 1] === 0 && bytes[i + 2] === 1) starts.push({ start: i > 0 && bytes[i - 1] === 0 ? i - 1 : i, data: i + 3 })
  const pictures = []
  let picture = []
  let config = []
  for (let i = 0; i < starts.length; i++) {
    const nal = bytes.subarray(starts[i].data, starts[i + 1]?.start)
    const type = nal[0] & 31
    if (type === 9) { if (picture.length) pictures.push(picture); picture = [] }
    else if (type === 7 || type === 8) { if (!pictures.length) config.push(nal) }
    else picture.push(nal)
  }
  if (picture.length) pictures.push(picture)
  assert.equal(pictures.length, frames)
  assert.ok(pictures.every(p => p.filter(n => [1, 5].includes(n[0] & 31)).length === slices))
  // 规范化 Annex-B 起始码，AUD 仅用于夹具拆分，不进入生产输入
  const pack = nals => Buffer.concat(nals.flatMap(n => [Buffer.from([0, 0, 0, 1]), n]))
  const configuration = pack(config)
  return { probe, cabac: high, slices, configuration, parameterSets: config.map(n => pack([n])), pictures: pictures.map(pack), bytes }
}
module.exports = { legacyVideoFixture }
