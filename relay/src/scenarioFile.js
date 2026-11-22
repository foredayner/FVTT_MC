'use strict'
// The scenario builder's file in the server's world (<world>/blockworld/clues.json: the clues and
// the stairs of the map built there), for Foundry to load when the map is opened. Found from the
// server's folder and the world its server.properties names.
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const MAX_BYTES = 4 * 1024 * 1024

function worldDir (serverDir) {
  if (!serverDir) return null
  let level = 'world'
  try {
    const props = fs.readFileSync(path.join(serverDir, 'server.properties'), 'utf8')
    const m = /^level-name=(.*)$/m.exec(props)
    if (m && m[1].trim()) level = m[1].trim().replace(/\\:/g, ':')
  } catch { /* the default */ }
  return path.resolve(serverDir, level)
}

/** {world, hash, data} of the world's file, or null when there is none. */
function readScenarioFile (serverDir) {
  const dir = worldDir(serverDir)
  if (!dir) return null
  const file = path.join(dir, 'blockworld', 'clues.json')
  let raw
  try {
    if (fs.statSync(file).size > MAX_BYTES) return null
    raw = fs.readFileSync(file, 'utf8')
  } catch { return null }
  let data
  try { data = JSON.parse(raw) } catch { return null }
  if (!data || typeof data !== 'object' || (!Array.isArray(data.clues) && !Array.isArray(data.stairs))) return null
  return { world: path.basename(dir), hash: crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16), data }
}

module.exports = { readScenarioFile, worldDir }
