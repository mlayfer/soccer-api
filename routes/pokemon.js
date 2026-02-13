import { Router } from "express";
import axios from "axios";
import * as cheerio from "cheerio";

const router = Router();

// ──────────────────────────────────────────────────────────────
//  POKÉAPI — pokeapi.co (free, no key required)
// ──────────────────────────────────────────────────────────────
const POKE_BASE = "https://pokeapi.co/api/v2";

// Simple in-memory cache — Pokemon data never changes
const cache = new Map();
const CACHE_TTL = 1000 * 60 * 60 * 24; // 24 hours

const CACHE_MISS = Symbol("CACHE_MISS");

function cached(key) {
  const entry = cache.get(key);
  if (entry && Date.now() - entry.ts < CACHE_TTL) return entry.data;
  return CACHE_MISS;
}

function setCache(key, data) {
  cache.set(key, { data, ts: Date.now() });
  return data;
}

/**
 * Fetch JSON with caching.
 */
async function pokeGet(url) {
  const hit = cached(url);
  if (hit !== CACHE_MISS) return hit;
  const { data } = await axios.get(url, { timeout: 15_000 });
  return setCache(url, data);
}

// ──────────────────────────────────────────────────────────────
//  HEBREW TRANSLATION MAPS
//  Based on official Israeli Pokemon terminology from
//  pocketmonsters.co.il & the Hebrew anime dub.
// ──────────────────────────────────────────────────────────────

const TYPE_HE = {
  normal: "נורמלי",
  fire: "אש",
  water: "מים",
  grass: "עשב",
  electric: "חשמל",
  ice: "קרח",
  fighting: "לוחם",
  poison: "רעל",
  ground: "אדמה",
  flying: "מעופף",
  psychic: "על-חושי",
  bug: "חרק",
  rock: "סלע",
  ghost: "רפאים",
  dragon: "דרקון",
  dark: "אופל",
  steel: "מתכת",
  fairy: "פיה",
  stellar: "כוכבי",
  unknown: "לא ידוע",
};

const STAT_HE = {
  hp: "נקודות חיים",
  attack: "התקפה",
  defense: "הגנה",
  "special-attack": "התקפה מיוחדת",
  "special-defense": "הגנה מיוחדת",
  speed: "מהירות",
};

const COLOR_HE = {
  black: "שחור",
  blue: "כחול",
  brown: "חום",
  gray: "אפור",
  green: "ירוק",
  pink: "ורוד",
  purple: "סגול",
  red: "אדום",
  white: "לבן",
  yellow: "צהוב",
};

const SHAPE_HE = {
  ball: "כדור",
  squiggle: "פיתול",
  fish: "דג",
  arms: "זרועות",
  blob: "אמורפי",
  upright: "זקוף",
  legs: "רגליים",
  quadruped: "ארבע רגליים",
  wings: "כנפיים",
  tentacles: "זרועונים",
  heads: "ראשים",
  humanoid: "דמוי אדם",
  "bug-wings": "כנפי חרק",
  armor: "שריון",
};

const HABITAT_HE = {
  cave: "מערה",
  forest: "יער",
  grassland: "מרעה",
  mountain: "הר",
  rare: "נדיר",
  "rough-terrain": "שטח סלעי",
  sea: "ים",
  urban: "עירוני",
  "waters-edge": "חוף מים",
};

const GROWTH_RATE_HE = {
  slow: "איטי",
  medium: "בינוני",
  fast: "מהיר",
  "medium-slow": "בינוני-איטי",
  "slow-then-very-fast": "איטי ואז מהיר מאוד",
  "fast-then-very-slow": "מהיר ואז איטי מאוד",
};

const GENERATION_HE = {
  "generation-i": "דור ראשון",
  "generation-ii": "דור שני",
  "generation-iii": "דור שלישי",
  "generation-iv": "דור רביעי",
  "generation-v": "דור חמישי",
  "generation-vi": "דור שישי",
  "generation-vii": "דור שביעי",
  "generation-viii": "דור שמיני",
  "generation-ix": "דור תשיעי",
};

const REGION_HE = {
  kanto: "קאנטו",
  johto: "ג'וטו",
  hoenn: "הואן",
  sinnoh: "סינו",
  unova: "יונובה",
  kalos: "קאלוס",
  alola: "אלולה",
  galar: "גאלאר",
  paldea: "פלדאה",
};

