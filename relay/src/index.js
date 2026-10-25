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
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
