'use strict'
// Maps (world folders) inside the server folder: list, import from a folder or zip, new world, select.
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')
const { layout, DATA_VERSION } = require('./state')
const props = require('./properties')

const propsFile = (home) => path.join(layout(home).server, 'server.properties')
const NAME_RE = /^[A-Za-z0-9가-힣_\- ]{1,48}$/

/** Make a folder-safe world name from any label. */
function safeName (label) {
  const s = String(label ?? '').normalize('NFC').replace(/[^A-Za-z0-9가-힣_\- ]+/g, '_').trim().slice(0, 48)
  return s || 'world'
}

function uniqueName (serverDir, base) {
  let name = safeName(base); let i = 2
  while (fs.existsSync(path.join(serverDir, name))) name = `${safeName(base)}_${i++}`
  return name
}

/** DataVersion from level.dat (gzipped NBT), or null if it cannot be read. */
function readDataVersion (levelDat) {
  try {
    const nbt = require('prismarine-nbt')
    const parsed = nbt.parseUncompressed(zlib.gunzipSync(fs.readFileSync(levelDat)))
    return parsed.value?.Data?.value?.DataVersion?.value ?? null
  } catch {
    return null
  }
}

function isWorld (dir) { return fs.existsSync(path.join(dir, 'level.dat')) }

/** Worlds in the server folder. Paper's separate <name>_nether / <name>_the_end folders are not listed. */
function listWorlds (home) {
  const dir = layout(home).server
  let entries = []
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return [] }
  const names = new Set(entries.filter((e) => e.isDirectory() && isWorld(path.join(dir, e.name))).map((e) => e.name))
  return [...names]
    .filter((n) => !(/_(nether|the_end)$/.test(n) && names.has(n.replace(/_(nether|the_end)$/, ''))))
    .sort((a, b) => a.localeCompare(b))
    .map((name) => {
      const dataVersion = readDataVersion(path.join(dir, name, 'level.dat'))
      return { name, dataVersion, tooNew: dataVersion != null && dataVersion > DATA_VERSION }
    })
}

/** The folder holding level.dat inside an unpacked archive (it is often wrapped in one more folder). */
function findWorldRoot (dir, depth = 3) {
  if (isWorld(dir)) return dir
  if (depth === 0) return null
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name === '__MACOSX') continue
    const hit = findWorldRoot(path.join(dir, e.name), depth - 1)
    if (hit) return hit
  }
  return null
}

function importFolder (home, src) {
  const root = fs.existsSync(src) && fs.statSync(src).isDirectory() ? findWorldRoot(src) : null
  if (!root) throw new Error('그 폴더 안에서 level.dat 을 찾지 못했습니다. 마인크래프트 월드 폴더를 고르세요.')
  const dir = layout(home).server
  fs.mkdirSync(dir, { recursive: true })
  const name = uniqueName(dir, path.basename(root))
  fs.cpSync(root, path.join(dir, name), { recursive: true, filter: (p) => path.basename(p) !== 'session.lock' })
  return name
}

function importZip (home, zipPath) {
  const AdmZip = require('adm-zip')
  const dir = layout(home).server
  const tmp = path.join(dir, `.import-${Date.now()}`)
  fs.mkdirSync(tmp, { recursive: true })
  try {
    const zip = new AdmZip(zipPath)
    for (const e of zip.getEntries()) {
      // refuse entries that would land outside the temp folder
      const out = path.resolve(tmp, e.entryName)
      if (!out.startsWith(path.resolve(tmp) + path.sep)) throw new Error('압축 파일 안에 잘못된 경로가 있습니다.')
    }
    zip.extractAllTo(tmp, true)
    const root = findWorldRoot(tmp)
    if (!root) throw new Error('압축 파일 안에서 level.dat 을 찾지 못했습니다.')
    const base = root === tmp ? path.basename(zipPath, path.extname(zipPath)) : path.basename(root)
    const name = uniqueName(dir, base)
    fs.renameSync(root, path.join(dir, name))
    fs.rmSync(path.join(dir, name, 'session.lock'), { force: true })
    return name
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

/** Point server.properties at a world. A new world also sets how it is generated on first start. */
function selectWorld (home, state, name, newType = null) {
  if (!NAME_RE.test(name)) throw new Error('맵 이름은 한글·영문·숫자·_·- 로 48자 이내여야 합니다.')
  const dir = layout(home).server
  fs.mkdirSync(dir, { recursive: true })
  const exists = isWorld(path.join(dir, name))
  if (!exists && !newType) throw new Error(`맵 "${name}" 이 없습니다.`)
  if (!exists && fs.existsSync(path.join(dir, name))) throw new Error(`"${name}" 폴더가 이미 있지만 월드가 아닙니다. 다른 이름을 쓰세요.`)
  const values = { 'level-name': name }
  if (!exists) values['level-type'] = newType === 'flat' ? 'minecraft:flat' : 'minecraft:normal'
  props.update(propsFile(home), values)
  state.pendingWorld = exists ? null : { name, type: newType }
  return state
}

function mapStatus (home, state) {
  const name = props.get(props.read(propsFile(home)), 'level-name')
  if (!name) return { ok: false, name: null }
  const world = listWorlds(home).find((w) => w.name === name)
  if (world) return { ok: !world.tooNew, name, tooNew: world.tooNew, pending: false }
  const pending = state.pendingWorld?.name === name
  return { ok: pending, name, pending, type: pending ? state.pendingWorld.type : null }
}

module.exports = { safeName, readDataVersion, listWorlds, importFolder, importZip, selectWorld, mapStatus, findWorldRoot, propsFile }