const ABILITY_HE = {
  overgrow: "צמיחת יתר",
  blaze: "להבה",
  torrent: "זרם",
  "shield-dust": "אבקת מגן",
  "run-away": "בריחה",
  "shed-skin": "החלפת עור",
  "compound-eyes": "עיניים מורכבות",
  swarm: "נחיל",
  "keen-eye": "עין חדה",
  "tangled-feet": "רגליים סבוכות",
  "big-pecks": "חזה גדול",
  guts: "אומץ",
  hustle: "מרץ",
  sniper: "צלף",
  intimidate: "הפחדה",
  static: "חשמל סטטי",
  "lightning-rod": "מוליך ברקים",
  "sand-veil": "מסך חול",
  "sand-rush": "דהירת חול",
  "poison-point": "קוץ רעל",
  rivalry: "יריבות",
  "sheer-force": "כוח גס",
  "cute-charm": "קסם חמוד",
  "magic-guard": "מגן קסם",
  "friend-guard": "מגן ידיד",
  unaware: "חוסר מודעות",
  "flash-fire": "הצתה",
  drought: "בצורת",
  chlorophyll: "כלורופיל",
  "effect-spore": "נבג אפקט",
  "dry-skin": "עור יבש",
  damp: "לחות",
  "swift-swim": "שחייה מהירה",
  "rain-dish": "מנת גשם",
  "water-absorb": "ספיגת מים",
  "sand-stream": "סופת חול",
  "snow-warning": "אזהרת שלג",
  levitate: "ריחוף",
  synchronize: "סנכרון",
  "inner-focus": "ריכוז פנימי",
  "early-bird": "ציפור מוקדמת",
  "flame-body": "גוף להבה",
  sturdy: "עמיד",
  "rock-head": "ראש סלע",
  pressure: "לחץ",
  "natural-cure": "ריפוי טבעי",
  "serene-grace": "חסד שליו",
  "speed-boost": "תאוצת מהירות",
  "battle-armor": "שריון קרב",
  "shell-armor": "שריון קונכייה",
  "clear-body": "גוף נקי",
  "thick-fat": "שומן עבה",
  "huge-power": "כוח עצום",
  "pure-power": "כוח טהור",
  "truant": "עצלן",
  "wonder-guard": "מגן פלא",
  "shadow-tag": "תג צל",
  immunity: "חסינות",
  adaptability: "הסתגלות",
  "skill-link": "קישור מיומנות",
  "vital-spirit": "רוח חיות",
  "poison-heal": "ריפוי רעל",
  "marvel-scale": "קשקש פלא",
  multiscale: "רב-קשקשים",
  insomnia: "נדודי שינה",
  "trace": "עקיבה",
  "download": "הורדה",
  "iron-fist": "אגרוף ברזל",
  "mold-breaker": "שובר תבנית",
  "rough-skin": "עור מחוספס",
  "solar-power": "כוח שמש",
  technician: "טכנאי",
  "super-luck": "מזל-על",
  prankster: "שובב",
  defiant: "מתריס",
  justified: "מוצדק",
  "sand-force": "כוח חול",
  "iron-barbs": "קוצי ברזל",
  "magic-bounce": "קפיצת קסם",
  "ice-body": "גוף קרח",
  "snow-cloak": "מעטה שלג",
  "moody": "מזג משתנה",
  overcoat: "מעיל עליון",
  regenerator: "מתחדש",
  "analytic": "אנליטי",
  "strong-jaw": "לסת חזקה",
  "refrigerate": "קירור",
  pixilate: "פייה",
  aerilate: "מעופפ",
  "dark-aura": "הילת אופל",
  "fairy-aura": "הילת פיה",
  protean: "פרוטאן",
  "fur-coat": "מעיל פרווה",
  "tough-claws": "טפרים חזקים",
  "beast-boost": "תאוצת חיה",
  "soul-heart": "לב נשמה",
  "electric-surge": "גל חשמל",
  "psychic-surge": "גל על-חושי",
  "grassy-surge": "גל עשב",
  "misty-surge": "גל ערפל",
  intimidate: "הפחדה",
  "libero": "חופשי",
};

const EVO_TRIGGER_HE = {
  "level-up": "עליית רמה",
  trade: "החלפה",
  "use-item": "שימוש בפריט",
  shed: "השלכה",
  spin: "סיבוב",
  "tower-of-darkness": "מגדל החושך",
  "tower-of-waters": "מגדל המים",
  "three-critical-hits": "שלוש מכות קריטיות",
  "take-damage": "ספיגת נזק",
  "agile-style-move": "מהלך זריז",
  "strong-style-move": "מהלך חזק",
  "recoil-damage": "נזק חוזר",
  other: "אחר",
};

/**
 * Dynamic Hebrew Pokemon name dictionary.
 * Loaded once from pocketmonsters.co.il/dictionary then cached.
 * Key = PokeAPI name (lowercase), Value = Hebrew script.
 */
