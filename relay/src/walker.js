'use strict'
// Walking a character to a spot clicked on the map.
// With the pathfinder plugin loaded, a path is worked out first (around walls, through doors, up
// steps; never digging or placing blocks) a little each tick so nothing freezes; without it, or
// when no path is found, the character walks straight at the target as before.
// Turning is gradual: the character swings round at a fixed rate and only walks on once it is
// roughly facing the way, so it does not snap about.

const { Vec3 } = require('vec3')

const STUCK_WINDOW_MS = 1500
const STUCK_MIN_PROGRESS = 0.5 // blocks per window
/** Doors a character opens by hand on the way (iron doors need redstone). */
const HAND_DOOR_RE = /^(?!iron_).*(_door|_fence_gate)$/
const DOOR_RETRY_MS = 600
/** How fast a character turns, radians per tick (20 ticks a second): about half a turn in half a second. */
const TURN_PER_TICK = 0.32
/** Facing further off than this, the character turns on the spot before walking on. */
const WALK_WHILE_OFF = 0.5 // about 30 degrees
/** How long a path may take to work out, and how much of each tick it may use. */
const PATH_TIMEOUT_MS = 1500
/** To another floor the search is longer (round by doors, along halls, up flights): give it time. */
const PATH_TIMEOUT_FLOORS_MS = 8000
const PATH_TICK_MS = 15
/** Waypoint reached when this close (horizontal). */
const WAYPOINT_REACH = 0.35
const MAX_REPLANS = 3
/** How many waypoints ahead the character may cut straight to, when the way there is clear. */
const LOOK_AHEAD = 4
/** Half the character's width, plus a little: what a straight cut must keep clear on each side. */
const HALF_WIDTH = 0.38
/** Fences (not walls or gates) a character hops over, with its jump boost. */
const FENCE_RE = /_fence$/
const STAIRS_RE = /_stairs$/
/** On stairs: walk only when facing within this (about 7 degrees), and reach each step's middle closer. */
const STAIR_WALK_WHILE_OFF = 0.12
const STAIR_WAYPOINT_REACH = 0.22
/** The most a planned path may drop, as the path finder counts it (from the feet to the block landed on). */
const MAX_DROP = 3

class WalkStopped extends Error {
  /** @param {'replaced'|'cancelled'|'stuck'|'offline'|'nopath'} reason */
  constructor (reason, message) {
    super(message ?? reason)
    this.reason = reason
  }
}

/** Mineflayer yaw that faces (dx, dz). Verified against a live bot: yaw 0 walks -Z, pi/2 walks -X. */
function yawToward (dx, dz) { return Math.atan2(-dx, -dz) }

/** Smallest signed angle from a to b. */
function angleTo (a, b) {
  let d = (b - a) % (2 * Math.PI)
  if (d > Math.PI) d -= 2 * Math.PI
  if (d < -Math.PI) d += 2 * Math.PI
  return d
}

/** The yaw after one tick of turning from `from` toward `to`. */
function turnStep (from, to, rate = TURN_PER_TICK) {
  const d = angleTo(from, to)
  return Math.abs(d) <= rate ? to : from + Math.sign(d) * rate
}

class StraightWalker {
  constructor (bot) {
    this.bot = bot
    this.current = null // {cancel(reason)}
  }

  get active () { return this.current !== null }

  cancel (reason = 'cancelled') { this.current?.cancel(reason) }

  /** Settings for the path search: walk, climb steps, open doors; never dig, build or parkour. */
  movements () {
    const bot = this.bot
    if (!bot.pathfinder || !this.Movements) return null
    if (!this._movements) {
      const m = new (townMovements(this.Movements))(bot)
      m.canDig = false
      m.allow1by1towers = false
      m.scafoldingBlocks = []
      m.allowParkour = false
      m.allowSprinting = true
      m.canOpenDoors = false // doors are walked through by getBlock below, and opened by the walk
      m.maxDropDown = MAX_DROP
      m.allowEntityDetection = false
      this._movements = m
      bot.pathfinder.setMovements?.(m)
    }
    return this._movements
  }

  /** Use the pathfinder plugin (already loaded into the bot) for routes. */
  usePathfinder ({ Movements, goals }) {
    this.Movements = Movements
    this.goals = goals
    this._movements = null
  }

