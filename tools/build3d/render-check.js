// End-to-end render check for the browser 3D view, no Foundry needed:
//   dev server (classic flat) -> relay -> fake GM client -> headless Chromium running bwb3d.js
// Saves screenshots to ./render-check-out/. Usage: node render-check.js [--hills]
const fs = require('fs')
const path = require('path')
const http = require('http')
const { chromium } = require('playwright')
const RELAY = path.resolve(__dirname, '../../relay')
const WebSocket = require(path.join(RELAY, 'node_modules/ws'))
const { startDevServer } = require(path.join(RELAY, 'test/dev-server'))
const { startRelay } = require(path.join(RELAY, 'src/relay'))
const { deepMerge } = require(path.join(RELAY, 'src/config'))
const defaults = require(path.join(RELAY, 'config.example.json'))

const OUT = path.join(__dirname, 'render-check-out')
const WWW = path.join(OUT, 'www')
const VENDOR = path.resolve(__dirname, '../../module/vendor')
const hills = process.argv.includes('--hills')

function serve (root, port) {
  const types = { '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.html': 'text/html' }
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '')
      const file = rel.startsWith('vendor/') ? path.join(VENDOR, rel.slice(7)) : path.join(root, rel || 'index.html')
      if (!fs.existsSync(file)) { res.writeHead(404); return res.end() }
      res.writeHead(200, { 'content-type': types[path.extname(file)] ?? 'application/octet-stream' })
      fs.createReadStream(file).pipe(res)
    }).listen(port, '127.0.0.1', () => resolve(s))
  })
}