let POKEMON_NAME_HE = {};
let _heNamesDictLoaded = false;

/**
 * Normalize an English Pokemon name from the dictionary site to match PokeAPI conventions.
 * e.g., "Nidoran F" → "nidoran-f", "Mr.Mime" → "mr-mime", "Farfetch'd" → "farfetchd"
 */
function normalizeNameForApi(engName) {
  return engName
    .toLowerCase()
    .trim()
    .replace(/\./g, "-")              // Mr.Mime → mr-mime
    .replace(/'/g, "")                // Farfetch'd → farfetchd
    .replace(/[']/g, "")              // curly quotes
    .replace(/\s+/g, "-")            // Nidoran F → nidoran-f
    .replace(/é/g, "e")               // Flabébé → flabebe
    .replace(/-+/g, "-")              // cleanup double dashes
    .replace(/-$/, "");               // trailing dash
}

/**
 * Load the full Hebrew Pokemon name dictionary from pocketmonsters.co.il.
 * This page has ALL Pokemon names in one table — a single request gets everything.
 * Cached for 24 hours.
 */
async function loadHebrewNameDictionary() {
  if (_heNamesDictLoaded) return;

  const cacheKey = "he_name_dictionary";
  const hit = cached(cacheKey);
  if (hit !== CACHE_MISS) {
    POKEMON_NAME_HE = hit;
    _heNamesDictLoaded = true;
    return;
  }

  try {
    const { data: html } = await axios.get("https://pocketmonsters.co.il/?p=7428", {
      timeout: 20_000,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; PokemonAPI/1.0)" },
    });
    const $ = cheerio.load(html);
    const names = {};

    // The dictionary is a big table with rows:  number | hebrew name | english name | image
    $("table tr, table tbody tr").each((_, tr) => {
      const cells = $(tr).find("td");
      if (cells.length >= 3) {
        const num = parseInt($(cells[0]).text().trim(), 10);
        const hebrewRaw = $(cells[1]).text().trim();
        const englishRaw = $(cells[2]).text().trim();

        if (num && hebrewRaw && englishRaw) {
          const apiName = normalizeNameForApi(englishRaw);
          if (apiName) {
            names[apiName] = hebrewRaw;
          }
        }
      }
    });

    if (Object.keys(names).length > 100) {
      POKEMON_NAME_HE = names;
      _heNamesDictLoaded = true;
      setCache(cacheKey, names);
      console.log(`[Hebrew Names] Loaded ${Object.keys(names).length} Pokemon names from pocketmonsters.co.il`);
    }
  } catch (err) {
    console.error("[Hebrew Names Load Error]", err.message);
  }
}

// Start loading dictionary on startup (non-blocking)
loadHebrewNameDictionary();

/** Translate a single value using a map, returning null if not found. */
function he(map, key) {
  return key ? map[key] || null : null;
}

/** Translate an array of values using a map. */
function heArray(map, arr) {
  return (arr || []).map((v) => map[v] || v);
}

// ──────────────────────────────────────────────────────────────
//  HELPERS
// ──────────────────────────────────────────────────────────────

/** Extract a name in a given language from a names array. */
function getName(names, langCode) {
  return names?.find((n) => n.language?.name === langCode)?.name || null;
}

/**
 * Get the Hebrew name for a Pokemon, using multiple fallbacks:
 * 1. PokeAPI species names (if Hebrew ever becomes available)
 * 2. Our dynamically loaded dictionary from pocketmonsters.co.il
 */
function getHebrewName(speciesNames, pokemonName) {
  return getName(speciesNames, "he") || POKEMON_NAME_HE[pokemonName] || null;
}

/**
 * Get the full Hebrew name dictionary. Ensures it's loaded.
 * Returns the map of apiName → hebrewName.
 */
async function getHebrewNameMap() {
  if (!_heNamesDictLoaded) {
    await loadHebrewNameDictionary();
  }
  return POKEMON_NAME_HE;
}

/** Extract a flavor-text entry in a given language. */
function getFlavorText(entries, langCode) {
  const entry = entries?.find((e) => e.language?.name === langCode);
  return entry?.flavor_text?.replace(/[\n\f\r]/g, " ").trim() || null;
}

/** Extract a genus (category like "Seed Pokémon") in a given language. */
function getGenus(genera, langCode) {
  return genera?.find((g) => g.language?.name === langCode)?.genus || null;
}

/** Build a clean images object from sprites. */
function buildImages(sprites) {
  return {
    front: sprites?.front_default || null,
    back: sprites?.back_default || null,
    frontShiny: sprites?.front_shiny || null,
    backShiny: sprites?.back_shiny || null,
    officialArtwork: sprites?.other?.["official-artwork"]?.front_default || null,
    officialArtworkShiny: sprites?.other?.["official-artwork"]?.front_shiny || null,
    dreamWorld: sprites?.other?.dream_world?.front_default || null,
    homeRender: sprites?.other?.home?.front_default || null,
    homeRenderShiny: sprites?.other?.home?.front_shiny || null,
  };
}

/** Convert hectograms to kg and decimetres to metres. */
function formatPhysical(pokemon) {
  return {
    heightM: pokemon.height != null ? pokemon.height / 10 : null,
    weightKg: pokemon.weight != null ? pokemon.weight / 10 : null,
  };
}

/**
 * Build a compact Pokemon object from both /pokemon and /pokemon-species data.
 */
function buildFullPokemon(pokemon, species) {
  const { heightM, weightKg } = formatPhysical(pokemon);

  const gen = species.generation?.name || null;
  const colorName = species.color?.name || null;
  const shapeName = species.shape?.name || null;
  const habitatName = species.habitat?.name || null;
  const growthName = species.growth_rate?.name || null;
  const typeNames = pokemon.types.map((t) => t.type.name);

  return {
    id: pokemon.id,
    name: pokemon.name,
    nameEnglish: getName(species.names, "en") || pokemon.name,
    nameHebrew: getHebrewName(species.names, pokemon.name),
    nameJapanese: getName(species.names, "ja"),
    genus: getFlavorText(species.genera, "en") || getGenus(species.genera, "en"),
    genusHebrew: getFlavorText(species.genera, "he") || getGenus(species.genera, "he"),
    description: getFlavorText(species.flavor_text_entries, "en"),
    descriptionHebrew: getFlavorText(species.flavor_text_entries, "he"),
    generation: gen,
    generationHebrew: he(GENERATION_HE, gen),
    types: typeNames,
    typesHebrew: heArray(TYPE_HE, typeNames),
    abilities: pokemon.abilities.map((a) => ({
      name: a.ability.name,
      nameHebrew: ABILITY_HE[a.ability.name] || null,
      isHidden: a.is_hidden,
    })),
    stats: Object.fromEntries(
      pokemon.stats.map((s) => [
        s.stat.name,
        {
          nameHebrew: STAT_HE[s.stat.name] || null,
          base: s.base_stat,
          effort: s.effort,
        },
      ])
    ),
    heightM,
    weightKg,
    baseExperience: pokemon.base_experience,
    images: buildImages(pokemon.sprites),
    color: colorName,
    colorHebrew: he(COLOR_HE, colorName),
    shape: shapeName,
    shapeHebrew: he(SHAPE_HE, shapeName),
    habitat: habitatName,
    habitatHebrew: he(HABITAT_HE, habitatName),
    growthRate: growthName,
    growthRateHebrew: he(GROWTH_RATE_HE, growthName),
    captureRate: species.capture_rate,
    baseHappiness: species.base_happiness,
    isBaby: species.is_baby,
    isLegendary: species.is_legendary,
    isMythical: species.is_mythical,
    evolutionChainUrl: species.evolution_chain?.url || null,
    moves: pokemon.moves.map((m) => m.move.name),
    heldItems: pokemon.held_items.map((h) => h.item.name),
  };
}

/**
 * Build a compact summary for list endpoints (no moves, less detail).
 */
function buildSummary(pokemon, species) {
  const { heightM, weightKg } = formatPhysical(pokemon);

  const gen = species.generation?.name || null;
  const typeNames = pokemon.types.map((t) => t.type.name);

  return {
    id: pokemon.id,
    name: pokemon.name,
    nameEnglish: getName(species.names, "en") || pokemon.name,
    nameHebrew: getHebrewName(species.names, pokemon.name),
    types: typeNames,
    typesHebrew: heArray(TYPE_HE, typeNames),
    generation: gen,
    generationHebrew: he(GENERATION_HE, gen),
    isLegendary: species.is_legendary,
    isMythical: species.is_mythical,
    heightM,
    weightKg,
    image: pokemon.sprites?.other?.["official-artwork"]?.front_default || pokemon.sprites?.front_default || null,
    sprite: pokemon.sprites?.front_default || null,
  };
}

// ──────────────────────────────────────────────────────────────
//  HEBREW DESCRIPTIONS — Scraped from pocketmonsters.co.il
//  (מפלצות כיס — The leading Israeli Pokémon fan site)
// ──────────────────────────────────────────────────────────────

const POCKETMONSTERS_BASE = "https://pocketmonsters.co.il";

/**
 * Fetch Hebrew Pokédex descriptions from pocketmonsters.co.il.
 * Two-step: tag page → full post page → parse descriptions & trivia.
 * Cached for 24 hours.
 */
async function fetchHebrewPokedex(pokemonId) {
  const paddedId = String(pokemonId).padStart(4, "0");
  const cacheKey = `he_pokedex_${paddedId}`;

  const hit = cached(cacheKey);
  if (hit !== CACHE_MISS) return hit;

  try {
    // Step 1 — Find the real post URL via the tag page
    const tagUrl = `${POCKETMONSTERS_BASE}/?tag=${paddedId}`;
    const { data: tagHtml } = await axios.get(tagUrl, {
      timeout: 12_000,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; PokemonAPI/1.0)" },
    });
    const $tag = cheerio.load(tagHtml);

    // The title of the post on the tag page is a link to the full post
    let postUrl = null;
    $tag("a").each((_, el) => {
      const href = $tag(el).attr("href") || "";
      const text = $tag(el).text();
      if (href && text.includes("פוקידע") && text.includes(paddedId)) {
        postUrl = href.startsWith("http") ? href : `${POCKETMONSTERS_BASE}${href}`;
        return false; // break
      }
    });
    if (!postUrl) return setCache(cacheKey, null);

    // Step 2 — Fetch the full post and parse Hebrew content
    const { data: postHtml } = await axios.get(postUrl, {
      timeout: 12_000,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; PokemonAPI/1.0)" },
    });
    const $ = cheerio.load(postHtml);

    const result = {
      source: "pocketmonsters.co.il",
      descriptions: [],
      species: null,
      trivia: [],
    };

    const bodyHtml = $("body").html() || "";

    // ─── Extract Pokédex Descriptions (תיאורי פוקידע) ───
    const descIdx = bodyHtml.indexOf("תיאורי פוקידע");
    if (descIdx >= 0) {
      // Get the HTML after the header, up to the next major section
      const afterDesc = bodyHtml.substring(descIdx);
      const $d = cheerio.load(`<div>${afterDesc}</div>`);
      const table = $d("table").first();
      table.find("tr").each((_, tr) => {
        const cells = $d(tr).find("td");
        if (cells.length >= 2) {
          const game = $d(cells[0]).text().trim();
          const desc = $d(cells[1]).text().trim();
          if (game && desc) {
            result.descriptions.push({ game, text: desc });
          }
        }
      });
    }

    // ─── Extract Species Kind (זן) ───
    // The table structure has "זן" in a header row (th) and
    // the value in the corresponding column of the data row (td).
    $("table").each((_, table) => {
      if (result.species) return false; // already found
      const tbl = $(table);
      const txt = tbl.text();
      if (txt.includes("זן") && !txt.includes("תיאורי")) {
        const headers = [];
        tbl.find("tr").first().find("td, th").each((i, cell) => {
          headers.push($(cell).text().trim());
        });
        const zanIdx = headers.indexOf("זן");
        if (zanIdx >= 0) {
          // Get the value from the next row at the same column index
          const dataRow = tbl.find("tr").eq(1);
          const dataCells = dataRow.find("td, th").toArray();
          if (dataCells[zanIdx]) {
            const val = $(dataCells[zanIdx]).text().trim();
            if (val) result.species = val;
          }
        }
      }
    });

    // ─── Extract Trivia (פרטי טריוויה) ───
    const triviaIdx = bodyHtml.indexOf("פרטי טריוויה");
    if (triviaIdx >= 0) {
      const afterTrivia = bodyHtml.substring(triviaIdx);
      const $t = cheerio.load(`<div>${afterTrivia}</div>`);
      $t("ul")
        .first()
        .find("li")
        .each((_, li) => {
          const text = $t(li).text().trim();
          if (text) result.trivia.push(text);
        });
    }

    const finalResult =
      result.descriptions.length > 0 || result.trivia.length > 0
        ? result
        : null;

    return setCache(cacheKey, finalResult);
  } catch (err) {
    console.error(`[Hebrew Pokedex Error] Pokemon #${pokemonId}:`, err.message);
    return null;
  }
}

