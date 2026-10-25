'use strict'
// Run with: electron test/electron-smoke.js
// Starts the fake server and the *bundled* relay with Electron's own binary as Node, like the packaged app does.
const path = require('path')
const fs = require('fs')
const os = require('os')
const { app } = require('electron')
const { Runner } = require('../lib/runner')
const { loadState, layout } = require('../lib/state')
const settings = require('../lib/settings')

app.whenReady().then(async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bwb-smoke-'))
  const state = loadState(home)
  Object.assign(state, { mcPort: 25611, rconPort: 25612, relayPort: 18765 })
  settings.applySettings(home, state)
  const runner = new Runner()
  runner.on('log', (l) => console.log(`[${l.src}] ${l.line}`))
  let code = 0
  try {
    await runner.start({
      javaPath: process.execPath,
      javaArgs: [path.join(__dirname, 'fake-server.js')],
      mcEnv: { ELECTRON_RUN_AS_NODE: '1' }, // the fake server is run by Electron's binary here, as plain Node
      serverDir: layout(home).server,
      memoryGB: 1,
      mcPort: state.mcPort,
      relayPort: state.relayPort,
      relayEntry: path.join(__dirname, '..', 'bundled', 'relay', 'src', 'index.js'),
      relayConfig: layout(home).relayConfig
    })
    console.log('SMOKE status', JSON.stringify(runner.status()))
    await runner.stop()
    console.log('SMOKE stopped', JSON.stringify(runner.status()))
  } catch (err) {
    console.log('SMOKE FAIL', err.message)
    code = 1
  }
  app.exit(code)
})
