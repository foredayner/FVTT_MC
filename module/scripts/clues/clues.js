// The clue system: clues placed on the map, noticed, looked at, picked up and checked.
//
// The GM who talks to the relay is the authority: players ask (over the module socket), the GM
// checks distance and line of sight, rolls, and changes journals' ownership. Everyone draws the
// clues they may see (clue-layer.js) and opens the clue window (clue-view.js).

import { MODULE_ID, SOCKET, L } from "../constants.js";
import { mcToScene } from "../coords.js";
import { rules } from "./rules.js";
import { clueSettings, newPlaced, visibleTo, audience, within, plainText, readClueFile, DEFAULT_CLUE, esc } from "./store.js";
import { ClueLayer } from "./clue-layer.js";
import { StairsLayer, readStairs } from "./stairs-layer.js";
import { ClueView } from "./clue-view.js";
import { ClueConfig } from "./clue-config.js";
import { ClueBoard } from "./clue-board.js";
import { sceneToMc } from "../coords.js";

const OBSERVER = () => CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER;
const NONE = () => CONST.DOCUMENT_OWNERSHIP_LEVELS.NONE;
/** A character must stand this close to look at a clue (blocks). */
const REACH = 3;

export class ClueSystem {
  constructor(bridge) {
    this.bridge = bridge;
    this.hub = bridge.hub;
    this.layer = new ClueLayer(this);
    this.stairs = new StairsLayer(this);
    this.views = new Map();      // placeId -> ClueView (mine)
    this.rolling = new Set();    // "placeId:userId" spot checks in progress
    this.gmPages = new Map();    // journal uuid -> lines about its later pages (GM tooltip)
    this.queue = Promise.resolve();
    game.socket.on(SOCKET, (data, sender) => this.onSocket(data, sender));
    if (game.user.isGM) {
      const tick = foundry.utils.throttle(() => this.discover(), 400);
      this.hub.addEventListener("state", (ev) => { tick(); this.followItems(ev.detail); });
      this.hub.addEventListener("event", (ev) => this.onRelayEvent(ev.detail));
      this.hub.addEventListener("status", (ev) => { if (ev.detail?.status === "connected") this.syncRelay(); });
    }
  }

  // ---------------- data ----------------

  get mode() {
    try { return game.settings.get(MODULE_ID, "clueMode"); } catch { return "party"; }
  }

  /** The map scene being looked at, if it is one. */
  get scene() {
    const s = canvas.scene;
    return s?.getFlag(MODULE_ID, "map") ? s : null;
  }

  placed(scene = this.scene) {
    return scene?.getFlag(MODULE_ID, "clues") ?? {};
  }

  get(id, scene = this.scene) {
    return this.placed(scene)[id] ?? null;
  }

  /** GM: change one placed clue (deep-merged). */
  async save(id, change, scene = this.scene) {
    if (!scene) return;
    await scene.update({ [`flags.${MODULE_ID}.clues.${id}`]: change });
  }

  isHost() { return this.hub.isRelayHost; }

  /** The Foundry user who plays a character (bot key = user id) and that character's actor. */
  actorFor(userId, scene = this.scene) {
    const token = scene?.tokens.find((t) => t.getFlag(MODULE_ID, "botKey") === userId);
    return token?.actor ?? game.users.get(userId)?.character ?? null;
  }

  userName(userId) {
    return this.hub.bots.find((b) => b.key === userId)?.username ?? game.users.get(userId)?.name ?? "?";
  }

  /** GM: what a clue's later pages hold (for the tooltip). */
  async loadGmPages(c) {
    const j = await fromUuid(c.uuid);
    if (!j) return;
    const r = rules();
    const open = (p) => Object.values(p.ownership ?? {}).some((v) => v >= OBSERVER());
    this.gmPages.set(c.uuid, j.pages.contents.sort((a, b) => a.sort - b.sort).slice(1).map((p) => {
      const k = p.getFlag(MODULE_ID, "check");
      const how = k?.skill ? `${r.skillLabel(k.skill)} (${L(`Clue.Difficulty.${k.difficulty ?? "regular"}`)})` : L("Clue.GmOnly");
      return `${p.name}: ${how}${open(p) ? " ✓" : ""}`;
    }));
  }

  // ---------------- placing (GM) ----------------

