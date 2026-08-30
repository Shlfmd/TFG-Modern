"use strict";

const $BuiltInRegistries = Java.loadClass(
  "net.minecraft.core.registries.BuiltInRegistries",
);
const FOOD_MODS = new Set([
  "farmersdelight",
  "farmersdelight_tfc",
  "moredelight",
  "delightful",
  "cuisinedelight",
  "tfc_cuisine",
  "tfc_gourmet",
  "rusticdelight",
  "survivorsdelight",
  "aquaculture",
  "survivorsaquaculture",
  "extradelight",
]);
// Flip to true to log one [TFGM-DUMP] line per food: id, hunger, saturation,
// decay, nutrients. Off by default; it is ~390 lines per datapack load.
const DUMP_FOOD_PROPERTIES = false;
const PROFILES = new Map();
// Survivor's Delight registers these items as empty dynamic foods. Reusing its
// exact data IDs replaces those definitions instead of leaving TFC to choose
// nondeterministically between the dynamic and fixed definitions.
const PROFILE_RESOURCE_IDS = new Map([
  ["farmersdelight:apple_cider", "survivorsdelight:drink/apple_cider"],
  ["farmersdelight:bacon_and_eggs", "survivorsdelight:meal/bacon_and_eggs"],
  ["farmersdelight:baked_cod_stew", "survivorsdelight:soup/baked_cod_stew"],
  ["farmersdelight:barbecue_stick", "survivorsdelight:food/barbecue_stick"],
  ["farmersdelight:beef_stew", "survivorsdelight:soup/beef_stew"],
  ["farmersdelight:bone_broth", "survivorsdelight:soup/bone_broth"],
  ["farmersdelight:cabbage_rolls", "survivorsdelight:food/cabbage_rolls"],
  ["farmersdelight:chicken_soup", "survivorsdelight:soup/chicken_soup"],
  ["farmersdelight:cod_roll", "survivorsdelight:food/cod_roll"],
  ["farmersdelight:dumplings", "survivorsdelight:food/dumplings"],
  ["farmersdelight:fish_stew", "survivorsdelight:soup/fish_stew"],
  ["farmersdelight:fried_rice", "survivorsdelight:meal/fried_rice"],
  ["farmersdelight:grilled_salmon", "survivorsdelight:meal/grilled_salmon"],
  ["farmersdelight:hot_cocoa", "survivorsdelight:drink/hot_cocoa"],
  ["farmersdelight:kelp_roll", "survivorsdelight:food/kelp_roll"],
  ["farmersdelight:kelp_roll_slice", "survivorsdelight:pie/kelp_roll_slice"],
  ["farmersdelight:mushroom_rice", "survivorsdelight:meal/mushroom_rice"],
  ["farmersdelight:noodle_soup", "survivorsdelight:soup/noodle_soup"],
  ["farmersdelight:onion_soup", "survivorsdelight:soup/onion_soup"],
  [
    "farmersdelight:pasta_with_meatballs",
    "survivorsdelight:meal/pasta_with_meatballs",
  ],
  [
    "farmersdelight:pasta_with_mutton_chop",
    "survivorsdelight:meal/pasta_with_mutton_chop",
  ],
  ["farmersdelight:pie_crust", "survivorsdelight:pie/pie_crust"],
  ["farmersdelight:pumpkin_soup", "survivorsdelight:soup/pumpkin_soup"],
  ["farmersdelight:ratatouille", "survivorsdelight:meal/ratatouille"],
  [
    "farmersdelight:roasted_mutton_chops",
    "survivorsdelight:meal/roasted_mutton_chops",
  ],
  ["farmersdelight:salmon_roll", "survivorsdelight:food/salmon_roll"],
  ["farmersdelight:squid_ink_pasta", "survivorsdelight:meal/squid_ink_pasta"],
  [
    "farmersdelight:steak_and_potatoes",
    "survivorsdelight:meal/steak_and_potatoes",
  ],
  ["farmersdelight:stuffed_potato", "survivorsdelight:food/stuffed_potato"],
  ["farmersdelight:tomato_sauce", "survivorsdelight:soup/tomato_sauce"],
  [
    "farmersdelight:vegetable_noodles",
    "survivorsdelight:meal/vegetable_noodles",
  ],
  ["farmersdelight:vegetable_soup", "survivorsdelight:soup/vegetable_soup"],
]);

