// Modified in the Mobile Remote derivative (2026): mobile UI, media transport or recovery changes; see MODIFICATIONS.md.
;(async function () {
  'use strict'
  const feedback = document.querySelector('#feedback')
  // 认证失效立即返回登录页，不展示错误接口内容
  async function request(url, method = 'GET', body) {
    const response = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, cache: 'no-store' })
    if (response.status === 401) { location.assign('/login'); throw new Error('请重新登录') }
    const data = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(data.error || '操作失败，请稍后重试')
    return data
  }
  // 使用文本节点渲染分享记录，不把设备名称当作 HTML
  async function refresh() {
    const { shares } = await request('/api/shares'), box = document.querySelector('#shares')
    box.replaceChildren()
    for (const share of shares.slice().reverse()) {
      const row = document.createElement('div'); row.className = 'share-item'
      const text = document.createElement('p'), active = !share.revoked && share.expiresAt > Date.now()
      text.textContent = (active ? '分享中' : share.revoked ? '已关闭' : '已到期') + ' · ' + new Date(share.createdAt).toLocaleString() + ' 创建 · ' + new Date(share.expiresAt).toLocaleString() + ' 到期'
      row.append(text)
      if (active) {
        const button = document.createElement('button'); button.textContent = '关闭分享'; button.className = 'danger'
        button.onclick = async () => { button.disabled = true; try { await request('/api/shares/' + share.id, 'DELETE'); await refresh(); feedback.textContent = '分享已关闭，观看连接已断开' } catch (error) { feedback.textContent = error.message; button.disabled = false } }
        row.append(button)
      }
      box.append(row)
    }
  }
  try {
    const [account, records] = await Promise.all([request('/session/account'), request('/api/records')])
    document.querySelector('#username').textContent = account.username
    for (const record of records.records || []) { const option = document.createElement('option'); option.value = record.serial; option.textContent = record.name || record.model || '安卓设备'; document.querySelector('#device').append(option) }
    await refresh()
  } catch (error) { feedback.textContent = error.message }
  document.querySelector('#create').onsubmit = async event => {
    event.preventDefault(); const button = event.target.querySelector('button'); button.disabled = true
    try { const result = await request('/api/shares', 'POST', { serial: document.querySelector('#device').value, minutes: Number(document.querySelector('#duration').value) }); document.querySelector('#link').value = result.url; document.querySelector('#result').hidden = false; await refresh(); feedback.textContent = '观看链接已生成' } catch (error) { feedback.textContent = error.message } finally { button.disabled = false }
  }
  document.querySelector('#copy').onclick = async () => { try { await navigator.clipboard.writeText(document.querySelector('#link').value); feedback.textContent = '链接已复制' } catch (_) { document.querySelector('#link').select(); feedback.textContent = '请长按链接复制' } }
  document.querySelector('#password').onsubmit = async event => {
    event.preventDefault(); const data = Object.fromEntries(new FormData(event.target)), button = event.target.querySelector('button')
    if (data.newPassword !== data.confirm) { feedback.textContent = '两次新密码不一致'; return }
    button.disabled = true
    try { await request('/session/password', 'POST', data); event.target.reset(); location.assign('/login') } catch (error) { feedback.textContent = error.message; button.disabled = false }
  }
})()
