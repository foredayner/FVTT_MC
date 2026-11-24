// Journal pins on the map scene: a journal one has (a clue from the hotbar, or a journal from the
// sidebar) dragged onto the map is pinned there for everyone to see and open. Only the one who
// pinned it and the GM can take it away (right-click) or make it bigger or smaller (Ctrl+wheel,
// the same size for everyone). Pins are kept on the scene in Minecraft block coordinates
// (flags.<module>.pins), so they stay put when the map is redrawn.

import { MODULE_ID, L } from "../constants.js";
import { mcToScene } from "../coords.js";
import { esc } from "./store.js";
import { addToOverlay, Z } from "./sight.js";

const COLOR = 0xe8d9a8;
export const PIN_MIN = 0.5;
export const PIN_MAX = 4;

export class PinLayer {
  constructor(system) {
    this.system = system;
    this.container = null;
    this.tip = null;
    const redraw = foundry.utils.debounce(() => this.draw(), 50);
    Hooks.on("canvasReady", () => this.draw());
    Hooks.on("updateScene", (scene, change) => {
      if (scene.id === canvas.scene?.id && foundry.utils.hasProperty(change, `flags.${MODULE_ID}`)) redraw();
    });
    Hooks.on("canvasTearDown", () => { this.container = null; this.hover = null; this.hideTip(); });
    // Ctrl+wheel over one's pin: bigger or smaller (before Foundry zooms the map).
    window.addEventListener("wheel", (ev) => this.onWheel(ev), { capture: true, passive: false });
  }

  onWheel(ev) {
    const h = this.hover;
    if (!ev.ctrlKey || !h || !this.mayRemove(h.pin) || !h.sprite || h.sprite.destroyed) return;
    ev.preventDefault();
    ev.stopImmediatePropagation();
    const cur = h.scale ?? (Number(h.pin.scale) || 1);
    const next = Math.max(PIN_MIN, Math.min(PIN_MAX, Math.round(cur * (ev.deltaY < 0 ? 1.15 : 1 / 1.15) * 100) / 100));
    h.scale = next;
    h.sprite.scale.set(next); // at once here; for everyone a moment later
    clearTimeout(this.sizeTimer);
    this.sizeTimer = setTimeout(() => this.system.requestPinSize(h.pin.id, next), 300);
  }

  pins(scene = this.system.scene) { return scene?.getFlag(MODULE_ID, "pins") ?? {}; }

  draw() {
    this.clear();
    const scene = this.system.scene;
    if (!scene || !canvas.ready) return;
    const pins = Object.values(this.pins(scene));
    if (!pins.length) return;
    const map = scene.getFlag(MODULE_ID, "map");
    const dims = { grid: scene.grid.size, sceneX: canvas.dimensions.sceneX, sceneY: canvas.dimensions.sceneY };
    const g = dims.grid;
    const box = new PIXI.Container();
    box.eventMode = "passive";
    for (const p of pins) {
      const at = mcToScene({ x: p.x + 0.5, z: p.z + 0.5 }, map, dims);
      const s = new PIXI.Container();
      s.position.set(at.x, at.y);
      s.scale.set(Math.max(PIN_MIN, Math.min(PIN_MAX, Number(p.scale) || 1)));
      const paper = new PIXI.Graphics();
      paper.beginFill(COLOR, 0.95).lineStyle(g * 0.04, 0x5a4a2a, 0.9)
        .drawRoundedRect(-g * 0.28, -g * 0.34, g * 0.56, g * 0.68, g * 0.06).endFill();
      paper.lineStyle(g * 0.03, 0x5a4a2a, 0.7);
      for (const y of [-0.16, -0.02, 0.12]) paper.moveTo(-g * 0.17, g * y).lineTo(g * 0.17, g * y);
      paper.beginFill(0xc0392b).lineStyle(0).drawCircle(0, -g * 0.34, g * 0.08).endFill();
      s.addChild(paper);
      s.eventMode = "static";
      s.cursor = "pointer";
      s.on("pointerover", (ev) => { this.hover = { pin: p, sprite: s }; this.showTip(p, ev); });
      s.on("pointermove", (ev) => this.moveTip(ev));
      s.on("pointerout", () => { if (this.hover?.sprite === s) this.hover = null; this.hideTip(); });
      s.on("pointerdown", (ev) => {
        const button = ev.button ?? ev.data?.button ?? 0;
        if (button !== 0 && button !== 2) return;
        ev.stopPropagation();
        this.hideTip();
        if (button === 0) this.open(p);
        else if (this.mayRemove(p)) this.system.requestUnpin(p.id);
      });
      box.addChild(s);
    }
    addToOverlay(box, Z.pins);
    this.container = box;
  }

  mayRemove(p) { return game.user.isGM || p.by === game.user.id; }

  async open(p) {
    const doc = await fromUuid(p.uuid).catch(() => null);
    if (!doc) { ui.notifications.warn(L("Pin.Gone")); return; }
    if (!doc.testUserPermission(game.user, "OBSERVER")) { ui.notifications.info(L("Clue.CannotRead")); return; }
    doc.sheet.render(true);
  }

  clear() {
    if (this.container && !this.container.destroyed) this.container.destroy({ children: true });
    this.container = null;
  }

  showTip(p, ev) {
    if (!this.tip) {
      this.tip = document.createElement("div");
      this.tip.className = "bwb-clue-tip";
      document.body.appendChild(this.tip);
    }
    const hint = this.mayRemove(p) ? L("Pin.HintMine") : L("Pin.Hint");
    this.tip.innerHTML = `<b>${esc(p.name)}</b><div>${esc(L("Pin.By", { who: p.byName ?? "" }))}</div><div>${esc(hint)}</div>`;
    this.tip.style.display = "block";
    this.moveTip(ev);
  }

  moveTip(ev) {
    if (!this.tip) return;
    const x = ev.clientX ?? ev.data?.originalEvent?.clientX ?? 0;
    const y = ev.clientY ?? ev.data?.originalEvent?.clientY ?? 0;
    this.tip.style.left = `${x + 14}px`;
    this.tip.style.top = `${y + 14}px`;
  }

  hideTip() { if (this.tip) this.tip.style.display = "none"; }
}