// Teas hydrate instead of feeding. TFC fresh water is thirst 10, so these sit
// above it, and the low decay keeps them travel-worthy. Brewed drinks only;
// leaves and powders are ingredients.
const TEA_WATER = new Map();
function teas(namespace, paths, water, decay) {
  paths
    .trim()
    .split(/\s+/)
    .forEach((path) => {
      TEA_WATER.set(`${namespace}:${path}`, { water: water, decay: decay });
    });
}
// Bucket-sized brews carry more water than a cup.
teas(
  "tfc_gourmet",
  "tea_chamomile_bucket tea_mint_bucket tea_nettle_bucket tea_rosehip_bucket",
  20,
  0.5,
);
teas("delightful", "azalea_tea lavender_tea", 15, 0.5);
// Lattes are milk-based, so they already carry dairy from their profile; the
// hydration is smaller to match.
teas("delightful", "matcha_latte berry_matcha_latte", 10, 0.75);

function foods(namespace, paths, nutrients, decay) {
  paths
    .trim()
    .split(/\s+/)
    .forEach((path) => {
      PROFILES.set(`${namespace}:${path}`, {
        nutrients: nutrients,
        decay: decay,
      });
    });
}

// Parent-scale base portions. These are not category flags: they are the
// quantities used by TFC food data for a normal cooked grain, berry/fruit,
// vegetable, raw red-meat portion, and minor dairy ingredient respectively.
const G = [1.5, 0, 0, 0, 0];
const F = [0, 0.75, 0, 0, 0];
const V = [0, 0, 1, 0, 0];
const P = [0, 0, 0, 2, 0];
const D = [0, 0, 0, 0, 0.5];
const GV = [1.5, 0, 1, 0, 0];
const GP = [1.5, 0, 0, 2, 0];
const GD = [1.5, 0, 0, 0, 0.5];
const GF = [1.5, 0.75, 0, 0, 0];
const FD = [0, 0.75, 0, 0, 0.5];
const VP = [0, 0, 1, 2, 0];
const VD = [0, 0, 1, 0, 0.5];
const GVP = [1.5, 0, 1, 2, 0];
const GPD = [1.5, 0, 0, 2, 0.5];
const GVD = [1.5, 0, 1, 0, 0.5];
const GFD = [1.5, 0.75, 0, 0, 0.5];
const GVPD = [1.5, 0, 1, 2, 0.5];
const NONE = [0, 0, 0, 0, 0];
// Food-mod foods with no explicit profile still get this decay so they spoil
// like TFC food instead of keeping their non-decaying vanilla FoodProperties.
const FALLBACK_DECAY = 2;
// Farmer's Delight's honey-glazed ham is a fourteen-hunger feast, crafted
// from two cooked-rice portions, four sweet berries, and a smoked ham. It is
// intentionally not represented by the generic single-protein profile.
const HONEY_GLAZED_HAM = [2, 3, 0, 5, 0];

