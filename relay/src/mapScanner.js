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
const KIND = { SURFACE: 0, FLOOR: 1, WALL: 2, WINDOW: 3, DOOR: 4, DOOR_OPEN: 5, FURNITURE: 6 }

// Floor-plan palette: light floors, dark walls, so rooms read at a glance.
// Doors are blue everywhere (floor plan and top view) so entrances stand out from wood floors.
// Doors leading outside are deep blue (open or shut, on the floor plan and on roofs alike);
// doors inside a building are yellow. Open or shut shows on the Foundry door.
const PLAN = { WALL: [43, 43, 48], ROCK: [20, 20, 23], WINDOW: [159, 211, 234], DOOR_OUT: [28, 72, 214], DOOR_IN: [236, 190, 24], STAIRS: [150, 104, 196] }
/** Stairs have their own colour (on floor plans and outdoors), so a flight stands out from the floor. */
const STAIRS_RE = /_stairs$/
/** Blocks at head height that leave the way out of a door open. */
const HEAD_OPEN_RE = /^(air|cave_air|void_air|light|lantern|soul_lantern|cobweb|chain|vine|glow_lichen|.*_carpet|.*_banner|.*_button|.*_sign|.*_hanging_sign|torch|wall_torch|soul_torch|soul_wall_torch|redstone_torch|redstone_wall_torch|short_grass|tall_grass|fern|large_fern)$/

