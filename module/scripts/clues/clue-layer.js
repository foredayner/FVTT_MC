// Clues drawn on the map scene (the GM drags one to move it): an icon on each clue a player has
// seen, every clue for the GM (hidden ones faint until spotted). Only the clues of the floor one
// is on, and for a player only while in sight of their character (its vision circle).
// Hovering shows what is there at a glance (and, for the GM, what more there is); right-clicking
// looks at it.

import { MODULE_ID, L } from "../constants.js";
import { mcToScene, sceneToMc } from "../coords.js";
import { visibleTo, esc } from "./store.js";
import { viewY, onFloor } from "./stairs-layer.js";
import { inSight, onSightChange, addToOverlay, Z } from "./sight.js";

export const DEFAULT_ICON = `modules/${MODULE_ID}/assets/clue.svg`;

export class ClueLayer {
  constructor(system) {
    this.system = system;
    this.container = null;
    this.tip = null;
    const redraw = foundry.utils.debounce(() => this.draw(), 50);
    Hooks.on("canvasReady", () => this.draw());
    Hooks.on("updateScene", (scene, change) => {
      if (scene.id === canvas.scene?.id && foundry.utils.hasProperty(change, `flags.${MODULE_ID}`)) redraw();
    });
    Hooks.on("canvasTearDown", () => { this.container = null; this.hideTip(); });
    // Another floor: other clues. In or out of sight: drawn, faint or not at all.
    system.hub.addEventListener("state", foundry.utils.throttle(() => {
      if (this.floorKey() !== this.shownFloor) this.draw();
    }, 300));
    onSightChange(() => this.refreshSight());
  }

  floorKey() {
    const vy = viewY(this.system);
    return vy === null ? "all" : String(Math.floor((vy + 2.5) / 5));
  }

  /** Player: a clue shows only while it is in sight of one's character (its vision circle). */
  refreshSight() {
    const box = this.container;
    const scene = this.system.scene;
    if (!box || box.destroyed || !scene || game.user.isGM) return;
    const tol = scene.grid.size * 0.35;
    for (const sprite of box.children) {
      if (!sprite.clueId) continue;
      sprite.visible = inSight([{ x: sprite.x, y: sprite.y }], tol);
    }
  }

  async draw() {
    const gen = this.gen = (this.gen ?? 0) + 1;
    const scene = this.system.scene;
    if (!scene) { this.clear(); return; }
    // Load the icons first: sized before its picture loads, a sprite would end up huge.
    const load = foundry.canvas?.loadTexture ?? globalThis.loadTexture;
    const icons = new Map();
    for (const c of Object.values(this.system.placed(scene))) {
      const src = c.icon || DEFAULT_ICON;
      if (!icons.has(src)) icons.set(src, await load(src).catch(() => null) ?? await load(DEFAULT_ICON).catch(() => null));
    }
    if (gen !== this.gen || this.system.scene !== scene) return; // a newer draw started
    this.clear();
    const map = scene.getFlag(MODULE_ID, "map");
    const dims = { grid: scene.grid.size, sceneX: canvas.dimensions.sceneX, sceneY: canvas.dimensions.sceneY };
    const box = new PIXI.Container();
    box.eventMode = "passive";
    box.sortableChildren = true;
    const isGM = game.user.isGM;
    const vy = viewY(this.system);
    this.shownFloor = this.floorKey();
    for (const c of Object.values(this.system.placed(scene))) {
      if (!visibleTo(c, game.user.id, isGM) || (c.dim ?? "overworld") !== (map.dim ?? "overworld")) continue;
      if (!onFloor(c.y, vy)) continue; // another floor's
      const at = mcToScene({ x: c.x + 0.5, z: c.z + 0.5 }, map, dims);
      const tex = icons.get(c.icon || DEFAULT_ICON);
      if (!tex) continue;
      const sprite = new PIXI.Sprite(tex);
      sprite.anchor.set(0.5);
      sprite.width = sprite.height = dims.grid * 0.75;
      sprite.position.set(at.x, at.y);
      const notYet = isGM && (!c.revealed || !Object.keys(c.seen ?? {}).length);
      sprite.alpha = notYet ? 0.45 : 1;
      if (isGM && !c.revealed) sprite.tint = 0xff8080;
      sprite.eventMode = "static";
      sprite.cursor = "pointer";
      sprite.on("pointerover", (ev) => this.showTip(c, ev));
      sprite.on("pointermove", (ev) => this.moveTip(ev));
      sprite.on("pointerout", () => this.hideTip());
      sprite.on("rightdown", (ev) => { ev.stopPropagation(); this.hideTip(); this.system.request("use", c.id); });
      if (isGM) this.draggable(sprite, c, box, map, dims);
      sprite.clueId = c.id;
      box.addChild(sprite);
    }
    addToOverlay(box, Z.clues);
    this.container = box;
    this.refreshSight();
  }

