'use strict'
// Minecraft map-item colours: the 61 base colours of the in-game map, assigned per block,
// with the map's height shading. Base RGB values from the Minecraft Wiki "Map item format" page.
// Block -> colour assignments follow vanilla where known and fall back to the closest family.

/** id -> [name, r, g, b]; id 0 (NONE) is see-through. */
const BASE = [
  ['NONE', 0, 0, 0], ['GRASS', 127, 178, 56], ['SAND', 247, 233, 163], ['WOOL', 199, 199, 199],
  ['FIRE', 255, 0, 0], ['ICE', 160, 160, 255], ['METAL', 167, 167, 167], ['PLANT', 0, 124, 0],
  ['SNOW', 255, 255, 255], ['CLAY', 164, 168, 184], ['DIRT', 151, 109, 77], ['STONE', 112, 112, 112],
  ['WATER', 64, 64, 255], ['WOOD', 143, 119, 72], ['QUARTZ', 255, 252, 245], ['COLOR_ORANGE', 216, 127, 51],
  ['COLOR_MAGENTA', 178, 76, 216], ['COLOR_LIGHT_BLUE', 102, 153, 216], ['COLOR_YELLOW', 229, 229, 51],
  ['COLOR_LIGHT_GREEN', 127, 204, 25], ['COLOR_PINK', 242, 127, 165], ['COLOR_GRAY', 76, 76, 76],
  ['COLOR_LIGHT_GRAY', 153, 153, 153], ['COLOR_CYAN', 76, 127, 153], ['COLOR_PURPLE', 127, 63, 178],
  ['COLOR_BLUE', 51, 76, 178], ['COLOR_BROWN', 102, 76, 51], ['COLOR_GREEN', 102, 127, 51],
  ['COLOR_RED', 153, 51, 51], ['COLOR_BLACK', 25, 25, 25], ['GOLD', 250, 238, 77], ['DIAMOND', 92, 219, 213],
  ['LAPIS', 74, 128, 255], ['EMERALD', 0, 217, 58], ['PODZOL', 129, 86, 49], ['NETHER', 112, 2, 0],
  ['TERRACOTTA_WHITE', 209, 177, 161], ['TERRACOTTA_ORANGE', 159, 82, 36], ['TERRACOTTA_MAGENTA', 149, 87, 108],
  ['TERRACOTTA_LIGHT_BLUE', 112, 108, 138], ['TERRACOTTA_YELLOW', 186, 133, 36],
  ['TERRACOTTA_LIGHT_GREEN', 103, 117, 53], ['TERRACOTTA_PINK', 160, 77, 78], ['TERRACOTTA_GRAY', 57, 41, 35],
  ['TERRACOTTA_LIGHT_GRAY', 135, 107, 98], ['TERRACOTTA_CYAN', 87, 92, 92], ['TERRACOTTA_PURPLE', 122, 73, 88],
  ['TERRACOTTA_BLUE', 76, 62, 92], ['TERRACOTTA_BROWN', 76, 50, 35], ['TERRACOTTA_GREEN', 76, 82, 42],
  ['TERRACOTTA_RED', 142, 60, 46], ['TERRACOTTA_BLACK', 37, 22, 16], ['CRIMSON_NYLIUM', 189, 48, 49],
  ['CRIMSON_STEM', 148, 63, 97], ['CRIMSON_HYPHAE', 92, 25, 29], ['WARPED_NYLIUM', 22, 126, 134],
  ['WARPED_STEM', 58, 142, 140], ['WARPED_HYPHAE', 86, 44, 62], ['WARPED_WART_BLOCK', 20, 180, 133],
  ['DEEPSLATE', 100, 100, 100], ['RAW_IRON', 216, 175, 147], ['GLOW_LICHEN', 127, 167, 150]
]
const ID = Object.fromEntries(BASE.map(([n], i) => [n, i]))

/** Shade multipliers of the map item: lower than the block to the north, level, higher. */
const SHADE = { LOW: 180, NORMAL: 220, HIGH: 255 }

const DYES = ['white', 'orange', 'magenta', 'light_blue', 'yellow', 'lime', 'pink', 'gray', 'light_gray', 'cyan', 'purple', 'blue', 'brown', 'green', 'red', 'black']
const DYE_COLOR = {
  white: ID.SNOW, orange: ID.COLOR_ORANGE, magenta: ID.COLOR_MAGENTA, light_blue: ID.COLOR_LIGHT_BLUE,
  yellow: ID.COLOR_YELLOW, lime: ID.COLOR_LIGHT_GREEN, pink: ID.COLOR_PINK, gray: ID.COLOR_GRAY,
  light_gray: ID.COLOR_LIGHT_GRAY, cyan: ID.COLOR_CYAN, purple: ID.COLOR_PURPLE, blue: ID.COLOR_BLUE,
  brown: ID.COLOR_BROWN, green: ID.COLOR_GREEN, red: ID.COLOR_RED, black: ID.COLOR_BLACK
}
const DYE_TERRACOTTA = Object.fromEntries(DYES.map((d) => [d, ID[`TERRACOTTA_${d.toUpperCase()}`]]))
const DYE_RE = new RegExp(`^(${DYES.sort((a, b) => b.length - a.length).join('|')})_(.+)$`)
const DYED = /^(wool|carpet|concrete|concrete_powder|stained_glass|stained_glass_pane|shulker_box|bed|banner|wall_banner|candle|candle_cake|glazed_terracotta)$/

