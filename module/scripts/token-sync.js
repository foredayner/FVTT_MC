import { MODULE_ID } from "./constants.js";
import { tokenTopLeft, yawToRotation, inMap } from "./coords.js";

const MIN_MOVE_BLOCKS = 0.2;
/** A bit longer than the relay's state interval (0.1 s), so the token arrives just as the next update comes. */
const STEP_MS = 120;
/** Further than this in one update (teleport, respawn): jump instead of sliding across the map. */
const JUMP_BLOCKS = 8;

/**
 * Update options for following the bot. Since V13, x/y updates are token *movement*: animated at
 * CONFIG.Token.movement.defaultSpeed (6 squares/s) unless told otherwise, constrained like a
 * player's move, and the old `animation` option alone is not enough. A sprinting character
 * (~5.6 blocks/s) then outruns its token. The same options also work on older versions.
 */
export function followOptions(jump) {
  const opts = {
    method: "api",
    autoRotate: false,       // rotation comes from Minecraft
    showRuler: false,
    constrainOptions: { ignoreWalls: true, ignoreCost: true }, // the bot already walked it
    animation: { duration: STEP_MS, movementSpeed: 1000 }
  };
  if (jump) { opts.animate = false; opts.animation = { duration: 0 }; }
  return opts;
}

/**
 * GM only: keeps one Token per online bot on every map scene that is in use, following the bot's
 * position. "In use" = the scene the GM is looking at plus every scene an active player is viewing,
 * so a player on another map scene than the GM still has a token there (and so can see).
 * Minecraft owns the position; dragging the token in Foundry does not move the bot.
 *
 * Each bot gets an Actor owned by its Foundry user, so that player sees through the token
 * (Foundry only shares vision from tokens you own). Sight range = the vision radius setting.
 */
export class TokenSync {
  constructor(hub) {
    this.hub = hub;
    this.busy = false;
    this.again = false;
    this.last = new Map(); // "sceneId:key" -> {x,z,rot}
    hub.addEventListener("state", () => this.sync());
    hub.addEventListener("bots", () => this.sync(true));
    Hooks.on("updateSetting", (s) => { if (s.key === `${MODULE_ID}.visionRadius`) this.sync(true); });
    // A player went to another scene: give them their token there right away.
    Hooks.on("updateUser", (user, change) => { if ("viewedScene" in change) this.sync(true); });
    Hooks.on("userConnected", () => this.sync(true));
  }

  get radius() { return Number(game.settings.get(MODULE_ID, "visionRadius")) || 16; }

  async sync(force = false) {
    if (!this.hub.isRelayHost) return;
    if (this.busy) { this.again ||= force; return; }
    const scenes = mapScenesInUse();
    if (!scenes.length) return;
    this.busy = true;
    try {
      for (const scene of scenes) {
        try {
          await this.syncScene(scene, force);
        } catch (err) {
          console.error(`${MODULE_ID} | token sync (${scene.name})`, err);
        }
      }
    } finally {
      this.busy = false;
      if (this.again) { const f = this.again; this.again = false; this.sync(f); }
    }
  }

  async syncScene(scene, force) {
    const map = scene.getFlag(MODULE_ID, "map");
    const dims = sceneDims(scene);
    if (!map || !dims) return;
    const radius = this.radius;
    const tokens = scene.tokens.filter((t) => t.getFlag(MODULE_ID, "botKey"));
    const byKey = new Map();
    const remove = [];
    for (const t of tokens) {
      const key = t.getFlag(MODULE_ID, "botKey");
      // Tokens from 0.1.0 had no actor, so players could not see through them: replace them.
      if (!t.actorId || byKey.has(key)) remove.push(t.id);
      else byKey.set(key, t);
    }
    const create = [];
    const update = [];
    const jumps = [];

    for (const bot of this.hub.bots) {
      const pos = this.hub.positions.get(bot.key);
      const tok = byKey.get(bot.key);
      const lk = `${scene.id}:${bot.key}`;
      const visible = bot.online && pos && pos.dim === (map.dim ?? "overworld") && inMap(pos.x, pos.z, map);
      if (!visible) { if (tok && !tok.hidden) update.push({ _id: tok.id, hidden: true }); continue; }
      const tl = tokenTopLeft(pos, map, dims);
      const rotation = yawToRotation(pos.yaw);
      if (!tok) {
        create.push({ bot, data: this.newToken(bot, tl, rotation, pos.y, radius) });
        this.last.set(lk, { x: pos.x, z: pos.z, rot: rotation });
        continue;
      }
      const prev = this.last.get(lk);
      const moved = !prev || Math.hypot(pos.x - prev.x, pos.z - prev.z) >= MIN_MOVE_BLOCKS;
      const sightWrong = !tok.sight?.enabled || tok.sight?.range !== radius;
      if (force || moved || prev.rot !== rotation || tok.hidden || sightWrong) {
        const u = { _id: tok.id, x: tl.x, y: tl.y, rotation, elevation: Math.floor(pos.y), hidden: false };
        if (sightWrong) u.sight = { enabled: true, range: radius };
        const far = !prev || tok.hidden || Math.hypot(pos.x - prev.x, pos.z - prev.z) > JUMP_BLOCKS;
        (far ? jumps : update).push(u);
        this.last.set(lk, { x: pos.x, z: pos.z, rot: rotation });
      }
    }
    for (const [key, tok] of byKey) if (!this.hub.bots.some((b) => b.key === key)) remove.push(tok.id);

    if (remove.length) await scene.deleteEmbeddedDocuments("Token", remove);
    for (const { bot, data } of create) {
      const actor = await this.ensureActor(bot);
      await scene.createEmbeddedDocuments("Token", [{ ...data, actorId: actor.id, actorLink: true }]);
    }
    if (jumps.length) await scene.updateEmbeddedDocuments("Token", jumps, followOptions(true));
    if (update.length) await scene.updateEmbeddedDocuments("Token", update, followOptions(false));
  }

