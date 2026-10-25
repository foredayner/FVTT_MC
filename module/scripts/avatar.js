import { MODULE_ID } from "./constants.js";

/**
 * How a player's character looks in other players' 3D windows: a coloured box (the Minecraft
 * hitbox, 0.6 × 1.8 blocks) with an illustration on the side the character faces.
 * Stored as a flag on the Foundry user, so Foundry syncs it to everyone and each player can
 * edit their own.
 */
export const AVATAR_FLAG = "avatar";
export const DEFAULT_COLOR = "#3cdcff";
export const SCALE_MIN = 0.2;
export const SCALE_MAX = 3;
export const BOX = { w: 0.6, h: 1.8 };
/** How far (blocks) the illustration's centre may move from the centre of the front face. */
export const OFFSET_MAX = { x: 0.8, y: 1.2 };
const NO_IMAGE = new Set(["", "icons/svg/mystery-man.svg"]);

/** Clean up whatever is stored (old, hand-edited or missing data) into a usable look. */
export function normalizeAvatar(raw = {}, fallbackImage = "") {
  const color = /^#[0-9a-f]{6}$/i.test(raw.color ?? "") ? raw.color.toLowerCase() : DEFAULT_COLOR;
  const image = typeof raw.image === "string" ? raw.image.trim() : (NO_IMAGE.has(fallbackImage) ? "" : fallbackImage);
  let scale = Number(raw.scale);
  if (!Number.isFinite(scale)) scale = 1;
  scale = Math.round(Math.min(SCALE_MAX, Math.max(SCALE_MIN, scale)) * 100) / 100;
  const off = (v, max) => { const n = Number(v); return Number.isFinite(n) ? Math.round(Math.min(max, Math.max(-max, n)) * 1000) / 1000 : 0; };
  // offsetX: + = right as seen from the front; offsetY: + = up.
  return { color, image, scale, offsetX: off(raw.offsetX, OFFSET_MAX.x), offsetY: off(raw.offsetY, OFFSET_MAX.y) };
}

/** The look for a Foundry user. Until they set one, the illustration is their user avatar. */
export function avatarFor(user) {
  return normalizeAvatar(user?.getFlag?.(MODULE_ID, AVATAR_FLAG) ?? undefined, user?.avatar ?? "");
}

/**
 * Size of the illustration on the front face, in blocks: fit inside the 0.6 × 1.8 face keeping
 * its aspect ratio, then multiply by scale (above 1 it grows past the box edges).
 */
export function illustrationSize(aspect, scale, box = BOX) {
  const a = aspect > 0 ? aspect : 1;
  const fit = a > box.w / box.h ? { w: box.w, h: box.w / a } : { w: box.h * a, h: box.h };
  return { w: fit.w * scale, h: fit.h * scale };
}