  /**
   * @param {number} x target block x (fractional ok)
   * @param {number} z target block z
   * @param {number} stopDist arrive when this close (horizontal)
   * @param {number|null} y the height to arrive at (feet), e.g. the floor above up a flight of stairs; null = any
   */
  walkTo (x, z, stopDist = 0.5, y = null) {
    this.cancel('replaced')
    const bot = this.bot
    return new Promise((resolve, reject) => {
      let lastPos = bot.entity.position.clone()
      let lastCheck = Date.now()
      let lastDoor = 0
      let done = false
      let yaw = bot.entity.yaw ?? 0
      let route = null // [{x, y, z}] block centres still to reach; null = straight at the target
      let planner = null
      let replans = 0
      const finish = (err) => {
        if (done) return
        done = true
        bot.removeListener('physicsTick', tick)
        bot.setControlState('forward', false)
        bot.setControlState('sprint', false)
        bot.setControlState('jump', false)
        if (this.current === walk) this.current = null
        err ? reject(err) : resolve()
      }
      const walk = { cancel: (reason) => finish(new WalkStopped(reason)) }

      const plan = () => {
        const movements = this.movements()
        if (!movements) { planner = null; route = null; return }
        const goal = y !== null && this.goals.GoalBlock
          ? new this.goals.GoalBlock(Math.floor(x), Math.round(y), Math.floor(z))
          : stopDist < 1 ? new this.goals.GoalXZ(x, z) : new this.goals.GoalNearXZ(x, z, stopDist)
        try {
          // Every block of the way (not merged into long straight runs, which cut corners).
          const timeout = y !== null ? PATH_TIMEOUT_FLOORS_MS : PATH_TIMEOUT_MS
          planner = bot.pathfinder.getPathFromTo(movements, bot.entity.position, goal, { timeout, tickTimeout: PATH_TICK_MS, optimizePath: false })
        } catch { planner = null; route = null }
      }

      // One slice of path finding per tick until it is done.
      const think = () => {
        let step
        try { step = planner.next() } catch { planner = null; route = null; return }
        if (step.done) { planner = null; return }
        const { result } = step.value
        if (result.status === 'partial') return
        planner = null
        const path = result.path ?? []
        if (result.status === 'noPath' && !path.length) {
          route = null // nothing found: walk straight and see
          return
        }
        route = path.map((n) => ({ x: n.x + 0.5, y: n.y, z: n.z + 0.5, hop: !!n.hop }))
        lastCheck = Date.now()
        lastPos = bot.entity.position.clone()
      }

      const tick = () => {
        if (!bot.entity) return finish(new WalkStopped('offline'))
        const p = bot.entity.position
        const fdx = x - p.x
        const fdz = z - p.z
        const left = Math.hypot(fdx, fdz)
        if (left <= stopDist && (y === null || Math.abs(p.y - y) < 0.7)) return finish()
        if (planner) {
          think()
          if (planner) { bot.setControlState('forward', false); return } // still thinking
        }
        // The server may have moved the character (a correction, a push): carry on from the
        // nearest point of the route, and look again if it is far off it.
        if (route && route.length) {
          let best = 0; let bd = Infinity
          for (let i = 0; i < Math.min(route.length, 12); i++) {
            const d = Math.hypot(route[i].x - p.x, route[i].z - p.z)
            if (d < bd) { bd = d; best = i }
          }
          // Only skip ahead to a waypoint the character is already standing at (never across a wall).
          if (best > 0 && bd < 0.9) route.splice(0, best)
          if (bd > 3 && replans < MAX_REPLANS) { replans++; plan(); return }
        }
        // Where to head now: the next waypoint, or the target itself.
        const stairs = onStairs(bot, p, route?.[0])
        const reach = stairs ? STAIR_WAYPOINT_REACH : WAYPOINT_REACH
        while (route && route.length && Math.hypot(route[0].x - p.x, route[0].z - p.z) <= reach && (!stairs || Math.abs(route[0].y - p.y) < 0.8)) route.shift()
        if (route && !route.length) route = null
        // Cut straight to a waypoint further on when nothing is in the way of the whole body.
        if (route && route.length > 1 && !route[0].hop && !stairs) {
          let far = 0
          for (let i = 1; i < Math.min(route.length, LOOK_AHEAD + 1); i++) {
            if (route[i].y !== route[0].y || route[i].hop || route[i - 1].hop) break
            if (!clearWay(bot, p, route[i])) break
            far = i
          }
          if (far > 0) route.splice(0, far)
        }
        const aim = route ? route[0] : { x, z, y: null }
        const dx = aim.x - p.x
        const dz = aim.z - p.z
        const dist = Math.hypot(dx, dz) || 1e-6
        const want = yawToward(dx, dz)
        yaw = turnStep(yaw, want)
        bot.look(yaw, 0, true)?.catch?.(() => {})
        const off = Math.abs(angleTo(yaw, want))
        const walkWhileOff = stairs ? STAIR_WALK_WHILE_OFF : WALK_WHILE_OFF
        bot.setControlState('forward', off < walkWhileOff)
        bot.setControlState('sprint', !stairs && off < 0.2 && left > 6)
        const now = Date.now()
        // A closed door right ahead: open it and walk on.
        if (now - lastDoor > DOOR_RETRY_MS && openDoorAhead(bot, dx / dist, dz / dist)) {
          lastDoor = now
          lastCheck = now // opening is not being stuck
        }
        // Up a step of stairs the feet step up by themselves: a jump there could carry over the side.
        const stairUp = aim.y !== null && isStairs(bot, aim.x, aim.y - 1, aim.z)
        const up = aim.y !== null && ((aim.y > p.y + 0.5 && !stairUp) || (aim.hop && dist < 1.6))
        bot.setControlState('jump', (up || !!(bot.entity.isCollidedHorizontally || bot.entity.isInWater)) && !doorAhead(bot, dx / dist, dz / dist))
        if (off >= walkWhileOff) { lastCheck = now; lastPos = p.clone(); return } // turning on the spot
        if (now - lastCheck >= STUCK_WINDOW_MS) {
          if (p.distanceTo(lastPos) < STUCK_MIN_PROGRESS) {
            if (replans < MAX_REPLANS && this.movements()) {
              replans++
              plan()
              lastCheck = now
              return
            }
            return finish(new WalkStopped('stuck', '막혀서 멈췄습니다 (갈 수 있는 길이 없습니다)'))
          }
          lastPos = p.clone()
          lastCheck = now
        }
        // Came to the end of a part-way path but not the target: look further. (Under or over the
        // target on another floor counts as far: walking on to its column there would get nowhere.)
        const wrongFloor = y !== null && Math.abs(p.y - y) > 0.7
        if (!route && aim.y === null && replans < MAX_REPLANS && this.movements() && this._hadRoute && (left > 2 || wrongFloor)) {
          this._hadRoute = false
          replans++
          plan()
        }
        if (route) this._hadRoute = true
      }

      this.current = walk
      this._hadRoute = false
      plan()
      bot.on('physicsTick', tick)
    })
  }
}