  newToken(bot, tl, rotation, y, radius) {
    const user = game.users.get(bot.key);
    return {
      name: bot.username,
      x: tl.x, y: tl.y, rotation, elevation: Math.floor(y),
      width: 1, height: 1,
      texture: { src: user?.avatar || "icons/svg/mystery-man.svg" },
      displayName: CONST.TOKEN_DISPLAY_MODES.ALWAYS,
      disposition: CONST.TOKEN_DISPOSITIONS.FRIENDLY,
      sight: { enabled: true, range: radius },
      lockRotation: false,
      flags: { [MODULE_ID]: { botKey: bot.key } }
    };
  }

  /** One Actor per bot key, owned by that user, kept in a "Blockworld Bridge" folder. */
  async ensureActor(bot) {
    let actor = game.actors.find((a) => a.getFlag(MODULE_ID, "botKey") === bot.key);
    const ownership = { default: CONST.DOCUMENT_OWNERSHIP_LEVELS.NONE, [bot.key]: CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER };
    if (actor) {
      const change = {};
      if (actor.name !== bot.username) change.name = bot.username;
      if (actor.ownership?.[bot.key] !== CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER) change.ownership = ownership;
      if (Object.keys(change).length) await actor.update(change);
      return actor;
    }
    const user = game.users.get(bot.key);
    return Actor.create({
      name: bot.username,
      type: pickActorType(),
      img: user?.avatar || "icons/svg/mystery-man.svg",
      folder: (await this.folder())?.id ?? null,
      ownership,
      flags: { [MODULE_ID]: { botKey: bot.key } }
    });
  }

  async folder() {
    let f = game.folders.find((x) => x.type === "Actor" && x.getFlag(MODULE_ID, "folder"));
    if (!f) {
      try {
        f = await Folder.create({ name: "Blockworld Bridge", type: "Actor", flags: { [MODULE_ID]: { folder: true } } });
      } catch { f = null; }
    }
    return f;
  }
}

function pickActorType() {
  const types = (globalThis.Actor?.TYPES ?? game.documentTypes?.Actor ?? []).filter((t) => t !== "base");
  return types.includes("character") ? "character" : (types[0] ?? "character");
}

/** Map scenes someone is looking at: the GM's own canvas and every active player's viewed scene. */
export function mapScenesInUse() {
  const ids = new Set();
  if (canvas?.ready && canvas.scene) ids.add(canvas.scene.id);
  for (const u of game.users) if (u.active && u.viewedScene) ids.add(u.viewedScene);
  return [...ids].map((id) => game.scenes.get(id)).filter((s) => s?.getFlag(MODULE_ID, "map"));
}

/**
 * Grid size and where the scene rectangle starts, for any scene (not only the one on the canvas).
 * Uses the live canvas for the scene being viewed; otherwise the scene's own computed dimensions.
 */
export function sceneDims(scene) {
  if (canvas?.ready && canvas.scene?.id === scene.id && canvas.dimensions) {
    return { grid: scene.grid.size, sceneX: canvas.dimensions.sceneX, sceneY: canvas.dimensions.sceneY };
  }
  const d = scene.getDimensions?.() ?? scene.dimensions;
  if (d && Number.isFinite(d.sceneX)) return { grid: scene.grid.size, sceneX: d.sceneX, sceneY: d.sceneY };
  return scene.padding ? null : { grid: scene.grid.size, sceneX: 0, sceneY: 0 }; // map scenes have no padding
}
