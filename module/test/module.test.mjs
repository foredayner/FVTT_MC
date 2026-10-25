// Node tests for the module's pure logic and its permission routing (Foundry globals are mocked).
// Run: node --test module/test/
import test from "node:test";
import assert from "node:assert";
import { createRequire } from "node:module";
import { mcToScene, sceneToMc, tokenTopLeft, yawToRotation, inMap, chunkToRGBA, originAround } from "../scripts/coords.js";

const require = createRequire(import.meta.url);

test("coords: scene <-> minecraft round trip", () => {
  const map = { originX: -64, originZ: 100, size: 128 };
  const dims = { grid: 100, sceneX: 0, sceneY: 0 };
  const p = mcToScene({ x: -10.5, z: 120.25 }, map, dims);
  assert.deepStrictEqual(p, { x: 5350, y: 2025 });
  assert.deepStrictEqual(sceneToMc(p, map, dims), { x: -10.5, z: 120.25 });
  assert.deepStrictEqual(tokenTopLeft({ x: -10.5, z: 120.5 }, map, dims), { x: 5300, y: 2000 });
  assert.ok(inMap(-64, 100, map) && !inMap(64, 100, map) && !inMap(0, 99, map));
  assert.deepStrictEqual(originAround({ x: 10.7, z: -3.2 }, 128), { originX: -54, originZ: -68 });
});

test("coords: yaw -> token rotation (verified against a real bot: yaw 0 walks -Z, pi/2 walks -X)", () => {
  assert.strictEqual(yawToRotation(0), 180);              // north = up
  assert.strictEqual(yawToRotation(Math.PI / 2), 90);     // west = left
  assert.strictEqual(yawToRotation(Math.PI), 0);          // south = down
  assert.strictEqual(yawToRotation(-Math.PI / 2), 270);   // east = right
});

test("coords: relay chunk encoding decodes to the same pixels", () => {
  const { MapScanner } = require("../../relay/src/mapScanner.js");
  const rgb = new Uint8Array(768).map((_, i) => i % 251);
  const enc = MapScanner.encode({ dim: "overworld", cx: 0, cz: 0, rgb, heights: new Int16Array(256) });
  const rgba = chunkToRGBA(enc.rgb);
  for (let i = 0; i < 256; i++) {
    assert.deepStrictEqual([rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2], rgba[i * 4 + 3]], [rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2], 255]);
  }
});

// ---- Hub permission routing with mocked Foundry globals ----
function mockFoundry({ me, gm = "gm1" }) {
  const sent = [];
  const users = new Map([
    ["gm1", { id: "gm1", isGM: true }],
    ["p1", { id: "p1", isGM: false }],
    ["p2", { id: "p2", isGM: false }]
  ]);
  globalThis.game = {
    user: users.get(me),
    users: Object.assign(users, { activeGM: users.get(gm) }),
    socket: { emit: (_, d) => sent.push(d), on: () => {} },
    settings: { get: () => false },
    i18n: { localize: (k) => k, format: (k) => k }
  };
  globalThis.ui = { notifications: { warn: () => {}, info: () => {} } };
  return sent;
}

test("hub: GM only forwards a player's intent for that player's own bot", async () => {
  const sent = mockFoundry({ me: "gm1" });
  const { Hub } = await import("../scripts/hub.js");
  const hub = new Hub();
  const calls = [];
  hub.relay = { call: async (type, body) => { calls.push({ type, ...body }); return "ok"; }, fire: (type, body) => calls.push({ type, ...body }) };

  await hub.handlePlayerIntent("p1", { reqId: "a", payload: { type: "moveTo", key: "p1", x: 1, z: 2 } });
  await hub.handlePlayerIntent("p1", { reqId: "b", payload: { type: "moveTo", key: "p2", x: 1, z: 2 } });
  await hub.handlePlayerIntent("p1", { reqId: "c", payload: { type: "gm", action: "time", args: { value: "day" } } });
  await hub.handlePlayerIntent("p1", { payload: { type: "look", key: "p1", yaw: 1, pitch: 0 } });

  assert.deepStrictEqual(calls.map((c) => c.type), ["moveTo", "look"]);
  const results = Object.fromEntries(sent.filter((s) => s.t === "intentResult").map((s) => [s.reqId, s.ok]));
  assert.deepStrictEqual(results, { a: true, b: false, c: false });
});

