/* global self, postMessage, fetch */
// Mesher worker: holds chunk columns, turns dirty 16x16x16 sections into geometry.
// Based on prismarine-viewer's worker (MIT), changed to support worlds with negative heights
// (1.18+: minY -64) and to fetch block-state models from a URL itself.
const { Vec3 } = require('vec3')
const { World } = require('prismarine-viewer/viewer/lib/world')
const { getSectionGeometry } = require('prismarine-viewer/viewer/lib/models')

let blocksStates = null
let world = null
let version = null
let modelWorld = null // one empty section holding a single block, for block display models
const dirty = new Set()

const key = (x, y, z) => `${x},${y},${z}`

function sectionOf (chunk, y) {
  const minY = chunk.minY ?? 0
  return chunk.sections[(y - minY) >> 4]
}

function setDirty (x, y, z, value) {
  const k = key(x, y, z)
  if (!value) {
    dirty.delete(k)
    postMessage({ type: 'sectionFinished', key: k })
    return
  }
  const chunk = world && world.getColumn(x, z)
  if (chunk && sectionOf(chunk, y)) dirty.add(k)
  else postMessage({ type: 'sectionFinished', key: k })
}

self.onmessage = async ({ data }) => {
  switch (data.type) {
    case 'version':
      version = data.version
      world = new World(data.version)
      break
    case 'blockModel':
      postModel(data.stateId)
      break
    case 'blockStates':
      blocksStates = await (await fetch(data.url)).json()
      postMessage({ type: 'ready' })
      break
    case 'dirty':
      setDirty(data.x, data.y, data.z, data.value)
      break
    case 'chunk': {
      const col = world.addColumn(data.x, data.z, data.chunk)
      world.minY = col.minY ?? 0 // read by the patched mesher (see build.js)
      break
    }
    case 'unloadChunk':
      world.removeColumn(data.x, data.z)
      break
    case 'blockUpdate':
      world.setBlockStateId(new Vec3(data.x, data.y, data.z), data.stateId)
      break
  }
}

/**
 * Geometry of one block in the unit cube [0,1]^3: the block sits at (8,8,8) of an empty section,
 * and the mesher writes positions relative to the section centre (8,8,8). Neighbours are air, so no
 * face is culled. Used for block display entities, placed by the main thread with their matrix.
 */
function postModel (stateId) {
  if (!blocksStates) return
  if (!modelWorld) {
    const Chunk = require('prismarine-chunk')(version)
    modelWorld = new World(version)
    modelWorld.columns['0,0'] = new Chunk({ minY: 0, worldHeight: 16 })
    modelWorld.minY = 0
  }
  const pos = new Vec3(8, 8, 8)
  modelWorld.setBlockStateId(pos, stateId)
  const geometry = getSectionGeometry(0, 0, 0, modelWorld, blocksStates)
  modelWorld.setBlockStateId(pos, 0)
  const transfer = [geometry.positions.buffer, geometry.normals.buffer, geometry.colors.buffer, geometry.uvs.buffer]
  postMessage({ type: 'model', stateId, geometry }, transfer)
}

setInterval(() => {
  if (!world || !blocksStates || dirty.size === 0) return
  for (const k of [...dirty]) {
    dirty.delete(k)
    const [x, y, z] = k.split(',').map(Number)
    const chunk = world.getColumn(x, z)
    if (chunk && sectionOf(chunk, y)) {
      const geometry = getSectionGeometry(x, y, z, world, blocksStates)
      const transfer = [geometry.positions.buffer, geometry.normals.buffer, geometry.colors.buffer, geometry.uvs.buffer]
      postMessage({ type: 'geometry', key: k, geometry }, transfer)
    }
    postMessage({ type: 'sectionFinished', key: k })
  }
}, 50)
