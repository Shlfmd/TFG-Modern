// Derives TFC nutrient profiles for ExtraDelight foods from ExtraDelight's own
// recipe graph, so a dish's nutrition follows from what actually goes into it.
//
// Usage:
//   node tools/gen-extradelight-nutrition.mjs \
//     --data <dir with extracted data/ trees> \
//     --targets <file of item ids, one per line> \
//     --nutrition kubejs/server_scripts/tfgm/nutrition.js \
//     --out kubejs/server_scripts/tfgm/nutrition.extradelight.js
//
// <dir> is produced by unzipping, from every serverpack mod jar:
//   data/*/tags/items/*  data/*/tfc/food_items/*
// plus data/*/recipes/* from the extradelight and extradelighttfc jars.

import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import vm from "node:vm";

const NUTRIENTS = ["grain", "fruit", "vegetables", "protein", "dairy"];

// TFC's own foods top out around 5 in a single category; keep derived meals in
// the same range so a nine-ingredient dish cannot outclass every native food.
const NUTRIENT_CAP = 5;
const TOTAL_CAP = 8;

// Condiments are jars and bottles used by the spoonful, and the container comes
// back out of the recipe. Counting a whole jar of mayo would hand every
// sandwich in the mod the protein of the eggs that jar was made from.
const CONDIMENT_SCALE = 0.25;
const isCondiment = (t) =>
  (t.kind === "tag" &&
    (t.id.includes("condiments/") || t.id.includes("sauce"))) ||
  (t.kind === "item" && /_jar_item$|_bottle$|_sauce$/.test(t.id));
const DECAY_MIN = 1;
const DECAY_MAX = 3;
const DEFAULT_DECAY = 2;

// Fluids that carry nutrition. Amounts are per-recipe millibuckets; TFC dairy
// sits near 0.5 for a bottle, so 1000mB of milk lands at 2.
const FLUID_NUTRIENTS = {
  "minecraft:milk": { dairy: 2 },
  "farmersdelight:milk": { dairy: 2 },
  "extradelight:milk": { dairy: 2 },
  "extradelight:cream": { dairy: 3 },
  "extradelight:condensed_milk": { dairy: 3 },
  "extradelight:whipped_cream_fluid": { dairy: 2 },
  "extradelight:heavy_cream": { dairy: 3 },
};

// TFC pays nutrition out at the finished-food step, not on staples. I.e., its own
// flour, dough and butter definitions all carry zero, and the grain arrives on
// bread. ExtraDelight bakes straight from staples, so without these the entire
// baking half of the mod derives to nothing. Every value is lifted from the
// TFC-side definition of the same ingredient's finished form, named alongside.
// Keys starting with # are item tags.
// Shit's weird.
const STAPLE_SEEDS = {
  "extradelight:flour": { grain: 1 }, // tfc:food/wheat_bread grain 1
  "#c:flour": { grain: 1 },
  "#c:flours/wheat": { grain: 1 },
  "extradelight:butter": { dairy: 0.25 }, // firmalife toast_with_butter dairy 0.25
  "#c:butter": { dairy: 0.25 },
  "#c:eggs": { protein: 1.5, dairy: 0.25 }, // tfc:food/cooked_egg
  "#extradelight:egg_or_yolk": { protein: 1.5, dairy: 0.25 },
  "extradelight:egg_yolk": { protein: 0.75, dairy: 0.13 }, // half an egg
  "extradelight:cheese": { dairy: 3 }, // tfc:food/cheese dairy 3
  "#c:cheese": { dairy: 3 },
  "#c:foods/milk": { dairy: 0.5 }, // nutrition.js dairy portion
  "#c:drinks/milk": { dairy: 0.5 },
  "#c:crops/rice": { grain: 0.5 }, // farmersdelight raw rice, below cooked
  "extradelight:cooked_pasta": { grain: 1 }, // farmersdelight raw_pasta grain 0.5, cooked
  // ExtraDelight crops that no mod gives a TFC definition. Values are the
  // pack's own category portions from nutrition.js (fruit 0.75, vegetable 1).
  "#c:crops/grapefruit": { fruit: 0.75 },
  "#c:mint": { vegetables: 0.5 },
  "#c:seeds/corn": { grain: 0.5 },
  "#c:soybeans/soaked": { protein: 0.5 },
};

