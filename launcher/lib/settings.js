'use strict'
// server.properties and the relay config written from the same choices, so token and RCON password always match.
const fs = require('fs')
const crypto = require('crypto')
const { layout, MC_VERSION } = require('./state')
const props = require('./properties')
const { propsFile } = require('./worlds')

/** Performance presets for the relay (what Foundry receives and how often). */
const PRESETS = {
  light: { label: '가벼움', viewer: { radius: 1 }, map: { refreshMs: 3000, refreshRadius: 16 }, stateHz: 8, entityRadius: 24 },
  normal: { label: '보통', viewer: { radius: 2 }, map: { refreshMs: 2000, refreshRadius: 24 }, stateHz: 10, entityRadius: 32 },
  wide: { label: '넓게', viewer: { radius: 3 }, map: { refreshMs: 1500, refreshRadius: 32 }, stateHz: 12, entityRadius: 48 }
}

const randomSecret = (bytes = 18) => crypto.randomBytes(bytes).toString('base64url')

function checkPorts (state) {
  const ports = [['마크 서버', state.mcPort], ['RCON', state.rconPort], ['relay', state.relayPort]]
  for (const [name, p] of ports) {
    if (!Number.isInteger(p) || p < 1024 || p > 65535) throw new Error(`${name} 포트는 1024~65535 사이 정수여야 합니다.`)
  }
  if (new Set(ports.map(([, p]) => p)).size !== ports.length) throw new Error('포트 세 개는 서로 달라야 합니다.')
}

function expectedProperties (state) {
  return {
    'server-ip': '127.0.0.1', // only the relay on this PC connects
    'server-port': String(state.mcPort),
    'online-mode': String(!!state.onlineMode),
    'enable-rcon': 'true',
    'rcon.port': String(state.rconPort),
    'rcon.password': state.rconPassword ?? '',
    'spawn-protection': '0' // characters are not op, so they could not dig near spawn otherwise
  }
}

function expectedRelayConfig (state) {
  const p = PRESETS[state.preset] ?? PRESETS.normal
  return {
    listen: { host: '127.0.0.1', port: state.relayPort },
    token: state.token,
    minecraft: { host: '127.0.0.1', port: state.mcPort, version: MC_VERSION, auth: state.onlineMode ? 'microsoft' : 'offline' },
    rcon: { enabled: true, host: '127.0.0.1', port: state.rconPort, password: state.rconPassword },
    viewer: { enabled: true, radius: p.viewer.radius },
    map: { refreshMs: p.map.refreshMs, refreshRadius: p.map.refreshRadius },
    stateHz: p.stateHz,
    entityRadius: p.entityRadius
  }
}

/** Write both files. Creates the token and RCON password the first time. Mutates and returns state. */
function applySettings (home, state) {
  checkPorts(state)
  if (!PRESETS[state.preset]) throw new Error('알 수 없는 성능 프리셋입니다.')
  state.token ??= randomSecret(24)
  state.rconPassword ??= randomSecret(18)
  const dirs = layout(home)
  fs.mkdirSync(dirs.server, { recursive: true })
  props.update(propsFile(home), expectedProperties(state))
  fs.writeFileSync(dirs.relayConfig, JSON.stringify(expectedRelayConfig(state), null, 2))
  return state
}

/** Green when both files say what the current choices would write. */
function settingsStatus (home, state) {
  if (!state.token || !state.rconPassword) return { ok: false, reason: '아직 적용 안 함' }
  const lines = props.read(propsFile(home))
  for (const [k, v] of Object.entries(expectedProperties(state))) {
    if (props.get(lines, k) !== v) return { ok: false, reason: `다시 적용 필요 (${k})` }
  }
  let cfg
  try { cfg = JSON.parse(fs.readFileSync(layout(home).relayConfig, 'utf8')) } catch { return { ok: false, reason: '다시 적용 필요 (relay 설정 없음)' } }
  if (JSON.stringify(cfg) !== JSON.stringify(expectedRelayConfig(state))) return { ok: false, reason: '바꾼 설정 적용 필요' }
  return { ok: true }
}

module.exports = { PRESETS, expectedProperties, expectedRelayConfig, applySettings, settingsStatus, randomSecret }
