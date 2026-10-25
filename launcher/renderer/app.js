'use strict'
/* global bwb */
// Window logic: renders the snapshot from the main process and turns clicks into calls.

const $ = (sel, root = document) => root.querySelector(sel)
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)]
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

let S = null // latest snapshot
let logSrc = 'server'
let tokenShown = false
let firstRender = true

// ---------------- calls ----------------

async function call (channel, ...args) {
  const btns = $$(`[data-call="${channel}"]`)
  btns.forEach((b) => { b.disabled = true })
  try {
    const res = await bwb.call(channel, ...args)
    if (res?.snapshot) render(res.snapshot)
    if (res && !res.ok) toast(res.error, true)
    return res
  } finally {
    if (S) render(S) // re-evaluates disabled state
  }
}

let toastTimer = null
function toast (text, bad = false) {
  const t = $('#toast')
  t.textContent = text
  t.classList.toggle('bad', bad)
  t.hidden = false
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { t.hidden = true }, bad ? 6000 : 2200)
}

// ---------------- tabs ----------------

function showTab (id) {
  for (const b of $$('.tabs button')) b.setAttribute('aria-selected', String(b.dataset.tab === id))
  for (const p of $$('.panel')) p.classList.toggle('on', p.dataset.panel === id)
}
window.__showTab = showTab

