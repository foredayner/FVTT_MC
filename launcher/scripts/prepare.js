'use strict'
// Copies the relay source and the Foundry module into launcher/bundled/ so the app ships them.
// The relay's npm dependencies are the launcher's own (see package.json).
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..', '..')
const OUT = path.resolve(__dirname, '..', 'bundled')

fs.rmSync(OUT, { recursive: true, force: true })
fs.mkdirSync(path.join(OUT, 'relay'), { recursive: true })
fs.cpSync(path.join(ROOT, 'relay', 'src'), path.join(OUT, 'relay', 'src'), { recursive: true })
fs.copyFileSync(path.join(ROOT, 'relay', 'config.example.json'), path.join(OUT, 'relay', 'config.example.json'))
fs.cpSync(path.join(ROOT, 'module'), path.join(OUT, 'module'), {
  recursive: true,
  filter: (p) => path.basename(p) !== 'test'
})
const version = JSON.parse(fs.readFileSync(path.join(OUT, 'module', 'module.json'), 'utf8')).version
console.log(`bundled relay + module v${version} -> ${path.relative(process.cwd(), OUT) || OUT}`)
