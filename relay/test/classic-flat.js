'use strict'
// flying-squid world generator: Minecraft's "Classic Flat" preset as in 1.18+.
// bedrock y=-64, dirt y=-63..-62, grass block y=-61, plains biome.
const { Vec3 } = require('vec3')

function generation (options) {
  const { registry } = options
  const Chunk = require('prismarine-chunk')(registry)
  const bedrock = registry.blocksByName.bedrock.defaultState
  const dirt = registry.blocksByName.dirt.defaultState
  const grass = registry.blocksByName.grass_block.defaultState
  const plains = registry.biomesByName.plains.id
  const MIN_Y = -64

  return function generateChunk () {
    const chunk = new Chunk({ minY: MIN_Y, worldHeight: 384 })
    const p = new Vec3(0, 0, 0)
    for (let x = 0; x < 16; x++) {
      for (let z = 0; z < 16; z++) {
        p.x = x; p.z = z
        p.y = MIN_Y; chunk.setBlockStateId(p, bedrock)
        p.y = MIN_Y + 1; chunk.setBlockStateId(p, dirt)
        p.y = MIN_Y + 2; chunk.setBlockStateId(p, dirt)
        p.y = MIN_Y + 3; chunk.setBlockStateId(p, grass)
        for (let y = MIN_Y; y < MIN_Y + 384; y += 4) {
          p.y = y
          chunk.setBiome(p, plains)
        }
        for (let y = MIN_Y; y < MIN_Y + 384; y++) {
          p.y = y
          chunk.setSkyLight(p, 15)
        }
      }
    }
    return chunk
  }
}

module.exports = generation