test("hub: socket sender id beats a spoofed 'from' field", async () => {
  const sent = mockFoundry({ me: "gm1" });
  const { Hub } = await import("../scripts/hub.js");
  const hub = new Hub();
  const calls = [];
  hub.relay = { call: async (type, body) => { calls.push({ type, ...body }); return null; }, fire: () => {} };
  // p2 claims to be p1 in the payload, but Foundry says the sender is p2.
  hub.onSocket({ t: "intent", from: "p1", reqId: "x", payload: { type: "stop", key: "p1" } }, "p2");
  await new Promise((r) => setTimeout(r, 10));
  assert.strictEqual(calls.length, 0);
  assert.strictEqual(sent.find((s) => s.reqId === "x").ok, false);
});

test("hub: players send intents to the GM instead of the relay", async () => {
  const sent = mockFoundry({ me: "p1" });
  const { Hub } = await import("../scripts/hub.js");
  const hub = new Hub();
  hub.intent({ type: "control", key: "p1", control: "forward", state: true });
  assert.strictEqual(sent[0].t, "intent");
  assert.strictEqual(sent[0].reqId, undefined); // fire-and-forget
  await assert.rejects(hub.intent({ type: "gm", action: "time", args: { value: "day" } }));
});

test("hub 3D: GM caches columns, forwards only while another user watches, replays cache to a new viewer", async () => {
  const sent = mockFoundry({ me: "gm1" });
  globalThis.Hooks = { on: () => 0, off: () => {} };
  const { Hub } = await import("../scripts/hub.js");
  const hub = new Hub();
  const got = [];
  hub.addEventListener("col3d", (e) => got.push(e.detail));
  const col = { type: "col3d", dim: "overworld", x: 16, z: 32, minY: -64, height: 384, data: "AAA" };
  hub.fromRelay(col);
  hub.fromRelay({ type: "block3d", dim: "overworld", x: 20, y: -61, z: 40, stateId: 0 });
  assert.strictEqual(got.length, 1, "GM's own listeners get it");
  assert.strictEqual(sent.length, 0, "nobody else watching: nothing broadcast");

  hub.onSocket({ t: "sub3d", from: "p1", on: true }, "p1");
  const replay = sent.filter((s) => s.t === "relay" && s.to === "p1").map((s) => s.msg.type);
  assert.deepStrictEqual(replay, ["col3d", "block3d"], "new viewer gets the column, then its block changes");

  sent.length = 0;
  hub.fromRelay({ type: "unload3d", dim: "overworld", x: 16, z: 32 });
  assert.strictEqual(sent.length, 1, "while p1 watches, live messages are broadcast");
  assert.strictEqual([...hub.cached3d()].length, 0, "unloaded column leaves the cache");

  hub.onSocket({ t: "sub3d", from: "p1", on: false }, "p1");
  sent.length = 0;
  hub.fromRelay(col);
  assert.strictEqual(sent.length, 0, "after p1 closes, back to GM-only");
});

test("hub 3D: players ignore messages addressed to someone else", async () => {
  mockFoundry({ me: "p2" });
  const { Hub } = await import("../scripts/hub.js");
  const hub = new Hub();
  const got = [];
  hub.addEventListener("col3d", (e) => got.push(e.detail));
  hub.onSocket({ t: "relay", to: "p1", msg: { type: "col3d", dim: "overworld", x: 0, z: 0 } }, "gm1");
  hub.onSocket({ t: "relay", msg: { type: "col3d", dim: "overworld", x: 16, z: 0 } }, "gm1");
  assert.deepStrictEqual(got.map((m) => m.x), [16]);
});

