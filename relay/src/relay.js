'use strict'
// WebSocket front door. Exactly one authenticated client (the GM's Foundry tab) at a time.
const crypto = require('crypto')
const { WebSocketServer } = require('ws')
const { MapScanner } = require('./mapScanner')
const { BotManager } = require('./botManager')
const { buildGmCommand } = require('./gmCommands')
const { Rcon } = require('./rcon')
const { PROTOCOL_VERSION } = require('./protocol')
const { World3D, readAsset, assetVersion } = require('./world3d')
const { DisplayTracker } = require('./displays')

function safeEqual (a, b) {
  const ba = Buffer.from(String(a)); const bb = Buffer.from(String(b))
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb)
}

async function startRelay (cfg, log = console) {
  let client = null // the authenticated GM socket
  const send = (msg) => {
    if (client && client.readyState === 1) client.send(JSON.stringify(msg))
  }

  const scanner = new MapScanner(cfg.map, (chunk) => send({ type: 'chunk', ...chunk }))
  const world3d = new World3D({ radius: cfg.viewer.radius }, (msg) => send(msg))
  const bots = new BotManager(cfg, scanner, cfg.viewer.enabled ? [world3d] : [])
  const displays = new DisplayTracker(cfg.displays ?? { radius: 48 }, (msg) => send(msg), log)
  bots.on('bots', () => send({ type: 'bots', bots: bots.botList() }))
  bots.on('event', (ev) => {
    send({ type: 'event', ...ev })
    if (ev.kind !== 'chat') log.log(`[${ev.kind}] ${ev.text}`)
  })

  if (cfg.rcon.enabled) {
    const rcon = new Rcon(cfg.rcon)
    try {
      await rcon.connect()
      bots.rcon = rcon
      log.log('RCON 연결됨')
    } catch (err) {
      log.warn(`RCON 연결 실패 (봇 채팅으로 대체): ${err.message}`)
    }
  }

  // Intentions the GM client may relay. Each returns a value (or a promise) for the ack.
  const handlers = {
    spawnBot: (m) => { bots.spawn(m.key, m.username); return true },
    despawnBot: (m) => { bots.despawn(m.key); return true },
    moveTo: (m) => bots.moveTo(m.key, num(m.x), num(m.z)),
    stop: (m) => bots.stop(m.key),
    dig: (m) => bots.dig(m.key, num(m.x), num(m.z), m.y),
    attackAt: (m) => bots.attackAt(m.key, num(m.x), num(m.z)),
    control: (m) => bots.control(m.key, m.control, m.state),
    look: (m) => bots.look(m.key, num(m.yaw), num(m.pitch)),
    cursor: (m) => bots.cursor(m.key, m.button),
    chat: (m) => bots.chat(m.key, m.text),
    gm: async (m) => {
      const out = []
      for (const cmd of buildGmCommand(m)) out.push(await bots.runCommand(cmd))
      return out.filter(Boolean).join('\n')
    },
    resync: () => {
      send({ type: 'bots', bots: bots.botList() })
      for (const c of scanner.all()) send({ type: 'chunk', ...c })
      for (const c of world3d.all()) send(c)
      for (const d of displays.all()) send(d)
      return true
    },
    asset3d: (m) => readAsset(cfg.minecraft.version, m.name),
    mapView: (m) => {
      scanner.setView({ mode: m.mode, y: m.y })
      const live = bots.onlineBots().map((e) => e.bot)
      scanner.setCharacters(live)
      return scanner.rescanAll(live)
    }
  }

  const wss = new WebSocketServer({ host: cfg.listen.host, port: cfg.listen.port, maxPayload: 64 * 1024 })
  await new Promise((resolve, reject) => { wss.once('listening', resolve); wss.once('error', reject) })
  log.log(`Blockworld Bridge relay: ws://${cfg.listen.host}:${wss.address().port}`)

  wss.on('connection', (ws, req) => {
    let authed = false
    ws.isAlive = true
    ws.on('pong', () => { ws.isAlive = true })
    const authTimer = setTimeout(() => { if (!authed) ws.close(4000, 'auth timeout') }, 5000)

    ws.on('message', async (raw) => {
      let msg
      try { msg = JSON.parse(raw.toString()) } catch { return ws.close(4002, 'bad json') }
      if (!authed) {
        if (msg.type !== 'hello' || !safeEqual(msg.token, cfg.token)) {
          log.warn(`인증 실패: ${req.socket.remoteAddress}`)
          return ws.close(4003, 'unauthorized')
        }
        authed = true
        clearTimeout(authTimer)
        if (client && client !== ws) client.close(4001, 'replaced by a newer connection')
        client = ws
        ws.send(JSON.stringify({
          type: 'welcome',
          protocol: PROTOCOL_VERSION,
          mcVersion: cfg.minecraft.version,
          viewer: { enabled: cfg.viewer.enabled, version: assetVersion(cfg.minecraft.version), radius: cfg.viewer.radius },
          gmCommandsVia: bots.rcon ? 'rcon' : 'bot-chat'
        }))
        handlers.resync()
        log.log('Foundry 연결됨')
        return
      }
      const h = handlers[msg.type]
      if (!h) return reply(ws, msg.id, false, `unknown type ${msg.type}`)
      try {
        const result = await h(msg)
        reply(ws, msg.id, true, undefined, result)
      } catch (err) {
        reply(ws, msg.id, false, err.message)
      }
    })

    ws.on('close', () => {
      clearTimeout(authTimer)
      if (client === ws) { client = null; log.log('Foundry 연결 끊김') }
    })
  })

  // Heartbeat: drop dead sockets so a crashed tab doesn't hold the slot.
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) { ws.terminate(); continue }
      ws.isAlive = false
      ws.ping()
    }
  }, 15000)

  const stateTimer = setInterval(() => {
    if (client) send({ type: 'state', t: Date.now(), ...bots.snapshot() })
  }, Math.round(1000 / cfg.stateHz))

  // Periodic map sync: rescan what each character can see; only changed chunks are sent.
  // Auto floor-plan view follows characters in and out of buildings; chunks a cut just left
  // are redrawn as normal ground.
  const mapTimer = setInterval(() => {
    const live = bots.onlineBots().map((e) => e.bot)
    try { scanner.rescan(live, scanner.setCharacters(live)) } catch (err) { log.warn(`단면 갱신 실패: ${err.message}`) }
    for (const e of bots.onlineBots()) {
      try { scanner.scanAround(e.bot, cfg.map.refreshRadius) } catch (err) { log.warn(`지도 갱신 실패: ${err.message}`) }
    }
  }, Math.max(250, cfg.map.refreshMs))

  // 3D world: keep the columns around every character streamed.
  const world3dTimer = cfg.viewer.enabled
    ? setInterval(() => { try { world3d.update(bots.onlineBots().map((e) => e.bot)) } catch (err) { log.warn(`3D 갱신 실패: ${err.message}`) } }, 500)
    : null

  // Block displays (objects built from small blocks): for the map and the 3D view alike.
  const displayTimer = setInterval(() => {
    try { displays.update(bots.onlineBots().map((e) => e.bot)) } catch (err) { log.warn(`디스플레이 갱신 실패: ${err.message}`) }
  }, 500)

  async function close () {
    clearInterval(heartbeat)
    clearInterval(stateTimer)
    clearInterval(mapTimer)
    clearInterval(displayTimer)
    if (world3dTimer) clearInterval(world3dTimer)
    scanner.close()
    bots.closeAll()
    bots.rcon?.close()
    for (const ws of wss.clients) ws.terminate()
    await new Promise((r) => wss.close(r))
  }

  return { close, bots, scanner, world3d, displays, port: wss.address().port }
}

function reply (ws, id, ok, error, result) {
  if (id === undefined || ws.readyState !== 1) return
  ws.send(JSON.stringify({ type: 'ack', id, ok, error, result: result === undefined ? null : result }))
}

function num (v) {
  const n = Number(v)
  if (!Number.isFinite(n)) throw new Error('좌표가 숫자가 아닙니다')
  return n
}

module.exports = { startRelay }
