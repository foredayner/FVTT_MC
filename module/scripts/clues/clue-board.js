// GM: every clue on this map scene at a glance: what kind, whether it has been noticed, who
// failed to spot a hidden one (to show it by hand), who took it; plus importing the scenario
// builder's clues file.

import { MODULE_ID, L } from "../constants.js";
import { esc } from "./store.js";

const { ApplicationV2 } = foundry.applications.api;

export class ClueBoard extends ApplicationV2 {
  constructor(system, options = {}) {
    super(options);
    this.system = system;
    const redraw = foundry.utils.debounce(() => this.rendered && this.render(), 150);
    Hooks.on("updateScene", (s) => { if (s.id === canvas.scene?.id) redraw(); });
    Hooks.on("canvasReady", redraw);
  }

  static DEFAULT_OPTIONS = {
    id: "bwb-clue-board",
    classes: ["bwb", "bwb-clue-board"],
    tag: "section",
    window: { title: "BWB.Clue.Board", icon: "fa-solid fa-magnifying-glass", resizable: true },
    position: { width: 460, height: "auto" },
    actions: {
      open: ClueBoard.#open,
      reveal: ClueBoard.#reveal,
      remove: ClueBoard.#remove,
      import: ClueBoard.#import
    }
  };

  async _renderHTML() {
    const scene = this.system.scene;
    if (!scene) return `<p>${esc(L("Clue.NoMapScene"))}</p>`;
    const list = Object.values(this.system.placed(scene)).sort((a, b) => a.name.localeCompare(b.name));
    const rows = list.map((c) => {
      const fails = Object.entries(c.spotted ?? {}).filter(([, v]) => v === "fail").map(([u]) => this.system.userName(u));
      const seen = Object.keys(c.seen ?? {}).length > 0;
      const state = !c.revealed ? (fails.length ? L("Clue.SpotFailed", { who: fails.join(", ") }) : L("Clue.NotRevealed"))
        : c.takenBy ? L("Clue.Taken", { who: c.takerName }) : seen ? L("Clue.Seen") : L("Clue.Unseen");
      return `<li class="${!c.revealed && fails.length ? "bwb-clue-waiting" : ""}">
        <a data-action="open" data-id="${c.id}"><b>${esc(c.name)}</b></a>
        <small>${esc(L(`Clue.Kind.${c.kind}`))} · ${c.x}, ${c.y}, ${c.z}<br>${esc(state)}</small>
        <span class="bwb-clue-tools">
          ${c.revealed ? "" : `<button type="button" data-action="reveal" data-id="${c.id}" title="${esc(L("Clue.Reveal"))}"><i class="fa-solid fa-eye"></i></button>`}
          <button type="button" data-action="remove" data-id="${c.id}" title="${esc(L("Clue.Remove"))}"><i class="fa-solid fa-trash"></i></button>
        </span></li>`;
    }).join("");
    return `
      <p class="bwb-hint">${esc(L("Clue.BoardHint"))}</p>
      ${rows ? `<ul class="bwb-clue-list">${rows}</ul>` : `<p>${esc(L("Clue.NoneYet"))}</p>`}
      <div class="bwb-row"><button type="button" data-action="import"><i class="fa-solid fa-file-import"></i> ${esc(L("Clue.Import"))}</button></div>`;
  }

  _replaceHTML(result, content) { content.innerHTML = result; }

  static #open(event, target) { this.system.open(target.dataset.id); }

  static #reveal(event, target) { this.system.revealHidden(target.dataset.id); }

  static async #remove(event, target) {
    const ok = await foundry.applications.api.DialogV2.confirm({ window: { title: L("Clue.Remove") }, content: `<p>${esc(L("Clue.RemoveAsk"))}</p>` });
    if (ok) await this.system.remove(target.dataset.id);
  }

  static #import() {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json,application/json";
    input.addEventListener("change", async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const n = await this.system.importFile(JSON.parse(await file.text()));
        ui.notifications.info(L("Clue.ImportedN", { n }));
      } catch (err) {
        ui.notifications.error(`${L("Clue.ImportFailed")}: ${err.message}`);
      }
    });
    input.click();
  }
}
