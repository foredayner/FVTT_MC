/**
 * Minecraft-style screen text over the 3D view: chat (bottom left, fades after a while),
 * title + subtitle (centre, with the server's fade timings) and the action bar (above the bottom).
 */
const TICK_MS = 50;
const CHAT_LINES = 8;
const CHAT_FADE_MS = 10000;
const ACTIONBAR_MS = 3000;

export class Hud3D {
  /** @param {HTMLElement} stage the .bwb-stage element */
  constructor(stage) {
    this.root = document.createElement("div");
    this.root.className = "bwb-hud";
    this.root.innerHTML = `
      <div class="bwb-hud-chat"></div>
      <div class="bwb-hud-title"><div class="bwb-hud-t"></div><div class="bwb-hud-s"></div></div>
      <div class="bwb-hud-actionbar"></div>`;
    stage.appendChild(this.root);
    this.chatBox = this.root.querySelector(".bwb-hud-chat");
    this.titleBox = this.root.querySelector(".bwb-hud-title");
    this.bar = this.root.querySelector(".bwb-hud-actionbar");
    this.timers = new Set();
  }

  later(fn, ms) {
    const t = setTimeout(() => { this.timers.delete(t); fn(); }, ms);
    this.timers.add(t);
    return t;
  }

  /** One chat line; it fades out after a while like in the game. */
  chat(text, kind = "chat") {
    if (!text) return;
    const line = document.createElement("div");
    line.className = `bwb-hud-line bwb-hud-line-${kind}`;
    line.textContent = text;
    this.chatBox.appendChild(line);
    while (this.chatBox.childElementCount > CHAT_LINES) this.chatBox.firstElementChild.remove();
    this.later(() => line.classList.add("faded"), CHAT_FADE_MS);
  }

  /** @param {{text:string, subtitle?:string, times?:{fadeIn:number, stay:number, fadeOut:number}}} t ticks */
  title({ text, subtitle = "", times = { fadeIn: 10, stay: 70, fadeOut: 20 } }) {
    for (const t of this.titleTimers ?? []) { clearTimeout(t); this.timers.delete(t); }
    const box = this.titleBox;
    box.querySelector(".bwb-hud-t").textContent = text ?? "";
    box.querySelector(".bwb-hud-s").textContent = subtitle ?? "";
    box.style.transition = "none";
    box.style.opacity = "0";
    void box.offsetWidth; // restart the fade
    box.style.transition = `opacity ${Math.max(0, times.fadeIn) * TICK_MS}ms linear`;
    box.style.opacity = "1";
    this.titleTimers = [
      this.later(() => {
        box.style.transition = `opacity ${Math.max(0, times.fadeOut) * TICK_MS}ms linear`;
        box.style.opacity = "0";
      }, (Math.max(0, times.fadeIn) + Math.max(0, times.stay)) * TICK_MS)
    ];
  }

  clearTitle() {
    for (const t of this.titleTimers ?? []) { clearTimeout(t); this.timers.delete(t); }
    this.titleBox.style.transition = "none";
    this.titleBox.style.opacity = "0";
  }

  actionbar(text) {
    clearTimeout(this.barTimer);
    this.timers.delete(this.barTimer);
    this.bar.textContent = text ?? "";
    this.bar.classList.remove("faded");
    this.barTimer = this.later(() => this.bar.classList.add("faded"), ACTIONBAR_MS);
  }

  /** Relay event -> screen. `key` is whose 3D view this is. */
  handle(ev, key) {
    if (!ev) return;
    if (ev.kind === "chat") return this.chat(ev.text);
    if (ev.key !== key) return; // titles, deaths etc. belong to one character
    if (ev.kind === "hud") {
      if (ev.slot === "title") this.title(ev);
      else if (ev.slot === "actionbar") this.actionbar(ev.text);
      else if (ev.slot === "clear") this.clearTitle();
    } else if (ev.kind === "death" || ev.kind === "kicked") this.chat(ev.text, "warn");
  }

  destroy() {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    this.root.remove();
  }
}
