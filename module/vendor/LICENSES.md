# Third-party code in vendor/

`bwb3d.js` and `bwb3d-worker.js` are built by `tools/build3d` and bundle:

| Package | License |
| --- | --- |
| three 0.128.0 | MIT |
| prismarine-viewer 1.33.0 (mesher: models.js, world.js; patched for heights below 0) | MIT |
| prismarine-chunk, prismarine-block, prismarine-nbt, prismarine-registry | MIT |
| minecraft-data 3.117.0 (1.21.4 blocks, collision shapes, biomes, tints only) | MIT |
| vec3, buffer, events, smart-buffer | MIT |

Full license texts: the `*.LEGAL.txt` files next to the bundles, and each package's repository.

No Minecraft textures or models are included. The 3D view loads them from the GM's Foundry
data folder (`bwb-assets/`), where the GM's browser uploads them from the relay the first time.
