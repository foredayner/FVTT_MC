'use strict'
// The seven lights on the right of the window. Each says which tab fixes it.
const { findJava } = require('./java')
const { serverStatus } = require('./server')
const { mapStatus } = require('./worlds')
const { settingsStatus } = require('./settings')
const { moduleStatus } = require('./foundry')

const ITEMS = [
  { id: 'java', label: 'Java', tab: 'server' },
  { id: 'server', label: '서버 준비', tab: 'server' },
  { id: 'map', label: '맵 선택', tab: 'map' },
  { id: 'settings', label: '설정 적용', tab: 'settings' },
  { id: 'module', label: '모듈 설치', tab: 'module' },
  { id: 'mc', label: '마크 서버 실행', tab: 'run' },
  { id: 'relay', label: 'relay 실행', tab: 'run' }
]

/**
 * @param {{home:string, state:object, runner:{status():{mc:string,relay:string}}, bundledModule:string, java?:object}} ctx
 * `java` can be passed in to skip probing java again (it spawns a process).
 */
function computeStatus ({ home, state, runner, bundledModule, java }) {
  const j = java ?? findJava(home, state)
  const s = serverStatus(home, state)
  const m = mapStatus(home, state)
  const st = settingsStatus(home, state)
  const mod = moduleStatus(state.foundryData, bundledModule)
  const run = runner.status()
  const detail = {
    java: { ok: j.ok, text: j.ok ? `Java ${j.major}` : (j.seen?.length ? `Java ${Math.max(...j.seen.map((x) => x.major))} (21 이상 필요)` : '없음') },
    server: { ok: s.ok, text: s.ok ? `${state.serverType === 'paper' ? 'Paper' : 'Vanilla'} ${s.build ?? ''}`.trim() : !s.typeOk ? '서버 파일 없음' : 'EULA 미동의' },
    map: { ok: m.ok, text: m.name ? (m.tooNew ? `${m.name} (너무 새 버전)` : m.pending ? `${m.name} (새로 생성)` : m.name) : '선택 안 됨' },
    settings: { ok: st.ok, text: st.ok ? '적용됨' : st.reason },
    module: { ok: mod.ok, text: { noData: 'Foundry 폴더 미지정', missing: '설치 안 됨', old: `구버전 ${mod.installed}`, current: `v${mod.installed}` }[mod.state] },
    mc: { ok: run.mc === 'running', text: { stopped: '꺼짐', starting: '켜는 중', running: '실행 중', stopping: '끄는 중' }[run.mc] },
    relay: { ok: run.relay === 'running', text: { stopped: '꺼짐', starting: '켜는 중', running: '실행 중' }[run.relay] }
  }
  return {
    items: ITEMS.map((i) => ({ ...i, ...detail[i.id] })),
    java: j,
    server: s,
    map: m,
    module: mod,
    run,
    /** everything needed before pressing Start */
    readyToRun: ['java', 'server', 'map', 'settings'].every((k) => detail[k].ok)
  }
}

module.exports = { ITEMS, computeStatus }