/**
 * The path finder's moves, made for walking through a town: a diagonal step only when both
 * blocks beside it are free (no clipping wall corners, door frames or posts), and a hop over a
 * one-block fence when there is room to land.
 */
function townMovements (Movements) {
  if (Movements.__town) return Movements.__town
  let Move
  try { Move = require('mineflayer-pathfinder/lib/move') } catch { Move = null }
  class TownMovements extends Movements {
    /**
     * A door one opens by hand counts as a way through, open or shut (the walk opens it on the
     * way): the path finder's own door opening only looks at the lower half and then finds the
     * upper half a wall, so without this no path went through a closed door at all.
     */
    getBlock (pos, dx, dy, dz) {
      const b = super.getBlock(pos, dx, dy, dz)
      if (b?.name && HAND_DOOR_RE.test(b.name)) {
        b.safe = true
        b.physical = false
        b.openable = true
      }
      return b
    }

    getMoveDiagonal (node, dir, neighbors) {
      for (const [dx, dz] of [[dir.x, 0], [0, dir.z]]) {
        for (const dy of [0, 1]) {
          const b = this.getBlock(node, dx, dy, dz)
          if (!b.safe || b.openable) return
        }
      }
      return super.getMoveDiagonal(node, dir, neighbors)
    }

    /**
     * Stairs are walked along, never jumped off: down onto a stair only the way it goes down (not
     * from its side, e.g. into the hole over a flight), and off a stair's side at most one block.
     */
    getMoveDropDown (node, dir, neighbors) {
      const before = neighbors.length
      super.getMoveDropDown(node, dir, neighbors)
      if (neighbors.length === before) return
      const m = neighbors[neighbors.length - 1]
      const along = (b) => {
        const f = { north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0] }[b.getProperties?.().facing]
        return !!f && f[0] === -dir.x && f[1] === -dir.z
      }
      const onto = this.getBlock(m, 0, -1, 0)
      if (onto.name && STAIRS_RE.test(onto.name) && !along(onto)) { neighbors.pop(); return }
      const from = this.getBlock(node, 0, -1, 0)
      if (from.name && STAIRS_RE.test(from.name) && node.y - m.y > 1 && !along(from)) neighbors.pop()
    }

    getNeighbors (node) {
      const neighbors = super.getNeighbors(node)
      if (!Move) return neighbors
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const fence = this.getBlock(node, dx, 0, dz)
        if (!fence.name || !FENCE_RE.test(fence.name)) continue
        const clear = [[0, 2, 0], [dx, 1, dz], [dx, 2, dz], [2 * dx, 0, 2 * dz], [2 * dx, 1, 2 * dz]]
          .every(([a, b, c]) => this.getBlock(node, a, b, c).safe)
        const floor = this.getBlock(node, 2 * dx, -1, 2 * dz)
        if (!clear || !floor.physical) continue
        const m = new Move(node.x + 2 * dx, node.y, node.z + 2 * dz, node.remainingBlocks, 4)
        m.hop = true
        neighbors.push(m)
      }
      return neighbors
    }
  }
  Movements.__town = TownMovements
  return TownMovements
}