// Farmer's Delight and its direct addons.
foods(
  "farmersdelight",
  "rice cooked_rice raw_pasta wheat_dough pie_crust",
  G,
  2,
);
foods(
  "farmersdelight",
  "cabbage cabbage_leaf onion tomato tomato_sauce pumpkin_slice",
  V,
  2,
);
foods(
  "farmersdelight",
  "minced_beef beef_patty chicken_cuts cooked_chicken_cuts bacon cooked_bacon cod_slice cooked_cod_slice salmon_slice cooked_salmon_slice mutton_chops cooked_mutton_chops ham smoked_ham bone_broth",
  P,
  2.5,
);
foods("farmersdelight", "milk_bottle", D, 1.5);
foods(
  "farmersdelight",
  "apple_cider melon_juice fruit_salad melon_popsicle",
  F,
  1.5,
);
foods(
  "farmersdelight",
  "mixed_salad nether_salad vegetable_soup pumpkin_soup ratatouille gleaming_salad",
  V,
  1.5,
);
foods(
  "farmersdelight",
  "fried_egg barbecue_stick chicken_soup fish_stew baked_cod_stew grilled_salmon roast_chicken honey_glazed_ham roasted_mutton_chops",
  P,
  2.25,
);
foods(
  "farmersdelight",
  "egg_sandwich chicken_sandwich hamburger bacon_sandwich mutton_wrap dumplings cabbage_rolls salmon_roll cod_roll kelp_roll kelp_roll_slice",
  GP,
  2,
);
foods(
  "farmersdelight",
  "stuffed_potato stuffed_pumpkin steak_and_potatoes shepherds_pie",
  GVP,
  2,
);
foods(
  "farmersdelight",
  "fried_rice mushroom_rice noodle_soup onion_soup vegetable_noodles",
  GV,
  1.75,
);
foods(
  "farmersdelight",
  "beef_stew bacon_and_eggs pasta_with_meatballs pasta_with_mutton_chop squid_ink_pasta",
  GVP,
  2,
);
foods("farmersdelight", "cake_slice chocolate_pie_slice hot_cocoa", GD, 1.5);
foods(
  "farmersdelight",
  "apple_pie_slice sweet_berry_cheesecake_slice",
  GFD,
  1.5,
);
foods("farmersdelight", "pumpkin_pie_slice", GVD, 1.5);
foods("farmersdelight", "glow_berry_custard", FD, 1.5);
foods("farmersdelight", "sweet_berry_cookie", GF, 1.5);
foods("farmersdelight", "honey_cookie", G, 1.5);
foods("farmersdelight", "honey_glazed_ham", HONEY_GLAZED_HAM, 2.25);
// Whole pies and cakes. The per-slice items are already covered above; the uncut
// item used to come from farmersdelighttfc, whose definition is now disabled
// (tools/gen-food-nutrition-overrides.mjs), so set the whole item here at roughly
// its slice category.
foods("farmersdelight", "apple_pie sweet_berry_cheesecake", [2, 1.5, 0, 0, 0.5], 1.5);
foods("farmersdelight", "chocolate_pie", [2, 0, 0, 0, 1], 1.5);

// Parent-scale equivalents for Farmer's Delight ingredients. Raw and cooked
// cuts use the corresponding TFC meat values instead of the generic category
// marker used by the preliminary bridge above.
foods("farmersdelight", "minced_beef beef_patty", [0, 0, 0, 2, 0], 2);
foods(
  "farmersdelight",
  "chicken_cuts bacon mutton_chops",
  [0, 0, 0, 1.5, 0],
  3,
);
foods("farmersdelight", "cod_slice salmon_slice", [0, 0, 0, 1, 0], 3);
foods(
  "farmersdelight",
  "cooked_chicken_cuts cooked_bacon cooked_mutton_chops",
  [0, 0, 0, 2.5, 0],
  2.25,
);
foods(
  "farmersdelight",
  "cooked_cod_slice cooked_salmon_slice",
  [0, 0, 0, 2, 0],
  2.25,
);
foods("farmersdelight", "ham", [0, 0, 0, 3, 0], 2);
foods("farmersdelight", "smoked_ham", [0, 0, 0, 5, 0], 1.5);
foods("farmersdelight", "fried_egg", [0, 0, 0, 1.5, 0.25], 4);
foods("farmersdelight", "cooked_rice", [1, 0, 0, 0, 0], 1);
foods("farmersdelight", "cabbage", [0, 0, 1, 0, 0], 1.2);
foods("farmersdelight", "cabbage_leaf", [0, 0, 0.5, 0, 0], 1.2);
foods("farmersdelight", "onion", [0, 0, 1, 0, 0], 0.5);
foods("farmersdelight", "tomato", [0, 0, 1.5, 0, 0], 3.5);
foods("farmersdelight", "tomato_sauce", [0, 0, 3, 0, 0], 3.5);
foods("farmersdelight", "pumpkin_slice", [0, 0.75, 0, 0, 0], 1.5);
foods("farmersdelight", "milk_bottle", [0, 0, 0, 0, 0.375], 1.5);
foods("farmersdelight", "rice raw_pasta wheat_dough pie_crust", NONE, 2);
foods("farmersdelight", "fruit_salad", [0, 4.75, 0, 0, 0], 1.5);
// One bowl combines a rice portion with one raw-meat portion. Rotten flesh and
// bone meal are non-nutritive recipe inputs.
foods("farmersdelight", "dog_food", [1, 0, 0, 2, 0], 3);

