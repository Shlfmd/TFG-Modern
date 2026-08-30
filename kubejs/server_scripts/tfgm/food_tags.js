"use strict";

// Survivor's Delight incorrectly marks the cooked beef patty as raw meat.
// It is also a Firmalife pizza ingredient, which made the parent brining loop
// emit the same recipe twice under one ID.
ServerEvents.tags("item", (event) => {
  event.remove("tfc:foods/raw_meats", "farmersdelight:beef_patty");
});
