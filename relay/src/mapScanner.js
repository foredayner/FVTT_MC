'use strict'
// Builds a top-down colour map, one 16x16 chunk at a time.
//
// - When a chunk first loads it is scanned once, so the GM gets the lay of the land.
// - Every `refreshMs` the chunks within `refreshRadius` blocks of each character are scanned
//   again and sent only if something changed. Changes far from everyone wait until someone
//   walks near them, which matches what the characters could have seen.
const { Vec3 } = require('vec3')
const { colorId, isWaterLike, landShade, waterShade, rgb: shadeRgb, ID, SHADE } = require('./mapColors')

const MAX_WATER_DEPTH = 16
const ROOF_SCAN = 24 // how far above the cut a "roof" may be

/**
 * What each map pixel is, sent alongside the colours so the module can build Foundry walls.
 * SURFACE = normal top-down view; the rest only appear under a roof in cut (floor-plan) view.
 */
const KIND = { SURFACE: 0, FLOOR: 1, WALL: 2, WINDOW: 3, DOOR: 4, DOOR_OPEN: 5 }

// Floor-plan palette: light floors, dark walls, so rooms read at a glance.
const PLAN = { WALL: [43, 43, 48], WINDOW: [159, 211, 234], DOOR: [181, 101, 29], DOOR_OPEN: [224, 176, 112] }
const WINDOW_RE = /(^|_)glass(_pane)?$|^iron_bars$/
const DOOR_RE = /_door$|_fence_gate$/
const lighten = ([r, g, b]) => [r * 0.55 + 235 * 0.45, g * 0.55 + 235 * 0.45, b * 0.55 + 235 * 0.45].map(Math.round)

const NO_HEIGHT = -32768

class MapScanner {
  /**
   * @param {{scanAbove:number, scanBelow:number, refreshRadius?:number}} opts
   * @param {(chunk:{dim:string,cx:number,cz:number,rgb:string,heights:string}) => void} onChunk
   */
  constructor (opts, onChunk) {
    this.opts = opts
    this.onChunk = onChunk
    /** @type {Map<string, {dim:string,cx:number,cz:number,rgb:Uint8Array,heights:Int16Array}>} */
    this.chunks = new Map()
    this.pending = new Map() // key -> timer (first scan after load)
    /** auto: cut around characters who are under a roof · fixed: cut everywhere at y · off: surface only */
    this.view = { mode: 'auto', y: null }
    this.cuts = []             // [{dim, x, z, r, y}] from setCharacters()
    this.cutChunks = new Set() // chunk keys that were drawn cut last time
  }

  /**
   * Floor-plan view settings from the GM. `y` is a floor level: the y of the block a character's
   * feet are in, so the cut runs through the block above it (where walls, windows and doors are).
   */
  setView ({ mode, y } = {}) {
    if (!['auto', 'fixed', 'off'].includes(mode)) throw new Error(`unknown view mode ${mode}`)
    if (mode === 'fixed' && !Number.isInteger(y)) throw new Error('fixed view needs an integer y')
    this.view = { mode, y: mode === 'fixed' ? y : null }
  }

  /**
   * Auto mode: every character standing under a roof cuts the map around them at their own
   * floor. Where two cuts overlap, the higher floor wins (the upper storey covers the lower one).
   * Returns the chunk keys that were cut before but are not now, so they can be redrawn.
   */
  setCharacters (bots) {
    const r = this.opts.indoorRadius ?? 12
    this.cuts = []
    if (this.view.mode === 'auto') {
      for (const bot of bots) {
        if (!bot.entity) continue
        const p = bot.entity.position
        const feet = Math.floor(p.y)
        if (this.hasRoof(bot, Math.floor(p.x), feet + 1, Math.floor(p.z))) {
          this.cuts.push({ dim: dimOf(bot), x: Math.floor(p.x), z: Math.floor(p.z), r, y: feet })
        }
      }
    }
    const now = new Set()
    for (const c of this.cuts) {
      for (let cz = Math.floor((c.z - c.r) / 16); cz <= Math.floor((c.z + c.r) / 16); cz++) {
        for (let cx = Math.floor((c.x - c.r) / 16); cx <= Math.floor((c.x + c.r) / 16); cx++) now.add(this.key(c.dim, cx, cz))
      }
    }
    const gone = [...this.cutChunks].filter((k) => !now.has(k))
    this.cutChunks = now
    return gone
  }

  /** Floor level to cut at for one column, or null for the normal top-down view. */
  floorAt (dim, x, z) {
    if (this.view.mode === 'fixed') return this.view.y
    if (this.view.mode === 'off') return null
    let best = null
    for (const c of this.cuts) {
      if (c.dim !== dim || Math.abs(x - c.x) > c.r || Math.abs(z - c.z) > c.r) continue
      if (best === null || c.y > best) best = c.y
    }
    return best
  }

