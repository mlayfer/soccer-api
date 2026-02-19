import { Router } from "express";
import axios from "axios";
import * as cheerio from "cheerio";

const router = Router();

// ──────────────────────────────────────────────────────────────
//  FREE sources — no API keys required
//  • TVMaze  (api.tvmaze.com)  → TV show data, schedules, cast
//  • IMDb    (imdb.com)         → Movie search, charts, details
// ──────────────────────────────────────────────────────────────

const TVMAZE = "https://api.tvmaze.com";
const IMDB_SUGGEST = "https://v3.sg.media-imdb.com/suggestion";
const IMDB_BASE = "https://www.imdb.com";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

// ──── Cache ──────────────────────────────────────────────────
const cache = new Map();
const CACHE_SHORT = 1000 * 60 * 15; // 15 min
const CACHE_LONG = 1000 * 60 * 60 * 4; // 4 hours
const CACHE_MISS = Symbol("MISS");

function cached(key) {
  const e = cache.get(key);
  if (e && Date.now() - e.ts < e.ttl) return e.data;
  return CACHE_MISS;
}
function setCache(key, data, ttl = CACHE_SHORT) {
  cache.set(key, { data, ts: Date.now(), ttl });
  return data;
}

// ──── Fetch helpers ──────────────────────────────────────────

async function tvmGet(path) {
  const key = `tvm:${path}`;
  const hit = cached(key);
  if (hit !== CACHE_MISS) return hit;
  const { data } = await axios.get(`${TVMAZE}${path}`, { timeout: 10_000 });
  return setCache(key, data);
}

async function imdbSuggest(query) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const first = encodeURIComponent(q.charAt(0));
  const key = `imdb:s:${q}`;
  const hit = cached(key);
  if (hit !== CACHE_MISS) return hit;
  const url = `${IMDB_SUGGEST}/${first}/${encodeURIComponent(q)}.json`;
  const { data } = await axios.get(url, {
    timeout: 8_000,
    headers: { "User-Agent": UA },
  });
  return setCache(key, data.d || []);
}

async function fetchPage(url, ttl = CACHE_LONG) {
  const key = `page:${url}`;
  const hit = cached(key);
  if (hit !== CACHE_MISS) return hit;
  const { data } = await axios.get(url, {
    timeout: 15_000,
    headers: {
      "User-Agent": UA,
      Accept: "text/html,application/xhtml+xml",
      "Accept-Language": "en-US,en;q=0.9",
    },
  });
  return setCache(key, data, ttl);
}

// ──── Utility helpers ────────────────────────────────────────

function stripHtml(html) {
  if (!html) return "";
  return html.replace(/<[^>]*>/g, "").trim();
}

function parseIsoDuration(iso) {
  if (!iso) return null;
  const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?/);
  if (!m) return null;
  return parseInt(m[1] || 0, 10) * 60 + parseInt(m[2] || 0, 10);
}

function paginate(arr, page, limit) {
  const p = Math.max(1, Number(page) || 1);
  const l = Math.min(50, Math.max(1, Number(limit) || 20));
  const start = (p - 1) * l;
  return {
    page: p,
    totalPages: Math.ceil(arr.length / l),
    totalResults: arr.length,
    results: arr.slice(start, start + l),
  };
}

// ──── Format helpers ─────────────────────────────────────────

function fmtTVShow(item) {
  const s = item.show || item;
  return {
    id: s.id,
    type: "tv",
    name: s.name,
    overview: stripHtml(s.summary),
    year: s.premiered ? s.premiered.slice(0, 4) : null,
    endYear: s.ended ? s.ended.slice(0, 4) : null,
    status: s.status,
    rating: s.rating?.average,
    poster: s.image?.original || s.image?.medium || null,
    genres: s.genres || [],
    runtime: s.averageRuntime || s.runtime,
    network: s.network?.name || null,
    webChannel: s.webChannel?.name || null,
    streamingOn: s.webChannel?.name || null,
    officialSite: s.officialSite,
  };
}

