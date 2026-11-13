// Pure helpers for clues (no Foundry globals), so they can be unit tested in Node.
//
// A clue is a journal entry: its first page is what anyone sees at a glance (the surface), later
// pages are more that a check (or the GM) reveals. Its settings live in the journal's flags:
//   flags["blockworld-bridge"].clue = { kind, item, radius, spot, icon }
//     kind   "normal" (seen as soon as it comes into view), "hidden" (spotted by an automatic
//            perception check, or shown by the GM), "item" (can be picked up; one exists)
//     item   the Minecraft item floating where it lies (paper, book, tripwire_hook...)
//     radius blocks within which it is noticed
//     spot   difficulty of the automatic perception check for a hidden clue
//   page flags["blockworld-bridge"].check = { skill, difficulty, label }: a check that reveals it
//
// Where clues lie is kept on the map scene (flags["blockworld-bridge"].clues), one entry per
// placed clue: see newPlaced().

export const KINDS = ["normal", "hidden", "item"];
export const ITEMS = ["paper", "book", "written_book", "filled_map", "tripwire_hook", "name_tag", "flower_pot", "bone", "emerald", "clock", "compass", "potion", "feather", "string"];
export const DEFAULT_CLUE = { kind: "normal", item: "paper", radius: 5, spot: "regular", icon: "" };

/** A journal's clue settings with the defaults filled in. */
export function clueSettings(flag) {
  const c = { ...DEFAULT_CLUE, ...(flag ?? {}) };
  if (!KINDS.includes(c.kind)) c.kind = "normal";
  c.radius = Math.max(1, Math.min(32, Number(c.radius) || DEFAULT_CLUE.radius));
  if (!/^[a-z0-9_]{1,40}$/.test(String(c.item))) c.item = "paper";
  if (!["regular", "hard", "extreme"].includes(c.spot)) c.spot = "regular";
  return c;
}

/** A clue placed on the map: where, and what has happened to it. */
export function newPlaced(id, journal, settings, at) {
  return {
    id,
    uuid: journal.uuid,
    name: journal.name,
    surface: journal.surface ?? "",
    kind: settings.kind,
    item: settings.item,
    radius: settings.radius,
    spotDifficulty: settings.spot,
    icon: settings.icon || "",
    x: at.x, y: at.y, z: at.z, dim: at.dim ?? "overworld",
    revealed: settings.kind !== "hidden", // a hidden clue shows once spotted (or shown by the GM)
    seen: {},       // who has seen it on the map ("*" = everyone): it stays drawn for them
    spotted: {},    // automatic perception checks: userId -> "ok" | "fail"
    found: {},      // who has looked at it (it is in their journal)
    tried: {},      // "userId:pageId" -> true|false: extra checks tried (once each)
    takenBy: null, takerName: ""
  };
}

/** Is a placed clue drawn for this user (GM: always)? */
export function visibleTo(c, userId, isGM) {
  if (isGM) return true;
  if (!c.revealed) return false;
  return !!(c.seen?.["*"] || c.seen?.[userId]);
}

/** Who a discovery is for: everyone in a shared game, the one who found it in a private one. */
export function audience(mode, userId) {
  return mode === "private" ? userId : "*";
}

/** Within reach on the ground: horizontal distance from a character to the clue's middle. */
export function within(pos, c, radius) {
  const dx = pos.x - (c.x + 0.5); const dz = pos.z - (c.z + 0.5);
  return Math.hypot(dx, dz) <= radius && Math.abs((pos.y ?? c.y) - c.y) <= 4;
}

/** The surface text of a journal's first page, as plain text. */
export function plainText(html) {
  return String(html ?? "").replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>/gi, "\n").replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * The clues file the scenario builder writes: { version, scenario, clues: [{ id, name, kind, item,
 * text, checks: [{ label, skill, difficulty, text }], x, y, z, place }] }. Returns the clues that
 * look right, cleaned.
 */
export function readClueFile(data) {
  const list = Array.isArray(data?.clues) ? data.clues : [];
  const out = [];
  for (const c of list) {
    if (!c || typeof c.name !== "string" || !Number.isFinite(Number(c.x)) || !Number.isFinite(Number(c.z))) continue;
    const s = clueSettings({ kind: c.kind, item: c.item, radius: c.radius });
    out.push({
      id: String(c.id ?? ""), name: c.name.slice(0, 120), text: String(c.text ?? ""), place: String(c.place ?? ""),
      kind: s.kind, item: s.item, radius: s.radius,
      x: Math.floor(Number(c.x)), y: Math.floor(Number(c.y ?? 64)), z: Math.floor(Number(c.z)),
      checks: (Array.isArray(c.checks) ? c.checks : []).filter((k) => k && k.text).map((k) => ({
        label: String(k.label ?? "").slice(0, 80), skill: String(k.skill ?? "spot"),
        difficulty: ["regular", "hard", "extreme"].includes(k.difficulty) ? k.difficulty : "regular", text: String(k.text)
      }))
    });
  }
  return { scenario: String(data?.scenario ?? ""), clues: out };
}

export function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
