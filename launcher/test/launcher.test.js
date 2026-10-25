'use strict'
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')
const zlib = require('zlib')
const crypto = require('crypto')
const net = require('net')

const { loadState, saveState, layout, DATA_VERSION } = require('../lib/state')
const java = require('../lib/java')
const { download } = require('../lib/http')
const server = require('../lib/server')
const props = require('../lib/properties')
const worlds = require('../lib/worlds')
const settings = require('../lib/settings')
const foundry = require('../lib/foundry')
const { Runner } = require('../lib/runner')
const { computeStatus } = require('../lib/status')

const tmpHome = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bwb-launcher-'))
const sha = (algo, buf) => crypto.createHash(algo).update(buf).digest('hex')

/** fetch stand-in serving fixed URLs. */
function fakeFetch (routes) {
  return async (url) => {
    const body = routes[url]
    if (body === undefined) return new Response('not found', { status: 404 })
    const isJson = typeof body === 'object' && !Buffer.isBuffer(body)
    const buf = isJson ? Buffer.from(JSON.stringify(body)) : Buffer.from(body)
    return new Response(buf, { status: 200, headers: { 'content-length': String(buf.length) } })
  }
}

function writeLevelDat (dir, dataVersion) {
  const nbt = require('prismarine-nbt')
  fs.mkdirSync(dir, { recursive: true })
  const root = nbt.comp({ Data: nbt.comp({ DataVersion: nbt.int(dataVersion), LevelName: nbt.string('t') }) })
  fs.writeFileSync(path.join(dir, 'level.dat'), zlib.gzipSync(nbt.writeUncompressed(root)))
}

test('state: defaults, save and load', () => {
  const home = tmpHome()
  const s = loadState(home)
  assert.strictEqual(s.serverType, 'paper')
  s.memoryGB = 6
  saveState(home, s)
  assert.strictEqual(loadState(home).memoryGB, 6)
})

test('java: version parsing and choosing the first 21+', () => {
  assert.strictEqual(java.parseJavaVersion('openjdk version "21.0.4" 2024-07-16'), 21)
  assert.strictEqual(java.parseJavaVersion('java version "1.8.0_412"'), 8)
  assert.strictEqual(java.parseJavaVersion('java version "17"'), 17)
  assert.strictEqual(java.parseJavaVersion('nope'), null)
  const home = tmpHome()
  const versions = { '/old/java': 17, java: 21 }
  const r = java.findJava(home, { javaPath: '/old/java' }, { probeFn: (p) => versions[p] ?? null, env: {} })
  assert.ok(r.ok)
  assert.strictEqual(r.source, 'PATH')
  assert.deepStrictEqual(r.seen.map((s) => s.major), [17, 21])
  assert.strictEqual(java.findJava(home, {}, { probeFn: () => 17, env: {} }).ok, false)
})

test('java: Adoptium asset url and package pick', () => {
  assert.match(java.adoptiumUrl('win32', 'x64'), /latest\/21\/hotspot\?os=windows&architecture=x64&image_type=jre/)
  assert.throws(() => java.adoptiumUrl('aix', 'ppc'))
  const pkg = java.pickAdoptiumPackage([{ binary: { os: 'windows', package: { name: 'jre.zip', link: 'https://x/jre.zip', checksum: 'ab', size: 1 } } }])
  assert.deepStrictEqual(pkg, { name: 'jre.zip', url: 'https://x/jre.zip', sha256: 'ab', size: 1 })
  assert.throws(() => java.pickAdoptiumPackage([]))
})

test('java: probing the real java on this machine', (t) => {
  const r = java.findJava(tmpHome(), {})
  if (!r.ok) return t.skip(`no Java 21+ here (found: ${JSON.stringify(r.seen)})`)
  assert.ok(r.major >= 21 && r.path)
})

