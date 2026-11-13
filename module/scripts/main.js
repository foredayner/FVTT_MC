import { MODULE_ID, L } from "./constants.js";
import { Hub } from "./hub.js";
import { MapLayer } from "./map-layer.js";
import { TokenSync } from "./token-sync.js";
import { MapView } from "./map-view.js";
import { sceneToMc } from "./coords.js";
import { visionSceneData } from "./map-setup.js";
import { BridgePanel } from "./apps/panel.js";
import { View3D } from "./apps/view3d.js";
import { ClueSystem } from "./clues/clues.js";
import { Hotbar } from "./hotbar.js";

/** Module singleton, exposed as game.modules.get("blockworld-bridge").api */
class Bridge {
  constructor() {
    this.hub = new Hub();
    this.mapMode = false;
    this.panel = null;
    this.view3d = null;
  }

  ready() {
    this.hub.init();
    this.map = new MapLayer(this.hub);
    if (game.user.isGM) { this.tokens = new TokenSync(this.hub); this.mapView = new MapView(this.hub); }
    this.clues = new ClueSystem(this);
    this.hotbar = new Hotbar(this);
    this.map.bindScene();
    this.clues.layer.draw();
  }

  openPanel() {
    this.panel ??= new BridgePanel(this);
    this.panel.render({ force: true });
  }

  open3D() {
    if (!this.hub.can3d(game.user.id)) return ui.notifications.warn(L("View3D.NoViewer"));
    this.view3d ??= new View3D(this);
    this.view3d.render({ force: true });
  }

  setMapMode(on) {
    this.mapMode = !!on;
    document.body.classList.toggle("bwb-map-mode", this.mapMode);
    if (on && !canvas.scene?.getFlag(MODULE_ID, "map")) ui.notifications.warn(L("Notify.NotMapScene"));
  }

  /**
   * Map-mode clicks on the canvas: click = walk, Shift+click = dig, Alt+click = attack,
   * GM Ctrl+click = mark a wall cell as a secret door (or unmark it).
   * Uses the pointer position in scene coordinates and converts it to block coordinates.
   */
  onCanvasPointer(event) {
    if (!this.mapMode || event.button !== 0) return;
    const map = canvas.scene?.getFlag(MODULE_ID, "map");
    if (!map) return;
    const pt = event.getLocalPosition?.(canvas.stage) ?? canvas.mousePosition;
    if (!pt) return;
    const dims = { grid: canvas.scene.grid.size, sceneX: canvas.dimensions.sceneX, sceneY: canvas.dimensions.sceneY };
    const mc = sceneToMc(pt, map, dims);
    const key = game.user.id;
    const ev = event.nativeEvent ?? event;
    if (ev.ctrlKey && game.user.isGM) {
      // GM: Ctrl+click a wall to make it a secret door (or a plain wall again).
      this.mapView?.walls.toggleSecret(Math.floor(mc.x), Math.floor(mc.z)).catch((err) => ui.notifications.warn(err.message));
      return;
    }
    let payload;
    if (ev.shiftKey) payload = { type: "dig", key, x: Math.floor(mc.x), z: Math.floor(mc.z) };
    else if (ev.altKey) payload = { type: "attackAt", key, x: mc.x, z: mc.z };
    else payload = { type: "moveTo", key, x: mc.x, z: mc.z };
    canvas.ping?.(pt);
    this.hub.tryIntent(payload);
  }
}

const bridge = new Bridge();

// Whether Alt is held (for the GM's Alt+drag teleport).
let altDown = false;
window.addEventListener("keydown", (ev) => { if (ev.key === "Alt") altDown = true; });
window.addEventListener("keyup", (ev) => { if (ev.key === "Alt") altDown = false; });
window.addEventListener("blur", () => { altDown = false; });

/**
 * GM Alt+drag of a character's token: teleport the Minecraft character there (to the middle of
 * the block, standing on what the map shows: the ground, or the floor of the floor plan). The
 * token then follows the character as always. Without Alt nothing changes (Minecraft owns it).
 */
Hooks.on("preUpdateToken", (doc, change, options, userId) => {
  if (!altDown || !game.user.isGM || userId !== game.user.id || options?.method === "api") return;
  if (!("x" in change) && !("y" in change)) return;
  const key = doc.getFlag(MODULE_ID, "botKey");
  const scene = doc.parent;
  const map = scene?.getFlag(MODULE_ID, "map");
  const hub = bridge.hub;
  if (!key || !map || !hub.isRelayHost || !hub.relay) return;
  const bot = hub.bots.find((b) => b.key === key);
  const walls = bridge.mapView?.walls;
  if (!bot?.online || !walls) { ui.notifications.warn(L("Teleport.Offline")); return false; }
  const grid = scene.grid.size;
  const d = scene.dimensions ?? canvas.dimensions;
  const x = (change.x ?? doc.x) + (doc.width * grid) / 2;
  const y = (change.y ?? doc.y) + (doc.height * grid) / 2;
  const mc = sceneToMc({ x, y }, map, { grid, sceneX: d.sceneX ?? 0, sceneY: d.sceneY ?? 0 });
  const bx = Math.floor(mc.x); const bz = Math.floor(mc.z);
  const dim = map.dim ?? "overworld";
  const kind = walls.kindAt(dim, bx, bz);
  const h = walls.heightAt(dim, bx, bz);
  // Only onto ground or a floor: not into a wall, a window, a door or furniture.
  if (h === null || (kind !== 0 && kind !== 1)) { ui.notifications.warn(L("Teleport.NotThere")); return false; }
  hub.relay.call("stop", { key }).catch(() => {});
  hub.relay.call("gm", { action: "tp", args: { target: bot.username, x: bx, y: h + 1, z: bz, center: true } })
    .catch((err) => ui.notifications.warn(`${L("Teleport.Failed")}: ${err.message ?? err}`));
  return false; // the token follows the character
});