// ──────────────────────────────────────────────────────────────
//  ROUTES
// ──────────────────────────────────────────────────────────────

/**
 * GET /pokemon/list
 * Paginated list of Pokemon with basic info + Hebrew names.
 *
 * Query params:
 *   limit  – results per page (default 20, max 50)
 *   offset – starting index (default 0)
 */
router.get("/list", async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 50);
  const offset = Math.max(Number(req.query.offset) || 0, 0);

  try {
    // Get the paginated list of Pokemon names/urls
    const listRes = await pokeGet(`${POKE_BASE}/pokemon?limit=${limit}&offset=${offset}`);
    const total = listRes.count;

    // Fetch each Pokemon + species in parallel
    const pokemon = await Promise.all(
      listRes.results.map(async (entry) => {
        try {
          const [poke, species] = await Promise.all([
            pokeGet(entry.url),
            pokeGet(`${POKE_BASE}/pokemon-species/${entry.name}`),
          ]);
          return buildSummary(poke, species);
        } catch {
          return { name: entry.name, error: "Failed to load" };
        }
      })
    );

    res.json({
      source: "PokeAPI (pokeapi.co)",
      total,
      limit,
      offset,
      count: pokemon.length,
      hasNext: offset + limit < total,
      pokemon,
    });
  } catch (err) {
    console.error("[Pokemon List Error]", err.message);
    res.status(502).json({ error: "Failed to fetch Pokemon list", details: err.message });
  }
});

