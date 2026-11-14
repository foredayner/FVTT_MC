'use strict'
// A tiny PNG writer for test pictures (RGB, no dependencies).
const zlib = require('zlib')

const TABLE = new Uint32Array(256).map((_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

function crc32 (buf) {
  let c = 0xffffffff
  for (const b of buf) c = TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk (type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

/** A picture w x h, RGB bytes row by row, as a PNG file's bytes. */
function encodePng (w, h, rgb) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // RGB
  const raw = Buffer.alloc((w * 3 + 1) * h)
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0
    Buffer.from(rgb.buffer, rgb.byteOffset + y * w * 3, w * 3).copy(raw, y * (w * 3 + 1) + 1)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))
  ])
}

/** A canvas of w x h pixels to draw blocks on (each block `scale` pixels). */
class Picture {
  constructor (w, h, bg = [24, 24, 28]) {
    this.w = w
    this.h = h
    this.rgb = new Uint8Array(w * h * 3)
    for (let i = 0; i < w * h; i++) this.rgb.set(bg, i * 3)
  }

  set (x, y, c, alpha = 1) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return
    const i = (y * this.w + x) * 3
    for (let k = 0; k < 3; k++) this.rgb[i + k] = Math.round(this.rgb[i + k] * (1 - alpha) + c[k] * alpha)
  }

  rect (x, y, w, h, c, alpha = 1) {
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) this.set(xx, yy, c, alpha)
  }

  frame (x, y, w, h, c, t = 2) {
    this.rect(x, y, w, t, c); this.rect(x, y + h - t, w, t, c)
    this.rect(x, y, t, h, c); this.rect(x + w - t, y, t, h, c)
  }

  png () { return encodePng(this.w, this.h, this.rgb) }
}

module.exports = { encodePng, Picture }
