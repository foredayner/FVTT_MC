'use strict'
// Walking a character to a spot clicked on the map.
// With the pathfinder plugin loaded, a path is worked out first (around walls, through doors, up
// steps; never digging or placing blocks) a little each tick so nothing freezes; without it, or
// when no path is found, the character walks straight at the target as before.
// Turning is gradual: the character swings round at a fixed rate and only walks on once it is
// roughly facing the way, so it does not snap about.

const STUCK_WINDOW_MS = 1500
const STUCK_MIN_PROGRESS = 0.5 // blocks per window
/** Doors a character opens by hand on the way (iron doors need redstone). */
const HAND_DOOR_RE = /^(?!iron_).*(_door|_fence_gate)$/
const DOOR_RETRY_MS = 600
/** How fast a character turns, radians per tick (20 ticks a second): about half a turn in half a second. */
const TURN_PER_TICK = 0.32
/** Facing further off than this, the character turns on the spot before walking on. */
const WALK_WHILE_OFF = 0.35 // 20 degrees
/** How long a path may take to work out, and how much of each tick it may use. */
const PATH_TIMEOUT_MS = 1500
const PATH_TICK_MS = 15
/** Waypoint reached when this close (horizontal). */
const WAYPOINT_REACH = 0.35
const MAX_REPLANS = 3

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
      const m = new this.Movements(bot)
      m.canDig = false
      m.allow1by1towers = false
      m.scafoldingBlocks = []
      m.allowParkour = false
      m.allowSprinting = true
      m.canOpenDoors = true
      m.maxDropDown = 3
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
   */
  walkTo (x, z, stopDist = 0.5) {
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
        const goal = stopDist < 1 ? new this.goals.GoalXZ(x, z) : new this.goals.GoalNearXZ(x, z, stopDist)
        try {
          planner = bot.pathfinder.getPathFromTo(movements, bot.entity.position, goal, { timeout: PATH_TIMEOUT_MS, tickTimeout: PATH_TICK_MS })
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
        route = path.map((n) => ({ x: n.x + 0.5, y: n.y, z: n.z + 0.5 }))
        lastCheck = Date.now()
        lastPos = bot.entity.position.clone()
      }

      const tick = () => {
        if (!bot.entity) return finish(new WalkStopped('offline'))
        const p = bot.entity.position
        const fdx = x - p.x
        const fdz = z - p.z
        const left = Math.hypot(fdx, fdz)
        if (left <= stopDist) return finish()
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
          if (best > 0) route.splice(0, best)
          if (bd > 3 && replans < MAX_REPLANS) { replans++; plan(); return }
        }
        // Where to head now: the next waypoint, or the target itself.
        while (route && route.length && Math.hypot(route[0].x - p.x, route[0].z - p.z) <= WAYPOINT_REACH) route.shift()
        if (route && !route.length) route = null
        const aim = route ? route[0] : { x, z, y: null }
        const dx = aim.x - p.x
        const dz = aim.z - p.z
        const dist = Math.hypot(dx, dz) || 1e-6
        const want = yawToward(dx, dz)
        yaw = turnStep(yaw, want)
        bot.look(yaw, 0, true)?.catch?.(() => {})
        const off = Math.abs(angleTo(yaw, want))
        bot.setControlState('forward', off < WALK_WHILE_OFF)
        bot.setControlState('sprint', off < 0.2 && left > 6)
        const now = Date.now()
        // A closed door right ahead: open it and walk on.
        if (now - lastDoor > DOOR_RETRY_MS && openDoorAhead(bot, dx / dist, dz / dist)) {
          lastDoor = now
          lastCheck = now // opening is not being stuck
        }
        const up = aim.y !== null && aim.y > p.y + 0.5
        bot.setControlState('jump', (up || !!(bot.entity.isCollidedHorizontally || bot.entity.isInWater)) && !doorAhead(bot, dx / dist, dz / dist))
        if (off >= WALK_WHILE_OFF) { lastCheck = now; lastPos = p.clone(); return } // turning on the spot
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
        // Came to the end of a part-way path but not the target: look further.
        if (!route && aim.y === null && replans < MAX_REPLANS && this.movements() && this._hadRoute && left > 2) {
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

module.exports = { StraightWalker, WalkStopped, yawToward, turnStep, angleTo, doorAhead, HAND_DOOR_RE }