/**
 * GET /pokemon/detail/:idOrName
 * Full details for a single Pokemon in English and Hebrew.
 */
router.get("/detail/:idOrName", async (req, res) => {
  let q = req.params.idOrName.trim();

  // If query is in Hebrew, resolve to English API name
  if (/[\u0590-\u05FF]/.test(q)) {
    const heMap = await getHebrewNameMap();
    const entry = Object.entries(heMap).find(([_, heName]) => heName === q);
    if (entry) {
      q = entry[0]; // resolved to API name
    } else {
      return res.status(404).json({
        error: `פוקימון לא נמצא: "${q}"`,
        hint: "Use /pokemon/search to find valid names.",
      });
    }
  } else {
    q = q.toLowerCase();
  }

  try {
    const [pokemon, species] = await Promise.all([
      pokeGet(`${POKE_BASE}/pokemon/${encodeURIComponent(q)}`),
      pokeGet(`${POKE_BASE}/pokemon-species/${encodeURIComponent(q)}`),
    ]);

    const fullPokemon = buildFullPokemon(pokemon, species);

    // Fetch Hebrew descriptions from pocketmonsters.co.il (non-blocking)
    let hebrewPokedex = null;
    try {
      hebrewPokedex = await fetchHebrewPokedex(pokemon.id);
    } catch { /* don't fail the response for this */ }

    if (hebrewPokedex) {
      fullPokemon.hebrewPokedex = hebrewPokedex;
      // Use the first Hebrew description as the main descriptionHebrew if we don't have one
      if (!fullPokemon.descriptionHebrew && hebrewPokedex.descriptions.length > 0) {
        fullPokemon.descriptionHebrew = hebrewPokedex.descriptions[0].text;
      }
      // Use species kind in Hebrew if available
      if (hebrewPokedex.species) {
        fullPokemon.genusHebrew = hebrewPokedex.species;
      }
    }

    res.json({
      source: "PokeAPI (pokeapi.co) + pocketmonsters.co.il",
      pokemon: fullPokemon,
    });
  } catch (err) {
    if (err.response?.status === 404) {
      return res.status(404).json({
        error: `Pokemon not found: "${q}"`,
        hint: "Use /pokemon/list or /pokemon/search to find valid names or IDs.",
      });
    }
    console.error("[Pokemon Detail Error]", err.message);
    res.status(502).json({ error: "Failed to fetch Pokemon details", details: err.message });
  }
});

