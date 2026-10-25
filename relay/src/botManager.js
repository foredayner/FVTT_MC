'use strict'
// One Mineflayer bot per Foundry user. The bot is the character; Foundry only sends intentions.
const EventEmitter = require('events')
const mineflayer = require('mineflayer')
const { Vec3 } = require('vec3')
const { NAME_RE } = require('./gmCommands')
const { StraightWalker, WalkStopped } = require('./walker')

const CONTROLS = new Set(['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak'])
const HOSTILE_HINT = /zombie|skeleton|spider|creeper|enderman|witch|slime|husk|stray|drowned|pillager|vindicator|phantom|warden|blaze|ghast|piglin|hoglin|guardian|evoker|ravager|silverfish|endermite|shulker|vex|wither|zoglin|breeze|bogged/
const REACH = 4.2

class BotManager extends EventEmitter {
  /**
   * @param {object} cfg relay config
   * @param {import('./mapScanner').MapScanner} scanner
   * @param {{attach(bot:any):void}[]} [watchers] extra listeners attached to every bot (3D streaming)
   */
  constructor (cfg, scanner, watchers = []) {
    super()
    this.cfg = cfg
    this.scanner = scanner
    this.watchers = watchers
    /** @type {Map<string, {key:string, username:string, bot:any, online:boolean, busy:Promise|null, walker:StraightWalker}>} */
    this.entries = new Map()
    this.rcon = null
  }

  // ---------- lifecycle ----------

  spawn (key, username) {
    if (typeof key !== 'string' || !key) throw new Error('key 가 필요합니다')
    if (!NAME_RE.test(username ?? '')) throw new Error('마크 이름은 영문/숫자/_ 1~16자여야 합니다')
    const existing = this.entries.get(key)
    if (existing) {
      if (existing.username === username) return existing
      this.despawn(key)
    }
    for (const e of this.entries.values()) {
      if (e.username.toLowerCase() === username.toLowerCase()) throw new Error(`이미 사용 중인 마크 이름: ${username}`)
    }
    if (this.entries.size >= this.cfg.maxBots) throw new Error(`봇은 최대 ${this.cfg.maxBots}개까지입니다`)

    const { host, port, version, auth } = this.cfg.minecraft
    const bot = mineflayer.createBot({ host, port, version, auth, username, hideErrors: true })
    const entry = { key, username, bot, online: false, busy: null, walker: new StraightWalker(bot) }
    this.entries.set(key, entry)

    bot.once('spawn', () => {
      entry.online = true
      this.scanner.attach(bot)
      for (const w of this.watchers) w.attach(bot)
      this.info(key, `${username} 접속`)
      this.emit('bots')
    })
    bot.on('death', () => {
      entry.walker.cancel()
      this.emit('event', { kind: 'death', key, text: `${username} 사망` })
    })
    bot.on('respawn', () => this.emit('event', { kind: 'info', key, text: `${username} 부활` }))
    bot.on('messagestr', (msg, position) => {
      // Every bot hears the same chat; only the oldest online bot reports it.
      if (position === 'game_info') return
      if (this.chatReporter() !== entry) return
      this.emit('event', { kind: 'chat', text: msg })
    })
    bot.on('kicked', (reason) => this.emit('event', { kind: 'kicked', key, text: `${username} 추방됨: ${flatten(reason)}` }))
    bot.on('error', (err) => this.emit('event', { kind: 'error', key, text: `${username}: ${err.message}` }))
    bot.on('end', (reason) => {
      entry.online = false
      entry.walker.cancel()
      if (this.entries.get(key) === entry) this.entries.delete(key)
      this.info(key, `${username} 연결 종료 (${reason ?? 'end'})`)
      this.emit('bots')
    })
    this.emit('bots')
    return entry
  }

  despawn (key) {
    const e = this.entries.get(key)
    if (!e) return
    this.entries.delete(key)
    e.walker.cancel()
    try { e.bot.quit('despawn') } catch {}
    this.emit('bots')
  }

  closeAll () { for (const k of [...this.entries.keys()]) this.despawn(k) }

