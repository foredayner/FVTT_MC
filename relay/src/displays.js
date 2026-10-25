'use strict'
// Block display entities (minecraft:block_display) near the characters, e.g. objects built from
// many small scaled blocks. Each part goes to Foundry as one world-space matrix that maps the unit
// block [0,1]^3 to where the game draws it, plus its block state and map colour.
//
// Minecraft draws a block display as:
//   translate(position) * rotateY(-yaw) * rotateX(pitch) * translation * leftRotation * scale * rightRotation
// applied to the block model in [0,1]^3 (DisplayEntityRenderer + AffineTransformation, billboard "fixed").

const { colorId, rgb: shadeRgb, SHADE, ID } = require('./mapColors')

const DEG = Math.PI / 180

// ---------- 4x4 matrices, column-major like three.js (m[col * 4 + row]) ----------

const identity = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]

function mul (a, b) {
  const o = new Array(16)
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3]
    }
  }
  return o
}

const translate = (x, y, z) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1]
const scale = (x, y, z) => [x, 0, 0, 0, 0, y, 0, 0, 0, 0, z, 0, 0, 0, 0, 1]
function rotY (a) { const c = Math.cos(a); const s = Math.sin(a); return [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1] }
function rotX (a) { const c = Math.cos(a); const s = Math.sin(a); return [1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1] }

/** Rotation matrix of a quaternion (normalised first, as the game does). */
function quat ({ x, y, z, w }) {
  const n = Math.hypot(x, y, z, w) || 1
  x /= n; y /= n; z /= n; w /= n
  return [
    1 - 2 * (y * y + z * z), 2 * (x * y + z * w), 2 * (x * z - y * w), 0,
    2 * (x * y - z * w), 1 - 2 * (x * x + z * z), 2 * (y * z + x * w), 0,
    2 * (x * z + y * w), 2 * (y * z - x * w), 1 - 2 * (x * x + y * y), 0,
    0, 0, 0, 1
  ]
}

function apply (m, x, y, z) {
  return [m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]]
}

/**
 * World matrix of a block display.
 * @param {{x,y,z}} pos entity position
 * @param {number} yawDeg Minecraft yaw (degrees)
 * @param {number} pitchDeg Minecraft pitch (degrees)
 * @param {{translation, scale, left, right}} t vectors {x,y,z} and quaternions {x,y,z,w}
 */
function displayMatrix (pos, yawDeg, pitchDeg, t) {
  let m = translate(pos.x, pos.y, pos.z)
  m = mul(m, rotY(-yawDeg * DEG))
  m = mul(m, rotX(pitchDeg * DEG))
  m = mul(m, translate(t.translation.x, t.translation.y, t.translation.z))
  m = mul(m, quat(t.left))
  m = mul(m, scale(t.scale.x, t.scale.y, t.scale.z))
  m = mul(m, quat(t.right))
  return m
}

/** World-space bounding box of the unit block under m: [minX,minY,minZ,maxX,maxY,maxZ]. */
function unitBox (m) {
  const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]
  for (let i = 0; i < 8; i++) {
    const p = apply(m, i & 1, (i >> 1) & 1, (i >> 2) & 1)
    for (let k = 0; k < 3; k++) { b[k] = Math.min(b[k], p[k]); b[k + 3] = Math.max(b[k + 3], p[k]) }
  }
  return b
}

// ---------- reading the entity ----------

const ZERO = { x: 0, y: 0, z: 0 }
const ONE = { x: 1, y: 1, z: 1 }
const NO_ROT = { x: 0, y: 0, z: 0, w: 1 }

/** Accept {x,y,z[,w]} or [x,y,z[,w]] from the protocol layer. */
function vec (v, fallback) {
  if (!v) return fallback
  if (Array.isArray(v)) return v.length === 4 ? { x: v[0], y: v[1], z: v[2], w: v[3] } : { x: v[0], y: v[1], z: v[2] }
  return v
}

/** Index of each metadata field for block_display in this game version. */
function metaIndex (registry) {
  const keys = registry.entitiesByName?.block_display?.metadataKeys
  if (!keys) return null
  const at = (name) => keys.indexOf(name)
  return { translation: at('translation'), scale: at('scale'), left: at('left_rotation'), right: at('right_rotation'), blockState: at('block_state') }
}

const r4 = (v) => Math.round(v * 1e4) / 1e4

