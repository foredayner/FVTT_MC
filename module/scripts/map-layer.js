import { MODULE_ID, ENTITY_COLORS } from "./constants.js";
import { chunkToRGBA, inMap } from "./coords.js";

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
  }

  isMapTile(tile) { return !!tile?.document?.getFlag(MODULE_ID, "mapTile"); }

  applyTo(tile) {
    if (!this.texture || !this.isMapTile(tile) || !tile.mesh) return;
    const mesh = tile.mesh;
    if (mesh.texture !== this.texture) mesh.texture = this.texture;
    // The mesh was scaled for the 1x1 placeholder image. Re-fit it to the tile, or a 128px map
    // gets stretched 128 times and only one or two blocks fill the whole scene.
    const { width, height } = tile.document;
    if (typeof mesh.resize === "function") mesh.resize(width, height, { fit: "fill" });
    else { mesh.width = width; mesh.height = height; }
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

  /** Terrain + entity dots -> the texture the tile shows. */
  compose() {
    this.dirty = false;
    if (!this.map || !this.view) return;
    const ctx = this.view.getContext("2d");
    ctx.drawImage(this.base, 0, 0);
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
