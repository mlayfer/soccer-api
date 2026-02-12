import { Router } from "express";
import axios from "axios";

const router = Router();

// ──────────────────────────────────────────────────────────────
//  SEFARIA API — Hebrew Bible (Tanakh) with English translation
// ──────────────────────────────────────────────────────────────
const SEFARIA_BASE = "https://www.sefaria.org/api";

/**
 * All books of the Hebrew Bible (Tanakh), organised by section.
 * `ref` is the Sefaria reference name, `chapters` is the total chapter count.
 */
const TANAKH = {
  Torah: [
    { ref: "Genesis", he: "בראשית", chapters: 50 },
    { ref: "Exodus", he: "שמות", chapters: 40 },
    { ref: "Leviticus", he: "ויקרא", chapters: 27 },
    { ref: "Numbers", he: "במדבר", chapters: 36 },
    { ref: "Deuteronomy", he: "דברים", chapters: 34 },
  ],
  Prophets: [
    { ref: "Joshua", he: "יהושע", chapters: 24 },
    { ref: "Judges", he: "שופטים", chapters: 21 },
    { ref: "I Samuel", he: "שמואל א", chapters: 31 },
    { ref: "II Samuel", he: "שמואל ב", chapters: 24 },
    { ref: "I Kings", he: "מלכים א", chapters: 22 },
    { ref: "II Kings", he: "מלכים ב", chapters: 25 },
    { ref: "Isaiah", he: "ישעיהו", chapters: 66 },
    { ref: "Jeremiah", he: "ירמיהו", chapters: 52 },
    { ref: "Ezekiel", he: "יחזקאל", chapters: 48 },
    { ref: "Hosea", he: "הושע", chapters: 14 },
    { ref: "Joel", he: "יואל", chapters: 4 },
    { ref: "Amos", he: "עמוס", chapters: 9 },
    { ref: "Obadiah", he: "עובדיה", chapters: 1 },
    { ref: "Jonah", he: "יונה", chapters: 4 },
    { ref: "Micah", he: "מיכה", chapters: 7 },
    { ref: "Nahum", he: "נחום", chapters: 3 },
    { ref: "Habakkuk", he: "חבקוק", chapters: 3 },
    { ref: "Zephaniah", he: "צפניה", chapters: 3 },
    { ref: "Haggai", he: "חגי", chapters: 2 },
    { ref: "Zechariah", he: "זכריה", chapters: 14 },
    { ref: "Malachi", he: "מלאכי", chapters: 3 },
  ],
  Writings: [
    { ref: "Psalms", he: "תהלים", chapters: 150 },
    { ref: "Proverbs", he: "משלי", chapters: 31 },
    { ref: "Job", he: "איוב", chapters: 42 },
    { ref: "Song of Songs", he: "שיר השירים", chapters: 8 },
    { ref: "Ruth", he: "רות", chapters: 4 },
    { ref: "Lamentations", he: "איכה", chapters: 5 },
    { ref: "Ecclesiastes", he: "קהלת", chapters: 12 },
    { ref: "Esther", he: "אסתר", chapters: 10 },
    { ref: "Daniel", he: "דניאל", chapters: 12 },
    { ref: "Ezra", he: "עזרא", chapters: 10 },
    { ref: "Nehemiah", he: "נחמיה", chapters: 13 },
    { ref: "I Chronicles", he: "דברי הימים א", chapters: 29 },
    { ref: "II Chronicles", he: "דברי הימים ב", chapters: 36 },
  ],
};

/** Flat list of every book for quick lookups. */
const ALL_BOOKS = Object.values(TANAKH).flat();

/**
 * Find a book by name (case-insensitive, partial match, or Hebrew match).
 */