const WOOD_SPECIES = {
  oak: ID.WOOD, spruce: ID.PODZOL, birch: ID.SAND, jungle: ID.DIRT, acacia: ID.COLOR_ORANGE,
  dark_oak: ID.COLOR_BROWN, mangrove: ID.COLOR_RED, cherry: ID.TERRACOTTA_WHITE, pale_oak: ID.QUARTZ,
  bamboo: ID.COLOR_YELLOW, crimson: ID.CRIMSON_STEM, warped: ID.WARPED_STEM
}
const WOOD_RE = /^(?:stripped_)?(pale_oak|dark_oak|oak|spruce|birch|jungle|acacia|mangrove|cherry|bamboo|crimson|warped)_(log|wood|planks|slab|stairs|fence|fence_gate|door|trapdoor|sign|wall_sign|hanging_sign|wall_hanging_sign|pressure_plate|button|mosaic|mosaic_slab|mosaic_stairs|block)$/

const NONE_RE = /^(air|cave_air|void_air|light|barrier|structure_void|glass|glass_pane|torch|wall_torch|soul_torch|soul_wall_torch|redstone_torch|redstone_wall_torch|rail|powered_rail|detector_rail|activator_rail|redstone_wire|tripwire|tripwire_hook|lever|ladder|flower_pot|end_rod|iron_bars|chain|.*_button|.*_head|.*_skull|.*_wall_head|.*_wall_skull|potted_.*|moving_piston|nether_portal|end_portal|end_gateway)$/

