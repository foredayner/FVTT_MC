'use strict'
const test = require('node:test')
const assert = require('node:assert')
const net = require('net')
const { buildGmCommand } = require('../src/gmCommands')
const { colorId, ID, rgb: shadeRgb, landShade, waterShade, SHADE, BASE } = require('../src/mapColors')
const { MapScanner } = require('../src/mapScanner')
const { Rcon } = require('../src/rcon')
const { deepMerge } = require('../src/config')

test('gm: time / weather whitelist', () => {
  assert.deepStrictEqual(buildGmCommand({ action: 'time', args: { value: 'night' } }), ['time set night'])
  assert.throws(() => buildGmCommand({ action: 'time', args: { value: '0; op me' } }))
  assert.throws(() => buildGmCommand({ action: 'weather', args: { value: 'snow' } }))
})

test('gm: title text is escaped JSON and cannot break out', () => {
  const cmds = buildGmCommand({ action: 'title', args: { text: 'He said "hi" \\ run op x', target: '@a' } })
  const last = cmds.at(-1)
  assert.match(last, /^title @a title \{"text":/)
  assert.deepStrictEqual(JSON.parse(last.slice('title @a title '.length)), { text: 'He said "hi" \\ run op x' })
})

test('gm: target names and numbers are validated', () => {
  assert.throws(() => buildGmCommand({ action: 'effect', args: { target: 'a b', effect: 'speed' } }))
  assert.throws(() => buildGmCommand({ action: 'effect', args: { target: 'Jo', effect: 'instant_damage' } }))
  assert.throws(() => buildGmCommand({ action: 'summon', args: { near: '@a', mob: 'zombie' } }))
  assert.throws(() => buildGmCommand({ action: 'tp', args: { target: 'Jo', x: 1.5, y: 70, z: 0 } }))
  assert.deepStrictEqual(
    buildGmCommand({ action: 'summon', args: { near: 'Jo_1', mob: 'zombie', dx: 4, dz: -2 } }),
    ['execute at Jo_1 run summon minecraft:zombie ~4 ~ ~-2'])
  assert.throws(() => buildGmCommand({ action: 'op', args: {} }))
})

test('gm: tp / spawnpoint / worldspawn take whole-block coordinates only', () => {
  assert.deepStrictEqual(buildGmCommand({ action: 'tp', args: { target: '@a', x: 10, y: 64, z: -20 } }), ['tp @a 10 64 -20'])
  assert.deepStrictEqual(buildGmCommand({ action: 'tp', args: { target: 'Jo_1', x: 10, y: 64, z: -20, center: true } }), ['tp Jo_1 10.5 64 -19.5'])
  assert.deepStrictEqual(buildGmCommand({ action: 'spawnpoint', args: { target: 'Jo_1', x: '5', y: '-60', z: '7' } }), ['spawnpoint Jo_1 5 -60 7'])
  assert.deepStrictEqual(buildGmCommand({ action: 'worldspawn', args: { x: 0, y: 70, z: 0 } }), ['setworldspawn 0 70 0', 'gamerule spawnRadius 0'])
  assert.throws(() => buildGmCommand({ action: 'spawnpoint', args: { target: 'Jo', x: 0, y: 320, z: 0 } }))
  assert.throws(() => buildGmCommand({ action: 'spawnpoint', args: { target: 'Jo;op', x: 0, y: 64, z: 0 } }))
  assert.throws(() => buildGmCommand({ action: 'worldspawn', args: { x: '0 ~', y: 64, z: 0 } }))
  assert.throws(() => buildGmCommand({ action: 'worldspawn', args: { x: 30000000, y: 64, z: 0 } }))
  assert.throws(() => buildGmCommand({ action: 'tp', args: { target: 'Jo', y: 64, z: 0 } }))
  assert.throws(() => buildGmCommand({ action: 'tp', args: { target: 'Jo', x: '', y: 64, z: 0 } }))
})

test('mapColors: palette and block assignments follow the map item', () => {
  assert.strictEqual(BASE.length, 62)
  assert.deepStrictEqual(BASE[ID.GRASS].slice(1), [127, 178, 56])
  assert.deepStrictEqual(BASE[ID.WATER].slice(1), [64, 64, 255])
  const expect = {
    air: 'NONE', glass: 'NONE', torch: 'NONE', oak_button: 'NONE', grass_block: 'GRASS', short_grass: 'PLANT',
    oak_leaves: 'PLANT', cherry_leaves: 'COLOR_PINK', water: 'WATER', kelp: 'WATER', sand: 'SAND',
    sandstone_stairs: 'SAND', red_sand: 'COLOR_ORANGE', dirt: 'DIRT', farmland: 'DIRT', stone: 'STONE',
    diamond_ore: 'STONE', deepslate_iron_ore: 'DEEPSLATE', oak_planks: 'WOOD', spruce_log: 'PODZOL',
    birch_planks: 'SAND', dark_oak_door: 'COLOR_BROWN', white_wool: 'SNOW', light_blue_concrete: 'COLOR_LIGHT_BLUE',
    red_terracotta: 'TERRACOTTA_RED', light_gray_terracotta: 'TERRACOTTA_LIGHT_GRAY', terracotta: 'COLOR_ORANGE',
    netherrack: 'NETHER', red_nether_bricks: 'NETHER', obsidian: 'COLOR_BLACK', bricks: 'COLOR_RED',
    snow: 'SNOW', ice: 'ICE', lava: 'FIRE', iron_block: 'METAL', gold_block: 'GOLD', clay: 'CLAY',
    warped_planks: 'WARPED_STEM', crimson_hyphae: 'CRIMSON_HYPHAE', oxidized_copper: 'WARPED_NYLIUM',
    bedrock: 'STONE', diorite: 'QUARTZ', granite: 'DIRT', tuff: 'TERRACOTTA_GRAY', mycelium: 'COLOR_PURPLE'
  }
  for (const [block, name] of Object.entries(expect)) assert.strictEqual(BASE[colorId(block)][0], name, block)
})

test('mapColors: shading like the map item', () => {
  assert.strictEqual(landShade(70, 69), SHADE.HIGH)
  assert.strictEqual(landShade(70, 70), SHADE.NORMAL)
  assert.strictEqual(landShade(70, 71), SHADE.LOW)
  assert.strictEqual(landShade(70, null), SHADE.NORMAL)
  assert.deepStrictEqual(shadeRgb(ID.GRASS, SHADE.NORMAL), [109, 153, 48]) // 127*220/255 etc., floored
  assert.strictEqual(waterShade(1, 0, 0), SHADE.HIGH)   // shallow
  assert.strictEqual(waterShade(6, 0, 0), SHADE.NORMAL) // medium
  assert.strictEqual(waterShade(10, 0, 0), SHADE.LOW)   // deep
  assert.notStrictEqual(waterShade(4, 0, 0), waterShade(4, 1, 0)) // checkerboard dither
})

test('mapScanner: scans surface from a fake bot, sends only on change', () => {
  const sent = []
  const s = new MapScanner({ scanAbove: 10, scanBelow: 10 }, (c) => sent.push(c))
  let waterAt3 = true
  const bot = {
    entity: { position: { x: 8, y: 64, z: 8 } },
    blockAt: (p) => ({ name: p.y > 62 ? 'air' : (waterAt3 && p.x === 3 && p.z === 0 ? 'water' : 'grass_block') })
  }
  assert.ok(s.scanChunk(bot, 'overworld', 0, 0))
  assert.strictEqual(s.surfaceY('overworld', 5, 5), 62)
  const c = sent[0]
  const rgb = Buffer.from(c.rgb, 'base64')
  const heights = new Int16Array(new Uint8Array(Buffer.from(c.heights, 'base64')).buffer)
  assert.strictEqual(rgb.length, 16 * 16 * 3)
  assert.strictEqual(heights[0], 62)
  assert.deepStrictEqual([...rgb.subarray(9, 12)], shadeRgb(ID.WATER, SHADE.LOW)) // x=3,z=0: deep water
  assert.deepStrictEqual([...rgb.subarray(0, 3)], shadeRgb(ID.GRASS, SHADE.NORMAL)) // flat grass

  assert.strictEqual(s.scanChunk(bot, 'overworld', 0, 0), false, 'unchanged chunk is not resent')
  waterAt3 = false
  assert.strictEqual(s.scanChunk(bot, 'overworld', 0, 0), true, 'changed chunk is resent')
  assert.strictEqual(sent.length, 2)
  assert.strictEqual(s.scanAround(bot, 24), 15, 'radius 24 around (8,8) spans chunks -1..2 (4x4), 15 of them new')
  assert.strictEqual([...s.all()].length, 16)
  assert.strictEqual(s.scanAround(bot, 24), 0, 'second pass with no changes sends nothing')
  s.close()
})

test('mapScanner: uses state ids + registry when the bot has them', () => {
  const s = new MapScanner({ scanAbove: 4, scanBelow: 4 }, () => {})
  const bot = {
    entity: { position: { x: 0, y: 64, z: 0 } },
    registry: { blocksByStateId: { 0: { name: 'air' }, 9: { name: 'sand' } } },
    world: { getColumn: (cx) => (cx === 0 ? {} : undefined), getBlockStateId: (p) => (p.y <= 61 ? 9 : 0) },
    blockAt: () => { throw new Error('should not be used') }
  }
  assert.ok(s.scanChunk(bot, 'overworld', 0, 0))
  assert.strictEqual(s.surfaceY('overworld', 1, 1), 61)
  assert.strictEqual(s.scanChunk(bot, 'overworld', 5, 0), false, 'unloaded column is skipped')
})

test('walker: a closed wooden door ahead is found (iron doors and open doors are not)', () => {
  const { doorAhead } = require('../src/walker')
  const { Vec3 } = require('vec3')
  const blocks = new Map([['1,0,0', { name: 'oak_door', open: false }], ['0,0,3', { name: 'iron_door', open: false }], ['3,0,0', { name: 'oak_door', open: true }]])
  const bot = (x, z) => ({
    entity: { position: new Vec3(x, 0, z) },
    blockAt: (p) => { const b = blocks.get(`${p.x},${p.y},${p.z}`); return b ? { name: b.name, getProperties: () => ({ open: b.open }) } : { name: 'air', getProperties: () => ({}) } }
  })
  assert.strictEqual(doorAhead(bot(0.5, 0.5), 1, 0)?.name, 'oak_door')
  assert.strictEqual(doorAhead(bot(0.5, 2.5), 0, 1), null, 'iron doors need redstone')
  assert.strictEqual(doorAhead(bot(2.5, 0.5), 1, 0), null, 'already open')
})

test('walker: turning is gradual and takes the short way round', () => {
  const { turnStep, angleTo } = require('../src/walker')
  assert.ok(Math.abs(turnStep(0, Math.PI) - 0.32) < 1e-9, 'one step toward a half turn')
  assert.strictEqual(turnStep(1, 1.1), 1.1, 'a small turn is done at once')
  assert.ok(turnStep(3.0, -3.0, 0.1) > 3.0, 'from just under +pi to just over -pi it goes through pi, not round the long way')
  assert.ok(Math.abs(angleTo(3.0, -3.0) - (2 * Math.PI - 6)) < 1e-9)
})

test('walker: town moves hop a fence and never clip a corner diagonally', () => {
  const { townMovements } = require('../src/walker')
  // A fake grid: blocks by "x,y,z" -> name; everything else is air on a floor at y -1.
  const grid = new Map([['1,0,0', 'oak_fence'], ['0,0,-1', 'stone'], ['0,1,-1', 'stone']])
  class Base {
    getBlock (node, dx, dy, dz) {
      const x = node.x + dx; const y = node.y + dy; const z = node.z + dz
      const name = grid.get(`${x},${y},${z}`) ?? (y < 0 ? 'stone' : 'air')
      const solid = name !== 'air'
      return { name, safe: !solid, physical: solid && !name.endsWith('_fence'), openable: false }
    }

    getNeighbors () { return [] }
    getMoveDiagonal (node, dir, neighbors) { neighbors.push({ diag: [dir.x, dir.z] }) }
  }
  const M = townMovements(Base)
  const m = new M()
  const hops = m.getNeighbors({ x: 0, y: 0, z: 0, remainingBlocks: 0 }).filter((n) => n.hop)
  assert.deepStrictEqual(hops.map((n) => [n.x, n.y, n.z]), [[2, 0, 0]], 'over the fence to the far side')
  const out = []
  m.getMoveDiagonal({ x: 0, y: 0, z: 0 }, { x: 1, z: -1 }, out)
  assert.strictEqual(out.length, 0, 'a stone beside the diagonal (and the fence) blocks it')
  m.getMoveDiagonal({ x: 0, y: 0, z: 0 }, { x: -1, z: 1 }, out)
  assert.strictEqual(out.length, 1, 'open on both sides: allowed')
})

test('walker: yawToward faces the target in mineflayer convention', () => {
  const { yawToward } = require('../src/walker')
  assert.ok(Math.abs(yawToward(0, -1)) < 1e-9)               // north
  assert.ok(Math.abs(yawToward(-1, 0) - Math.PI / 2) < 1e-9)  // west
  assert.ok(Math.abs(Math.abs(yawToward(0, 1)) - Math.PI) < 1e-9) // south
  assert.ok(Math.abs(yawToward(1, 0) + Math.PI / 2) < 1e-9)  // east
})

test('config: deepMerge keeps nested defaults', () => {
  const m = deepMerge({ a: { b: 1, c: 2 }, d: [1] }, { a: { c: 3 }, d: [9] })
  assert.deepStrictEqual(m, { a: { b: 1, c: 3 }, d: [9] })
})

test('rcon: auth + command round trip against a fake server', async () => {
  const server = net.createServer((sock) => {
    let buf = Buffer.alloc(0)
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d])
      while (buf.length >= 4 && buf.length >= 4 + buf.readInt32LE(0)) {
        const len = buf.readInt32LE(0); const id = buf.readInt32LE(4); const type = buf.readInt32LE(8)
        const body = buf.toString('utf8', 12, 4 + len - 2)
        buf = buf.subarray(4 + len)
        const out = type === 3 ? (body === 'pw' ? '' : null) : `ran:${body}`
        const rid = out === null ? -1 : id
        const pb = Buffer.from(out ?? '')
        const pkt = Buffer.alloc(14 + pb.length)
        pkt.writeInt32LE(10 + pb.length, 0); pkt.writeInt32LE(rid, 4); pkt.writeInt32LE(type === 3 ? 2 : 0, 8)
        pb.copy(pkt, 12)
        sock.write(pkt)
      }
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  const ok = new Rcon({ host: '127.0.0.1', port, password: 'pw' })
  await ok.connect()
  assert.strictEqual(await ok.send('time set day'), 'ran:time set day')
  ok.close()
  const bad = new Rcon({ host: '127.0.0.1', port, password: 'nope' })
  await assert.rejects(bad.connect(), /비밀번호/)
  bad.close()
  server.close()
})

// A little house on a classic flat world, in a fake bot backed by real 1.21.4 block states.
function houseBot () {
  const mcData = require('minecraft-data')('1.21.4')
  const { Vec3 } = require('vec3')
  const blocks = new Map()
  const put = (x, y, z, name, props) => blocks.set(`${x},${y},${z}`, { name, props })
  for (let x = -16; x < 32; x++) for (let z = -16; z < 32; z++) { put(x, -64, z, 'bedrock'); put(x, -63, z, 'dirt'); put(x, -62, z, 'dirt'); put(x, -61, z, 'grass_block') }
  // 7x7 house at x,z 0..6: plank floor, stone brick walls 3 high, plank roof.
  for (let x = 0; x <= 6; x++) {
    for (let z = 0; z <= 6; z++) {
      put(x, -61, z, 'oak_planks')
      put(x, -57, z, 'oak_planks')
      const edge = x === 0 || x === 6 || z === 0 || z === 6
      if (edge) for (let y = -60; y <= -58; y++) put(x, y, z, 'stone_bricks')
    }
  }
  put(3, -60, 0, 'oak_door', { open: false }); put(3, -59, 0, 'oak_door', { open: false })
  put(6, -60, 3, 'oak_door', { open: true }); put(6, -59, 3, 'oak_door', { open: true })
  put(0, -59, 3, 'glass')
  put(2, -60, 2, 'red_carpet')
  put(4, -60, 4, 'barrel') // furniture one block high: under the cut, the floor
  put(5, -60, 5, 'bookshelf'); put(5, -59, 5, 'bookshelf') // a tall bookcase reads as wall
  put(1, -59, 4, 'lantern') // a lantern at head height: furniture, not a wall
  put(4, -59, 1, 'oak_fence') // a fence post at head height: furniture
  put(2, -60, 5, 'spruce_door', { open: false }); put(2, -59, 5, 'spruce_door', { open: false }) // a door inside
  // A pavilion at x,z 20..24: four posts, a roof two blocks over the ground, open at the sides.
  for (let x = 20; x <= 24; x++) for (let z = 20; z <= 24; z++) put(x, -58, z, 'spruce_planks')
  for (const [x, z] of [[20, 20], [24, 20], [20, 24], [24, 24]]) { put(x, -60, z, 'oak_log'); put(x, -59, z, 'oak_log') }
  const state = (b) => (b ? mcData.blocksByName[b.name].defaultState : mcData.blocksByName.air.defaultState)
  const at = (p) => blocks.get(`${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`)
  return {
    entity: { position: new Vec3(3.5, -60, 3.5) },
    game: { dimension: 'overworld', minY: -64 },
    registry: mcData,
    world: {
      getColumn: (cx, cz) => cx >= -1 && cx <= 1 && cz >= -1 && cz <= 1,
      getBlockStateId: (p) => state(at(p))
    },
    blockAt: (p) => { const b = at(p); return { name: b?.name ?? 'air', getProperties: () => b?.props ?? {} } }
  }
}

test('mapScanner: floor plan under a roof (auto), normal ground outside, back to normal when they leave', () => {
  const { KIND } = require('../src/mapScanner')
  const sent = []
  const scanner = new MapScanner({ scanAbove: 24, scanBelow: 48, indoorRadius: 12 }, (c) => sent.push(c))
  const bot = houseBot()
  assert.deepStrictEqual(scanner.setCharacters([bot]), [])
  assert.strictEqual(scanner.cuts.length, 1, 'inside the house counts as indoors')
  scanner.scanChunk(bot, 'overworld', 0, 0)
  const kinds = Buffer.from(sent.at(-1).kinds, 'base64')
  const k = (x, z) => kinds[z * 16 + x]
  assert.strictEqual(k(0, 0), KIND.WALL)
  assert.strictEqual(k(3, 0), KIND.DOOR)
  assert.strictEqual(k(6, 3), KIND.DOOR_OPEN)
  assert.strictEqual(k(0, 3), KIND.WINDOW)
  assert.strictEqual(k(3, 3), KIND.FLOOR)
  assert.strictEqual(k(2, 2), KIND.FLOOR, 'carpet is furniture on the floor, not a wall')
  assert.strictEqual(k(4, 4), KIND.FLOOR, 'a barrel on the floor is not a wall')
  assert.strictEqual(k(5, 5), KIND.WALL, 'a bookcase two blocks high blocks sight')
  assert.strictEqual(k(1, 4), KIND.FURNITURE, 'a hanging lantern is not a wall')
  assert.strictEqual(k(4, 1), KIND.FURNITURE, 'a fence post is not a wall')
  assert.strictEqual(k(10, 10), KIND.SURFACE, 'no roof outside: normal view')
  const rgb = Buffer.from(sent.at(-1).rgb, 'base64')
  const px = (x, z) => [...rgb.subarray((z * 16 + x) * 3, (z * 16 + x) * 3 + 3)]
  assert.deepStrictEqual(px(0, 0), [43, 43, 48], 'walls are dark')
  assert.ok(px(3, 3).reduce((a, b) => a + b) > px(10, 10).reduce((a, b) => a + b), 'floors are drawn light')
  assert.notDeepStrictEqual(px(1, 4), [43, 43, 48], 'furniture is not drawn as wall')
  assert.deepStrictEqual(px(3, 0), [28, 72, 214], 'a door to the outside: deep blue')
  assert.deepStrictEqual(px(2, 5), [236, 190, 24], 'a door inside: yellow')

  // Walk outside: the cut goes away and the chunk is listed for redrawing.
  bot.entity.position.set(12.5, -60, 12.5)
  const gone = scanner.setCharacters([bot])
  assert.strictEqual(scanner.cuts.length, 0)
  assert.ok(gone.includes('overworld:0:0'), 'the house chunk is listed for redrawing')
  assert.strictEqual(scanner.rescan([bot], gone) >= 1, true)
  const house = sent.filter((c) => c.cx === 0 && c.cz === 0).at(-1)
  assert.ok(Buffer.from(house.kinds, 'base64').every((v) => v === KIND.SURFACE), 'house chunk redrawn with its roof')
  // From outside, the doors to the outside show blue on the roof; the one inside does not.
  const roof = Buffer.from(house.rgb, 'base64')
  const rp = (x, z) => [...roof.subarray((z * 16 + x) * 3, (z * 16 + x) * 3 + 3)]
  assert.deepStrictEqual(rp(3, 0), [28, 72, 214], 'closed outer door: deep blue')
  assert.deepStrictEqual(rp(6, 3), [28, 72, 214], 'open outer door: the same deep blue')
  assert.notDeepStrictEqual(rp(2, 5), [28, 72, 214], 'a door inside stays hidden under the roof')
})

test('mapScanner: an open roof (a pavilion) shows its ground and posts from outside, the roof faintly over them', () => {
  const { KIND } = require('../src/mapScanner')
  const sent = []
  const scanner = new MapScanner({ scanAbove: 24, scanBelow: 48, indoorRadius: 12 }, (c) => sent.push(c))
  const bot = houseBot()
  bot.entity.position.set(12.5, -60, 12.5) // outside everything
  scanner.setCharacters([bot])
  scanner.scanChunk(bot, 'overworld', 1, 1)
  const c = sent.at(-1)
  const kinds = Buffer.from(c.kinds, 'base64')
  const k = (x, z) => kinds[(z - 16) * 16 + (x - 16)]
  assert.strictEqual(k(22, 22), KIND.FLOOR, 'the ground under the pavilion')
  assert.strictEqual(k(20, 20), KIND.WALL, 'a post')
  assert.strictEqual(k(28, 28), KIND.SURFACE, 'open ground stays as it is')
  const rgb = Buffer.from(c.rgb, 'base64')
  const px = (x, z) => [...rgb.subarray(((z - 16) * 16 + (x - 16)) * 3, ((z - 16) * 16 + (x - 16)) * 3 + 3)]
  assert.notDeepStrictEqual(px(22, 22), px(28, 28), 'the roof tints it')
  // The closed house keeps its roof.
  scanner.scanChunk(bot, 'overworld', 0, 0)
  const house = Buffer.from(sent.filter((m) => m.cx === 0 && m.cz === 0).at(-1).kinds, 'base64')
  assert.strictEqual(house[3 * 16 + 3], KIND.SURFACE, 'inside a closed house: still the roof')
})

test('mapScanner: fixed and off view modes', () => {
  const { KIND } = require('../src/mapScanner')
  const sent = []
  const scanner = new MapScanner({ scanAbove: 24, scanBelow: 48 }, (c) => sent.push(c))
  const bot = houseBot()
  bot.entity.position.set(12.5, -60, 12.5) // standing outside
  scanner.setView({ mode: 'fixed', y: -60 })
  scanner.setCharacters([bot])
  scanner.scanChunk(bot, 'overworld', 0, 0)
  assert.strictEqual(Buffer.from(sent.at(-1).kinds, 'base64')[3 * 16 + 3], KIND.FLOOR, 'fixed cut shows the inside even from outside')
  // Standing a block up (on a step): the cut runs over the doors, which still show as doors.
  scanner.setView({ mode: 'fixed', y: -59 })
  scanner.setCharacters([bot])
  scanner.scanChunk(bot, 'overworld', 0, 0)
  const raised = Buffer.from(sent.at(-1).kinds, 'base64')
  assert.strictEqual(raised[0 * 16 + 3], KIND.DOOR, 'door under a raised cut')
  assert.strictEqual(raised[3 * 16 + 6], KIND.DOOR_OPEN)
  scanner.setView({ mode: 'off' })
  scanner.setCharacters([bot])
  scanner.scanChunk(bot, 'overworld', 0, 0)
  assert.ok(Buffer.from(sent.at(-1).kinds, 'base64').every((v) => v === KIND.SURFACE), 'off: roofs everywhere')
  assert.throws(() => scanner.setView({ mode: 'fixed' }))
  assert.throws(() => scanner.setView({ mode: 'sideways' }))
})

test('displays: matrix follows the game order and gives the right box', () => {
  const { displayMatrix, unitBox } = require('../src/displays')
  const none = { translation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 }, left: { x: 0, y: 0, z: 0, w: 1 }, right: { x: 0, y: 0, z: 0, w: 1 } }
  const near = (a, b) => a.every((v, i) => Math.abs(v - b[i]) < 1e-6)
  assert.ok(near(unitBox(displayMatrix({ x: 1, y: 2, z: 3 }, 0, 0, none)), [1, 2, 3, 2, 3, 4]))
  // a real part of an AI-built object: translation + non-uniform scale
  const part = { ...none, translation: { x: -0.0833, y: 0.1142, z: -0.1042 }, scale: { x: 0.1667, y: 0.0417, z: 0.2083 } }
  assert.ok(near(unitBox(displayMatrix({ x: 8.5, y: -59.8642, z: 10.3958 }, 0, 0, part)), [8.4167, -59.75, 10.2916, 8.5834, -59.7083, 10.4999]))
  // left rotation 90° about +Y turns +X into -Z
  const s = Math.SQRT1_2
  const turned = { ...none, left: { x: 0, y: s, z: 0, w: s } }
  assert.ok(near(unitBox(displayMatrix({ x: 0, y: 0, z: 0 }, 0, 0, turned)), [0, 0, -1, 1, 1, 0]))
  // entity yaw 90° (Minecraft) turns the other way round Y: rotateY(-90°) sends +X to +Z
  assert.ok(near(unitBox(displayMatrix({ x: 0, y: 0, z: 0 }, 90, 0, none)), [-1, 0, 0, 0, 1, 1]))
  // scale happens before translation is applied, after left rotation: translation is not scaled
  const moved = { ...none, translation: { x: 2, y: 0, z: 0 }, scale: { x: 0.5, y: 0.5, z: 0.5 } }
  assert.ok(near(unitBox(displayMatrix({ x: 0, y: 0, z: 0 }, 0, 0, moved)), [2, 0, 0, 2.5, 0.5, 0.5]))
})