test('http: download over a real socket, checksum enforced, no partial file left', async () => {
  const payload = crypto.randomBytes(300000)
  const srv = http.createServer((req, res) => { res.setHeader('content-length', payload.length); res.end(payload) })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${srv.address().port}/f`
  const dir = tmpHome()
  try {
    let last = 0
    await download(url, path.join(dir, 'ok.bin'), { sha256: sha('sha256', payload), onProgress: (d) => { last = d } })
    assert.strictEqual(last, payload.length)
    assert.ok(fs.readFileSync(path.join(dir, 'ok.bin')).equals(payload))
    await assert.rejects(download(url, path.join(dir, 'bad.bin'), { sha1: '00' }), /체크섬/)
    assert.deepStrictEqual(fs.readdirSync(dir), ['ok.bin'])
  } finally { srv.close() }
})

test('server: vanilla and paper resolve + download, EULA status', async () => {
  const home = tmpHome()
  const jar = Buffer.from('fake jar')
  const fetchImpl = fakeFetch({
    [server.MOJANG_MANIFEST]: { versions: [{ id: '1.21.5', url: 'https://m/x' }, { id: '1.21.4', url: 'https://m/1.21.4.json' }] },
    'https://m/1.21.4.json': { downloads: { server: { url: 'https://m/server.jar', sha1: sha('sha1', jar), size: jar.length } } },
    'https://m/server.jar': jar,
    [server.PAPER_BUILDS]: [
      { id: 233, channel: 'ALPHA', downloads: { 'server:default': { url: 'https://p/233.jar' } } },
      { id: 232, channel: 'STABLE', downloads: { 'server:default': { name: 'paper-1.21.4-232.jar', url: 'https://p/232.jar', checksums: { sha256: sha('sha256', jar) } } } }
    ],
    'https://p/232.jar': jar
  })
  const state = loadState(home)
  state.serverType = 'vanilla'
  state.installedServer = await server.downloadServer(home, 'vanilla', { fetchImpl })
  assert.deepStrictEqual(state.installedServer, { type: 'vanilla', build: '1.21.4' })
  assert.deepStrictEqual(server.serverStatus(home, state), { ok: false, jar: true, typeOk: true, eula: false, build: '1.21.4' })
  server.writeEula(home, true)
  assert.ok(server.serverStatus(home, state).ok)
  state.serverType = 'paper' // switched type without downloading: red again
  assert.strictEqual(server.serverStatus(home, state).ok, false)
  state.installedServer = await server.downloadServer(home, 'paper', { fetchImpl })
  assert.strictEqual(state.installedServer.build, '1.21.4-232', 'stable build is picked over a newer alpha')
  assert.ok(server.serverStatus(home, state).ok)
  server.writeEula(home, false)
  assert.strictEqual(server.eulaAccepted(home), false)
})

test('properties: keeps comments/order, escapes colons', () => {
  const lines = props.parse('#Minecraft server properties\nmotd=Hello\nlevel-type=minecraft\\:normal\n')
  assert.strictEqual(props.get(lines, 'level-type'), 'minecraft:normal')
  const out = props.stringify(props.set(lines, { 'level-type': 'minecraft:flat', 'rcon.password': 'a=b' }))
  assert.strictEqual(out, '#Minecraft server properties\nmotd=Hello\nlevel-type=minecraft\\:flat\nrcon.password=a\\=b\n')
  assert.strictEqual(props.get(props.parse(out), 'rcon.password'), 'a=b')
})

test('worlds: list, too-new warning, Paper dimension folders hidden', () => {
  const home = tmpHome()
  const dir = layout(home).server
  writeLevelDat(path.join(dir, 'world'), DATA_VERSION)
  writeLevelDat(path.join(dir, 'world_nether'), DATA_VERSION)
  writeLevelDat(path.join(dir, 'future'), DATA_VERSION + 300)
  fs.mkdirSync(path.join(dir, 'logs'))
  const list = worlds.listWorlds(home)
  assert.deepStrictEqual(list.map((w) => [w.name, w.dataVersion, w.tooNew]), [['future', DATA_VERSION + 300, true], ['world', DATA_VERSION, false]])
})

test('worlds: import from folder and zip (wrapped, zip-slip refused), select and status', () => {
  const home = tmpHome()
  const state = loadState(home)
  const src = tmpHome()
  writeLevelDat(path.join(src, 'My Map!'), 4000)
  fs.writeFileSync(path.join(src, 'My Map!', 'session.lock'), 'x')
  const a = worlds.importFolder(home, path.join(src, 'My Map!'))
  assert.strictEqual(a, 'My Map_')
  assert.ok(!fs.existsSync(path.join(layout(home).server, a, 'session.lock')))
  assert.strictEqual(worlds.importFolder(home, path.join(src, 'My Map!')), 'My Map__2', 'same name gets a suffix')
  assert.throws(() => worlds.importFolder(home, src + '-missing'))

  const AdmZip = require('adm-zip')
  const zip = new AdmZip()
  zip.addFile('Adventure/level.dat', fs.readFileSync(path.join(src, 'My Map!', 'level.dat')))
  zip.addFile('Adventure/region/r.0.0.mca', Buffer.from('r'))
  const zipPath = path.join(src, 'adv.zip')
  zip.writeZip(zipPath)
  assert.strictEqual(worlds.importZip(home, zipPath), 'Adventure')
  assert.ok(fs.existsSync(path.join(layout(home).server, 'Adventure', 'region', 'r.0.0.mca')))

  const evil = new AdmZip()
  evil.addFile('level.dat', Buffer.from('x'))
  evil.getEntries()[0].entryName = '../escape/level.dat'
  const evilPath = path.join(src, 'evil.zip')
  evil.writeZip(evilPath)
  assert.throws(() => worlds.importZip(home, evilPath))
  assert.ok(!fs.existsSync(path.join(layout(home).server, '..', 'escape')))
  assert.ok(!fs.readdirSync(layout(home).server).some((n) => n.startsWith('.import-')), 'temp folder cleaned up')

  assert.deepStrictEqual(worlds.mapStatus(home, state), { ok: false, name: null })
  worlds.selectWorld(home, state, 'Adventure')
  assert.deepStrictEqual(worlds.mapStatus(home, state), { ok: true, name: 'Adventure', tooNew: false, pending: false })
  worlds.selectWorld(home, state, 'flatland', 'flat')
  const lines = props.read(worlds.propsFile(home))
  assert.strictEqual(props.get(lines, 'level-type'), 'minecraft:flat')
  assert.ok(worlds.mapStatus(home, state).ok && worlds.mapStatus(home, state).pending)
  assert.throws(() => worlds.selectWorld(home, state, 'nope'), /없습니다/)
  assert.throws(() => worlds.selectWorld(home, state, '../x', 'flat'))
})

test('settings: apply writes matching properties and relay config; edits turn it red', () => {
  const home = tmpHome()
  const state = loadState(home)
  assert.strictEqual(settings.settingsStatus(home, state).ok, false)
  settings.applySettings(home, state)
  assert.ok(state.token.length >= 16 && state.rconPassword)
  assert.ok(settings.settingsStatus(home, state).ok)
  const cfg = JSON.parse(fs.readFileSync(layout(home).relayConfig, 'utf8'))
  const lines = props.read(worlds.propsFile(home))
  assert.strictEqual(cfg.rcon.password, props.get(lines, 'rcon.password'))
  assert.strictEqual(props.get(lines, 'server-ip'), '127.0.0.1')
  assert.strictEqual(props.get(lines, 'spawn-protection'), '0')
  assert.strictEqual(cfg.minecraft.auth, 'offline')
  state.preset = 'wide'
  assert.strictEqual(settings.settingsStatus(home, state).ok, false)
  const token = state.token
  settings.applySettings(home, state)
  assert.strictEqual(state.token, token, 'token stays the same so Foundry need not change')
  assert.strictEqual(JSON.parse(fs.readFileSync(layout(home).relayConfig, 'utf8')).viewer.radius, 3)
  state.relayPort = state.mcPort
  assert.throws(() => settings.applySettings(home, state), /달라야/)
  state.relayPort = 80
  assert.throws(() => settings.applySettings(home, state), /1024/)
  // relay accepts the written config
  state.relayPort = 8765
  settings.applySettings(home, state)
  const { loadConfig } = require('../../relay/src/config')
  assert.strictEqual(loadConfig(layout(home).relayConfig).token, state.token)
})

test('foundry: data folder detection, install, upgrade', () => {
  const bundled = path.resolve(__dirname, '..', '..', 'module')
  const ver = foundry.readVersion(bundled)
  assert.ok(ver)
  const user = tmpHome()
  const data = path.join(user, 'Data')
  fs.mkdirSync(path.join(data, 'worlds'), { recursive: true })
  assert.strictEqual(foundry.resolveDataPath(user), data, 'parent of Data is accepted')
  assert.strictEqual(foundry.resolveDataPath(path.join(user, 'nothing')), null)
  assert.strictEqual(foundry.moduleStatus(null, bundled).state, 'noData')
  assert.strictEqual(foundry.moduleStatus(data, bundled).state, 'missing')
  const target = path.join(data, 'modules', 'blockworld-bridge')
  fs.mkdirSync(target, { recursive: true })
  fs.writeFileSync(path.join(target, 'module.json'), JSON.stringify({ version: '0.0.9' }))
  fs.writeFileSync(path.join(target, 'stale.js'), '')
  assert.strictEqual(foundry.moduleStatus(data, bundled).state, 'old')
  const st = foundry.installModule(user, bundled)
  assert.deepStrictEqual([st.state, st.installed], ['current', ver])
  assert.ok(!fs.existsSync(path.join(target, 'stale.js')), 'old files removed')
  assert.ok(!fs.existsSync(path.join(target, 'test')), 'tests not shipped')
  assert.deepStrictEqual(fs.readdirSync(path.join(data, 'modules')), ['blockworld-bridge'])
  assert.strictEqual(foundry.compareVersions('0.4.10', '0.4.2'), 1)
  assert.strictEqual(foundry.compareVersions('0.4.2', '0.4.2'), 0)
  assert.match(foundry.defaultDataPath('win32', { LOCALAPPDATA: 'C:\\U\\AppData\\Local' }), /FoundryVTT[\\/]Data$/)
})

test('runner: server then relay start, console command, stop saves and ends both', { timeout: 60000 }, async () => {
  const home = tmpHome()
  const state = loadState(home)
  // free ports for this run
  const freePort = () => new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)) }) })
  state.mcPort = await freePort(); state.relayPort = await freePort(); state.rconPort = await freePort()
  settings.applySettings(home, state)
  const runner = new Runner()
  const logs = []
  runner.on('log', (l) => logs.push(l))
  await runner.start({
    javaPath: process.execPath,
    javaArgs: [path.join(__dirname, 'fake-server.js')],
    serverDir: layout(home).server,
    memoryGB: 1,
    mcPort: state.mcPort,
    relayPort: state.relayPort,
    relayEntry: path.resolve(__dirname, '..', '..', 'relay', 'src', 'index.js'),
    relayConfig: layout(home).relayConfig
  })
  assert.deepStrictEqual(runner.status(), { mc: 'running', relay: 'running' })
  // the relay really listens and accepts the token from the written config
  const WebSocket = require('ws')
  const ws = new WebSocket(`ws://127.0.0.1:${state.relayPort}`)
  await new Promise((r, j) => { ws.once('open', r); ws.once('error', j) })
  ws.send(JSON.stringify({ type: 'hello', token: state.token }))
  const hello = await new Promise((r) => ws.once('message', (m) => r(JSON.parse(m))))
  assert.notStrictEqual(hello.type, 'error')
  ws.close()

  runner.command('/say hi')
  await new Promise((r) => setTimeout(r, 300))
  assert.ok(logs.some((l) => l.src === 'server' && /got command: say hi/.test(l.line)))
  await assert.rejects(runner.start({}), /이미/)

  await runner.stop()
  assert.deepStrictEqual(runner.status(), { mc: 'stopped', relay: 'stopped' })
  assert.ok(logs.some((l) => /got command: stop/.test(l.line)), 'server got stop so the world is saved')
  assert.throws(() => runner.command('say late'), /실행 중이 아닙니다/)
})

