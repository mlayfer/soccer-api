import { Router } from "express";
import axios from "axios";
import * as cheerio from "cheerio";

const router = Router();

// ──────────────────────────────────────────────────────────────
//  HEBREW JOKES — scraped from yo-yoo.co.il/jokes
// ──────────────────────────────────────────────────────────────
const JOKES_BASE = "https://www.yo-yoo.co.il/jokes";

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml",
  "Accept-Language": "he-IL,he;q=0.9,en;q=0.8",
};

/** Known max joke ID (approximately — the site goes up to ~4035+). */
const MAX_JOKE_ID = 4035;

// ──────────────────────────────────────────────────────────────
//  Windows-1255 URL encoding helper
//  The site uses windows-1255 (Hebrew code-page) encoding for
//  category URL parameters — NOT UTF-8.  We map Hebrew chars
//  (U+05D0–U+05EA → 0xE0–0xFA) and fall through to standard
//  percent-encoding for ASCII.
// ──────────────────────────────────────────────────────────────
function encodeWin1255(str) {
  let out = "";
  for (const ch of str) {
    const cp = ch.codePointAt(0);
    if (cp >= 0x05d0 && cp <= 0x05ea) {
      // Hebrew letter → windows-1255 byte
      const byte = 0xe0 + (cp - 0x05d0);
      out += "%" + byte.toString(16).toUpperCase();
    } else if (
      (cp >= 0x30 && cp <= 0x39) || // 0-9
      (cp >= 0x41 && cp <= 0x5a) || // A-Z
      (cp >= 0x61 && cp <= 0x7a) || // a-z
      "-_.~".includes(ch)
    ) {
      out += ch;
    } else if (ch === " ") {
      out += "%20";
    } else {
      // fallback: percent-encode the byte
      out += encodeURIComponent(ch);
    }
  }
  return out;
}

/**
 * Categories with their Hebrew names.
 * `param` is the Hebrew string the site expects in windows-1255 encoding.
 */
const CATEGORIES = [
  { slug: "animals", he: "בעלי חיים", param: "בעלי חיים" },
  { slug: "politics", he: "פוליטיקה", param: "פוליטיקה" },
  { slug: "ethnic", he: "עדות", param: "עדות" },
  { slug: "blondes", he: "בלונדיניות", param: "בלונדיניות" },
  { slug: "yo-mama", he: "אמא שלך", param: "אמאשך" },
  { slug: "corny", he: "קרש", param: "קרש" },
  { slug: "dark-humor", he: "הומור שחור", param: "הומור שחור" },
  { slug: "edgy", he: "שונות", param: "שונות" },
  { slug: "school", he: "בית ספר", param: "בית ספר" },
  { slug: "dad", he: "אבא", param: "אבא" },
  { slug: "love", he: "אהבה", param: "אהבה" },
  { slug: "crazy", he: "משוגעים", param: "משוגעים" },
  { slug: "doctors", he: "רופאים", param: "רופאים" },
  { slug: "grandma", he: "סבתא", param: "סבתא" },
  { slug: "holidays", he: "חגים", param: "חגים" },
  { slug: "witty", he: "שנונות", param: "שנונות" },
  { slug: "kids", he: "ילדים", param: "לילדים" },
  { slug: "army", he: "צבא", param: "צבא" },
  { slug: "elderly", he: "זקנים", param: "זקנים" },
  { slug: "clean", he: "נקיות", param: "נקיות" },
  { slug: "math", he: "מתמטיקה", param: "מתמטיקה" },
  { slug: "football", he: "כדורגל", param: "כדורגל" },
  { slug: "names", he: "בדיחות שמות", param: "בדיחות שמות" },
  { slug: "dwarfs", he: "גמדים", param: "גמדים" },
  { slug: "summer", he: "לחופש", param: "לחופש" },
  { slug: "corona", he: "קורונה", param: "קורונה" },
  { slug: "surfers", he: "גולשים", param: "גולשים" },
  { slug: "chuck-norris", he: "צ'אק נוריס", param: "צאק נוריס" },
];