function findBook(input) {
  if (!input) return null;
  const q = input.trim().toLowerCase();

  // Exact English match
  const exact = ALL_BOOKS.find((b) => b.ref.toLowerCase() === q);
  if (exact) return exact;

  // Hebrew match
  const heMatch = ALL_BOOKS.find((b) => b.he === input.trim());
  if (heMatch) return heMatch;

  // Partial English match
  const partial = ALL_BOOKS.find((b) => b.ref.toLowerCase().includes(q));
  return partial || null;
}

/**
 * Strip HTML tags that Sefaria sometimes includes in text.
 */
function stripHtml(str) {
  if (typeof str !== "string") return str;
  return str.replace(/<[^>]*>/g, "").trim();
}

/**
 * Process a verse or array of verses — strip HTML and normalise.
 */
function cleanVerses(data) {
  if (Array.isArray(data)) return data.map((v) => stripHtml(v));
  return stripHtml(data);
}

// ──────────────────────────────────────────────────────────────
//  ROUTES
// ──────────────────────────────────────────────────────────────

/**
 * GET /bible/books
 * List all books of the Hebrew Bible (Tanakh), grouped by section.
 */
router.get("/books", (req, res) => {
  const sections = Object.entries(TANAKH).map(([section, books]) => ({
    section,
    sectionHebrew: { Torah: "תורה", Prophets: "נביאים", Writings: "כתובים" }[section],
    books: books.map((b) => ({
      name: b.ref,
      nameHebrew: b.he,
      chapters: b.chapters,
    })),
  }));

  res.json({
    source: "Sefaria.org",
    totalBooks: ALL_BOOKS.length,
    sections,
  });
});

/**
 * GET /bible/text
 * Retrieve Bible text in Hebrew and English.
 *
 * Query params:
 *   book    – book name in English or Hebrew (required)
 *   chapter – chapter number (optional — omit to get full book info)
 *   verse   – verse number or range e.g. "1" or "1-5" (optional)
 */
router.get("/text", async (req, res) => {
  const { book, chapter, verse } = req.query;

  if (!book) {
    return res.status(400).json({
      error: "Missing required query param: book",
      example: "/bible/text?book=Genesis&chapter=1&verse=1",
    });
  }

  const found = findBook(book);
  if (!found) {
    return res.status(404).json({
      error: `Book not found: "${book}"`,
      hint: "Use /bible/books to see all valid book names.",
    });
  }

  // Build Sefaria reference string
  let ref = found.ref;
  if (chapter) {
    const chNum = Number(chapter);
    if (isNaN(chNum) || chNum < 1 || chNum > found.chapters) {
      return res.status(400).json({
        error: `Invalid chapter ${chapter} for ${found.ref}. Valid range: 1-${found.chapters}`,
      });
    }
    ref += `.${chNum}`;
    if (verse) ref += `.${verse}`;
  }

  try {
    const apiRes = await axios.get(`${SEFARIA_BASE}/texts/${encodeURIComponent(ref)}`, {
      params: { context: 0 },
      timeout: 10_000,
    });

    const d = apiRes.data;
    const hebrew = cleanVerses(d.he);
    const english = cleanVerses(d.text);

    // Build verses array when we have a chapter
    let verses = null;
    if (chapter && Array.isArray(hebrew)) {
      verses = hebrew.map((he, i) => ({
        verse: i + 1,
        hebrew: he,
        english: Array.isArray(english) ? english[i] || null : null,
      }));

      // If a specific verse/range was requested, filter
      if (verse) {
        const parts = String(verse).split("-").map(Number);
        const start = parts[0];
        const end = parts[1] || parts[0];
        verses = verses.filter((v) => v.verse >= start && v.verse <= end);
      }
    }

    res.json({
      source: "Sefaria.org",
      ref: d.ref,
      book: found.ref,
      bookHebrew: found.he,
      chapter: chapter ? Number(chapter) : null,
      totalChapters: found.chapters,
      totalVerses: Array.isArray(hebrew) ? hebrew.length : null,
      verses,
      // When no chapter specified, return raw text for overview
      ...(verses ? {} : { hebrew, english }),
    });
  } catch (err) {
    if (err.response?.status === 404) {
      return res.status(404).json({
        error: `Reference not found: "${ref}"`,
        hint: "Check book name, chapter and verse numbers.",
      });
    }
    console.error("[Bible Text Error]", err.message);
    res.status(502).json({
      error: "Failed to fetch text from Sefaria",
      details: err.message,
    });
  }
});