test("avatar: stored look is cleaned up; the user avatar is the default picture", async () => {
  const { normalizeAvatar, avatarFor, illustrationSize, DEFAULT_COLOR } = await import("../scripts/avatar.js");
  assert.deepStrictEqual(normalizeAvatar({ color: "#FF0000", image: " a.png ", scale: "1.5", offsetX: "0.25", offsetY: -9 }), { color: "#ff0000", image: "a.png", scale: 1.5, offsetX: 0.25, offsetY: -1.2 });
  assert.deepStrictEqual(normalizeAvatar({ color: "red", scale: 99 }, "me.png"), { color: DEFAULT_COLOR, image: "me.png", scale: 3, offsetX: 0, offsetY: 0 });
  assert.strictEqual(normalizeAvatar({ image: "" }, "me.png").image, "", "a cleared picture stays cleared");
  assert.strictEqual(normalizeAvatar({}, "icons/svg/mystery-man.svg").image, "", "Foundry's placeholder is not an illustration");
  const user = { avatar: "u.png", getFlag: () => undefined };
  assert.deepStrictEqual(avatarFor(user), { color: DEFAULT_COLOR, image: "u.png", scale: 1, offsetX: 0, offsetY: 0 });
  // 0.6 × 1.8 face: a square picture fits the width, a tall one fits the height, then scale multiplies.
  assert.deepStrictEqual(illustrationSize(1, 1), { w: 0.6, h: 0.6 });
  const tall = illustrationSize(0.25, 2);
  assert.ok(Math.abs(tall.w - 0.9) < 1e-9 && Math.abs(tall.h - 3.6) < 1e-9);
});

test("walls: floor-plan walls become merged wall segments; windows and open doors stay open", async () => {
  const { chunkWallSegments, KIND } = await import("../scripts/walls.js");
  // 5x5 room at x,z 0..4: wall ring, closed door at (2,0), window at (0,2), open door at (4,2).
  const cells = new Map();
  for (let x = 0; x <= 4; x++) for (let z = 0; z <= 4; z++) {
    cells.set(`${x},${z}`, x === 0 || x === 4 || z === 0 || z === 4 ? KIND.WALL : KIND.FLOOR);
  }
  cells.set("2,0", KIND.DOOR); cells.set("0,2", KIND.WINDOW); cells.set("4,2", KIND.DOOR_OPEN);
  const kindAt = (x, z) => cells.get(`${x},${z}`) ?? KIND.SURFACE;
  const map = { originX: -10, originZ: -10, size: 64 };
  const segs = chunkWallSegments(0, 0, kindAt, map);
  const key = (s) => s.join(",");
  const set = new Set(segs.map(key));
  assert.ok(set.has("0,0,5,0"), "north outer face is one run (closed door blocks too)");
  assert.ok(set.has("1,1,4,1"), "north inner face");
  assert.ok(set.has("0,0,0,2") && set.has("0,3,0,5"), "west face is split by the window");
  assert.ok(set.has("5,0,5,2") && set.has("5,3,5,5"), "east face is split by the open door");
  assert.ok(!segs.some(([x1, z1, x2, z2]) => x1 === x2 && x1 === 0 && z1 <= 2 && z2 > 2), "no wall across the window");
  // Nothing outside the map.
  assert.strictEqual(chunkWallSegments(0, 0, kindAt, { originX: 10, originZ: 10, size: 64 }).length, 0);
});

test("coords: map from its bottom-left (south-west) block", async () => {
  const { originFromBottomLeft, bottomLeftOf, mcToScene } = await import("../scripts/coords.js");
  const map = { ...originFromBottomLeft({ x: 100, z: 200 }, 128), size: 128 };
  assert.deepStrictEqual(map, { originX: 100, originZ: 73, size: 128 });
  assert.deepStrictEqual(bottomLeftOf(map), { x: 100, z: 200 });
  // That block's square is the bottom-left square of the scene.
  const dims = { grid: 100, sceneX: 0, sceneY: 0 };
  assert.deepStrictEqual(mcToScene({ x: 100, z: 200 }, map, dims), { x: 0, y: 12700 });
});

