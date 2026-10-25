'use strict'
// Where the launcher keeps its files, and the small JSON of choices the user made.
const fs = require('fs')
const path = require('path')

const MC_VERSION = '1.21.4'
/** Minecraft data version of 1.21.4; worlds saved by a newer game cannot be opened. */
const DATA_VERSION = 4189
const USER_AGENT = 'BlockworldBridgeLauncher/0.2.1 (https://github.com/foredayner/FVTT_MC)'

const DEFAULTS = {
  serverType: 'paper', // 'paper' | 'vanilla'
  eulaAccepted: false,
  installedServer: null, // { type, build } of server/server.jar
  javaPath: null, // a java the user picked by hand
  foundryData: null,
  preset: 'normal',
  memoryGB: 4,
  onlineMode: false,
  mcPort: 25565,
  rconPort: 25575,
  relayPort: 8765,
  token: null,
  rconPassword: null,
  pendingWorld: null // { name, type } chosen but not generated yet
}

function layout (home) {
  return {
    home,
    server: path.join(home, 'server'),
    java: path.join(home, 'java'),
    state: path.join(home, 'launcher.json'),
    relayConfig: path.join(home, 'relay-config.json')
  }
}

function loadState (home) {
  const file = layout(home).state
  try {
    return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(file, 'utf8')) }
  } catch {
    return { ...DEFAULTS }
  }
}

function saveState (home, state) {
  fs.mkdirSync(home, { recursive: true })
  const file = layout(home).state
  fs.writeFileSync(file + '.tmp', JSON.stringify(state, null, 2))
  fs.renameSync(file + '.tmp', file)
}

module.exports = { MC_VERSION, DATA_VERSION, USER_AGENT, DEFAULTS, layout, loadState, saveState }