/**
 * GET /pokemon/types
 * List all Pokemon types with English and Hebrew names.
 */
router.get("/types", async (req, res) => {
  try {
    const listRes = await pokeGet(`${POKE_BASE}/type`);

    const types = await Promise.all(
      listRes.results.map(async (entry) => {
        try {
          const typeData = await pokeGet(entry.url);
          const dr = typeData.damage_relations || {};
          const mapRelation = (arr) =>
            (arr || []).map((t) => ({
              name: t.name,
              nameHebrew: he(TYPE_HE, t.name),
            }));

          return {
            id: typeData.id,
            name: typeData.name,
            nameEnglish: getName(typeData.names, "en") || typeData.name,
            nameHebrew: getName(typeData.names, "he") || he(TYPE_HE, typeData.name),
            nameJapanese: getName(typeData.names, "ja"),
            pokemonCount: typeData.pokemon?.length || 0,
            damageRelations: {
              doubleDamageTo: mapRelation(dr.double_damage_to),
              doubleDamageFrom: mapRelation(dr.double_damage_from),
              halfDamageTo: mapRelation(dr.half_damage_to),
              halfDamageFrom: mapRelation(dr.half_damage_from),
              noDamageTo: mapRelation(dr.no_damage_to),
              noDamageFrom: mapRelation(dr.no_damage_from),
            },
          };
        } catch {
          return { name: entry.name, error: "Failed to load" };
        }
      })
    );

    res.json({
      source: "PokeAPI (pokeapi.co)",
      count: types.length,
      types,
    });
  } catch (err) {
    console.error("[Pokemon Types Error]", err.message);
    res.status(502).json({ error: "Failed to fetch types", details: err.message });
  }
});