// Simple in-memory cache for scraped pages
const cache = new Map();
const CACHE_TTL = 1000 * 60 * 30; // 30 minutes

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
 * Fetch an HTML page with caching.
 * The site uses windows-1255 encoding — we fetch the raw bytes
 * and decode them ourselves so Hebrew text comes through correctly.
 */
async function fetchPage(url) {
  const hit = cached(url);
  if (hit) return hit;
  const { data: buf } = await axios.get(url, {
    headers: HEADERS,
    timeout: 10_000,
    responseType: "arraybuffer",
  });
  const html = new TextDecoder("windows-1255").decode(buf);
  return setCache(url, html);
}

/**
 * Parse a single joke page and extract the joke.
 *
 * The site structure puts the joke text inside a JS call:
 *   openSharePopup(`JOKE TEXT`, ``)
 * The title lives in the <title> tag:
 *   "בדיחה : TITLE - יויו בדיחות"
 * Category can be extracted from the <h2>:
 *   "עוד בדיחות CATEGORY:"
 */
function parseJokePage(html, id) {
  const $ = cheerio.load(html);

  // ── Title ──────────────────────────────────────────────
  let title = null;
  const pageTitle = $("title").text().trim();
  const titleMatch = pageTitle.match(/בדיחה\s*:\s*(.+?)\s*-\s*יויו/);
  if (titleMatch) title = titleMatch[1].trim();

  // ── Joke text — primary: from openSharePopup() ────────
  let jokeText = null;
  const bodyHtml = $("body").html() || "";
  const shareMatch = bodyHtml.match(/openSharePopup\(`([^`]+)`/);
  if (shareMatch) {
    // Decode any HTML entities (e.g. &quot; → ") using cheerio
    jokeText = cheerio.load(shareMatch[1]).text().replace(/\s+/g, " ").trim();
  }

  // ── Fallback: <meta name="description"> ───────────────
  if (!jokeText) {
    const metaDesc = ($('meta[name="description"]').attr("content") || "").trim();
    if (metaDesc.length > 3) jokeText = metaDesc;
  }

  // ── Category from <h2> "עוד בדיחות X:" ───────────────
  let category = null;
  const h2text = $("h2").first().text().trim();
  const catMatch = h2text.match(/בדיחות\s+(.+?):/);
  if (catMatch) category = catMatch[1].trim();

  return {
    id: Number(id),
    title,
    joke: jokeText,
    category,
    url: `${JOKES_BASE}/joke.php?id=${id}`,
  };
}

/**
 * Parse a category/listing page and extract joke links with titles.
 */
function parseListingPage(html) {
  const $ = cheerio.load(html);
  const jokes = [];

  $('a[href*="joke.php?id="]').each((_, el) => {
    const href = $(el).attr("href") || "";
    const match = href.match(/id=(\d+)/);
    if (match) {
      const id = Number(match[1]);
      const title = $(el).text().trim();
      if (title && !jokes.find((j) => j.id === id)) {
        jokes.push({ id, title, url: `${JOKES_BASE}/joke.php?id=${id}` });
      }
    }
  });

  return jokes;
}

// ──────────────────────────────────────────────────────────────
//  ROUTES
// ──────────────────────────────────────────────────────────────

/**
 * GET /jokes/categories
 * List all available joke categories.
 */
router.get("/categories", (req, res) => {
  res.json({
    source: "yo-yoo.co.il",
    count: CATEGORIES.length,
    categories: CATEGORIES.map((c) => ({
      slug: c.slug,
      nameHebrew: c.he,
    })),
  });
});

/**
 * GET /jokes/random
 * Get a random joke in Hebrew.
 *
 * Query params:
 *   count – number of random jokes to return (default 1, max 10)
 */
router.get("/random", async (req, res) => {
  const count = Math.min(Math.max(Number(req.query.count) || 1, 1), 10);

  try {
    const jokes = [];
    const tried = new Set();
    let attempts = 0;

    while (jokes.length < count && attempts < count * 5) {
      attempts++;
      const id = Math.floor(Math.random() * MAX_JOKE_ID) + 1;
      if (tried.has(id)) continue;
      tried.add(id);

      try {
        const html = await fetchPage(`${JOKES_BASE}/joke.php?id=${id}`);
        const joke = parseJokePage(html, id);
        if (joke.joke && joke.joke.length > 3) {
          jokes.push(joke);
        }
      } catch {
        // Skip unavailable joke IDs
      }
    }

    res.json({
      source: "yo-yoo.co.il",
      count: jokes.length,
      jokes,
    });
  } catch (err) {
    console.error("[Jokes Random Error]", err.message);
    res.status(502).json({ error: "Failed to fetch random joke", details: err.message });
  }
});

/**
 * GET /jokes/latest
 * Get the latest jokes.
 *
 * Query params:
 *   limit – max jokes to fetch full text for (default 10, max 20)
 */
router.get("/latest", async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 10, 1), 20);

  try {
    const html = await fetchPage(`${JOKES_BASE}/new.php`);
    const jokeLinks = parseListingPage(html).slice(0, limit);

    // Fetch full joke text for each
    const jokes = await Promise.all(
      jokeLinks.map(async (link) => {
        try {
          const jokeHtml = await fetchPage(`${JOKES_BASE}/joke.php?id=${link.id}`);
          return parseJokePage(jokeHtml, link.id);
        } catch {
          return { ...link, joke: null };
        }
      })
    );

    res.json({
      source: "yo-yoo.co.il",
      count: jokes.length,
      jokes,
    });
  } catch (err) {
    console.error("[Jokes Latest Error]", err.message);
    res.status(502).json({ error: "Failed to fetch latest jokes", details: err.message });
  }
});

/**
 * GET /jokes/category/:slug
 * Get jokes from a specific category.
 *
 * Query params:
 *   limit – max jokes to fetch full text for (default 10, max 20)
 *   page  – page number for pagination (default 1)
 */
router.get("/category/:slug", async (req, res) => {
  const slug = req.params.slug.toLowerCase().trim();
  const limit = Math.min(Math.max(Number(req.query.limit) || 10, 1), 20);
  const page = Math.max(Number(req.query.page) || 1, 1);

  const category = CATEGORIES.find((c) => c.slug === slug);
  if (!category) {
    return res.status(404).json({
      error: `Category not found: "${slug}"`,
      hint: "Use /jokes/categories to see all valid category slugs.",
      validSlugs: CATEGORIES.map((c) => c.slug),
    });
  }

  try {
    const catParam = encodeWin1255(category.param);
    const url = `${JOKES_BASE}/?cat=${catParam}${page > 1 ? `&page=${page}` : ""}`;
    const html = await fetchPage(url);
    const jokeLinks = parseListingPage(html).slice(0, limit);

    // Fetch full joke text for each
    const jokes = await Promise.all(
      jokeLinks.map(async (link) => {
        try {
          const jokeHtml = await fetchPage(`${JOKES_BASE}/joke.php?id=${link.id}`);
          return parseJokePage(jokeHtml, link.id);
        } catch {
          return { ...link, joke: null };
        }
      })
    );

    res.json({
      source: "yo-yoo.co.il",
      category: category.slug,
      categoryHebrew: category.he,
      page,
      count: jokes.length,
      jokes,
    });
  } catch (err) {
    console.error("[Jokes Category Error]", err.message);
    res.status(502).json({ error: "Failed to fetch category jokes", details: err.message });
  }
});

/**
 * GET /jokes/:id
 * Get a specific joke by its ID.
 */
router.get("/:id", async (req, res) => {
  const id = Number(req.params.id);

  if (isNaN(id) || id < 1) {
    return res.status(400).json({
      error: "Invalid joke ID. Must be a positive number.",
      example: "/jokes/4033",
    });
  }

  try {
    const html = await fetchPage(`${JOKES_BASE}/joke.php?id=${id}`);
    const joke = parseJokePage(html, id);

    if (!joke.joke) {
      return res.status(404).json({
        error: `Joke not found or empty: id=${id}`,
        hint: "Try /jokes/random for a random joke or /jokes/latest for recent ones.",
      });
    }

    res.json({
      source: "yo-yoo.co.il",
      ...joke,
    });
  } catch (err) {
    if (err.response?.status === 404) {
      return res.status(404).json({ error: `Joke not found: id=${id}` });
    }
    console.error("[Joke Error]", err.message);
    res.status(502).json({ error: "Failed to fetch joke", details: err.message });
  }
});

export default router;