function fmtImdbItem(i) {
  const isTV = ["tvSeries", "tvMiniSeries"].includes(i.qid);
  return {
    id: i.id,
    type: isTV ? "tv" : "movie",
    title: isTV ? undefined : i.l,
    name: isTV ? i.l : undefined,
    year: i.y || null,
    yearRange: i.yr || null,
    poster: i.i?.imageUrl || null,
    stars: i.s || null,
    rating: null,
    rank: i.rank || null,
    mediaType: i.qid || i.q || null,
  };
}

function fmtChartItem(node) {
  const isTV =
    node.titleType?.id === "tvSeries" || node.titleType?.id === "tvMiniSeries";
  return {
    id: node.id,
    type: isTV ? "tv" : "movie",
    title: isTV ? undefined : node.titleText?.text,
    name: isTV ? node.titleText?.text : undefined,
    year: node.releaseYear?.year || null,
    rating: node.ratingsSummary?.aggregateRating || null,
    voteCount: node.ratingsSummary?.voteCount || null,
    poster: node.primaryImage?.url || null,
    runtime: node.runtime ? Math.round(node.runtime.seconds / 60) : null,
  };
}

function fmtEpisode(ep) {
  return {
    id: ep.id,
    name: ep.name,
    seasonNumber: ep.season,
    episodeNumber: ep.number,
    airDate: ep.airdate,
    airTime: ep.airtime,
    runtime: ep.runtime,
    rating: ep.rating?.average,
    overview: stripHtml(ep.summary),
    image: ep.image?.original || ep.image?.medium || null,
  };
}

function fmtSeason(s) {
  return {
    id: s.id,
    seasonNumber: s.number,
    name: s.name || `Season ${s.number}`,
    episodeCount: s.episodeOrder,
    premiereDate: s.premiereDate,
    endDate: s.endDate,
    poster: s.image?.original || s.image?.medium || null,
    overview: stripHtml(s.summary),
  };
}

function fmtCast(c) {
  return {
    id: c.person?.id,
    name: c.person?.name,
    character: c.character?.name || null,
    profileImage: c.person?.image?.medium || null,
  };
}

// ──── IMDb scraping ──────────────────────────────────────────

async function scrapeChart(chartUrl) {
  try {
    const html = await fetchPage(chartUrl);
    const $ = cheerio.load(html);
    const raw = $("script#__NEXT_DATA__").text();
    if (!raw) return [];
    const json = JSON.parse(raw);
    const edges =
      json.props?.pageProps?.pageData?.chartTitles?.edges || [];
    return edges.map((e) => fmtChartItem(e.node));
  } catch (err) {
    console.error("Chart scrape error:", chartUrl, err.message);
    return [];
  }
}

async function scrapeDetail(imdbId) {
  const html = await fetchPage(`${IMDB_BASE}/title/${imdbId}/`);
  const $ = cheerio.load(html);

  // JSON-LD (stable, Schema.org standard)
  let ld = {};
  try {
    const t = $('script[type="application/ld+json"]').first().text();
    if (t) ld = JSON.parse(t);
  } catch {}

  // __NEXT_DATA__ for extras
  let above = {};
  try {
    const t = $("script#__NEXT_DATA__").text();
    if (t) {
      const nd = JSON.parse(t);
      above = nd.props?.pageProps?.aboveTheFoldData || {};
    }
  } catch {}

  const isTV =
    ld["@type"] === "TVSeries" || ld["@type"] === "TVMiniSeries";
  const arr = (v) => (Array.isArray(v) ? v : v ? [v] : []);

  const directors = arr(ld.director)
    .filter((d) => d?.name)
    .map((d) => d.name);
  const cast = arr(ld.actor)
    .filter((a) => a?.name)
    .map((a) => a.name);
  const creators = arr(ld.creator)
    .filter((c) => c?.name)
    .map((c) => c.name);

  let trailer = null;
  if (ld.trailer?.embedUrl) {
    trailer = {
      url: ld.trailer.embedUrl,
      thumbnail: ld.trailer.thumbnailUrl || null,
      name: ld.trailer.name || null,
    };
  }

  const genres = arr(ld.genre);

  return {
    id: imdbId,
    type: isTV ? "tv" : "movie",
    title: isTV ? undefined : ld.name || above.titleText?.text || null,
    name: isTV ? ld.name || above.titleText?.text || null : undefined,
    tagline: above.tagline?.text || null,
    overview:
      above.plot?.plotText?.plainText || ld.description || null,
    releaseDate: ld.datePublished || null,
    year:
      ld.datePublished?.slice(0, 4) ||
      above.releaseYear?.year?.toString() ||
      null,
    rating: ld.aggregateRating?.ratingValue || null,
    voteCount: ld.aggregateRating?.ratingCount || null,
    contentRating:
      ld.contentRating || above.certificate?.rating || null,
    runtime: parseIsoDuration(ld.duration),
    genres,
    poster: ld.image || above.primaryImage?.url || null,
    directors,
    cast,
    creators,
    trailer,
    keywords: ld.keywords
      ? ld.keywords.split(",").map((k) => k.trim())
      : [],
    imdbUrl: `${IMDB_BASE}/title/${imdbId}/`,
    source: "imdb",
  };
}

