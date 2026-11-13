// Stairs on the map scene (from the scenario builder's file): each flight drawn over its steps
// with an arrow up it, and a sign at each end for the floor one is on: "▲" at the bottom on the
// floor below, "▼" at the top on the floor above. Right-clicking a sign walks one's character up
// or down the flight (the relay walks it carefully, step by step).

import { MODULE_ID, L } from "../constants.js";
import { mcToScene } from "../coords.js";
import { viewOf } from "../map-view.js";
import { esc } from "./store.js";

/** How far (blocks) from an end's height one still counts as on that floor. */
const SAME_FLOOR = 2.5;
const UP = 0x3fa7ff;
const DOWN = 0xffb13f;

/** The flights in a builder file: [{from, to, dir, steps: [[x,y,z]...], bottom: [x,y,z], top: [x,y,z]}]. */
export function readStairs(data) {
  const ok3 = (p) => Array.isArray(p) && p.length === 3 && p.every((v) => Number.isFinite(Number(v)));
  const out = [];
  for (const s of Array.isArray(data?.stairs) ? data.stairs : []) {
    if (!s || !ok3(s.bottom) || !ok3(s.top) || !Array.isArray(s.steps) || !s.steps.every(ok3)) continue;
    out.push({
      from: Number(s.from ?? 0), to: Number(s.to ?? 1), dir: String(s.dir ?? "north"),
      steps: s.steps.map((p) => p.map(Number)), bottom: s.bottom.map(Number), top: s.top.map(Number)
    });
  }
  return out;
}

export class StairsLayer {
  constructor(system) {
    this.system = system;
    this.container = null;
    this.tip = null;
    this.shown = "";
    const redraw = foundry.utils.debounce(() => this.draw(), 50);
    Hooks.on("canvasReady", () => this.draw());
    Hooks.on("updateScene", (scene, change) => {
      if (scene.id === canvas.scene?.id && foundry.utils.hasProperty(change, `flags.${MODULE_ID}`)) redraw();
    });
    Hooks.on("canvasTearDown", () => { this.container = null; this.hideTip(); });
    // The signs follow one's floor: redraw when it changes.
    system.hub.addEventListener("state", foundry.utils.throttle(() => {
      if (this.signature() !== this.shown) this.draw();
    }, 300));
  }

  get scene() { return this.system.scene; }

  flights() { return this.scene?.getFlag(MODULE_ID, "stairs") ?? []; }

  /** The height of the floor one is looking at: one's character, else the fixed floor plan, else none (all). */
  viewY() {
    const me = this.system.hub.positions?.get(game.user.id);
    if (me && Number.isFinite(me.y)) return me.y;
    const v = viewOf(this.scene);
    return v.mode === "fixed" && Number.isFinite(v.y) ? v.y + 1 : null;
  }

  /** Which ends show now (to redraw only when that changes). */
  signature() {
    const y = this.viewY();
    return this.flights().map((f) => `${this.sameFloor(f.bottom[1], y) ? 1 : 0}${this.sameFloor(f.top[1], y) ? 1 : 0}`).join(",");
  }

  sameFloor(at, y) { return y === null || Math.abs(at - y) <= SAME_FLOOR; }

  draw() {
    this.clear();
    const scene = this.scene;
    const flights = this.flights();
    if (!scene || !flights.length || !canvas.ready) return;
    const map = scene.getFlag(MODULE_ID, "map");
    const dims = { grid: scene.grid.size, sceneX: canvas.dimensions.sceneX, sceneY: canvas.dimensions.sceneY };
    const at = (x, z) => mcToScene({ x: x + 0.5, z: z + 0.5 }, map, dims);
    const g = dims.grid;
    const y = this.viewY();
    const box = new PIXI.Container();
    box.eventMode = "passive";
    flights.forEach((f, i) => {
      const lower = this.sameFloor(f.bottom[1], y);
      const upper = this.sameFloor(f.top[1], y);
      if (!lower && !upper) return;
      // The steps: a band with an arrow up them.
      const band = new PIXI.Graphics();
      const a = at(f.steps[0][0], f.steps[0][2]);
      const b = at(f.steps[f.steps.length - 1][0], f.steps[f.steps.length - 1][2]);
      band.lineStyle(g * 0.7, lower ? UP : DOWN, 0.18).moveTo(a.x, a.y).lineTo(b.x, b.y);
      const ang = Math.atan2(b.y - a.y, b.x - a.x);
      const head = g * 0.35;
      band.lineStyle(g * 0.08, 0xffffff, 0.75).moveTo(a.x, a.y).lineTo(b.x, b.y)
        .moveTo(b.x - Math.cos(ang - 0.5) * head, b.y - Math.sin(ang - 0.5) * head).lineTo(b.x, b.y)
        .lineTo(b.x - Math.cos(ang + 0.5) * head, b.y - Math.sin(ang + 0.5) * head);
      box.addChild(band);
      if (lower) box.addChild(this.sign(f, i, "up", a, g));
      if (upper) box.addChild(this.sign(f, i, "down", b, g));
    });
    (canvas.interface ?? canvas.stage).addChild(box);
    this.container = box;
    this.shown = this.signature();
  }

  /** A round sign at one end of a flight: right-click to walk up (or down) it. */
  sign(f, i, way, p, g) {
    const s = new PIXI.Container();
    s.position.set(p.x, p.y);
    const disc = new PIXI.Graphics();
    disc.beginFill(way === "up" ? UP : DOWN, 0.9).lineStyle(g * 0.04, 0x000000, 0.6).drawCircle(0, 0, g * 0.3).endFill();
    s.addChild(disc);
    const t = new PIXI.Text(way === "up" ? "▲" : "▼", { fontSize: Math.round(g * 0.32), fill: 0xffffff, fontWeight: "bold" });
    t.anchor.set(0.5);
    s.addChild(t);
    s.eventMode = "static";
    s.cursor = "pointer";
    s.on("pointerover", (ev) => this.showTip(way, f, ev));
    s.on("pointermove", (ev) => this.moveTip(ev));
    s.on("pointerout", () => this.hideTip());
    s.on("rightdown", (ev) => { ev.stopPropagation(); this.hideTip(); this.walk(f, way); });
    s.stairsIndex = i;
    return s;
  }

  /** Walk one's own character to the top (or the bottom) of the flight. */
  walk(f, way) {
    const [x, y, z] = way === "up" ? f.top : f.bottom;
    this.system.hub.tryIntent({ type: "moveTo", key: game.user.id, x: x + 0.5, z: z + 0.5, y });
  }

  clear() {
    if (this.container && !this.container.destroyed) this.container.destroy({ children: true });
    this.container = null;
  }

  showTip(way, f, ev) {
    if (!this.tip) {
      this.tip = document.createElement("div");
      this.tip.className = "bwb-clue-tip";
      document.body.appendChild(this.tip);
    }
    const floor = way === "up" ? f.to : f.from;
    this.tip.innerHTML = `<b>${esc(L(way === "up" ? "Stairs.Up" : "Stairs.Down"))}</b><div>${esc(L("Stairs.Hint", { floor: L("Stairs.Floor", { n: floor < 0 ? `B${-floor}` : floor + 1 }) }))}</div>`;
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
