/**
 * Put a display object exactly on a canvas rectangle by measuring where it really is drawn.
 * Foundry versions differ in how a tile's mesh is anchored and parented (centre vs corner,
 * scene vs primary group); measuring the result instead of assuming a convention works for all.
 * Rotation is not handled (the map tile is never rotated).
 *
 * @param {{getBounds():{x,y,width,height}, scale:{x,y}, position:{x,y}, parent?:{worldTransform:{a,d}}}} obj
 * @param {{x:number, y:number, width:number, height:number}} rect canvas (scene) coordinates
 * @param {{toGlobal(p:{x,y}):{x,y}}} stage canvas.stage: scene coordinates -> screen
 * @returns {boolean} whether it could be aligned (false while the object is not laid out yet)
 */
export function alignToRect(obj, rect, stage) {
  if (!obj?.parent?.worldTransform) return false;
  const tl = stage.toGlobal({ x: rect.x, y: rect.y });
  const br = stage.toGlobal({ x: rect.x + rect.width, y: rect.y + rect.height });
  const want = { x: tl.x, y: tl.y, w: br.x - tl.x, h: br.y - tl.y };
  if (!(want.w > 0 && want.h > 0)) return false;
  let b = obj.getBounds();
  if (!(b.width > 0 && b.height > 0)) return false;
  // Size first: scaling happens around the anchor, so the position is fixed afterwards.
  if (Math.abs(b.width - want.w) > 0.5 || Math.abs(b.height - want.h) > 0.5) {
    obj.scale.x *= want.w / b.width;
    obj.scale.y *= want.h / b.height;
    b = obj.getBounds();
  }
  const dx = want.x - b.x; const dy = want.y - b.y;
  if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) {
    // a screen-space shift, turned into the parent's units
    const m = obj.parent.worldTransform;
    obj.position.x += dx / m.a;
    obj.position.y += dy / m.d;
  }
  return true;
}
