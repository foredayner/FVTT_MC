import { MODULE_ID, L } from "../constants.js";
import { setupMapScene, clearMapScene } from "../map-setup.js";
import { AvatarConfig } from "./avatar-config.js";
import { viewOf } from "../map-view.js";

const { ApplicationV2 } = foundry.applications.api;

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/** Control panel: connection, my character, map mode, 3D view, chat, and GM tools. */
export class BridgePanel extends ApplicationV2 {
  constructor(bridge, options = {}) {
    super(options);
    this.bridge = bridge;
    const rerender = foundry.utils.debounce(() => this.rendered && this.render(), 150);
    for (const ev of ["status", "bots"]) bridge.hub.addEventListener(ev, rerender);
    bridge.hub.addEventListener("state", () => this.refreshLive());
  }

  static DEFAULT_OPTIONS = {
    id: "bwb-panel",
    classes: ["bwb", "bwb-panel"],
    tag: "section",
    window: { title: "BWB.Panel.Title", icon: "fa-solid fa-cube", resizable: true },
    position: { width: 380, height: "auto" },
    actions: {
      connect: BridgePanel.#connect,
      disconnect: BridgePanel.#disconnect,
      spawn: BridgePanel.#spawn,
      despawn: BridgePanel.#despawn,
      despawnOther: BridgePanel.#despawnOther,
      mapMode: BridgePanel.#mapMode,
      stop: BridgePanel.#stop,
      open3d: BridgePanel.#open3d,
      avatar: BridgePanel.#avatar,
      applyView: BridgePanel.#applyView,
      viewFromBot: BridgePanel.#viewFromBot,
      chat: BridgePanel.#chat,
      setupMap: BridgePanel.#setupMap,
      setupMapAt: BridgePanel.#setupMapAt,
      clearMap: BridgePanel.#clearMap,
      gm: BridgePanel.#gm,
      posFromBot: BridgePanel.#posFromBot,
      resync: BridgePanel.#resync
    }
  };