  hasRoof (bot, x, cutY, z, nameAt = blockNamer(bot)) {
    const p = new Vec3(x, 0, z)
    for (let y = cutY + 1; y <= cutY + ROOF_SCAN; y++) {
      p.y = y
      const name = nameAt(p)
      if (name === null) return false
      if (colorId(name) !== ID.NONE || WINDOW_RE.test(name)) return true
    }
    return false
  }

  /** Rescan specific chunks with whichever character has them loaded. */
  rescan (bots, keys) {
    let changed = 0
    for (const k of keys) {
      const [dim, cx, cz] = k.split(':')
      for (const bot of bots) {
        if (!bot.entity || dimOf(bot) !== dim) continue
        try { if (this.scanChunk(bot, dim, Number(cx), Number(cz))) changed++; break } catch { /* try the next bot */ }
      }
    }
    return changed
  }

  /** Redraw every chunk we know (after the GM changes the view). */
  rescanAll (bots) { return this.rescan(bots, [...this.chunks.keys()]) }

  key (dim, cx, cz) { return `${dim}:${cx}:${cz}` }

  /** Attach to a bot: scan each chunk once when it loads. */
  attach (bot) {
    bot.on('chunkColumnLoad', (pos) => {
      const dim = dimOf(bot)
      const cx = Math.floor(pos.x / 16)
      const cz = Math.floor(pos.z / 16)
      const k = this.key(dim, cx, cz)
      if (this.chunks.has(k) || this.pending.has(k)) return
      this.pending.set(k, setTimeout(() => {
        this.pending.delete(k)
        try { this.scanChunk(bot, dim, cx, cz) } catch { /* unloaded meanwhile */ }
      }, 50))
    })
  }

  /** Rescan the chunks around a bot. Returns how many chunks changed. */
  scanAround (bot, radius = this.opts.refreshRadius ?? 24) {
    if (!bot.entity) return 0
    const dim = dimOf(bot)
    const p = bot.entity.position
    const c0x = Math.floor((p.x - radius) / 16); const c1x = Math.floor((p.x + radius) / 16)
    const c0z = Math.floor((p.z - radius) / 16); const c1z = Math.floor((p.z + radius) / 16)
    let changed = 0
    for (let cz = c0z; cz <= c1z; cz++) {
      for (let cx = c0x; cx <= c1x; cx++) {
        try { if (this.scanChunk(bot, dim, cx, cz)) changed++ } catch { /* unloaded */ }
      }
    }
    return changed
  }

  /**
   * Scan one chunk the way a Minecraft map item draws it: the first block from the top whose map
   * colour is not see-through, shaded by its height against the block to its north (water by depth).
   * Sends it and returns true only if it changed.
   */
  scanChunk (bot, dim, cx, cz) {
    if (!bot.entity) return false
    if (bot.world?.getColumn && !bot.world.getColumn(cx, cz)) return false // not loaded
    const refY = Math.floor(bot.entity.position.y)
    const top = refY + this.opts.scanAbove
    const bottom = Math.max(refY - this.opts.scanBelow, bot.game?.minY ?? -64)
    const nameAt = blockNamer(bot)
    const p = new Vec3(0, 0, 0)

    // Surface of one column: {y, id, depth} or null when unknown/unloaded.
    const surface = (x, z) => {
      for (let y = top; y >= bottom; y--) {
        p.set(x, y, z)
        const name = nameAt(p)
        if (name === null) return null
        const id = colorId(name)
        if (id === ID.NONE) continue
        let depth = 0
        if (id === ID.WATER) {
          for (let d = y; d > y - MAX_WATER_DEPTH && d >= bottom; d--) {
            p.set(x, d, z)
            const n = nameAt(p)
            if (n === null || !isWaterLike(n)) break
            depth++
          }
        }
        return { y, id, depth }
      }
      return null
    }

    // Floor-plan cell: what is at body height (wall, window, door), else the floor below it.
    const solidAt = blockSolidity(bot)
    const plan = (x, z, floorY) => {
      const cut = floorY + 1
      if (!this.hasRoof(bot, x, cut, z, nameAt)) return null
      p.set(x, cut, z)
      const name = nameAt(p)
      if (name === null) return null
      if (DOOR_RE.test(name)) return { kind: isOpen(bot, p) ? KIND.DOOR_OPEN : KIND.DOOR, y: cut }
      if (WINDOW_RE.test(name)) return { kind: KIND.WINDOW, y: cut }
      if (solidAt(p)) return { kind: KIND.WALL, y: cut }
      for (let y = cut; y >= bottom; y--) {
        p.set(x, y, z)
        const n = nameAt(p)
        if (n === null) return null
        const id = colorId(n)
        if (id !== ID.NONE) return { kind: KIND.FLOOR, y, id }
      }
      return null
    }

    const rgb = new Uint8Array(16 * 16 * 3)
    const heights = new Int16Array(16 * 16).fill(NO_HEIGHT)
    const kinds = new Uint8Array(16 * 16)
    // Row above (north of) the chunk first, so the first row can be shaded too.
    let northRow = []
    for (let dx = 0; dx < 16; dx++) northRow.push(this.northNeighbour(bot, surface, cx * 16 + dx, cz * 16 - 1))
    let found = 0
    for (let dz = 0; dz < 16; dz++) {
      const row = []
      for (let dx = 0; dx < 16; dx++) {
        const x = cx * 16 + dx
        const z = cz * 16 + dz
        const i = dz * 16 + dx
        const floorY = this.floorAt(dim, x, z)
        const cell = floorY === null ? null : plan(x, z, floorY)
        if (cell) {
          let c
          if (cell.kind === KIND.FLOOR) c = lighten(shadeRgb(cell.id, SHADE.NORMAL))
          else if (cell.kind === KIND.WALL) c = PLAN.WALL
          else if (cell.kind === KIND.WINDOW) c = PLAN.WINDOW
          else if (cell.kind === KIND.DOOR) c = PLAN.DOOR
          else c = PLAN.DOOR_OPEN
          rgb[i * 3] = c[0]; rgb[i * 3 + 1] = c[1]; rgb[i * 3 + 2] = c[2]
          heights[i] = cell.y
          kinds[i] = cell.kind
          row.push({ y: cell.y })
          found++
          continue
        }
        const s = surface(x, z)
        row.push(s)
        if (!s) continue
        const shade = s.id === ID.WATER ? waterShade(s.depth, x, z) : landShade(s.y, northRow[dx]?.y ?? null)
        const [r, g, b] = shadeRgb(s.id, shade)
        rgb[i * 3] = r; rgb[i * 3 + 1] = g; rgb[i * 3 + 2] = b
        heights[i] = s.y
        found++
      }
      northRow = row
    }
    if (!found) return false
    const k = this.key(dim, cx, cz)
    const prev = this.chunks.get(k)
    if (prev && equalBytes(prev.rgb, rgb) && equalBytes(prev.heights, heights) && equalBytes(prev.kinds, kinds)) return false
    const entry = { dim, cx, cz, rgb, heights, kinds }
    this.chunks.set(k, entry)
    this.onChunk(MapScanner.encode(entry))
    return true
  }

