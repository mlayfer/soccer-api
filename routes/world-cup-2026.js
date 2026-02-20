import { Router } from "express";
import axios from "axios";
import * as cheerio from "cheerio";

const router = Router();

const ESPN_BASE = "https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world";
const ESPN_HEADSHOT = "https://a.espncdn.com/i/headshots/soccer/players/full";
const WIKI_SUMMARY = "https://en.wikipedia.org/api/rest_v1/page/summary";
const WIKIDATA_API = "https://www.wikidata.org/w/api.php";
const COMMONS_FILE = "https://commons.wikimedia.org/wiki/Special:FilePath";
const UA = "WorldCup2026API/1.0 (Node.js; educational project)";
const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const CACHE_MS = 5 * 60_000;
const IMG_CACHE_MS = 24 * 60 * 60 * 1000;

const cache = new Map();
const imgCache = new Map();

function getCached(key) { const e = cache.get(key); return e && Date.now() - e.ts < CACHE_MS ? e.data : null; }
function setCache(key, data) { cache.set(key, { data, ts: Date.now() }); return data; }
function getImgCached(key) { const e = imgCache.get(key); return e && Date.now() - e.ts < IMG_CACHE_MS ? e.url : undefined; }
function setImgCache(key, url) { imgCache.set(key, { url, ts: Date.now() }); return url; }

function normName(n) { return n ? n.trim().toLowerCase().replace(/\s+/g, " ") : ""; }

/** Strip diacritics: Ñ→N, é→e, etc. so Wikipedia search works. */
function stripAccents(s) { return s.normalize("NFD").replace(/[\u0300-\u036f]/g, ""); }

// ─── Image sources ──────────────────────────────────────────────

/** Source 1: ESPN headshot from API data. */
function getEspnDirect(athlete) {
  return (athlete.headshot && athlete.headshot.href) || null;
}

/**
 * Source 2: Wikipedia search API → page summary → thumbnail.
 * Strips accents so "Lautaro Martínez" → search "Lautaro Martinez footballer".
 */
async function tryWikipedia(name) {
  const ascii = stripAccents(name);
  for (const q of [ascii + " footballer", ascii + " soccer", name + " footballer"]) {
    try {
      const { data: sr } = await axios.get("https://en.wikipedia.org/w/api.php", {
        params: { action: "query", list: "search", srsearch: q, format: "json", srlimit: 1 },
        timeout: 6000, headers: { "User-Agent": UA },
      });
      const hit = sr.query && sr.query.search && sr.query.search[0];
      if (!hit) continue;
      const slug = encodeURIComponent(hit.title.replace(/ /g, "_"));
      const { data: pg } = await axios.get(`${WIKI_SUMMARY}/${slug}`, {
        timeout: 5000, headers: { "User-Agent": UA, Accept: "application/json" },
      });
      const thumb = (pg.thumbnail && pg.thumbnail.source) || (pg.originalimage && pg.originalimage.source);
      if (thumb && /upload\.wikimedia/.test(thumb)) return thumb;
    } catch {}
  }
  return null;
}

/** Source 3: Wikidata search + P18 property → Wikimedia Commons image. */
async function tryWikidata(name) {
  const ascii = stripAccents(name);
  try {
    const { data: sRes } = await axios.get(WIKIDATA_API, {
      params: { action: "wbsearchentities", search: ascii, language: "en", limit: 5, format: "json" },
      timeout: 6000, headers: { "User-Agent": UA },
    });
    const items = sRes && sRes.search;
    if (!items || !items.length) return null;
    const descOf = (it) => (typeof it.description === "string" ? it.description : "").toLowerCase();
    const best = items.find(it => /football|soccer|player/.test(descOf(it))) || items[0];
    if (!best || !best.id) return null;
    const { data: cRes } = await axios.get(WIKIDATA_API, {
      params: { action: "wbgetclaims", entity: best.id, property: "P18", format: "json" },
      timeout: 6000, headers: { "User-Agent": UA },
    });
    const p18 = cRes && cRes.claims && cRes.claims.P18 && cRes.claims.P18[0];
    const fn = p18 && p18.mainsnak && p18.mainsnak.datavalue && p18.mainsnak.datavalue.value;
    if (fn) return `${COMMONS_FILE}/${encodeURIComponent(fn)}`;
  } catch {}
  return null;
}

