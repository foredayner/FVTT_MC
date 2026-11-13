// GM: a journal's clue settings (kind, the item it shows as, how near it is noticed, the
// perception difficulty for a hidden one, its icon) and, for each later page, the check that
// reveals it.

import { MODULE_ID, L } from "../constants.js";
import { rules } from "./rules.js";
import { clueSettings, KINDS, ITEMS, esc } from "./store.js";

const { ApplicationV2 } = foundry.applications.api;

export class ClueConfig extends ApplicationV2 {
  constructor(journal, options = {}) {
    super({ ...options, id: `bwb-clue-config-${journal.id}` });
    this.journal = journal;
  }

  static DEFAULT_OPTIONS = {
    classes: ["bwb", "bwb-clue-config"],
    tag: "form",
    window: { title: "BWB.Clue.Config", icon: "fa-solid fa-magnifying-glass", resizable: true },
    position: { width: 460, height: "auto" },
    form: { handler: ClueConfig.#save, closeOnSubmit: true },
    actions: { pickIcon: ClueConfig.#pickIcon }
  };

  get title() { return `${L("Clue.Config")}: ${this.journal.name}`; }

  async _renderHTML() {
    const c = clueSettings(this.journal.getFlag(MODULE_ID, "clue"));
    const r = rules();
    const opt = (list, cur) => list.map(([v, label]) => `<option value="${esc(v)}" ${v === cur ? "selected" : ""}>${esc(label)}</option>`).join("");
    const diffs = r.difficulties.map((d) => [d.key, d.label]);
    const skills = [["", L("Clue.GmOnly")], ...r.skills.map((s) => [s.key, s.label])];
    const items = ITEMS.includes(c.item) ? ITEMS : [...ITEMS, c.item];
    const pages = this.journal.pages.contents.sort((a, b) => a.sort - b.sort);
    const rows = pages.slice(1).map((p) => {
      const k = p.getFlag(MODULE_ID, "check") ?? {};
      return `<tr><td>${esc(p.name)}</td>
        <td><select name="skill.${p.id}">${opt(skills, k.skill ?? "")}</select></td>
        <td><select name="diff.${p.id}">${opt(diffs, k.difficulty ?? "regular")}</select></td>
        <td><input type="text" name="label.${p.id}" value="${esc(k.label ?? "")}" placeholder="${esc(L("Clue.MoreCheck"))}"></td></tr>`;
    }).join("");
    return `
      <p class="bwb-hint">${esc(L("Clue.ConfigHint"))}</p>
      <div class="form-group"><label>${esc(L("Clue.KindLabel"))}</label>
        <select name="kind">${opt(KINDS.map((k) => [k, L(`Clue.Kind.${k}`)]), c.kind)}</select></div>
      <div class="form-group"><label>${esc(L("Clue.ItemLabel"))}</label>
        <select name="item">${opt(items.map((i) => [i, i]), c.item)}</select></div>
      <div class="form-group"><label>${esc(L("Clue.RadiusLabel"))}</label>
        <input type="number" name="radius" min="1" max="32" value="${c.radius}"></div>
      <div class="form-group"><label>${esc(L("Clue.SpotLabel"))}</label>
        <select name="spot">${opt(diffs, c.spot)}</select></div>
      <div class="form-group"><label>${esc(L("Clue.IconLabel"))}</label>
        <input type="text" name="icon" value="${esc(c.icon)}" placeholder="clue.svg">
        <button type="button" data-action="pickIcon"><i class="fa-solid fa-file-image"></i></button></div>
      <h4>${esc(L("Clue.PagesLabel"))}</h4>
      ${rows ? `<table class="bwb-clue-pages"><tr><th>${esc(L("Clue.Page"))}</th><th>${esc(L("Clue.Skill"))}</th><th>${esc(L("Clue.DifficultyLabel"))}</th><th>${esc(L("Clue.CheckName"))}</th></tr>${rows}</table>`
        : `<p class="bwb-hint">${esc(L("Clue.NoMorePages"))}</p>`}
      <button type="submit"><i class="fa-solid fa-save"></i> ${esc(L("Clue.Save"))}</button>`;
  }

  _replaceHTML(result, content) { content.innerHTML = result; }

  static async #pickIcon() {
    const input = this.element.querySelector('[name="icon"]');
    const FP = foundry.applications.apps?.FilePicker?.implementation ?? globalThis.FilePicker;
    new FP({ type: "image", current: input.value, callback: (path) => { input.value = path; } }).render(true);
  }

  static async #save(event, form, formData) {
    const d = formData.object;
    await this.journal.setFlag(MODULE_ID, "clue", clueSettings({ kind: d.kind, item: d.item, radius: d.radius, spot: d.spot, icon: d.icon }));
    const updates = [];
    for (const p of this.journal.pages.contents.sort((a, b) => a.sort - b.sort).slice(1)) {
      const skill = d[`skill.${p.id}`] ?? "";
      updates.push({
        _id: p.id,
        [`flags.${MODULE_ID}.check`]: skill ? { skill, difficulty: d[`diff.${p.id}`] ?? "regular", label: d[`label.${p.id}`] ?? "" } : null,
        ...(p.getFlag(MODULE_ID, "hidden") ? {} : { "ownership.default": CONST.DOCUMENT_OWNERSHIP_LEVELS.NONE, [`flags.${MODULE_ID}.hidden`]: true })
      });
    }
    if (updates.length) await this.journal.updateEmbeddedDocuments("JournalEntryPage", updates);
    // Placed copies keep the name, surface and settings they show on the map in step.
    const system = game.modules.get(MODULE_ID).api?.clues;
    await system?.refreshPlaced(this.journal);
  }
}
