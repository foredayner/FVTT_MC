/**
 * Block display parts (objects built from many small blocks) as sent by the relay:
 * {id, dim, s: stateId, name, m: 4x4 column-major world matrix of the unit block,
 *  box: [minX,minY,minZ,maxX,maxY,maxZ], c: [r,g,b] map colour or null}
 */

/** Apply one relay "disp" message to a Map of parts (id -> part). */
export function applyDisp(parts, msg) {
  if (msg.reset) parts.clear();
  for (const p of msg.add ?? []) parts.set(p.id, p);
  for (const id of msg.del ?? []) parts.delete(id);
  return parts;
}

/**
 * Map cells covered by parts, like the map item would show them: per block column the colour of
 * the highest part. Small parts still colour the one cell they sit in.
 * @param {Iterable<object>} parts
 * @param {{originX:number, originZ:number, size:number, dim:string}} map
 * @param {{maxY?:number}} [opts] parts starting above maxY are left out (floor-plan cut)
 * @returns {Map<number, {x:number, z:number, top:number, c:number[]}>} key = z*size+x (map pixels)
 */
export function displayCells(parts, map, { maxY = Infinity } = {}) {
  const cells = new Map();
  for (const p of parts) {
    if (!p.c || (p.dim ?? "overworld") !== map.dim || p.box[1] >= maxY) continue;
    const [x0, , z0, x1, top, z1] = p.box;
    const ax = Math.floor(x0) - map.originX; const bx = Math.max(Math.floor(x0), Math.ceil(x1) - 1) - map.originX;
    const az = Math.floor(z0) - map.originZ; const bz = Math.max(Math.floor(z0), Math.ceil(z1) - 1) - map.originZ;
    for (let z = Math.max(0, az); z <= Math.min(map.size - 1, bz); z++) {
      for (let x = Math.max(0, ax); x <= Math.min(map.size - 1, bx); x++) {
        const k = z * map.size + x;
        const cur = cells.get(k);
        if (!cur || top > cur.top) cells.set(k, { x, z, top, c: p.c });
      }
    }
  }
  return cells;
}