// ═══════════════════════════════════════════════════════════════
//  ROUTES
// ═══════════════════════════════════════════════════════════════

// ──── Index ──────────────────────────────────────────────────

router.get("/", (req, res) => {
  res.json({
    name: "TV & Movies API",
    sources: [
      "TVMaze — TV shows, schedules, cast, streaming platform info",
      "IMDb — Movie search, charts, details (scraped)",
    ],
    apiKeyRequired: false,
    endpoints: {
      search: {
        "GET /search?q=...": "Search movies & TV shows",
        params: "q (required), type (multi|movie|tv|person)",
      },
      trending:
        "GET /trending — shows airing today + new on streaming",
      movies: {
        "GET /movies/popular": "IMDb most popular movies",
        "GET /movies/top-rated": "IMDb top 250 movies",
        "GET /movies/:imdbId": "Movie details (e.g. /movies/tt1375666)",
        params: "page, limit (for list endpoints)",
      },
      tv: {
        "GET /tv/popular": "IMDb most popular TV shows",
        "GET /tv/top-rated": "IMDb top 250 TV shows",
        "GET /tv/airing-today": "TV schedule (TVMaze)",
        "GET /tv/on-the-air": "Streaming schedule (TVMaze)",
        "GET /tv/:id": "TV show details (TVMaze or IMDb ID)",
        "GET /tv/:id/season/:num": "Season episodes",
        params: "page, limit, country (for schedule)",
      },
      people: {
        "GET /person/:id": "Person details + credits (TVMaze)",
        "GET /search?q=...&type=person": "Search people",
      },
      genres: "GET /genres — genre list",
    },
  });
});

// ──── Search ─────────────────────────────────────────────────

router.get("/search", async (req, res) => {
  try {
    const { q, query, type = "multi" } = req.query;
    const searchQ = q || query;
    if (!searchQ) {
      return res.status(400).json({
        error: "Missing search query",
        usage: "/search?q=breaking+bad",
      });
    }

    if (type === "tv") {
      const raw = await tvmGet(
        `/search/shows?q=${encodeURIComponent(searchQ)}`
      );
      return res.json({
        query: searchQ,
        type: "tv",
        page: 1,
        totalPages: 1,
        totalResults: raw.length,
        results: raw.map(fmtTVShow),
        source: "tvmaze",
      });
    }

    if (type === "person") {
      const raw = await tvmGet(
        `/search/people?q=${encodeURIComponent(searchQ)}`
      );
      return res.json({
        query: searchQ,
        type: "person",
        page: 1,
        totalPages: 1,
        totalResults: raw.length,
        results: raw.map((r) => ({
          id: r.person.id,
          type: "person",
          name: r.person.name,
          profileImage: r.person.image?.medium || null,
          country: r.person.country?.name || null,
        })),
        source: "tvmaze",
      });
    }

    if (type === "movie") {
      const items = await imdbSuggest(searchQ);
      const movies = items.filter((i) =>
        ["movie", "tvMovie", "short", "video", "feature"].includes(
          i.qid || i.q
        )
      );
      return res.json({
        query: searchQ,
        type: "movie",
        page: 1,
        totalPages: 1,
        totalResults: movies.length,
        results: movies.map(fmtImdbItem),
        source: "imdb",
      });
    }

    // Multi-search: combine TV (TVMaze) + Movies (IMDb)
    const [tvRaw, imdbItems] = await Promise.all([
      tvmGet(`/search/shows?q=${encodeURIComponent(searchQ)}`).catch(
        () => []
      ),
      imdbSuggest(searchQ).catch(() => []),
    ]);

    const tvResults = tvRaw.map(fmtTVShow);
    const movieResults = imdbItems
      .filter((i) => !["tvSeries", "tvMiniSeries"].includes(i.qid))
      .map(fmtImdbItem);

    // Interleave results
    const results = [];
    const max = Math.max(tvResults.length, movieResults.length);
    for (let i = 0; i < max; i++) {
      if (i < movieResults.length) results.push(movieResults[i]);
      if (i < tvResults.length) results.push(tvResults[i]);
    }

    res.json({
      query: searchQ,
      type: "multi",
      page: 1,
      totalPages: 1,
      totalResults: results.length,
      results,
      source: "tvmaze+imdb",
    });
  } catch (err) {
    console.error("Search error:", err.message);
    res.status(502).json({ error: "Search failed", details: err.message });
  }
});

