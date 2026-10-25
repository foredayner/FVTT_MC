import { MODULE_ID, SOCKET, PLAYER_INTENTS, GM_INTENTS, L } from "./constants.js";
import { RelayClient } from "./relay-client.js";
import { ensureAssets } from "./assets.js";
import { applyDisp } from "./displays.js";

/** High-rate inputs: no ack, so they never queue up behind a slow dig. */
const FIRE_AND_FORGET = new Set(["look", "control"]);

/**
 * Shared state on every client.
 * The GM's browser owns the relay connection and fans everything out over the Foundry socket;
 * players send their intentions to the GM, who checks they only touch their own bot.
 *
 * 3D world data (col3d/block3d/unload3d) is cached by the GM and only forwarded while somebody
 * has a 3D window open; a player opening one gets the cache first.
 *
 * Block display parts ("disp") are kept like map chunks: every client has them, for the map and 3D.
 *
 * Events: status, bots, state, chunk, disp, event, col3d, block3d, unload3d
 */
export class Hub extends EventTarget {
  constructor() {
    super();
    this.status = { status: "disconnected", detail: null, info: null };
    this.bots = [];                 // [{key, username, online}]
    this.positions = new Map();     // key -> {x,y,z,yaw,pitch,health,food,dim,moving}
    this.entities = [];             // [{id, kind, name, x,y,z}]
    this.chunks = new Map();        // "dim:cx:cz" -> chunk msg
    this.displays = new Map();      // id -> block display part (see displays.js)
    this.log = [];                  // recent events
    this.waiting = new Map();       // reqId -> {resolve, reject, timer} (players)
    this.reqSeq = 0;
    this.relay = null;
    this.cols3d = new Map();        // GM: "dim:x,z" -> {col, updates[]}
    this.subs3d = new Set();        // GM: users with a 3D window open
  }

  get isGM() { return game.user.isGM; }

  /** Am I the GM that talks to the relay? (first active GM, so two GMs don't both relay) */
  get isRelayHost() {
    if (!this.isGM) return false;
    const gm = game.users.activeGM;
    return !gm || gm.id === game.user.id;
  }

  init() {
    game.socket.on(SOCKET, (data, sender) => this.onSocket(data, sender));
    if (this.isGM) {
      this.relay = new RelayClient();
      for (const type of ["welcome", "bots", "state", "chunk", "disp", "event", "col3d", "block3d", "unload3d"]) {
        this.relay.addEventListener(type, (ev) => this.fromRelay(ev.detail));
      }
      this.relay.addEventListener("status", (ev) => {
        this.status = { ...ev.detail, info: this.relay.info };
        this.broadcast({ t: "status", status: this.status });
        this.emit("status", this.status);
      });
      if (game.settings.get(MODULE_ID, "autoConnect")) this.connect();
      Hooks.on("userConnected", (user, connected) => { if (!connected) this.subs3d.delete(user.id); });
    } else {
      this.broadcast({ t: "sync", from: game.user.id });
    }
  }

  connect() {
    const url = game.settings.get(MODULE_ID, "relayUrl");
    const token = game.settings.get(MODULE_ID, "relayToken");
    if (!token) return ui.notifications.warn(L("Notify.NoToken"));
    this.relay.connect(url, token);
  }

  disconnect() { this.relay?.disconnect(); }

  // ---------------- incoming ----------------

  /** GM only: a message straight from the relay. */
  fromRelay(msg) {
    if (msg.type === "col3d" || msg.type === "block3d" || msg.type === "unload3d") return this.from3d(msg);
    this.ingest(msg);
    if (msg.type !== "welcome") this.broadcast({ t: "relay", msg });
    if (msg.type === "event") this.mirrorToChat(msg);
    if (msg.type === "welcome" && msg.viewer?.enabled && msg.viewer.version) {
      ensureAssets(this.relay, msg.viewer.version).catch((err) => {
        console.error(`${MODULE_ID} | 3D assets`, err);
        ui.notifications.error(L("Notify.AssetsFailed", { error: err.message }));
      });
    }
  }

  /** GM only: keep the 3D cache, pass it on while anyone else is watching. */
  from3d(msg) {
    const k = `${msg.dim}:${msg.x},${msg.z}`;
    if (msg.type === "col3d") this.cols3d.set(k, { col: msg, updates: [] });
    else if (msg.type === "unload3d") this.cols3d.delete(k);
    else {
      const ck = `${msg.dim}:${Math.floor(msg.x / 16) * 16},${Math.floor(msg.z / 16) * 16}`;
      const entry = this.cols3d.get(ck);
      if (entry) { entry.updates.push(msg); if (entry.updates.length > 4000) entry.updates.splice(0, 2000); }
    }
    this.emit(msg.type, msg);
    if ([...this.subs3d].some((id) => id !== game.user.id)) this.broadcast({ t: "relay", msg });
  }

  /** GM only: everything a new 3D viewer needs, oldest first. */
  * cached3d() {
    for (const { col, updates } of this.cols3d.values()) { yield col; yield* updates; }
  }

  /** Any client: my 3D window opened or closed. */
  subscribe3d(on) {
    if (this.isRelayHost) { on ? this.subs3d.add(game.user.id) : this.subs3d.delete(game.user.id); return; }
    this.broadcast({ t: "sub3d", from: game.user.id, on: !!on });
  }