/**
 * One part from a Mineflayer entity, or null if it shows nothing.
 * Mineflayer yaw/pitch are radians: yaw = 180° - mcYaw, pitch = -mcPitch.
 */
function readPart (ent, registry, idx, dim) {
  const meta = ent.metadata ?? []
  const stateId = Number(meta[idx.blockState] ?? 0)
  if (!stateId) return null // air: nothing drawn
  const block = registry.blocksByStateId?.[stateId]
  const name = block?.name ?? 'unknown'
  const t = {
    translation: vec(meta[idx.translation], ZERO),
    scale: vec(meta[idx.scale], ONE),
    left: vec(meta[idx.left], NO_ROT),
    right: vec(meta[idx.right], NO_ROT)
  }
  const yaw = 180 - (ent.yaw ?? Math.PI) / DEG
  const pitch = -(ent.pitch ?? 0) / DEG
  const m = displayMatrix(ent.position, yaw, pitch, t)
  const id = colorId(name)
  return {
    id: String(ent.id),
    dim,
    s: stateId,
    name,
    m: m.map(r4),
    box: unitBox(m).map(r4),
    c: id === ID.NONE ? null : shadeRgb(id, SHADE.NORMAL)
  }
}

// ---------- tracker ----------

class DisplayTracker {
  /**
   * @param {{radius:number, maxParts?:number}} opts radius in blocks around each character
   * @param {(msg:object) => void} send
   * @param {{log:Function}} log
   */
  constructor (opts, send, log = console) {
    this.radius = opts.radius
    this.maxParts = opts.maxParts ?? 6000
    this.send = send
    this.log = log
    this.parts = new Map() // id -> part (what Foundry has)
    this.sig = new Map() // id -> signature of the last sent state
    this.reported = -1
    this.lastReport = 0
  }

  /** Recompute the parts near the characters; send what appeared, changed or went away. */
  update (bots) {
    const now = new Map()
    let capped = false
    for (const bot of bots) {
      if (!bot.entity) continue
      const idx = (bot._bwbDisplayIdx ??= metaIndex(bot.registry))
      if (!idx) continue
      const dim = String(bot.game?.dimension ?? 'overworld')
      const p = bot.entity.position
      for (const ent of Object.values(bot.entities)) {
        if (ent.name !== 'block_display' || now.has(String(ent.id))) continue
        if (Math.abs(ent.position.x - p.x) > this.radius || Math.abs(ent.position.z - p.z) > this.radius) continue
        if (now.size >= this.maxParts) { capped = true; break }
        const part = readPart(ent, bot.registry, idx, dim)
        if (part) now.set(part.id, part)
      }
    }
    const add = []
    for (const [id, part] of now) {
      const sig = `${part.s}|${part.m.join(',')}`
      if (this.sig.get(id) === sig) continue
      this.sig.set(id, sig)
      this.parts.set(id, part)
      add.push(part)
    }
    const del = []
    for (const id of this.parts.keys()) if (!now.has(id)) del.push(id)
    for (const id of del) { this.parts.delete(id); this.sig.delete(id) }
    for (let i = 0; i < add.length; i += 400) this.send({ type: 'disp', add: add.slice(i, i + 400), del: [] })
    if (del.length) this.send({ type: 'disp', add: [], del })
    this.report(capped)
  }

  /** A line in the relay log when the number of display parts changes (at most every 5 s). */
  report (capped) {
    const n = this.parts.size
    if (n === this.reported || Date.now() - this.lastReport < 5000) return
    this.reported = n
    this.lastReport = Date.now()
    const kinds = {}
    for (const p of this.parts.values()) kinds[p.name] = (kinds[p.name] ?? 0) + 1
    const top = Object.entries(kinds).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, v]) => `${k} ${v}`).join(', ')
    this.log.log(`디스플레이 블록 ${n}개${n ? ` (${top})` : ''}${capped ? ` — 최대 ${this.maxParts}개까지만 보냅니다` : ''}`)
  }

  /** Everything, for a client that (re)connects: replaces whatever it had. */
  * all () {
    const list = [...this.parts.values()]
    yield { type: 'disp', reset: true, add: list.slice(0, 400), del: [] }
    for (let i = 400; i < list.length; i += 400) yield { type: 'disp', add: list.slice(i, i + 400), del: [] }
  }
}

module.exports = { DisplayTracker, displayMatrix, unitBox, readPart, metaIndex, quat, mul, apply }
