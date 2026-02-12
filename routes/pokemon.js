import { Router } from "express";
import axios from "axios";

const router = Router();

// ──────────────────────────────────────────────────────────────
//  POKÉAPI — pokeapi.co (free, no key required)
// ──────────────────────────────────────────────────────────────
const POKE_BASE = "https://pokeapi.co/api/v2";

// Simple in-memory cache — Pokemon data never changes
const cache = new Map();
const CACHE_TTL = 1000 * 60 * 60 * 24; // 24 hours

function cached(key) {
  const entry = cache.get(key);
  if (entry && Date.now() - entry.ts < CACHE_TTL) return entry.data;
  return null;
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
  if (hit) return hit;
  const { data } = await axios.get(url, { timeout: 15_000 });
  return setCache(url, data);
}

// ──────────────────────────────────────────────────────────────
//  HELPERS
// ──────────────────────────────────────────────────────────────

/** Extract a name in a given language from a names array. */
function getName(names, langCode) {
  return names?.find((n) => n.language?.name === langCode)?.name || null;
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

  return {
    id: pokemon.id,
    name: pokemon.name,
    nameEnglish: getName(species.names, "en") || pokemon.name,
    nameHebrew: getName(species.names, "he"),
    nameJapanese: getName(species.names, "ja"),
    genus: getFlavorText(species.genera, "en") || getGenus(species.genera, "en"),
    genusHebrew: getFlavorText(species.genera, "he") || getGenus(species.genera, "he"),
    description: getFlavorText(species.flavor_text_entries, "en"),
    descriptionHebrew: getFlavorText(species.flavor_text_entries, "he"),
    generation: species.generation?.name || null,
    types: pokemon.types.map((t) => t.type.name),
    abilities: pokemon.abilities.map((a) => ({
      name: a.ability.name,
      isHidden: a.is_hidden,
    })),
    stats: Object.fromEntries(
      pokemon.stats.map((s) => [s.stat.name, { base: s.base_stat, effort: s.effort }])
    ),
    heightM,
    weightKg,
    baseExperience: pokemon.base_experience,
    images: buildImages(pokemon.sprites),
    color: species.color?.name || null,
    shape: species.shape?.name || null,
    habitat: species.habitat?.name || null,
    growthRate: species.growth_rate?.name || null,
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

  return {
    id: pokemon.id,
    name: pokemon.name,
    nameEnglish: getName(species.names, "en") || pokemon.name,
    nameHebrew: getName(species.names, "he"),
    types: pokemon.types.map((t) => t.type.name),
    generation: species.generation?.name || null,
    isLegendary: species.is_legendary,
    isMythical: species.is_mythical,
    heightM,
    weightKg,
    image: pokemon.sprites?.other?.["official-artwork"]?.front_default || pokemon.sprites?.front_default || null,
    sprite: pokemon.sprites?.front_default || null,
  };
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
  const q = req.params.idOrName.toLowerCase().trim();

  try {
    const [pokemon, species] = await Promise.all([
      pokeGet(`${POKE_BASE}/pokemon/${encodeURIComponent(q)}`),
      pokeGet(`${POKE_BASE}/pokemon-species/${encodeURIComponent(q)}`),
    ]);

    res.json({
      source: "PokeAPI (pokeapi.co)",
      pokemon: buildFullPokemon(pokemon, species),
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
          return {
            id: typeData.id,
            name: typeData.name,
            nameEnglish: getName(typeData.names, "en") || typeData.name,
            nameHebrew: getName(typeData.names, "he"),
            nameJapanese: getName(typeData.names, "ja"),
            pokemonCount: typeData.pokemon?.length || 0,
            damageRelations: {
              doubleDamageTo: typeData.damage_relations?.double_damage_to?.map((t) => t.name) || [],
              doubleDamageFrom: typeData.damage_relations?.double_damage_from?.map((t) => t.name) || [],
              halfDamageTo: typeData.damage_relations?.half_damage_to?.map((t) => t.name) || [],
              halfDamageFrom: typeData.damage_relations?.half_damage_from?.map((t) => t.name) || [],
              noDamageTo: typeData.damage_relations?.no_damage_to?.map((t) => t.name) || [],
              noDamageFrom: typeData.damage_relations?.no_damage_from?.map((t) => t.name) || [],
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
      typeHebrew: getName(typeData.names, "he"),
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
      region: genData.main_region?.name || null,
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

    // Recursively walk the chain
    function walkChain(link) {
      if (!link) return null;

      const speciesName = link.species?.name || null;
      const id = link.species?.url
        ? Number(link.species.url.split("/").filter(Boolean).pop())
        : null;

      return {
        name: speciesName,
        id,
        image: id
          ? `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/other/official-artwork/${id}.png`
          : null,
        trigger: link.evolution_details?.[0]?.trigger?.name || null,
        minLevel: link.evolution_details?.[0]?.min_level || null,
        item: link.evolution_details?.[0]?.item?.name || null,
        evolvesTo: (link.evolves_to || []).map(walkChain),
      };
    }

    const chain = walkChain(chainData.chain);

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
      example: "/pokemon/search?q=pika",
    });
  }

  const query = q.toLowerCase().trim();

  try {
    // Fetch a large batch of species to search through (up to 1025 Pokemon)
    const allSpecies = await pokeGet(`${POKE_BASE}/pokemon-species?limit=1025`);

    // First: filter by English name substring
    const nameMatches = allSpecies.results.filter((s) => s.name.includes(query));

    // If not enough matches from English names, try Hebrew names
    let hebrewMatches = [];
    if (nameMatches.length < limit) {
      // Check remaining species for Hebrew name matches
      const remaining = allSpecies.results.filter((s) => !s.name.includes(query));
      const sampled = remaining.slice(0, 200); // check a reasonable batch

      const checked = await Promise.all(
        sampled.map(async (s) => {
          try {
            const species = await pokeGet(s.url);
            const heName = getName(species.names, "he");
            if (heName && heName.includes(q.trim())) {
              return s;
            }
          } catch { /* skip */ }
          return null;
        })
      );
      hebrewMatches = checked.filter(Boolean);
    }

    const combined = [...nameMatches, ...hebrewMatches].slice(0, limit);

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
      source: "PokeAPI (pokeapi.co)",
      query: q,
      count: pokemon.length,
      pokemon,
    });
  } catch (err) {
    console.error("[Pokemon Search Error]", err.message);
    res.status(502).json({ error: "Failed to search Pokemon", details: err.message });
  }
});

export default router;