/**
 * GET /bible/search
 * Search the Hebrew Bible for a word or phrase.
 *
 * Query params:
 *   q       – search term (required)
 *   lang    – "he" for Hebrew, "en" for English (default "en")
 *   limit   – max results (optional, default 20, max 100)
 */
router.get("/search", async (req, res) => {
  const { q, lang, limit } = req.query;

  if (!q) {
    return res.status(400).json({
      error: "Missing required query param: q",
      example: '/bible/search?q=in the beginning&lang=en',
    });
  }

  const language = lang === "he" ? "hebrew" : "english";
  const size = Math.min(Number(limit) || 20, 100);

  try {
    const apiRes = await axios.post(
      `${SEFARIA_BASE}/search-wrapper`,
      {
        query: q,
        type: "text",
        field: language,
        filters: ["Tanakh"],
        size,
        sort_type: "relevance",
      },
      { timeout: 15_000 }
    );

    const hits = (apiRes.data?.hits?.hits || []).map((h) => {
      const src = h._source || {};
      return {
        ref: src.ref,
        book: src.ref?.split(/[.:]/)?.[0] || null,
        hebrew: stripHtml(src.hebrew || src.he || null),
        english: stripHtml(src.english || src.text || null),
      };
    });

    res.json({
      source: "Sefaria.org",
      query: q,
      language: lang === "he" ? "hebrew" : "english",
      count: hits.length,
      results: hits,
    });
  } catch (err) {
    console.error("[Bible Search Error]", err.message);
    res.status(502).json({
      error: "Failed to search Sefaria",
      details: err.message,
    });
  }
});

/**
 * GET /bible/random
 * Get a random verse from the Tanakh in Hebrew and English.
 *
 * Query params:
 *   book – optional, restrict to a specific book
 */
router.get("/random", async (req, res) => {
  const { book } = req.query;

  // Pick a random book (or use the specified one)
  let target;
  if (book) {
    target = findBook(book);
    if (!target) {
      return res.status(404).json({
        error: `Book not found: "${book}"`,
        hint: "Use /bible/books to see all valid book names.",
      });
    }
  } else {
    target = ALL_BOOKS[Math.floor(Math.random() * ALL_BOOKS.length)];
  }

  // Pick random chapter and verse
  const chapter = Math.floor(Math.random() * target.chapters) + 1;

  try {
    // First fetch the chapter to know how many verses it has
    const chapterRes = await axios.get(
      `${SEFARIA_BASE}/texts/${encodeURIComponent(target.ref + "." + chapter)}`,
      { params: { context: 0 }, timeout: 10_000 }
    );

    const heArr = chapterRes.data?.he || [];
    const enArr = chapterRes.data?.text || [];
    const verseCount = heArr.length;

    if (verseCount === 0) {
      return res.json({ source: "Sefaria.org", message: "No verses found. Try again." });
    }

    const verseIdx = Math.floor(Math.random() * verseCount);

    res.json({
      source: "Sefaria.org",
      ref: `${target.ref} ${chapter}:${verseIdx + 1}`,
      book: target.ref,
      bookHebrew: target.he,
      chapter,
      verse: verseIdx + 1,
      hebrew: stripHtml(heArr[verseIdx]),
      english: stripHtml(enArr[verseIdx] || null),
    });
  } catch (err) {
    console.error("[Bible Random Error]", err.message);
    res.status(502).json({
      error: "Failed to fetch random verse",
      details: err.message,
    });
  }
});

export default router;