/** Source 4: TransferMarkt search scraping. */
async function tryTransfermarkt(name) {
  try {
    const { data: html } = await axios.get("https://www.transfermarkt.com/schnellsuche/ergebnis/schnellsuche", {
      params: { query: stripAccents(name) },
      timeout: 8000,
      headers: { "User-Agent": BROWSER_UA, Accept: "text/html" },
    });
    const $ = cheerio.load(html);
    const img = $("table.items tbody tr:first-child td.zentriert img").first().attr("src") ||
                $("table.items tbody tr:first-child img[src*='headshots']").first().attr("src") ||
                $(".spielprofil_tooltip img").first().attr("src");
    if (img && img.startsWith("http") && !img.includes("wappen") && !img.includes("flagge")) return img;
  } catch {}
  return null;
}

/** Source 5: SoFIFA scraping — almost every player in FIFA game has a photo. */
async function trySofifa(name) {
  try {
    const { data: html } = await axios.get("https://sofifa.com/players", {
      params: { keyword: stripAccents(name) },
      timeout: 8000,
      headers: { "User-Agent": BROWSER_UA, Accept: "text/html" },
    });
    const $ = cheerio.load(html);
    const img = $("table tbody tr:first-child td img[data-src]").first().attr("data-src") ||
                $("table tbody tr:first-child td img").first().attr("src");
    if (img && img.startsWith("http") && img.includes("sofifa")) return img;
  } catch {}
  return null;
}

/**
 * Multi-source image resolver with caching.
 * ESPN direct → Wikipedia search → Wikidata → TransferMarkt → SoFIFA.
 */
async function resolveImage(athlete) {
  const name = athlete.fullName || athlete.displayName ||
    [athlete.firstName, athlete.lastName].filter(Boolean).join(" ").trim();
  const key = normName(name);
  if (!key) return null;

  const cached = getImgCached(key);
  if (cached !== undefined) return cached;

  const espn = getEspnDirect(athlete);
  if (espn) { setImgCache(key, espn); return espn; }

  const wiki = await tryWikipedia(name);
  if (wiki) { setImgCache(key, wiki); return wiki; }

  const wd = await tryWikidata(name);
  if (wd) { setImgCache(key, wd); return wd; }

  const tm = await tryTransfermarkt(name);
  if (tm) { setImgCache(key, tm); return tm; }

  const sf = await trySofifa(name);
  if (sf) { setImgCache(key, sf); return sf; }

  setImgCache(key, null);
  return null;
}

/**
 * Process a batch of athletes: resolve images with concurrency limit.
 */
async function resolveRosterImages(athletes) {
  const BATCH = 5;
  const results = new Array(athletes.length);
  for (let i = 0; i < athletes.length; i += BATCH) {
    const slice = athletes.slice(i, i + BATCH);
    const imgs = await Promise.all(slice.map(a => resolveImage(a)));
    for (let j = 0; j < slice.length; j++) results[i + j] = imgs[j];
  }
  return results;
}

// ─── Team group photo (scrape Wikipedia) ────────────────────

const teamPhotoCache = new Map();

function scoreTeamPhoto(src, alt) {
  let s = 0;
  const text = (src + " " + alt).toLowerCase();
  if (/team|lineup|squad|starting|xi|national.*football|seleccion|football_team|equipe/i.test(text)) s += 15;
  if (/match|game|versus|copa|world.?cup|euro|qualif/i.test(text)) s += 5;
  if (/202[5-6]/.test(text)) s += 12;
  if (/2024/.test(text)) s += 10;
  if (/202[2-3]/.test(text)) s += 6;
  if (/202[0-1]/.test(text)) s += 3;
  if (/201[5-9]/.test(text)) s += 1;
  if (/headshot|portrait|player\/|messi|kane|neymar|mbappe|ronaldo/i.test(text)) s -= 20;
  if (/19[0-9]{2}/.test(text)) s -= 10;
  if (/stadium|arena|trophy|cup\b|venue|torch/i.test(text) && !/team|lineup/i.test(text)) s -= 10;
  return s;
}

/**
 * Scrape Wikipedia article for the national team page and pick the best
 * recent group/team photo. Returns a high-res Wikimedia URL or null.
 */
async function getTeamPhoto(teamName) {
  const key = normName(teamName);
  const cached = teamPhotoCache.get(key);
  if (cached && Date.now() - cached.ts < IMG_CACHE_MS) return cached.url;

  const slug = stripAccents(teamName).replace(/ /g, "_") + "_national_football_team";
  try {
    const { data: html } = await axios.get(`https://en.wikipedia.org/wiki/${encodeURIComponent(slug)}`, {
      timeout: 10000, headers: { "User-Agent": UA },
    });
    const $ = cheerio.load(html);
    const candidates = [];
    $("img").each((_, el) => {
      const src = $(el).attr("src") || "";
      const alt = $(el).attr("alt") || "";
      const width = parseInt($(el).attr("width") || "0");
      if (width < 180) return;
      if (/logo|crest|badge|seal|icon|flag|jersey|kit|medal|\.svg/i.test(src)) return;
      const score = scoreTeamPhoto(src, alt);
      candidates.push({ src, score, width });
    });
    candidates.sort((a, b) => b.score - a.score || b.width - a.width);
    const best = candidates[0];
    if (best && best.score > 0) {
      let url = best.src.startsWith("//") ? "https:" + best.src : best.src;
      url = url.replace(/\/(\d+)px-/, "/600px-");
      teamPhotoCache.set(key, { url, ts: Date.now() });
      return url;
    }
  } catch {}
  teamPhotoCache.set(key, { url: null, ts: Date.now() });
  return null;
}

