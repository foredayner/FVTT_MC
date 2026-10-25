import { MODULE_ID, L } from "../constants.js";
import { assetUrls, assetsReady } from "../assets.js";
import { avatarFor } from "../avatar.js";

/** Foundry file paths are relative to the server root; the renderer needs a full URL. */
const absUrl = (path) => { try { return path ? new URL(path, document.baseURI).href : ""; } catch { return ""; } };

const { ApplicationV2 } = foundry.applications.api;

const KEYS = {
  KeyW: "forward", KeyS: "back", KeyA: "left", KeyD: "right",
  Space: "jump", ShiftLeft: "sneak", ControlLeft: "sprint"
};
const LOOK_HZ = 15;
let scriptPromise = null;

/** Load the bundled renderer once, the first time anyone opens a 3D window. */
function loadRenderer() {
  scriptPromise ??= new Promise((resolve, reject) => {
    if (globalThis.BWB3D) return resolve(globalThis.BWB3D);
    const s = document.createElement("script");
    s.src = `modules/${MODULE_ID}/vendor/bwb3d.js`;
    s.onload = () => resolve(globalThis.BWB3D);
    s.onerror = () => { scriptPromise = null; reject(new Error("bwb3d.js failed to load")); };
    document.head.append(s);
  });
  return scriptPromise;
}

/**
 * First-person window. The player's own browser draws the world (three.js, bundled in
 * vendor/bwb3d.js); chunk data arrives over the Foundry socket like the map does, so nothing
 * but Foundry has to be reachable. An overlay captures mouse and keys and sends them to the bot.
 *
 * Keys go through a hidden <input> that holds focus, so Foundry's own keybindings (WASD pans the
 * canvas) stay quiet while you play.
 */
export class View3D extends ApplicationV2 {
  constructor(bridge, options = {}) {
    super(options);
    this.bridge = bridge;
    this.held = new Set();
    this.yaw = null;
    this.pitch = null;
    this.lookTimer = null;
    this.lookDirty = false;
    this.r3d = null;
    this.listeners = [];
  }

  static DEFAULT_OPTIONS = {
    id: "bwb-view3d",
    classes: ["bwb", "bwb-view3d"],
    tag: "section",
    window: { title: "BWB.View3D.Title", icon: "fa-solid fa-vr-cardboard", resizable: true },
    position: { width: 720, height: 480 }
  };

  get key() { return game.user.id; }
  get hub() { return this.bridge.hub; }
  get version() { return this.hub.status.info?.viewer?.version ?? null; }

  async _renderHTML() {
    if (!this.hub.can3d(this.key)) return `<p class="bwb-hint">${L("View3D.NoViewer")}</p>`;
    if (!assetsReady(this.version)) return `<p class="bwb-hint">${L("View3D.Preparing")}</p>`;
    return `
      <div class="bwb-stage">
        <canvas class="bwb-canvas"></canvas>
        <div class="bwb-loading">${L("View3D.Loading")}</div>
        <div class="bwb-overlay" title="${L("View3D.ClickToControl")}">
          <input class="bwb-keysink" aria-label="controls" autocomplete="off">
          <div class="bwb-crosshair">+</div>
          <div class="bwb-help">${L("View3D.Help")}</div>
        </div>
      </div>`;
  }

  _replaceHTML(result, content) {
    this.teardown();
    content.innerHTML = result;
  }

  async _onRender() {
    const stage = this.element.querySelector(".bwb-stage");
    if (!stage) {
      // Waiting for the GM to finish uploading the 3D files: re-render when they are ready.
      this._settingHook ??= Hooks.on("updateSetting", (s) => {
        if (s.key === `${MODULE_ID}.assetsVersion` && this.rendered) this.render();
      });
      return;
    }
    this.bindInput(stage);
    try {
      const BWB3D = await loadRenderer();
      const canvas = stage.querySelector(".bwb-canvas");
      this.r3d = new BWB3D.Renderer3D(canvas, { ...assetUrls(this.version), version: this.version, workers: 2 });
      this.r3d.onReady = () => stage.querySelector(".bwb-loading")?.remove();
      this.resizer = new ResizeObserver(() => this.r3d?.resize(stage.clientWidth, stage.clientHeight));
      this.resizer.observe(stage);
      this.r3d.resize(stage.clientWidth, stage.clientHeight);
      this.attachWorld(BWB3D);
    } catch (err) {
      console.error(`${MODULE_ID} | 3D`, err);
      stage.querySelector(".bwb-loading").textContent = L("View3D.Failed", { error: err.message });
    }
  }

  /** Feed the renderer: cached columns first (GM), then live messages; follow my bot. */
  attachWorld(BWB3D) {
    const hub = this.hub;
    const myDim = () => hub.positions.get(this.key)?.dim ?? "overworld";
    const queue = [];
    let busy = false;
    const pump = async () => {
      if (busy) return;
      busy = true;
      while (queue.length && this.r3d) {
        const m = queue.shift();
        try {
          if (m.dim !== myDim()) continue;
          if (m.type === "col3d") this.r3d.addColumn(m.x, m.z, m.minY, m.height, await BWB3D.gunzipBase64(m.data));
          else if (m.type === "block3d") this.r3d.setBlock(m.x, m.y, m.z, m.stateId);
          else if (m.type === "unload3d") this.r3d.removeColumn(m.x, m.z);
        } catch (err) { console.warn(`${MODULE_ID} | 3D message`, err); }
      }
      busy = false;
    };
    const on = (type, fn) => { hub.addEventListener(type, fn); this.listeners.push([type, fn]); };
    for (const type of ["col3d", "block3d", "unload3d"]) on(type, (ev) => { queue.push(ev.detail); pump(); });
    on("state", () => this.followBot());
    // Objects built from block displays: the whole set for my dimension, redrawn when it changes.
    const pushDisplays = () => this.r3d?.setDisplays([...hub.displays.values()].filter((p) => (p.dim ?? "overworld") === myDim()));
    on("disp", pushDisplays);
    pushDisplays();
    // Someone changed their look: redraw at once instead of waiting for the next state tick.
    this._userHook ??= Hooks.on("updateUser", (user, change) => {
      if (foundry.utils.hasProperty(change, `flags.${MODULE_ID}`) || "avatar" in change) this.followBot();
    });
    if (hub.isRelayHost) for (const m of hub.cached3d()) queue.push(m);
    hub.subscribe3d(true);
    this.followBot();
    pump();
  }