// Foods the recipe graph cannot settle on its own. Each value is grounded in
// the shipped item or recipe data, or in an existing pack profile for the same
// dish. These are applied only while an item remains unresolved, so a future
// ExtraDelight recipe can replace them automatically.
const MANUAL_PROFILES = {
  // Loot-only rotten food. It intentionally provides no TFC nutrients.
  "extradelight:bad_food": {
    vec: [0, 0, 0, 0, 0],
    decay: DEFAULT_DECAY,
    via: "loot_only_empty",
  },
  // Legendary chest loot using the same FoodProperties as the nutrient-empty
  // chocolate bars.
  "extradelight:easter_egg": {
    vec: [0, 0, 0, 0, 0],
    decay: DEFAULT_DECAY,
    via: "chocolate_empty",
  },
  // The pack override cuts one TFC melon slice (fruit 0.8, decay 2.25) into
  // two chunks and one rind, so the rind carries one third of the input fruit.
  "extradelight:melon_rind": {
    vec: [0, 0.27, 0, 0, 0],
    decay: 2.25,
    via: "melon_cutting",
  },
  // Exact counterpart to delightful:nut_butter_and_jam_sandwich, already
  // curated as grain + protein at decay 1.75 in nutrition.js.
  "extradelight:peanut_butter_jelly": {
    vec: [1.5, 0, 0, 2, 0],
    decay: 1.75,
    via: "pack_analogue",
  },
  // Two salami-mix portions become one unripe salami, then aging is one-to-one.
  "extradelight:salami_item": {
    vec: [0, 0, 0.12, 0.5, 0],
    decay: 1.45,
    via: "salami_aging",
  },
};

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) {
    if (fallback !== undefined) return fallback;
    throw new Error(`missing --${name}`);
  }
  return process.argv[i + 1];
}

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (e.endsWith(".json")) out.push(p);
  }
  return out;
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

const zero = () => NUTRIENTS.map(() => 0);
const isZero = (v) => v.every((n) => n === 0);

// ---------------------------------------------------------------- tag index

// data/<ns>/tags/items/<path>.json -> "<ns>:<path>"
function tagIdFromPath(p) {
  const parts = p.split(sep);
  const i = parts.lastIndexOf("data");
  if (i === -1) return null;
  const ns = parts[i + 1];
  const rest = parts
    .slice(i + 4)
    .join("/")
    .replace(/\.json$/, "");
  if (parts[i + 2] !== "tags" || parts[i + 3] !== "items") return null;
  return `${ns}:${rest}`;
}

function buildTags(files) {
  const tags = new Map();
  for (const f of files) {
    const id = tagIdFromPath(f);
    if (!id) continue;
    const json = readJson(f);
    if (!json || !Array.isArray(json.values)) continue;
    const members = json.values
      .map((v) => (typeof v === "string" ? v : v && v.id))
      .filter(Boolean);
    // Several mods contribute to the same tag; merge rather than overwrite.
    const prev = tags.get(id) || [];
    tags.set(id, prev.concat(members));
  }
  return tags;
}

function tagMembers(tags, id, seen = new Set()) {
  if (seen.has(id)) return [];
  seen.add(id);
  const out = [];
  for (const m of tags.get(id) || []) {
    if (m.startsWith("#")) out.push(...tagMembers(tags, m.slice(1), seen));
    else out.push(m);
  }
  return out;
}

// -------------------------------------------------------------- seed values

// TFC food definitions ship as data/<ns>/tfc/food_items/*.json and are the
// authoritative nutrition for everything TFG already curates.
function buildTfcSeeds(files) {
  const byItem = new Map();
  const byTag = new Map();
  for (const f of files) {
    if (!f.includes(`${sep}tfc${sep}food_items${sep}`)) continue;
    const json = readJson(f);
    if (!json || !json.ingredient) continue;
    const vec = NUTRIENTS.map((n) => Number(json[n]) || 0);
    const decay = Number(json.decay_modifier);
    const entry = { vec, decay: Number.isFinite(decay) ? decay : undefined };
    const ing = json.ingredient;
    if (ing.item) byItem.set(ing.item, entry);
    else if (ing.tag) byTag.set(ing.tag, entry);
  }
  return { byItem, byTag };
}