  /** Make a journal a clue (default settings) if it is not one yet; hide its later pages. */
  async prepareJournal(journal) {
    if (!journal.getFlag(MODULE_ID, "clue")) await journal.setFlag(MODULE_ID, "clue", { ...DEFAULT_CLUE });
    const pages = journal.pages.contents.sort((a, b) => a.sort - b.sort);
    const hide = pages.slice(1).filter((p) => !p.getFlag(MODULE_ID, "hidden"))
      .map((p) => ({ _id: p.id, "ownership.default": NONE(), [`flags.${MODULE_ID}.hidden`]: true }));
    if (hide.length) await journal.updateEmbeddedDocuments("JournalEntryPage", hide);
    return clueSettings(journal.getFlag(MODULE_ID, "clue"));
  }

  surfaceOf(journal) {
    const first = journal.pages.contents.sort((a, b) => a.sort - b.sort)[0];
    return plainText(first?.text?.content ?? "").slice(0, 600);
  }

  /** Put a clue (journal) at block x,z of the map scene; y: where it floats (default: just over the floor there). */
  async place(journal, at, scene = this.scene) {
    if (!scene) throw new Error(L("Clue.NoMapScene"));
    const map = scene.getFlag(MODULE_ID, "map");
    let y = at.y;
    if (!Number.isInteger(y)) {
      const h = this.bridge.mapView?.walls?.heightAt(map.dim ?? "overworld", at.x, at.z);
      y = h === null || h === undefined ? null : h + 1;
    }
    if (!Number.isInteger(y)) {
      const near = [...this.hub.positions.values()].sort((a, b) => Math.hypot(a.x - at.x, a.z - at.z) - Math.hypot(b.x - at.x, b.z - at.z))[0];
      y = near ? Math.floor(near.y) : 64;
    }
    const settings = await this.prepareJournal(journal);
    const id = foundry.utils.randomID(12);
    const c = newPlaced(id, { uuid: journal.uuid, name: journal.name, surface: this.surfaceOf(journal) }, settings,
      { x: at.x, y, z: at.z, dim: map.dim ?? "overworld" });
    await this.save(id, c, scene);
    if (c.revealed) await this.relayPlace(c);
    return c;
  }

  async relayPlace(c) {
    if (!this.hub.relay) return;
    try { await this.hub.relay.call("cluePlace", { clue: c.id, x: c.x, y: c.y, z: c.z, item: c.item }); } catch (err) { ui.notifications.warn(`${L("Clue.PlaceFailed")}: ${err.message}`); }
  }

  async remove(id, scene = this.scene) {
    try { await this.hub.relay?.call("clueRemove", { clue: id }); } catch { /* the object may be gone already */ }
    await scene.update({ [`flags.${MODULE_ID}.clues.-=${id}`]: null });
  }

  /** After (re)connecting: tell the relay where the clues are (the objects stay in the world). */
  async syncRelay() {
    if (!this.isHost() || !this.hub.relay) return;
    const list = [];
    for (const scene of game.scenes) {
      if (!scene.getFlag(MODULE_ID, "map")) continue;
      for (const c of Object.values(this.placed(scene))) if (c.revealed) list.push({ clue: c.id, x: c.x, y: c.y, z: c.z, item: c.item });
    }
    try { await this.hub.relay.call("clueKnown", { list }); } catch { /* older relay */ }
  }

  /** The scenario builder's clues file: a journal per clue (in a folder), each placed where it was built. */
  async importFile(data, scene = this.scene) {
    const { scenario, clues } = readClueFile(data);
    const stairs = readStairs(data);
    if (!clues.length && !stairs.length) throw new Error(L("Clue.ImportEmpty"));
    // The flights of stairs replace any from an earlier file.
    if (stairs.length) await scene.setFlag(MODULE_ID, "stairs", stairs);
    if (!clues.length) return 0;
    const folder = await Folder.create({ name: `${L("Clue.Folder")}: ${scenario || L("Clue.Imported")}`, type: "JournalEntry" });
    const ruleSet = rules();
    let n = 0;
    for (const c of clues) {
      const pages = [{ name: L("Clue.SurfacePage"), type: "text", text: { content: `<p>${esc(c.text).replace(/\n/g, "<br>")}</p>` } }];
      for (const k of c.checks) {
        pages.push({
          name: k.label || ruleSet.skillLabel(k.skill), type: "text", text: { content: `<p>${esc(k.text).replace(/\n/g, "<br>")}</p>` },
          ownership: { default: NONE() },
          flags: { [MODULE_ID]: { hidden: true, check: { skill: k.skill, difficulty: k.difficulty, label: k.label } } }
        });
      }
      const journal = await JournalEntry.create({
        name: c.name, folder: folder.id, pages,
        flags: { [MODULE_ID]: { clue: { kind: c.kind, item: c.item, radius: c.radius, spot: "regular", icon: "" } } }
      });
      await this.place(journal, { x: c.x, y: c.y, z: c.z }, scene);
      n++;
    }
    return n;
  }