test("displays: parts paint the cells they cover, highest part wins, other dimensions and cut are skipped", async () => {
  const { applyDisp, displayCells } = await import("../scripts/displays.js");
  const parts = new Map();
  const part = (id, box, c, dim = "overworld") => ({ id, dim, box, c });
  applyDisp(parts, { reset: true, add: [
    part("body", [8.04, -60, 9.79, 8.96, -59.2, 11.21], [200, 200, 200]),   // spans z 9..11, one x cell
    part("beak", [8.4, -59.0, 9.8, 8.6, -58.9, 10.0], [216, 127, 51]),      // higher: wins its cell
    part("tiny", [20.1, -60, 20.1, 20.2, -59.9, 20.2], [0, 0, 0]),          // smaller than a block: still 1 cell
    part("nether", [8, -60, 9, 9, -59, 10], [255, 0, 0], "the_nether"),
    part("glass", [8, 0, 8, 9, 1, 9], null)
  ], del: [] });
  const map = { originX: 0, originZ: 0, size: 32, dim: "overworld" };
  const cells = displayCells(parts.values(), map);
  const at = (x, z) => cells.get(z * map.size + x)?.c;
  assert.deepStrictEqual(at(8, 9), [216, 127, 51]);
  assert.deepStrictEqual(at(8, 10), [200, 200, 200]);
  assert.deepStrictEqual(at(8, 11), [200, 200, 200]);
  assert.deepStrictEqual(at(20, 20), [0, 0, 0]);
  assert.strictEqual(cells.size, 4);
  assert.strictEqual(displayCells(parts.values(), map, { maxY: -59.5 }).get(9 * 32 + 8).c[0], 200, "beak above the cut is hidden");
  applyDisp(parts, { add: [], del: ["beak", "tiny"] });
  assert.deepStrictEqual([...parts.keys()].sort(), ["body", "glass", "nether"]);
  assert.strictEqual(displayCells(parts.values(), { originX: 100, originZ: 0, size: 32, dim: "overworld" }).size, 0, "outside the map");
});

test("hub: display parts reach every client and late joiners get them in the snapshot", async () => {
  const sent = mockFoundry({ me: "gm1" });
  const { Hub } = await import("../scripts/hub.js");
  const hub = new Hub();
  hub.fromRelay({ type: "disp", reset: true, add: [{ id: "1", dim: "overworld", box: [0, 0, 0, 1, 1, 1], c: [1, 2, 3] }], del: [] });
  assert.strictEqual(hub.displays.size, 1);
  assert.ok(sent.some((s) => s.t === "relay" && s.msg.type === "disp"), "broadcast to players like map chunks");
  hub.sendSnapshot("p1");
  const snap = sent.find((s) => s.t === "snapshot");
  assert.strictEqual(snap.displays.length, 1);

  mockFoundry({ me: "p1" });
  const player = new Hub();
  const got = [];
  player.addEventListener("disp", (e) => got.push(e.detail));
  player.onSocket(snap, "gm1");
  assert.strictEqual(player.displays.size, 1);
  assert.ok(got[0].reset);
  player.onSocket({ t: "relay", msg: { type: "disp", add: [], del: ["1"] } }, "gm1");
  assert.strictEqual(player.displays.size, 0);
});