async function main () {
  fs.mkdirSync(path.join(WWW, 'bwb-assets'), { recursive: true })
  const serv = await startDevServer({ port: 25592, quiet: true, world: hills ? 'hills' : 'flat' })
  const cfg = deepMerge(defaults, {
    listen: { host: '127.0.0.1', port: 0 },
    token: 'render-check-token-123',
    minecraft: { host: '127.0.0.1', port: 25592 }
  })
  const relay = await startRelay(cfg, { log () {}, warn: console.warn })

  // Fake GM: collect what the module would receive.
  const ws = new WebSocket(`ws://127.0.0.1:${relay.port}`)
  const msgs = []; const acks = new Map(); let id = 0
  ws.on('message', (raw) => { const m = JSON.parse(raw); if (m.type === 'ack') acks.get(m.id)?.(m); else msgs.push(m) })
  const call = (type, body = {}) => new Promise((resolve) => { const i = ++id; acks.set(i, resolve); ws.send(JSON.stringify({ type, id: i, ...body })) })
  await new Promise((r) => ws.once('open', r))
  ws.send(JSON.stringify({ type: 'hello', token: cfg.token }))
  await new Promise((r) => setTimeout(r, 300))
  const welcome = msgs.find((m) => m.type === 'welcome')
  console.log('welcome.viewer', welcome.viewer)

  // Assets, exactly as the GM would upload them.
  const ver = welcome.viewer.version
  fs.mkdirSync(path.join(WWW, 'bwb-assets', ver), { recursive: true })
  for (const [name, file] of [['atlas', 'atlas.png'], ['blockStates', 'blockStates.json']]) {
    const a = await call('asset3d', { name })
    fs.writeFileSync(path.join(WWW, 'bwb-assets', ver, file), Buffer.from(a.result.data, 'base64'))
  }

  await call('spawnBot', { key: 'u1', username: 'Viewer' })
  const waitFor = async (pred, ms = 20000) => { const t = Date.now(); while (Date.now() - t < ms) { if (pred()) return true; await new Promise((r) => setTimeout(r, 100)) } return false }
  await waitFor(() => msgs.filter((m) => m.type === 'col3d').length >= 25)
  const cols = msgs.filter((m) => m.type === 'col3d')
  const state = () => msgs.filter((m) => m.type === 'state').at(-1)?.bots.find((b) => b.key === 'u1')
  await waitFor(() => !!state())
  console.log('col3d received', cols.length, 'avg KB', (cols.reduce((a, c) => a + c.data.length, 0) / cols.length / 1024).toFixed(1), 'minY', cols[0].minY, 'height', cols[0].height)

  fs.writeFileSync(path.join(WWW, 'index.html'), '<!doctype html><html><head><link rel="icon" href="data:,"></head><body style="margin:0;background:#000"><canvas id="c" width="800" height="450"></canvas><script src="vendor/bwb3d.js"></script></body></html>')
  const web = await serve(WWW, 0)
  const base = `http://127.0.0.1:${web.address().port}/`

  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
  const page = await browser.newPage({ viewport: { width: 800, height: 450 } })
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  await page.goto(base)
  await page.evaluate(({ base, ver }) => {
    const c = document.getElementById('c')
    window.r = new BWB3D.Renderer3D(c, {
      workerUrl: base + 'vendor/bwb3d-worker.js',
      atlasUrl: base + `bwb-assets/${ver}/atlas.png`,
      blockStatesUrl: base + `bwb-assets/${ver}/blockStates.json`,
      version: ver
    })
    window.r.resize(800, 450)
  }, { base, ver })

  const s = state()
  for (const col of cols) {
    await page.evaluate(async (col) => { const json = await BWB3D.gunzipBase64(col.data); window.r.addColumn(col.x, col.z, col.minY, col.height, json) }, col)
  }
  // Look slightly down across the land; put a mob and two avatar characters in view.
  // b2 faces the camera (illustration visible), b3 also faces it at 200% (spills past the box), b4 has no picture.
  fs.copyFileSync(path.join(__dirname, 'test-illust.png'), path.join(WWW, 'illust.png'))
  await page.evaluate(({ s, base }) => {
    window.r.setTarget({ x: s.x, y: s.y, z: s.z })
    window.r.setLook(Math.PI * 0.75, -0.2)
    const at = (d, side) => ({ x: s.x - d * 0.707 + side * 0.707, z: s.z + d * 0.707 + side * 0.707 })
    const face = (p) => Math.atan2(-(s.x - p.x), -(s.z - p.z)) // yaw that looks back at the camera
    const p2 = at(4, -1); const p3 = at(5, 1.5); const p4 = at(6, -3)
    window.r.setEntities([
      { id: 'm1', kind: 'hostile', ...at(7, 3), y: s.y },
      { id: 'b2', kind: 'bot', ...p2, y: s.y, yaw: face(p2), avatar: { color: '#3cdcff', image: base + 'illust.png', scale: 1 } },
      { id: 'b3', kind: 'bot', ...p3, y: s.y, yaw: face(p3), avatar: { color: '#ffaa00', image: base + 'illust.png', scale: 2 } },
      { id: 'b5', kind: 'bot', ...at(4, 1.6), y: s.y, yaw: face(at(4, 1.6)), avatar: { color: '#33cc66', image: base + 'illust.png', scale: 0.6, offsetX: 0.3, offsetY: 0.5 } },
      { id: 'b4', kind: 'bot', ...p4, y: s.y, yaw: 0, avatar: { color: '#8844ff', image: '', scale: 1 } }
    ])
  }, { s, base })
  await page.waitForFunction(() => window.r.ready && window.r.stats().meshes > 10, null, { timeout: 60000 })
  await page.waitForTimeout(1500)
  await page.screenshot({ path: path.join(OUT, '1-world.png') })
  console.log('stats', await page.evaluate(() => window.r.stats()))

  // Dig the block under our feet's neighbour, apply the block3d message, render again.
  const before = msgs.length
  const dig = await call('dig', { key: 'u1', x: Math.floor(s.x) - 1, z: Math.floor(s.z) + 1 })
  await waitFor(() => msgs.slice(before).some((m) => m.type === 'block3d'), 8000)
  const updates = msgs.slice(before).filter((m) => m.type === 'block3d')
  console.log('dig ok', dig.ok, dig.error ?? '', 'block3d messages', updates.length, updates[0] ?? '')
  for (const u of updates) await page.evaluate((u) => window.r.setBlock(u.x, u.y, u.z, u.stateId), u)
  await page.evaluate(({ s }) => { window.r.setLook(Math.PI * 0.75, -1.0) }, { s })
  await page.waitForTimeout(1500)
  await page.screenshot({ path: path.join(OUT, '2-after-dig.png') })

  console.log('page errors', errors.length ? errors : 'none')
  await browser.close(); web.close(); ws.close(); await relay.close(); serv.quit?.()
  process.exit(errors.length ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