foods("moredelight", "bread_slice toast", G, 2);
foods("moredelight", "toast_with_honey", G, 1.5);
foods(
  "moredelight",
  "toast_with_sweet_berries toast_with_glow_berries toast_with_blueberries chocolate_popsicle",
  GF,
  1.5,
);
foods(
  "moredelight",
  "toast_with_cheese toast_with_chocolate toast_with_peanut_butter",
  GD,
  1.5,
);
foods(
  "moredelight",
  "diced_potatoes mashed_potatoes carrot_soup tomato_sandwich potato_salad",
  V,
  1.75,
);
foods("moredelight", "omelette toast_with_egg", P, 2);
foods(
  "moredelight",
  "cooked_rice_with_beef cooked_rice_with_chicken_cuts cooked_rice_with_porkchop diced_potatoes_with_beef diced_potatoes_with_chicken_cuts diced_potatoes_with_porkchop chicken_sandwich_with_egg_and_tomato egg_with_bacon_sandwich simple_hamburger steak_sandwich steak_with_egg_sandwich porkchop_sandwich",
  GVP,
  2,
);
foods(
  "moredelight",
  "creamy_pasta_with_chicken_cuts creamy_pasta_with_ham hamburger_with_cheese hamburger_with_egg loaded_hamburger",
  GPD,
  2,
);
foods("moredelight", "diced_potatoes_with_egg_and_tomato chicken_salad", VP, 2);

// Cuisine Delight's recipes state the ingredients in their output names.
foods("cuisinedelight", "fried_egg", P, 2);
foods(
  "cuisinedelight",
  "fried_mushroom vegetable_fried_rice vegetable_pasta vegetable_platter",
  GV,
  1.75,
);
foods("cuisinedelight", "fried_pasta fried_rice", G, 1.75);
foods(
  "cuisinedelight",
  "fried_meat_and_melon ham_fried_rice meat_fried_rice meat_pasta meat_platter meat_with_seafood mixed_fried_rice mixed_pasta seafood_fried_rice seafood_pasta seafood_platter",
  GP,
  2,
);
foods(
  "cuisinedelight",
  "meat_with_vegetables seafood_with_vegetables scrambled_egg_and_tomato suspicious_mix",
  VP,
  2,
);

// Survivor's Delight only adds a player food directly; its other food support
// is tags and recipes for the namespaces covered above.
foods("survivorsdelight", "golden_carrot", V, 1.5);

