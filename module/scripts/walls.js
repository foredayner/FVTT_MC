import { MODULE_ID } from "./constants.js";
import { mcToScene } from "./coords.js";

/** Map pixel kinds sent by the relay (relay/src/mapScanner.js KIND). */
export const KIND = { SURFACE: 0, FLOOR: 1, WALL: 2, WINDOW: 3, DOOR: 4, DOOR_OPEN: 5, FURNITURE: 6 };
/** Cells drawn as plain walls. Doors (and secret doors) get their own door walls; windows and furniture let you see through. */
const DOORLIKE = (k) => k === KIND.DOOR || k === KIND.DOOR_OPEN;

/** Scene flag key of a secret door cell. */
export const secretKey = (dim, x, z) => `${dim}|${x}|${z}`;

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
export function chunkWallSegments(cx, cz, kindAt, map, isSecret = () => false) {
  const BLOCKS = (k, x, z) => k === KIND.WALL && !isSecret(x, z);
  const inside = (x, z) => x >= map.originX && z >= map.originZ && x < map.originX + map.size && z < map.originZ + map.size;
  const h = new Map(); // line z -> sorted xs of unit edges along it
  const v = new Map(); // line x -> zs
  const add = (m, line, at) => { if (!m.has(line)) m.set(line, []); m.get(line).push(at); };
  for (let dz = 0; dz < 16; dz++) {
    for (let dx = 0; dx < 16; dx++) {
      const x = cx * 16 + dx; const z = cz * 16 + dz;
      if (!inside(x, z) || !BLOCKS(kindAt(x, z), x, z)) continue;
      if (!BLOCKS(kindAt(x, z - 1), x, z - 1)) add(h, z, x);
      if (!BLOCKS(kindAt(x, z + 1), x, z + 1)) add(h, z + 1, x);
      if (!BLOCKS(kindAt(x - 1, z), x - 1, z)) add(v, x, z);
      if (!BLOCKS(kindAt(x + 1, z), x + 1, z)) add(v, x + 1, z);
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
 * Door walls for one chunk: a segment across the middle of every door cell and secret door cell,
 * running along the wall it stands in (the plain walls end at the cell's edges, so it is sealed).
 * @param {(x:number, z:number) => object|null} secretAt  the secret door at a cell ({open}) or null
 * @returns {{x:number, z:number, seg:number[], secret:boolean, open:boolean}[]}
 */
export function chunkDoors(cx, cz, kindAt, map, secretAt = () => null) {
  const inside = (x, z) => x >= map.originX && z >= map.originZ && x < map.originX + map.size && z < map.originZ + map.size;
  const solid = (x, z) => { const k = kindAt(x, z); return k === KIND.WALL || DOORLIKE(k) || !!secretAt(x, z); };
  const out = [];
  for (let dz = 0; dz < 16; dz++) {
    for (let dx = 0; dx < 16; dx++) {
      const x = cx * 16 + dx; const z = cz * 16 + dz;
      if (!inside(x, z)) continue;
      const s = secretAt(x, z);
      const k = kindAt(x, z);
      if (!s && !DOORLIKE(k)) continue;
      const ew = (solid(x - 1, z) ? 1 : 0) + (solid(x + 1, z) ? 1 : 0);
      const ns = (solid(x, z - 1) ? 1 : 0) + (solid(x, z + 1) ? 1 : 0);
      const alongX = ew >= ns;
      out.push({
        x, z, secret: !!s, open: s ? !!s.open : k === KIND.DOOR_OPEN,
        seg: alongX ? [x, z + 0.5, x + 1, z + 0.5] : [x + 0.5, z, x + 0.5, z + 1]
      });
    }
  }
  return out;
}

/**
 * GM only: keeps Foundry walls on the map scene in step with the floor plan, so a token's vision
 * stops at real Minecraft walls. Walls are tagged per chunk and only the chunks that changed
 * (plus their neighbours, whose border edges depend on them) are rebuilt, at most once a second.
 *
 * Doors become Foundry doors: opening or closing one in Foundry opens or closes it in Minecraft,
 * and the other way round. A wall cell the GM marked (Ctrl+click in map mode) is a secret door:
 * a wall to the players, a door only the GM sees; opening it lifts the wall blocks out in
 * Minecraft and closing it puts them back. Secret doors live in the scene flag "secrets".
 */
export class WallSync {
  constructor(hub) {
    this.hub = hub;
    this.kinds = new Map();   // "dim:cx:cz" -> Uint8Array(256)
    this.heights = new Map(); // "dim:cx:cz" -> Int16Array(256)
    this.pending = new Map(); // "dim|x|z" -> {open, until}: a door just set from Foundry, until Minecraft shows it
    this.dirty = new Set();
    this.busy = null;
    hub.addEventListener("chunk", (ev) => this.onChunk(ev.detail));
    this.timer = setInterval(() => this.flush(), 1000);
    Hooks.on("updateWall", (wall, change, options) => this.onWallChange(wall, change, options));
    Hooks.on("updateScene", (scene, change) => {
      if (scene.id === canvas.scene?.id && foundry.utils.hasProperty(change, `flags.${MODULE_ID}`)
        && JSON.stringify(change.flags[MODULE_ID]).includes("secrets")) this.rebuildAll();
    });
  }

  get scene() { return canvas.scene; }
  get map() { return this.scene?.getFlag(MODULE_ID, "map") ?? null; }
  get enabled() { return !!this.map && (this.scene.getFlag(MODULE_ID, "view")?.walls ?? true); }
  get dim() { return this.map?.dim ?? "overworld"; }
  get secrets() { return this.scene?.getFlag(MODULE_ID, "secrets") ?? {}; }

  onChunk(c) {
    const kinds = decodeKinds(c.kinds);
    if (!kinds) return;
    const key = `${c.dim}:${c.cx}:${c.cz}`;
    const h = decodeKinds(c.heights);
    if (h) this.heights.set(key, new Int16Array(h.buffer, h.byteOffset, Math.floor(h.byteLength / 2)));
    const prev = this.kinds.get(key);
    this.kinds.set(key, kinds);
    if (prev && prev.every((v, i) => v === kinds[i])) return;
    for (const [dx, dz] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) this.dirty.add(`${c.dim}:${c.cx + dx}:${c.cz + dz}`);
  }

  cell(map, dim, x, z) {
    const k = map.get(`${dim}:${Math.floor(x / 16)}:${Math.floor(z / 16)}`);
    if (!k) return null;
    return k[(((z % 16) + 16) % 16) * 16 + (((x % 16) + 16) % 16)];
  }

  kindAt(dim, x, z) { return this.cell(this.kinds, dim, x, z) ?? KIND.SURFACE; }

  /** The plan's height at a cell: the cut height for a wall or door. */
  heightAt(dim, x, z) {
    const y = this.cell(this.heights, dim, x, z);
    return y === null || y === -32768 ? null : y;
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
    if (ids.length) await scene.deleteEmbeddedDocuments("Wall", ids, { bwbSync: true });
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
    const T = CONST.WALL_DOOR_TYPES ?? { NONE: 0, DOOR: 1, SECRET: 2 };
    const D = CONST.WALL_DOOR_STATES ?? { CLOSED: 0, OPEN: 1, LOCKED: 2 };
    const secrets = this.secrets;
    const now = Date.now();
    const toDelete = [];
    const toCreate = [];
    const toUpdate = [];
    const place = (x1, z1, x2, z2) => {
      const a = mcToScene({ x: x1, z: z1 }, map, dims); const b = mcToScene({ x: x2, z: z2 }, map, dims);
      return [a.x, a.y, b.x, b.y].map(Math.round);
    };
    for (const key of keys) {
      const [dim, cx, cz] = key.split(":");
      const existing = scene.walls.filter((w) => w.getFlag(MODULE_ID, "chunk") === key);
      const want = new Map();
      if (on && dim === this.dim) {
        const secretAt = (x, z) => secrets[secretKey(dim, x, z)] ?? null;
        const kindAt = (x, z) => this.kindAt(dim, x, z);
        for (const [x1, z1, x2, z2] of chunkWallSegments(Number(cx), Number(cz), kindAt, map, (x, z) => !!secretAt(x, z))) {
          const c = place(x1, z1, x2, z2);
          want.set(c.join(","), { c, door: T.NONE });
        }
        for (const d of chunkDoors(Number(cx), Number(cz), kindAt, map, secretAt)) {
          const c = place(...d.seg);
          const sk = secretKey(dim, d.x, d.z);
          const p = this.pending.get(sk);
          const open = p && p.until > now ? p.open : d.open;
          const y = d.secret ? secretAt(d.x, d.z).y : this.heightAt(dim, d.x, d.z);
          // A secret door the GM turned into a plain door in the wall settings (found) stays one.
          const type = d.secret ? (secretAt(d.x, d.z).found ? T.DOOR : T.SECRET) : T.DOOR;
          want.set(c.join(","), { c, door: type, open, cell: [dim, d.x, d.z, y] });
        }
      }
      for (const w of existing) {
        const id = w.c.map(Math.round).join(",");
        const wish = want.get(id);
        if (!wish) { toDelete.push(w.id); continue; }
        want.delete(id);
        if (wish.door === T.NONE && !w.door) continue;
        // A door Foundry locked stays locked while it is shut in Minecraft.
        const ds = wish.open ? D.OPEN : (w.ds === D.LOCKED ? D.LOCKED : D.CLOSED);
        if (w.door !== wish.door || w.ds !== ds || JSON.stringify(w.getFlag(MODULE_ID, "cell")) !== JSON.stringify(wish.cell ?? null)) {
          toUpdate.push({ _id: w.id, door: wish.door, ds, [`flags.${MODULE_ID}.cell`]: wish.cell ?? null });
        }
      }
      for (const wish of want.values()) {
        const doc = { c: wish.c, move: M.NORMAL, sight: S.NORMAL, light: S.NORMAL, sound: S.NORMAL, flags: { [MODULE_ID]: { chunk: key } } };
        if (wish.door !== T.NONE) {
          doc.door = wish.door;
          doc.ds = wish.open ? D.OPEN : D.CLOSED;
          doc.flags[MODULE_ID].cell = wish.cell;
        }
        toCreate.push(doc);
      }
    }
    if (toDelete.length) await scene.deleteEmbeddedDocuments("Wall", toDelete, { bwbSync: true });
    if (toUpdate.length) await scene.updateEmbeddedDocuments("Wall", toUpdate, { bwbSync: true });
    if (toCreate.length) await scene.createEmbeddedDocuments("Wall", toCreate, { bwbSync: true });
  }

  /** A door opened, closed or locked in Foundry (by anyone): do the same in Minecraft. */
  onWallChange(wall, change, options) {
    if (options?.bwbSync || !this.hub.isRelayHost || !this.hub.relay) return;
    const cell = wall.getFlag(MODULE_ID, "cell");
    if (!cell || wall.parent?.id !== this.scene?.id) return;
    const D = CONST.WALL_DOOR_STATES ?? { CLOSED: 0, OPEN: 1, LOCKED: 2 };
    const T = CONST.WALL_DOOR_TYPES ?? { NONE: 0, DOOR: 1, SECRET: 2 };
    const [dim, x, z, y] = cell;
    const sk = secretKey(dim, x, z);
    const secret = this.secrets[sk];
    if ("door" in change && secret) {
      // The GM changed the secret door's type in the wall settings: found (a door everyone sees) or hidden again.
      const found = change.door === T.DOOR;
      if (!!secret.found !== found) this.scene.setFlag(MODULE_ID, "secrets", { [sk]: { ...secret, found } }).catch(() => {});
    }
    if (!("ds" in change)) return;
    const open = change.ds === D.OPEN;
    this.pending.set(sk, { open, until: Date.now() + 5000 });
    const job = secret ? this.setSecret(sk, x, z, open) : this.hub.relay.call("door", { x, y, z, open });
    Promise.resolve(job).catch((err) => {
      this.pending.delete(sk);
      ui.notifications.warn(`${game.i18n.localize("BWB.Walls.DoorFailed")}: ${err.message ?? err}`);
      wall.update({ ds: open ? D.CLOSED : D.OPEN }, { bwbSync: true }).catch(() => {});
    });
  }

  async setSecret(sk, x, z, open) {
    const s = this.secrets[sk];
    if (!s || !!s.open === open) return;
    if (open) {
      const blocks = await this.hub.relay.call("secret", { x, y: s.y, z, open: true });
      await this.scene.setFlag(MODULE_ID, "secrets", { [sk]: { ...s, open: true, blocks } });
    } else {
      await this.hub.relay.call("secret", { x, y: s.y, z, open: false, blocks: s.blocks ?? [] });
      await this.scene.setFlag(MODULE_ID, "secrets", { [sk]: { ...s, open: false, blocks: [] } });
    }
  }

  /** GM: make the wall cell at x,z a secret door, or a plain wall again. */
  async toggleSecret(x, z) {
    const scene = this.scene;
    if (!scene || !this.map) return;
    const sk = secretKey(this.dim, x, z);
    const s = this.secrets[sk];
    if (s) {
      if (s.open) return ui.notifications.warn(game.i18n.localize("BWB.Walls.CloseFirst"));
      await scene.update({ [`flags.${MODULE_ID}.secrets.-=${sk}`]: null });
      return ui.notifications.info(game.i18n.localize("BWB.Walls.SecretOff"));
    }
    const y = this.heightAt(this.dim, x, z);
    if (this.kindAt(this.dim, x, z) !== KIND.WALL || y === null) {
      return ui.notifications.warn(game.i18n.localize("BWB.Walls.NotAWall"));
    }
    await scene.setFlag(MODULE_ID, "secrets", { [sk]: { x, z, y, open: false, blocks: [] } });
    ui.notifications.info(game.i18n.localize("BWB.Walls.SecretOn"));
  }
}