test('runner: busy port is reported before anything starts', async () => {
  const blocker = net.createServer()
  await new Promise((r) => blocker.listen(0, '127.0.0.1', r))
  const runner = new Runner()
  try {
    await assert.rejects(runner.start({ mcPort: blocker.address().port, relayPort: 1 }), /다른 프로그램/)
    assert.deepStrictEqual(runner.status(), { mc: 'stopped', relay: 'stopped' })
  } finally { blocker.close() }
})

test('status: seven lights in order, readyToRun needs the first four', () => {
  const home = tmpHome()
  const state = loadState(home)
  const runner = { status: () => ({ mc: 'stopped', relay: 'stopped' }) }
  const bundledModule = path.resolve(__dirname, '..', '..', 'module')
  let s = computeStatus({ home, state, runner, bundledModule, java: { ok: true, major: 21 } })
  assert.deepStrictEqual(s.items.map((i) => i.id), ['java', 'server', 'map', 'settings', 'module', 'mc', 'relay'])
  assert.deepStrictEqual(s.items.map((i) => i.ok), [true, false, false, false, false, false, false])
  assert.strictEqual(s.readyToRun, false)
  fs.mkdirSync(layout(home).server, { recursive: true })
  fs.writeFileSync(server.jarPath(home), 'x')
  state.installedServer = { type: 'paper', build: '1.21.4-1' }
  server.writeEula(home, true)
  worlds.selectWorld(home, state, 'world', 'normal')
  settings.applySettings(home, state)
  s = computeStatus({ home, state, runner, bundledModule, java: { ok: true, major: 21 } })
  assert.strictEqual(s.readyToRun, true)
  assert.strictEqual(s.items.find((i) => i.id === 'map').text, 'world (새로 생성)')
})