// Raw fish, at TFC's own raw-fish weight.
foods(
  "aquaculture",
  "atlantic_cod blackfish pacific_halibut atlantic_halibut atlantic_herring pink_salmon pollock rainbow_trout bayad boulti capitaine synodontis smallmouth_bass bluegill brown_trout carp catfish gar minnow muskellunge perch arapaima piranha tambaqui brown_shrooma red_shrooma jellyfish red_grouper tuna fish_fillet_raw",
  [0, 0, 0, 1, 0],
  3,
);
foods("aquaculture", "fish_fillet_cooked", [0, 0, 0, 2, 0], 2.25);
// A fillet is a processed portion, lighter than a whole fish. Match Survivor's
// Aquaculture's own fillet values (0.75 raw, 1.5 cooked) so the fork's entries
// and the mod's static food_items never disagree regardless of load order.
foods("aquaculture", "fish_fillet_raw", [0, 0, 0, 0.75, 0], 3);
foods("aquaculture", "fish_fillet_cooked", [0, 0, 0, 1.5, 0], 2.25);
// Gathered pond growth, not a cultivated crop: half a vegetable portion.
foods("aquaculture", "algae", [0, 0, 0.5, 0, 0], 2);
foods("aquaculture", "sushi", GP, 1.75);
foods("aquaculture", "turtle_soup", VP, 2);

// Rustic Delight.
foods(
  "rusticdelight",
  "bell_pepper_green bell_pepper_red bell_pepper_yellow bell_pepper_slice_green bell_pepper_slice_red bell_pepper_slice_yellow roasted_bell_pepper_green roasted_bell_pepper_red roasted_bell_pepper_yellow roasted_bell_pepper_slice_green roasted_bell_pepper_slice_red roasted_bell_pepper_slice_yellow potato_slices baked_potato_slices fried_mushrooms",
  V,
  2,
);
foods(
  "rusticdelight",
  "calamari calamari_slice cooked_calamari cooked_calamari_slice fried_calamari fried_chicken coffee_braised_beef",
  P,
  2.5,
);
foods(
  "rusticdelight",
  "bell_pepper_pasta bell_pepper_roll_green bell_pepper_roll_red bell_pepper_roll_yellow spring_rolls fried_dumplings",
  GV,
  1.75,
);
foods("rusticdelight", "calamari_roll", GP, 1.75);
foods(
  "rusticdelight",
  "bell_pepper_soup stuffed_bell_pepper_green stuffed_bell_pepper_red stuffed_bell_pepper_yellow potato_salad sweet_salad",
  V,
  1.75,
);
foods(
  "rusticdelight",
  "batter fried_dough pancake chocolate_pancake pumpkin_pancake honey_pancake cherry_blossom_pancake vegetable_pancake",
  G,
  1.75,
);
foods(
  "rusticdelight",
  "cherry_blossom_cheesecake_slice syrup_cheesecake_slice milk_coffee",
  GD,
  1.5,
);
foods(
  "rusticdelight",
  "fruit_beignet cherry_blossom_cookie coffee_cookie syrup_cookie",
  G,
  1.5,
);
foods("rusticdelight", "cherry_blossom_roll", G, 1.5);
foods(
  "rusticdelight",
  "coffee chocolate_coffee dark_coffee honey_coffee roasted_coffee_beans golden_coffee_beans syrup_coffee cooking_oil",
  NONE,
  1,
);
foods("rusticdelight", "syrup syrup_sandwich", G, 1.5);