function isStairs (bot, x, y, z) {
  if (typeof bot.blockAt !== 'function' || y === null || y === undefined) return false
  const b = bot.blockAt(new Vec3(Math.floor(x), Math.floor(y), Math.floor(z)), false)
  return !!(b && STAIRS_RE.test(b.name))
}

/** Standing on stairs, or about to step onto them (the next waypoint is over a stair). */
function onStairs (bot, p, next) {
  if (isStairs(bot, p.x, p.y - 0.6, p.z) || isStairs(bot, p.x, p.y, p.z)) return true
  return !!(next && next.y !== null && next.y !== undefined && (isStairs(bot, next.x, next.y - 1, next.z) || isStairs(bot, next.x, next.y, next.z)))
}

/** Can the whole body go straight from p to the waypoint (feet and head level, both edges)? */
function clearWay (bot, p, to) {
  if (typeof bot.blockAt !== 'function') return false
  const dx = to.x - p.x; const dz = to.z - p.z
  const len = Math.hypot(dx, dz)
  if (len < 1e-6) return true
  const nx = -dz / len; const nz = dx / len // sideways
  const y = Math.floor(to.y ?? p.y)
  for (let t = 0; t <= len; t += 0.25) {
    for (const side of [-HALF_WIDTH, 0, HALF_WIDTH]) {
      const cx = p.x + dx * (t / len) + nx * side
      const cz = p.z + dz * (t / len) + nz * side
      for (const up of [0, 1]) {
        const b = bot.blockAt(new Vec3(Math.floor(cx), y + up, Math.floor(cz)), false)
        if (!b) return false
        if (b.boundingBox !== 'empty' && !CARPET_RE.test(b.name)) return false
      }
      // and something to stand on
      const under = bot.blockAt(new Vec3(Math.floor(cx), y - 1, Math.floor(cz)), false)
      if (!under || under.boundingBox === 'empty') return false
    }
  }
  return true
}
const CARPET_RE = /_carpet$/

/** The closed hand-opened door (block) at feet or head height just ahead, or null. */
function doorAhead (bot, ux, uz) {
  if (typeof bot.blockAt !== 'function') return null
  const p = bot.entity.position
  for (const reach of [0.8, 1.3]) {
    for (const up of [0, 1]) {
      const b = bot.blockAt(p.offset(ux * reach, up, uz * reach).floored(), false)
      if (b && HAND_DOOR_RE.test(b.name) && b.getProperties?.().open !== true) return b
    }
  }
  return null
}

/** Open the closed door just ahead, if there is one. */
function openDoorAhead (bot, ux, uz) {
  const door = doorAhead(bot, ux, uz)
  if (!door) return false
  bot.activateBlock(door)?.catch?.(() => {})
  return true
}

module.exports = { StraightWalker, WalkStopped, yawToward, turnStep, angleTo, doorAhead, clearWay, townMovements, onStairs, HAND_DOOR_RE }
