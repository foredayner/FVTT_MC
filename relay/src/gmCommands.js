'use strict'
// GM actions arrive as structured objects, never as raw command text.
// Each one is validated against a whitelist and turned into exactly one server command.

const NAME_RE = /^[A-Za-z0-9_]{1,16}$/
const EFFECTS = new Set([
  'slowness', 'speed', 'blindness', 'darkness', 'nausea', 'weakness', 'strength', 'regeneration',
  'poison', 'night_vision', 'glowing', 'jump_boost', 'levitation', 'resistance', 'fire_resistance',
  'invisibility', 'hunger', 'mining_fatigue', 'haste'
])
const MOBS = new Set([
  'zombie', 'skeleton', 'spider', 'creeper', 'enderman', 'witch', 'slime', 'husk', 'stray', 'drowned',
  'pillager', 'vindicator', 'phantom', 'cow', 'pig', 'sheep', 'chicken', 'horse', 'wolf', 'cat',
  'villager', 'iron_golem', 'bat', 'fox', 'rabbit', 'allay', 'warden'
])
const TIMES = new Set(['day', 'noon', 'night', 'midnight'])
const WEATHER = new Set(['clear', 'rain', 'thunder'])

class GmCommandError extends Error {}

function target (t) {
  if (t === '@a') return '@a'
  if (typeof t === 'string' && NAME_RE.test(t)) return t
  throw new GmCommandError(`잘못된 대상: ${t}`)
}

function int (v, min, max, name) {
  const n = Number(v)
  if (!Number.isInteger(n) || n < min || n > max) throw new GmCommandError(`${name} 값은 ${min}~${max} 사이 정수여야 합니다`)
  return n
}

function text (v, max = 120) {
  if (typeof v !== 'string' || !v.trim()) throw new GmCommandError('문구가 비어 있습니다')
  // JSON.stringify produces a valid JSON text component and escapes quotes/backslashes.
  return JSON.stringify({ text: v.slice(0, max) })
}

/** @returns {string[]} the server command(s), without a leading slash */
function buildGmCommand ({ action, args = {} }) {
  switch (action) {
    case 'time':
      if (!TIMES.has(args.value)) throw new GmCommandError('time 값은 day/noon/night/midnight')
      return [`time set ${args.value}`]
    case 'weather':
      if (!WEATHER.has(args.value)) throw new GmCommandError('weather 값은 clear/rain/thunder')
      return [`weather ${args.value}`]
    case 'title': {
      const who = target(args.target ?? '@a')
      const cmds = [`title ${who} times 10 70 20`]
      if (args.subtitle) cmds.push(`title ${who} subtitle ${text(args.subtitle)}`)
      cmds.push(`title ${who} title ${text(args.text)}`)
      return cmds
    }
    case 'actionbar':
      return [`title ${target(args.target ?? '@a')} actionbar ${text(args.text)}`]
    case 'effect': {
      if (!EFFECTS.has(args.effect)) throw new GmCommandError(`허용되지 않은 효과: ${args.effect}`)
      const s = int(args.seconds ?? 10, 1, 600, 'seconds')
      const a = int(args.amplifier ?? 0, 0, 4, 'amplifier')
      return [`effect give ${target(args.target)} minecraft:${args.effect} ${s} ${a}`]
    }
    case 'summon': {
      if (!MOBS.has(args.mob)) throw new GmCommandError(`허용되지 않은 몹: ${args.mob}`)
      const who = target(args.near)
      if (who === '@a') throw new GmCommandError('summon 은 한 명을 기준으로만 가능합니다')
      const dx = int(args.dx ?? 3, -16, 16, 'dx')
      const dz = int(args.dz ?? 0, -16, 16, 'dz')
      return [`execute at ${who} run summon minecraft:${args.mob} ~${dx} ~ ~${dz}`]
    }
    case 'tp': {
      const who = target(args.target)
      const x = int(args.x, -30000000, 30000000, 'x')
      const y = int(args.y, -64, 320, 'y')
      const z = int(args.z, -30000000, 30000000, 'z')
      return [`tp ${who} ${x} ${y} ${z}`]
    }
    default:
      throw new GmCommandError(`알 수 없는 GM 명령: ${action}`)
  }
}

module.exports = { buildGmCommand, GmCommandError, NAME_RE, EFFECTS, MOBS }