  async _renderHTML() {
    const hub = this.bridge.hub;
    const me = hub.botFor(game.user.id);
    const st = hub.status;
    const isGM = game.user.isGM;
    const statusLabel = L(`Status.${st.status}`);
    const mapCfg = canvas.scene?.getFlag(MODULE_ID, "map");

    const myBot = me
      ? `<p class="bwb-me">
           <b>${esc(me.username)}</b> · ${me.online ? L("Panel.Online") : L("Panel.Joining")}
           <span class="bwb-live" data-live="${esc(me.key)}"></span>
         </p>
         <div class="bwb-row">
           <button type="button" data-action="despawn"><i class="fa-solid fa-right-from-bracket"></i> ${L("Panel.Leave")}</button>
           <button type="button" data-action="open3d" ${hub.can3d(me.key) ? "" : "disabled"}><i class="fa-solid fa-vr-cardboard"></i> ${L("Panel.Open3D")}</button>
           <button type="button" data-action="avatar"><i class="fa-solid fa-user-astronaut"></i> ${L("Panel.Avatar")}</button>
         </div>`
      : `<div class="bwb-row">
           <input type="text" name="username" maxlength="16" placeholder="${L("Panel.UsernamePlaceholder")}"
                  value="${esc(game.user.getFlag(MODULE_ID, "lastUsername") ?? "")}">
           <button type="button" data-action="spawn"><i class="fa-solid fa-right-to-bracket"></i> ${L("Panel.Join")}</button>
         </div>`;

    const mapMode = this.bridge.mapMode;
    const control = `
      <div class="bwb-row">
        <button type="button" data-action="mapMode" class="${mapMode ? "active" : ""}" ${me?.online ? "" : "disabled"}>
          <i class="fa-solid fa-map-location-dot"></i> ${mapMode ? L("Panel.MapModeOn") : L("Panel.MapModeOff")}
        </button>
        <button type="button" data-action="stop" ${me?.online ? "" : "disabled"}><i class="fa-solid fa-hand"></i> ${L("Panel.Stop")}</button>
      </div>
      <p class="bwb-hint">${L("Panel.MapHint")}</p>
      <div class="bwb-row">
        <input type="text" name="chat" maxlength="240" placeholder="${L("Panel.ChatPlaceholder")}">
        <button type="button" data-action="chat" ${me?.online ? "" : "disabled"}><i class="fa-solid fa-paper-plane"></i></button>
      </div>`;

    let gm = "";
    if (isGM) {
      const online = hub.bots.filter((b) => b.online);
      const botOptions = online.map((b) => `<option value="${esc(b.key)}">${esc(b.username)}</option>`).join("");
      const targets = `<option value="@a">${L("GM.Everyone")}</option>` +
        online.map((b) => `<option value="${esc(b.username)}">${esc(b.username)}</option>`).join("");
      gm = `
      <h3>${L("GM.Header")}</h3>
      <div class="bwb-row">
        ${st.status === "connected" || st.status === "connecting"
          ? `<button type="button" data-action="disconnect"><i class="fa-solid fa-plug-circle-xmark"></i> ${L("GM.Disconnect")}</button>
             <button type="button" data-action="resync"><i class="fa-solid fa-rotate"></i> ${L("GM.Resync")}</button>`
          : `<button type="button" data-action="connect"><i class="fa-solid fa-plug"></i> ${L("GM.Connect")}</button>`}
      </div>
      <ul class="bwb-bots">
        ${hub.bots.map((b) => `<li>${esc(b.username)} <small>(${esc(game.users.get(b.key)?.name ?? b.key)})</small>
          <span class="bwb-live" data-live="${esc(b.key)}"></span>
          <a data-action="despawnOther" data-key="${esc(b.key)}" title="${L("Panel.Leave")}"><i class="fa-solid fa-xmark"></i></a></li>`).join("") || `<li class="bwb-empty">${L("GM.NoBots")}</li>`}
      </ul>
      <fieldset><legend>${L("GM.MapScene")}</legend>
        <p class="bwb-hint">${mapCfg ? L("GM.MapBound", { x: mapCfg.originX, z: mapCfg.originZ + mapCfg.size - 1, size: mapCfg.size }) : L("GM.MapUnbound")}</p>
        <div class="bwb-row">
          <select name="mapCenter">${botOptions}</select>
          <select name="mapSize">${[64, 96, 128, 192, 256].map((s) => `<option ${s === 128 ? "selected" : ""}>${s}</option>`).join("")}</select>
          <button type="button" data-action="setupMap" ${online.length ? "" : "disabled"}>${L("GM.SetupMap")}</button>
          ${mapCfg ? `<button type="button" data-action="clearMap">${L("GM.ClearMap")}</button>` : ""}
        </div>
        <div class="bwb-row">
          <label title="${L("GM.CornerHint")}">${L("GM.Corner")}</label>
          X <input type="number" name="cornerX" class="bwb-num" step="1" value="${mapCfg ? mapCfg.originX : ""}">
          Z <input type="number" name="cornerZ" class="bwb-num" step="1" value="${mapCfg ? mapCfg.originZ + mapCfg.size - 1 : ""}">
          <button type="button" data-action="setupMapAt">${L("GM.SetupMapAt")}</button>
        </div>
        ${mapCfg ? this.viewControls() : ""}
      </fieldset>
      <fieldset ${st.status === "connected" ? "" : "disabled"}><legend>${L("GM.Direction")}</legend>
        <div class="bwb-row">
          <button type="button" data-action="gm" data-cmd="time" data-value="day">☀ ${L("GM.Day")}</button>
          <button type="button" data-action="gm" data-cmd="time" data-value="night">☾ ${L("GM.Night")}</button>
          <button type="button" data-action="gm" data-cmd="weather" data-value="clear">${L("GM.Clear")}</button>
          <button type="button" data-action="gm" data-cmd="weather" data-value="thunder">${L("GM.Storm")}</button>
        </div>
        <div class="bwb-row">
          <input type="text" name="titleText" maxlength="120" placeholder="${L("GM.TitlePlaceholder")}">
          <select name="titleTarget">${targets}</select>
          <button type="button" data-action="gm" data-cmd="title">${L("GM.Show")}</button>
        </div>
        <div class="bwb-row">
          <select name="effect">${["slowness", "blindness", "darkness", "nausea", "speed", "regeneration", "night_vision", "glowing"].map((e) => `<option value="${e}">${L(`Effect.${e}`)}</option>`).join("")}</select>
          <select name="effectTarget">${targets}</select>
          <input type="number" name="effectSeconds" value="10" min="1" max="600" class="bwb-num">
          <button type="button" data-action="gm" data-cmd="effect">${L("GM.Apply")}</button>
        </div>
        <div class="bwb-row">
          <select name="mob">${["zombie", "skeleton", "spider", "creeper", "witch", "enderman", "cow", "wolf", "villager"].map((m) => `<option value="${m}">${L(`Mob.${m}`)}</option>`).join("")}</select>
          <select name="mobNear">${online.map((b) => `<option value="${esc(b.username)}">${esc(b.username)}</option>`).join("")}</select>
          <button type="button" data-action="gm" data-cmd="summon" ${online.length ? "" : "disabled"}>${L("GM.Summon")}</button>
        </div>
        <p class="bwb-hint">${st.info?.gmCommandsVia === "bot-chat" ? L("GM.ViaBotChat") : ""}</p>
      </fieldset>
      <fieldset ${st.status === "connected" ? "" : "disabled"}><legend>${L("GM.Teleport")}</legend>
        <div class="bwb-row">
          <label>${L("GM.PosFrom")}</label>
          <select name="posFrom">${botOptions}</select>
          <button type="button" data-action="posFromBot" ${online.length ? "" : "disabled"} title="${L("GM.PosFromHint")}"><i class="fa-solid fa-location-crosshairs"></i> ${L("GM.HerePos")}</button>
        </div>
        <div class="bwb-row">
          X <input type="number" name="posX" class="bwb-num" step="1">
          Y <input type="number" name="posY" class="bwb-num" step="1" min="-64" max="319">
          Z <input type="number" name="posZ" class="bwb-num" step="1">
        </div>
        <div class="bwb-row">
          <select name="posTarget">${targets}</select>
          <button type="button" data-action="gm" data-cmd="tp" ${online.length ? "" : "disabled"}>${L("GM.Tp")}</button>
          <button type="button" data-action="gm" data-cmd="spawnpoint" ${online.length ? "" : "disabled"} title="${L("GM.SpawnpointHint")}">${L("GM.Spawnpoint")}</button>
        </div>
        <div class="bwb-row">
          <button type="button" data-action="gm" data-cmd="worldspawn" title="${L("GM.WorldSpawnHint")}"><i class="fa-solid fa-flag"></i> ${L("GM.WorldSpawn")}</button>
        </div>
        <p class="bwb-hint">${L("GM.TeleportHint")}</p>
      </fieldset>`;
    }

    return `
      <p class="bwb-status bwb-status-${esc(st.status)}"><i class="fa-solid fa-circle"></i> ${statusLabel}
        ${st.info?.mcVersion ? `· Minecraft ${esc(st.info.mcVersion)}` : ""}
        ${st.detail ? `<small>(${esc(st.detail)})</small>` : ""}</p>
      <h3>${L("Panel.MyCharacter")}</h3>
      ${myBot}
      ${control}
      ${gm}`;
  }