// Ordered name rules for everything not covered above. First match wins.
const RULES = [
  [/^(water|bubble_column|kelp|kelp_plant|seagrass|tall_seagrass)$/, ID.WATER],
  [/^(lava|fire|tnt|redstone_block)$/, ID.FIRE],
  [/^soul_fire$/, ID.COLOR_LIGHT_BLUE],
  [/^(ice|packed_ice|blue_ice|frosted_ice)$/, ID.ICE],
  [/^(snow|snow_block|powder_snow)$/, ID.SNOW],
  [/^(grass_block|slime_block)$/, ID.GRASS],
  [/^cherry_leaves$/, ID.COLOR_PINK],
  [/^pale_oak_leaves$/, ID.COLOR_GREEN],
  [/leaves$|^(azalea|flowering_azalea)$/, ID.PLANT],
  [/^(short_grass|tall_grass|grass|fern|large_fern|vine|lily_pad|sugar_cane|cactus|bamboo|bamboo_sapling|wheat|carrots|potatoes|beetroots|sweet_berry_bush|pumpkin_stem|melon_stem|attached_pumpkin_stem|attached_melon_stem|cocoa|big_dripleaf|big_dripleaf_stem|small_dripleaf|spore_blossom|hanging_roots|pink_petals|pitcher_plant|pitcher_crop|torchflower|torchflower_crop|cave_vines|cave_vines_plant|twisting_vines|twisting_vines_plant|weeping_vines|weeping_vines_plant)$/, ID.PLANT],
  [/sapling$|^(dandelion|poppy|blue_orchid|allium|azure_bluet|red_tulip|orange_tulip|white_tulip|pink_tulip|oxeye_daisy|cornflower|lily_of_the_valley|wither_rose|sunflower|lilac|rose_bush|peony|open_eyeblossom|closed_eyeblossom)$/, ID.PLANT],
  [/^dead_bush$/, ID.WOOD],
  [/^(moss_block|moss_carpet)$/, ID.COLOR_GREEN],
  [/^pale_moss_(block|carpet)$/, ID.COLOR_LIGHT_GRAY],
  [/^(dirt|coarse_dirt|farmland|dirt_path|rooted_dirt|packed_mud|granite|polished_granite|granite_slab|granite_stairs|granite_wall|polished_granite_slab|polished_granite_stairs)$/, ID.DIRT],
  [/^podzol$|^campfire$|^soul_campfire$/, ID.PODZOL],
  [/^mycelium$/, ID.COLOR_PURPLE],
  [/^(red_sand|red_sandstone|chiseled_red_sandstone|cut_red_sandstone|smooth_red_sandstone)(_slab|_stairs|_wall)?$/, ID.COLOR_ORANGE],
  [/^(sand|suspicious_sand|sandstone|chiseled_sandstone|cut_sandstone|smooth_sandstone)(_slab|_stairs|_wall)?$/, ID.SAND],
  [/^(glowstone|end_stone|end_stone_bricks|end_stone_brick_slab|end_stone_brick_stairs|end_stone_brick_wall|bone_block|scaffolding)$/, ID.SAND],
  [/^clay$|^infested_/, ID.CLAY],
  [/^mud$/, ID.TERRACOTTA_CYAN],
  [/^mud_brick/, ID.TERRACOTTA_LIGHT_GRAY],
  [/^terracotta$/, ID.COLOR_ORANGE],
  [/^(diorite|polished_diorite|quartz_block|quartz_bricks|quartz_pillar|chiseled_quartz_block|smooth_quartz|sea_lantern)(_slab|_stairs|_wall)?$|^quartz_(slab|stairs)$/, ID.QUARTZ],
  [/^(tuff|polished_tuff|tuff_bricks|chiseled_tuff|chiseled_tuff_bricks)(_slab|_stairs|_wall)?$|^tuff_brick/, ID.TERRACOTTA_GRAY],
  [/^calcite$/, ID.TERRACOTTA_WHITE],
  [/^(dripstone_block|pointed_dripstone)$/, ID.TERRACOTTA_BROWN],
  [/^(deepslate|cobbled_deepslate|polished_deepslate|deepslate_bricks|deepslate_tiles|chiseled_deepslate|cracked_deepslate_bricks|cracked_deepslate_tiles|reinforced_deepslate)|^deepslate_|^cobbled_deepslate_|^polished_deepslate_/, ID.DEEPSLATE],
  [/^(iron_block|iron_door|iron_trapdoor|anvil|chipped_anvil|damaged_anvil|cauldron|water_cauldron|lava_cauldron|powder_snow_cauldron|hopper|lantern|soul_lantern|heavy_weighted_pressure_plate|brewing_stand|grindstone|heavy_core)$/, ID.METAL],
  [/^(gold_block|raw_gold_block|bell|light_weighted_pressure_plate)$/, ID.GOLD],
  [/^(diamond_block|beacon|prismarine_bricks|prismarine_brick_slab|prismarine_brick_stairs|dark_prismarine|dark_prismarine_slab|dark_prismarine_stairs|conduit)$/, ID.DIAMOND],
  [/^prismarine(_slab|_stairs|_wall)?$/, ID.COLOR_CYAN],
  [/^lapis_block$/, ID.LAPIS],
  [/^emerald_block$/, ID.EMERALD],
  [/^raw_iron_block$/, ID.RAW_IRON],
  [/^raw_copper_block$/, ID.COLOR_ORANGE],
  [/^(waxed_)?oxidized_/, ID.WARPED_NYLIUM],
  [/^(waxed_)?weathered_/, ID.WARPED_STEM],
  [/^(waxed_)?exposed_/, ID.TERRACOTTA_LIGHT_GRAY],
  [/^(waxed_)?(copper|cut_copper|chiseled_copper|copper_grate|copper_door|copper_trapdoor|copper_bulb|cut_copper_slab|cut_copper_stairs)$|^waxed_copper/, ID.COLOR_ORANGE],
  [/^(netherrack|nether_bricks|nether_brick_slab|nether_brick_stairs|nether_brick_wall|nether_brick_fence|chiseled_nether_bricks|cracked_nether_bricks|nether_gold_ore|nether_quartz_ore|magma_block|red_nether_bricks|red_nether_brick_slab|red_nether_brick_stairs|red_nether_brick_wall)$/, ID.NETHER],
  [/^(soul_sand|soul_soil)$/, ID.COLOR_BROWN],
  [/^(obsidian|crying_obsidian|basalt|polished_basalt|smooth_basalt|blackstone|polished_blackstone|gilded_blackstone|sculk|sculk_catalyst|sculk_shrieker|sculk_sensor|coal_block|respawn_anchor|ancient_debris|netherite_block|lodestone)|^polished_blackstone_|^blackstone_/, ID.COLOR_BLACK],
  [/^crimson_nylium$/, ID.CRIMSON_NYLIUM],
  [/^(crimson_stem|stripped_crimson_stem|crimson_fungus|crimson_roots)$/, ID.CRIMSON_STEM],
  [/^(crimson_hyphae|stripped_crimson_hyphae)$/, ID.CRIMSON_HYPHAE],
  [/^warped_nylium$/, ID.WARPED_NYLIUM],
  [/^(warped_hyphae|stripped_warped_hyphae)$/, ID.WARPED_HYPHAE],
  [/^warped_wart_block$/, ID.WARPED_WART_BLOCK],
  [/^(warped_fungus|warped_roots|nether_sprouts)$/, ID.COLOR_CYAN],
  [/^(nether_wart_block|nether_wart|bricks|brick_slab|brick_stairs|brick_wall|red_mushroom_block|decorated_pot)$/, ID.COLOR_RED],
  [/^brown_mushroom_block$/, ID.DIRT],
  [/^mushroom_stem$|^cobweb$/, ID.WOOL],
  [/^(pumpkin|carved_pumpkin|jack_o_lantern|honey_block|honeycomb_block)$/, ID.COLOR_ORANGE],
  [/^melon$/, ID.COLOR_LIGHT_GREEN],
  [/^(hay_block|sponge|wet_sponge|bamboo_block|stripped_bamboo_block)$/, ID.COLOR_YELLOW],
  [/^purpur/, ID.COLOR_MAGENTA],
  [/^(amethyst_block|budding_amethyst|amethyst_cluster|chorus_plant|chorus_flower)$/, ID.COLOR_PURPLE],
  [/^tinted_glass$/, ID.COLOR_GRAY],
  [/^(glow_lichen|verdant_froglight)$/, ID.GLOW_LICHEN],
  [/^ochre_froglight$/, ID.SAND],
  [/^pearlescent_froglight$/, ID.COLOR_PINK],
  [/^(oak|spruce|birch|jungle|acacia|dark_oak|mangrove|cherry|pale_oak|bamboo)_.*sign$|chest$|^(crafting_table|bookshelf|chiseled_bookshelf|barrel|lectern|composter|note_block|jukebox|loom|cartography_table|fletching_table|smithing_table|beehive|bee_nest)$/, ID.WOOD],
  [/^(stone|cobblestone|mossy_cobblestone|stone_bricks|mossy_stone_bricks|cracked_stone_bricks|chiseled_stone_bricks|smooth_stone|andesite|polished_andesite|gravel|suspicious_gravel|bedrock|furnace|blast_furnace|smoker|dispenser|dropper|observer|piston|sticky_piston|stonecutter|spawner|trial_spawner|vault|crafter)|ore$|^(stone|cobblestone|mossy_cobblestone|stone_brick|mossy_stone_brick|smooth_stone|andesite|polished_andesite)_(slab|stairs|wall)$/, ID.STONE]
]

