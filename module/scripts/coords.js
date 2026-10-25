// Pure coordinate helpers (no Foundry globals) so they can be unit tested in Node.
//
// Map layout: an N x N block square whose north-west corner is (originX, originZ).
// One block = one grid square. Minecraft +X -> scene right, +Z (south) -> scene down.

/**
 * @param {{x:number, z:number}} mc
 * @param {{originX:number, originZ:number}} map
 * @param {{grid:number, sceneX:number, sceneY:number}} dims
 * @returns {{x:number, y:number}} scene pixel of the block's centre
 */
export function mcToScene(mc, map, dims) {
  return {
    x: dims.sceneX + (mc.x - map.originX) * dims.grid,
    y: dims.sceneY + (mc.z - map.originZ) * dims.grid
  };
}

/** Inverse of mcToScene; returns fractional block coordinates. */
export function sceneToMc(pt, map, dims) {
  return {
    x: map.originX + (pt.x - dims.sceneX) / dims.grid,
    z: map.originZ + (pt.y - dims.sceneY) / dims.grid
  };
}

/** Top-left of a 1x1 token whose centre should sit at the bot's position. */
export function tokenTopLeft(mc, map, dims) {
  const c = mcToScene(mc, map, dims);
  return { x: Math.round(c.x - dims.grid / 2), y: Math.round(c.y - dims.grid / 2) };
}

/**
 * Mineflayer yaw: 0 = facing north (-Z), increasing counter-clockwise (pi/2 = west).
 * Foundry rotation: 0 = facing down/south, degrees clockwise.
 */
export function yawToRotation(yaw) {
  const deg = 180 - (yaw * 180) / Math.PI;
  return ((Math.round(deg) % 360) + 360) % 360;
}

/** Is a block column inside the map square? */
export function inMap(x, z, map) {
  return x >= map.originX && z >= map.originZ && x < map.originX + map.size && z < map.originZ + map.size;
}

/** Decode a chunk message's base64 RGB into a 16x16 RGBA buffer. */
export function chunkToRGBA(rgbBase64) {
  const bin = atob(rgbBase64);
  const out = new Uint8ClampedArray(16 * 16 * 4);
  for (let i = 0; i < 256; i++) {
    out[i * 4] = bin.charCodeAt(i * 3);
    out[i * 4 + 1] = bin.charCodeAt(i * 3 + 1);
    out[i * 4 + 2] = bin.charCodeAt(i * 3 + 2);
    out[i * 4 + 3] = 255;
  }
  return out;
}

/** Map origin that centres an N-block square on a position. */
/**
 * Map whose bottom-left block on screen (smallest X, largest Z: the south-west corner) is (x, z).
 * Scene down is +Z, so the map's north-west origin is size-1 blocks north of it.
 */
export function originFromBottomLeft(corner, size) {
  return { originX: Math.floor(corner.x), originZ: Math.floor(corner.z) - size + 1 };
}

/** The bottom-left block of a map (inverse of originFromBottomLeft). */
export function bottomLeftOf(map) {
  return { x: map.originX, z: map.originZ + map.size - 1 };
}

export function originAround(pos, size) {
  return { originX: Math.floor(pos.x) - Math.floor(size / 2), originZ: Math.floor(pos.z) - Math.floor(size / 2) };
}