test('displays: tracker sends new, changed and removed parts, and a reset on resync', () => {
  const { DisplayTracker } = require('../src/displays')
  const registry = require('minecraft-data')('1.21.4')
  const keys = registry.entitiesByName.block_display.metadataKeys
  const stone = registry.blocksByName.stone.defaultState
  const meta = (stateId, sx = 1) => {
    const m = []
    m[keys.indexOf('scale')] = { x: sx, y: 1, z: 1 }
    m[keys.indexOf('block_state')] = stateId
    return m
  }
  const ent = (id, x, metadata) => ({ id, name: 'block_display', position: { x, y: 0, z: 0 }, yaw: Math.PI, pitch: 0, metadata })
  const bot = { entity: { position: { x: 0, y: 0, z: 0 } }, registry, game: { dimension: 'overworld' }, entities: {} }
  bot.entities = { 1: ent(1, 1, meta(stone)), 2: ent(2, 2, meta(stone)), 3: ent(3, 100, meta(stone)), 4: ent(4, 3, meta(0)) }
  const sent = []
  const t = new DisplayTracker({ radius: 48 }, (m) => sent.push(m), { log () {} })
  t.update([bot])
  assert.deepStrictEqual(sent.flatMap((m) => m.add.map((p) => p.id)).sort(), ['1', '2'], 'far away and air parts are left out')
  assert.strictEqual(sent[0].add[0].name, 'stone')
  const { rgb, ID, SHADE } = require('../src/mapColors')
  assert.deepStrictEqual(sent[0].add[0].c, rgb(ID.STONE, SHADE.NORMAL), 'map colour of the block')
  sent.length = 0
  t.update([bot])
  assert.strictEqual(sent.length, 0, 'nothing changed: nothing sent')
  bot.entities[2].metadata = meta(stone, 2)
  delete bot.entities[1]
  t.update([bot])
  assert.deepStrictEqual(sent.map((m) => [m.add.map((p) => p.id), m.del]), [[['2'], []], [[], ['1']]])
  const reset = [...t.all()]
  assert.ok(reset[0].reset && reset[0].add.length === 1)
})