  chatReporter () {
    for (const e of this.entries.values()) if (e.online) return e
    return null
  }

  onlineBots () { return [...this.entries.values()].filter((e) => e.online && e.bot.entity) }

  info (key, text) { this.emit('event', { kind: 'info', key, text }) }

  get (key) {
    const e = this.entries.get(key)
    if (!e || !e.online) throw new Error('해당 캐릭터가 접속 중이 아닙니다')
    return e
  }

  // ---------- intentions from Foundry ----------

  /** Walk in a straight line to x,z. Returns at once; problems are reported as events. */
  moveTo (key, x, z) {
    const e = this.get(key)
    e.bot.clearControlStates()
    e.walker.walkTo(x, z, 0.5).catch((err) => this.reportWalk(e, err))
  }

  stop (key) {
    const e = this.get(key)
    e.walker.cancel()
    e.bot.clearControlStates()
  }

  /** Dig the surface block of column x,z (or a given y), walking closer first if needed. */
  async dig (key, x, z, y) {
    const e = this.get(key)
    const { bot } = e
    const dim = String(bot.game?.dimension ?? 'overworld')
    const yy = Number.isInteger(y) ? y : this.scanner.surfaceY(dim, x, z)
    if (yy === null) throw new Error('그 위치의 블록 정보를 아직 모릅니다')
    const pos = new Vec3(Math.floor(x), yy, Math.floor(z))
    return this.exclusive(e, async () => {
      const centre = pos.offset(0.5, 0.5, 0.5)
      if (bot.entity.position.distanceTo(centre) > REACH) {
        await e.walker.walkTo(centre.x, centre.z, 2.5).catch((err) => this.walkFailed(err))
      }
      if (bot.entity.position.distanceTo(centre) > REACH + 0.5) throw new Error('블록까지 닿지 않습니다')
      const block = bot.blockAt(pos)
      if (!block || !bot.canDigBlock(block)) throw new Error('캘 수 없는 블록입니다')
      await bot.dig(block, true)
    })
  }

  /** Attack the nearest non-bot entity close to x,z. */
  async attackAt (key, x, z) {
    const e = this.get(key)
    const { bot } = e
    const target = this.nearestEntity(bot, x, z, 2.5)
    if (!target) throw new Error('그 근처에 대상이 없습니다')
    return this.exclusive(e, async () => {
      if (bot.entity.position.distanceTo(target.position) > 3) {
        await e.walker.walkTo(target.position.x, target.position.z, 2).catch((err) => this.walkFailed(err))
      }
      if (target.isValid && bot.entity.position.distanceTo(target.position) <= 3.5) {
        await bot.lookAt(target.position.offset(0, target.height * 0.8, 0), true)
        bot.attack(target)
      } else {
        throw new Error('대상에게 닿지 않습니다')
      }
    })
  }

  /** Manual WASD-style control from the 3D window. */
  control (key, control, state) {
    if (!CONTROLS.has(control)) throw new Error(`알 수 없는 조작: ${control}`)
    const e = this.get(key)
    if (state && e.walker.active) e.walker.cancel()
    e.bot.setControlState(control, !!state)
  }