  /** GM: drag a clue's icon to another block to move the clue there (in Minecraft too). */
  draggable(sprite, c, box, map, dims) {
    let drag = null;
    sprite.on("pointerdown", (ev) => {
      if ((ev.button ?? 0) !== 0) return;
      ev.stopPropagation(); // not a walk to the spot, nor a selection box
      this.hideTip();
      drag = { from: { x: sprite.x, y: sprite.y }, moved: false };
    });
    sprite.on("globalpointermove", (ev) => {
      if (!drag) return;
      const p = ev.getLocalPosition(box);
      if (!drag.moved && Math.hypot(p.x - drag.from.x, p.y - drag.from.y) < dims.grid * 0.3) return;
      drag.moved = true;
      sprite.position.set(p.x, p.y);
      sprite.zIndex = 10;
    });
    const drop = (ev) => {
      if (!drag) return;
      const d = drag; drag = null;
      if (!d.moved) return;
      const p = ev.getLocalPosition(box);
      const mc = sceneToMc({ x: p.x, y: p.y }, map, dims);
      const x = Math.floor(mc.x); const z = Math.floor(mc.z);
      if (x === c.x && z === c.z) { sprite.position.set(d.from.x, d.from.y); return; }
      this.system.moveClue(c.id, x, z).catch((err) => {
        sprite.position.set(d.from.x, d.from.y);
        ui.notifications.warn(err.message);
      });
    };
    sprite.on("pointerup", drop);
    sprite.on("pointerupoutside", drop);
  }

  clear() {
    if (this.container && !this.container.destroyed) this.container.destroy({ children: true });
    this.container = null;
  }

  /** A short flash where a clue was just noticed. */
  ping(id) {
    const s = this.container?.children.find((ch) => ch.clueId === id);
    if (s) canvas.ping?.({ x: s.x, y: s.y });
  }

  tipHtml(c) {
    const lines = [`<b>${esc(c.name)}</b>`];
    if (c.surface) lines.push(`<div>${esc(c.surface).replace(/\n/g, "<br>")}</div>`);
    if (c.takenBy) lines.push(`<div class="bwb-tip-note">${esc(L("Clue.Taken", { who: c.takerName }))}</div>`);
    if (game.user.isGM) {
      const kind = L(`Clue.Kind.${c.kind}`);
      const fails = Object.entries(c.spotted ?? {}).filter(([, v]) => v === "fail").map(([u]) => this.system.userName(u));
      lines.push(`<div class="bwb-tip-gm">${esc(kind)}${c.revealed ? "" : ` · ${esc(L("Clue.NotRevealed"))}`}`
        + (fails.length ? `<br>${esc(L("Clue.SpotFailed", { who: fails.join(", ") }))}` : "") + `</div>`);
      const more = this.system.gmPages?.get(c.uuid);
      if (more?.length) lines.push(`<div class="bwb-tip-gm">${more.map((p) => esc(p)).join("<br>")}</div>`);
      lines.push(`<div class="bwb-tip-note">${esc(L("Clue.DragHint"))}</div>`);
    }
    return lines.join("");
  }

  showTip(c, ev) {
    if (!this.tip) {
      this.tip = document.createElement("div");
      this.tip.className = "bwb-clue-tip";
      document.body.appendChild(this.tip);
    }
    this.tip.innerHTML = this.tipHtml(c);
    this.tip.style.display = "block";
    this.moveTip(ev);
    if (game.user.isGM) this.system.loadGmPages(c).then(() => { if (this.tip?.style.display === "block") this.tip.innerHTML = this.tipHtml(c); });
  }

  moveTip(ev) {
    if (!this.tip) return;
    const x = ev.clientX ?? ev.data?.originalEvent?.clientX ?? 0;
    const y = ev.clientY ?? ev.data?.originalEvent?.clientY ?? 0;
    this.tip.style.left = `${x + 14}px`;
    this.tip.style.top = `${y + 14}px`;
  }

  hideTip() {
    if (this.tip) this.tip.style.display = "none";
  }
}
