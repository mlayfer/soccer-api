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
const valueCache = new Map();

function getCached(key) { const e = cache.get(key); return e && Date.now() - e.ts < CACHE_MS ? e.data : null; }
function setCache(key, data) { cache.set(key, { data, ts: Date.now() }); return data; }
function getImgCached(key) { const e = imgCache.get(key); return e && Date.now() - e.ts < IMG_CACHE_MS ? e.url : undefined; }
function setImgCache(key, url) { imgCache.set(key, { url, ts: Date.now() }); return url; }
function getValueCached(key) { const e = valueCache.get(key); return e && Date.now() - e.ts < IMG_CACHE_MS ? e.data : undefined; }
function setValueCache(key, data) { valueCache.set(key, { data, ts: Date.now() }); return data; }

function normName(n) { return n ? n.trim().toLowerCase().replace(/\s+/g, " ") : ""; }

/** Strip diacritics: Ñ→N, é→e, etc. so Wikipedia search works. */
function stripAccents(s) { return s.normalize("NFD").replace(/[\u0300-\u036f]/g, ""); }

// ─── Image sources ──────────────────────────────────────────────

/** Source 1: ESPN headshot from API data. */
function getEspnDirect(athlete) {
  return (athlete.headshot && athlete.headshot.href) || null;
}

/** When API has no headshot, try constructed ESPN CDN URL (validates with HEAD). */
async function tryEspnHeadshotById(athlete) {
  const id = athlete?.id;
  if (!id) return null;
  try {
    const url = `${ESPN_HEADSHOT}/${id}.png`;
    const res = await axios.head(url, { timeout: 3000, validateStatus: (s) => s < 400 });
    if (res.status === 200) return url;
  } catch {}
  return null;
}

/**
 * Source 2: Wikipedia search API → page summary → thumbnail.
 * Strips accents so "Lautaro Martínez" → search "Lautaro Martinez footballer".
 */
async function tryWikipedia(name) {
  const ascii = stripAccents(name);
  const queries = [
    ascii + " footballer",
    ascii + " soccer",
    ascii + " (footballer)",
    name + " footballer",
    ascii + " association football",
    ascii, // Famous players may have simple "First Last" page
  ];
  for (const q of queries) {
    try {
      const { data: sr } = await axios.get("https://en.wikipedia.org/w/api.php", {
        params: { action: "query", list: "search", srsearch: q, format: "json", srlimit: 2 },
        timeout: 6000, headers: { "User-Agent": UA },
      });
      const hits = sr.query && sr.query.search || [];
      for (const hit of hits.slice(0, 2)) {
        if (!hit || !hit.title) continue;
        const slug = encodeURIComponent(hit.title.replace(/ /g, "_"));
        const { data: pg } = await axios.get(`${WIKI_SUMMARY}/${slug}`, {
          timeout: 5000, headers: { "User-Agent": UA, Accept: "application/json" },
        });
        const thumb = (pg.thumbnail && pg.thumbnail.source) || (pg.originalimage && pg.originalimage.source);
        if (thumb && /upload\.wikimedia/.test(thumb) && !/logo|crest|badge|flag|svg/i.test(thumb)) return thumb;
      }
    } catch {}
  }
  return null;
}

