'use strict'
// Finding a Java 21+ to run the 1.21.4 server, or fetching an Eclipse Temurin JRE into the launcher folder.
const fs = require('fs')
const path = require('path')
const { spawnSync, execFileSync } = require('child_process')
const { getJson, download } = require('./http')
const { layout } = require('./state')

const MIN_JAVA = 21
const EXE = process.platform === 'win32' ? 'java.exe' : 'java'

/** Major version from `java -version` output ("21.0.4", "1.8.0_412" -> 8). */
function parseJavaVersion (text) {
  const m = /version "(\d+)(?:\.(\d+))?/.exec(String(text))
  if (!m) return null
  const major = Number(m[1])
  return major === 1 ? Number(m[2]) : major
}

function probe (javaPath) {
  try {
    const r = spawnSync(javaPath, ['-version'], { encoding: 'utf8', timeout: 15000, windowsHide: true })
    if (r.error) return null
    return parseJavaVersion(`${r.stderr}\n${r.stdout}`)
  } catch {
    return null
  }
}

/** java executables under a folder (an unpacked JRE), shallowest first. */
function findJavaIn (dir, depth = 5) {
  const found = []
  const walk = (d, left) => {
    let entries
    try { entries = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const p = path.join(d, e.name)
      if (e.isFile() && e.name === EXE && path.basename(d) === 'bin') found.push(p)
      else if (e.isDirectory() && left > 0) walk(p, left - 1)
    }
  }
  walk(dir, depth)
  return found
}

function candidates (home, state, env = process.env) {
  const list = []
  if (state.javaPath) list.push({ path: state.javaPath, source: 'picked' })
  for (const p of findJavaIn(layout(home).java)) list.push({ path: p, source: 'launcher' })
  if (env.JAVA_HOME) list.push({ path: path.join(env.JAVA_HOME, 'bin', EXE), source: 'JAVA_HOME' })
  list.push({ path: 'java', source: 'PATH' })
  return list
}

/** @returns {{ok:boolean, path?:string, major?:number, source?:string, seen:Array}} */
function findJava (home, state, { probeFn = probe, env = process.env } = {}) {
  const seen = []
  for (const c of candidates(home, state, env)) {
    const major = probeFn(c.path)
    if (major == null) continue
    seen.push({ ...c, major })
    if (major >= MIN_JAVA) return { ok: true, ...c, major, seen }
  }
  return { ok: false, seen }
}

const ADOPTIUM_OS = { win32: 'windows', darwin: 'mac', linux: 'linux' }
const ADOPTIUM_ARCH = { x64: 'x64', arm64: 'aarch64' }

function adoptiumUrl (platform = process.platform, arch = process.arch) {
  const os = ADOPTIUM_OS[platform]; const a = ADOPTIUM_ARCH[arch]
  if (!os || !a) throw new Error(`이 컴퓨터(${platform}/${arch})용 Java 자동 설치는 지원하지 않습니다. 직접 설치하세요.`)
  return `https://api.adoptium.net/v3/assets/latest/${MIN_JAVA}/hotspot?os=${os}&architecture=${a}&image_type=jre&vendor=eclipse`
}

/** The package to fetch from the Adoptium assets response. */
function pickAdoptiumPackage (assets) {
  const pkg = Array.isArray(assets) ? assets.find((a) => a?.binary?.package?.link)?.binary?.package : null
  if (!pkg) throw new Error('Java 다운로드 정보를 찾지 못했습니다.')
  return { name: pkg.name, url: pkg.link, sha256: pkg.checksum, size: pkg.size }
}

async function installJava (home, { onProgress, fetchImpl } = {}) {
  const dir = layout(home).java
  const pkg = pickAdoptiumPackage(await getJson(adoptiumUrl(), { fetchImpl }))
  const archive = path.join(dir, 'download', pkg.name)
  await download(pkg.url, archive, { sha256: pkg.sha256, onProgress, fetchImpl })
  const target = path.join(dir, 'jre')
  fs.rmSync(target, { recursive: true, force: true })
  fs.mkdirSync(target, { recursive: true })
  extract(archive, target)
  fs.rmSync(path.dirname(archive), { recursive: true, force: true })
  const exe = findJavaIn(target)[0]
  if (!exe) throw new Error('받은 Java 안에서 실행 파일을 찾지 못했습니다.')
  if (process.platform !== 'win32') fs.chmodSync(exe, 0o755)
  return exe
}

function extract (archive, target) {
  if (archive.endsWith('.zip')) {
    const AdmZip = require('adm-zip')
    new AdmZip(archive).extractAllTo(target, true)
  } else {
    execFileSync('tar', ['-xzf', archive, '-C', target])
  }
}

module.exports = { MIN_JAVA, parseJavaVersion, probe, findJava, findJavaIn, adoptiumUrl, pickAdoptiumPackage, installJava }
