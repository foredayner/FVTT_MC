'use strict'
// Streams the 3D world around every character to Foundry: whole chunk columns (gzip'd JSON in
// prismarine-chunk's format), single block changes, and unloads when nobody is near any more.
// Column data is shared: one column near two characters is sent once.
const zlib = require('zlib')
const fs = require('fs')
const path = require('path')

class World3D {
  /**
   * @param {{radius:number}} opts radius in chunks around each character
   * @param {(msg:object) => void} send
   */
  constructor (opts, send) {
    this.radius = opts.radius
    this.send = send
    /** @type {Map<string, {dim:string, x:number, z:number, minY:number, height:number, data:string}>} */
    this.sent = new Map()          // key -> last message sent (also the resync cache)
    this.lastBlock = new Map()     // "dim:x,y,z" -> stateId, to drop duplicates heard by several bots
  }

  key (dim, x, z) { return `${dim}:${x},${z}` }

  attach (bot) {
    bot.on('blockUpdate', (oldBlock, newBlock) => {
      const b = newBlock ?? oldBlock
      if (!b?.position) return
      const dim = dimOf(bot)
      const x = b.position.x; const y = b.position.y; const z = b.position.z
      if (!this.sent.has(this.key(dim, Math.floor(x / 16) * 16, Math.floor(z / 16) * 16))) return
      const stateId = newBlock?.stateId ?? 0
      const bk = `${dim}:${x},${y},${z}`
      if (this.lastBlock.get(bk) === stateId) return
      this.lastBlock.set(bk, stateId)
      if (this.lastBlock.size > 20000) this.lastBlock.clear()
      this.send({ type: 'block3d', dim, x, y, z, stateId })
    })
    bot.on('chunkColumnLoad', (pos) => {
      // A column we already sent was reloaded (e.g. after respawn): its contents may differ.
      const k = this.key(dimOf(bot), pos.x, pos.z)
      if (this.sent.has(k)) this.sendColumn(bot, pos.x, pos.z, true)
    })
  }

  /** Recompute what is near the characters; send new columns, unload ones nobody is near. */
  update (bots) {
    const wanted = new Map() // key -> bot that can provide it
    for (const bot of bots) {
      if (!bot.entity) continue
      const dim = dimOf(bot)
      const cx = Math.floor(bot.entity.position.x / 16)
      const cz = Math.floor(bot.entity.position.z / 16)
      for (let dz = -this.radius; dz <= this.radius; dz++) {
        for (let dx = -this.radius; dx <= this.radius; dx++) {
          const x = (cx + dx) * 16; const z = (cz + dz) * 16
          const k = this.key(dim, x, z)
          if (!wanted.has(k) && bot.world.getColumn(cx + dx, cz + dz)) wanted.set(k, bot)
        }
      }
    }
    for (const [k, bot] of wanted) {
      if (this.sent.has(k)) continue
      const [, xz] = k.split(':')
      const [x, z] = xz.split(',').map(Number)
      this.sendColumn(bot, x, z, false)
    }
    for (const [k, msg] of this.sent) {
      if (wanted.has(k)) continue
      this.sent.delete(k)
      this.send({ type: 'unload3d', dim: msg.dim, x: msg.x, z: msg.z })
    }
  }

  sendColumn (bot, x, z, force) {
    const col = bot.world.getColumn(x >> 4, z >> 4)
    if (!col) return
    const dim = dimOf(bot)
    const k = this.key(dim, x, z)
    const json = col.toJson()
    const data = zlib.gzipSync(json).toString('base64')
    const prev = this.sent.get(k)
    if (prev && prev.data === data && !force) return
    const msg = { type: 'col3d', dim, x, z, minY: col.minY ?? bot.game?.minY ?? 0, height: col.worldHeight ?? bot.game?.height ?? 256, data }
    this.sent.set(k, msg)
    this.send(msg)
  }

  /** Everything currently loaded, for a client that (re)connects. */
  * all () { yield * this.sent.values() }
}

function dimOf (bot) { return String(bot.game?.dimension ?? 'overworld') }

/** Texture atlas + block-state models for the browser renderer, read from prismarine-viewer. */
function readAssets (mcVersion) {
  const root = path.dirname(require.resolve('prismarine-viewer/package.json'))
  const { getVersion } = require('prismarine-viewer/viewer/lib/version')
  const version = getVersion(mcVersion)
  if (!version) throw new Error(`3D 자료가 없는 버전입니다: ${mcVersion}`)
  return {
    version,
    atlas: path.join(root, 'public/textures', `${version}.png`),
    blockStates: path.join(root, 'public/blocksStates', `${version}.json`)
  }
}

function assetVersion (mcVersion) {
  try { return readAssets(mcVersion).version } catch { return null }
}

/** One asset file as base64 (for the GM to upload into Foundry's data folder). */
function readAsset (mcVersion, name) {
  const a = readAssets(mcVersion)
  const file = name === 'atlas' ? a.atlas : name === 'blockStates' ? a.blockStates : null
  if (!file) throw new Error(`알 수 없는 자료: ${name}`)
  return { version: a.version, name, data: fs.readFileSync(file).toString('base64') }
}

module.exports = { World3D, readAsset, assetVersion }
