'use strict'
// server.properties read/write that keeps comments, order and unknown keys.
const fs = require('fs')

const unescape = (s) => s.replace(/\\(.)/g, '$1')
const escape = (s) => String(s).replace(/\\/g, '\\\\').replace(/([:=])/g, '\\$1')

function parse (text) {
  const lines = String(text ?? '').split(/\r?\n/)
  if (lines.at(-1) === '') lines.pop()
  return lines.map((raw) => {
    const m = /^\s*([^#!=\s][^=]*?)\s*=(.*)$/.exec(raw)
    return m ? { raw, key: m[1], value: unescape(m[2].trim()) } : { raw }
  })
}

function get (lines, key) {
  return lines.find((l) => l.key === key)?.value
}

/** Set several keys in place; new keys are appended. */
function set (lines, values) {
  const out = lines.map((l) => ({ ...l }))
  for (const [key, v] of Object.entries(values)) {
    const value = String(v)
    const line = out.find((l) => l.key === key)
    const raw = `${key}=${escape(value)}`
    if (line) Object.assign(line, { value, raw })
    else out.push({ key, value, raw })
  }
  return out
}

const stringify = (lines) => lines.map((l) => l.raw).join('\n') + '\n'

function read (file) {
  try { return parse(fs.readFileSync(file, 'utf8')) } catch { return [] }
}

function update (file, values) {
  fs.writeFileSync(file, stringify(set(read(file), values)))
}

module.exports = { parse, get, set, stringify, read, update }