  /** GM: floor-plan view of the map scene (see map-view.js). */
  viewControls() {
    const v = viewOf(canvas.scene);
    const opt = (m) => `<option value="${m}" ${v.mode === m ? "selected" : ""}>${L(`View.${m}`)}</option>`;
    return `
        <div class="bwb-row">
          <label>${L("View.Label")}</label>
          <select name="viewMode">${["auto", "fixed", "off"].map(opt).join("")}</select>
          <input type="number" name="viewY" class="bwb-num" step="1" value="${v.y ?? ""}" placeholder="Y" title="${L("View.YHint")}">
          <button type="button" data-action="viewFromBot" title="${L("View.FromBot")}"><i class="fa-solid fa-person-arrow-down-to-line"></i></button>
        </div>
        <div class="bwb-row">
          <label><input type="checkbox" name="viewWalls" ${v.walls ? "checked" : ""}> ${L("View.Walls")}</label>
          <button type="button" data-action="applyView">${L("GM.Apply")}</button>
        </div>
        <p class="bwb-hint">${L(`View.Hint.${v.mode}`)}</p>`;
  }

  _replaceHTML(result, content) {
    // Keep typed teleport coordinates and picks when the panel re-renders (bots joining, status changes).
    const keep = ["posX", "posY", "posZ", "posTarget", "posFrom"];
    const saved = Object.fromEntries(keep.map((n) => [n, content.querySelector(`[name="${n}"]`)?.value]));
    content.innerHTML = result;
    for (const [n, v] of Object.entries(saved)) {
      const el = content.querySelector(`[name="${n}"]`);
      if (!el || v === undefined) continue;
      if (el.tagName === "SELECT" && ![...el.options].some((o) => o.value === v)) continue;
      el.value = v;
    }
    this.refreshLive();
  }

  /** Cheap per-tick update of coordinates/health without a full re-render. */
  refreshLive() {
    if (!this.rendered) return;
    for (const el of this.element.querySelectorAll("[data-live]")) {
      const p = this.bridge.hub.positions.get(el.dataset.live);
      el.textContent = p ? ` ${Math.floor(p.x)}, ${Math.floor(p.y)}, ${Math.floor(p.z)} · ♥${p.health ?? "?"}` : "";
    }
  }

  field(name) { return this.element.querySelector(`[name="${name}"]`)?.value?.trim() ?? ""; }

  // ---------------- actions (this = app) ----------------

  static #connect() { this.bridge.hub.connect(); }
  static #disconnect() { this.bridge.hub.disconnect(); }

