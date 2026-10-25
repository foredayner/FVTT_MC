'use strict'
// Block displays from a saved world, through the real pipeline without a Minecraft server:
// reads block_display entities from <worldDir>/entities, has the dev server send them to a bot as
// real packets, and checks that the relay outputs the same boxes as computed from the saved NBT.
//   node test/display-from-world.js <worldDir> [tag] [out.json]
// tag: only entities carrying this tag (e.g. one object of the AI build mod); out.json can be
// passed to tools/build3d/render-check.js --displays to see the parts in 3D.
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')
const REPO = path.resolve(__dirname, '..', '..')
const nbt = require(path.join(REPO, 'relay/node_modules/prismarine-nbt'))
const WebSocket = require(path.join(REPO, 'relay/node_modules/ws'))
const registry = require(path.join(REPO, 'relay/node_modules/minecraft-data'))('1.21.4')
const Block = require(path.join(REPO, 'relay/node_modules/prismarine-block'))(registry)
const { startDevServer } = require(path.join(REPO, 'relay/test/dev-server.js'))
const { startRelay } = require(path.join(REPO, 'relay/src/relay.js'))
const { deepMerge } = require(path.join(REPO, 'relay/src/config.js'))
const { displayMatrix, unitBox } = require(path.join(REPO, 'relay/src/displays.js'))

const [world, tag, outFile] = process.argv.slice(2)

function regionEntities (dir) {
  const out = []
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.mca'))) {
    const buf = fs.readFileSync(path.join(dir, f))
    if (buf.length < 8192) continue
    for (let i = 0; i < 1024; i++) {
      const off = buf.readUIntBE(i * 4, 3) * 4096
      if (!off) continue
      const len = buf.readUInt32BE(off)
      const raw = zlib.inflateSync(buf.subarray(off + 5, off + 4 + len))
      out.push(...(nbt.simplify(nbt.parseUncompressed(raw)).Entities ?? []))
    }
  }
  return out
}

const parts = regionEntities(path.join(world, 'entities')).filter((e) => e.id === 'minecraft:block_display' && (!tag || (e.Tags ?? []).includes(tag)))
console.log(`${parts.length} block display parts${tag ? ` with tag ${tag}` : ''}`)
if (!parts.length) process.exit(1)

function stateOf (bs) {
  const name = bs.Name.replace(/^minecraft:/, '')
  return Block.fromProperties(name, bs.Properties ?? {}, 0).stateId
}
const v3 = (a) => ({ x: a[0], y: a[1], z: a[2] })
const v4 = (a) => ({ x: a[0], y: a[1], z: a[2], w: a[3] })

;(async () => {
  const MC = 25641
  const serv = await startDevServer({ port: MC, quiet: true })
  const cfg = deepMerge(require(path.join(REPO, 'relay/config.example.json')), {
    listen: { host: '127.0.0.1', port: 0 }, token: 'duck-live-token-0123',
    minecraft: { host: '127.0.0.1', port: MC, version: '1.21.4', auth: 'offline' }, viewer: { enabled: false }
  })
  cfg.displays = { radius: 100000, maxParts: 100000 } // whole saved world, not just near the bot
  const relay = await startRelay(cfg, { log: (m) => /디스플레이/.test(m) && console.log('[relay]', m), warn: (m) => console.log('[relay warn]', m) })
  const ws = new WebSocket(`ws://127.0.0.1:${relay.port}`)
  const got = new Map()
  ws.on('message', (raw) => {
    const m = JSON.parse(raw)
    if (m.type !== 'disp') return
    if (m.reset) got.clear()
    for (const p of m.add) got.set(p.id, p)
    for (const id of m.del) got.delete(id)
  })
  await new Promise((r) => ws.once('open', r))
  ws.send(JSON.stringify({ type: 'hello', token: cfg.token }))
  ws.send(JSON.stringify({ type: 'spawnBot', id: 1, key: 'u1', username: 'DisplayCheck' }))
  while (!serv.players?.length) await new Promise((r) => setTimeout(r, 200))
  await new Promise((r) => setTimeout(r, 1500)) // let the bot finish spawning
  const client = serv.players[0]._client

  const expected = new Map()
  let eid = 900000
  for (const e of parts) {
    const id = eid++
    const t = e.transformation
    const st = stateOf(e.block_state)
    const [yaw, pitch] = e.Rotation ?? [0, 0]
    client.write('spawn_entity', {
      entityId: id, objectUUID: '00000000-0000-4000-8000-' + String(id).padStart(12, '0'), type: registry.entitiesByName.block_display.id,
      x: e.Pos[0], y: e.Pos[1], z: e.Pos[2], pitch: Math.round(pitch * 256 / 360), yaw: Math.round(yaw * 256 / 360), headPitch: 0, objectData: 0, velocity: { x: 0, y: 0, z: 0 }
    })
    client.write('entity_metadata', {
      entityId: id,
      metadata: [
        { key: 11, type: 'vector3', value: v3(t.translation) },
        { key: 12, type: 'vector3', value: v3(t.scale) },
        { key: 13, type: 'quaternion', value: v4(t.left_rotation) },
        { key: 14, type: 'quaternion', value: v4(t.right_rotation) },
        { key: 23, type: 'block_state', value: st }
      ]
    })
    const m = displayMatrix(v3(e.Pos), yaw, pitch, { translation: v3(t.translation), scale: v3(t.scale), left: v4(t.left_rotation), right: v4(t.right_rotation) })
    expected.set(String(id), { box: unitBox(m), name: e.block_state.Name.replace(/^minecraft:/, '') })
  }
  const t0 = Date.now()
  while (got.size < parts.length && Date.now() - t0 < 20000) await new Promise((r) => setTimeout(r, 200))
  let worst = 0; let nameMismatch = 0
  for (const [id, exp] of expected) {
    const p = got.get(id)
    if (!p) continue
    if (p.name !== exp.name) nameMismatch++
    for (let k = 0; k < 6; k++) worst = Math.max(worst, Math.abs(p.box[k] - exp.box[k]))
  }
  console.log(`relay sent ${got.size}/${parts.length} parts; block names mismatched: ${nameMismatch}; worst box error: ${worst.toFixed(4)} blocks`)
  // the packet angles are bytes (1.4°), so a rotated part may differ slightly; unrotated parts should be exact
  const all = [...got.values()]
  const bb = all.reduce((b, p) => [Math.min(b[0], p.box[0]), Math.min(b[1], p.box[1]), Math.min(b[2], p.box[2]), Math.max(b[3], p.box[3]), Math.max(b[4], p.box[4]), Math.max(b[5], p.box[5])], [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity])
  const ok = got.size === parts.length && nameMismatch === 0 && worst < 0.05
  console.log(ok ? 'OK' : 'MISMATCH')
  console.log('object bounds:', bb.map((v) => v.toFixed(2)).join(', '))
  const kinds = {}; for (const p of all) kinds[p.name] = (kinds[p.name] ?? 0) + 1
  console.log('blocks:', JSON.stringify(kinds))
  if (outFile) fs.writeFileSync(outFile, JSON.stringify(all))
  ws.close(); await relay.close(); serv.quit?.()
  setTimeout(() => process.exit(ok ? 0 : 1), 300)
})().catch((e) => { console.error(e); process.exit(1) })
