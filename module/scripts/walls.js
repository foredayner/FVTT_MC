import { MODULE_ID } from "./constants.js";
import { mcToScene } from "./coords.js";

/** Map pixel kinds sent by the relay (relay/src/mapScanner.js KIND). */
export const KIND = { SURFACE: 0, FLOOR: 1, WALL: 2, WINDOW: 3, DOOR: 4, DOOR_OPEN: 5 };
/** Cells that block sight: walls and closed doors. Windows and open doors let you see through. */
const BLOCKS = (k) => k === KIND.WALL || k === KIND.DOOR;

export function decodeKinds(b64) {
  if (!b64) return null;
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Wall segments (in block coordinates) for one chunk: every edge between a sight-blocking cell
 * and a cell that does not block, merged into straight runs. Edges facing a neighbour chunk use
 * that chunk's cells when known. Cells outside the map are ignored.
 * @param {(x:number, z:number) => number} kindAt  kind of any block column (0 if unknown)
 * @returns {number[][]} [[x1, z1, x2, z2], ...] on block-corner coordinates
 */
export function chunkWallSegments(cx, cz, kindAt, map) {
  const inside = (x, z) => x >= map.originX && z >= map.originZ && x < map.originX + map.size && z < map.originZ + map.size;
  const h = new Map(); // line z -> sorted xs of unit edges along it
  const v = new Map(); // line x -> zs
  const add = (m, line, at) => { if (!m.has(line)) m.set(line, []); m.get(line).push(at); };
  for (let dz = 0; dz < 16; dz++) {
    for (let dx = 0; dx < 16; dx++) {
      const x = cx * 16 + dx; const z = cz * 16 + dz;
      if (!inside(x, z) || !BLOCKS(kindAt(x, z))) continue;
      if (!BLOCKS(kindAt(x, z - 1))) add(h, z, x);
      if (!BLOCKS(kindAt(x, z + 1))) add(h, z + 1, x);
      if (!BLOCKS(kindAt(x - 1, z))) add(v, x, z);
      if (!BLOCKS(kindAt(x + 1, z))) add(v, x + 1, z);
    }
  }
  const out = [];
  const runs = (m, horizontal) => {
    for (const [line, list] of m) {
      const at = [...new Set(list)].sort((a, b) => a - b);
      let start = at[0]; let prev = at[0];
      for (let i = 1; i <= at.length; i++) {
        if (i < at.length && at[i] === prev + 1) { prev = at[i]; continue; }
        out.push(horizontal ? [start, line, prev + 1, line] : [line, start, line, prev + 1]);
        start = prev = at[i];
      }
    }
  };
  runs(h, true);
  runs(v, false);
  return out;
}

/**
 * GM only: keeps Foundry walls on the map scene in step with the floor plan, so a token's vision
 * stops at real Minecraft walls. Walls are tagged per chunk and only the chunks that changed
 * (plus their neighbours, whose border edges depend on them) are rebuilt, at most once a second.
 */
export class WallSync {
  constructor(hub) {
    this.hub = hub;
    this.kinds = new Map();  // "dim:cx:cz" -> Uint8Array(256)
    this.dirty = new Set();
    this.busy = null;
    hub.addEventListener("chunk", (ev) => this.onChunk(ev.detail));
    this.timer = setInterval(() => this.flush(), 1000);
  }

  get scene() { return canvas.scene; }
  get map() { return this.scene?.getFlag(MODULE_ID, "map") ?? null; }
  get enabled() { return !!this.map && (this.scene.getFlag(MODULE_ID, "view")?.walls ?? true); }

  onChunk(c) {
    const kinds = decodeKinds(c.kinds);
    if (!kinds) return;
    const key = `${c.dim}:${c.cx}:${c.cz}`;
    const prev = this.kinds.get(key);
    this.kinds.set(key, kinds);
    if (prev && prev.every((v, i) => v === kinds[i])) return;
    for (const [dx, dz] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) this.dirty.add(`${c.dim}:${c.cx + dx}:${c.cz + dz}`);
  }

  kindAt(dim, x, z) {
    const k = this.kinds.get(`${dim}:${Math.floor(x / 16)}:${Math.floor(z / 16)}`);
    if (!k) return KIND.SURFACE;
    return k[(((z % 16) + 16) % 16) * 16 + (((x % 16) + 16) % 16)];
  }

  /** Rebuild every chunk (scene bound, map moved, walls switched on). */
  rebuildAll() {
    for (const key of this.kinds.keys()) this.dirty.add(key);
    for (const w of this.scene?.walls ?? []) { const k = w.getFlag(MODULE_ID, "chunk"); if (k) this.dirty.add(k); }
    return this.flush();
  }

  async removeAll() {
    const scene = this.scene;
    const ids = scene?.walls.filter((w) => w.getFlag(MODULE_ID, "chunk")).map((w) => w.id) ?? [];
    if (ids.length) await scene.deleteEmbeddedDocuments("Wall", ids);
  }

  flush() {
    if (this.busy || !this.dirty.size) return this.busy;
    const keys = [...this.dirty];
    this.dirty.clear();
    this.busy = this.apply(keys).catch((err) => console.warn(`${MODULE_ID} | walls`, err)).finally(() => { this.busy = null; });
    return this.busy;
  }

  async apply(keys) {
    const scene = this.scene;
    if (!scene || !this.hub.isRelayHost) return;
    const map = this.map;
    const on = this.enabled;
    const dims = { grid: scene.grid.size, sceneX: canvas.dimensions.sceneX, sceneY: canvas.dimensions.sceneY };
    const S = CONST.WALL_SENSE_TYPES ?? { NORMAL: 20 };
    const M = CONST.WALL_MOVEMENT_TYPES ?? { NORMAL: 20 };
    const toDelete = [];
    const toCreate = [];
    for (const key of keys) {
      const [dim, cx, cz] = key.split(":");
      const existing = scene.walls.filter((w) => w.getFlag(MODULE_ID, "chunk") === key);
      const want = new Map();
      if (on && dim === (map.dim ?? "overworld")) {
        for (const [x1, z1, x2, z2] of chunkWallSegments(Number(cx), Number(cz), (x, z) => this.kindAt(dim, x, z), map)) {
          const a = mcToScene({ x: x1, z: z1 }, map, dims); const b = mcToScene({ x: x2, z: z2 }, map, dims);
          const c = [a.x, a.y, b.x, b.y].map(Math.round);
          want.set(c.join(","), c);
        }
      }
      for (const w of existing) {
        const id = w.c.map(Math.round).join(",");
        if (want.has(id)) want.delete(id); else toDelete.push(w.id);
      }
      for (const c of want.values()) {
        toCreate.push({ c, move: M.NORMAL, sight: S.NORMAL, light: S.NORMAL, sound: S.NORMAL, flags: { [MODULE_ID]: { chunk: key } } });
      }
    }
    if (toDelete.length) await scene.deleteEmbeddedDocuments("Wall", toDelete);
    if (toCreate.length) await scene.createEmbeddedDocuments("Wall", toCreate);
  }
}
