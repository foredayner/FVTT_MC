'use strict'
// A throwaway local Minecraft server for development (flying-squid, offline mode, 1.21.4).
// Not a replacement for a real Paper/vanilla server — use it to try the relay without one.
const mcServer = require('flying-squid')

function startDevServer ({ port = 25565, version = '1.21.4', quiet = false, world = 'flat' } = {}) {
  // flying-squid writes logs/<timestamp>.log relative to the working directory and fails if it is missing.
  if (!quiet) require('fs').mkdirSync(require('path').join(process.cwd(), 'logs'), { recursive: true })
  return new Promise((resolve, reject) => {
    const serv = mcServer.createMCServer({
      'motd': 'Blockworld Bridge dev server',
      port,
      'max-players': 10,
      'online-mode': false,
      logging: !quiet,
      gameMode: 0,
      difficulty: 1,
      worldFolder: undefined,
      // 'flat' = Minecraft's Classic Flat preset (grass at y=-61); 'hills' = random terrain for testing
      generation: world === 'hills'
        ? { name: 'diamond_square', options: { worldHeight: 80 } }
        : { name: require('path').join(__dirname, 'classic-flat.js'), options: {} },
      kickTimeout: 10000,
      plugins: {},
      modpe: false,
      'view-distance': 4,
      'player-list-text': { header: 'BWB', footer: 'dev' },
      'everybody-op': true,
      'max-entities': 100,
      version
    })
    serv.once('listening', () => resolve(serv))
    serv.once('error', reject)
  })
}

if (require.main === module) {
  const world = process.argv.includes('--hills') ? 'hills' : 'flat'
  startDevServer({ world }).then(() => console.log(`dev server: localhost:25565 (1.21.4, offline, ${world === 'flat' ? 'classic flat' : 'hills'})`))
}

module.exports = { startDevServer }