  /** GM: a journal dropped on the map scene becomes a clue lying there. */
  async dropJournal(data) {
    const scene = this.scene;
    if (!scene || !game.user.isGM) return false;
    const journal = await fromUuid(data.uuid);
    if (!(journal instanceof JournalEntry)) return false;
    const map = scene.getFlag(MODULE_ID, "map");
    const dims = { grid: scene.grid.size, sceneX: canvas.dimensions.sceneX, sceneY: canvas.dimensions.sceneY };
    const mc = sceneToMc({ x: data.x, y: data.y }, map, dims);
    try {
      await this.place(journal, { x: Math.floor(mc.x), z: Math.floor(mc.z) }, scene);
      ui.notifications.info(L("Clue.Placed", { name: journal.name }));
    } catch (err) { ui.notifications.warn(err.message); }
    return true;
  }

  configure(journal) {
    new ClueConfig(journal).render({ force: true });
  }

  openBoard() {
    this.board ??= new ClueBoard(this);
    this.board.render({ force: true });
  }

  /** GM: after a journal's settings changed, its placed copies follow (and their objects in the world). */
  async refreshPlaced(journal) {
    const s = clueSettings(journal.getFlag(MODULE_ID, "clue"));
    for (const scene of game.scenes) {
      if (!scene.getFlag(MODULE_ID, "map")) continue;
      for (const c of Object.values(this.placed(scene))) {
        if (c.uuid !== journal.uuid) continue;
        const change = { name: journal.name, surface: this.surfaceOf(journal), kind: s.kind, item: s.item, radius: s.radius, spotDifficulty: s.spot, icon: s.icon || "" };
        if (s.kind !== "hidden" && !c.revealed) change.revealed = true;
        await this.save(c.id, change, scene);
        if ((change.revealed || c.revealed) && (c.item !== s.item || change.revealed)) await this.relayPlace({ ...c, ...change });
      }
    }
  }

  // ---------------- noticing (GM) ----------------

  /** Can a character at pos see the clue (walls of the scene in between)? */
  lineOfSight(scene, pos, c) {
    const map = scene.getFlag(MODULE_ID, "map");
    const dims = { grid: scene.grid.size, sceneX: canvas.dimensions.sceneX, sceneY: canvas.dimensions.sceneY };
    const a = mcToScene({ x: pos.x, z: pos.z }, map, dims);
    const b = mcToScene({ x: c.x + 0.5, z: c.z + 0.5 }, map, dims);
    const backend = CONFIG.Canvas?.polygonBackends?.sight;
    if (!backend?.testCollision) return true;
    try { return !backend.testCollision(a, b, { type: "sight", mode: "any" }); } catch { return true; }
  }

  /** Every few tenths of a second: characters near clues see them; hidden ones get one perception check each. */
  discover() {
    const scene = this.scene;
    if (!scene || !this.isHost()) return;
    const placed = Object.values(this.placed(scene));
    if (!placed.length) return;
    const dim = scene.getFlag(MODULE_ID, "map").dim ?? "overworld";
    const seen = {};
    for (const bot of this.hub.bots) {
      if (!bot.online) continue;
      const pos = this.hub.positions.get(bot.key);
      if (!pos || (pos.dim ?? "overworld") !== dim) continue;
      for (const c of placed) {
        if (!within(pos, c, c.radius) || !this.lineOfSight(scene, pos, c)) continue;
        if (!c.revealed) {
          if (c.kind === "hidden" && !c.spotted?.[bot.key]) this.spotCheck(scene, c.id, bot.key);
          continue;
        }
        const who = audience(this.mode, bot.key);
        if (!c.seen?.[who]) (seen[c.id] ??= {})[who] = true;
      }
    }
    for (const [id, who] of Object.entries(seen)) this.save(id, { seen: who }, scene).catch(() => {});
  }

  /** The automatic perception check for a hidden clue: once per character. */
  spotCheck(scene, id, userId) {
    const k = `${id}:${userId}`;
    if (this.rolling.has(k)) return;
    this.rolling.add(k);
    this.queue = this.queue.then(async () => {
      const c = this.get(id, scene);
      if (!c || c.revealed || c.spotted?.[userId]) return;
      const r = rules();
      const actor = this.actorFor(userId, scene);
      const res = await r.check(actor, r.perception, c.spotDifficulty ?? "regular", { blind: true, flavor: L("Clue.SpotFlavor", { name: c.name, who: this.userName(userId) }) });
      if (!res.success) {
        await this.save(id, { spotted: { [userId]: "fail" } }, scene);
        return;
      }
      await this.save(id, { spotted: { [userId]: "ok" }, revealed: true, seen: { [audience(this.mode, userId)]: true } }, scene);
      await this.relayPlace({ ...c, revealed: true });
      this.tell(userId, { t: "clueNotice", place: id });
    }).catch((err) => console.warn(`${MODULE_ID} | spot`, err)).finally(() => this.rolling.delete(k));
  }