// ──── Trending ───────────────────────────────────────────────

router.get("/trending", async (req, res) => {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const { country = "US" } = req.query;

    const [schedule, webSchedule] = await Promise.all([
      tvmGet(`/schedule?country=${country}&date=${today}`).catch(() => []),
      tvmGet(`/schedule/web?date=${today}`).catch(() => []),
    ]);

    const seen = new Set();
    const shows = [];
    for (const entry of [...schedule, ...webSchedule]) {
      const show = entry._embedded?.show || entry.show;
      if (!show || seen.has(show.id)) continue;
      seen.add(show.id);
      shows.push(fmtTVShow({ show }));
    }
    shows.sort((a, b) => (b.rating || 0) - (a.rating || 0));

    res.json({
      date: today,
      page: 1,
      totalPages: 1,
      totalResults: shows.length,
      results: shows.slice(0, 50),
      source: "tvmaze",
    });
  } catch (err) {
    console.error("Trending error:", err.message);
    res.status(502).json({
      error: "Failed to fetch trending",
      details: err.message,
    });
  }
});

// ──── Movies — Popular & Top Rated (IMDb charts) ─────────────

router.get("/movies/popular", async (req, res) => {
  try {
    const all = await scrapeChart(`${IMDB_BASE}/chart/moviemeter/`);
    const { page, totalPages, totalResults, results } = paginate(
      all,
      req.query.page,
      req.query.limit
    );
    res.json({ page, totalPages, totalResults, results, source: "imdb" });
  } catch (err) {
    console.error("Popular movies error:", err.message);
    res.status(502).json({
      error: "Failed to fetch popular movies",
      details: err.message,
    });
  }
});

router.get("/movies/top-rated", async (req, res) => {
  try {
    const all = await scrapeChart(`${IMDB_BASE}/chart/top/`);
    const { page, totalPages, totalResults, results } = paginate(
      all,
      req.query.page,
      req.query.limit
    );
    res.json({ page, totalPages, totalResults, results, source: "imdb" });
  } catch (err) {
    console.error("Top rated movies error:", err.message);
    res.status(502).json({
      error: "Failed to fetch top rated movies",
      details: err.message,
    });
  }
});

// ──── Movie Detail ───────────────────────────────────────────

router.get("/movies/:id", async (req, res) => {
  try {
    const { id } = req.params;
    if (!id.startsWith("tt")) {
      return res.status(400).json({
        error: "Expected an IMDb ID (e.g., tt1375666)",
        hint: "Search first at /search?q=movie+name to find the IMDb ID",
      });
    }
    const detail = await scrapeDetail(id);
    res.json(detail);
  } catch (err) {
    console.error("Movie detail error:", err.message);
    res.status(502).json({
      error: "Failed to fetch movie details",
      details: err.message,
    });
  }
});

