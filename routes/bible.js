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

/** Hebrew numerals for converting chapter:verse to Hebrew. */
const HE_NUMERALS = {
  1: "א", 2: "ב", 3: "ג", 4: "ד", 5: "ה", 6: "ו", 7: "ז", 8: "ח", 9: "ט",
  10: "י", 11: "יא", 12: "יב", 13: "יג", 14: "יד", 15: "טו", 16: "טז",
  17: "יז", 18: "יח", 19: "יט", 20: "כ", 21: "כא", 22: "כב", 23: "כג",
  24: "כד", 25: "כה", 26: "כו", 27: "כז", 28: "כח", 29: "כט", 30: "ל",
  31: "לא", 32: "לב", 33: "לג", 34: "לד", 35: "לה", 36: "לו", 37: "לז",
  38: "לח", 39: "לט", 40: "מ", 41: "מא", 42: "מב", 43: "מג", 44: "מד",
  45: "מה", 46: "מו", 47: "מז", 48: "מח", 49: "מט", 50: "נ",
  51: "נא", 52: "נב", 53: "נג", 54: "נד", 55: "נה", 56: "נו", 57: "נז",
  58: "נח", 59: "נט", 60: "ס", 61: "סא", 62: "סב", 63: "סג", 64: "סד",
  65: "סה", 66: "סו", 100: "ק", 119: "קיט", 150: "קנ",
};

function toHebrewNumeral(n) {
  if (HE_NUMERALS[n]) return HE_NUMERALS[n];
  if (n > 99) {
    const hundreds = Math.floor(n / 100) * 100;
    const remainder = n % 100;
    const hPart = { 100: "ק", 200: "ר" }[hundreds] || "ק";
    return remainder ? hPart + (HE_NUMERALS[remainder] || String(remainder)) : hPart;
  }
  return String(n);
}

/**
 * Convert an English ref like "Genesis 1:1" to Hebrew "בראשית א:א".
 * Returns { refHebrew, bookHebrew } or nulls if the book isn't found.
 */
function hebrewRef(ref) {
  if (!ref) return { refHebrew: null, bookHebrew: null };
  // Ref format: "Book Chapter:Verse" or "Book Chapter:Start-End"
  const bookName = ref.replace(/[\d.:,\-\s]+$/, "").trim();
  const rest = ref.slice(bookName.length).trim(); // e.g. "1:1" or "6:4"
  const found = ALL_BOOKS.find(
    (b) => b.ref.toLowerCase() === bookName.toLowerCase()
  );
  if (!found) return { refHebrew: null, bookHebrew: null };

  if (!rest) return { refHebrew: found.he, bookHebrew: found.he };

  // Convert "1:1" → "א:א", "6:4-5" → "ו:ד-ה"
  const heRest = rest.replace(/\d+/g, (m) => toHebrewNumeral(Number(m)));
  return {
    refHebrew: `${found.he} ${heRest}`,
    bookHebrew: found.he,
  };
}

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
 * Strip HTML tags and entities that Sefaria sometimes includes in text.
 */
function stripHtml(str) {
  if (typeof str !== "string") return str;
  return str
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&thinsp;/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\{[ספפ]\}/g, "")   // Remove section markers {ס} {פ}
    .replace(/\s{2,}/g, " ")
    .trim();
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

    const hr = hebrewRef(d.ref);
    res.json({
      source: "Sefaria.org",
      ref: d.ref,
      refHebrew: hr.refHebrew,
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
 *   lang    – "he" for Hebrew, "en" for English (default auto-detect)
 *   limit   – max results (optional, default 20, max 100)
 */
router.get("/search", async (req, res) => {
  const { q, lang, limit } = req.query;

  if (!q) {
    return res.status(400).json({
      error: "Missing required query param: q",
      example: '/bible/search?q=בראשית ברא&lang=he',
    });
  }

  // Auto-detect language if not specified
  const isHebrew =
    lang === "he" || (!lang && /[\u0590-\u05FF]/.test(q));
  const searchLang = isHebrew ? "hebrew" : "english";
  // Sefaria now requires "naive_lemmatizer" or "exact" — the old
  // "hebrew" / "english" field names no longer return results.
  const field = "naive_lemmatizer";
  const size = Math.min(Number(limit) || 20, 100);

  try {
    const apiRes = await axios.post(
      `${SEFARIA_BASE}/search-wrapper`,
      {
        query: q,
        type: "text",
        field,
        filters: ["Tanakh"],
        size: size * 3, // fetch extra to compensate for dedup
        sort_type: "relevance",
      },
      { timeout: 15_000 }
    );

    // Sefaria now returns _id (with ref + version) and highlight
    // instead of _source.  Deduplicate by ref since the same verse
    // appears in multiple versions (nikkud, ta'amei hamikra, etc.)
    const seen = new Map();
    for (const h of apiRes.data?.hits?.hits || []) {
      const idStr = h._id || "";
      const refMatch = idStr.match(/^(.+?)\s*\(/);
      if (!refMatch) continue;

      const ref = refMatch[1].trim();
      if (seen.has(ref)) continue;

      const isHeVersion = idStr.includes("[he]");
      const highlightText = stripHtml(
        h.highlight?.[field]?.[0] || ""
      );

      seen.set(ref, {
        ref,
        book: ref.split(/[.:]/)?.[0]?.trim() || null,
        version: isHeVersion ? "hebrew" : "english",
        matchText: highlightText,
      });

      if (seen.size >= size) break;
    }

    // For each unique ref, fetch full Hebrew + English text
    const results = await Promise.all(
      [...seen.values()].map(async (entry) => {
        try {
          const textRes = await axios.get(
            `${SEFARIA_BASE}/texts/${encodeURIComponent(entry.ref)}`,
            { params: { context: 0 }, timeout: 8_000 }
          );
          const d = textRes.data;
          const heRaw = Array.isArray(d.he) ? d.he.join(" ") : d.he;
          const enRaw = Array.isArray(d.text) ? d.text.join(" ") : d.text;
          const hr = hebrewRef(entry.ref);
          return {
            ref: entry.ref,
            refHebrew: hr.refHebrew,
            book: entry.book,
            bookHebrew: hr.bookHebrew,
            hebrew: stripHtml(heRaw || null),
            english: stripHtml(enRaw || null),
          };
        } catch {
          // Fallback: return the highlight text only
          const hr = hebrewRef(entry.ref);
          return {
            ref: entry.ref,
            refHebrew: hr.refHebrew,
            book: entry.book,
            bookHebrew: hr.bookHebrew,
            hebrew: entry.version === "hebrew" ? entry.matchText : null,
            english: entry.version === "english" ? entry.matchText : null,
          };
        }
      })
    );

    res.json({
      source: "Sefaria.org",
      query: q,
      language: searchLang,
      count: results.length,
      results,
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

    const fullRef = `${target.ref} ${chapter}:${verseIdx + 1}`;
    const hr = hebrewRef(fullRef);
    res.json({
      source: "Sefaria.org",
      ref: fullRef,
      refHebrew: hr.refHebrew,
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