/** Source 3: Wikidata search + P18 property → Wikimedia Commons image. */
async function tryWikidata(name) {
  const ascii = stripAccents(name);
  for (const q of [ascii, ascii + " footballer"]) {
    try {
      const { data: sRes } = await axios.get(WIKIDATA_API, {
        params: { action: "wbsearchentities", search: q, language: "en", limit: 8, format: "json" },
        timeout: 6000, headers: { "User-Agent": UA },
      });
      const items = sRes && sRes.search;
      if (!items || !items.length) continue;
      const descOf = (it) => (typeof it.description === "string" ? it.description : "").toLowerCase();
      for (const it of items.slice(0, 4)) {
        if (!it.id) continue;
        const desc = descOf(it);
        if (!/football|soccer|player|athlete|sports/.test(desc)) continue;
        const { data: cRes } = await axios.get(WIKIDATA_API, {
          params: { action: "wbgetclaims", entity: it.id, property: "P18", format: "json" },
          timeout: 5000, headers: { "User-Agent": UA },
        });
        const p18 = cRes?.claims?.P18?.[0];
        const fn = p18?.mainsnak?.datavalue?.value;
        if (fn && !/logo|crest|badge|flag/i.test(fn)) return `${COMMONS_FILE}/${encodeURIComponent(fn)}`;
      }
    } catch {}
  }
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

/** Source 6: Wikimedia Commons search — "X footballer" in file namespace. */
async function tryCommonsPlayer(name) {
  const ascii = stripAccents(name);
  for (const q of [ascii + " footballer", ascii + " soccer player", ascii + " (footballer)", ascii]) {
    try {
      const { data } = await axios.get("https://commons.wikimedia.org/w/api.php", {
        params: {
          action: "query",
          generator: "search",
          gsrsearch: q,
          gsrnamespace: 6,
          gsrlimit: 5,
          prop: "imageinfo",
          iiprop: "url",
          format: "json",
        },
        timeout: 6000,
        headers: { "User-Agent": UA },
      });
      const pages = data?.query?.pages || {};
      for (const p of Object.values(pages)) {
        const title = (p.title || "").toLowerCase();
        if (/logo|crest|badge|flag|team|squad|lineup|kit|jersey/.test(title)) continue;
        if (!/\.(jpg|jpeg|png|webp)$/i.test(title)) continue;
        const url = p.imageinfo?.[0]?.url;
        if (url && url.startsWith("http")) return url;
      }
    } catch {}
  }
  return null;
}

/** Source 7: WorldFootball.net — predictable URL: player_summary/name-slug/ */
async function tryWorldFootball(name) {
  const slug = stripAccents(name).toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
  if (slug.length < 4) return null;
  try {
    const { data: html } = await axios.get(`https://www.worldfootball.net/player_summary/${slug}/`, {
      timeout: 6000, headers: { "User-Agent": BROWSER_UA }, validateStatus: (s) => s < 400,
    });
    const $ = cheerio.load(html);
    const img = $("img[src*='worldfootball']").first().attr("src") ||
                $(".portrait img, .bild img, .photo img").first().attr("src") ||
                $("meta[property='og:image']").first().attr("content");
    if (img && img.startsWith("http") && !/logo|crest|flag/i.test(img)) return img;
  } catch {}
  return null;
}

/** Source 8: Kicker.de — German football site, /name/spieler */
async function tryKicker(name) {
  const slug = stripAccents(name).toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
  if (slug.length < 4) return null;
  try {
    const { data: html } = await axios.get(`https://www.kicker.de/${slug}/spieler`, {
      timeout: 6000, headers: { "User-Agent": BROWSER_UA }, validateStatus: (s) => s < 400,
    });
    const $ = cheerio.load(html);
    const img = $("img[src*='kicker']").first().attr("src") ||
                $(".player-image img, .spielerbild img").first().attr("src") ||
                $("meta[property='og:image']").first().attr("content");
    if (img && img.startsWith("http") && !/logo|wappen|flagge/i.test(img)) {
      return img.startsWith("//") ? "https:" + img : img;
    }
  } catch {}
  return null;
}

/** Source 9: Zerozero.pt — Portuguese football database */
async function tryZerozero(name) {
  const slug = stripAccents(name).toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
  if (slug.length < 4) return null;
  try {
    const { data: html } = await axios.get(`https://www.zerozero.pt/player/${slug}/`, {
      timeout: 6000, headers: { "User-Agent": BROWSER_UA }, validateStatus: (s) => s < 400,
    });
    const $ = cheerio.load(html);
    const img = $("img[src*='zerozero']").first().attr("src") ||
                $(".player-photo img").first().attr("src") ||
                $("meta[property='og:image']").first().attr("content");
    if (img && img.startsWith("http") && !/logo|badge|escudo/i.test(img)) return img;
  } catch {}
  return null;
}

/** Source 10b: PlaymakerStats — search players, get first football result */
async function tryPlaymakerstats(name) {
  try {
    const { data: html } = await axios.get("https://www.playmakerstats.com/players", {
      params: { search_txt: stripAccents(name) },
      timeout: 6000, headers: { "User-Agent": BROWSER_UA },
    });
    const $ = cheerio.load(html);
    const link = $("a[href*='/player/']").first().attr("href");
    if (!link || !link.includes("/player/")) return null;
    const playerUrl = link.startsWith("http") ? link : "https://www.playmakerstats.com" + (link.startsWith("/") ? link : "/" + link);
    const { data: pHtml } = await axios.get(playerUrl, {
      timeout: 5000, headers: { "User-Agent": BROWSER_UA },
    });
    const $2 = cheerio.load(pHtml);
    const img = $2("img[src*='playmakerstats']").first().attr("src") ||
                $2(".player-image img").first().attr("src") ||
                $2("meta[property='og:image']").first().attr("content");
    if (img && img.startsWith("http") && !/logo|badge/i.test(img)) return img;
  } catch {}
  return null;
}

/** Source 10: FBref player search. */
async function tryFbrefPlayer(name) {
  try {
    const { data: html } = await axios.get("https://fbref.com/search/search.fcgi", {
      params: { search: stripAccents(name) },
      timeout: 8000,
      headers: { "User-Agent": BROWSER_UA, Accept: "text/html" },
    });
    const $ = cheerio.load(html);
    const link = $("table.search_results tbody tr th a[href*='/players/']").first().attr("href");
    if (!link) return null;
    const m = link.match(/\/players\/([a-f0-9]+)\//);
    const pid = m ? m[1] : null;
    if (!pid) return null;
    const img = $(`img[src*='${pid}']`).first().attr("src") ||
                $("table.search_results tbody tr:first-child img").first().attr("src");
    if (img && img.startsWith("http")) return img;
    const playerUrl = "https://fbref.com" + (link.startsWith("/") ? link : "/" + link);
    const { data: pHtml } = await axios.get(playerUrl, {
      timeout: 6000,
      headers: { "User-Agent": BROWSER_UA },
    });
    const $2 = cheerio.load(pHtml);
    const img2 = $2("img[src*='headshot']").first().attr("src") ||
                 $2(".media-item img").first().attr("src");
    if (img2 && img2.startsWith("http")) return img2.startsWith("//") ? "https:" + img2 : img2;
  } catch {}
  return null;
}

/** Parse TransferMarkt value string to { valueM: number, display: string }. */
function parseTransfermarktValue(raw) {
  if (!raw || typeof raw !== "string") return null;
  const s = raw.trim();
  if (s === "-" || s === "" || s === "—") return null;
  const m = s.match(/€\s*([\d,.]+)\s*(m|M|Th\.?|k|K)?/i);
  if (!m) return null;
  let num = parseFloat(m[1].replace(/,/g, "."));
  const unit = (m[2] || "m").toLowerCase();
  if (unit === "th" || unit === "th.") num /= 1000;
  else if (unit === "k") num /= 1000;
  return { valueM: num, display: s };
}

/** Get market value from TransferMarkt player search. */
async function getTransfermarktValue(name) {
  const key = normName(name);
  const cached = getValueCached(key);
  if (cached !== undefined) return cached;

  try {
    const { data: html } = await axios.get("https://www.transfermarkt.com/schnellsuche/ergebnis/schnellsuche", {
      params: { query: stripAccents(name) },
      timeout: 8000, headers: { "User-Agent": BROWSER_UA, Accept: "text/html" },
    });
    const $ = cheerio.load(html);
    let val = null;
    $("table.items tbody tr.odd, table.items tbody tr.even").each((_, row) => {
      if (val) return;
      const tds = $(row).find("td");
      for (let i = 0; i < tds.length; i++) {
        const text = $(tds[i]).text().trim();
        if (/€[\d,.]+\s*(m|M|Th|k|K)/.test(text)) {
          val = parseTransfermarktValue(text);
          return false; // break
        }
      }
    });
    setValueCache(key, val);
    return val;
  } catch {
    setValueCache(key, null);
    return null;
  }
}

/**
 * Multi-source image resolver with caching.
 * ESPN → ESPN ID → Wikipedia → Wikidata → TransferMarkt → SoFIFA → Commons → FBref →
 * WorldFootball → Kicker → Zerozero → PlaymakerStats.
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

  const espnId = await tryEspnHeadshotById(athlete);
  if (espnId) { setImgCache(key, espnId); return espnId; }

  const wiki = await tryWikipedia(name);
  if (wiki) { setImgCache(key, wiki); return wiki; }

  const wd = await tryWikidata(name);
  if (wd) { setImgCache(key, wd); return wd; }

  const tm = await tryTransfermarkt(name);
  if (tm) { setImgCache(key, tm); return tm; }

  const sf = await trySofifa(name);
  if (sf) { setImgCache(key, sf); return sf; }

  const commons = await tryCommonsPlayer(name);
  if (commons) { setImgCache(key, commons); return commons; }

  const fbref = await tryFbrefPlayer(name);
  if (fbref) { setImgCache(key, fbref); return fbref; }

  const wf = await tryWorldFootball(name);
  if (wf) { setImgCache(key, wf); return wf; }

  const kicker = await tryKicker(name);
  if (kicker) { setImgCache(key, kicker); return kicker; }

  const zerozero = await tryZerozero(name);
  if (zerozero) { setImgCache(key, zerozero); return zerozero; }

  const pms = await tryPlaymakerstats(name);
  if (pms) { setImgCache(key, pms); return pms; }

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

/**
 * Resolve market values for athletes (TransferMarkt) in parallel batches.
 */
async function resolveRosterValues(athletes) {
  const name = (a) => a.fullName || a.displayName || [a.firstName, a.lastName].filter(Boolean).join(" ").trim();
  const BATCH = 4;
  const results = new Array(athletes.length);
  for (let i = 0; i < athletes.length; i += BATCH) {
    const slice = athletes.slice(i, i + BATCH);
    const vals = await Promise.all(slice.map(a => getTransfermarktValue(name(a))));
    for (let j = 0; j < slice.length; j++) results[i + j] = vals[j];
  }
  return results;
}

// ─── Team group photo (multi-source: Wikipedia, TransferMarkt) ───────

const teamPhotoCache = new Map();

const TEAM_TO_WIKI_SLUG = {
  "united states": "United_States_men's_national_soccer_team",
  "usa": "United_States_men's_national_soccer_team",
  "iran": "Iran_national_football_team",
  "ir iran": "Iran_national_football_team",
  "korea republic": "South_Korea_national_football_team",
  "south korea": "South_Korea_national_football_team",
  "england": "England_national_football_team",
  "wales": "Wales_national_football_team",
  "scotland": "Scotland_national_football_team",
  "northern ireland": "Northern_Ireland_national_football_team",
  "côte d'ivoire": "Ivory_Coast_national_football_team",
  "ivory coast": "Ivory_Coast_national_football_team",
  "czechia": "Czech_Republic_national_football_team",
  "czech republic": "Czech_Republic_national_football_team",
  "venezuela": "Venezuela_national_football_team",
  "colombia": "Colombia_national_football_team",
  "peru": "Peru_national_football_team",
  "chile": "Chile_national_football_team",
  "ecuador": "Ecuador_national_football_team",
  "bolivia": "Bolivia_national_football_team",
  "paraguay": "Paraguay_national_football_team",
  "uruguay": "Uruguay_national_football_team",
  "brazil": "Brazil_national_football_team",
  "argentina": "Argentina_national_football_team",
  "germany": "Germany_national_football_team",
  "france": "France_national_football_team",
  "spain": "Spain_national_football_team",
  "italy": "Italy_national_football_team",
  "netherlands": "Netherlands_national_football_team",
  "portugal": "Portugal_national_football_team",
  "belgium": "Belgium_national_football_team",
  "croatia": "Croatia_national_football_team",
  "serbia": "Serbia_national_football_team",
  "switzerland": "Switzerland_national_football_team",
  "mexico": "Mexico_national_football_team",
  "canada": "Canada_men's_national_soccer_team",
  "japan": "Japan_national_football_team",
  "australia": "Australia_national_soccer_team",
  "morocco": "Morocco_national_football_team",
  "senegal": "Senegal_national_football_team",
  "nigeria": "Nigeria_national_football_team",
  "egypt": "Egypt_national_football_team",
  "ghana": "Ghana_national_football_team",
  "tunisia": "Tunisia_national_football_team",
  "cameroon": "Cameroon_national_football_team",
  "costa rica": "Costa_Rica_national_football_team",
  "honduras": "Honduras_national_football_team",
  "jamaica": "Jamaica_national_football_team",
  "panama": "Panama_national_football_team",
  "saudi arabia": "Saudi_Arabia_national_football_team",
  "qatar": "Qatar_national_football_team",
  "uae": "United_Arab_Emirates_national_football_team",
  "united arab emirates": "United_Arab_Emirates_national_football_team",
  "iraq": "Iraq_national_football_team",
  "uzbekistan": "Uzbekistan_national_football_team",
  "oman": "Oman_national_football_team",
  "china": "China_national_football_team",
  "new zealand": "New_Zealand_men's_national_football_team",
  "ukraine": "Ukraine_national_football_team",
  "poland": "Poland_national_football_team",
  "sweden": "Sweden_national_football_team",
  "denmark": "Denmark_national_football_team",
  "norway": "Norway_national_football_team",
  "russia": "Russia_national_football_team",
  "wales": "Wales_national_football_team",
};

function scoreTeamPhoto(src, alt) {
  let s = 0;
  const text = (src + " " + alt).toLowerCase();
  if (/squad|lineup|team.?photo|group|official|starting.?xi|seleccion|equipe/i.test(text)) s += 25;
  if (/202[5-6]/.test(text)) s += 15;
  if (/2024/.test(text)) s += 12;
  if (/202[2-3]/.test(text)) s += 10;
  if (/202[0-1]/.test(text)) s += 8;
  if (/201[8-9]/.test(text)) s += 5;
  if (/201[5-7]/.test(text)) s += 3;
  if (/201[4]/.test(text)) s += 1;
  if (/world.?cup|copa|euro|qualif|match|game/i.test(text)) s += 3;
  if (/team|national/i.test(text)) s += 5;
  if (/headshot|portrait|bust|player\/|messi|ronaldo|\.svg/i.test(text)) s -= 30;
  if (/logo|crest|badge|flag|jersey|kit|medal|icon|seal/i.test(src)) s -= 25;
  if (/19[0-9]{2}/.test(text)) s -= 8;
  if (/stadium|arena|trophy|venue|torch|ball/i.test(text) && !/squad|lineup|team/i.test(text)) s -= 12;
  return s;
}

function parseWikiImg($, minWidth = 120, minScore = -8) {
  const candidates = [];
  $("img").each((_, el) => {
    const src = $(el).attr("src") || "";
    const alt = $(el).attr("alt") || "";
    const width = parseInt($(el).attr("width") || "0");
    if (width < minWidth) return;
    if (/logo|crest|badge|seal|icon|flag|jersey|kit|medal|\.svg|wikidata/i.test(src)) return;
    const score = scoreTeamPhoto(src, alt);
    if (score >= minScore) candidates.push({ src, score, width });
  });
  candidates.sort((a, b) => b.score - a.score || b.width - a.width);
  const best = candidates[0];
  if (best) {
    let url = best.src.startsWith("//") ? "https:" + best.src : best.src;
    url = url.replace(/\/(\d+)px-/, "/600px-");
    return url;
  }
  return null;
}

async function tryWikipediaTeamPhoto(teamName) {
  const n = normName(teamName);
  const base = stripAccents(teamName).replace(/ /g, "_");
  const slugs = [
    TEAM_TO_WIKI_SLUG[n],
    base + "_national_football_team",
    base + "_men's_national_soccer_team",
    base + "_national_team",
    base + "_at_the_2022_FIFA_World_Cup",
    base + "_at_the_2024_Copa_América",
    base + "_at_UEFA_Euro_2024",
    base + "_at_the_2018_FIFA_World_Cup",
    base + "_at_UEFA_Euro_2020",
    base + "_at_the_2021_Copa_América",
    base + "_at_the_2014_FIFA_World_Cup",
  ].filter(Boolean);
  for (const slug of [...new Set(slugs)]) {
    try {
      const { data: html } = await axios.get(`https://en.wikipedia.org/wiki/${encodeURIComponent(slug)}`, {
        timeout: 10000, headers: { "User-Agent": UA },
        validateStatus: (s) => s < 400,
      });
      if (!html || typeof html !== "string") continue;
      const $ = cheerio.load(html);
      const url = parseWikiImg($, 120, -8);
      if (url) return url;
    } catch {}
  }
  return null;
}

async function tryTransfermarktTeamPhoto(teamName) {
  const q = stripAccents(teamName) + " national team";
  try {
    const { data: html } = await axios.get("https://www.transfermarkt.com/schnellsuche/ergebnis/schnellsuche", {
      params: { query: q },
      timeout: 8000, headers: { "User-Agent": BROWSER_UA, Accept: "text/html" },
    });
    const $ = cheerio.load(html);
    const link = $("table.items tbody tr a[href*='startseite/verein']").first().attr("href");
    if (!link) return null;
    const teamUrl = "https://www.transfermarkt.com" + (link.startsWith("/") ? link : "/" + link);
    const { data: teamHtml } = await axios.get(teamUrl, {
      timeout: 8000, headers: { "User-Agent": BROWSER_UA },
    });
    const $2 = cheerio.load(teamHtml);
    const imgs = [];
    $2("img").each((_, el) => {
      const src = $2(el).attr("src") || "";
      const w = parseInt($2(el).attr("width") || "0");
      const alt = ($2(el).attr("alt") || "").toLowerCase();
      if (src.startsWith("http") && w >= 100 && !/wappen|flagge|logo|crest|badge|\.svg|spieler|player/i.test(src + alt)) imgs.push({ src, w });
    });
    imgs.sort((a, b) => b.w - a.w);
    const img = imgs[0]?.src;
    if (img) return img.replace(/small|middle|tiny|mini/, "normal");
  } catch {}
  return null;
}

async function tryWikiCommonsTeamPhoto(teamName) {
  const base = stripAccents(teamName);
  const queries = [
    base + " national football team squad",
    base + " national team 2024",
    base + " national team 2022",
    base + " national team World Cup squad",
  ];
  for (const q of queries) {
    try {
      const { data } = await axios.get("https://commons.wikimedia.org/w/api.php", {
        params: { action: "query", list: "search", srsearch: q, srnamespace: 6, format: "json", srlimit: 10 },
        timeout: 8000, headers: { "User-Agent": UA },
      });
      const results = data?.query?.search || [];
      let best = null;
      let bestYear = 0;
      for (const r of results) {
        const title = (r.title || "").replace("File:", "");
        if (!/\.(jpg|jpeg|png|webp)$/i.test(title)) continue;
        if (/logo|crest|badge|flag|icon|kit|jersey/i.test(title)) continue;
        if (!/squad|team|lineup|group|official|players|202[0-6]|201[5-9]| Copa|World.?Cup|Euro/i.test(title)) continue;
        const m = title.match(/20(1[4-9]|2[0-6])/);
        const year = m ? parseInt(m[0], 10) : 0;
        if (year > bestYear) { bestYear = year; best = title; }
        if (!best) best = title;
      }
      if (best) {
        const fileUrl = `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(best)}`;
        return fileUrl + "?width=600";
      }
    } catch {}
  }
  return null;
}

async function tryFbrefTeamPhoto(teamName) {
  const n = normName(teamName);
  const codes = { argentina: "ARG", brazil: "BRA", france: "FRA", germany: "GER", spain: "ESP", italy: "ITA",
    england: "ENG", portugal: "POR", netherlands: "NED", belgium: "BEL", croatia: "CRO", uruguay: "URU",
    usa: "USA", "united states": "USA", mexico: "MEX", canada: "CAN", japan: "JPN", "korea republic": "KOR",
    "south korea": "KOR", morocco: "MAR", senegal: "SEN", egypt: "EGY", iran: "IRN", "ir iran": "IRN",
    australia: "AUS", "saudi arabia": "KSA", colombia: "COL", chile: "CHI", ecuador: "ECU", peru: "PER",
    switzerland: "SUI", serbia: "SRB", poland: "POL", sweden: "SWE", denmark: "DEN", wales: "WAL",
    venezuela: "VEN", bolivia: "BOL", paraguay: "PAR", honduras: "HON", jamaica: "JAM", panama: "PAN",
    "costa rica": "CRC", qatar: "QAT", iraq: "IRQ", uzbekistan: "UZB", oman: "OMN", china: "CHN",
    "new zealand": "NZL", ukraine: "UKR", tunisia: "TUN", ghana: "GHA", nigeria: "NGA", cameroon: "CMR",
    "côte d'ivoire": "CIV", "ivory coast": "CIV", czechia: "CZE", "czech republic": "CZE",
    "united arab emirates": "UAE", uae: "UAE",
  };
  const code = codes[n];
  if (!code) return null;
  const slug = stripAccents(teamName).replace(/\s+/g, "-").replace(/'/g, "");
  try {
    const resp = await axios.get(`https://fbref.com/en/country/${code}/men/`, {
      timeout: 8000, headers: { "User-Agent": BROWSER_UA },
      validateStatus: () => true,
    });
    if (resp.status === 404 || !resp.data) return null;
    const $ = cheerio.load(typeof resp.data === "string" ? resp.data : String(resp.data || ""));
    const img = $(".media-item img").first().attr("src") || $("img[data-src*='squad']").first().attr("data-src") || $("img[src*='squad']").first().attr("src");
    if (img && img.startsWith("http")) return img.startsWith("//") ? "https:" + img : img;
  } catch {}
  return null;
}

/** תמונה קבוצתית חייבת להיות landscape (רוחב > גובה). דוחים רק כשאנחנו בטוחים שזה portrait. */
async function isLandscapePhoto(url) {
  try {
    const { data } = await axios.get(url, {
      responseType: "arraybuffer",
      timeout: 5000,
      headers: { Range: "bytes=0-2047", "User-Agent": UA },
      validateStatus: (s) => s === 200 || s === 206,
    });
    const raw = Buffer.isBuffer(data) ? data : Buffer.from(data || []);
    const buf = raw.length > 2048 ? raw.subarray(0, 2048) : raw;
    let w = 0, h = 0;
    if (buf[0] === 0xff && buf[1] === 0xd8) {
      for (let i = 2; i < buf.length - 9; i++) {
        if (buf[i] === 0xff && (buf[i + 1] === 0xc0 || buf[i + 1] === 0xc2)) {
          h = buf.readUInt16BE(i + 5);
          w = buf.readUInt16BE(i + 7);
          break;
        }
      }
    } else if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e) {
      w = buf.readUInt32BE(16);
      h = buf.readUInt32BE(20);
    }
    if (w > 0 && h > 0) return w > h; // דוחים רק portrait מאומת
    return true; // לא הצלחנו לקרוא – מקבלים (CDN/פורמט לא תומך)
  } catch {
    return true; // שגיאה ברשת – מקבלים
  }
}

async function getTeamPhoto(teamName) {
  const key = normName(teamName);
  const cached = teamPhotoCache.get(key);
  if (cached && Date.now() - cached.ts < IMG_CACHE_MS) return cached.url;

  const sources = [
    () => tryWikipediaTeamPhoto(teamName),
    () => tryTransfermarktTeamPhoto(teamName),
    () => tryWikiCommonsTeamPhoto(teamName),
    () => tryFbrefTeamPhoto(teamName),
  ];
  for (const fn of sources) {
    try {
      const url = await fn();
      if (url && await isLandscapePhoto(url)) {
        teamPhotoCache.set(key, { url, ts: Date.now() });
        return url;
      }
    } catch {}
  }

  teamPhotoCache.set(key, { url: null, ts: Date.now() });
  return null;
}

// ─── Tournament info ─────────────────────────────────────────

const TOURNAMENT_INFO = {
  name: "FIFA World Cup 2026",
  nameHe: "World Cup 2026",
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

function mapAthlete(a, image, marketValue) {
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
    marketValue: marketValue || null, // { valueM: number, display: string } e.g. €85.00m
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

    const [imgs, values] = await Promise.all([
      resolveRosterImages(athletes),
      resolveRosterValues(athletes),
    ]);
    const players = athletes.map((a, i) => mapAthlete(a, imgs[i], values[i]));

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
        const [imgs, values] = await Promise.all([
          resolveRosterImages(athletes),
          resolveRosterValues(athletes),
        ]);
        const players = athletes.map((a, i) => ({
          id: a.id, fullName: a.fullName || a.displayName,
          position: (a.position && a.position.displayName) || null,
          image: imgs[i] || null, age: a.age, citizenship: a.citizenship,
          teamId: t.id, teamName: t.displayName,
          marketValue: values[i] || null,
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
        const [imgs, values] = await Promise.all([
          resolveRosterImages(athletes),
          resolveRosterValues(athletes),
        ]);
        athletes.forEach((a, i) => {
          all.push({
            id: a.id, fullName: a.fullName || a.displayName,
            position: (a.position && a.position.displayName) || null,
            image: imgs[i] || null, age: a.age, citizenship: a.citizenship,
            teamId: tm.id, teamName: tm.displayName,
            marketValue: values[i] || null,
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
      url = await resolveImage({ fullName: name });
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
