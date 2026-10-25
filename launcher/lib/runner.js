'use strict'
// Runs the Minecraft server (java) and then the relay (a Node child), and stops them in reverse order.
const EventEmitter = require('events')
const net = require('net')
const readline = require('readline')
const { spawn, fork } = require('child_process')

const READY_RE = /\bDone \([\d.,]+s\)!/
const BIND_FAIL_RE = /FAILED TO BIND TO PORT/i

function portFree (port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const s = net.createServer()
    s.once('error', () => resolve(false))
    s.listen(port, host, () => s.close(() => resolve(true)))
  })
}

function waitExit (child, ms) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true)
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), ms)
    child.once('exit', () => { clearTimeout(t); resolve(true) })
  })
}

class Runner extends EventEmitter {
  constructor () {
    super()
    this.mc = null
    this.relay = null
    this.mcState = 'stopped' // stopped | starting | running | stopping
    this.relayState = 'stopped' // stopped | starting | running
    this.stopping = null
  }

  status () { return { mc: this.mcState, relay: this.relayState } }

  setState (mc, relay) {
    if (mc) this.mcState = mc
    if (relay) this.relayState = relay
    this.emit('status', this.status())
  }

  log (src, line) { this.emit('log', { src, line, time: Date.now() }) }

  /**
   * @param {{javaPath:string, serverDir:string, memoryGB:number, mcPort:number, relayPort:number,
   *          relayEntry:string, relayConfig:string, startTimeoutMs?:number, javaArgs?:string[]}} o
   */
  async start (o) {
    if (this.mcState !== 'stopped' || this.relayState !== 'stopped') throw new Error('이미 실행 중입니다.')
    for (const [name, port] of [['마크 서버', o.mcPort], ['relay', o.relayPort]]) {
      if (!(await portFree(port))) throw new Error(`${name} 포트 ${port} 를 다른 프로그램이 쓰고 있습니다. 그 프로그램을 끄거나 설정 탭에서 포트를 바꾸세요.`)
    }
    this.setState('starting')
    const args = o.javaArgs ?? [`-Xms1G`, `-Xmx${o.memoryGB}G`, '-jar', 'server.jar', 'nogui']
    const mc = spawn(o.javaPath, args, { cwd: o.serverDir, env: { ...process.env, ...o.mcEnv }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    this.mc = mc

    const ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('서버가 제때 켜지지 않았습니다. 서버 로그를 확인하세요.')), o.startTimeoutMs ?? 600000)
      const onLine = (line) => {
        this.log('server', line)
        if (READY_RE.test(line)) { clearTimeout(timer); resolve() }
        if (BIND_FAIL_RE.test(line)) { clearTimeout(timer); reject(new Error('서버가 포트를 열지 못했습니다. 다른 서버가 켜져 있는지 확인하세요.')) }
      }
      readline.createInterface({ input: mc.stdout }).on('line', onLine)
      readline.createInterface({ input: mc.stderr }).on('line', onLine)
      mc.once('error', (err) => { clearTimeout(timer); reject(new Error(`Java 를 실행하지 못했습니다: ${err.message}`)) })
      mc.once('exit', (code) => { clearTimeout(timer); reject(new Error(`서버가 시작 중에 꺼졌습니다 (코드 ${code}). 서버 로그를 확인하세요.`)) })
    })
    mc.once('exit', (code) => {
      this.mc = null
      this.log('launcher', `마크 서버 종료 (코드 ${code})`)
      this.setState('stopped')
      // the relay is useless without the server
      if (!this.stopping && this.relay) this.stopRelay()
    })

    try {
      await ready
    } catch (err) {
      if (this.mc) { this.mc.kill(); await waitExit(mc, 5000) }
      this.setState('stopped')
      throw err
    }
    this.setState('running')
    await this.startRelay(o)
  }

  async startRelay (o) {
    this.setState(null, 'starting')
    const child = fork(o.relayEntry, [], {
      execPath: process.execPath, // inside Electron this is the app, run as plain Node below
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', BWB_CONFIG: o.relayConfig },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      windowsHide: true
    })
    this.relay = child
    readline.createInterface({ input: child.stdout }).on('line', (l) => this.log('relay', l))
    readline.createInterface({ input: child.stderr }).on('line', (l) => this.log('relay', l))
    child.once('exit', (code) => {
      if (this.relay === child) this.relay = null
      this.log('launcher', `relay 종료 (코드 ${code})`)
      this.setState(null, 'stopped')
    })
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('relay 가 제때 켜지지 않았습니다.')), 30000)
      child.on('message', (m) => { if (m?.type === 'ready') { clearTimeout(t); resolve() } })
      child.once('exit', (code) => { clearTimeout(t); reject(new Error(`relay 가 켜지지 못했습니다 (코드 ${code}). relay 로그를 확인하세요.`)) })
    }).catch((err) => { this.log('launcher', err.message); throw err })
    this.setState(null, 'running')
  }

  async stopRelay () {
    const child = this.relay
    if (!child) return
    try { child.send({ type: 'stop' }) } catch { /* already gone */ }
    if (!(await waitExit(child, 8000))) child.kill()
    await waitExit(child, 3000)
  }

  /** Relay first, then `stop` on the server console so the world is saved. */
  stop () {
    this.stopping ??= (async () => {
      await this.stopRelay()
      const mc = this.mc
      if (mc) {
        this.setState('stopping')
        try { mc.stdin.write('stop\n') } catch { /* stdin closed */ }
        if (!(await waitExit(mc, 90000))) {
          this.log('launcher', '서버가 응답하지 않아 강제로 종료합니다.')
          mc.kill()
          await waitExit(mc, 5000)
        }
      }
      this.setState('stopped', 'stopped')
    })().finally(() => { this.stopping = null })
    return this.stopping
  }

  /** A line typed in the server console box. */
  command (text) {
    const line = String(text ?? '').replace(/[\r\n]+/g, ' ').trim().replace(/^\//, '')
    if (!line) return
    if (!this.mc || this.mcState !== 'running') throw new Error('서버가 실행 중이 아닙니다.')
    this.log('launcher', `> ${line}`)
    this.mc.stdin.write(line + '\n')
  }
}

module.exports = { Runner, portFree, READY_RE }