// ─── Tournament info ─────────────────────────────────────────

const TOURNAMENT_INFO = {
  name: "FIFA World Cup 2026",
  nameHe: "מונדיאל 2026",
  year: 2026,
  host: "USA, Mexico & Canada",
  hostHe: "ארה״ב, מקסיקו וקנדה",
  startDate: "2026-06-11",
  endDate: "2026-07-19",
  teamsCount: 48,
  description: "The 23rd FIFA World Cup, expanded to 48 teams, hosted across 16 cities in North America.",
};

// ─── Helpers ─────────────────────────────────────────────────

async function parseTeam(teamFromRoster, teamMeta) {
  const r = teamFromRoster || {};
  const m = teamMeta || {};
  const logo = r.logo || (m.logos && m.logos[0] && m.logos[0].href) || null;
  const name = r.displayName || m.displayName || "Unknown";
  const teamPhoto = await getTeamPhoto(name);
  return {
    id: r.id || m.id || null,
    name,
    shortName: r.abbreviation || m.abbreviation || m.shortDisplayName || null,
    logo,
    image: logo,
    teamPhoto,
    color: (r.color || m.color) ? `#${r.color || m.color}` : null,
    recordSummary: r.recordSummary || null,
    standingSummary: r.standingSummary || null,
  };
}

function mapAthlete(a, image) {
  return {
    id: a.id,
    fullName: a.fullName || a.displayName,
    firstName: a.firstName,
    lastName: a.lastName,
    position: (a.position && (a.position.displayName || a.position.abbreviation)) || null,
    positionAbbr: (a.position && a.position.abbreviation) || null,
    image: image || null,
    age: a.age != null ? a.age : null,
    citizenship: a.citizenship || null,
    jerseyNumber: a.jersey != null ? a.jersey : null,
  };
}

// ─── GET / ─── Info
router.get("/", (_req, res) => {
  res.json({
    tournament: TOURNAMENT_INFO,
    endpoints: {
      info: "GET /world-cup-2026",
      teams: "GET /world-cup-2026/teams",
      teamDetail: "GET /world-cup-2026/teams/:teamId",
      players: "GET /world-cup-2026/players?teamId=",
      playerPhoto: "GET /world-cup-2026/player-photo/:name",
    },
  });
});

// ─── GET /teams ──────────────────────────────────────────────
router.get("/teams", async (_req, res) => {
  try {
    const c = getCached("teams"); if (c) return res.json(c);
    const { data } = await axios.get(`${ESPN_BASE}/teams`, { timeout: 12000 });
    const league = (data.sports && data.sports[0] && data.sports[0].leagues && data.sports[0].leagues[0]) || {};
    const raw = league.teams || [];
    const mapped = raw.map(({ team: t }) => {
      const logo = (t.logos && t.logos[0] && t.logos[0].href) || null;
      return {
        id: t.id, name: t.displayName || t.name, shortName: t.shortDisplayName || t.abbreviation,
        abbreviation: t.abbreviation, logo, image: logo, slug: t.slug,
        color: t.color ? `#${t.color}` : null,
      };
    }).sort((a, b) => (a.name || "").localeCompare(b.name || ""));
    // Fetch team photos in parallel batches
    const BATCH = 6;
    for (let i = 0; i < mapped.length; i += BATCH) {
      const slice = mapped.slice(i, i + BATCH);
      const photos = await Promise.all(slice.map(t => getTeamPhoto(t.name)));
      for (let j = 0; j < slice.length; j++) slice[j].teamPhoto = photos[j];
    }
    const teams = mapped;
    const out = { tournament: TOURNAMENT_INFO, count: teams.length, teams };
    setCache("teams", out);
    res.json(out);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch teams", message: err.message });
  }
});