  followBot() {
    if (!this.r3d) return;
    const hub = this.hub;
    const me = hub.positions.get(this.key);
    if (me) {
      this.r3d.setTarget(me);
      const locked = document.pointerLockElement === this.element?.querySelector(".bwb-overlay");
      if (!locked || this.yaw === null) this.r3d.setLook(me.yaw, me.pitch);
    }
    const others = [...hub.positions.values()]
      .filter((p) => p.key !== this.key && p.dim === me?.dim)
      .map((p) => {
        const look = avatarFor(game.users.get(p.key));
        return { id: `bot:${p.key}`, kind: "bot", x: p.x, y: p.y, z: p.z, yaw: p.yaw, avatar: { ...look, image: absUrl(look.image) } };
      });
    this.r3d.setEntities([...others, ...hub.entities.map((e) => ({ ...e, id: `e:${e.id}` }))]);
  }

  // ---------------- input ----------------

  bindInput(stage) {
    const overlay = stage.querySelector(".bwb-overlay");
    const sink = stage.querySelector(".bwb-keysink");
    overlay.addEventListener("mousedown", (ev) => {
      ev.preventDefault();
      sink.focus();
      if (document.pointerLockElement !== overlay) {
        overlay.requestPointerLock?.();
        return; // first click only grabs the mouse
      }
      this.cursor(ev.button === 2 ? "right" : "left");
    });
    overlay.addEventListener("contextmenu", (ev) => ev.preventDefault());
    overlay.addEventListener("mousemove", (ev) => {
      if (document.pointerLockElement !== overlay) return;
      this.turn(ev.movementX, ev.movementY);
    });
    sink.addEventListener("keydown", (ev) => this.onKey(ev, true));
    sink.addEventListener("keyup", (ev) => this.onKey(ev, false));
    sink.addEventListener("blur", () => this.releaseAll());
    this._onLockChange = () => {
      overlay.classList.toggle("locked", document.pointerLockElement === overlay);
      if (document.pointerLockElement !== overlay) this.releaseAll();
    };
    document.addEventListener("pointerlockchange", this._onLockChange);
    clearInterval(this.lookTimer);
    this.lookTimer = setInterval(() => this.flushLook(), 1000 / LOOK_HZ);
  }

  onKey(ev, down) {
    ev.stopPropagation();
    const control = KEYS[ev.code];
    if (!control) return;
    ev.preventDefault();
    if (down === this.held.has(control)) return; // ignore auto-repeat
    down ? this.held.add(control) : this.held.delete(control);
    this.hub.intent({ type: "control", key: this.key, control, state: down }).catch(() => {});
  }

  turn(dx, dy) {
    const sens = game.settings.get(MODULE_ID, "lookSensitivity") / 1000;
    if (this.yaw === null) {
      const p = this.hub.positions.get(this.key);
      this.yaw = p?.yaw ?? 0;
      this.pitch = p?.pitch ?? 0;
    }
    // Mineflayer yaw grows counter-clockwise, so moving the mouse right turns it down.
    this.yaw -= dx * sens;
    this.pitch = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, this.pitch - dy * sens));
    this.r3d?.setLook(this.yaw, this.pitch); // the view turns at once; the bot follows at LOOK_HZ
    this.lookDirty = true;
  }

  flushLook() {
    if (!this.lookDirty) return;
    this.lookDirty = false;
    this.hub.intent({ type: "look", key: this.key, yaw: this.yaw, pitch: this.pitch }).catch(() => {});
  }

  cursor(button) {
    this.flushLook();
    this.hub.tryIntent({ type: "cursor", key: this.key, button });
  }

  releaseAll() {
    for (const control of this.held) {
      this.hub.intent({ type: "control", key: this.key, control, state: false }).catch(() => {});
    }
    this.held.clear();
    this.yaw = null; // re-read the bot's real heading next time
  }

  teardown() {
    clearInterval(this.lookTimer);
    this.lookTimer = null;
    this.releaseAll();
    if (this._onLockChange) document.removeEventListener("pointerlockchange", this._onLockChange);
    this._onLockChange = null;
    for (const [type, fn] of this.listeners) this.hub.removeEventListener(type, fn);
    if (this.listeners.length) this.hub.subscribe3d(false);
    this.listeners = [];
    this.resizer?.disconnect();
    this.resizer = null;
    this.r3d?.dispose();
    this.r3d = null;
  }

  async _onClose(options) {
    this.teardown();
    if (document.pointerLockElement) document.exitPointerLock();
    if (this._settingHook) { Hooks.off("updateSetting", this._settingHook); this._settingHook = null; }
    if (this._userHook) { Hooks.off("updateUser", this._userHook); this._userHook = null; }
    return super._onClose?.(options);
  }
}
