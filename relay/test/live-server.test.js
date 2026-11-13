'use strict'
// Against a REAL Minecraft server (Paper 1.21.4): what only the real game can tell us.
//   - a clue placed by the relay is really there (interaction + item_display with our tags)
//   - giving a clue item really works with the 1.21.4 item component syntax (a written book with
//     pages, a named key with lore), and the character's hotbar shows it by name
//   - picking a slot, throwing an item
// Runs only when BWB_LIVE_JAR points at a server jar (the "live-server" CI job downloads Paper).
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')
const WebSocket = require('ws')
const { startRelay } = require('../src/relay')
const { deepMerge } = require('../src/config')
const defaults = require('../config.example.json')

const JAR = process.env.BWB_LIVE_JAR
const MC_PORT = 25611
const RCON_PORT = 25612
const RCON_PASS = 'live-test-rcon-pass'
const OUT = process.env.BWB_LIVE_OUT || path.join(os.tmpdir(), 'bwb-live-out')

function client (port, token) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`)
  const msgs = []
  let nextId = 1
  const waiters = []
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString())
    msgs.push(m)
    for (const w of [...waiters]) if (w.pred(m)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(m) }
  })
  const api = {
    msgs,
    open: () => new Promise((r) => ws.once('open', () => { ws.send(JSON.stringify({ type: 'hello', token })); r() })),
    wait (pred, ms = 30000) {
      const hit = msgs.find(pred)
      if (hit) return Promise.resolve(hit)
      return new Promise((resolve, reject) => {
        const w = { pred, resolve }
        waiters.push(w)
        setTimeout(() => { const i = waiters.indexOf(w); if (i >= 0) { waiters.splice(i, 1); reject(new Error('timeout waiting')) } }, ms)
      })
    },
    async call (type, body = {}) {
      const id = nextId++
      ws.send(JSON.stringify({ type, id, ...body }))
      return api.wait((m) => m.type === 'ack' && m.id === id, 60000)
    },
    close: () => ws.close()
  }
  return api
}

function startServer (dir) {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'eula.txt'), 'eula=true\n')
  fs.writeFileSync(path.join(dir, 'server.properties'), [
    `server-port=${MC_PORT}`, 'online-mode=false', 'level-type=minecraft\\:flat', 'spawn-protection=0', 'enable-rcon=true',
    `rcon.port=${RCON_PORT}`, `rcon.password=${RCON_PASS}`, 'spawn-monsters=false', 'view-distance=4', 'simulation-distance=4',
    'gamemode=survival', 'difficulty=peaceful'
  ].join('\n') + '\n')
  const proc = spawn('java', ['-Xmx1500M', '-jar', JAR, '--nogui'], { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] })
  let log = ''
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not start:\n' + log.slice(-3000))), 240000)
    proc.stdout.on('data', (d) => {
      log += d.toString()
      if (/Done \(/.test(log)) { clearTimeout(timer); resolve() }
    })
    proc.stderr.on('data', (d) => { log += d.toString() })
    proc.on('exit', (c) => reject(new Error(`server exited ${c}:\n` + log.slice(-3000))))
  })
  return { proc, ready, log: () => log }
}

test('relay against a real Paper 1.21.4 server: clues and items', { skip: !JAR, timeout: 600000 }, async (t) => {
  fs.mkdirSync(OUT, { recursive: true })
  const report = []
  const note = (s) => { report.push(s); console.log(s) }
  const server = startServer(path.join(os.tmpdir(), `bwb-live-${process.pid}`))
  t.after(() => {
    fs.writeFileSync(path.join(OUT, 'report.txt'), report.join('\n') + '\n')
    fs.writeFileSync(path.join(OUT, 'server.log'), server.log().slice(-60000))
    try { server.proc.stdin.write('stop\n') } catch { /* gone */ }
    setTimeout(() => { try { server.proc.kill('SIGKILL') } catch { /* gone */ } process.exit(0) }, 8000).unref()
  })
  await server.ready
  note('server up')

  const cfg = deepMerge(defaults, {
    listen: { host: '127.0.0.1', port: 0 },
    token: 'live-token-0123456789abcdef',
    minecraft: { host: '127.0.0.1', port: MC_PORT, version: '1.21.4', auth: 'offline' },
    rcon: { enabled: true, host: '127.0.0.1', port: RCON_PORT, password: RCON_PASS },
    viewer: { enabled: false }
  })
  const relay = await startRelay(cfg, { log () {}, warn (s) { console.log('relay warn:', s) } })
  t.after(() => relay.close())
  const c = client(relay.port, cfg.token)
  t.after(() => {
    const quiet = new Set(['state', 'chunk', 'disp', 'col3d'])
    fs.writeFileSync(path.join(OUT, 'messages.txt'), c.msgs.filter((m) => !quiet.has(m.type)).map((m) => JSON.stringify(m).slice(0, 400)).join('\n'))
  })
  await c.open()
  await c.wait((m) => m.type === 'welcome')

  assert.ok((await c.call('spawnBot', { key: 'u1', username: 'Live_Jo' })).ok)
  await c.wait((m) => m.type === 'bots' && m.bots.some((b) => b.key === 'u1' && b.online), 90000)
  const st = await c.wait((m) => m.type === 'state' && m.bots.some((b) => b.key === 'u1' && b.hotbar), 30000)
  const me = st.bots.find((b) => b.key === 'u1')
  note(`character at ${me.x}, ${me.y}, ${me.z}; hotbar ${JSON.stringify(me.hotbar)}`)
  const bx = Math.floor(me.x) + 2; const by = Math.floor(me.y); const bz = Math.floor(me.z)

  // 1. A clue in the world: an interaction box and a floating paper, both tagged.
  note('placing a clue...')
  const placed = await c.call('cluePlace', { clue: 'live1', x: bx, y: by, z: bz, item: 'paper' })
  note(`cluePlace: ${JSON.stringify(placed)}`)
  assert.ok(placed.ok, placed.error)
  const count = await relay.bots.rcon.send('execute if entity @e[tag=bwb_c_live1]')
  note(`entities with the clue's tag: ${count}`)
  assert.match(String(count), /Test passed, count: 2/, 'an interaction and an item_display')
  const kinds = await relay.bots.rcon.send('execute if entity @e[type=minecraft:item_display,tag=bwb_c_live1]')
  assert.match(String(kinds), /count: 1/)

  // 2. Items given with 1.21.4 components: a written book, a named key.
  const book = await c.call('clueGive', { key: 'u1', clue: 'live1', title: '서진의 일기장', text: "10월 27일. 관리실에서 보일러실 열쇠를 빌렸다. '누가' 부른다.\n내일 다시 간다.", item: 'written_book' })
  note(`clueGive book: ${JSON.stringify(book)}`)
  assert.ok(book.ok, book.error)
  const key = await c.call('clueGive', { key: 'u1', clue: 'live2', title: '녹슨 열쇠', text: 'B1 이라고 적힌 꼬리표', item: 'tripwire_hook' })
  note(`clueGive key: ${JSON.stringify(key)}`)
  assert.ok(key.ok, key.error)
  const books = await relay.bots.rcon.send('clear Live_Jo minecraft:written_book 0')
  const keys = await relay.bots.rcon.send('clear Live_Jo minecraft:tripwire_hook 0')
  note(`in the inventory: ${books} | ${keys}`)
  assert.match(String(books), /Found 1|1 matching/i, 'the book is there')
  assert.match(String(keys), /Found 1|1 matching/i, 'the key is there')
  const data = await relay.bots.rcon.send('data get entity Live_Jo Inventory[{id:"minecraft:tripwire_hook"}].components')
  note(`the key's components: ${String(data).slice(0, 1500)}`)
  assert.ok(String(data).includes('bwb_clue'), 'the clue id rides along')
  assert.ok(String(data).includes('녹슨 열쇠'), 'the key has its name')
  const pages = await relay.bots.rcon.send('data get entity Live_Jo Inventory[{id:"minecraft:written_book"}].components."minecraft:written_book_content".title')
  note(`the book's title: ${pages}`)
  assert.ok(String(pages).includes('서진의 일기장'))

  await new Promise((r) => setTimeout(r, 1500))
  const inv = relay.bots.entries.get('u1').bot.inventory.slots.filter(Boolean).map((it) => ({ name: it.name, components: it.components }))
  fs.writeFileSync(path.join(OUT, 'mineflayer-items.json'), JSON.stringify(inv, null, 2))
  // 3. The hotbar as the relay reads it: the items by their names.
  const hb = await c.wait((m) => m.type === 'state' && (m.bots.find((b) => b.key === 'u1')?.hotbar ?? []).filter(Boolean).length >= 2, 20000)
  const bar = hb.bots.find((b) => b.key === 'u1')
  note(`hotbar now: ${JSON.stringify(bar.hotbar)} named ${JSON.stringify(bar.named)}`)
  assert.ok(bar.hotbar.some((it) => it && it.t === '서진의 일기장'), 'the book shows by its title')
  assert.ok(bar.hotbar.some((it) => it && it.t === '녹슨 열쇠'), 'the key shows by its name')
  assert.ok(bar.named.includes('녹슨 열쇠'))

  // 4. Picking a slot and throwing what is in hand.
  const slot = bar.hotbar.findIndex((it) => it && it.n === 'tripwire_hook')
  assert.ok((await c.call('hotbar', { key: 'u1', slot })).ok)
  await c.wait((m) => m.type === 'state' && m.bots.find((b) => b.key === 'u1')?.sel === slot, 10000)
  const dropped = await c.call('dropItem', { key: 'u1' })
  note(`dropItem: ${JSON.stringify(dropped)}`)
  assert.ok(dropped.ok, dropped.error)
  await c.wait((m) => m.type === 'state' && !(m.bots.find((b) => b.key === 'u1')?.hotbar ?? []).some((it) => it && it.n === 'tripwire_hook'), 10000)
  note('the key left the hotbar')

  // 5. Stairs: an open flight of five steps (no rail, the last set in the floor above) with the hole
  // over it, like the scenario builder makes. Walk up and down three times: never off the side,
  // never through the hole, no damage.
  await stairsTest(c, relay, note, bx + 4, by, bz)

  // 6. Removing the clue removes both entities.
  assert.ok((await c.call('clueRemove', { clue: 'live1' })).ok)
  const after = await relay.bots.rcon.send('execute if entity @e[tag=bwb_c_live1]')
  note(`after removing: ${after}`)
  assert.doesNotMatch(String(after), /Test passed/)
  c.close()
  note('ALL OK')
})