  /** Surface of the column north of a chunk edge, if that chunk is loaded. */
  northNeighbour (bot, surface, x, z) {
    if (bot.world?.getColumn && !bot.world.getColumn(Math.floor(x / 16), Math.floor(z / 16))) return null
    try { return surface(x, z) } catch { return null }
  }

  /** All cached chunks, encoded for the wire (used on (re)connect). */
  * all () {
    for (const c of this.chunks.values()) yield MapScanner.encode(c)
  }

  /** Height of the surface block at x,z if known. */
  surfaceY (dim, x, z) {
    const c = this.chunks.get(this.key(dim, Math.floor(x / 16), Math.floor(z / 16)))
    if (!c) return null
    const dx = ((Math.floor(x) % 16) + 16) % 16
    const dz = ((Math.floor(z) % 16) + 16) % 16
    const h = c.heights[dz * 16 + dx]
    return h === NO_HEIGHT ? null : h
  }

  static encode ({ dim, cx, cz, rgb, heights, kinds }) {
    const b64 = (a) => Buffer.from(a.buffer, a.byteOffset, a.byteLength).toString('base64')
    return { dim, cx, cz, rgb: b64(rgb), heights: b64(heights), kinds: b64(kinds ?? new Uint8Array(256)) }
  }

  close () {
    for (const t of this.pending.values()) clearTimeout(t)
    this.pending.clear()
  }
}

function dimOf (bot) { return String(bot.game?.dimension ?? 'overworld') }

/**
 * Fast block-name lookup. Uses state ids + the registry when available (no Block objects per call),
 * otherwise falls back to bot.blockAt. Returns null for unloaded positions.
 */
function blockNamer (bot) {
  const world = bot.world
  const byState = bot.registry?.blocksByStateId
  if (world?.getBlockStateId && byState) {
    return (p) => {
      const id = world.getBlockStateId(p)
      if (id === undefined || id === null) return null
      return byState[id]?.name ?? 'unknown'
    }
  }
  return (p) => {
    const b = bot.blockAt(p, false)
    return b ? b.name : null
  }
}

/** Is the block at p a full, solid cube (a wall), rather than a slab, carpet, flower...? */
function blockSolidity (bot) {
  const world = bot.world
  const byState = bot.registry?.blocksByStateId
  if (world?.getBlockStateId && byState) {
    return (p) => byState[world.getBlockStateId(p)]?.boundingBox === 'block'
  }
  return (p) => bot.blockAt(p, false)?.boundingBox === 'block'
}

function isOpen (bot, p) {
  try { return bot.blockAt(p, false)?.getProperties?.().open === true } catch { return false }
}

function equalBytes (a, b) {
  if (!a || !b) return a === b
  return Buffer.from(a.buffer, a.byteOffset, a.byteLength).equals(Buffer.from(b.buffer, b.byteOffset, b.byteLength))
}

module.exports = { MapScanner, KIND }