const cache = new Map()

/** Map colour id (0..61) for a block name. 0 means see-through. */
function colorId (name) {
  let id = cache.get(name)
  if (id !== undefined) return id
  id = lookup(name)
  cache.set(name, id)
  return id
}

function lookup (name) {
  if (NONE_RE.test(name)) return ID.NONE
  const dyed = DYE_RE.exec(name)
  if (dyed) {
    const [, dye, rest] = dyed
    if (rest === 'terracotta') return DYE_TERRACOTTA[dye]
    if (DYED.test(rest)) return DYE_COLOR[dye]
  }
  const wood = WOOD_RE.exec(name)
  if (wood) {
    const [, species, part] = wood
    if (species === 'crimson' && (part === 'hyphae' || part === 'wood')) return ID.CRIMSON_HYPHAE
    if (species === 'warped' && (part === 'hyphae' || part === 'wood')) return ID.WARPED_HYPHAE
    return WOOD_SPECIES[species]
  }
  for (const [re, cid] of RULES) if (re.test(name)) return cid
  // Families we did not list: guess from the name, else stone.
  if (/leaves|flower|sapling|bush|vine|roots|crop|grass/.test(name)) return ID.PLANT
  if (/log|wood|plank|door|fence|sign|shelf|table/.test(name)) return ID.WOOD
  if (/glass/.test(name)) return ID.NONE
  return ID.STONE
}

/** Is this block part of a body of water for the depth shading? */
function isWaterLike (name) { return colorId(name) === ID.WATER }

/**
 * Shade of a land pixel from its height and the height of the block to its north (null = unknown).
 * Higher than north -> HIGH, level -> NORMAL, lower -> LOW.
 */
function landShade (y, northY) {
  if (northY === null || northY === undefined || y === northY) return SHADE.NORMAL
  return y > northY ? SHADE.HIGH : SHADE.LOW
}

/** Water shading by depth with the map's checkerboard dither (vanilla-like). */
function waterShade (depth, x, z) {
  const f = depth * 0.1 + ((x + z) & 1) * 0.2
  if (f < 0.5) return SHADE.HIGH
  if (f > 0.9) return SHADE.LOW
  return SHADE.NORMAL
}

/** RGB of a colour id at a shade multiplier. */
function rgb (id, shade) {
  const [, r, g, b] = BASE[id] ?? BASE[ID.STONE]
  return [Math.floor(r * shade / 255), Math.floor(g * shade / 255), Math.floor(b * shade / 255)]
}

module.exports = { BASE, ID, SHADE, colorId, isWaterLike, landShade, waterShade, rgb }