$$('.tabs button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)))

// ---------------- render ----------------

function render (snap) {
  // logs are cleared on each start: redraw the box when the list got shorter
  const logsReset = S && snap !== S && (snap.logs?.[logSrc]?.length ?? 0) < (S.logs?.[logSrc]?.length ?? 0)
  S = snap
  if (logsReset) renderLog()
  const st = snap.status
  const item = Object.fromEntries(st.items.map((i) => [i.id, i]))
  const running = st.run.mc !== 'stopped' || st.run.relay !== 'stopped'
  const busy = snap.busy

  $('#mcVersion').textContent = `Minecraft ${snap.mcVersion}`

  // status column
  $('#statusList').innerHTML = st.items.map((i, n) => `
    ${n === 5 ? '<li class="sep" aria-hidden="true"></li>' : ''}
    <li><button data-goto="${i.tab}" title="${esc(i.text)}">
      <span class="light ${i.ok ? 'ok' : ''}" aria-label="${i.ok ? '됨' : '안 됨'}"></span>
      <span class="slabel">${esc(i.label)}</span>
      <span class="stext">${esc(i.text)}</span>
    </button></li>`).join('')
  $('#allGood').hidden = !st.items.every((i) => i.ok)

  // 1. server
  const j = st.java
  $('#javaResult').className = `result ${j.ok ? 'ok' : 'bad'}`
  $('#javaResult').textContent = j.ok
    ? `Java ${j.major} 사용 (${{ picked: '직접 고른 것', launcher: '앱이 설치한 것', JAVA_HOME: 'JAVA_HOME', PATH: '시스템' }[j.source] ?? j.source}) · ${j.path}`
    : (j.seen?.length ? `찾은 Java 가 너무 오래됐습니다 (${j.seen.map((s) => s.major).join(', ')}). Java 21 이상이 필요합니다.` : 'Java 를 찾지 못했습니다.')
  $('#btnJavaInstall').classList.toggle('primary', !j.ok)
  setRadio('serverType', snap.state.serverType)
  $('#eula').checked = st.server.eula
  const sv = st.server
  $('#serverResult').className = `result ${sv.typeOk ? 'ok' : 'warn'}`
  $('#serverResult').textContent = sv.typeOk
    ? `설치됨: ${snap.state.serverType === 'paper' ? 'Paper' : 'Vanilla'} ${sv.build ?? ''}${sv.eula ? '' : ' · EULA 동의가 남았습니다'}`
    : (sv.jar ? '다른 종류의 서버가 설치돼 있습니다. 다시 받으세요.' : '')
  $('#btnServerDownload').textContent = sv.typeOk ? '다시 받기' : '서버 받기'

  // 2. map
  const current = st.map.name
  const rows = snap.worlds.map((w) => `
    <li class="${w.name === current ? 'current' : ''}">
      <span class="wname">${esc(w.name)}</span>
      ${worldTag(w, snap.mcVersion)}
      ${w.name === current ? '<span class="tag">사용 중</span>' : `<button class="small" data-world="${esc(w.name)}" ${w.tooNew || running ? 'disabled' : ''}>사용</button>`}
    </li>`)
  if (st.map.pending) rows.unshift(`<li class="current"><span class="wname">${esc(current)}</span><span class="tag">새 ${snap.state.pendingWorld?.type === 'flat' ? '평면' : '일반'} 맵 · 첫 실행 때 생성</span><span class="tag">사용 중</span></li>`)
  $('#worldList').innerHTML = rows.join('') || '<li class="empty">아직 맵이 없습니다. 위에서 넣거나 새로 만드세요.</li>'

  // 3. settings
  setRadio('onlineMode', String(snap.state.onlineMode))
  if (firstRender) {
    $('#preset').innerHTML = Object.entries(snap.presets).map(([k, p]) => `
      <label class="choice"><input type="radio" name="preset" value="${k}"><span><b>${esc(p.label)}</b>
        <small>3D ${p.radius * 2 + 1}×${p.radius * 2 + 1} 청크 · 지도 ${p.refreshMs / 1000}초마다 ${p.refreshRadius}블록</small></span></label>`).join('')
  }
  setRadio('preset', snap.state.preset)
  setValue('#memoryGB', snap.state.memoryGB)
  for (const k of ['mcPort', 'rconPort', 'relayPort']) setValue(`#${k}`, snap.state[k])
  $('#settingsResult').className = `result ${item.settings.ok ? 'ok' : 'warn'}`
  $('#settingsResult').textContent = item.settings.ok ? '적용됨. 서버와 relay 설정이 서로 맞습니다.' : (snap.state.token ? item.settings.text : '')

  // 4. module
  const m = st.module
  $('#foundryPath').className = `result ${m.state === 'noData' ? '' : 'ok'}`
  $('#foundryPath').textContent = m.data ? `폴더: ${m.data}` : `아직 지정하지 않았습니다. (기본 위치: ${snap.foundryDefault})`
  $('#btnModule').textContent = { missing: '설치', old: '업데이트', current: '다시 설치', noData: '설치' }[m.state]
  $('#btnModule').disabled = m.state === 'noData' || !!busy
  $('#moduleResult').className = `result ${m.ok ? 'ok' : m.state === 'old' ? 'warn' : ''}`
  $('#moduleResult').textContent = m.state === 'noData' ? '' : `설치된 버전: ${m.installed ?? '없음'} · 앱의 모듈: ${m.bundled ?? '?'}`

  // 5. run
  $('#btnStart').disabled = running || !st.readyToRun || !!busy
  $('#btnStop').disabled = !running || st.run.mc === 'stopping'
  $('#btnStart').textContent = st.run.mc === 'starting' ? '켜는 중…' : st.run.relay === 'starting' ? 'relay 켜는 중…' : '시작'
  $('#btnStop').textContent = st.run.mc === 'stopping' ? '저장하고 끄는 중…' : '정지'
  const missing = st.items.slice(0, 4).filter((i) => !i.ok).map((i) => i.label)
  $('#runBlocked').textContent = !running && missing.length ? `시작하려면 먼저: ${missing.join(', ')}` : ''
  $('#valAddr').textContent = `ws://127.0.0.1:${snap.state.relayPort}`
  const token = snap.state.token
  $('#valToken').textContent = token ? (tokenShown ? token : '•'.repeat(16)) : '설정 적용 후 생깁니다'
  $('#valToken').classList.toggle('masked', !!token && !tokenShown)
  $('#btnReveal').textContent = tokenShown ? '숨기기' : '보기'
  $('#cmd').disabled = st.run.mc !== 'running'
  $('#cmdForm button').disabled = st.run.mc !== 'running'

  // lock preparation while running or busy
  for (const id of ['server', 'map', 'settings']) {
    for (const el of $$(`[data-panel="${id}"] button, [data-panel="${id}"] input, [data-panel="${id}"] select`)) {
      if (el.matches('[data-open], [data-call="world:openFolder"], [data-call="java:check"]')) continue
      if (running || (busy && !el.matches('[data-world]'))) el.disabled = true
      else if (!el.matches('[data-world]')) el.disabled = false
    }
  }
  $('#drop').classList.toggle('disabled', running)

  // progress bars
  for (const p of $$('[data-progress]')) p.hidden = !(busy && busy.id === p.dataset.progress)
  if (busy) progress(busy)

  if (firstRender) {
    firstRender = false
    renderLog()
    const firstRed = st.items.slice(0, 5).find((i) => !i.ok)
    showTab(firstRed ? firstRed.tab : 'run')
  }
}

/** Version note for a world: same as the server, older (upgraded on first start), or too new. */
function worldTag (w, mc) {
  if (w.tooNew) return `<span class="tag bad">${mc}보다 새 버전 · 열 수 없음</span>`
  if (w.dataVersion == null) return '<span class="tag">버전 모름</span>'
  if (w.dataVersion === S.dataVersion) return `<span class="tag">${mc} 맵</span>`
  return '<span class="tag">이전 버전 맵 · 첫 실행 때 변환</span>'
}

function setRadio (name, value) {
  for (const r of $$(`input[name="${name}"]`)) r.checked = r.value === value
}
function setValue (sel, v) {
  const el = $(sel)
  if (document.activeElement !== el) el.value = v
}

function progress (b) {
  const p = $(`[data-progress="${b.id}"]`)
  if (!p) return
  const pct = b.total ? Math.min(100, Math.round((b.done / b.total) * 100)) : 0
  p.classList.toggle('indeterminate', !b.total)
  p.querySelector('div').style.width = b.total ? `${pct}%` : ''
  p.querySelector('span').textContent = b.total
    ? `${b.label} ${pct}% (${(b.done / 1048576).toFixed(1)} / ${(b.total / 1048576).toFixed(1)} MB)`
    : `${b.label}…`
}

// ---------------- log ----------------

function logLine (e) {
  const cls = e.src === 'launcher' ? 'l-launcher' : /\b(warn|error|exception)\b|실패|오류/i.test(e.line) ? 'l-warn' : ''
  return `<span class="${cls}">${esc(e.line)}</span>\n`
}

function renderLog () {
  const list = S?.logs?.[logSrc] ?? []
  const box = $('#log')
  box.innerHTML = list.map(logLine).join('') || '<span class="l-launcher">아직 로그가 없습니다. 시작을 누르면 여기에 나옵니다.</span>'
  box.scrollTop = box.scrollHeight
}

function appendLog (e) {
  const src = e.src === 'relay' ? 'relay' : 'server'
  if (!S || src !== logSrc) return
  const box = $('#log')
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40
  if (box.querySelector('.l-launcher') && box.childElementCount === 1 && /아직 로그/.test(box.textContent)) box.innerHTML = ''
  box.insertAdjacentHTML('beforeend', logLine(e))
  while (box.childElementCount > 1000) box.firstElementChild.remove()
  if (atBottom) box.scrollTop = box.scrollHeight
}

$$('.logtabs button').forEach((b) => b.addEventListener('click', () => {
  logSrc = b.dataset.log
  $$('.logtabs button').forEach((x) => x.classList.toggle('on', x === b))
  renderLog()
}))

// ---------------- events ----------------

document.addEventListener('click', (e) => {
  const t = e.target.closest('button, [data-goto]')
  if (!t) return
  if (t.dataset.call) return call(t.dataset.call)
  if (t.dataset.goto) return showTab(t.dataset.goto)
  if (t.dataset.open) return bwb.call('open:url', t.dataset.open)
  if (t.dataset.world) return call('world:select', t.dataset.world)
  if (t.dataset.copy) {
    const text = t.dataset.copy === 'valToken' ? S?.state?.token : $(`#${t.dataset.copy}`).textContent
    if (!text) return
    return bwb.call('clipboard', text).then(() => toast('복사했습니다'))
  }
})

$('#btnReveal').addEventListener('click', () => { tokenShown = !tokenShown; render(S) })

$('#serverType').addEventListener('change', (e) => call('server:type', e.target.value))
$('#eula').addEventListener('change', (e) => call('server:eula', e.target.checked))
$('#onlineMode').addEventListener('change', (e) => call('settings:save', { onlineMode: e.target.value === 'true' }))
$('#preset').addEventListener('change', (e) => call('settings:save', { preset: e.target.value }))
$('#memoryGB').addEventListener('change', (e) => call('settings:save', { memoryGB: Number(e.target.value) }))
for (const k of ['mcPort', 'rconPort', 'relayPort']) {
  $(`#${k}`).addEventListener('change', (e) => call('settings:save', { [k]: Number(e.target.value) }))
}

$('#btnCreateWorld').addEventListener('click', async () => {
  const name = $('#newWorldName').value.trim()
  if (!name) return toast('맵 이름을 넣으세요', true)
  const res = await call('world:create', name, $('#newWorldType').value)
  if (res?.ok) { $('#newWorldName').value = ''; toast(`"${name}" 맵을 골랐습니다. 첫 실행 때 만들어집니다.`) }
})

$('#cmdForm').addEventListener('submit', (e) => {
  e.preventDefault()
  const v = $('#cmd').value.trim()
  if (!v) return
  $('#cmd').value = ''
  call('run:command', v)
})

// drag and drop: a world folder or a zip
const drop = $('#drop')
for (const ev of ['dragover', 'drop']) document.addEventListener(ev, (e) => e.preventDefault())
drop.addEventListener('dragenter', () => drop.classList.add('over'))
drop.addEventListener('dragleave', () => drop.classList.remove('over'))
drop.addEventListener('drop', (e) => {
  drop.classList.remove('over')
  if (drop.classList.contains('disabled')) return toast('서버가 실행 중입니다. 정지한 뒤 넣으세요.', true)
  const file = e.dataTransfer.files[0]
  if (!file) return
  const p = bwb.pathForFile(file)
  call(/\.zip$/i.test(p) ? 'world:importZip' : 'world:dropFolder', p)
})

bwb.on('snapshot', render)
bwb.on('progress', progress)
bwb.on('log', (e) => {
  if (S) (S.logs[e.src === 'relay' ? 'relay' : 'server'] ??= []).push(e)
  appendLog(e)
})

call('snapshot')