/** Build a flight of stairs east from (x0, G, z0) to a floor 5 above, then walk it up and down. */
async function stairsTest (c, relay, note, x0, G, z0) {
  const rcon = (cmd) => relay.bots.rcon.send(cmd)
  const top = G + 4 // the floor block above
  await rcon(`fill ${x0 - 4} ${G} ${z0 - 4} ${x0 + 9} ${G + 8} ${z0 + 4} air`)
  await rcon(`fill ${x0 - 2} ${top} ${z0 - 2} ${x0 + 8} ${top} ${z0 + 2} stone`)
  for (let i = 1; i <= 3; i++) await rcon(`setblock ${x0 + i} ${top} ${z0} air`)
  for (let i = 0; i <= 4; i++) {
    if (i >= 1 && i <= 3) await rcon(`fill ${x0 + i} ${G} ${z0} ${x0 + i} ${G + i - 1} ${z0} stone`)
    await rcon(`setblock ${x0 + i} ${G + i} ${z0} minecraft:oak_stairs[facing=east]`)
  }
  const bot = relay.bots.entries.get('u1').bot
  await rcon('gamemode survival Live_Jo')
  await rcon(`tp Live_Jo ${x0 - 2}.5 ${G} ${z0 + 2}.5`)
  await new Promise((r) => setTimeout(r, 1500))
  const health0 = bot.health
  let lowest = Infinity
  let sideways = 0
  let weakest = health0 // peaceful heals quickly: watch the lowest health, not the last
  const watch = setInterval(() => {
    const p = bot.entity?.position
    if (!p) return
    weakest = Math.min(weakest, bot.health)
    // Between the floors the only footing is the flight, one block wide: the body must stay over it.
    // (Off the first step's side is a step down, fine.)
    if (p.y > G + 1.6 && p.y < top + 0.6) sideways = Math.max(sideways, Math.abs(p.z - (z0 + 0.5)))
    // Under the upper floor and beside the flight: the ground; nothing lower is allowed.
    lowest = Math.min(lowest, p.y)
  }, 50)
  const arrive = async (x, y, z, label) => {
    const t0 = Date.now()
    await c.call('moveTo', { key: 'u1', x: x + 0.5, z: z + 0.5, y })
    while (Date.now() - t0 < 40000) {
      const p = bot.entity.position
      if (Math.hypot(p.x - x - 0.5, p.z - z - 0.5) < 0.7 && Math.abs(p.y - y) < 0.7) {
        note(`${label}: there in ${((Date.now() - t0) / 1000).toFixed(1)} s at ${p.x.toFixed(2)}, ${p.y.toFixed(2)}, ${p.z.toFixed(2)}`)
        return
      }
      await new Promise((r) => setTimeout(r, 100))
    }
    const p = bot.entity.position
    throw new Error(`${label}: not there after 40 s (at ${p.x.toFixed(2)}, ${p.y.toFixed(2)}, ${p.z.toFixed(2)})`)
  }
  try {
    for (let round = 1; round <= 3; round++) {
      // Up: to the last step, in the floor above.
      await arrive(x0 + 4, top + 1, z0, `round ${round} up`)
      // Along the upper floor, round the hole, to its far side.
      await arrive(x0 + 2, top + 1, z0 + 2, `round ${round} upstairs, beside the hole`)
      // Down: to the first step.
      await arrive(x0, G + 1, z0, `round ${round} down`)
      // Back out on the ground floor, under the upper floor.
      await arrive(x0 + 2, G, z0 - 1, `round ${round} under the floor`)
    }
  } finally {
    clearInterval(watch)
  }
  note(`stairs: lowest ${lowest.toFixed(2)} (ground ${G}), health ${health0}, lowest health ${weakest}`)
  note(`stairs: off the flight's middle by at most ${sideways.toFixed(2)} between the floors`)
  assert.ok(lowest > G - 0.1, 'never below the ground')
  assert.ok(sideways < 0.8, 'never over the side of the flight')
  assert.ok(weakest >= health0, 'no fall damage')
  await rcon('gamemode creative Live_Jo')
}