/**
 * GET /pokemon/type/:type
 * Get all Pokemon of a specific type.
 *
 * Query params:
 *   limit  – max results (default 20, max 50)
 *   offset – starting index (default 0)
 */
router.get("/type/:type", async (req, res) => {
  const typeName = req.params.type.toLowerCase().trim();
  const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 50);
  const offset = Math.max(Number(req.query.offset) || 0, 0);

  try {
    const typeData = await pokeGet(`${POKE_BASE}/type/${encodeURIComponent(typeName)}`);
    const allPokemon = typeData.pokemon || [];
    const slice = allPokemon.slice(offset, offset + limit);

    const pokemon = await Promise.all(
      slice.map(async (entry) => {
        try {
          const poke = await pokeGet(entry.pokemon.url);
          const species = await pokeGet(`${POKE_BASE}/pokemon-species/${poke.name}`);
          return buildSummary(poke, species);
        } catch {
          return { name: entry.pokemon.name, error: "Failed to load" };
        }
      })
    );

    res.json({
      source: "PokeAPI (pokeapi.co)",
      type: typeName,
      typeEnglish: getName(typeData.names, "en") || typeName,
      typeHebrew: getName(typeData.names, "he") || he(TYPE_HE, typeName),
      total: allPokemon.length,
      limit,
      offset,
      count: pokemon.length,
      hasNext: offset + limit < allPokemon.length,
      pokemon,
    });
  } catch (err) {
    if (err.response?.status === 404) {
      return res.status(404).json({
        error: `Type not found: "${typeName}"`,
        hint: "Use /pokemon/types to see all valid types.",
      });
    }
    console.error("[Pokemon Type Error]", err.message);
    res.status(502).json({ error: "Failed to fetch Pokemon by type", details: err.message });
  }
});

/**
 * GET /pokemon/generation/:gen
 * Get all Pokemon from a specific generation (1-9).
 *
 * Query params:
 *   limit  – max results (default 20, max 50)
 *   offset – starting index (default 0)
 */
router.get("/generation/:gen", async (req, res) => {
  const gen = req.params.gen;
  const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 50);
  const offset = Math.max(Number(req.query.offset) || 0, 0);

  try {
    const genData = await pokeGet(`${POKE_BASE}/generation/${encodeURIComponent(gen)}`);
    const allSpecies = genData.pokemon_species || [];

    // Sort by Pokemon ID
    const sorted = allSpecies
      .map((s) => ({ name: s.name, id: Number(s.url.split("/").filter(Boolean).pop()) }))
      .sort((a, b) => a.id - b.id);

    const slice = sorted.slice(offset, offset + limit);

    const pokemon = await Promise.all(
      slice.map(async (entry) => {
        try {
          const [poke, species] = await Promise.all([
            pokeGet(`${POKE_BASE}/pokemon/${entry.id}`),
            pokeGet(`${POKE_BASE}/pokemon-species/${entry.id}`),
          ]);
          return buildSummary(poke, species);
        } catch {
          return { name: entry.name, id: entry.id, error: "Failed to load" };
        }
      })
    );

    res.json({
      source: "PokeAPI (pokeapi.co)",
      generation: genData.name,
      generationHebrew: he(GENERATION_HE, genData.name),
      region: genData.main_region?.name || null,
      regionHebrew: he(REGION_HE, genData.main_region?.name),
      total: allSpecies.length,
      limit,
      offset,
      count: pokemon.length,
      hasNext: offset + limit < allSpecies.length,
      pokemon,
    });
  } catch (err) {
    if (err.response?.status === 404) {
      return res.status(404).json({
        error: `Generation not found: "${gen}"`,
        hint: "Use a number 1-9 or a name like 'generation-i'.",
      });
    }
    console.error("[Pokemon Generation Error]", err.message);
    res.status(502).json({ error: "Failed to fetch generation", details: err.message });
  }
});

/**
 * GET /pokemon/evolution/:idOrName
 * Get the full evolution chain for a Pokemon.
 */
