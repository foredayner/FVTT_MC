import { PROTOCOL_VERSION, L } from "./constants.js";

/**
 * WebSocket client to the relay. Runs only in the GM's browser.
 * Emits: status, welcome, bots, state, chunk, event
 */
export class RelayClient extends EventTarget {
  constructor() {
    super();
    this.ws = null;
    this.status = "disconnected"; // disconnected | connecting | connected | error
    this.info = null;             // welcome payload
    this.pending = new Map();     // id -> {resolve, reject, timer}
    this.nextId = 1;
    this.wanted = false;          // user asked to stay connected
    this.retry = 0;
    this.retryTimer = null;
  }

  connect(url, token) {
    this.wanted = true;
    this.url = url;
    this.token = token;
    this.open();
  }

  disconnect() {
    this.wanted = false;
    clearTimeout(this.retryTimer);
    this.ws?.close(1000, "bye");
    this.ws = null;
    this.setStatus("disconnected");
  }

  open() {
    clearTimeout(this.retryTimer);
    this.setStatus("connecting");
    let ws;
    try {
      ws = new WebSocket(this.url);
    } catch (err) {
      this.setStatus("error", err.message);
      return this.scheduleRetry();
    }
    this.ws = ws;
    ws.addEventListener("open", () => ws.send(JSON.stringify({ type: "hello", token: this.token })));
    ws.addEventListener("message", (ev) => this.onMessage(ev.data));
    ws.addEventListener("close", (ev) => {
      if (this.ws !== ws) return;
      this.ws = null;
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error("relay closed")); }
      this.pending.clear();
      if (ev.code === 4003) {
        this.wanted = false;
        return this.setStatus("error", "unauthorized");
      }
      if (ev.code === 4001) {
        this.wanted = false; // another tab took over
        return this.setStatus("disconnected", "replaced");
      }
      this.setStatus(this.wanted ? "connecting" : "disconnected");
      if (this.wanted) this.scheduleRetry();
    });
  }

  scheduleRetry() {
    if (!this.wanted) return;
    const delay = Math.min(30000, 1000 * 2 ** this.retry++);
    this.retryTimer = setTimeout(() => this.open(), delay);
  }

  onMessage(raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.type === "ack") {
      const p = this.pending.get(msg.id);
      if (!p) return;
      clearTimeout(p.timer);
      this.pending.delete(msg.id);
      return msg.ok ? p.resolve(msg.result) : p.reject(new Error(msg.error ?? "error"));
    }
    if (msg.type === "welcome") {
      if (msg.protocol !== PROTOCOL_VERSION) {
        this.disconnect();
        return this.setStatus("error", `protocol ${msg.protocol} != ${PROTOCOL_VERSION}`);
      }
      this.info = msg;
      this.retry = 0;
      this.setStatus("connected");
    }
    this.dispatchEvent(new CustomEvent(msg.type, { detail: msg }));
  }

  /** Send a request and wait for its ack. */
  call(type, body = {}, timeoutMs = 30000) {
    if (!this.ws || this.status !== "connected") return Promise.reject(new Error(L("Notify.RelayNotConnected")));
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ type, id, ...body }));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error("relay timeout")); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
  }

  /** Fire-and-forget (used for high-rate look/control updates). */
  fire(type, body = {}) {
    if (this.ws && this.status === "connected") this.ws.send(JSON.stringify({ type, ...body }));
  }

  setStatus(status, detail) {
    this.status = status;
    this.statusDetail = detail ?? null;
    this.dispatchEvent(new CustomEvent("status", { detail: { status, detail } }));
  }
}
