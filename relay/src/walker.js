'use strict'
// Straight-line walking: face the target and hold "forward" until we arrive.
// Hops one-block steps on its own; gives up when it stops making progress (a wall, a cliff face).

const STUCK_WINDOW_MS = 1500
const STUCK_MIN_PROGRESS = 0.5 // blocks per window

class WalkStopped extends Error {
  /** @param {'replaced'|'cancelled'|'stuck'|'offline'} reason */
  constructor (reason, message) {
    super(message ?? reason)
    this.reason = reason
  }
}

/** Mineflayer yaw that faces (dx, dz). Verified against a live bot: yaw 0 walks -Z, pi/2 walks -X. */
function yawToward (dx, dz) { return Math.atan2(-dx, -dz) }

class StraightWalker {
  constructor (bot) {
    this.bot = bot
    this.current = null // {cancel(reason)}
  }

  get active () { return this.current !== null }

  cancel (reason = 'cancelled') { this.current?.cancel(reason) }

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
      let done = false
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

      const tick = () => {
        if (!bot.entity) return finish(new WalkStopped('offline'))
        const p = bot.entity.position
        const dx = x - p.x
        const dz = z - p.z
        const dist = Math.hypot(dx, dz)
        if (dist <= stopDist) return finish()
        bot.look(yawToward(dx, dz), 0, true)?.catch?.(() => {})
        bot.setControlState('forward', true)
        bot.setControlState('sprint', dist > 6)
        bot.setControlState('jump', !!(bot.entity.isCollidedHorizontally || bot.entity.isInWater))
        const now = Date.now()
        if (now - lastCheck >= STUCK_WINDOW_MS) {
          if (p.distanceTo(lastPos) < STUCK_MIN_PROGRESS) {
            return finish(new WalkStopped('stuck', '막혀서 멈췄습니다 (높은 벽이나 절벽)'))
          }
          lastPos = p.clone()
          lastCheck = now
        }
      }

      this.current = walk
      bot.on('physicsTick', tick)
    })
  }
}

module.exports = { StraightWalker, WalkStopped, yawToward }