// nutrition.js holds the hand-curated profiles as live JS. Evaluate the part
// above its TFCEvents hook rather than re-typing 390 entries here.
function buildScriptSeeds(nutritionPath) {
  const src = readFileSync(nutritionPath, "utf8");
  const cut = src.indexOf("TFCEvents.data");
  const head =
    (cut === -1 ? src : src.slice(0, cut)) +
    "\n;globalThis.__PROFILES = PROFILES;";
  const ctx = vm.createContext({
    Java: { loadClass: () => ({}) },
    globalThis: undefined,
  });
  ctx.globalThis = ctx;
  vm.runInContext(head, ctx);
  const map = new Map();
  for (const [k, v] of ctx.__PROFILES) {
    map.set(k, { vec: v.nutrients.slice(), decay: v.decay });
  }
  return map;
}

// ------------------------------------------------------------ recipe graph

function idOf(x) {
  if (!x) return null;
  if (typeof x === "string") return x;
  if (typeof x === "object") return x.id || x.item || null;
  return null;
}

function ingredientTokens(node, out = []) {
  if (!node) return out;
  if (Array.isArray(node)) {
    for (const n of node) ingredientTokens(n, out);
    return out;
  }
  if (typeof node === "string") {
    out.push({ kind: "item", id: node });
    return out;
  }
  if (typeof node === "object") {
    if (node.tag) out.push({ kind: "tag", id: node.tag });
    else if (node.fluid) {
      // Create states fluid inputs inline rather than in a `fluid` field.
      out.push({
        kind: "fluid",
        id: idOf(node.fluid) || node.fluid,
        amount: Number(node.amount) || 1000,
      });
    } else if (node.item) out.push({ kind: "item", id: idOf(node.item) });
    else if (node.id) out.push({ kind: "item", id: node.id });
  }
  return out;
}

// Recipes state their output as `result`, `results` (Create) or `output`.
function resultNode(json) {
  if (json.result != null) {
    return Array.isArray(json.result)
      ? json.result[0] && (json.result[0].item ?? json.result[0])
      : json.result;
  }
  if (Array.isArray(json.results) && json.results.length) {
    const first = json.results.find((x) => x && (x.item || x.id));
    return first ? (first.item ?? first) : null;
  }
  if (json.output != null) return json.output;
  return null;
}

// A feast recipe carries no ingredients: it serves portions out of a feast
// block that was itself cooked from real ingredients. Nutrition comes from the
// block, split across its servings.
const FEAST_SERVINGS = 4;

function parseRecipe(json) {
  if (!json || typeof json !== "object") return null;
  if (json.result == null && json.results == null && json.output == null) {
    return null;
  }

  if (json.type === "extradelight:feast") {
    const out = idOf(json.result);
    const block = idOf(json.out);
    if (!out || !block) return null;
    return {
      out,
      count: FEAST_SERVINGS,
      tokens: [{ kind: "item", id: block }],
      type: json.type,
    };
  }

  const r = resultNode(json);
  const out = idOf(r);
  if (!out) return null;
  const count = Number((r && r.count) || 1) || 1;

  const tokens = [];
  ingredientTokens(json.ingredients, tokens);
  ingredientTokens(json.ingredient, tokens);
  ingredientTokens(json.inputs, tokens);
  // Shaped crafting: each key counts once per occurrence in the pattern.
  if (Array.isArray(json.pattern) && json.key) {
    const chars = json.pattern.join("").split("");
    for (const [k, v] of Object.entries(json.key)) {
      const n = chars.filter((c) => c === k).length;
      for (let i = 0; i < n; i++) ingredientTokens(v, tokens);
    }
  }
  // The container is eaten with the dish when it is itself a food (toast,
  // pie crust); bowls and trays simply resolve to nothing.
  if (json.container) {
    const cid = idOf(json.container);
    if (cid) tokens.push({ kind: "item", id: cid });
  }
  if (json.fluid) {
    const fid = idOf(json.fluid);
    if (fid) {
      tokens.push({
        kind: "fluid",
        id: fid,
        amount: Number(json.fluid.amount) || 1000,
      });
    }
  }
  if (!tokens.length) return null;
  return { out, count, tokens, type: json.type || "" };
}

