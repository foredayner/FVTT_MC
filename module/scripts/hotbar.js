// My character's Minecraft hotbar, at the bottom of the screen while it is in the game.
// As in Minecraft: 1-9 pick a slot, Q throws what is in hand; click picks too, right-click reads a
// book or clue in that slot; drag a slot onto another character's token to hand it over (onto
// the map anywhere else: drop it). The number keys and Q only act in map mode, so Foundry's own
// shortcuts (macro hotbar) keep working otherwise.

import { MODULE_ID, L } from "./constants.js";
import { esc } from "./clues/store.js";

const READABLE = /written_book|writable_book|^book$|^paper$|filled_map|^map$/;

export class Hotbar {
  constructor(bridge) {
    this.bridge = bridge;
    this.hub = bridge.hub;
    this.el = null;
    this.last = "";
    this.hub.addEventListener("state", () => this.update());
    this.hub.addEventListener("bots", () => this.update());
    window.addEventListener("keydown", (ev) => this.onKey(ev), true);
  }

  get mine() {
    const bot = this.hub.botFor(game.user.id);
    return bot?.online ? this.hub.positions.get(bot.key) ?? null : null;
  }

  ensure() {
    if (this.el) return this.el;
    this.el = document.createElement("div");
    this.el.id = "bwb-hotbar";
    this.el.addEventListener("click", (ev) => {
      const slot = ev.target.closest("[data-slot]");
      if (slot) this.select(Number(slot.dataset.slot));
    });
    this.el.addEventListener("contextmenu", (ev) => {
      ev.preventDefault();
      const slot = ev.target.closest("[data-slot]");
      if (slot) this.read(Number(slot.dataset.slot));
    });
    this.el.addEventListener("dragstart", (ev) => {
      const slot = ev.target.closest("[data-slot]");
      if (!slot) return;
      ev.dataTransfer.setData("text/plain", JSON.stringify({ type: "bwbHotbar", slot: Number(slot.dataset.slot) }));
    });
    document.body.appendChild(this.el);
    return this.el;
  }

  update() {
    const me = this.mine;
    const show = !!(me?.hotbar && canvas.scene?.getFlag(MODULE_ID, "map"));
    if (!show) { if (this.el) this.el.style.display = "none"; return; }
    const key = JSON.stringify([me.hotbar, me.sel]);
    const el = this.ensure();
    el.style.display = "flex";
    if (key === this.last) return;
    this.last = key;
    el.innerHTML = me.hotbar.map((it, i) => `<div class="bwb-slot${i === me.sel ? " bwb-sel" : ""}" data-slot="${i}" draggable="${it ? "true" : "false"}"
      title="${it ? esc(it.t) : ""}"><span class="bwb-slot-key">${i + 1}</span>${it ? `<span class="bwb-slot-name">${esc(short(it.t))}</span>${it.c > 1 ? `<span class="bwb-slot-count">${it.c}</span>` : ""}` : ""}</div>`).join("");
  }

  select(slot) {
    this.hub.tryIntent({ type: "hotbar", key: game.user.id, slot });
  }

  /** Right-click a slot: read a book or a clue item (its clue's journal, if I have it). */
  read(slot) {
    const it = this.mine?.hotbar?.[slot];
    if (!it) return;
    const clues = this.bridge.clues;
    const c = Object.values(clues.placed()).find((p) => p.name.slice(0, 32) === it.t);
    if (c) {
      fromUuid(c.uuid).then((j) => j?.testUserPermission(game.user, "OBSERVER") ? j.sheet.render(true) : ui.notifications.info(L("Clue.CannotRead")));
      return;
    }
    ui.notifications.info(READABLE.test(it.n) ? L("Hotbar.Book", { name: it.t }) : L("Clue.JustAnItem", { name: it.t }));
  }

  /** A slot dropped on the map: onto another character's token = give, anywhere else = drop. */
  async dropOnCanvas(data) {
    await this.hub.intent({ type: "hotbar", key: game.user.id, slot: data.slot }).catch(() => {});
    const token = canvas.tokens?.placeables.find((t) => {
      const k = t.document.getFlag(MODULE_ID, "botKey");
      return k && k !== game.user.id && t.bounds?.contains(data.x, data.y);
    });
    if (token) return this.hub.tryIntent({ type: "giveItem", key: game.user.id, to: token.document.getFlag(MODULE_ID, "botKey") });
    return this.hub.tryIntent({ type: "dropItem", key: game.user.id });
  }

  onKey(ev) {
    if (!this.bridge.mapMode || !this.mine) return;
    const t = ev.target;
    if (t && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName))) return;
    if (ev.ctrlKey || ev.altKey || ev.metaKey) return;
    const m = /^Digit([1-9])$/.exec(ev.code);
    if (m) {
      ev.preventDefault(); ev.stopImmediatePropagation();
      this.select(Number(m[1]) - 1);
    } else if (ev.code === "KeyQ" && !ev.repeat) {
      ev.preventDefault(); ev.stopImmediatePropagation();
      this.hub.tryIntent({ type: "dropItem", key: game.user.id });
    }
  }
}

function short(s) {
  const t = String(s ?? "");
  return t.length > 9 ? `${t.slice(0, 8)}…` : t;
}
