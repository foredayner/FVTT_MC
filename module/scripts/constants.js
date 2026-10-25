export const MODULE_ID = "blockworld-bridge";
export const SOCKET = `module.${MODULE_ID}`;
export const PROTOCOL_VERSION = 1;

/** Keys a player may send for their own bot (the GM may send any of these for any bot). */
export const PLAYER_INTENTS = new Set([
  "spawnBot", "despawnBot", "moveTo", "stop", "dig", "attackAt", "control", "look", "cursor", "chat"
]);
/** GM-only relay calls. */
export const GM_INTENTS = new Set(["gm", "resync", "mapView"]);

export const ENTITY_COLORS = {
  hostile: [230, 40, 40],
  passive: [250, 220, 60],
  player: [60, 220, 255]
};

/** Localize with a fallback so a missing key never shows as a raw path. */
export function L(key, data) {
  const full = `BWB.${key}`;
  return data ? game.i18n.format(full, data) : game.i18n.localize(full);
}
