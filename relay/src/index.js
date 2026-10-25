#!/usr/bin/env node
'use strict'
const { loadConfig } = require('./config')
const { startRelay } = require('./relay')

async function main () {
  let cfg
  try { cfg = loadConfig() } catch (err) {
    console.error(err.message)
    process.exit(1)
  }
  const relay = await startRelay(cfg)
  const shutdown = async () => {
    console.log('종료 중...')
    await relay.close()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
  // When started by the launcher (child process with IPC): report ready, stop on request.
  if (process.send) {
    process.on('message', (m) => { if (m?.type === 'stop') shutdown() })
    process.send({ type: 'ready', port: relay.port })
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
