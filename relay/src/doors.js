'use strict'
// Doors and secret doors driven from Foundry: open or close a Minecraft door, or open a secret
// passage by lifting the wall blocks out (and put them back when it closes).
const { Vec3 } = require('vec3')

const DOOR_RE = /_door$|_fence_gate$/
/** A block state as setblock takes it, without the namespace: name[key=value,...]. */
const STATE_RE = /^[a-z0-9_]+(\[[a-z0-9_]+=[a-z0-9_]+(,[a-z0-9_]+=[a-z0-9_]+)*\])?$/

class DoorError extends Error {}

function int (v, min, max, name) {
  const n = Number(v)
  if (!Number.isInteger(n) || n < min || n > max) throw new DoorError(`${name} 값이 잘못되었습니다`)
  return n
}

function coords (m) {
  return {
    x: int(m.x, -29999999, 29999999, 'x'),
    y: int(m.y, -64, 319, 'y'),
    z: int(m.z, -29999999, 29999999, 'z')
  }
}

/** The block at x,y,z from the first character that has it loaded. */
function blockAt (bots, x, y, z) {
  const p = new Vec3(x, y, z)
  for (const e of bots.onlineBots()) {
    try {
      const b = e.bot.blockAt(p, false)
      if (b) return b
    } catch { /* next */ }
  }
  return null
}

/** name[props] of a block, as setblock takes it. */
function stateString (block, override = {}) {
  const props = { ...(block.getProperties?.() ?? {}), ...override }
  const list = Object.entries(props).map(([k, v]) => `${k}=${v}`).join(',')
  return list ? `${block.name}[${list}]` : block.name
}

/**
 * Open or close the door whose cell the floor plan drew at x,z (y = the plan's cut height: the
 * upper half of a door). Only the lower half is set; the game makes the upper half follow.
 */
async function setDoor (bots, m) {
  const { x, y, z } = coords(m)
  const open = m.open === true
  for (let yy = y + 1; yy >= y - 2; yy--) {
    const b = blockAt(bots, x, yy, z)
    if (!b || !DOOR_RE.test(b.name)) continue
    if (b.getProperties?.().half === 'upper') continue
    await bots.runCommand(`setblock ${x} ${yy} ${z} minecraft:${stateString(b, { open })}`)
    return true
  }
  throw new DoorError('그 자리에서 문을 찾지 못했습니다 (캐릭터가 근처에 있어야 합니다)')
}

/**
 * A secret passage at x,z: opening lifts out the two blocks a character walks through (y-1, y)
 * and returns them as [[y, state], ...]; closing puts the given blocks back.
 */
async function setSecret (bots, m) {
  const { x, y, z } = coords(m)
  if (m.open === true) {
    const blocks = []
    for (const yy of [y - 1, y]) {
      const b = blockAt(bots, x, yy, z)
      if (!b) throw new DoorError('그 자리가 불러와져 있지 않습니다 (캐릭터가 근처에 있어야 합니다)')
      if (b.name === 'air' || b.name === 'cave_air') continue
      blocks.push([yy, stateString(b)])
    }
    for (const [yy] of blocks) await bots.runCommand(`setblock ${x} ${yy} ${z} minecraft:air`)
    return blocks
  }
  const blocks = Array.isArray(m.blocks) ? m.blocks.slice(0, 4) : []
  for (const [yy, state] of blocks) {
    const at = int(yy, -64, 319, 'y')
    if (typeof state !== 'string' || !STATE_RE.test(state)) throw new DoorError(`잘못된 블록: ${state}`)
    await bots.runCommand(`setblock ${x} ${at} ${z} minecraft:${state}`)
  }
  return true
}

module.exports = { setDoor, setSecret, stateString, DoorError, STATE_RE }