// ---- a cleaner map outdoors ----
/** Small plants on the ground (grass, flowers, ferns, saplings, mushrooms, vines): looked through, the ground under them shows. */
const SMALL_PLANT_RE = /^(short_grass|tall_grass|grass|fern|large_fern|dead_bush|sweet_berry_bush|bush|firefly_bush|short_dry_grass|tall_dry_grass|leaf_litter|wildflowers|pink_petals|brown_mushroom|red_mushroom|crimson_fungus|warped_fungus|crimson_roots|warped_roots|nether_sprouts|vine|glow_lichen|dandelion|poppy|blue_orchid|allium|azure_bluet|red_tulip|orange_tulip|white_tulip|pink_tulip|oxeye_daisy|cornflower|lily_of_the_valley|wither_rose|sunflower|lilac|rose_bush|peony|torchflower|pitcher_plant|open_eyeblossom|closed_eyeblossom|.*_sapling)$/
/** Trees from above: every kind of leaves one flat dark green, so a tree reads as one shape. */
const LEAVES_RE = /_leaves$|^(azalea|flowering_azalea)$/
const TREE = [46, 92, 36]
/** How much of the height shading is kept on the ground outdoors (0 = none). */
const LAND_SHADE = 0.35
/** Outside the scenario's area (see setArea): trees and everything else in one plain colour each. */
const OUT_TREE = [72, 98, 66]
const OUT_LAND = [150, 160, 138]
/** Blocks round each place that still count as the scenario's area. */
const AREA_MARGIN = 3
/** Natural ground (and paths) outdoors: a lone odd cell of it may take its neighbours' colour; a path never changes. */
const GROUND_RE = /^(grass_block|dirt|coarse_dirt|rooted_dirt|podzol|mycelium|gravel|sand|red_sand|stone|andesite|diorite|granite|tuff|clay|mud|moss_block|snow|snow_block|dirt_path)$/
/** How far under a roof a door is looked for, and how far out from it the open sky. */
const DOOR_UNDER_ROOF = 12
const DOOR_SKY_REACH = 4
/** How far out from a roofed spot open sky may be for it to count as open (a porch, a pavilion). */
const OPEN_ROOF_REACH = 6
/** How much of the roof's colour shows over the floor plan of an open roof (and over its posts). */
const ROOF_OVER = 0.3
const ROOF_OVER_WALL = 0.1
/** Tops of columns that are open ground, not a roof: nothing to look under. */
const OPEN_GROUND_RE = /^(grass_block|dirt|coarse_dirt|rooted_dirt|podzol|mycelium|sand|red_sand|gravel|stone|deepslate|snow_block|snow|water|lava|ice|dirt_path|farmland|mud|clay|short_grass|tall_grass|fern)$/
const WINDOW_RE = /(^|_)glass(_pane)?$|^iron_bars$/
const DOOR_RE = /_door$|_fence_gate$/
const WALL_RE = /_wall$/ // cobblestone walls and the like: thin, but a wall all the same
// Furniture (something at head height that is not a full block: a hanging lantern, a fence post, a
// slab shelf, a trapdoor): the block's own colour, a little lighter, so it reads as a thing in the
// room and not as a wall. It does not block sight.
const FURNITURE_FALLBACK = [120, 104, 88]
const furnish = ([r, g, b]) => [r * 0.8 + 235 * 0.2, g * 0.8 + 235 * 0.2, b * 0.8 + 235 * 0.2].map(Math.round)
const blend = (a, b, t) => a.map((v, i) => Math.round(v * (1 - t) + b[i] * t))
/** Colour of a floor-plan cell. */
function planColour (cell) {
  if (cell.stairs) return PLAN.STAIRS
  if (cell.kind === KIND.FLOOR) return lighten(shadeRgb(cell.id, SHADE.NORMAL))
  if (cell.kind === KIND.WALL) return cell.rock ? PLAN.ROCK : PLAN.WALL
  if (cell.kind === KIND.FURNITURE) return cell.id === ID.NONE ? FURNITURE_FALLBACK : furnish(shadeRgb(cell.id, SHADE.NORMAL))
  if (cell.kind === KIND.WINDOW) return PLAN.WINDOW
  return cell.outer ? PLAN.DOOR_OUT : PLAN.DOOR_IN
}
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
  /**
   * The scenario's area from the scenario builder's file ({town, places}), or null: everywhere is
   * drawn in full. Outside it the map is drawn plain. Returns whether it changed.
   */
  setArea (file) {
    const rects = []
    const add = (r, m) => {
      const n = (k) => Number(r?.[k])
      if (!r || !['x1', 'z1', 'x2', 'z2'].every((k) => Number.isFinite(n(k)))) return
      rects.push([Math.min(n('x1'), n('x2')) - m, Math.min(n('z1'), n('z2')) - m, Math.max(n('x1'), n('x2')) + m, Math.max(n('z1'), n('z2')) + m])
    }
    if (file) {
      add(file.town, 0)
      for (const p of Array.isArray(file.places) ? file.places : []) add(p, AREA_MARGIN)
    }
    const next = rects.length ? rects : null
    const changed = JSON.stringify(next) !== JSON.stringify(this.area ?? null)
    this.area = next
    return changed
  }

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
        if (id === ID.NONE || SMALL_PLANT_RE.test(name)) continue
        let depth = 0
        if (id === ID.WATER) {
          for (let d = y; d > y - MAX_WATER_DEPTH && d >= bottom; d--) {
            p.set(x, d, z)
            const n = nameAt(p)
            if (n === null || !isWaterLike(n)) break
            depth++
          }
        }
        return { y, id, depth, leaves: LEAVES_RE.test(name) }
      }
      return null
    }

    // Floor-plan cell: what is at body height (wall, window, door), else the floor below it.
    const solidAt = blockSolidity(bot)
    const fullAt = blockFullness(bot)
    const plan = (x, z, floorY) => {
      const cut = floorY + 1
      if (!this.hasRoof(bot, x, cut, z, nameAt)) return null
      p.set(x, cut, z)
      const name = nameAt(p)
      if (name === null) return null
      // A door at the cut, or just under it (standing a block up, on a step or a bed, the cut
      // runs through the wall over the door).
      for (const dy of [cut, cut - 1]) {
        p.set(x, dy, z)
        if (DOOR_RE.test(nameAt(p) ?? '')) {
          return { kind: isOpen(bot, p) ? KIND.DOOR_OPEN : KIND.DOOR, y: dy, outer: this.leadsOutside(x, dy, z, bottom, nameAt, surface) }
        }
      }
      p.set(x, cut, z)
      if (WINDOW_RE.test(name)) return { kind: KIND.WINDOW, y: cut }
      if (solidAt(p)) {
        // A step up (stairs at body height): walked on, not furniture.
        if (STAIRS_RE.test(name)) return { kind: KIND.FLOOR, y: cut, id: colorId(name), stairs: true }
        if (!(fullAt(p) || WALL_RE.test(name))) return { kind: KIND.FURNITURE, y: cut, id: colorId(name) }
        // Solid all round at the cut (the earth round a cellar, the middle of a thick wall): still a
        // wall to see and walk by, drawn darker so the wall line along the rooms stands out.
        let inside = true
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          p.set(x + dx, cut, z + dz)
          if (!solidAt(p)) { inside = false; break }
        }
        p.set(x, cut, z)
        return { kind: KIND.WALL, y: cut, id: colorId(name), rock: inside }
      }
      for (let y = cut; y >= bottom; y--) {
        p.set(x, y, z)
        const n = nameAt(p)
        if (n === null) return null
        const id = colorId(n)
        if (id !== ID.NONE) return { kind: KIND.FLOOR, y, id, stairs: STAIRS_RE.test(n) }
      }
      return null
    }

    // Open roofs: the feet height under the roof of a column that is open to the sky at the
    // sides, else null. A post or wall under such a roof counts when a neighbour is open.
    const roofMemo = new Map()
    const openSpace = (x, z) => {
      const k = `${x},${z}`
      if (roofMemo.has(k)) return roofMemo.get(k)
      let feet = null
      try { feet = this.openRoofSpace(x, z, bottom, nameAt, surface) } catch { feet = null }
      roofMemo.set(k, feet)
      return feet
    }
    const openRoof = (x, z) => {
      const feet = openSpace(x, z)
      if (feet !== null) return feet === false ? null : feet
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const f = openSpace(x + dx, z + dz)
        if (f !== null && f !== false) return f
      }
      return null
    }

    const rgb = new Uint8Array(16 * 16 * 3)
    // Outdoor ground: 1 = may be painted over when it is a lone odd cell, 2 = a path (counts, never changes),
    // 0 = everything else (water, doors, stairs, posts and props, floor plans).
    const soft = new Uint8Array(16 * 16)
    // Outdoors: 1 = water, 2 = leaves (they keep their kind outside the scenario's area).
    const look = new Uint8Array(16 * 16)
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
          const c = planColour(cell)
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
        // Under a roof that is open to the sky at the sides (a porch, a pavilion, eaves, a market
        // roof): the floor plan, with the roof showing faintly over it.
        const openFeet = openRoof(x, z)
        const under = openFeet === null ? null : plan(x, z, openFeet)
        if (under) {
          const roof = shadeRgb(s.id, shade)
          const c = blend(planColour(under), roof, under.kind === KIND.WALL ? ROOF_OVER_WALL : under.kind === KIND.DOOR || under.kind === KIND.DOOR_OPEN ? 0 : ROOF_OVER)
          rgb[i * 3] = c[0]; rgb[i * 3 + 1] = c[1]; rgb[i * 3 + 2] = c[2]
          heights[i] = under.y
          kinds[i] = under.kind
          found++
          continue
        }
        p.set(x, s.y, z)
        const door = this.outerDoor(x, z, s.y, bottom, nameAt, surface)
        const step = !door && STAIRS_RE.test(nameAt(p) ?? '') && this.groundStep(x, s.y, z, nameAt, surface)
        const [r, g, b] = door ? PLAN.DOOR_OUT : step ? PLAN.STAIRS
          : s.id === ID.WATER ? shadeRgb(s.id, shade)
            : s.leaves ? TREE
              // the ground: only a little of the height shading, so it reads as one colour
              : blend(shadeRgb(s.id, SHADE.NORMAL), shadeRgb(s.id, shade), LAND_SHADE)
        rgb[i * 3] = r; rgb[i * 3 + 1] = g; rgb[i * 3 + 2] = b
        look[i] = s.id === ID.WATER ? 1 : s.leaves ? 2 : 0
        const ground = !door && !step && s.id !== ID.WATER && !s.leaves ? (nameAt(p) ?? '') : ''
        soft[i] = !GROUND_RE.test(ground) ? 0 : ground === 'dirt_path' ? 2 : 1
        heights[i] = s.y
        found++
      }
      northRow = row
    }
    if (!found) return false
    // Outside the scenario's town and places (the scenario builder's file): plain, so the town stands out.
    if (this.area && dim === 'overworld') {
      for (let dz = 0; dz < 16; dz++) {
        for (let dx = 0; dx < 16; dx++) {
          if (inArea(this.area, cx * 16 + dx, cz * 16 + dz)) continue
          const i = dz * 16 + dx
          if (look[i] === 1) continue // water stays water
          const c = look[i] === 2 ? OUT_TREE : OUT_LAND
          rgb[i * 3] = c[0]; rgb[i * 3 + 1] = c[1]; rgb[i * 3 + 2] = c[2]
          soft[i] = 0
        }
      }
    }
    despeckle(rgb, soft)
    const k = this.key(dim, cx, cz)
    const prev = this.chunks.get(k)
    if (prev && equalBytes(prev.rgb, rgb) && equalBytes(prev.heights, heights) && equalBytes(prev.kinds, kinds)) return false
    const entry = { dim, cx, cz, rgb, heights, kinds }
    this.chunks.set(k, entry)
    this.onChunk(MapScanner.encode(entry))
    return true
  }

  /**
   * Outdoors, stairs that are steps (up to a door, a porch, a terrace), not a roof: beside them is
   * natural ground or a path, level with them or a block lower.
   */
  groundStep (x, y, z, nameAt, surface) {
    const p = new Vec3(0, 0, 0)
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      let n = null
      try { n = surface(x + dx, z + dz) } catch { n = null }
      if (!n || n.y > y || n.y < y - 1) continue
      p.set(x + dx, n.y, z + dz)
      // ground beside it (grass, a path, gravel), not a roof's ridge or a terrace of planks
      if (GROUND_RE.test(nameAt(p) ?? '')) return true
    }
    return false
  }

  /**
   * Under the roof of column x,z: the feet height of the space there if it is open to the sky at
   * the sides (walking out at head height, open sky comes within OPEN_ROOF_REACH blocks before a
   * wall or a door does); false if there is a roof but the space under it is closed in; null if
   * there is no roofed space to walk in (open ground, or a post or wall all the way up).
   */
  openRoofSpace (x, z, bottom, nameAt, surface) {
    const s = surface(x, z)
    if (!s) return null
    const p = new Vec3(x, s.y, z)
    if (OPEN_GROUND_RE.test(nameAt(p) ?? '')) return null
    // Down from the roof: through the air under it to the floor.
    let y = s.y - 1
    const lowest = Math.max(bottom, s.y - DOOR_UNDER_ROOF)
    const isAir = (yy) => { p.set(x, yy, z); const n = nameAt(p); return n === 'air' || n === 'cave_air' }
    while (y >= lowest && !isAir(y)) y--
    if (y < lowest) return null
    while (y >= lowest && isAir(y)) y--
    if (y < lowest) return null
    const feet = y + 1
    const head = feet + 1
    if (!isAir(head)) return null
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      for (let step = 1; step <= OPEN_ROOF_REACH; step++) {
        const ax = x + dx * step; const az = z + dz * step
        p.set(ax, head, az)
        const n = nameAt(p)
        if (n === null || (n !== 'air' && n !== 'cave_air')) break
        let o
        try { o = surface(ax, az) } catch { o = null }
        if (o && o.y < head) return feet
      }
    }
    return false
  }

  /**
   * On the top view: is there a door to the outside at the top of this column, or under its roof
   * (a door under eaves or a porch)? Doors inside a building stay hidden until a character is in
   * there and the floor plan shows them.
   */
  outerDoor (x, z, topY, bottom, nameAt, surface) {
    const p = new Vec3(x, topY, z)
    if (OPEN_GROUND_RE.test(nameAt(p) ?? '')) return false // bare ground or water: no roof to look under
    for (let y = topY; y >= Math.max(bottom, topY - DOOR_UNDER_ROOF); y--) {
      p.set(x, y, z)
      const name = nameAt(p)
      if (name === null) return false
      if (DOOR_RE.test(name)) {
        if (y === topY || this.leadsOutside(x, y, z, bottom, nameAt, surface)) return true
        // The other leaf of a double door that does lead outside: outside too (one leaf may have
        // a lamp or a post in front of it).
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          p.set(x + dx, y, z + dz)
          if (DOOR_RE.test(nameAt(p) ?? '') && this.leadsOutside(x + dx, y, z + dz, bottom, nameAt, surface)) return true
        }
        return false
      }
    }
    return false
  }

  /**
   * Does the door with a block at x,y,z lead outside? Walking out from it at head height on any
   * side, open sky comes within a few blocks before a wall does.
   */
  leadsOutside (x, y, z, bottom, nameAt, surface) {
    const p = new Vec3(x, y - 1, z)
    let foot = y
    while (foot - 1 >= bottom && DOOR_RE.test(nameAt(p) ?? '')) { foot--; p.set(x, foot - 1, z) }
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      for (let step = 1; step <= DOOR_SKY_REACH; step++) {
        const ax = x + dx * step; const az = z + dz * step
        p.set(ax, foot + 1, az)
        const head = nameAt(p)
        // Nothing in the way at head height (an invisible light block, a lantern hanging from the
        // eaves, a cobweb do not block the way out).
        if (head === null || !HEAD_OPEN_RE.test(head)) break
        let s
        try { s = surface(ax, az) } catch { s = null }
        if (s && s.y < foot + 1) return true
      }
    }
    return false
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

