import { MODULE_ID, L } from "./constants.js";

/** Where the 3D textures and block models live inside Foundry's data folder. */
export const ASSET_ROOT = "bwb-assets";
const FILES = [
  { name: "atlas", file: "atlas.png", type: "image/png" },
  { name: "blockStates", file: "blockStates.json", type: "application/json" }
];

/** Absolute URLs the 3D renderer needs for a version. */
export function assetUrls(version) {
  const at = (f) => new URL(`${ASSET_ROOT}/${version}/${f}`, document.baseURI).href;
  return {
    atlasUrl: at("atlas.png"),
    blockStatesUrl: at("blockStates.json"),
    workerUrl: new URL(`modules/${MODULE_ID}/vendor/bwb3d-worker.js`, document.baseURI).href
  };
}

export function assetsReady(version) {
  return !!version && game.settings.get(MODULE_ID, "assetsVersion") === version;
}

/**
 * GM: make sure the texture atlas and block models are in Foundry's data folder, so every
 * player's browser loads them from Foundry like any other image. They come from the relay
 * (which has them from its prismarine-viewer package); the module itself ships none of them.
 */
export async function ensureAssets(relay, version) {
  const dir = `${ASSET_ROOT}/${version}`;
  const urls = assetUrls(version);
  if (assetsReady(version) && await exists(urls.atlasUrl) && await exists(urls.blockStatesUrl)) return;

  const FP = foundry.applications?.apps?.FilePicker?.implementation ?? globalThis.FilePicker;
  if (!FP?.upload) throw new Error("FilePicker.upload unavailable");
  ui.notifications.info(L("Notify.AssetsUploading"));
  await mkdir(FP, ASSET_ROOT);
  await mkdir(FP, dir);
  for (const f of FILES) {
    const res = await relay.call("asset3d", { name: f.name }, 120000);
    const bytes = Uint8Array.from(atob(res.data), (c) => c.charCodeAt(0));
    const file = new File([bytes], f.file, { type: f.type });
    const out = await FP.upload("data", dir, file, {}, { notify: false });
    if (out === false || out?.status === "error") throw new Error(`upload ${f.file} failed`);
  }
  await game.settings.set(MODULE_ID, "assetsVersion", version);
  ui.notifications.info(L("Notify.AssetsReady"));
}

async function mkdir(FP, path) {
  try { await FP.createDirectory("data", path, {}); } catch { /* already there */ }
}

async function exists(url) {
  try { return (await fetch(url, { method: "HEAD", cache: "no-store" })).ok; } catch { return false; }
}
