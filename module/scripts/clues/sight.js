// What a player's character sees on the map scene, and the one overlay the module's map marks are
// drawn in (place names under stairs, under clues, under pins; above Foundry's own layers, so a
// fog reset or a re-sort of the interface never hides them).

/** Whether any of these points (scene pixels) is in sight of one of my tokens (its vision circle, walls in the way). GM: always. */
export function inSight(points, tolerance = 0) {
  if (game.user.isGM) return true;
  const vis = canvas.visibility;
  if (!vis?.tokenVision) return true;
  for (const p of points) {
    try { if (vis.testVisibility({ x: p.x, y: p.y }, { tolerance })) return true; } catch { return true; }
  }
  return false;
}

/** Call fn (throttled) whenever what tokens see may have changed. */
export function onSightChange(fn, ms = 150) {
  const t = foundry.utils.throttle(fn, ms);
  for (const hook of ["sightRefresh", "visibilityRefresh", "refreshToken", "updateToken", "canvasReady"]) Hooks.on(hook, t);
  return t;
}

export const Z = { places: 1, stairs: 2, clues: 3, pins: 4 };

/** The module's overlay on the map, made again after the canvas is redrawn. */
export function overlay() {
  let o = canvas.bwbOverlay;
  if (!o || o.destroyed || !o.parent) {
    o = new PIXI.Container();
    o.sortableChildren = true;
    o.eventMode = "passive";
    o.zIndex = 1000;
    (canvas.interface ?? canvas.stage).addChild(o);
    canvas.bwbOverlay = o;
  }
  return o;
}

/** Add a layer's container to the overlay at its place. */
export function addToOverlay(box, z) {
  box.zIndex = z;
  overlay().addChild(box);
  return box;
}

/**
 * Foundry's own fog reset (GM, or a player resetting their own): announced as the hook
 * "<module>.fogReset" so the module's map marks can follow it.
 */
export function watchFogReset(moduleId) {
  Hooks.on("canvasReady", () => {
    const proto = canvas.fog?.constructor?.prototype;
    if (!proto || typeof proto.reset !== "function" || proto.__bwbReset) return;
    const orig = proto.reset;
    proto.reset = async function (...args) {
      const out = await orig.apply(this, args);
      Hooks.callAll(`${moduleId}.fogReset`);
      return out;
    };
    proto.__bwbReset = true;
  });
}
