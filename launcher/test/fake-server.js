'use strict'
// Stands in for `java -jar server.jar nogui` in tests: prints the real "Done" line, echoes commands, saves on stop.
const readline = require('readline')
console.log('[Server thread/INFO]: Starting minecraft server version 1.21.4')
console.log(`[Server thread/INFO]: env _JAVA_OPTIONS=${process.env._JAVA_OPTIONS ?? '(none)'}`)
setTimeout(() => console.log('[Server thread/INFO]: Done (1.234s)! For help, type "help"'), 200)
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  console.log(`[Server thread/INFO]: got command: ${line}`)
  if (line.trim() === 'stop') {
    console.log('[Server thread/INFO]: Saving worlds')
    setTimeout(() => process.exit(0), 100)
  }
})