// Delightful's crops, meat, and composed meals.
foods(
  "delightful",
  "acorn roasted_acorn nut_dough honey_glazed_walnut rock_candy source_berry_cookie smore",
  G,
  2,
);
foods("delightful", "cantaloupe_slice salmonberries", F, 2);
foods(
  "delightful",
  "cactus_flesh cactus_steak cactus_soup cactus_soup_cup cactus_chili field_salad",
  V,
  1.75,
);
foods(
  "delightful",
  "aged_roe caviar animal_fat raw_goat cooked_goat venison_chops cooked_venison_chops venison_stew venison_stew_cup crab_rangoon sinigang sinigang_cup mutton_pie_slice",
  P,
  2.5,
);
foods(
  "delightful",
  "cantaloupe_bread chorus_muffin nut_butter_and_jam_sandwich roe_blini roe_roll salmon_and_roe_blini chunkwich",
  GP,
  1.75,
);
foods(
  "delightful",
  "cheeseburger deluxe_cheeseburger coconut_curry stuffed_cantaloupe",
  GVP,
  2,
);
foods(
  "delightful",
  "baklava_slice blueberry_pie_slice chorus_pie_slice gloomgourd_pie_slice green_apple_pie_slice mulberry_pie_slice passion_fruit_tart_slice salmonberry_pie_slice source_berry_pie_slice",
  GVD,
  1.5,
);
foods(
  "delightful",
  "matcha_ice_cream matcha_latte matcha_milkshake salmonberry_ice_cream salmonberry_milkshake source_berry_ice_cream source_berry_milkshake berry_matcha_latte",
  D,
  1.5,
);
foods(
  "delightful",
  "cantaloupe_gummy matcha_gummy salmonberry_gummy source_berry_gummy cantaloupe_popsicle glow_jam_cookie",
  F,
  1.5,
);
foods("delightful", "cooked_marshmallow_stick marshmallow_stick", G, 1.5);
foods("delightful", "wrapped_cantaloupe", F, 1.5);
// Cutting one clover produces two chopped portions.
foods("delightful", "chopped_clover", [0, 0, 0.5, 0, 0], 1.5);
foods(
  "delightful",
  "azalea_tea lavender_tea green_tea_leaf matcha ender_nectar long_prickly_pear_juice prickly_pear_juice animal_oil_bottle nut_butter_bottle jam_jar glow_jam_jar",
  NONE,
  1,
);

// TFC Gourmet: profiles follow the historical parent recipes at the last
// commit before upstream removed this mod (b8310fd2^).
foods(
  "tfc_gourmet",
  "ox_milk_bucket sheep_milk_bucket alpaca_milk_bucket curdled_ox_milk_bucket curdled_sheep_milk_bucket curdled_alpaca_milk_bucket ox_curd sheep_curd alpaca_curd ox_brinza sheep_brinza alpaca_brinza ox_brinza_slice sheep_brinza_slice alpaca_brinza_slice tzatziki syrniki raw_syrniki",
  D,
  1.5,
);
foods(
  "tfc_gourmet",
  "plant_mix sliced_cabbage adjika sauerkraut kimchi greek_salad hummus raw_falafel falafel gazpacho ratatouille fresh_onion_soup potato_stew pea_soup minestrone schi",
  V,
  1.75,
);
foods("tfc_gourmet", "adjika_bread", GV, 1.75);
foods("tfc_gourmet", "lent_soup", VP, 1.75);
foods("tfc_gourmet", "fresh_onion_soup_bread", GVD, 1.75);
foods(
  "tfc_gourmet",
  "dried_chamomile_leaves dried_mint_leaves dried_nettle_leaves dried_rosehip_leaves cocoa_bucket coffee_bucket compote_bucket kvass_bucket lemonade_bucket nalivka_bucket tea_chamomile_bucket tea_mint_bucket tea_nettle_bucket tea_rosehip_bucket",
  NONE,
  1,
);
foods(
  "tfc_gourmet",
  "porridge porridge_with_honey porridge_with_fruits mamaliga raw_crepes crepes raw_oladyi oladyi raw_croissants croissants",
  G,
  1.75,
);
foods(
  "tfc_gourmet",
  "margarita_pizza four_cheeses_pizza raw_margarita_pizza raw_four_cheeses_pizza raw_khachapuri khachapuri raw_quiche quiche tiramisu",
  GD,
  1.75,
);
foods(
  "tfc_gourmet",
  "pepperoni_pizza hawaiian_pizza four_meats_pizza neapolitano_pizza raw_pepperoni_pizza raw_hawaiian_pizza raw_four_meats_pizza raw_neapolitano_pizza raw_bratwurst bratwurst raw_bulgogi bulgogi raw_kiev_cutlets kiev_cutlets raw_tandoori_chicken tandoori_chicken raw_tonkatsu tonkatsu raw_takoyaki takoyaki",
  GP,
  2.25,
);
foods(
  "tfc_gourmet",
  "raw_placinda placinda raw_lavash_wrap lavash_wrap raw_pelmeni pelmeni raw_vareniki vareniki raw_chebureki chebureki pasta_with_adjika risotto fried_rice",
  GV,
  1.75,
);
foods(
  "tfc_gourmet",
  "borscht solyanka zama curry goulash pho bouillabaisse ramen_with_bacon ramen_with_beef ramen_with_camelidae ramen_with_chevon biryani dolma spaghetti_bolognese pasta_carbonara kharcho shurpa fish_soup fish_soup_tomato cabbage_with_meat",
  GVP,
  2,
);
foods("tfc_gourmet", "okroshka kholodnik", VP, 1.75);

