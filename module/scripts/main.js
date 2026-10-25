import { MODULE_ID, L } from "./constants.js";
import { Hub } from "./hub.js";
import { MapLayer } from "./map-layer.js";
import { TokenSync } from "./token-sync.js";
import { MapView } from "./map-view.js";
import { sceneToMc } from "./coords.js";
import { visionSceneData } from "./map-setup.js";
import { BridgePanel } from "./apps/panel.js";
import { View3D } from "./apps/view3d.js";

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
    this.map.bindScene();
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
   * Map-mode clicks on the canvas: click = walk, Shift+click = dig, Alt+click = attack.
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
    let payload;
    if (ev.shiftKey) payload = { type: "dig", key, x: Math.floor(mc.x), z: Math.floor(mc.z) };
    else if (ev.altKey) payload = { type: "attackAt", key, x: mc.x, z: mc.z };
    else payload = { type: "moveTo", key, x: mc.x, z: mc.z };
    canvas.ping?.(pt);
    this.hub.tryIntent(payload);
  }
}

const bridge = new Bridge();

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
});

Hooks.once("ready", () => bridge.ready());

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
