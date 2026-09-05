"use strict";

// ExtraDelight ships minecraft:campfire_cooking recipes for 33 of its foods,
// letting a plain campfire cook them and bypass TFC's heat model. Every one of
// those foods also has an extradelight:oven (or crafting) recipe, so removing
// the campfire path leaves them all obtainable through the mod's own oven. The
// matching minecraft:smelting/smoking recipes are left alone: the furnace and
// smoker are unobtainable in TFG, so they are already dead.
ServerEvents.recipes((event) => {
  event.remove({ type: "minecraft:campfire_cooking", mod: "extradelight" });
});