/**
 * A lone odd cell of ground outdoors (a gravel block on a path, a dirt patch in a lawn) painted the
 * colour that at least three of its four neighbours share. Only ground cells (soft 1) change, and
 * only from ground or path neighbours; paths, water, doors, stairs, props and floor plans stay.
 */
function inArea (rects, x, z) {
  for (const r of rects) if (x >= r[0] && x <= r[2] && z >= r[1] && z <= r[3]) return true
  return false
}

function despeckle (rgb, soft) {
  const src = rgb.slice()
  const at = (i) => (src[i * 3] << 16) | (src[i * 3 + 1] << 8) | src[i * 3 + 2]
  for (let z = 0; z < 16; z++) {
    for (let x = 0; x < 16; x++) {
      const i = z * 16 + x
      if (soft[i] !== 1) continue
      const me = at(i)
      const counts = new Map()
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx; const nz = z + dz
        if (nx < 0 || nx > 15 || nz < 0 || nz > 15) continue
        const j = nz * 16 + nx
        if (!soft[j]) continue
        const c = at(j)
        if (c !== me) counts.set(c, (counts.get(c) ?? 0) + 1)
      }
      for (const [c, n] of counts) {
        if (n < 3) continue
        rgb[i * 3] = c >> 16; rgb[i * 3 + 1] = (c >> 8) & 255; rgb[i * 3 + 2] = c & 255
        break
      }
    }
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

/**
 * Is the block at p a whole cube (a wall, a tall bookcase, a stack of crates), rather than something
 * thin or small that has collision (a fence, a lantern, a slab, a trapdoor, a chain)? Uses the
 * block state's own collision shape.
 */
function blockFullness (bot) {
  const world = bot.world
  const reg = bot.registry
  const shapes = reg?.blockCollisionShapes
  const byState = reg?.blocksByStateId
  if (!world?.getBlockStateId || !byState || !shapes) return () => true
  const cache = new Map()
  return (p) => {
    const id = world.getBlockStateId(p)
    if (cache.has(id)) return cache.get(id)
    const block = byState[id]
    let full = false
    if (block) {
      const entry = shapes.blocks[block.name]
      const shapeId = Array.isArray(entry) ? entry[id - block.minStateId] ?? entry[0] : entry
      const boxes = shapes.shapes[shapeId] ?? []
      full = boxes.some((b) => b[0] <= 0 && b[1] <= 0 && b[2] <= 0 && b[3] >= 1 && b[4] >= 1 && b[5] >= 1)
    }
    cache.set(id, full)
    return full
  }
}

function isOpen (bot, p) {
  try { return bot.blockAt(p, false)?.getProperties?.().open === true } catch { return false }
}

function equalBytes (a, b) {
  if (!a || !b) return a === b
  return Buffer.from(a.buffer, a.byteOffset, a.byteLength).equals(Buffer.from(b.buffer, b.byteOffset, b.byteLength))
}

module.exports = { despeckle, SMALL_PLANT_RE, LEAVES_RE, MapScanner, KIND }