router.get("/evolution/:idOrName", async (req, res) => {
  const q = req.params.idOrName.toLowerCase().trim();

  try {
    const species = await pokeGet(`${POKE_BASE}/pokemon-species/${encodeURIComponent(q)}`);
    const chainUrl = species.evolution_chain?.url;
    if (!chainUrl) {
      return res.json({ source: "PokeAPI (pokeapi.co)", chain: [] });
    }

    const chainData = await pokeGet(chainUrl);

    // Recursively walk the chain, fetching Hebrew names for each species
    async function walkChain(link) {
      if (!link) return null;

      const speciesName = link.species?.name || null;
      const id = link.species?.url
        ? Number(link.species.url.split("/").filter(Boolean).pop())
        : null;

      // Get Hebrew name from our map (instant), with PokeAPI fallback
      let nameHebrew = POKEMON_NAME_HE[speciesName] || null;
      if (!nameHebrew && link.species?.url) {
        try {
          const sp = await pokeGet(link.species.url);
          nameHebrew = getName(sp.names, "he");
        } catch { /* skip */ }
      }

      const trigger = link.evolution_details?.[0]?.trigger?.name || null;

      const children = await Promise.all(
        (link.evolves_to || []).map(walkChain)
      );

      return {
        name: speciesName,
        nameHebrew,
        id,
        image: id
          ? `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/other/official-artwork/${id}.png`
          : null,
        trigger,
        triggerHebrew: he(EVO_TRIGGER_HE, trigger),
        minLevel: link.evolution_details?.[0]?.min_level || null,
        item: link.evolution_details?.[0]?.item?.name || null,
        evolvesTo: children,
      };
    }

    const chain = await walkChain(chainData.chain);

    res.json({
      source: "PokeAPI (pokeapi.co)",
      pokemon: q,
      chain,
    });
  } catch (err) {
    if (err.response?.status === 404) {
      return res.status(404).json({
        error: `Pokemon not found: "${q}"`,
        hint: "Use /pokemon/list or /pokemon/search to find valid names or IDs.",
      });
    }
    console.error("[Pokemon Evolution Error]", err.message);
    res.status(502).json({ error: "Failed to fetch evolution chain", details: err.message });
  }
});

/**
 * GET /pokemon/search
 * Search Pokemon by name (English or Hebrew partial match).
 * Supports searching in Hebrew characters across ALL generations.
 *
 * Query params:
 *   q      – search term (required)
 *   limit  – max results (default 20, max 50)
 */
router.get("/search", async (req, res) => {
  const { q, limit: rawLimit } = req.query;
  const limit = Math.min(Math.max(Number(rawLimit) || 20, 1), 50);

  if (!q) {
    return res.status(400).json({
      error: "Missing required query param: q",
      example: "/pokemon/search?q=pika or /pokemon/search?q=פיקאצ'ו",
    });
  }

  const queryRaw = q.trim();
  const queryLower = queryRaw.toLowerCase();
  // Detect Hebrew query (contains Hebrew characters)
  const isHebrew = /[\u0590-\u05FF]/.test(queryRaw);

  try {
    // Ensure Hebrew dictionary is loaded
    const heMap = await getHebrewNameMap();

    // Fetch a large batch of species to search through (up to 1025 Pokemon)
    const allSpecies = await pokeGet(`${POKE_BASE}/pokemon-species?limit=1025`);

    let matched;
    if (isHebrew) {
      // Hebrew search — search through our Hebrew name dictionary
      matched = allSpecies.results.filter((s) => {
        const heName = heMap[s.name];
        return heName && heName.includes(queryRaw);
      });
    } else {
      // English search — first by English name, then also check Hebrew
      const nameMatches = allSpecies.results.filter((s) => s.name.includes(queryLower));
      const hebrewMatches = allSpecies.results.filter((s) => {
        if (s.name.includes(queryLower)) return false; // already matched
        const heName = heMap[s.name];
        return heName && heName.includes(queryRaw);
      });
      matched = [...nameMatches, ...hebrewMatches];
    }

    const combined = matched.slice(0, limit);

    const pokemon = await Promise.all(
      combined.map(async (entry) => {
        try {
          const id = Number(entry.url.split("/").filter(Boolean).pop());
          const [poke, species] = await Promise.all([
            pokeGet(`${POKE_BASE}/pokemon/${id}`),
            pokeGet(entry.url),
          ]);
          return buildSummary(poke, species);
        } catch {
          return { name: entry.name, error: "Failed to load" };
        }
      })
    );

    res.json({
      source: "PokeAPI (pokeapi.co) + pocketmonsters.co.il",
      query: q,
      searchLanguage: isHebrew ? "hebrew" : "english",
      count: pokemon.length,
      pokemon,
    });
  } catch (err) {
    console.error("[Pokemon Search Error]", err.message);
    res.status(502).json({ error: "Failed to search Pokemon", details: err.message });
  }
});

export default router;
