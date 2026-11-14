'use strict'
// A play test in a building the scenario builder made: its world (from MCSinarioBuilder's hand
// test) on a real Paper 1.21.4 server, the relay as the game table drives it.
//   - a character walks from outside the entrance to every room, by doors and stairs, and back
//     (a room behind a secret door after the GM opens it)
//   - every clue of the clues file placed in the world; the ones to carry given and on the hotbar
//   - the map the game table gets, floor by floor, drawn to pictures with the clues and stairs on it
// Runs only when BWB_LIVE_JAR (a server jar) and BWB_PLAY_DIR (world/, clues.json, playtest.json) are set.
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
const { Picture } = require('./png')

const JAR = process.env.BWB_LIVE_JAR
const PLAY = process.env.BWB_PLAY_DIR
const MC_PORT = 25621
const RCON_PORT = 25622
const RCON_PASS = 'play-test-rcon-pass'
const OUT = process.env.BWB_PLAY_OUT || path.join(os.tmpdir(), 'bwb-play-out')
const SCALE = 8

function client (port, token) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`)
  const msgs = []
  let nextId = 1
  const waiters = []
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString())
    if (m.type !== 'chunk' && m.type !== 'col3d') msgs.push(m)
    if (msgs.length > 5000) msgs.splice(0, 2000)
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

function copyDir (from, to) {
  fs.mkdirSync(to, { recursive: true })
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const a = path.join(from, e.name); const b = path.join(to, e.name)
    if (e.isDirectory()) copyDir(a, b); else fs.copyFileSync(a, b)
  }
}

function startServer (dir) {
  fs.mkdirSync(dir, { recursive: true })
  copyDir(path.join(PLAY, 'world'), path.join(dir, 'world'))
  fs.writeFileSync(path.join(dir, 'eula.txt'), 'eula=true\n')
  fs.writeFileSync(path.join(dir, 'server.properties'), [
    `server-port=${MC_PORT}`, 'online-mode=false', 'level-name=world', 'spawn-protection=0', 'enable-rcon=true',
    `rcon.port=${RCON_PORT}`, `rcon.password=${RCON_PASS}`, 'spawn-monsters=false', 'view-distance=6', 'simulation-distance=6',
    'gamemode=survival', 'difficulty=peaceful'
  ].join('\n') + '\n')
  const proc = spawn('java', ['-Xmx2G', '-jar', JAR, '--nogui'], { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] })
  let log = ''
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not start:\n' + log.slice(-3000))), 300000)
    proc.stdout.on('data', (d) => {
      log += d.toString()
      if (/Done \(/.test(log)) { clearTimeout(timer); resolve() }
    })
    proc.stderr.on('data', (d) => { log += d.toString() })
    proc.on('exit', (c) => reject(new Error(`server exited ${c}:\n` + log.slice(-3000))))
  })
  return { proc, ready, log: () => log }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

test('play test in a building the scenario builder made', { skip: !(JAR && PLAY), timeout: 1800000 }, async (t) => {
  fs.mkdirSync(OUT, { recursive: true })
  const report = []
  const note = (s) => { report.push(s); console.log(s) }
  const problems = []
  const problem = (s) => { problems.push(s); note(`PROBLEM: ${s}`) }
  const play = JSON.parse(fs.readFileSync(path.join(PLAY, 'playtest.json'), 'utf8'))
  const file = JSON.parse(fs.readFileSync(path.join(PLAY, 'clues.json'), 'utf8'))
  const server = startServer(path.join(os.tmpdir(), `bwb-play-${process.pid}`))
  t.after(() => {
    fs.writeFileSync(path.join(OUT, 'report.txt'), report.join('\n') + '\n')
    fs.writeFileSync(path.join(OUT, 'server.log'), server.log().slice(-80000))
    try { server.proc.stdin.write('stop\n') } catch { /* gone */ }
    setTimeout(() => { try { server.proc.kill('SIGKILL') } catch { /* gone */ } process.exit(0) }, 8000).unref()
  })
  await server.ready
  note(`server up; scenario "${file.scenario}", ${file.clues.length} clues, ${(file.stairs ?? []).length} flights of stairs, ${play.rooms.length} rooms`)

  const cfg = deepMerge(defaults, {
    listen: { host: '127.0.0.1', port: 0 },
    token: 'play-token-0123456789abcdef',
    minecraft: { host: '127.0.0.1', port: MC_PORT, version: '1.21.4', auth: 'offline' },
    rcon: { enabled: true, host: '127.0.0.1', port: RCON_PORT, password: RCON_PASS },
    viewer: { enabled: false }
  })
  const relay = await startRelay(cfg, { log () {}, warn (s) { note(`relay warn: ${s}`) } })
  t.after(() => relay.close())
  const c = client(relay.port, cfg.token)
  t.after(() => fs.writeFileSync(path.join(OUT, 'messages.txt'), c.msgs.filter((m) => m.type !== 'state' && m.type !== 'disp').map((m) => JSON.stringify(m).slice(0, 400)).join('\n')))
  await c.open()
  await c.wait((m) => m.type === 'welcome')
  const rcon = (cmd) => relay.bots.rcon.send(cmd)
  assert.ok((await c.call('spawnBot', { key: 'u1', username: 'Play_Jo' })).ok)
  await c.wait((m) => m.type === 'bots' && m.bots.some((b) => b.key === 'u1' && b.online), 120000)
  const bot = relay.bots.entries.get('u1').bot
  for (const cmd of ['time set noon', 'gamerule doDaylightCycle false', 'gamerule doMobSpawning false', 'difficulty peaceful', 'gamemode survival Play_Jo']) await rcon(cmd)
  const [ex, ey, ez] = play.entrance
  await c.call('gm', { action: 'tp', args: { target: 'Play_Jo', x: ex, y: ey, z: ez, center: true } })
  await sleep(4000) // the building's chunks come in
  note(`at the entrance ${bot.entity.position}`)

  // ---------------------------------------------------------------- walking
  let weakest = bot.health
  const watch = setInterval(() => { weakest = Math.min(weakest, bot.health) }, 100)
  const walks = []
  const go = async (label, [x, y, z], ms = 90000) => {
    const t0 = Date.now()
    const h0 = bot.health
    await c.call('moveTo', { key: 'u1', x: x + 0.5, z: z + 0.5, y })
    let stillSince = Date.now(); let last = bot.entity.position.clone()
    while (Date.now() - t0 < ms) {
      await sleep(150)
      const p = bot.entity.position
      if (Math.hypot(p.x - x - 0.5, p.z - z - 0.5) < 0.8 && Math.abs(p.y - y) < 0.8) {
        const s = (Date.now() - t0) / 1000
        walks.push({ label, ok: true, seconds: s, hurt: h0 - Math.min(h0, weakest) })
        note(`walk ${label}: there in ${s.toFixed(1)} s`)
        return true
      }
      if (p.distanceTo(last) > 0.05) { last = p.clone(); stillSince = Date.now() }
      if (Date.now() - stillSince > 12000) break // stopped for good
    }
    const p = bot.entity.position
    walks.push({ label, ok: false, at: [p.x, p.y, p.z].map((v) => +v.toFixed(2)) })
    note(`walk ${label}: NOT there (stopped at ${p.x.toFixed(2)}, ${p.y.toFixed(2)}, ${p.z.toFixed(2)})`)
    return false
  }
  let secretsOpen = false
  const openSecrets = async () => {
    for (const [x, y, z] of play.secretDoors ?? []) {
      const r = await c.call('secret', { x, y: y + 1, z, open: true })
      note(`GM opens the secret door at ${x}, ${y}, ${z}: ${JSON.stringify(r).slice(0, 200)}`)
    }
    secretsOpen = true
  }
  const rooms = play.rooms.filter((r) => !r.id.startsWith('_') && r.stand)
  for (const r of rooms) {
    let ok = await go(r.id, r.stand)
    if (!ok && !secretsOpen && (play.secretDoors ?? []).length) {
      await openSecrets()
      ok = await go(`${r.id} (after the secret door opened)`, r.stand)
    }
    if (!ok) problem(`could not walk to ${r.id}`)
  }
  if (!(await go('back out of the entrance', play.entrance))) problem('could not walk back out')
  clearInterval(watch)
  note(`lowest health on the walk: ${weakest} of 20`)
  if (weakest < 20) problem(`hurt on the way (lowest health ${weakest})`)

  // ---------------------------------------------------------------- clues
  const near = rooms.find((r) => r.level === 0) ?? rooms[0]
  await c.call('gm', { action: 'tp', args: { target: 'Play_Jo', x: near.stand[0], y: near.stand[1], z: near.stand[2], center: true } })
  await sleep(2000)
  for (const cl of file.clues) {
    const r = await c.call('cluePlace', { clue: cl.id, x: cl.x, y: cl.y, z: cl.z, item: cl.item || 'paper' })
    const n = String(await rcon(`execute if entity @e[tag=bwb_c_${cl.id}]`))
    const at = String(await rcon(`execute if block ${cl.x} ${cl.y} ${cl.z} #minecraft:air`))
    note(`clue ${cl.id} (${cl.kind}) at ${cl.x},${cl.y},${cl.z}: ${r.ok ? 'placed' : 'NOT placed ' + r.error}; ${n.trim()}; in air: ${/passed/.test(at)}`)
    if (!r.ok || !/count: 2/.test(n)) problem(`clue ${cl.id} not placed in the world`)
  }
  const carried = file.clues.filter((cl) => cl.kind === 'item')
  for (const cl of carried) {
    const r = await c.call('clueGive', { key: 'u1', clue: cl.id, title: cl.name, text: cl.text, item: cl.item })
    if (!r.ok) problem(`clue ${cl.id} not given: ${r.error}`)
  }
  if (carried.length) {
    try {
      const st = await c.wait((m) => m.type === 'state' && carried.every((cl) => (m.bots.find((b) => b.key === 'u1')?.hotbar ?? []).some((it) => it && it.t === cl.name)), 20000)
      note(`hotbar: ${JSON.stringify(st.bots.find((b) => b.key === 'u1').hotbar.filter(Boolean))}`)
    } catch {
      problem(`the carried clues are not all on the hotbar by name: ${carried.map((cl) => cl.name).join(', ')}`)
    }
  }

  // ---------------------------------------------------------------- the map, floor by floor
  const [x1, z1, x2, z2] = play.bounds
  const M = 6
  const floors = [...new Map(play.rooms.map((r) => [r.level, r])).values()].sort((a, b) => a.level - b.level)
  const draw = async (name, level, floorY, standAt) => {
    await c.call('gm', { action: 'tp', args: { target: 'Play_Jo', x: standAt[0], y: standAt[1], z: standAt[2], center: true } })
    await sleep(1500)
    await sleep(2500)
    const W = (x2 - x1 + 1 + 2 * M); const H = (z2 - z1 + 1 + 2 * M)
    const pic = new Picture(W * SCALE, H * SCALE)
    let filled = 0
    for (let z = z1 - M; z <= z2 + M; z++) {
      for (let x = x1 - M; x <= x2 + M; x++) {
        const e = relay.scanner.chunks.get(`overworld:${Math.floor(x / 16)}:${Math.floor(z / 16)}`) ??
          relay.scanner.chunks.get(`minecraft:overworld:${Math.floor(x / 16)}:${Math.floor(z / 16)}`)
        if (!e) continue
        const i = (((z % 16) + 16) % 16) * 16 + (((x % 16) + 16) % 16)
        pic.rect((x - x1 + M) * SCALE, (z - z1 + M) * SCALE, SCALE, SCALE, [e.rgb[i * 3], e.rgb[i * 3 + 1], e.rgb[i * 3 + 2]])
        filled++
      }
    }
    const px = (x, z) => [(x - x1 + M) * SCALE, (z - z1 + M) * SCALE]
    if (level !== null) {
      for (const s of file.stairs ?? []) {
        if (s.from === level) {
          for (const [sx, , sz] of s.steps) { const [a, b] = px(sx, sz); pic.rect(a, b, SCALE, SCALE, [63, 167, 255], 0.45) }
          const [a, b] = px(s.bottom[0], s.bottom[2]); pic.frame(a, b, SCALE, SCALE, [63, 167, 255], 2)
        }
        if (s.to === level) {
          for (const [sx, , sz] of s.steps.slice(1)) { const [a, b] = px(sx, sz); pic.rect(a, b, SCALE, SCALE, [255, 177, 63], 0.35) }
          const [a, b] = px(s.top[0], s.top[2]); pic.frame(a, b, SCALE, SCALE, [255, 177, 63], 2)
        }
      }
      for (const cl of file.clues) {
        if (cl.y < floorY || cl.y >= floorY + 4) continue
        const [a, b] = px(cl.x, cl.z)
        pic.frame(a - 1, b - 1, SCALE + 2, SCALE + 2, cl.kind === 'hidden' ? [255, 90, 90] : [255, 230, 40], 2)
      }
    }
    const p = bot.entity.position
    const [a, b] = px(Math.floor(p.x), Math.floor(p.z))
    pic.rect(a + 2, b + 2, SCALE - 4, SCALE - 4, [230, 40, 40])
    fs.writeFileSync(path.join(OUT, `${name}.png`), pic.png())
    note(`map ${name}: ${filled} of ${W * H} blocks drawn`)
    if (filled < W * H * 0.8) problem(`map ${name}: only ${filled} of ${W * H} blocks came in`)
  }
  for (const f of floors) {
    const r = rooms.find((rr) => rr.level === f.level) ?? play.rooms.find((rr) => rr.level === f.level && rr.stand)
    if (!r?.stand) continue
    await c.call('mapView', { mode: 'fixed', y: f.floorY })
    await draw(`map_floor_${f.level < 0 ? 'b' + -f.level : f.level + 1}`, f.level, f.floorY, r.stand)
  }
  // As players see it: cut around a character indoors (auto), and from above (off).
  await c.call('mapView', { mode: 'auto' })
  const upstairs = rooms.find((r) => r.level > 0) ?? rooms[0]
  await draw('map_auto_upstairs', upstairs.level, upstairs.floorY, upstairs.stand)
  await c.call('mapView', { mode: 'off' })
  await draw('map_from_above', null, 0, play.entrance)

  fs.writeFileSync(path.join(OUT, 'walks.json'), JSON.stringify(walks, null, 2))
  c.close()
  note(problems.length ? `${problems.length} PROBLEM(S)` : 'ALL OK')
  assert.deepStrictEqual(problems, [])
})