  ingest(msg) {
    switch (msg.type) {
      case "bots":
        this.bots = msg.bots;
        for (const k of [...this.positions.keys()]) if (!this.bots.some((b) => b.key === k)) this.positions.delete(k);
        break;
      case "state":
        for (const b of msg.bots) this.positions.set(b.key, b);
        this.entities = msg.entities;
        break;
      case "chunk":
        this.chunks.set(`${msg.dim}:${msg.cx}:${msg.cz}`, msg);
        break;
      case "disp":
        applyDisp(this.displays, msg);
        break;
      case "event":
        if (msg.kind === "hud") break; // screen text for one 3D view, not a log line
        this.log.push({ ...msg, at: Date.now() });
        if (this.log.length > 50) this.log.shift();
        if ((msg.kind === "error" || msg.kind === "warn") && msg.key === game.user.id) ui.notifications.warn(msg.text);
        break;
    }
    this.emit(msg.type, msg);
  }

  onSocket(data, sender) {
    if (!data || typeof data !== "object") return;
    // Foundry passes the sender's id as the second argument; fall back to the payload for safety.
    const from = (typeof sender === "string" && game.users.get(sender)) ? sender : data.from;
    switch (data.t) {
      case "relay":
        if (this.isRelayHost || (data.to && data.to !== game.user.id)) break;
        this.ingest(data.msg);
        break;
      case "sub3d":
        if (!this.isRelayHost || !from) break;
        if (data.on) {
          this.subs3d.add(from);
          for (const msg of this.cached3d()) this.broadcast({ t: "relay", to: from, msg });
        } else this.subs3d.delete(from);
        break;
      case "status":
        if (!this.isRelayHost) { this.status = data.status; this.emit("status", this.status); }
        break;
      case "snapshot":
        if (data.to === game.user.id) this.applySnapshot(data);
        break;
      case "sync":
        if (this.isRelayHost) this.sendSnapshot(from);
        break;
      case "intent":
        if (this.isRelayHost) this.handlePlayerIntent(from, data);
        break;
      case "intentResult": {
        if (data.to !== game.user.id) break;
        const w = this.waiting.get(data.reqId);
        if (!w) break;
        clearTimeout(w.timer);
        this.waiting.delete(data.reqId);
        data.ok ? w.resolve(data.result) : w.reject(new Error(data.error));
        break;
      }
    }
  }

  sendSnapshot(to) {
    this.broadcast({
      t: "snapshot", to, status: this.status, bots: this.bots,
      positions: [...this.positions.values()], entities: this.entities, chunks: [...this.chunks.values()],
      displays: [...this.displays.values()]
    });
  }

  applySnapshot(s) {
    this.status = s.status;
    this.bots = s.bots;
    this.positions = new Map(s.positions.map((p) => [p.key, p]));
    this.entities = s.entities;
    this.chunks = new Map(s.chunks.map((c) => [`${c.dim}:${c.cx}:${c.cz}`, c]));
    this.emit("status", this.status);
    this.emit("bots", { bots: this.bots });
    for (const c of s.chunks) this.emit("chunk", c);
    applyDisp(this.displays, { reset: true, add: s.displays ?? [] });
    this.emit("disp", { reset: true, add: s.displays ?? [], del: [] });
    this.emit("state", { bots: s.positions, entities: s.entities });
  }

  async handlePlayerIntent(from, { reqId, payload }) {
    const reply = (ok, error, result) => this.broadcast({ t: "intentResult", to: from, reqId, ok, error, result });
    const user = game.users.get(from);
    if (!user || !payload || !PLAYER_INTENTS.has(payload.type)) return reply(false, L("Notify.Forbidden"));
    if (!user.isGM && payload.key !== from) return reply(false, L("Notify.NotYourBot"));
    try {
      const result = await this.toRelay(payload);
      if (reqId !== undefined) reply(true, null, result ?? null);
    } catch (err) {
      if (reqId !== undefined) reply(false, err.message);
    }
  }

  toRelay(payload) {
    const { type, ...body } = payload;
    if (FIRE_AND_FORGET.has(type)) { this.relay.fire(type, body); return Promise.resolve(null); }
    return this.relay.call(type, body);
  }

  // ---------------- outgoing ----------------

  /**
   * Ask for something to happen in Minecraft. Works on any client.
   * @param {{type:string, key?:string, [k:string]:any}} payload
   */
  intent(payload) {
    if (GM_INTENTS.has(payload.type) && !this.isGM) return Promise.reject(new Error(L("Notify.Forbidden")));
    if (this.isRelayHost) return this.toRelay(payload);
    if (!game.users.activeGM) return Promise.reject(new Error(L("Notify.NoGM")));
    const fire = FIRE_AND_FORGET.has(payload.type);
    const reqId = fire ? undefined : `${game.user.id}-${++this.reqSeq}`;
    this.broadcast({ t: "intent", from: game.user.id, reqId, payload });
    if (fire) return Promise.resolve(null);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.waiting.delete(reqId); reject(new Error("timeout")); }, 30000);
      this.waiting.set(reqId, { resolve, reject, timer });
    });
  }

  /** Same as intent() but shows failures as a notification instead of throwing. */
  async tryIntent(payload) {
    try { return await this.intent(payload); } catch (err) { ui.notifications.warn(err.message); return null; }
  }

  broadcast(data) { game.socket.emit(SOCKET, data); }

  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }

  // ---------------- helpers ----------------

  botFor(userId) { return this.bots.find((b) => b.key === userId) ?? null; }

  /** Can this user open the 3D window right now? */
  can3d(key) {
    return !!(this.botFor(key)?.online && this.status.info?.viewer?.enabled && this.status.info.viewer.version);
  }

  mirrorToChat(ev) {
    if (!game.settings.get(MODULE_ID, "mirrorChat")) return;
    if (!["chat", "death", "kicked"].includes(ev.kind)) return;
    const content = `<p class="bwb-chat bwb-chat-${ev.kind}">${foundry.utils.escapeHTML?.(ev.text) ?? escape(ev.text)}</p>`;
    ChatMessage.create({ content, speaker: { alias: L("ChatAlias") } });
  }
}

function escape(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
