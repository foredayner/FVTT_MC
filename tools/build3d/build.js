// Builds the browser 3D renderer into module/vendor/.
//   node build.js
// minecraft-data normally bundles every Minecraft version (~60 MB). A plugin swaps its version
// index for one that only knows 1.21.4 (blocks, shapes, biomes, tints) and 1.16.2 tints, which
// prismarine-viewer's mesher reads.
const esbuild = require('esbuild')
const fs = require('fs')
const path = require('path')

const OUT = path.resolve(__dirname, '../../module/vendor')
const VERSION = '1.21.4'
const MCD = path.dirname(require.resolve('minecraft-data/package.json'))

function trimmedDataJs () {
  const rel = (f) => JSON.stringify(path.join(MCD, 'minecraft-data/data/pc', f))
  const v = (name) => `get ${name} () { return require(${rel(`${VERSION}/${name}.json`)}) }`
  return `module.exports = {
  pc: {
    '${VERSION}': {
      ${['blocks', 'blockCollisionShapes', 'biomes', 'tints', 'materials', 'version'].map(v).join(',\n      ')}
    },
    '1.16.2': {
      get tints () { return require(${rel('1.16.2/tints.json')}) },
      get version () { return require(${rel('1.16.2/version.json')}) }
    }
  },
  bedrock: {}
}`
}

// prismarine-viewer's mesher skips faces whose neighbour is below y=0 (pre-1.18 worlds).
// 1.18+ worlds go down to -64, so compare with the world's real bottom instead.
// It also treats every block whose name contains "air" as air (stairs!); match the real air blocks only.
const negativeHeights = {
  name: 'negative-heights',
  setup (build) {
    build.onLoad({ filter: /prismarine-viewer[\\/]viewer[\\/]lib[\\/]models\.js$/ }, (args) => {
      const src = fs.readFileSync(args.path, 'utf8')
      let patched = src.replaceAll('neighbor.position.y < 0', 'neighbor.position.y < (world.minY ?? 0)')
      if (patched === src) throw new Error('models.js patch did not apply; check the prismarine-viewer version')
      // "air" check matched any name containing it, so stairs ("st-air-s") were never drawn.
      const airFixed = patched.replace("if (block.name.includes('air')) return []", "if (/^(air|cave_air|void_air)$/.test(block.name)) return []")
      if (airFixed === patched) throw new Error('models.js air patch did not apply; check the prismarine-viewer version')
      patched = airFixed
      return { contents: patched, loader: 'js', resolveDir: path.dirname(args.path) }
    })
  }
}

const trimMinecraftData = {
  name: 'trim-minecraft-data',
  setup (build) {
    build.onLoad({ filter: /minecraft-data[\\/]data\.js$/ }, () => ({ contents: trimmedDataJs(), loader: 'js', resolveDir: MCD }))
  }
}

const common = {
  bundle: true,
  minify: true,
  format: 'iife',
  platform: 'browser',
  target: ['chrome110', 'firefox110', 'safari16'],
  define: { global: 'globalThis', 'process.env.NODE_DEBUG': 'false', 'process.platform': '"browser"' },
  inject: [path.join(__dirname, 'src/shims.js')],
  plugins: [trimMinecraftData, negativeHeights],
  alias: {
    zlib: path.join(__dirname, 'src/node-shims/zlib.js'),
    assert: path.join(__dirname, 'src/node-shims/assert.js'),
    util: path.join(__dirname, 'src/node-shims/util.js'),
    buffer: require.resolve('buffer/'),
    events: require.resolve('events/')
  },
  legalComments: 'linked',
  logLevel: 'warning'
}

async function main () {
  fs.mkdirSync(OUT, { recursive: true })
  await esbuild.build({ ...common, entryPoints: [path.join(__dirname, 'src/renderer.js')], outfile: path.join(OUT, 'bwb3d.js') })
  await esbuild.build({ ...common, entryPoints: [path.join(__dirname, 'src/worker.js')], outfile: path.join(OUT, 'bwb3d-worker.js') })
  for (const f of ['bwb3d.js', 'bwb3d-worker.js']) {
    console.log(f, (fs.statSync(path.join(OUT, f)).size / 1024).toFixed(0) + ' KB')
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
