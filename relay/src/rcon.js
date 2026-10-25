'use strict'
// Minimal Source-RCON client (the protocol vanilla/Paper Minecraft servers speak on rcon.port).
// Packet: int32 length | int32 id | int32 type | ascii body | 0x00 0x00   (little endian)
const net = require('net')

const TYPE_AUTH = 3
const TYPE_COMMAND = 2

class Rcon {
  constructor ({ host, port, password, timeoutMs = 5000 }) {
    Object.assign(this, { host, port, password, timeoutMs })
    this.socket = null
    this.nextId = 1
    this.waiting = new Map() // id -> {resolve, reject, timer}
    this.buf = Buffer.alloc(0)
  }

  async connect () {
    this.socket = net.createConnection({ host: this.host, port: this.port })
    this.socket.on('data', (d) => this.onData(d))
    this.socket.on('close', () => this.failAll(new Error('RCON 연결이 닫혔습니다')))
    this.socket.on('error', (e) => this.failAll(e))
    await new Promise((resolve, reject) => {
      this.socket.once('connect', resolve)
      this.socket.once('error', reject)
    })
    const res = await this.request(TYPE_AUTH, this.password)
    if (res.id === -1) throw new Error('RCON 비밀번호가 틀렸습니다')
  }

  send (command) {
    return this.request(TYPE_COMMAND, command).then((r) => r.body)
  }

  request (type, body) {
    if (!this.socket) return Promise.reject(new Error('RCON 미연결'))
    const id = this.nextId++
    const payload = Buffer.from(body, 'utf8')
    const pkt = Buffer.alloc(14 + payload.length)
    pkt.writeInt32LE(10 + payload.length, 0)
    pkt.writeInt32LE(id, 4)
    pkt.writeInt32LE(type, 8)
    payload.copy(pkt, 12)
    // last two bytes already 0
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id)
        reject(new Error('RCON 응답 시간 초과'))
      }, this.timeoutMs)
      this.waiting.set(id, { resolve, reject, timer })
      this.socket.write(pkt)
    })
  }

  onData (chunk) {
    this.buf = Buffer.concat([this.buf, chunk])
    while (this.buf.length >= 4) {
      const len = this.buf.readInt32LE(0)
      if (this.buf.length < 4 + len) return
      const id = this.buf.readInt32LE(4)
      const type = this.buf.readInt32LE(8)
      const body = this.buf.toString('utf8', 12, 4 + len - 2)
      this.buf = this.buf.subarray(4 + len)
      // A failed login answers with id -1; resolve the oldest waiter in that case.
      const key = id === -1 ? this.waiting.keys().next().value : id
      const w = this.waiting.get(key)
      if (w) {
        clearTimeout(w.timer)
        this.waiting.delete(key)
        w.resolve({ id, type, body })
      }
    }
  }

  failAll (err) {
    for (const w of this.waiting.values()) { clearTimeout(w.timer); w.reject(err) }
    this.waiting.clear()
  }

  close () { this.socket?.end(); this.socket = null }
}

module.exports = { Rcon }
