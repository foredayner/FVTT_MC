'use strict'
// The server jar (official download only) and the EULA, which only the user can accept.
const fs = require('fs')
const path = require('path')
const { getJson, download } = require('./http')
const { layout, MC_VERSION } = require('./state')

const MOJANG_MANIFEST = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json'
const PAPER_BUILDS = `https://fill.papermc.io/v3/projects/paper/versions/${MC_VERSION}/builds`
const EULA_URL = 'https://aka.ms/MinecraftEULA'

const jarPath = (home) => path.join(layout(home).server, 'server.jar')

async function resolveVanilla ({ fetchImpl } = {}) {
  const manifest = await getJson(MOJANG_MANIFEST, { fetchImpl })
  const entry = manifest.versions?.find((v) => v.id === MC_VERSION)
  if (!entry) throw new Error(`Mojang 목록에 ${MC_VERSION} 이 없습니다.`)
  const meta = await getJson(entry.url, { fetchImpl })
  const server = meta.downloads?.server
  if (!server?.url) throw new Error(`${MC_VERSION} 서버 다운로드 정보를 찾지 못했습니다.`)
  return { url: server.url, sha1: server.sha1, build: MC_VERSION }
}

/** Latest stable Paper build (the list is newest first). */
async function resolvePaper ({ fetchImpl } = {}) {
  const builds = await getJson(PAPER_BUILDS, { fetchImpl })
  if (!Array.isArray(builds) || !builds.length) throw new Error(`Paper ${MC_VERSION} 빌드를 찾지 못했습니다.`)
  const build = builds.find((b) => b.channel === 'STABLE') ?? builds[0]
  const dl = build.downloads?.['server:default']
  if (!dl?.url) throw new Error('Paper 다운로드 정보를 찾지 못했습니다.')
  return { url: dl.url, sha256: dl.checksums?.sha256, build: `${MC_VERSION}-${build.id}` }
}

async function downloadServer (home, type, { onProgress, fetchImpl } = {}) {
  const info = type === 'vanilla' ? await resolveVanilla({ fetchImpl }) : await resolvePaper({ fetchImpl })
  await download(info.url, jarPath(home), { sha1: info.sha1, sha256: info.sha256, onProgress, fetchImpl })
  return { type, build: info.build }
}

function eulaAccepted (home) {
  try {
    return /^\s*eula\s*=\s*true\s*$/mi.test(fs.readFileSync(path.join(layout(home).server, 'eula.txt'), 'utf8'))
  } catch {
    return false
  }
}

function writeEula (home, accepted) {
  const dir = layout(home).server
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'eula.txt'),
    `#By changing the setting below to TRUE you are indicating your agreement to our EULA (${EULA_URL}).\n` +
    `#Set by the user in Blockworld Bridge launcher on ${new Date().toISOString()}\n` +
    `eula=${accepted ? 'true' : 'false'}\n`)
}

/** Server ready = the jar for the chosen type is there and the user accepted the EULA. */
function serverStatus (home, state) {
  const jar = fs.existsSync(jarPath(home))
  const typeOk = jar && state.installedServer?.type === state.serverType
  const eula = eulaAccepted(home)
  return { ok: typeOk && eula, jar, typeOk, eula, build: state.installedServer?.build ?? null }
}

module.exports = { EULA_URL, jarPath, resolveVanilla, resolvePaper, downloadServer, eulaAccepted, writeEula, serverStatus, MOJANG_MANIFEST, PAPER_BUILDS }