// ─── GET /teams/:teamId ─────────────────────────────────────
router.get("/teams/:teamId", async (req, res) => {
  const { teamId } = req.params;
  try {
    const ck = `roster-${teamId}`;
    const c = getCached(ck); if (c) return res.json(c);

    const [teamsRes, rosterRes] = await Promise.all([
      axios.get(`${ESPN_BASE}/teams`, { timeout: 12000 }),
      axios.get(`${ESPN_BASE}/teams/${teamId}/roster`, { timeout: 12000 }),
    ]);
    const league = (teamsRes.data.sports && teamsRes.data.sports[0] && teamsRes.data.sports[0].leagues && teamsRes.data.sports[0].leagues[0]) || {};
    const raw = league.teams || [];
    const meta = (raw.find(t => String((t.team || {}).id) === String(teamId)) || {}).team;
    const rd = rosterRes.data;
    const team = await parseTeam(rd.team, meta);
    const athletes = rd.athletes || [];

    const imgs = await resolveRosterImages(athletes);
    const players = athletes.map((a, i) => mapAthlete(a, imgs[i]));

    const out = {
      tournament: TOURNAMENT_INFO, team,
      coach: (rd.coach || []).map(c => ({ id: c.id, name: [c.firstName, c.lastName].filter(Boolean).join(" ") })),
      playersCount: players.length, players,
    };
    setCache(ck, out);
    res.json(out);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch team roster", message: err.message });
  }
});

// ─── GET /players ────────────────────────────────────────────
router.get("/players", async (req, res) => {
  const { teamId } = req.query;
  try {
    if (teamId) {
      const ck = `roster-${teamId}`;
      let c = getCached(ck);
      if (!c) {
        const { data: rd } = await axios.get(`${ESPN_BASE}/teams/${teamId}/roster`, { timeout: 12000 });
        const t = rd.team || {};
        const logo = t.logo || null;
        const team = { id: t.id, name: t.displayName, logo, image: logo };
        const athletes = rd.athletes || [];
        const imgs = await resolveRosterImages(athletes);
        const players = athletes.map((a, i) => ({
          id: a.id, fullName: a.fullName || a.displayName,
          position: (a.position && a.position.displayName) || null,
          image: imgs[i] || null, age: a.age, citizenship: a.citizenship,
          teamId: t.id, teamName: t.displayName,
        }));
        c = { tournament: TOURNAMENT_INFO, team, players };
        setCache(ck, c);
      }
      return res.json({ ...c, count: (c.players || []).length });
    }

    const ck = "all-players";
    const c = getCached(ck); if (c) return res.json(c);

    const { data: td } = await axios.get(`${ESPN_BASE}/teams`, { timeout: 12000 });
    const raw = ((td.sports && td.sports[0] && td.sports[0].leagues && td.sports[0].leagues[0]) || {}).teams || [];
    const all = [];
    for (const { team: tm } of raw) {
      if (!tm || !tm.id) continue;
      try {
        const { data: rd } = await axios.get(`${ESPN_BASE}/teams/${tm.id}/roster`, { timeout: 10000 });
        const athletes = rd.athletes || [];
        const imgs = await resolveRosterImages(athletes);
        athletes.forEach((a, i) => {
          all.push({
            id: a.id, fullName: a.fullName || a.displayName,
            position: (a.position && a.position.displayName) || null,
            image: imgs[i] || null, age: a.age, citizenship: a.citizenship,
            teamId: tm.id, teamName: tm.displayName,
          });
        });
      } catch {}
    }
    const out = { tournament: TOURNAMENT_INFO, count: all.length, players: all };
    setCache(ck, out);
    res.json(out);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch players", message: err.message });
  }
});

// ─── GET /player-photo/:name ─── Proxy: returns actual image bytes ──────
router.get("/player-photo/:name", async (req, res) => {
  const name = decodeURIComponent(req.params.name || "").trim();
  if (!name) return res.status(400).json({ error: "Missing name" });
  try {
    const key = normName(name);
    let url = getImgCached(key);
    if (url === undefined) {
      const wiki = await tryWikipedia(name);
      if (wiki) { url = wiki; }
      else {
        const wd = await tryWikidata(name);
        if (wd) { url = wd; }
        else {
          const tm = await tryTransfermarkt(name);
          if (tm) { url = tm; }
        }
      }
      setImgCache(key, url || null);
    }
    if (!url) return res.status(404).json({ error: "No image found" });
    const imgRes = await axios.get(url, {
      responseType: "arraybuffer", timeout: 10000,
      headers: { "User-Agent": UA },
    });
    const ct = imgRes.headers["content-type"] || "image/jpeg";
    res.set("Content-Type", ct);
    res.set("Cache-Control", "public, max-age=86400");
    res.send(Buffer.from(imgRes.data));
  } catch {
    res.status(502).json({ error: "Failed to proxy image" });
  }
});

export default router;
