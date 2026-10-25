import { MODULE_ID, ENTITY_COLORS, L } from "./constants.js";
import { chunkToRGBA, inMap, mapTileRect, tileMisplaced, paddingAction } from "./coords.js";
import { displayCells } from "./displays.js";
import { alignToRect } from "./align.js";
import { viewOf } from "./map-view.js";

/**
 * Paints the top-down map into an off-screen canvas and shows it through a flagged Tile.
 * No database writes per update: every client swaps the tile's texture locally, so
 * terrain and mob dots update at relay rate without touching the server.
 */
export class MapLayer {
  constructor(hub) {
    this.hub = hub;
    this.map = null;       // {originX, originZ, size, dim}
    this.base = null;      // terrain canvas (1 px = 1 block)
    this.view = null;      // terrain + entity dots
    this.texture = null;
    this.dirty = false;

    hub.addEventListener("chunk", (ev) => this.paintChunk(ev.detail));
    hub.addEventListener("disp", () => this.markDirty());
    hub.addEventListener("state", () => this.markDirty());
    Hooks.on("canvasReady", () => this.bindScene());
    Hooks.on("updateScene", (scene, change) => {
      if (scene.id === canvas.scene?.id && foundry.utils.hasProperty(change, `flags.${MODULE_ID}`)) this.bindScene();
    });
    // Re-apply our texture whenever Foundry (re)draws the map tile.
    for (const hook of ["drawTile", "refreshTile"]) Hooks.on(hook, (tile) => this.applyTo(tile));
  }

  /** Read the current scene's map settings and rebuild the canvases. */
  bindScene() {
    const cfg = canvas.scene?.getFlag(MODULE_ID, "map");
    if (!cfg) { this.map = null; return; }
    const sizeChanged = !this.map || this.map.size !== cfg.size;
    this.map = { dim: "overworld", ...cfg };
    if (sizeChanged || !this.base) {
      this.base = Object.assign(document.createElement("canvas"), { width: cfg.size, height: cfg.size });
      this.view = Object.assign(document.createElement("canvas"), { width: cfg.size, height: cfg.size });
      this.texture?.destroy?.(true);
      this.texture = PIXI.Texture.from(this.view);
      setNearest(this.texture);
    }
    const ctx = this.base.getContext("2d");
    ctx.fillStyle = "#7a7a7a"; // never-seen ground starts grey
    ctx.fillRect(0, 0, cfg.size, cfg.size);
    for (const c of this.hub.chunks.values()) this.paintChunk(c, false);
    this.markDirty();
    for (const tile of canvas.tiles?.placeables ?? []) this.applyTo(tile);
    this.repairTile(cfg);
  }

  /**
   * GM: map tiles made by older versions sit at canvas (0,0); on a scene with padding that shifts
   * the whole picture away from the tokens. Move such a tile onto the scene rectangle.
   */
  repairTile(cfg) {
    if (!game.user.isGM || game.users.activeGM?.id !== game.user.id) return;
    if (this.removePadding()) return; // the scene redraws; the tile is checked again then
    const doc = canvas.scene?.tiles.find((t) => t.getFlag(MODULE_ID, "mapTile"));
    if (!doc) return;
    const d = canvas.dimensions;
    const rect = mapTileRect(cfg, { grid: canvas.scene.grid.size, sceneX: d.sceneX, sceneY: d.sceneY });
    if (!tileMisplaced(doc, rect)) return;
    doc.update(rect).catch((err) => console.warn(`${MODULE_ID} | map tile`, err));
  }

