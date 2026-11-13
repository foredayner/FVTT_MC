'use strict'
// Clues in the Minecraft world, driven from Foundry (where the clue itself lives, as a journal).
//
// A placed clue is an invisible, clickable box (minecraft:interaction) with an item floating in its
// middle (minecraft:item_display: a sheet of paper, a book, a key...). Both carry the tags
// bwb_clue and bwb_c_<id>, so they can be found and removed. The relay remembers where each one
// is, so a right click in the 3D view can tell which clue the character is looking at.
//
// Taking a clue that can be carried gives the character an item: a written book with the clue's
// text, or the item itself with the clue's name and a line of lore.

const ID_RE = /^[A-Za-z0-9_-]{1,40}$/
const ITEM_RE = /^[a-z0-9_]{1,40}$/
const BOOKISH = new Set(['paper', 'book', 'written_book', 'writable_book', 'map', 'filled_map', 'enchanted_book'])

class ClueError extends Error {}

function int (v, name, min = -30000000, max = 30000000) {
  const n = Number(v)
  if (!Number.isInteger(n) || n < min || n > max) throw new ClueError(`${name} 값이 잘못되었습니다`)
  return n
}

function clueId (v) {
  const s = String(v ?? '')
  if (!ID_RE.test(s)) throw new ClueError('단서 id 가 잘못되었습니다')
  return s
}

function itemName (v) {
  const s = String(v ?? 'paper').replace(/^minecraft:/, '')
  if (!ITEM_RE.test(s)) throw new ClueError('아이템 이름이 잘못되었습니다')
  return s
}

/** A string inside an SNBT string in double quotes. */
function snbtString (s) {
  return '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'
}

/** A JSON text component, as an SNBT string in single quotes (what 1.21.4 item components take). */
function textComponent (text, extra = {}) {
  const json = JSON.stringify({ text: String(text), ...extra })
  return "'" + json.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'"
}

/** Book pages of at most ~220 characters each, at most 50 pages. */
function pages (text) {
  const out = []
  let rest = String(text ?? '').replace(/\r/g, '')
  while (rest.length && out.length < 50) {
    let cut = Math.min(rest.length, 220)
    if (cut < rest.length) {
      const nl = rest.lastIndexOf('\n', cut)
      const sp = rest.lastIndexOf(' ', cut)
      const at = Math.max(nl, sp)
      if (at > 120) cut = at
    }
    out.push(rest.slice(0, cut).trim())
    rest = rest.slice(cut).replace(/^[\s]+/, '')
  }
  return out.length ? out : ['']
}

/** The command that gives a clue to a character (a book, or the item itself, named). */
function giveCommand (username, { id, title, text, item }) {
  const name = String(username ?? '')
  if (!/^[A-Za-z0-9_]{1,16}$/.test(name)) throw new ClueError('캐릭터 이름이 잘못되었습니다')
  const cid = clueId(id)
  const it = itemName(item)
  const t = String(title ?? '단서').slice(0, 32) || '단서'
  const data = `minecraft:custom_data={bwb_clue:${snbtString(cid)}}`
  if (BOOKISH.has(it)) {
    const body = pages(text).map((p) => textComponent(p)).join(',')
    return `give ${name} minecraft:written_book[minecraft:written_book_content={title:${snbtString(t)},author:"",pages:[${body}]},${data}] 1`
  }
  const lore = pages(text).slice(0, 4).map((p) => textComponent(p.slice(0, 60), { italic: false, color: 'gray' })).join(',')
  return `give ${name} minecraft:${it}[minecraft:custom_name=${textComponent(t, { italic: false })},minecraft:lore=[${lore}],${data}] 1`
}

class ClueSpots {
  constructor (bots) {
    this.bots = bots
    this.spots = new Map() // id -> {x, y, z, item}
  }

  /** Put (or move) a clue's object at block x,y,z (y: the block it floats in). */
  async place (m) {
    const id = clueId(m.id)
    const x = int(m.x, 'x'); const y = int(m.y, 'y', -64, 319); const z = int(m.z, 'z')
    const item = itemName(m.item)
    await this.remove({ id }).catch(() => {})
    const tags = `Tags:["bwb_clue","bwb_c_${id}"]`
    const cx = x + 0.5; const cz = z + 0.5
    await this.bots.runCommand(`summon minecraft:interaction ${cx} ${y} ${cz} {width:0.8f,height:0.9f,response:1b,${tags}}`)
    await this.bots.runCommand(`summon minecraft:item_display ${cx} ${y + 0.5} ${cz} {item:{id:"minecraft:${item}",count:1},billboard:"vertical",` +
      `transformation:{left_rotation:[0f,0f,0f,1f],right_rotation:[0f,0f,0f,1f],translation:[0f,0f,0f],scale:[0.6f,0.6f,0.6f]},${tags}}`)
    this.spots.set(id, { x, y, z, item })
    return true
  }

  async remove (m) {
    const id = clueId(m.id)
    this.spots.delete(id)
    await this.bots.runCommand(`kill @e[tag=bwb_c_${id}]`)
    return true
  }

  /** Foundry's list of placed clues (after a reconnect): remembered without touching the world. */
  known (list) {
    if (!Array.isArray(list)) return false
    this.spots.clear()
    for (const c of list.slice(0, 2000)) {
      try { this.spots.set(clueId(c.id), { x: int(c.x, 'x'), y: int(c.y, 'y', -64, 319), z: int(c.z, 'z'), item: itemName(c.item) }) } catch { /* skip */ }
    }
    return true
  }

  async give (m, username) {
    await this.bots.runCommand(giveCommand(username, m))
    return true
  }

  /**
   * The clue a character is looking at (within reach), if any: the one whose box the line of
   * sight passes nearest to.
   */
  atCursor (bot, reach = 4.5) {
    const e = bot?.entity
    if (!e) return null
    const eye = { x: e.position.x, y: e.position.y + (e.height ?? 1.62), z: e.position.z }
    const dir = { x: -Math.sin(e.yaw) * Math.cos(e.pitch), y: Math.sin(e.pitch), z: -Math.cos(e.yaw) * Math.cos(e.pitch) }
    let best = null; let bestD = 0.6
    for (const [id, s] of this.spots) {
      const c = { x: s.x + 0.5, y: s.y + 0.45, z: s.z + 0.5 }
      const v = { x: c.x - eye.x, y: c.y - eye.y, z: c.z - eye.z }
      const t = v.x * dir.x + v.y * dir.y + v.z * dir.z
      if (t < 0 || t > reach) continue
      const off = Math.hypot(v.x - dir.x * t, v.y - dir.y * t, v.z - dir.z * t)
      if (off < bestD) { best = id; bestD = off }
    }
    return best
  }
}

module.exports = { ClueSpots, giveCommand, pages, ClueError }