// ──── TV — Popular & Top Rated (IMDb charts) ─────────────────

router.get("/tv/popular", async (req, res) => {
  try {
    const all = await scrapeChart(`${IMDB_BASE}/chart/tvmeter/`);
    const { page, totalPages, totalResults, results } = paginate(
      all,
      req.query.page,
      req.query.limit
    );
    res.json({ page, totalPages, totalResults, results, source: "imdb" });
  } catch (err) {
    console.error("Popular TV error:", err.message);
    res.status(502).json({
      error: "Failed to fetch popular TV",
      details: err.message,
    });
  }
});

router.get("/tv/top-rated", async (req, res) => {
  try {
    const all = await scrapeChart(`${IMDB_BASE}/chart/toptv/`);
    const { page, totalPages, totalResults, results } = paginate(
      all,
      req.query.page,
      req.query.limit
    );
    res.json({ page, totalPages, totalResults, results, source: "imdb" });
  } catch (err) {
    console.error("Top rated TV error:", err.message);
    res.status(502).json({
      error: "Failed to fetch top rated TV",
      details: err.message,
    });
  }
});

// ──── TV — Airing Today (TVMaze schedule) ────────────────────

router.get("/tv/airing-today", async (req, res) => {
  try {
    const { country = "US" } = req.query;
    const today = new Date().toISOString().slice(0, 10);
    const schedule = await tvmGet(
      `/schedule?country=${country}&date=${today}`
    );
    const seen = new Set();
    const shows = [];
    for (const entry of schedule) {
      if (!entry.show || seen.has(entry.show.id)) continue;
      seen.add(entry.show.id);
      shows.push(fmtTVShow({ show: entry.show }));
    }
    res.json({
      date: today,
      page: 1,
      totalPages: 1,
      totalResults: shows.length,
      results: shows,
      source: "tvmaze",
    });
  } catch (err) {
    console.error("Airing today error:", err.message);
    res.status(502).json({
      error: "Failed to fetch airing today",
      details: err.message,
    });
  }
});

// ──── TV — On The Air / Streaming Schedule ───────────────────

router.get("/tv/on-the-air", async (req, res) => {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const schedule = await tvmGet(`/schedule/web?date=${today}`);
    const seen = new Set();
    const shows = [];
    for (const entry of schedule) {
      const show = entry._embedded?.show;
      if (!show || seen.has(show.id)) continue;
      seen.add(show.id);
      shows.push(fmtTVShow({ show }));
    }
    res.json({
      date: today,
      page: 1,
      totalPages: 1,
      totalResults: shows.length,
      results: shows.slice(0, 60),
      source: "tvmaze",
    });
  } catch (err) {
    console.error("On the air error:", err.message);
    res.status(502).json({
      error: "Failed to fetch streaming schedule",
      details: err.message,
    });
  }
});

// ──── TV Show Detail ─────────────────────────────────────────

