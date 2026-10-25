import { MODULE_ID } from "./constants.js";
import { WallSync } from "./walls.js";

/**
 * Floor-plan view of the map scene, stored on the scene as flags.blockworld-bridge.view:
 *   mode "auto"  - around characters standing under a roof, the roof is cut away at their floor
 *        "fixed" - the whole map is cut at floor level y (for one storey of a building or dungeon)
 *        "off"   - plain top-down view, roofs and all
 *   walls        - turn the cut walls into Foundry walls so vision stops at them
 */
export const DEFAULT_VIEW = { mode: "auto", y: null, walls: true };

export function viewOf(scene) {
  return { ...DEFAULT_VIEW, ...(scene?.getFlag(MODULE_ID, "view") ?? {}) };
}

/** GM only: sends the scene's view to the relay and keeps the generated walls in step. */
export class MapView {
  constructor(hub) {
    this.hub = hub;
    this.walls = new WallSync(hub);
    hub.addEventListener("welcome", () => this.push());
    Hooks.on("canvasReady", () => { this.push(); this.syncWalls(); });
    Hooks.on("updateScene", (scene, change) => {
      if (scene.id !== canvas.scene?.id) return;
      const f = `flags.${MODULE_ID}`;
      if (foundry.utils.hasProperty(change, `${f}.view`) || foundry.utils.hasProperty(change, `${f}.-=view`)) { this.push(); this.syncWalls(); }
      else if (foundry.utils.hasProperty(change, `${f}.map`)) this.syncWalls();
    });
  }

  get scene() { return canvas.scene?.getFlag(MODULE_ID, "map") ? canvas.scene : null; }

  push() {
    if (!this.hub.isRelayHost || !this.hub.relay || !this.scene) return;
    const v = viewOf(this.scene);
    this.hub.relay.call("mapView", { mode: v.mode, y: v.mode === "fixed" ? v.y : null })
      .catch((err) => console.warn(`${MODULE_ID} | map view`, err));
  }

  syncWalls() {
    if (!this.hub.isRelayHost || !this.scene) return;
    return viewOf(this.scene).walls ? this.walls.rebuildAll() : this.walls.removeAll();
  }
}