// extradelighttfc already gives TFC food definitions to these ExtraDelight items
// (explicit food_items plus its dynamic_food tag). Leave them to that mod so the
// fallback below never double-defines them.
const EXTRADELIGHT_TFC_COVERED = new Set([
  "extradelight:bbq_jar_item",
  "extradelight:breadcrumbs",
  "extradelight:butter",
  "extradelight:grated_carrot",
  "extradelight:grated_garlic",
  "extradelight:grated_potato",
  "extradelight:potato_sticks",
  "extradelight:sliced_apple",
  "extradelight:sliced_onion",
  "extradelight:sliced_potato",
  "extradelight:sliced_tomato",
  "extradelight:beef_wellington",
  "extradelight:beef_wellington_block_item",
  "extradelight:sausage_roll",
  "extradelight:liver_onions",
  "extradelight:stuffed_heart",
  "extradelight:fried_brains",
  "extradelight:oxtail_soup",
  "extradelight:bbq_ribs",
  "extradelight:bbq_ribs_block_item",
  "extradelight:rack_lamb",
  "extradelight:rack_lamb_block_item",
  "extradelight:haggis",
  "extradelight:haggis_block_item",
  "extradelight:mint_lamb",
  "extradelight:mint_lamb_feast",
  "extradelight:currywurst",
  "extradelight:pulled_pork_sandwich",
  "extradelight:pulled_pork_block_item",
  "extradelight:pork_and_apples",
  "extradelight:pork_and_apples_feast",
]);

// Farmer's Delight feast block items are placed, not eaten, and have no vanilla
// FoodProperties, so this script cannot register them. farmersdelighttfc keeps
// their definition (Survivor's Delight for gleaming_salad); skip them here so no
// empty duplicate gets added. The other mod's copy is disabled by
// tools/gen-food-nutrition-overrides.mjs.
const FD_FEAST_BLOCKS = new Set([
  "farmersdelight:honey_glazed_ham_block",
  "farmersdelight:rice_roll_medley_block",
  "farmersdelight:roast_chicken_block",
  "farmersdelight:shepherds_pie_block",
  "farmersdelight:stuffed_pumpkin_block",
  "farmersdelight:gleaming_salad_block",
]);

const AQUACULTURE_FISH = new Set([
  "atlantic_cod",
  "blackfish",
  "pacific_halibut",
  "atlantic_halibut",
  "atlantic_herring",
  "pink_salmon",
  "pollock",
  "rainbow_trout",
  "bayad",
  "boulti",
  "capitaine",
  "synodontis",
  "smallmouth_bass",
  "bluegill",
  "brown_trout",
  "carp",
  "catfish",
  "gar",
  "minnow",
  "muskellunge",
  "perch",
  "arapaima",
  "piranha",
  "tambaqui",
  "brown_shrooma",
  "red_shrooma",
  "jellyfish",
  "red_grouper",
  "tuna",
]);

