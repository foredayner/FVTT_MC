import { MODULE_ID, L } from "./constants.js";
import { originAround, originFromBottomLeft, bottomLeftOf } from "./coords.js";

export const BLANK = `modules/${MODULE_ID}/assets/blank.png`;
export const UNEXPLORED_GREY = "#7a7a7a";

/**
 * Vision for a map scene: each token sees a radius around itself, unseen ground is grey fog,
 * ground seen before stays dimmed. Global light off, so nothing outside a token's radius is lit.
 */
export function visionSceneData() {
  return {
    tokenVision: true,
    "fog.exploration": true,
    "fog.colors.unexplored": UNEXPLORED_GREY,
    "environment.globalLight.enabled": false,
    [`flags.${MODULE_ID}.vision`]: true
  };
}

/**
 * GM: turn the current scene into a map scene, either centred on a bot or with a given block as
 * its bottom-left corner. One block = one grid square; the scene is resized to size x size squares.
 * @param {{centerKey?:string, size:number, corner?:{x:number, z:number}}} opts
 */
export async function setupMapScene(hub, { centerKey, size, corner }) {
  const scene = canvas.scene;
  if (!scene) return ui.notifications.warn(L("Notify.NoScene"));
  const pos = hub.positions.get(centerKey);
  if (!corner && !pos) return ui.notifications.warn(L("Notify.NoBotPosition"));
  const grid = scene.grid.size;
  const { originX, originZ } = corner ? originFromBottomLeft(corner, size) : originAround(pos, size);

  await scene.update({
    width: size * grid,
    height: size * grid,
    padding: 0,
    "grid.distance": 1,
    "grid.units": L("BlockUnit"),
    [`flags.${MODULE_ID}.map`]: { originX, originZ, size, dim: pos?.dim ?? "overworld" }
  });
  try {
    await scene.update(visionSceneData());
  } catch (err) {
    // Field names can move between Foundry versions; the map still works without fog.
    console.warn(`${MODULE_ID} | could not enable vision on the scene`, err);
    ui.notifications.warn(L("Notify.VisionSetupFailed"));
  }

  const tileData = {
    texture: { src: BLANK },
    x: 0, y: 0, width: size * grid, height: size * grid,
    elevation: -100, sort: -1, locked: true,
    flags: { [MODULE_ID]: { mapTile: true } }
  };
  const existing = scene.tiles.find((t) => t.getFlag(MODULE_ID, "mapTile"));
  if (existing) await existing.update(tileData);
  else await scene.createEmbeddedDocuments("Tile", [tileData]);

  const bl = bottomLeftOf({ originX, originZ, size });
  ui.notifications.info(L("Notify.MapReady", { x: bl.x, z: bl.z, size }));
}

/** GM: forget the map binding (tile and tokens stay so nothing is lost by accident). */
export async function clearMapScene() {
  // Generated walls belong to the map; the tile and tokens stay.
  const ids = canvas.scene?.walls.filter((w) => w.getFlag(MODULE_ID, "chunk")).map((w) => w.id) ?? [];
  if (ids.length) await canvas.scene.deleteEmbeddedDocuments("Wall", ids);
  await canvas.scene?.unsetFlag(MODULE_ID, "map");
}
