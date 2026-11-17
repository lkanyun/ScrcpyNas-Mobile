// Modified in the Mobile Remote derivative (2026): mobile UI, media transport or recovery changes; see MODIFICATIONS.md.
// 复用引擎已有视频参数命令，只增加移动端可操作的设置入口
;(function () {
  'use strict'
  const realtime = !!window.scrcpyNasRtc
  const adaptive = typeof window.scrcpyNasRtc?.getQuality === 'function'
  const sizes = [720, 960, 1280, 1600, 1920]
  const rates = realtime ? [500000, 600000, 1000000, 1400000, 1500000, 1600000, 2000000, 2200000, 2800000, 3200000, 4000000, 4500000, 6000000] : [1000000, 2000000, 4000000, 6000000, 8000000, 12000000]
  const frames = [24, 30, 60]
  const serial = new URLSearchParams(location.hash.replace(/^#!/, '')).get('udid')
  if (!serial) return
  // 将固定选项转换为表单，避免向底层透传任意编码器参数
  function options(values, format) {
    return values.map(value => `<option value="${value}">${format(value)}</option>`).join('')
  }
  // 仅定位引擎原生的视频设置区，不暴露剪贴板、文本或任意命令
  function nativeSettings() {
    return Array.from(document.querySelectorAll('.more-box .spoiler .box')).find(box => box.querySelectorAll('input').length === 5)
  }
  // 菜单异步出现时挂载一次，保持现有视频与全屏状态
  function mount() {
    const menu = document.querySelector('#mobile-menu')
    if (!menu || document.querySelector('#media-panel')) return
    const button = document.createElement('button')
    button.type = 'button'
    button.dataset.mobileAction = 'settings'
    button.textContent = '更多设置'
    menu.insertBefore(button, menu.querySelector('#mobile-status'))
    const panel = document.createElement('section')
    panel.id = 'media-panel'
    panel.hidden = true
    panel.setAttribute('role', 'dialog')
    panel.setAttribute('aria-label', '音画设置')
    panel.setAttribute('aria-modal', 'true')
    panel.innerHTML = `<header><span class="settings-eyebrow">控制中心</span><h2>音画设置</h2></header>
      <nav class="settings-tabs" role="tablist" aria-label="设置分类"><button id="settings-tab-common" type="button" role="tab" aria-selected="true" aria-controls="settings-common" data-settings-tab="common">常用</button><button id="settings-tab-video" type="button" role="tab" aria-selected="false" aria-controls="settings-video" data-settings-tab="video" tabindex="-1">画质</button><button id="settings-tab-details" type="button" role="tab" aria-selected="false" aria-controls="settings-details" data-settings-tab="details" tabindex="-1">详情</button></nav>
      <div id="media-content">
        <section id="settings-common" class="settings-page settings-group" role="tabpanel" aria-labelledby="settings-tab-common"><div class="settings-heading"><h3>声音与屏幕</h3><span>实时生效 · 自动保存</span></div><div id="media-live-controls" class="settings-card"><div id="media-audio-controls"></div><div id="media-screen-controls"></div></div></section>
        <section id="settings-video" class="settings-page settings-group" role="tabpanel" aria-labelledby="settings-tab-video" hidden><div class="settings-heading"><h3>视频画质</h3><span>调整后保存</span></div><div class="settings-card">
          ${adaptive ? '<label>画质模式<select id="media-quality-mode"><option value="auto">自动适应网络</option><option value="manual">手动设置</option></select></label>' : ''}
          <div id="media-manual-fields"><label>画面最长边<select id="media-resolution">${options(sizes, n => n + ' px')}</select></label>
          <label>视频码率<select id="media-bitrate">${options(rates, n => n / 1000000 + ' Mbps')}</select></label>
          <label>帧率上限<select id="media-fps">${options(frames, n => n + ' fps')}</select></label></div>
        </div><p class="settings-note">${adaptive ? '自动匹配内外网画质，网络变差时优先流畅。切换手动后可调整详细参数。' : realtime ? '按网络情况保存视频参数。' : '先从 1280 px · 4 Mbps · 30 fps 开始，再按网络调整。'}</p>
        ${adaptive ? '<p id="media-quality-status" class="settings-note" aria-live="polite"></p>' : ''}
        <p id="media-feedback" role="status" aria-live="polite"></p></section>
        <section id="settings-details" class="settings-page" role="tabpanel" aria-labelledby="settings-tab-details" hidden><div class="settings-heading"><h3>连接与声音详情</h3></div><div id="media-diagnostics"><p id="media-audio-status">声音未开启</p></div></section>
      </div><footer><button id="media-apply" type="button">保存视频设置</button><button id="media-close" type="button">关闭</button></footer>`
    const backdrop = document.createElement('div')
    backdrop.id = 'media-backdrop'
    backdrop.hidden = true
    document.body.append(backdrop, panel)
    window.scrcpyNasLowLatency?.mount(panel.querySelector('#media-diagnostics'))
    // 将低频画面与退出操作收纳到详情，保留原有事件处理
    for (const action of ['scale', 'disconnect']) {
      const control = menu.querySelector(`[data-mobile-action="${action}"]`)
      if (control) { control.hidden = false; panel.querySelector('#media-diagnostics').appendChild(control) }
    }
    // 每次只展示一组设置 画质页才显示保存操作
    function selectTab(name, focus = false) {
      for (const tab of panel.querySelectorAll('[data-settings-tab]')) {
        const selected = tab.dataset.settingsTab === name
        tab.setAttribute('aria-selected', String(selected))
        tab.tabIndex = selected ? 0 : -1
        panel.querySelector('#settings-' + tab.dataset.settingsTab).hidden = !selected
        if (selected && focus) tab.focus()
      }
      panel.querySelector('#media-apply').hidden = name !== 'video'
      panel.querySelector('#media-content').scrollTop = 0
    }
    for (const tab of panel.querySelectorAll('[data-settings-tab]')) {
      tab.addEventListener('click', () => selectTab(tab.dataset.settingsTab))
      tab.addEventListener('keydown', event => {
        const names = ['common', 'video', 'details']
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
        event.preventDefault()
        const index = names.indexOf(tab.dataset.settingsTab)
        selectTab(names[event.key === 'Home' ? 0 : event.key === 'End' ? 2 : (index + (event.key === 'ArrowRight' ? 1 : 2)) % 3], true)
      })
    }
    selectTab('common')
    // 关闭只收起面板 视频草稿不提交 即时开关保持已生效状态
    function closePanel() {
      panel.hidden = backdrop.hidden = true
      document.querySelector('#mobile-orb')?.focus()
    }
    backdrop.addEventListener('click', event => { event.stopPropagation(); closePanel() })
    for (const name of ['pointerdown', 'pointerup', 'touchstart', 'touchmove']) backdrop.addEventListener(name, event => event.stopPropagation())
    // 键盘焦点留在当前弹窗 防止设置操作传到远程设备
    panel.addEventListener('keydown', event => {
      event.stopPropagation()
      if (event.key === 'Escape') { event.preventDefault(); closePanel(); return }
      if (event.key !== 'Tab') return
      const items = [...panel.querySelectorAll('button, select, input, summary')].filter(item => item.getClientRects().length && !item.disabled)
      const first = items[0], last = items[items.length - 1]
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    })
    panel.addEventListener('pointerdown', event => event.stopPropagation())
    panel.addEventListener('pointerup', event => event.stopPropagation())
    // 表单使用独立滚动，不吞掉选择器与系统弹出菜单的触摸
    panel.addEventListener('touchmove', event => event.stopPropagation(), { passive: true })
    const resolution = panel.querySelector('#media-resolution')
    const bitrate = panel.querySelector('#media-bitrate')
    const fps = panel.querySelector('#media-fps')
    const feedback = panel.querySelector('#media-feedback')
    const mode = panel.querySelector('#media-quality-mode')
    // 自动模式禁用手动草稿 只在点击保存后改变实际连接
    function showMode() {
      if (!mode) return
      for (const input of [resolution, bitrate, fps]) input.disabled = mode.value === 'auto'
      panel.querySelector('#media-manual-fields').hidden = mode.value === 'auto'
    }
    mode?.addEventListener('change', showMode)
    // 当前目标单独回显 不覆盖用户正在编辑的草稿
    function showQuality() {
      const value = window.scrcpyNasRtc?.getQuality?.()
      const label = panel.querySelector('#media-quality-status')
      if (!value || !label) return
      const route = value.network === 'lan' ? '内网直连' : value.network === 'direct' ? '外网直连' : value.network === 'wan' ? '腾讯云中转' : '正在识别网络'
      label.textContent = `${route} · ${value.mode === 'auto' ? '自动' : '手动'} · 当前目标 ${value.maxSize} px / ${value.bitrate / 1000000} Mbps / ${value.maxFps} fps 上限${value.level < 42 ? ' · 解码兼容上限' : ''}`
    }
    window.addEventListener('scrcpynas:quality-state', showQuality)
    // 优先回显用户保存值，再读取引擎当前参数，不把建议值冒充当前值
    button.addEventListener('click', () => {
      let saved
      try { saved = JSON.parse(localStorage.getItem('scrcpyNas.media.' + serial)) } catch (_) { /* 没有偏好时读取原生字段 */ }
      if (adaptive) {
        let preference = {}
        try { preference = JSON.parse(localStorage.getItem('scrcpyNas.quality.' + serial) || '{}') || {} } catch (_) {}
        mode.value = preference.mode === 'manual' ? 'manual' : 'auto'
        saved = mode.value === 'manual' ? preference.values : window.scrcpyNasRtc.getQuality()
        showMode()
        showQuality()
      }
      const native = nativeSettings()
      const inputs = native ? native.querySelectorAll('input') : []
      resolution.value = String(saved ? saved.maxSize : Number(inputs[3] && inputs[3].value) || 1280)
      bitrate.value = String(saved ? saved.bitrate : Number(inputs[0] && inputs[0].value) || 4000000)
      fps.value = String(saved ? saved.maxFps : Number(inputs[1] && inputs[1].value) || 30)
      if (!resolution.value) resolution.value = '1280'
      if (!bitrate.value) bitrate.value = realtime ? '2000000' : '4000000'
      if (!fps.value) fps.value = '30'
      feedback.textContent = ''
      selectTab('common')
      panel.hidden = backdrop.hidden = false
      menu.hidden = true
      window.dispatchEvent(new Event('scrcpynas:close-menu'))
      document.querySelector('#mobile-orb')?.setAttribute('aria-expanded', 'false')
      panel.querySelector('#media-close').focus({ preventScroll: true })
    })
    panel.querySelector('#media-close').addEventListener('click', closePanel)
    // 发送引擎原有设置命令，不重连设备、不改变画面和触点映射
    panel.querySelector('#media-apply').addEventListener('click', () => {
      const values = { maxSize: Number(resolution.value), bitrate: Number(bitrate.value), maxFps: Number(fps.value) }
      if (!sizes.includes(values.maxSize) || !rates.includes(values.bitrate) || !frames.includes(values.maxFps)) {
        feedback.textContent = '设置值无效，请重新选择'
        return
      }
      if (adaptive) {
        const preference = { mode: mode.value, values }
        if (!window.scrcpyNasRtc.setQualityPreference(preference)) { feedback.textContent = '视频尚未就绪，请在出现画面后重试'; return }
        try {
          localStorage.setItem('scrcpyNas.quality.' + serial, JSON.stringify(preference))
          feedback.textContent = '已保存；实际目标会遵守当前网络带宽与解码能力上限'
        } catch (_) { feedback.textContent = '已提交；浏览器禁止保存设置' }
        showQuality()
        return
      }
      const native = nativeSettings()
      if (!native) { feedback.textContent = '视频尚未就绪，请在出现画面后重试'; return }
      const inputs = native.querySelectorAll('input')
      const apply = Array.from(native.querySelectorAll('button')).find(item => !['Fit', 'Reset'].includes(item.textContent.trim()))
      if (!apply) { feedback.textContent = '当前引擎不支持调整参数'; return }
      inputs[0].value = String(values.bitrate)
      inputs[1].value = String(values.maxFps)
      inputs[3].value = inputs[4].value = String(values.maxSize)
      apply.click()
      try {
        localStorage.setItem('scrcpyNas.media.' + serial, JSON.stringify(values))
        feedback.textContent = '参数已提交并记住；实际帧率和码率随内容及网络变化'
      } catch (_) { feedback.textContent = '参数已提交；浏览器禁止保存设置' }
    })
  }
  new MutationObserver(mount).observe(document.body, { childList: true, subtree: true })
  mount()
})()
