// The window that opens when a character looks at a clue: what is there at a glance, what has
// been found out, the checks still to try, and (for a clue that can be carried) taking it.
// The GM sees every page, and can show pages or a hidden clue, or remove the clue.

import { MODULE_ID, L } from "../constants.js";
import { rules } from "./rules.js";
import { esc } from "./store.js";

const { ApplicationV2 } = foundry.applications.api;

export class ClueView extends ApplicationV2 {
  constructor(system, placeId, options = {}) {
    super({ ...options, id: `bwb-clue-${placeId}` });
    this.system = system;
    this.placeId = placeId;
    this._redraw = foundry.utils.debounce(() => this.rendered && this.render(), 100);
    this._hooks = [
      ["updateScene", Hooks.on("updateScene", (s) => { if (s.id === canvas.scene?.id) this._redraw(); })],
      ["updateJournalEntry", Hooks.on("updateJournalEntry", () => this._redraw())],
      ["updateJournalEntryPage", Hooks.on("updateJournalEntryPage", () => this._redraw())]
    ];
  }

  static DEFAULT_OPTIONS = {
    classes: ["bwb", "bwb-clue-view"],
    tag: "section",
    window: { title: "BWB.Clue.Title", icon: "fa-solid fa-magnifying-glass", resizable: true },
    position: { width: 380, height: "auto" },
    actions: {
      take: ClueView.#take,
      check: ClueView.#check,
      journal: ClueView.#journal,
      reveal: ClueView.#reveal,
      revealPage: ClueView.#revealPage,
      remove: ClueView.#remove,
      config: ClueView.#config
    }
  };

  get title() {
    return this.system.get(this.placeId)?.name ?? L("Clue.Title");
  }

  async _renderHTML() {
    const c = this.system.get(this.placeId);
    if (!c) return `<p>${esc(L("Clue.Gone"))}</p>`;
    const journal = await fromUuid(c.uuid);
    const me = game.user;
    const isGM = me.isGM;
    const r = rules();
    const pages = journal ? journal.pages.contents.sort((a, b) => a.sort - b.sort) : [];
    const can = (doc) => isGM || doc?.testUserPermission?.(me, "OBSERVER");
    const parts = [];
    const first = pages[0];
    parts.push(`<div class="bwb-clue-surface">${first && can(first) ? first.text?.content ?? "" : esc(c.surface).replace(/\n/g, "<br>")}</div>`);
    for (const p of pages.slice(1)) {
      const check = p.getFlag(MODULE_ID, "check");
      const how = check?.skill ? `${r.skillLabel(check.skill)} · ${L(`Clue.Difficulty.${check.difficulty ?? "regular"}`)}` : L("Clue.GmOnly");
      if (can(p)) {
        const shown = Object.values(p.ownership ?? {}).some((v) => v >= CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER);
        parts.push(`<fieldset class="bwb-clue-more"><legend>${esc(p.name)}${isGM ? ` <small>(${esc(how)}${shown ? " ✓" : ""})</small>` : ""}</legend>${p.text?.content ?? ""}`
          + (isGM && !shown ? `<button type="button" data-action="revealPage" data-page="${p.id}">${esc(L("Clue.ShowPage"))}</button>` : "")
          + `</fieldset>`);
        continue;
      }
      if (!check?.skill) continue;
      const tried = c.tried?.[`${me.id}:${p.id}`];
      parts.push(tried === undefined
        ? `<button type="button" class="bwb-clue-check" data-action="check" data-page="${p.id}"><i class="fa-solid fa-dice-d20"></i> ${esc(check.label || L("Clue.MoreCheck"))} (${esc(how)})</button>`
        : `<p class="bwb-hint">${esc(check.label || L("Clue.MoreCheck"))}: ${esc(L("Clue.CheckFailed"))}</p>`);
    }
    if (c.kind === "item") {
      parts.push(c.takenBy
        ? `<p class="bwb-hint">${esc(L("Clue.Taken", { who: c.takerName }))}</p>`
        : `<button type="button" data-action="take"><i class="fa-solid fa-hand"></i> ${esc(L("Clue.Take"))}</button>`);
    }
    const row = [];
    if (journal && can(journal)) row.push(`<button type="button" data-action="journal"><i class="fa-solid fa-book-open"></i> ${esc(L("Clue.OpenJournal"))}</button>`);
    if (isGM) {
      if (!c.revealed) row.push(`<button type="button" data-action="reveal"><i class="fa-solid fa-eye"></i> ${esc(L("Clue.Reveal"))}</button>`);
      row.push(`<button type="button" data-action="config"><i class="fa-solid fa-gear"></i> ${esc(L("Clue.Config"))}</button>`);
      row.push(`<button type="button" data-action="remove"><i class="fa-solid fa-trash"></i> ${esc(L("Clue.Remove"))}</button>`);
    }
    if (row.length) parts.push(`<div class="bwb-row">${row.join("")}</div>`);
    return parts.join("");
  }

  _replaceHTML(result, content) {
    content.innerHTML = result;
  }

  _onClose(options) {
    super._onClose?.(options);
    for (const [name, id] of this._hooks) Hooks.off(name, id);
    this.system.views.delete(this.placeId);
  }

  static #take() { this.system.request("take", this.placeId); }

  static #check(event, target) { this.system.request("check", this.placeId, target.dataset.page); }

  static async #journal() {
    const c = this.system.get(this.placeId);
    (await fromUuid(c?.uuid))?.sheet.render(true);
  }

  static #reveal() { this.system.revealHidden(this.placeId); }

  static #revealPage(event, target) { this.system.revealPage(this.placeId, target.dataset.page); }

  static async #remove() {
    const ok = await foundry.applications.api.DialogV2.confirm({ window: { title: L("Clue.Remove") }, content: `<p>${esc(L("Clue.RemoveAsk"))}</p>` });
    if (!ok) return;
    await this.system.remove(this.placeId);
    this.close();
  }

  static async #config() {
    const c = this.system.get(this.placeId);
    const j = await fromUuid(c?.uuid);
    if (j) this.system.configure(j);
  }
}