test("map tile: placed on the scene rectangle, so it lines up with tokens on a padded scene", async () => {
  const { mapTileRect, tileMisplaced, mcToScene } = await import("../scripts/coords.js");
  const map = { originX: -200, originZ: -29, size: 128 };
  // a padded scene like the one in the bug report: the scene starts half a map in
  const dims = { grid: 100, sceneX: 6400, sceneY: 6400 };
  const rect = mapTileRect(map, dims);
  assert.deepStrictEqual(rect, { x: 6400, y: 6400, width: 12800, height: 12800 });
  // the block a token stands on and the same block in the tile image are the same canvas point
  const token = mcToScene({ x: -136.5, z: 35.5 }, map, dims);
  const pixel = { x: rect.x + (-136.5 - map.originX) * dims.grid, y: rect.y + (35.5 - map.originZ) * dims.grid };
  assert.deepStrictEqual(token, pixel);
  assert.ok(tileMisplaced({ x: 0, y: 0, width: 12800, height: 12800 }, rect), "old tile at canvas (0,0) is detected");
  assert.ok(!tileMisplaced({ x: 6400.2, y: 6400, width: 12800, height: 12800 }, rect));
});

test("map setup: the tile is created at the scene's real origin, whatever the padding", async () => {
  mockFoundry({ me: "gm1" });
  const created = [];
  const updates = [];
  const scene = {
    grid: { size: 100 },
    update: async (d) => { updates.push(d); },
    getDimensions: () => ({ sceneX: 6400, sceneY: 6400 }), // padding was not removed
    tiles: { find: () => undefined },
    createEmbeddedDocuments: async (type, data) => { created.push({ type, data }); }
  };
  globalThis.canvas = { scene, dimensions: { sceneX: 0, sceneY: 0 } };
  const { setupMapScene } = await import("../scripts/map-setup.js");
  const hub = { positions: new Map([["u1", { x: -136.5, y: -60, z: 35.5, dim: "overworld" }]]) };
  await setupMapScene(hub, { centerKey: "u1", size: 128 });
  const tile = created[0].data[0];
  assert.deepStrictEqual([tile.x, tile.y, tile.width, tile.height], [6400, 6400, 12800, 12800]);
  delete globalThis.canvas;
});

test("3D HUD: chat for everyone, titles and deaths only for that character's view", async () => {
  const { Hud3D } = await import("../scripts/hud.js");
  const got = [];
  const hud = Object.create(Hud3D.prototype);
  hud.chat = (text, kind = "chat") => got.push(["chat", text, kind]);
  hud.title = (ev) => got.push(["title", ev.text, ev.subtitle]);
  hud.actionbar = (text) => got.push(["bar", text]);
  hud.clearTitle = () => got.push(["clear"]);
  hud.handle({ kind: "chat", text: "<Jo> hi" }, "me");
  hud.handle({ kind: "hud", key: "other", slot: "title", text: "not mine" }, "me");
  hud.handle({ kind: "hud", key: "me", slot: "title", text: "T", subtitle: "S" }, "me");
  hud.handle({ kind: "hud", key: "me", slot: "actionbar", text: "A" }, "me");
  hud.handle({ kind: "hud", key: "me", slot: "clear" }, "me");
  hud.handle({ kind: "death", key: "me", text: "Jo died" }, "me");
  hud.handle({ kind: "death", key: "other", text: "someone died" }, "me");
  hud.handle({ kind: "info", key: "me", text: "joined" }, "me");
  assert.deepStrictEqual(got, [["chat", "<Jo> hi", "chat"], ["title", "T", "S"], ["bar", "A"], ["clear"], ["chat", "Jo died", "warn"]]);
});

test("map scene padding: removed when present, reported once if the scene still starts off the corner", async () => {
  const { paddingAction } = await import("../scripts/coords.js");
  assert.strictEqual(paddingAction(0.25, { sceneX: 3200, sceneY: 3200 }), "update");
  assert.strictEqual(paddingAction(0, { sceneX: 0, sceneY: 0 }), "ok");
  assert.strictEqual(paddingAction(undefined, { sceneX: 0, sceneY: 0 }), "ok");
  assert.strictEqual(paddingAction(0, { sceneX: 6400, sceneY: 6400 }), "report");
});