  look (key, yaw, pitch) {
    const { bot } = this.get(key)
    if (!Number.isFinite(yaw) || !Number.isFinite(pitch)) return
    const p = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, pitch))
    bot.look(yaw, p, true)
  }

  /** Mouse button in the 3D window: left = hit entity or dig block under cursor, right = use block. */
  async cursor (key, button) {
    const e = this.get(key)
    const { bot } = e
    if (button === 'left') {
      const ent = typeof bot.entityAtCursor === 'function' ? bot.entityAtCursor(3.5) : null
      if (ent && !this.isOurBot(ent)) { bot.attack(ent); return }
      const block = bot.blockAtCursor(5)
      if (!block || !bot.canDigBlock(block)) return
      if (bot.targetDigBlock) return // already digging
      return this.exclusive(e, () => bot.dig(block, 'ignore'))
    }
    if (button === 'right') {
      const block = bot.blockAtCursor(5)
      if (block) await bot.activateBlock(block)
    }
  }

  chat (key, msg) {
    const { bot } = this.get(key)
    const t = String(msg ?? '').trim().slice(0, 240)
    if (!t) return
    if (t.startsWith('/')) throw new Error('명령어는 GM 패널로만 보낼 수 있습니다')
    bot.chat(t)
  }

  /** Run a whitelisted server command (already built by gmCommands). */
  async runCommand (cmd) {
    if (this.rcon) return this.rcon.send(cmd)
    const e = this.chatReporter()
    if (!e) throw new Error('RCON 이 꺼져 있고 접속한 봇도 없어 명령을 보낼 수 없습니다')
    e.bot.chat('/' + cmd) // requires the bot to be op
    return '(봇 채팅으로 전송 — 봇에 OP 권한이 필요합니다)'
  }

  reportWalk (entry, err) {
    if (err instanceof WalkStopped && err.reason !== 'stuck') return // replaced / cancelled: not news
    this.emit('event', { kind: 'warn', key: entry.key, text: `${entry.username}: ${err.message}` })
  }

  walkFailed (err) {
    if (err instanceof WalkStopped && err.reason !== 'stuck') throw err
    // stuck: carry on and let the reach check decide
  }

  // ---------- snapshots ----------

  isOurBot (entity) {
    if (entity.type !== 'player') return false
    for (const e of this.entries.values()) if (e.username === entity.username) return true
    return false
  }

  nearestEntity (bot, x, z, maxDist) {
    let best = null; let bestD = maxDist
    for (const ent of Object.values(bot.entities)) {
      if (ent === bot.entity || this.isOurBot(ent) || !kindOf(ent)) continue
      const d = Math.hypot(ent.position.x - x, ent.position.z - z)
      if (d < bestD) { best = ent; bestD = d }
    }
    return best
  }

  botList () {
    return [...this.entries.values()].map((e) => ({
      key: e.key, username: e.username, online: e.online
    }))
  }

  snapshot () {
    const bots = []
    const entities = new Map()
    for (const e of this.onlineBots()) {
      const { bot } = e
      const p = bot.entity.position
      bots.push({
        key: e.key,
        x: round(p.x), y: round(p.y), z: round(p.z),
        yaw: round(bot.entity.yaw, 3), pitch: round(bot.entity.pitch, 3),
        health: bot.health ?? null, food: bot.food ?? null,
        dim: String(bot.game?.dimension ?? 'overworld'),
        moving: e.walker.active
      })
      for (const ent of Object.values(bot.entities)) {
        if (ent === bot.entity || entities.has(ent.id) || this.isOurBot(ent)) continue
        const kind = kindOf(ent)
        if (!kind || ent.position.distanceTo(p) > this.cfg.entityRadius) continue
        entities.set(ent.id, {
          id: ent.id, kind, name: ent.username ?? ent.name ?? 'entity',
          x: round(ent.position.x), y: round(ent.position.y), z: round(ent.position.z)
        })
      }
    }
    return { bots, entities: [...entities.values()] }
  }

  /** Make sure only one long action (dig/attack walk) runs per bot at a time. */
  exclusive (entry, fn) {
    if (entry.busy) throw new Error('이전 동작이 아직 진행 중입니다')
    entry.busy = Promise.resolve().then(fn).finally(() => { entry.busy = null })
    return entry.busy
  }
}

function kindOf (ent) {
  if (ent.type === 'player') return 'player'
  if (ent.type === 'hostile') return 'hostile'
  if (['animal', 'passive', 'water_creature', 'ambient'].includes(ent.type)) return 'passive'
  if (ent.type === 'mob') return HOSTILE_HINT.test(ent.name ?? '') ? 'hostile' : 'passive'
  return null // items, arrows, xp orbs...
}

function round (v, d = 2) { const k = 10 ** d; return Math.round(v * k) / k }

function flatten (reason) {
  if (typeof reason === 'string') return reason
  try { return JSON.stringify(reason).slice(0, 200) } catch { return 'unknown' }
}

module.exports = { BotManager, kindOf }