  /**
   * GM: a map scene is exactly the map, with no grey padding around it. Returns true when it asked
   * Foundry to remove the padding. If the scene still starts away from the canvas corner with
   * padding 0, say so once with the numbers instead of retrying.
   */
  removePadding() {
    const scene = canvas.scene;
    const d = canvas.dimensions;
    let action = paddingAction(scene?.padding, d);
    this.paddingTried ??= new Set();
    if (action === "update" && this.paddingTried.has(scene.id)) action = "report"; // tried once already: never loop
    if (action === "update") {
      this.paddingTried.add(scene.id);
      scene.update({ padding: 0 }).catch((err) => console.warn(`${MODULE_ID} | scene padding`, err));
      return true;
    }
    if (action === "report" && this.reportedScene !== scene.id) {
      this.reportedScene = scene.id;
      console.warn(`${MODULE_ID} | map scene starts at`, { sceneX: d.sceneX, sceneY: d.sceneY, padding: scene.padding });
      ui.notifications.warn(L("Notify.PaddingStuck", { x: d.sceneX, y: d.sceneY }));
    }
    return false;
  }

  isMapTile(tile) { return !!tile?.document?.getFlag(MODULE_ID, "mapTile"); }

  applyTo(tile) {
    if (!this.texture || !this.isMapTile(tile) || !tile.mesh) return;
    const mesh = tile.mesh;
    if (mesh.texture !== this.texture) mesh.texture = this.texture;
    // The mesh was scaled for the 1x1 placeholder image. Re-fit it to the tile, or a 128px map
    // gets stretched 128 times and only one or two blocks fill the whole scene.
    const { x, y, width, height } = tile.document;
    if (typeof mesh.resize === "function") mesh.resize(width, height, { fit: "fill" });
    else { mesh.width = width; mesh.height = height; }
    // Then make sure the picture really covers the tile: its anchor/parent may differ from what the
    // resize assumed (on V14 the picture's centre ended up on the tile's top-left corner).
    alignToRect(mesh, { x, y, width, height }, canvas.stage);
  }

  paintChunk(c, redraw = true) {
    if (!this.map || c.dim !== this.map.dim) return;
    const x0 = c.cx * 16 - this.map.originX;
    const z0 = c.cz * 16 - this.map.originZ;
    if (x0 >= this.map.size || z0 >= this.map.size || x0 <= -16 || z0 <= -16) return;
    const img = new ImageData(chunkToRGBA(c.rgb), 16, 16);
    this.base.getContext("2d").putImageData(img, x0, z0); // putImageData clips to the canvas
    if (redraw) this.markDirty();
  }

  markDirty() {
    if (!this.map || this.dirty) return;
    this.dirty = true;
    requestAnimationFrame(() => this.compose());
  }

  /** Terrain + block-display objects + entity dots -> the texture the tile shows. */
  compose() {
    this.dirty = false;
    if (!this.map || !this.view) return;
    const ctx = this.view.getContext("2d");
    ctx.drawImage(this.base, 0, 0);
    // Objects made of block displays, coloured like blocks (above the cut in a fixed floor plan: hidden).
    const v = viewOf(canvas.scene);
    const maxY = v.mode === "fixed" && Number.isInteger(v.y) ? v.y + 3 : Infinity;
    for (const cell of displayCells(this.hub.displays.values(), this.map, { maxY }).values()) {
      ctx.fillStyle = `rgb(${cell.c[0]},${cell.c[1]},${cell.c[2]})`;
      ctx.fillRect(cell.x, cell.z, 1, 1);
    }
    for (const e of this.hub.entities) {
      const x = Math.floor(e.x); const z = Math.floor(e.z);
      if (!inMap(x, z, this.map)) continue;
      const [r, g, b] = ENTITY_COLORS[e.kind] ?? [255, 255, 255];
      ctx.fillStyle = `rgb(${r},${g},${b})`;
      ctx.fillRect(x - this.map.originX, z - this.map.originZ, 1, 1);
    }
    updateTexture(this.texture);
  }
}

// PIXI 7 (BaseTexture) and PIXI 8 (TextureSource) name these differently; support both.
function setNearest(tex) {
  if (tex.baseTexture) tex.baseTexture.scaleMode = PIXI.SCALE_MODES?.NEAREST ?? 0;
  else if (tex.source) tex.source.scaleMode = "nearest";
}
function updateTexture(tex) {
  if (!tex) return;
  if (tex.baseTexture?.update) tex.baseTexture.update();
  else tex.source?.update?.();
}
