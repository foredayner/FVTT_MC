'use strict'
// End-to-end: flying-squid dev server <-> relay <-> a fake "Foundry" WebSocket client.
// Run with: node --test test/integration.test.js   (takes ~30-60 s, opens local ports)
const test = require('node:test')
const assert = require('node:assert')
const WebSocket = require('ws')
const { startDevServer } = require('./dev-server')
const { startRelay } = require('../src/relay')
const { deepMerge } = require('../src/config')
const defaults = require('../config.example.json')

const MC_PORT = 25599
const quietLog = { log () {}, warn () {} }

function client (port, token) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`)
  const msgs = []
  const waiters = []
  let nextId = 1
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString())
    msgs.push(m)
    for (const w of [...waiters]) if (w.pred(m)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(m) }
  })
  const api = {
    ws,
    msgs,
    open: () => new Promise((r) => ws.once('open', () => { ws.send(JSON.stringify({ type: 'hello', token })); r() })),
    wait (pred, ms = 20000) {
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
      const ack = await api.wait((m) => m.type === 'ack' && m.id === id, 30000)
      return ack
    }
  }
  return api
}

test('relay end-to-end against a local server', { timeout: 180000 }, async (t) => {
  const serv = await startDevServer({ port: MC_PORT, quiet: true })
  const cfg = deepMerge(defaults, {
    listen: { host: '127.0.0.1', port: 0 },
    token: 'test-token-0123456789',
    minecraft: { host: '127.0.0.1', port: MC_PORT, version: '1.21.4', auth: 'offline' },
    viewer: { enabled: true, radius: 1 }
  })
  const relay = await startRelay(cfg, quietLog)
  t.after(async () => { await relay.close(); serv.quit?.(); setTimeout(() => process.exit(0), 500).unref() })

  // wrong token is rejected
  const bad = new WebSocket(`ws://127.0.0.1:${relay.port}`)
  await new Promise((r) => bad.once('open', r))
  bad.send(JSON.stringify({ type: 'hello', token: 'nope' }))
  const code = await new Promise((r) => bad.once('close', (c) => r(c)))
  assert.strictEqual(code, 4003)

  const c = client(relay.port, cfg.token)
  await c.open()
  const welcome = await c.wait((m) => m.type === 'welcome')
  assert.strictEqual(welcome.protocol, 1)

  // invalid username is refused
  assert.strictEqual((await c.call('spawnBot', { key: 'u1', username: 'bad name!' })).ok, false)

  assert.ok((await c.call('spawnBot', { key: 'u1', username: 'Jo_bot' })).ok)
  await c.wait((m) => m.type === 'bots' && m.bots.some((b) => b.key === 'u1' && b.online), 60000)
  const st = await c.wait((m) => m.type === 'state' && m.bots.some((b) => b.key === 'u1'), 30000)
  const start = st.bots.find((b) => b.key === 'u1')
  assert.ok(Number.isFinite(start.x) && Number.isFinite(start.y))

  const chunk = await c.wait((m) => m.type === 'chunk', 30000)
  assert.strictEqual(Buffer.from(chunk.rgb, 'base64').length, 768)

  // 3D: columns around the bot arrive as gzip'd chunk JSON; assets are served for upload
  assert.strictEqual(welcome.viewer.version, '1.21.4')
  await c.wait((m) => m.type === 'col3d', 20000)
  await new Promise((r) => setTimeout(r, 1500))
  const cols = c.msgs.filter((m) => m.type === 'col3d')
  assert.strictEqual(cols.length, 9, 'radius 1 = 3x3 columns')
  const json = JSON.parse(require('zlib').gunzipSync(Buffer.from(cols[0].data, 'base64')).toString())
  assert.strictEqual(json.minY, -64)
  assert.strictEqual(cols[0].minY, -64)
  const atlas = await c.call('asset3d', { name: 'atlas' })
  assert.ok(atlas.ok && Buffer.from(atlas.result.data, 'base64').subarray(1, 4).toString() === 'PNG')
  assert.strictEqual((await c.call('asset3d', { name: '../../package.json' })).ok, false)

  // manual control from the "3D window"
  assert.ok((await c.call('look', { key: 'u1', yaw: 1.2, pitch: 0 })).ok)
  assert.ok((await c.call('control', { key: 'u1', control: 'forward', state: true })).ok)
  await new Promise((r) => setTimeout(r, 1500))
  assert.ok((await c.call('control', { key: 'u1', control: 'forward', state: false })).ok)
  assert.strictEqual((await c.call('control', { key: 'u1', control: 'fly', state: true })).ok, false)

  // click-to-move on the map: walks in a straight line (no zig-zag)
  // Pin the character to a block first: after the manual walk the dev server may still move it
  // back to where it thinks it is, which would look like a detour.
  const latest = () => c.msgs.filter((m) => m.type === 'state').at(-1).bots.find((b) => b.key === 'u1')
  const pinName = c.msgs.filter((m) => m.type === 'bots').at(-1).bots.find((b) => b.key === 'u1').username
  await new Promise((r) => setTimeout(r, 800))
  const pin = latest()
  assert.ok((await c.call('gm', { action: 'tp', args: { target: pinName, x: Math.floor(pin.x), y: Math.floor(pin.y), z: Math.floor(pin.z) } })).ok)
  let here = null
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 400))
    const now = latest()
    if (here && Math.hypot(now.x - here.x, now.z - here.z) < 0.01 && Math.abs(now.x - Math.floor(pin.x)) < 1.01) break
    here = now
  }
  const target = { x: here.x + 5, z: here.z + 5 }
  const mark = c.msgs.length
  assert.ok((await c.call('moveTo', { key: 'u1', x: target.x, z: target.z })).ok)
  await new Promise((r) => setTimeout(r, 4000))
  const track = c.msgs.slice(mark).filter((m) => m.type === 'state').map((m) => m.bots.find((b) => b.key === 'u1')).filter(Boolean)
  const after = track.at(-1)
  const moved = Math.hypot(after.x - here.x, after.z - here.z)
  assert.ok(moved > 1, `bot should have moved (moved ${moved.toFixed(2)})`)
  // perpendicular distance of every sampled point from the start->target line
  const lx = target.x - here.x; const lz = target.z - here.z; const len = Math.hypot(lx, lz)
  const maxOff = Math.max(...track.map((p) => Math.abs((p.x - here.x) * lz - (p.z - here.z) * lx) / len))
  assert.ok(maxOff < 0.8, `path should be straight (max sideways ${maxOff.toFixed(2)} blocks)`)

  // click-to-move around a wall: the path finder goes round it (a straight walk would stick)
  {
    await new Promise((r) => setTimeout(r, 500))
    const { Vec3 } = require('vec3')
    const stone = require('minecraft-data')('1.21.4').blocksByName.stone.defaultState
    const from = c.msgs.filter((m) => m.type === 'state').at(-1).bots.find((b) => b.key === 'u1')
    const fx = Math.floor(from.x); const fz = Math.floor(from.z); const fy = Math.floor(from.y)
    for (let dz = -4; dz <= 4; dz++) for (let dy = 0; dy < 3; dy++) await serv.setBlock(serv.overworld, new Vec3(fx + 3, fy + dy, fz + dz), stone)
    await new Promise((r) => setTimeout(r, 500))
    const goal = { x: fx + 6.5, z: fz + 0.5 }
    assert.ok((await c.call('moveTo', { key: 'u1', x: goal.x, z: goal.z })).ok)
    let end
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 500))
      end = c.msgs.filter((m) => m.type === 'state').at(-1).bots.find((b) => b.key === 'u1')
      if (Math.hypot(end.x - goal.x, end.z - goal.z) < 1) break
    }
    assert.ok(Math.hypot(end.x - goal.x, end.z - goal.z) < 1.2, `went round the wall (ended ${end.x.toFixed(1)},${end.z.toFixed(1)}, goal ${goal.x},${goal.z})`)
  }

  // turning round to walk back is gradual, not a snap
  {
    const start = c.msgs.filter((m) => m.type === 'state').at(-1).bots.find((b) => b.key === 'u1')
    const mark2 = c.msgs.length
    // the spot 4 blocks behind it (yaw 0 faces -Z, so behind is +sin, +cos)
    assert.ok((await c.call('moveTo', { key: 'u1', x: start.x + 4 * Math.sin(start.yaw), z: start.z + 4 * Math.cos(start.yaw) })).ok)
    await new Promise((r) => setTimeout(r, 1500))
    const yaws = c.msgs.slice(mark2).filter((m) => m.type === 'state').map((m) => m.bots.find((b) => b.key === 'u1').yaw)
    const steps = yaws.slice(1).map((y, i) => { let d = Math.abs(y - yaws[i]) % (2 * Math.PI); return d > Math.PI ? 2 * Math.PI - d : d })
    assert.ok(Math.max(...steps) < 1.0, `turns gradually (largest step ${Math.max(...steps).toFixed(2)} rad per state)`)
    assert.ok(steps.filter((d) => d > 0.05).length >= 2, `the turn is spread over several updates (${yaws.map((y) => y.toFixed(2)).join(' ')})`)
  }

  // chat and GM commands
  assert.ok((await c.call('chat', { key: 'u1', text: 'hello from foundry' })).ok)
  assert.strictEqual((await c.call('chat', { key: 'u1', text: '/op me' })).ok, false)
  assert.ok((await c.call('gm', { action: 'time', args: { value: 'night' } })).ok)
  assert.strictEqual((await c.call('gm', { action: 'raw', args: { cmd: 'stop' } })).ok, false)

  // GM teleport: the character jumps to the typed block and the map state follows
  {
    const from = c.msgs.filter((m) => m.type === 'state').at(-1).bots.find((b) => b.key === 'u1')
    const dest = { x: Math.floor(from.x) + 20, y: Math.floor(from.y), z: Math.floor(from.z) - 12 }
    const username = c.msgs.filter((m) => m.type === 'bots').at(-1).bots.find((b) => b.key === 'u1').username
    assert.ok((await c.call('gm', { action: 'tp', args: { target: username, ...dest } })).ok)
    const landed = await c.wait((m) => m.type === 'state' && m.bots.some((b) => b.key === 'u1' &&
      Math.abs(b.x - (dest.x + 0.5)) < 1 && Math.abs(b.z - (dest.z + 0.5)) < 1), 10000)
    assert.ok(landed)
    assert.strictEqual((await c.call('gm', { action: 'spawnpoint', args: { target: username, x: 0, y: 400, z: 0 } })).ok, false)
    // walk back near the room-building spot used below
    assert.ok((await c.call('gm', { action: 'tp', args: { target: username, x: Math.floor(from.x), y: dest.y, z: Math.floor(from.z) } })).ok)
    await c.wait((m) => m.type === 'state' && m.bots.some((b) => b.key === 'u1' && Math.abs(b.x - (Math.floor(from.x) + 0.5)) < 1 && Math.abs(b.z - (Math.floor(from.z) + 0.5)) < 1), 10000)
  }

  // Block display entities (objects made of small blocks) reach Foundry as parts with a world box
  {
    const registry = require('minecraft-data')('1.21.4')
    const me = c.msgs.filter((m) => m.type === 'state').at(-1).bots.find((b) => b.key === 'u1')
    const client = serv.players[0]._client
    const at = { x: Math.floor(me.x) + 3.5, y: Math.floor(me.y), z: Math.floor(me.z) + 0.5 }
    client.write('spawn_entity', {
      entityId: 777001, objectUUID: '00000000-0000-4000-8000-000000777001', type: registry.entitiesByName.block_display.id,
      ...at, pitch: 0, yaw: 0, headPitch: 0, objectData: 0, velocity: { x: 0, y: 0, z: 0 }
    })
    client.write('entity_metadata', {
      entityId: 777001,
      metadata: [
        { key: 11, type: 'vector3', value: { x: -0.25, y: 0, z: -0.25 } },
        { key: 12, type: 'vector3', value: { x: 0.5, y: 0.25, z: 0.5 } },
        { key: 23, type: 'block_state', value: registry.blocksByName.orange_concrete.defaultState }
      ]
    })
    const msg = await c.wait((m) => m.type === 'disp' && m.add.some((p) => p.id === '777001'), 5000)
    const part = msg.add.find((p) => p.id === '777001')
    assert.strictEqual(part.name, 'orange_concrete')
    const want = [at.x - 0.25, at.y, at.z - 0.25, at.x + 0.25, at.y + 0.25, at.z + 0.25]
    assert.ok(part.box.every((v, i) => Math.abs(v - want[i]) < 1e-3), `box ${part.box} vs ${want}`)
    client.write('entity_destroy', { entityIds: [777001] })
    await c.wait((m) => m.type === 'disp' && m.del.includes('777001'), 5000)
  }

  // Titles and the action bar reach Foundry as 'hud' events for that character
  {
    const nbt = require('prismarine-nbt')
    const client = serv.players[0]._client
    client.write('set_title_time', { fadeIn: 5, stay: 40, fadeOut: 10 })
    client.write('set_title_subtitle', { text: nbt.comp({ text: nbt.string('부제목'), color: nbt.string('gray') }) })
    client.write('set_title_text', { text: nbt.comp({ text: nbt.string('어둠이 '), extra: nbt.list(nbt.comp([{ text: nbt.string('내려온다') }])) }) })
    client.write('action_bar', { text: nbt.string('발소리가 들린다') })
    const title = await c.wait((m) => m.type === 'event' && m.kind === 'hud' && m.slot === 'title', 5000)
    assert.deepStrictEqual([title.key, title.text, title.subtitle, title.times], ['u1', '어둠이 내려온다', '부제목', { fadeIn: 5, stay: 40, fadeOut: 10 }])
    const bar = await c.wait((m) => m.type === 'event' && m.kind === 'hud' && m.slot === 'actionbar', 5000)
    assert.strictEqual(bar.text, '발소리가 들린다')
  }

  // resync replays cached chunks
  const before = c.msgs.filter((m) => m.type === 'chunk').length
  assert.ok((await c.call('resync')).ok)
  await new Promise((r) => setTimeout(r, 300))
  assert.ok(c.msgs.filter((m) => m.type === 'chunk').length > before)

  // Floor plan: build a roofed 7x7 room around the character, then the map shows walls inside.
  const mcData = require('minecraft-data')('1.21.4')
  const { Vec3 } = require('vec3')
  const me = c.msgs.filter((m) => m.type === 'state').at(-1).bots.find((b) => b.key === 'u1')
  const bx = Math.floor(me.x); const bz = Math.floor(me.z); const fy = Math.floor(me.y)
  const set = (x, y, z, name) => serv.setBlock(serv.overworld, new Vec3(x, y, z), mcData.blocksByName[name].defaultState)
  for (let dx = -3; dx <= 3; dx++) {
    for (let dz = -3; dz <= 3; dz++) {
      set(bx + dx, fy + 3, bz + dz, 'oak_planks')
      if (Math.abs(dx) === 3 || Math.abs(dz) === 3) for (let y = fy; y <= fy + 2; y++) set(bx + dx, y, bz + dz, 'stone_bricks')
    }
  }
  const hasWall = (m) => m.type === 'chunk' && Buffer.from(m.kinds, 'base64').includes(2)
  const markFp = c.msgs.length
  assert.ok((await c.call('mapView', { mode: 'auto' })).ok)
  await c.wait((m) => c.msgs.indexOf(m) >= markFp && hasWall(m), 15000)
  const markOff = c.msgs.length
  assert.ok((await c.call('mapView', { mode: 'off' })).ok)
  await new Promise((r) => setTimeout(r, 500))
  const offChunks = c.msgs.slice(markOff).filter((m) => m.type === 'chunk')
  assert.ok(offChunks.length > 0 && !offChunks.some(hasWall), 'off: roofs again')
  assert.strictEqual((await c.call('mapView', { mode: 'fixed' })).ok, false, 'fixed needs y')
  assert.ok((await c.call('mapView', { mode: 'fixed', y: fy })).ok)

  assert.ok((await c.call('despawnBot', { key: 'u1' })).ok)
  await c.wait((m) => m.type === 'bots' && !m.bots.some((b) => b.key === 'u1'), 10000)
  c.ws.close()
})