  static async #spawn() {
    const username = this.field("username");
    if (!/^[A-Za-z0-9_]{3,16}$/.test(username)) return ui.notifications.warn(L("Notify.BadUsername"));
    await game.user.setFlag(MODULE_ID, "lastUsername", username);
    await this.bridge.hub.tryIntent({ type: "spawnBot", key: game.user.id, username });
  }

  static async #despawn() {
    this.bridge.setMapMode(false);
    await this.bridge.hub.tryIntent({ type: "despawnBot", key: game.user.id });
  }

  static async #despawnOther(event, target) {
    await this.bridge.hub.tryIntent({ type: "despawnBot", key: target.dataset.key });
  }

  static #mapMode() { this.bridge.setMapMode(!this.bridge.mapMode); this.render(); }

  static async #stop() { await this.bridge.hub.tryIntent({ type: "stop", key: game.user.id }); }

  static #open3d() { this.bridge.open3D(); }

  static #avatar() { (this.avatarApp ??= new AvatarConfig()).render({ force: true }); }

  static async #chat() {
    const input = this.element.querySelector('[name="chat"]');
    const text = input.value.trim();
    if (!text) return;
    input.value = "";
    await this.bridge.hub.tryIntent({ type: "chat", key: game.user.id, text });
  }

  static async #setupMap() {
    await setupMapScene(this.bridge.hub, { centerKey: this.field("mapCenter"), size: Number(this.field("mapSize")) });
    this.render();
  }

  /** Floor level of the character picked as map centre: the block their feet are in. */
  static #viewFromBot() {
    const p = this.bridge.hub.positions.get(this.field("mapCenter"));
    if (!p) return ui.notifications.warn(L("Notify.NoBotPosition"));
    this.element.querySelector('[name="viewY"]').value = Math.floor(p.y);
    this.element.querySelector('[name="viewMode"]').value = "fixed";
  }

  static async #applyView() {
    const mode = this.field("viewMode");
    const y = Number.parseInt(this.field("viewY"), 10);
    if (mode === "fixed" && !Number.isInteger(y)) return ui.notifications.warn(L("View.NeedY"));
    const walls = !!this.element.querySelector('[name="viewWalls"]')?.checked;
    await canvas.scene.setFlag(MODULE_ID, "view", { mode, y: Number.isInteger(y) ? y : null, walls });
    this.render();
  }

  /** Map with the typed block as its bottom-left corner (size from the size picker). */
  static async #setupMapAt() {
    const x = Number.parseInt(this.field("cornerX"), 10);
    const z = Number.parseInt(this.field("cornerZ"), 10);
    if (!Number.isInteger(x) || !Number.isInteger(z)) return ui.notifications.warn(L("Notify.NeedCorner"));
    await setupMapScene(this.bridge.hub, { centerKey: this.field("mapCenter"), size: Number(this.field("mapSize")), corner: { x, z } });
    this.render();
  }

  static async #clearMap() { await clearMapScene(); this.render(); }

  static async #resync() { await this.bridge.hub.tryIntent({ type: "resync" }); }

  /** X/Y/Z from the teleport fields, or null unless all three are whole numbers (Y within build height). */
  typedPos() {
    const [x, y, z] = ["posX", "posY", "posZ"].map((n) => {
      const s = this.field(n);
      return /^-?\d+$/.test(s) ? Number(s) : NaN;
    });
    if (![x, y, z].every(Number.isInteger) || y < -64 || y > 319) return null;
    return { x, y, z };
  }

  /** Fill X/Y/Z with the block the picked character is standing in. */
  static #posFromBot() {
    const p = this.bridge.hub.positions.get(this.field("posFrom"));
    if (!p) return ui.notifications.warn(L("Notify.NoBotPosition"));
    const set = (n, v) => { this.element.querySelector(`[name="${n}"]`).value = Math.floor(v); };
    set("posX", p.x); set("posY", p.y); set("posZ", p.z);
  }

  static async #gm(event, target) {
    const cmd = target.dataset.cmd;
    let args;
    switch (cmd) {
      case "time":
      case "weather":
        args = { value: target.dataset.value };
        break;
      case "title":
        args = { text: this.field("titleText"), target: this.field("titleTarget") };
        if (!args.text) return;
        break;
      case "effect":
        args = { effect: this.field("effect"), target: this.field("effectTarget"), seconds: Number(this.field("effectSeconds")) };
        break;
      case "summon":
        args = { mob: this.field("mob"), near: this.field("mobNear"), dx: 4, dz: 0 };
        break;
      case "tp":
      case "spawnpoint":
      case "worldspawn": {
        const p = this.typedPos();
        if (!p) return ui.notifications.warn(L("Notify.NeedXYZ"));
        args = cmd === "worldspawn" ? p : { ...p, target: this.field("posTarget") };
        break;
      }
      default:
        return;
    }
    const res = await this.bridge.hub.tryIntent({ type: "gm", action: cmd, args });
    if (res !== null) ui.notifications.info(L("Notify.GmSent"));
  }
}