  /** GM: show a hidden clue to everyone (or one player) without a check. */
  async revealHidden(id, userId = null) {
    const c = this.get(id);
    if (!c) return;
    const who = userId ? audience(this.mode, userId) : "*";
    await this.save(id, { revealed: true, seen: { [who]: true } });
    await this.relayPlace({ ...c, revealed: true });
    for (const u of game.users) if (!u.isGM && (!userId || u.id === userId)) this.tell(u.id, { t: "clueNotice", place: id });
  }

  // ---------------- looking, taking, checking (GM decides) ----------------

  /** Wait (a while) for a character to come within reach of a clue, walking it there first. */
  async approach(userId, c) {
    const near = () => { const p = this.hub.positions.get(userId); return p && within(p, c, REACH); };
    if (near()) return true;
    const p = this.hub.positions.get(userId);
    if (!p) return false;
    // A spot next to the clue, on the character's side.
    const dx = p.x - (c.x + 0.5); const dz = p.z - (c.z + 0.5); const d = Math.hypot(dx, dz) || 1;
    try { await this.hub.relay.call("moveTo", { key: userId, x: c.x + 0.5 + (dx / d) * 1.5, z: c.z + 0.5 + (dz / d) * 1.5 }); } catch { return false; }
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 250));
      if (near()) return true;
      if (i > 8 && !this.hub.positions.get(userId)?.moving) break;
    }
    return near();
  }

  /** Grant a journal (or one page) to whoever a discovery is for. */
  async grant(doc, userId) {
    const who = audience(this.mode, userId);
    if (who === "*") {
      if ((doc.ownership?.default ?? 0) < OBSERVER()) await doc.update({ "ownership.default": OBSERVER() });
    } else if ((doc.ownership?.[userId] ?? -1) < OBSERVER()) {
      await doc.update({ [`ownership.${userId}`]: OBSERVER() });
    }
  }

  async handle(userId, op, id, pageId) {
    const scene = this.scene;
    const c = this.get(id, scene);
    if (!c) throw new Error(L("Clue.Gone"));
    const user = game.users.get(userId);
    if (!user) return;
    if (!user.isGM && !visibleTo(c, userId, false)) throw new Error(L("Clue.NotSeen"));
    const journal = await fromUuid(c.uuid);
    if (!journal) throw new Error(L("Clue.NoJournal"));
    if (!user.isGM && !(await this.approach(userId, c))) throw new Error(L("Clue.TooFar"));

    if (op === "use") {
      await this.grant(journal, userId);
      if (!c.found?.[userId]) {
        await this.save(id, { found: { [userId]: true } }, scene);
        if (!user.isGM) this.announce(userId, L("Clue.Found", { who: this.userName(userId), name: c.name }));
      }
    } else if (op === "take") {
      if (c.kind !== "item") throw new Error(L("Clue.NotItem"));
      if (c.takenBy) throw new Error(L("Clue.Taken", { who: c.takerName }));
      await this.hub.relay.call("clueGive", { key: userId, clue: c.id, title: c.name, text: c.surface, item: c.item });
      await this.grant(journal, userId);
      await this.save(id, { takenBy: userId, takerName: this.userName(userId), found: { [userId]: true } }, scene);
      this.announce(userId, L("Clue.TookIt", { who: this.userName(userId), name: c.name }));
    } else if (op === "check") {
      const page = journal.pages.get(pageId);
      const check = page?.getFlag(MODULE_ID, "check");
      if (!check?.skill) throw new Error(L("Clue.NoCheck"));
      const key = `${userId}:${pageId}`;
      if (c.tried?.[key] !== undefined) throw new Error(L("Clue.Tried"));
      const res = await rules().check(this.actorFor(userId, scene), check.skill, check.difficulty ?? "regular",
        { flavor: `${c.name}: ${check.label || page.name}` });
      await this.save(id, { tried: { [key]: res.success } }, scene);
      if (res.success) {
        await this.grant(journal, userId);
        await this.grant(page, userId);
        this.announce(userId, L("Clue.MoreFound", { who: this.userName(userId), name: page.name }));
      }
    }
    this.tell(userId, { t: "clueOpen", place: id });
  }

  /** GM: reveal one page of a clue (to everyone, or to one player). */
  async revealPage(id, pageId, userId = null) {
    const c = this.get(id);
    const journal = c && await fromUuid(c.uuid);
    const page = journal?.pages.get(pageId);
    if (!page) return;
    if (userId) { await this.grant(journal, userId); await this.grant(page, userId); } else {
      await journal.update({ "ownership.default": OBSERVER() });
      await page.update({ "ownership.default": OBSERVER() });
    }
  }

  announce(userId, text) {
    const whisper = this.mode === "private" ? [userId, ...game.users.filter((u) => u.isGM).map((u) => u.id)] : [];
    ChatMessage.create({ content: `<p class="bwb-clue-msg"><i class="fa-solid fa-magnifying-glass"></i> ${esc(text)}</p>`, whisper, speaker: { alias: L("Clue.Alias") } });
  }

  /**
   * Who holds a picked-up clue: if its item turns up in another character's inventory (given or
   * picked up), that character gets it (and, in a private game, its journal).
   */
  followItems(state) {
    if (!this.isHost() || !state?.bots) return;
    const scene = this.scene;
    if (!scene) return;
    for (const c of Object.values(this.placed(scene))) {
      if (!c.takenBy) continue;
      const holder = state.bots.find((b) => b.key !== c.takenBy && (b.named ?? []).includes(c.name.slice(0, 32)));
      const stillHas = state.bots.find((b) => b.key === c.takenBy)?.named?.includes(c.name.slice(0, 32));
      if (!holder || stillHas) continue;
      this.save(c.id, { takenBy: holder.key, takerName: this.userName(holder.key), found: { [holder.key]: true } }, scene).catch(() => {});
      fromUuid(c.uuid).then(async (j) => {
        if (!j || this.mode !== "private") return;
        await this.grant(j, holder.key);
        for (const p of j.pages) if ((p.ownership?.[c.takenBy] ?? -1) >= OBSERVER()) await this.grant(p, holder.key);
      }).catch(() => {});
    }
  }

  onRelayEvent(ev) {
    if (!ev || !this.isHost()) return;
    if (ev.kind === "clue") this.handle(ev.key, "use", ev.id).catch((err) => this.tell(ev.key, { t: "clueError", text: err.message }));
    if (ev.kind === "read") this.read(ev.key, ev.name);
  }

  /** A book or clue item read in hand: open its clue (if it is one this player has). */
  read(userId, name) {
    for (const c of Object.values(this.placed())) {
      if (c.name.slice(0, 32) === String(name ?? "").slice(0, 32)) { this.tell(userId, { t: "clueRead", uuid: c.uuid }); return; }
    }
    this.tell(userId, { t: "clueError", text: L("Clue.JustAnItem", { name }) });
  }

  // ---------------- messages ----------------

  /** Send to one user (or handle it here when that is me). */
  tell(userId, msg) {
    if (userId === game.user.id) return this.onMessage(msg);
    game.socket.emit(SOCKET, { ...msg, to: userId });
  }

  /** Ask the GM for something about a clue. */
  async request(op, id, pageId) {
    if (this.isHost()) {
      try { await this.handle(game.user.id, op, id, pageId); } catch (err) { ui.notifications.warn(err.message); }
      return;
    }
    game.socket.emit(SOCKET, { t: "clueReq", from: game.user.id, op, place: id, page: pageId });
  }

  onSocket(data, sender) {
    if (!data || typeof data !== "object") return;
    if (data.t === "clueReq") {
      if (!this.isHost()) return;
      const from = (typeof sender === "string" && game.users.get(sender)) ? sender : data.from;
      if (!["use", "take", "check"].includes(data.op)) return;
      this.handle(from, data.op, data.place, data.page).catch((err) => this.tell(from, { t: "clueError", text: err.message }));
      return;
    }
    if (data.to === game.user.id) this.onMessage(data);
  }

  onMessage(msg) {
    switch (msg.t) {
      case "clueOpen": this.open(msg.place); break;
      case "clueNotice": {
        const c = this.get(msg.place);
        ui.notifications.info(L("Clue.Noticed", { name: c?.name ?? "" }));
        this.layer.ping(msg.place);
        break;
      }
      case "clueRead": fromUuid(msg.uuid).then((j) => j?.testUserPermission(game.user, "OBSERVER") ? j.sheet.render(true) : ui.notifications.info(L("Clue.CannotRead"))); break;
      case "clueError": ui.notifications.warn(msg.text); break;
    }
  }

  /** Open (or refresh) the clue window. */
  open(id) {
    let v = this.views.get(id);
    if (!v) { v = new ClueView(this, id); this.views.set(id, v); }
    v.render({ force: true });
  }
}
