'use strict'
// Installing the bundled module into a Foundry VTT data folder on this PC.
const fs = require('fs')
const path = require('path')
const os = require('os')

const MODULE_ID = 'blockworld-bridge'

/** Foundry's default user data folder ("Data" inside it holds modules/worlds/systems). */
function defaultDataPath (platform = process.platform, env = process.env, home = os.homedir()) {
  if (platform === 'win32') return path.join(env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'FoundryVTT', 'Data')
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'FoundryVTT', 'Data')
  return path.join(home, '.local', 'share', 'FoundryVTT', 'Data')
}

/** Accept the Data folder itself, or its parent (the user data folder) when that has Data inside. */
function resolveDataPath (p) {
  if (!p) return null
  const isData = (d) => ['modules', 'worlds', 'systems'].some((s) => fs.existsSync(path.join(d, s)))
  if (isData(p)) return p
  if (isData(path.join(p, 'Data'))) return path.join(p, 'Data')
  return null
}

function readVersion (moduleDir) {
  try { return JSON.parse(fs.readFileSync(path.join(moduleDir, 'module.json'), 'utf8')).version ?? null } catch { return null }
}

/** -1 / 0 / 1 for dotted numeric versions ("0.4.10" > "0.4.2"). */
function compareVersions (a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0)
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d) return Math.sign(d)
  }
  return 0
}

function moduleStatus (dataPath, bundledDir) {
  const bundled = readVersion(bundledDir)
  const data = resolveDataPath(dataPath)
  if (!data) return { ok: false, state: 'noData', bundled, installed: null }
  const installed = readVersion(path.join(data, 'modules', MODULE_ID))
  const state = !installed ? 'missing' : compareVersions(installed, bundled) < 0 ? 'old' : 'current'
  return { ok: state === 'current', state, bundled, installed, data }
}

/** Copy into a temp folder first, then swap, so a failed copy never leaves a half module. */
function installModule (dataPath, bundledDir) {
  const data = resolveDataPath(dataPath)
  if (!data) throw new Error('Foundry 데이터 폴더가 아닙니다. modules·worlds·systems 폴더가 있는 Data 폴더를 고르세요.')
  if (!readVersion(bundledDir)) throw new Error('앱 안의 모듈 파일을 찾지 못했습니다.')
  const modules = path.join(data, 'modules')
  fs.mkdirSync(modules, { recursive: true })
  const target = path.join(modules, MODULE_ID)
  const tmp = path.join(modules, `.${MODULE_ID}-installing`)
  const old = path.join(modules, `.${MODULE_ID}-old`)
  fs.rmSync(tmp, { recursive: true, force: true })
  fs.rmSync(old, { recursive: true, force: true })
  fs.cpSync(bundledDir, tmp, { recursive: true, filter: (p) => path.basename(p) !== 'test' })
  if (fs.existsSync(target)) fs.renameSync(target, old)
  fs.renameSync(tmp, target)
  fs.rmSync(old, { recursive: true, force: true })
  return moduleStatus(data, bundledDir)
}

module.exports = { MODULE_ID, defaultDataPath, resolveDataPath, readVersion, compareVersions, moduleStatus, installModule }
