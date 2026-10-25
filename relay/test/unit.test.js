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
  assert.strictEqual(k(10, 10), KIND.SURFACE, 'no roof outside: normal view')
  const rgb = Buffer.from(sent.at(-1).rgb, 'base64')
  const px = (x, z) => [...rgb.subarray((z * 16 + x) * 3, (z * 16 + x) * 3 + 3)]
  assert.deepStrictEqual(px(0, 0), [43, 43, 48], 'walls are dark')
  assert.ok(px(3, 3).reduce((a, b) => a + b) > px(10, 10).reduce((a, b) => a + b), 'floors are drawn light')

  // Walk outside: the cut goes away and the chunk is listed for redrawing.
  bot.entity.position.set(12.5, -60, 12.5)
  const gone = scanner.setCharacters([bot])
  assert.strictEqual(scanner.cuts.length, 0)
  assert.ok(gone.includes('overworld:0:0'), 'the house chunk is listed for redrawing')
  assert.strictEqual(scanner.rescan([bot], gone) >= 1, true)
  const house = sent.filter((c) => c.cx === 0 && c.cz === 0).at(-1)
  assert.ok(Buffer.from(house.kinds, 'base64').every((v) => v === KIND.SURFACE), 'house chunk redrawn with its roof')
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
  scanner.setView({ mode: 'off' })
  scanner.setCharacters([bot])
  scanner.scanChunk(bot, 'overworld', 0, 0)
  assert.ok(Buffer.from(sent.at(-1).kinds, 'base64').every((v) => v === KIND.SURFACE), 'off: roofs everywhere')
  assert.throws(() => scanner.setView({ mode: 'fixed' }))
  assert.throws(() => scanner.setView({ mode: 'sideways' }))
})