// --------------------------------------------------------------- resolution

function main() {
  const dataDir = arg("data");
  const targetsPath = arg("targets");
  const nutritionPath = arg("nutrition");
  const outPath = arg("out");

  const files = walk(dataDir);
  const tags = buildTags(
    files.filter((f) => f.includes(`tags${sep}items${sep}`)),
  );
  const tfc = buildTfcSeeds(files);
  const script = buildScriptSeeds(nutritionPath);

  const recipes = [];
  for (const f of files) {
    if (!f.includes(`${sep}recipes${sep}`)) continue;
    const parsed = parseRecipe(readJson(f));
    if (parsed) recipes.push(parsed);
  }

  const targets = readFileSync(targetsPath, "utf8")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  const targetSet = new Set(targets);

  // known: item id -> {vec, decay}. Seeded with everything already curated.
  const known = new Map();
  const seed = (id, entry) => {
    if (!id || known.has(id) || targetSet.has(id)) return;
    known.set(id, { vec: entry.vec.slice(), decay: entry.decay });
  };
  for (const [id, e] of tfc.byItem) seed(id, e);
  for (const [id, e] of script) seed(id, e);
  // Tag-wide TFC definitions apply to every member of the tag.
  for (const [tag, e] of tfc.byTag) {
    for (const m of tagMembers(tags, tag)) seed(m, e);
  }

  const vecOf = (obj) => NUTRIENTS.map((n) => Number(obj[n]) || 0);
  const tagOverrides = new Map();
  for (const [key, obj] of Object.entries(STAPLE_SEEDS)) {
    const entry = { vec: vecOf(obj), decay: undefined };
    if (key.startsWith("#")) tagOverrides.set(key.slice(1), entry);
    else known.set(key, entry);
  }

  const resolveToken = (t) => {
    if (t.kind === "item") return known.get(t.id) || null;
    if (t.kind === "fluid") {
      const f = FLUID_NUTRIENTS[t.id];
      if (!f) return null;
      const vec = zero();
      const scale = (t.amount || 1000) / 1000;
      for (const [k, v] of Object.entries(f)) {
        vec[NUTRIENTS.indexOf(k)] = v * scale;
      }
      return { vec, decay: undefined };
    }
    // A tag stands for any of its members; average the ones we know so a
    // "#c:apple/sliced" contributes apple-ish fruit regardless of which mod
    // supplied the slice.
    // ExtraDelight references tags no mod in the pack defines, such as
    // c:beef/cubed/raw. Fall back to the nearest parent tag that does exist
    // (c:beef) rather than losing the ingredient entirely.
    let hits = [];
    let path = t.id;
    for (;;) {
      hits = tagMembers(tags, path)
        .map((m) => known.get(m))
        .filter(Boolean);
      if (hits.length) break;
      const override = tagOverrides.get(path);
      if (override) return override;
      const cut = path.lastIndexOf("/");
      if (cut === -1) return null;
      path = path.slice(0, cut);
    }
    const vec = zero();
    for (const h of hits) for (let i = 0; i < 5; i++) vec[i] += h.vec[i];
    for (let i = 0; i < 5; i++) vec[i] /= hits.length;
    const decays = hits.map((h) => h.decay).filter((d) => Number.isFinite(d));
    const decay = decays.length
      ? decays.reduce((a, b) => a + b, 0) / decays.length
      : undefined;
    return { vec, decay };
  };

  const evaluate = (r, strict = true) => {
    const vec = zero();
    const decays = [];
    let resolved = 0;
    let pending = false;
    for (const t of r.tokens) {
      // An item we can still derive is worth waiting for; a bowl is not.
      if (
        strict &&
        t.kind === "item" &&
        derivable.has(t.id) &&
        !known.has(t.id)
      ) {
        pending = true;
        continue;
      }
      const hit = resolveToken(t);
      if (!hit) continue;
      if (!isZero(hit.vec)) resolved++;
      const scale = isCondiment(t) ? CONDIMENT_SCALE : 1;
      for (let i = 0; i < 5; i++) vec[i] += hit.vec[i] * scale;
      if (Number.isFinite(hit.decay)) decays.push(hit.decay);
    }
    for (let i = 0; i < 5; i++)
      vec[i] = Math.min(NUTRIENT_CAP, vec[i] / r.count);
    // A nine-ingredient dish would otherwise beat every food in the game at
    // once. TFC's richest composite (farmersdelight honey_glazed_ham) totals 8
    // across all categories, so scale anything above that back proportionally.
    const total = vec.reduce((a, b) => a + b, 0);
    if (total > TOTAL_CAP) {
      for (let i = 0; i < 5; i++) vec[i] *= TOTAL_CAP / total;
    }
    for (let i = 0; i < 5; i++) vec[i] = Math.round(vec[i] * 100) / 100;
    const decay = decays.length
      ? Math.min(
          DECAY_MAX,
          Math.max(
            DECAY_MIN,
            Math.round(
              (decays.reduce((a, b) => a + b, 0) / decays.length) * 100,
            ) / 100,
          ),
        )
      : DEFAULT_DECAY;
    return { vec, decay, resolved, pending };
  };

  // Derive across every craftable item, not just the emitted ones. Most meals
  // are built from ExtraDelight intermediates (flour, butter, chocolate) that
  // are not foods themselves, so nothing grounds out unless those resolve too.
  const byOutput = new Map();
  for (const r of recipes) {
    if (known.has(r.out)) continue;
    if (!byOutput.has(r.out)) byOutput.set(r.out, []);
    byOutput.get(r.out).push(r);
  }
  const derivable = new Set(byOutput.keys());
  const universe = [...derivable];

  const derived = new Map();
  const sources = new Map();

  // strict: wait for anything still derivable instead of reading it as zero.
  const sweep = (strict) => {
    for (let pass = 0; pass < 40; pass++) {
      let changed = 0;
      for (const id of universe) {
        if (derived.has(id)) continue;
        let best = null;
        let bestRecipe = null;
        for (const r of byOutput.get(id)) {
          const e = evaluate(r, strict);
          if (strict && e.pending) continue;
          if (isZero(e.vec)) continue;
          if (!best || e.resolved > best.resolved) {
            best = e;
            bestRecipe = r;
          }
        }
        if (!best) continue;
        derived.set(id, best);
        sources.set(id, bestRecipe);
        known.set(id, { vec: best.vec, decay: best.decay });
        changed++;
      }
      if (!changed) break;
    }
  };

  sweep(true);
  // Second sweep breaks cycles (a cake made of its own slices) and dead ends.
  sweep(false);

  // A tag's value is the average of the members known at the time, so items
  // resolved in an early pass were priced against a thinner seed set. Recompute
  // every dish from its chosen recipe now that the graph is complete.
  for (let pass = 0; pass < 3; pass++) {
    for (const [id, r] of sources) {
      const e = evaluate(r, false);
      if (isZero(e.vec) && !isZero(derived.get(id).vec)) continue;
      derived.set(id, e);
      known.set(id, { vec: e.vec, decay: e.decay });
    }
  }

  // A staple that is itself one of the emitted foods keeps its seeded value.
  for (const id of targets) {
    if (derived.has(id) || !known.has(id)) continue;
    const k = known.get(id);
    derived.set(id, {
      vec: k.vec,
      decay: Number.isFinite(k.decay) ? k.decay : DEFAULT_DECAY,
    });
  }

  const empty = [];
  for (const [id, profile] of Object.entries(MANUAL_PROFILES)) {
    if (!targetSet.has(id) || derived.has(id)) continue;
    derived.set(id, { vec: profile.vec.slice(), decay: profile.decay });
    sources.set(id, { type: `manual:${profile.via}` });
    if (isZero(profile.vec)) empty.push(id);
  }

  // Whatever is left has no nutritive input at all: candy is sugar and dye.
  // Record it explicitly with a derived decay rather than leaving it to the
  // blanket fallback, and mark it in the output.
  for (const id of targets) {
    if (derived.has(id)) continue;
    const rs = byOutput.get(id);
    if (!rs) continue;
    const e = evaluate(rs[0], false);
    derived.set(id, e);
    sources.set(id, rs[0]);
    empty.push(id);
  }

  const unresolved = targets.filter((id) => !derived.has(id));
  const noRecipe = unresolved.filter((id) => !byOutput.has(id));

  // --explain <id> prints how one dish was worked out, for checking the tool.
  const explainIdx = process.argv.indexOf("--explain");
  if (explainIdx !== -1) {
    const id = process.argv[explainIdx + 1];
    console.log(`seeded items: ${known.size}`);
    const r = sources.get(id) || (byOutput.get(id) || [])[0];
    if (!r) {
      console.log(`${id}: no recipe`);
    } else {
      console.log(`${id} via ${r.type} (makes ${r.count})`);
      for (const t of r.tokens) {
        const hit = resolveToken(t);
        const members =
          t.kind === "tag" ? tagMembers(tags, t.id).slice(0, 4).join(" ") : "";
        console.log(
          `  ${t.kind}:${t.id} -> ${hit ? `[${hit.vec.join(",")}]` : "UNKNOWN"}${members ? `   members: ${members}` : ""}`,
        );
      }
      console.log(`  = ${JSON.stringify(derived.get(id))}`);
    }
    return;
  }

  // --gaps ranks the inputs that most often resolve to nothing, which is the
  // list of things worth seeding next.
  if (process.argv.includes("--gaps")) {
    const counts = new Map();
    for (const id of targets) {
      const d = derived.get(id);
      if (!d || !isZero(d.vec)) continue;
      const r = sources.get(id);
      if (!r) continue;
      for (const t of r.tokens) {
        if (resolveToken(t)) continue;
        const k = `${t.kind}:${t.id}`;
        counts.set(k, (counts.get(k) || 0) + 1);
      }
    }
    for (const [k, n] of [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 40)) {
      const members = k.startsWith("tag:")
        ? tagMembers(tags, k.slice(4)).slice(0, 5).join(" ")
        : "";
      console.log(`${String(n).padStart(4)}  ${k}   ${members}`);
    }
    return;
  }

  const emitted = targets.filter((id) => derived.has(id));
  writeFileSync(outPath, render(targets, derived, sources, unresolved, empty));

  console.log(`targets:     ${targets.length}`);
  console.log(
    `emitted:     ${emitted.length} (${empty.length} with no nutritive input)`,
  );
  console.log(
    `graph nodes: ${derived.size} derived across the whole recipe graph`,
  );
  console.log(
    `unresolved:  ${unresolved.length} (${noRecipe.length} have no recipe at all)`,
  );
  console.log(`written:     ${outPath}`);
  if (unresolved.length) {
    console.log(`\nunresolved ids:\n${unresolved.join("\n")}`);
  }
}