TFCEvents.data((event) => {
  const missing = [];
  let registered = 0;
  // Set by tfgm/nutrition.extradelight.js, which loads first on its priority.
  const GENERATED = global.TFGM_EXTRADELIGHT_NUTRITION || {};
  let generatedUsed = 0;
  $BuiltInRegistries.ITEM.entrySet().forEach((entry) => {
    const id = entry.getKey().location();
    // getNamespace()/getPath() hand back java.lang.String. Rhino compares those
    // to JS string literals by identity, so Set/Map lookups and === silently
    // never match unless the values are coerced to JS strings first.
    const namespace = String(id.getNamespace());
    const path = String(id.getPath());
    const key = `${namespace}:${path}`;
    if (!FOOD_MODS.has(namespace)) return;
    if (FD_FEAST_BLOCKS.has(key)) return;
    const nativeFood = entry.getValue().getFoodProperties();
    const fish = namespace === "aquaculture" && AQUACULTURE_FISH.has(path);
    if (nativeFood === null && !fish) return;
    let profile = PROFILES.get(key);
    if (profile === undefined) {
      // extradelighttfc defines these; skip so we do not double-define them.
      if (EXTRADELIGHT_TFC_COVERED.has(key)) return;
      // ExtraDelight is too large to curate by hand, so its profiles are
      // derived from its own recipes by tools/gen-extradelight-nutrition.mjs.
      if (GENERATED[key] !== undefined) {
        profile = { nutrients: GENERATED[key].n, decay: GENERATED[key].d };
        generatedUsed++;
      } else {
        // No profile at all: keep the item's own hunger/saturation but give it
        // a default TFC decay so it spoils. Nutrients stay empty.
        missing.push(key);
        profile = { nutrients: NONE, decay: FALLBACK_DECAY };
      }
    }
    const hungerValue = nativeFood === null ? 4 : nativeFood.getNutrition();
    const saturationValue =
      nativeFood === null ? 0 : nativeFood.getSaturationModifier();
    // One-shot migration aid: hunger/saturation come from each item's vanilla
    // FoodProperties, which live in mod Java and cannot be read from the jars.
    // Logging them lets the static data/<ns>/tfc/food_items/*.json files be
    // generated offline. Delete DUMP_FOOD_PROPERTIES once those exist.
    if (DUMP_FOOD_PROPERTIES) {
      console.info(
        `[TFGM-DUMP] ${key} ${hungerValue} ${saturationValue} ${profile.decay} ${profile.nutrients.join(",")}`,
      );
    }
    const configureFood = (food) => {
      // TFC fish are hunger 4 / saturation 0 when raw; force Aquaculture whole
      // fish to match so raw lines up with the cooked variants (tfgm/cooked_fish).
      if (fish) {
        food.hunger(4).saturation(0);
      } else {
        if (hungerValue > 0) food.hunger(hungerValue);
        if (nativeFood !== null)
          food.saturation(nativeFood.getSaturationModifier());
      }
      const tea = TEA_WATER.get(key);
      food.decayModifier(tea === undefined ? profile.decay : tea.decay);
      if (tea !== undefined) food.water(tea.water);
      const [grain, fruit, vegetables, protein, dairy] = profile.nutrients;
      if (grain) food.grain(grain);
      if (fruit) food.fruit(fruit);
      if (vegetables) food.vegetables(vegetables);
      if (protein) food.protein(protein);
      if (dairy) food.dairy(dairy);
    };
    const resourceId = PROFILE_RESOURCE_IDS.get(key);
    if (resourceId === undefined) {
      event.foodItem(key, configureFood);
    } else {
      event.foodItem(key, configureFood, resourceId);
    }
    registered++;
  });
  console.info(
    `[TFGM] Registered explicit TFC nutrition for ${registered} fork foods (${generatedUsed} derived from ExtraDelight recipes).`,
  );
  // An exception here aborts the whole TFCEvents.data callback, so one uncovered
  // item would drop nutrition for EVERY OTHER food instead of just its own. Wild.
  if (missing.length) {
    console.info(
      `[TFGM] Gave default decay (empty nutrients) to ${missing.length} foods lacking a profile: ${missing.join(", ")}`,
    );
  }
});
