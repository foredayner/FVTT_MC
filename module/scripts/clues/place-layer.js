// Place names on the map scene: each place the scenario builder built (from its file) named in
// the middle of its lot; the bigger the place, the bigger the name. Only the places of the floor
// one is on (a cellar's name when looking underground).
// A name is hidden from players until some character has had part of the place in sight; then it
// shows for everyone (kept on the scene; a fog reset hides them all again). While the name's spot
// is in one's own sight it is hidden (the place itself is there to see). The GM sees every name,
// the ones not found yet faint.

import { MODULE_ID } from "../constants.js";
import { mcToScene } from "../coords.js";
import { viewY, onFloor } from "./stairs-layer.js";
import { inSight, onSightChange, addToOverlay, Z } from "./sight.js";

const FAINT = 0.45;

/** The places in a builder file: [{id, name, x1, z1, x2, z2, y, outdoor}] (world blocks). */
export function readPlaces(data) {
  const out = [];
  for (const p of Array.isArray(data?.places) ? data.places : []) {
    const n = (k) => Number(p?.[k]);
    if (!p || typeof p.name !== "string" || !p.name.trim() || !["x1", "z1", "x2", "z2", "y"].every((k) => Number.isFinite(n(k)))) continue;
    out.push({
      id: String(p.id ?? p.name).slice(0, 80), name: p.name.trim().slice(0, 60),
      x1: Math.min(n("x1"), n("x2")), z1: Math.min(n("z1"), n("z2")), x2: Math.max(n("x1"), n("x2")), z2: Math.max(n("z1"), n("z2")),
      y: n("y"), outdoor: !!p.outdoor
    });
  }
  return out;
}

/**
 * Font size (pixels) for a place's name: grows with the smaller side of the lot, within limits,
 * and shrinks again if the name would be wider than the lot.
 * @param {number} wBlocks @param {number} dBlocks lot size  @param {number} grid pixels per block
 */
export function labelSize(wBlocks, dBlocks, grid) {
  const side = Math.min(wBlocks, dBlocks);
  return Math.max(grid * 0.7, Math.min(grid * 3, side * grid * 0.22));
}

/**
 * Points (scene pixels) over a place's area to test for sight: every block's middle, or a coarser
 * grid over a big place (at most about 400 points).
 */
export function areaPoints(p, map, dims) {
  const w = p.x2 - p.x1 + 1; const d = p.z2 - p.z1 + 1;
  const step = Math.max(1, Math.ceil(Math.sqrt((w * d) / 400)));
  const out = [];
  for (let x = p.x1; x <= p.x2; x += step) {
    for (let z = p.z1; z <= p.z2; z += step) out.push(mcToScene({ x: x + 0.5, z: z + 0.5 }, map, dims));
  }
  return out;
}

export class PlaceLayer {
  constructor(system) {
    this.system = system;
    this.container = null;
    this.shownFloor = null;
    const redraw = foundry.utils.debounce(() => this.draw(), 50);
    Hooks.on("canvasReady", () => this.draw());
    Hooks.on("updateScene", (scene, change) => {
      if (scene.id === canvas.scene?.id && foundry.utils.hasProperty(change, `flags.${MODULE_ID}`)) redraw();
    });
    Hooks.on("canvasTearDown", () => { this.container = null; });
    system.hub.addEventListener("state", foundry.utils.throttle(() => {
      if (this.floorKey() !== this.shownFloor) this.draw();
    }, 300));
    onSightChange(() => this.refreshSight(), 250);
    // A fog reset (GM): every place unfound again; and the names drawn again either way.
    Hooks.on(`${MODULE_ID}.fogReset`, () => {
      if (game.user.isGM && this.system.scene) this.system.scene.unsetFlag(MODULE_ID, "placesSeen").catch(() => {});
      this.draw();
    });
  }

  seen(scene = this.system.scene) { return scene?.getFlag(MODULE_ID, "placesSeen") ?? {}; }

  /**
   * Player: a place not found yet whose area is partly in sight is found (for everyone); a name
   * whose spot is in sight is hidden while it is.
   */
  refreshSight() {
    const box = this.container;
    const scene = this.system.scene;
    if (!box || box.destroyed || !scene) return;
    const seen = this.seen(scene);
    const tol = scene.grid.size * 0.4;
    for (const t of box.children) {
      if (!t.place) continue;
      const found = !!seen[t.place.id];
      if (game.user.isGM) { t.visible = true; t.alpha = found ? 0.9 : FAINT; continue; }
      if (!found && !this.asked?.has(t.place.id) && inSight(t.cells, tol)) {
        (this.asked ??= new Set()).add(t.place.id);
        this.system.requestPlaceSeen(t.place.id);
      }
      t.visible = found && !inSight([{ x: t.x, y: t.y }], tol);
    }
  }

  floorKey() {
    const vy = viewY(this.system);
    return vy === null ? "all" : String(Math.floor((vy + 2.5) / 5));
  }

  draw() {
    this.clear();
    this.asked = new Set();
    const scene = this.system.scene;
    if (!scene || !canvas.ready) return;
    const places = scene.getFlag(MODULE_ID, "places") ?? [];
    this.shownFloor = this.floorKey();
    if (!places.length) return;
    const map = scene.getFlag(MODULE_ID, "map");
    const dims = { grid: scene.grid.size, sceneX: canvas.dimensions.sceneX, sceneY: canvas.dimensions.sceneY };
    const g = dims.grid;
    const vy = viewY(this.system);
    const box = new PIXI.Container();
    box.eventMode = "none";
    for (const p of places) {
      if (!onFloor(p.y, vy)) continue;
      const w = p.x2 - p.x1 + 1; const d = p.z2 - p.z1 + 1;
      const at = mcToScene({ x: (p.x1 + p.x2 + 1) / 2, z: (p.z1 + p.z2 + 1) / 2 }, map, dims);
      const size = labelSize(w, d, g);
      const text = new PIXI.Text(p.name, {
        fontFamily: "Signika, sans-serif", fontSize: Math.round(size), fontWeight: "bold", fill: 0xffffff,
        stroke: 0x111111, strokeThickness: Math.max(2, Math.round(size * 0.14)), align: "center",
        wordWrap: true, wordWrapWidth: Math.max(g * 2, w * g * 0.9), breakWords: true
      });
      text.anchor.set(0.5);
      // Never wider or taller than the lot.
      const fit = Math.min(1, (w * g * 0.95) / Math.max(1, text.width), (d * g * 0.95) / Math.max(1, text.height));
      if (fit < 1) text.scale.set(Math.max(0.35, fit));
      text.position.set(at.x, at.y);
      text.alpha = 0.9;
      text.place = p;
      text.cells = areaPoints(p, map, dims);
      box.addChild(text);
    }
    addToOverlay(box, Z.places); // under the stairs, clues and pins
    this.container = box;
    this.refreshSight();
  }

  clear() {
    if (this.container && !this.container.destroyed) this.container.destroy({ children: true });
    this.container = null;
  }
}