function render(targets, derived, sources, unresolved, empty) {
  const emptySet = new Set(empty);
  const lines = [];
  lines.push("// priority: 100");
  lines.push('"use strict";');
  lines.push("");
  lines.push(
    "// GENERATED by tools/gen-extradelight-nutrition.mjs. Do not hand-edit.",
  );
  lines.push(
    "// Nutrients are derived from each dish's own ExtraDelight recipe, so the",
  );
  lines.push("// numbers follow the ingredients. Read by tfgm/nutrition.js.");
  lines.push(
    "// [grain, fruit, vegetables, protein, dairy], then decay modifier.",
  );
  lines.push("");
  const emitted = targets.filter((id) => derived.has(id));
  lines.push(`// ${emitted.length} of ${targets.length} ExtraDelight foods.`);
  if (empty.length) {
    lines.push(
      `// ${empty.length} resolve to no nutrients because nothing nutritive goes`,
    );
    lines.push(
      "// into them (candy is sugar and dye). They are marked EMPTY below.",
    );
  }
  if (unresolved.length) {
    lines.push(
      `// ${unresolved.length} unresolved (no recipe, or every recipe grounds out empty):`,
    );
    for (const id of unresolved) lines.push(`//   ${id}`);
  }
  lines.push("");
  lines.push("global.TFGM_EXTRADELIGHT_NUTRITION = {");
  for (const id of targets) {
    const d = derived.get(id);
    if (!d) continue;
    const src = sources.get(id);
    const via = src ? src.type.replace(/^.*:/, "") : "";
    const note = emptySet.has(id) ? `${via} EMPTY` : via;
    lines.push(
      `  "${id}": { n: [${d.vec.join(", ")}], d: ${d.decay} }, // ${note}`,
    );
  }
  lines.push("};");
  lines.push("");
  return lines.join("\n");
}

main();