Hooks.once("init", () => {
  const S = (key, data) => game.settings.register(MODULE_ID, key, data);
  S("relayUrl", {
    name: "BWB.Settings.RelayUrl.Name", hint: "BWB.Settings.RelayUrl.Hint",
    scope: "client", config: true, type: String, default: "ws://127.0.0.1:8765",
    restricted: true
  });
  // Client scope on purpose: world settings are sent to every player, the token must not be.
  S("relayToken", {
    name: "BWB.Settings.RelayToken.Name", hint: "BWB.Settings.RelayToken.Hint",
    scope: "client", config: true, type: String, default: "", restricted: true
  });
  S("autoConnect", {
    name: "BWB.Settings.AutoConnect.Name", hint: "BWB.Settings.AutoConnect.Hint",
    scope: "client", config: true, type: Boolean, default: false, restricted: true
  });
  // Which 3D asset version the GM has uploaded to the data folder (set automatically).
  S("assetsVersion", { scope: "world", config: false, type: String, default: "" });
  S("visionRadius", {
    name: "BWB.Settings.VisionRadius.Name", hint: "BWB.Settings.VisionRadius.Hint",
    scope: "world", config: true, type: Number, default: 16,
    range: { min: 4, max: 64, step: 1 }
  });
  S("mirrorChat", {
    name: "BWB.Settings.MirrorChat.Name", hint: "BWB.Settings.MirrorChat.Hint",
    scope: "world", config: true, type: Boolean, default: true
  });
  S("clueMode", {
    name: "BWB.Settings.ClueMode.Name", hint: "BWB.Settings.ClueMode.Hint",
    scope: "world", config: true, type: String, default: "party",
    choices: { party: "BWB.Settings.ClueMode.Party", private: "BWB.Settings.ClueMode.Private" }
  });
  S("clueRules", {
    name: "BWB.Settings.ClueRules.Name", hint: "BWB.Settings.ClueRules.Hint",
    scope: "world", config: true, type: String, default: "auto",
    choices: { auto: "BWB.Settings.ClueRules.Auto", coc7: "BWB.Settings.ClueRules.Coc7", generic: "BWB.Settings.ClueRules.Generic" }
  });
  S("lookSensitivity", {
    name: "BWB.Settings.LookSensitivity.Name", hint: "BWB.Settings.LookSensitivity.Hint",
    scope: "client", config: true, type: Number, default: 3,
    range: { min: 1, max: 10, step: 0.5 }
  });

  game.keybindings.register(MODULE_ID, "openPanel", {
    name: "BWB.Keybind.OpenPanel",
    editable: [{ key: "KeyM", modifiers: ["Shift"] }],
    onDown: () => { bridge.openPanel(); return true; }
  });
  game.keybindings.register(MODULE_ID, "toggleMapMode", {
    name: "BWB.Keybind.ToggleMapMode",
    editable: [{ key: "KeyN", modifiers: ["Shift"] }],
    onDown: () => { bridge.setMapMode(!bridge.mapMode); bridge.panel?.rendered && bridge.panel.render(); return true; }
  });

  game.modules.get(MODULE_ID).api = bridge;
});

// A button in the Token controls to open the panel.
Hooks.on("getSceneControlButtons", (controls) => {
  const tokens = controls.tokens ?? controls.token;
  if (!tokens?.tools) return;
  tokens.tools.bwbPanel = {
    name: "bwbPanel",
    title: "BWB.Panel.Title",
    icon: "fa-solid fa-cube",
    order: Object.keys(tokens.tools).length,
    button: true,
    visible: true,
    onChange: () => bridge.openPanel()
  };
  if (game.user.isGM) {
    tokens.tools.bwbClues = {
      name: "bwbClues",
      title: "BWB.Clue.Board",
      icon: "fa-solid fa-magnifying-glass",
      order: Object.keys(tokens.tools).length,
      button: true,
      visible: true,
      onChange: () => bridge.clues?.openBoard()
    };
  }
});

Hooks.once("ready", () => bridge.ready());

// A journal dropped on a map scene (GM) becomes a clue lying there; a hotbar slot dropped on the
// map is handed to the character under it, or dropped.
Hooks.on("dropCanvasData", (cnv, data) => {
  if (data?.type === "JournalEntry" && game.user.isGM && bridge.clues?.scene) { bridge.clues.dropJournal(data); return false; }
  if (data?.type === "bwbHotbar" && bridge.hotbar) { bridge.hotbar.dropOnCanvas(data); return false; }
});

// "Clue settings" in a journal's window header (GM).
Hooks.on("getHeaderControlsJournalEntrySheet", (app, controls) => {
  if (!game.user.isGM) return;
  controls.push({ icon: "fa-solid fa-magnifying-glass", label: "BWB.Clue.Config", action: "bwbClueConfig", onClick: () => bridge.clues?.configure(app.document) });
});

Hooks.on("canvasReady", async () => {
  // Map scenes made with 0.1.x had no vision settings: apply them once, from the active GM only.
  const scene = canvas.scene;
  if (game.user.isGM && game.users.activeGM?.id === game.user.id && scene?.getFlag(MODULE_ID, "map") && !scene.getFlag(MODULE_ID, "vision")) {
    try { await scene.update({ ...visionSceneData(), [`flags.${MODULE_ID}.vision`]: true }); }
    catch (err) { console.warn(`${MODULE_ID} | vision`, err); }
  }
  canvas.stage.off?.("pointerdown", bridge._onPointer);
  bridge._onPointer ??= (ev) => bridge.onCanvasPointer(ev);
  canvas.stage.on("pointerdown", bridge._onPointer);
});