test('hud: text components become plain text', () => {
  const { componentText } = require('../src/hud')
  const nbt = require('prismarine-nbt')
  assert.strictEqual(componentText('{"text":"He said \\"hi\\""}'), 'He said "hi"')
  assert.strictEqual(componentText('just text {not json'), 'just text {not json')
  assert.strictEqual(componentText({ translate: 'chat.type.text', with: [{ text: 'Jo' }, 'hello'] }), '<Jo> hello')
  assert.strictEqual(componentText({ translate: 'some.unknown.key', fallback: 'Fallback %s', with: ['x'] }), 'Fallback x')
  assert.strictEqual(componentText(nbt.comp({ text: nbt.string('a'), extra: nbt.list(nbt.string(['b', 'c'])) })), 'abc')
  assert.strictEqual(componentText(nbt.string('plain')), 'plain')
  assert.strictEqual(componentText(null), '')
})

test('doors: a door is opened by its lower half; a secret passage is lifted out and put back', async () => {
  const { setDoor, setSecret } = require('../src/doors')
  const blocks = new Map()
  const put = (x, y, z, name, props = {}) => blocks.set(`${x},${y},${z}`, { name, getProperties: () => props })
  put(3, -60, 0, 'oak_door', { facing: 'south', half: 'lower', hinge: 'left', open: false, powered: false })
  put(3, -59, 0, 'oak_door', { facing: 'south', half: 'upper', hinge: 'left', open: false, powered: false })
  put(0, -60, 3, 'bookshelf'); put(0, -59, 3, 'bookshelf')
  const cmds = []
  const bots = {
    onlineBots: () => [{ bot: { blockAt: (p) => blocks.get(`${p.x},${p.y},${p.z}`) ?? { name: 'air', getProperties: () => ({}) } } }],
    runCommand: async (c) => { cmds.push(c); return '' }
  }
  await setDoor(bots, { x: 3, y: -59, z: 0, open: true })
  assert.deepStrictEqual(cmds, ['setblock 3 -60 0 minecraft:oak_door[facing=south,half=lower,hinge=left,open=true,powered=false]'])
  cmds.length = 0
  const lifted = await setSecret(bots, { x: 0, y: -59, z: 3, open: true })
  assert.deepStrictEqual(lifted, [[-60, 'bookshelf'], [-59, 'bookshelf']])
  assert.deepStrictEqual(cmds, ['setblock 0 -60 3 minecraft:air', 'setblock 0 -59 3 minecraft:air'])
  cmds.length = 0
  await setSecret(bots, { x: 0, y: -59, z: 3, open: false, blocks: lifted })
  assert.deepStrictEqual(cmds, ['setblock 0 -60 3 minecraft:bookshelf', 'setblock 0 -59 3 minecraft:bookshelf'])
  await assert.rejects(() => setSecret(bots, { x: 0, y: -59, z: 3, open: false, blocks: [[-60, 'stone; op @a']] }))
  await assert.rejects(() => setDoor(bots, { x: 9, y: -59, z: 9, open: true }), /문을 찾지 못했습니다/)
})
