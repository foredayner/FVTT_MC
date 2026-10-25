'use strict'
// What a player's screen would show besides the world: titles (GM narration), subtitles and the
// action bar. Read from the raw 1.21.4 packets, whose text is an NBT text component.
// Each bot reports its own, so a title sent to one player only reaches that player's 3D view.

const nbt = require('prismarine-nbt')

const TRANSLATIONS = {
  'chat.type.text': '<%s> %s',
  'chat.type.announcement': '[%s] %s',
  'chat.type.emote': '* %s %s',
  'commands.message.display.incoming': '%s whispers to you: %s'
}

/** Plain text of a text component given as JSON text, a parsed object, or an NBT tag. */
function componentText (c) {
  if (c == null) return ''
  if (typeof c === 'string') {
    const s = c.trim()
    if ((s.startsWith('{') && s.endsWith('}')) || (s.startsWith('[') && s.endsWith(']')) || (s.startsWith('"') && s.endsWith('"'))) {
      try { return componentText(JSON.parse(s)) } catch { /* plain text that looks like JSON */ }
    }
    return c
  }
  if (typeof c === 'number' || typeof c === 'boolean') return String(c)
  if (Array.isArray(c)) return c.map(componentText).join('')
  if (typeof c === 'object' && typeof c.type === 'string' && 'value' in c) return componentText(nbt.simplify(c))
  if (typeof c !== 'object') return ''
  let out = ''
  if (c.text !== undefined) out += componentText(c.text)
  else if (c[''] !== undefined) out += componentText(c[''])
  if (c.translate) {
    const args = (c.with ?? []).map(componentText)
    const pattern = TRANSLATIONS[c.translate] ?? (c.fallback ?? c.translate + (args.length ? ' %s'.repeat(args.length) : ''))
    let i = 0
    out += pattern.replace(/%(\d+\$)?s/g, (_, pos) => args[pos ? parseInt(pos, 10) - 1 : i++] ?? '')
  }
  if (c.extra) out += componentText(c.extra)
  return out
}

/** Vanilla defaults (ticks) until the server sends set_title_time. */
const DEFAULT_TIMES = { fadeIn: 10, stay: 70, fadeOut: 20 }

/**
 * @param {object} bot Mineflayer bot
 * @param {(ev:{slot:string, text?:string, subtitle?:string, times?:object}) => void} emit
 */
function attachHud (bot, emit) {
  let times = { ...DEFAULT_TIMES }
  let subtitle = ''
  const c = bot._client
  c.on('set_title_time', (p) => { times = { fadeIn: p.fadeIn, stay: p.stay, fadeOut: p.fadeOut } })
  c.on('set_title_subtitle', (p) => { subtitle = componentText(p.text) }) // shown with the next title
  c.on('set_title_text', (p) => {
    emit({ slot: 'title', text: componentText(p.text), subtitle, times })
    subtitle = ''
  })
  c.on('clear_titles', (p) => {
    subtitle = ''
    if (p.reset) times = { ...DEFAULT_TIMES }
    emit({ slot: 'clear' })
  })
  c.on('action_bar', (p) => emit({ slot: 'actionbar', text: componentText(p.text) }))
  c.on('system_chat', (p) => { if (p.isActionBar) emit({ slot: 'actionbar', text: componentText(p.content) }) })
}

module.exports = { attachHud, componentText, DEFAULT_TIMES }