router.get("/tv/:id", async (req, res) => {
  try {
    let { id } = req.params;

    // Accept both TVMaze numeric IDs and IMDb IDs
    if (id.startsWith("tt")) {
      const lookup = await tvmGet(`/lookup/shows?imdb=${id}`);
      id = lookup.id;
    }

    const [show, seasons, castList, crew] = await Promise.all([
      tvmGet(`/shows/${id}`),
      tvmGet(`/shows/${id}/seasons`),
      tvmGet(`/shows/${id}/cast`),
      tvmGet(`/shows/${id}/crew`).catch(() => []),
    ]);

    const s = show;

    res.json({
      id: s.id,
      type: "tv",
      name: s.name,
      overview: stripHtml(s.summary),
      premiered: s.premiered,
      ended: s.ended,
      year: s.premiered ? s.premiered.slice(0, 4) : null,
      status: s.status,
      showType: s.type,
      rating: s.rating?.average,
      runtime: s.averageRuntime || s.runtime,
      genres: s.genres || [],
      language: s.language,
      poster: s.image?.original || s.image?.medium || null,
      network: s.network
        ? { name: s.network.name, country: s.network.country?.name }
        : null,
      webChannel: s.webChannel
        ? { name: s.webChannel.name, country: s.webChannel.country?.name }
        : null,
      streamingOn: s.webChannel?.name || null,
      officialSite: s.officialSite,
      schedule: s.schedule,
      imdbId: s.externals?.imdb || null,
      tvdbId: s.externals?.thetvdb || null,
      seasons: seasons
        .filter((ss) => ss.number !== null && ss.number !== 0)
        .map(fmtSeason),
      cast: castList.slice(0, 25).map(fmtCast),
      crew: crew
        .filter((c) =>
          [
            "Creator",
            "Executive Producer",
            "Director",
            "Writer",
            "Showrunner",
          ].includes(c.type)
        )
        .slice(0, 15)
        .map((c) => ({
          id: c.person?.id,
          name: c.person?.name,
          role: c.type,
          profileImage: c.person?.image?.medium || null,
        })),
      tvmazeUrl: s.url,
      imdbUrl: s.externals?.imdb
        ? `${IMDB_BASE}/title/${s.externals.imdb}/`
        : null,
      source: "tvmaze",
    });
  } catch (err) {
    console.error("TV detail error:", err.message);
    if (err.response?.status === 404) {
      return res.status(404).json({ error: "TV show not found" });
    }
    res.status(502).json({
      error: "Failed to fetch TV show details",
      details: err.message,
    });
  }
});

// ──── Season Episodes ────────────────────────────────────────

router.get("/tv/:id/season/:seasonNumber", async (req, res) => {
  try {
    let { id, seasonNumber } = req.params;

    if (id.startsWith("tt")) {
      const lookup = await tvmGet(`/lookup/shows?imdb=${id}`);
      id = lookup.id;
    }

    const seasons = await tvmGet(`/shows/${id}/seasons`);
    const season = seasons.find(
      (s) => s.number === Number(seasonNumber)
    );
    if (!season) {
      return res.status(404).json({ error: "Season not found" });
    }

    const episodes = await tvmGet(`/seasons/${season.id}/episodes`);

    res.json({
      tvShowId: Number(id),
      seasonId: season.id,
      seasonNumber: season.number,
      name: season.name || `Season ${season.number}`,
      premiereDate: season.premiereDate,
      endDate: season.endDate,
      episodes: episodes.map(fmtEpisode),
      source: "tvmaze",
    });
  } catch (err) {
    console.error("Season error:", err.message);
    res.status(502).json({
      error: "Failed to fetch season",
      details: err.message,
    });
  }
});

// ──── Person Detail ──────────────────────────────────────────

router.get("/person/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const [person, castCredits] = await Promise.all([
      tvmGet(`/people/${id}`),
      tvmGet(`/people/${id}/castcredits?embed=show`).catch(() => []),
    ]);

    const p = person;

    res.json({
      id: p.id,
      name: p.name,
      birthday: p.birthday,
      deathday: p.deathday,
      gender: p.gender,
      country: p.country?.name || null,
      profileImage: p.image?.original || p.image?.medium || null,
      tvmazeUrl: p.url,
      knownFor: castCredits
        .map((c) => c._embedded?.show)
        .filter(Boolean)
        .slice(0, 20)
        .map((s) => fmtTVShow({ show: s })),
      source: "tvmaze",
    });
  } catch (err) {
    console.error("Person error:", err.message);
    if (err.response?.status === 404) {
      return res.status(404).json({ error: "Person not found" });
    }
    res.status(502).json({
      error: "Failed to fetch person details",
      details: err.message,
    });
  }
});

// ──── Genres ─────────────────────────────────────────────────

router.get("/genres", (req, res) => {
  res.json({
    genres: [
      "Action",
      "Adventure",
      "Animation",
      "Biography",
      "Comedy",
      "Crime",
      "Documentary",
      "Drama",
      "Family",
      "Fantasy",
      "History",
      "Horror",
      "Music",
      "Musical",
      "Mystery",
      "Romance",
      "Sci-Fi",
      "Science-Fiction",
      "Sport",
      "Supernatural",
      "Thriller",
      "War",
      "Western",
    ],
    source: "static",
  });
});

export default router;
