import { Router } from "express";
import axios from "axios";

const router = Router();

/**
 * ESPN public API endpoints for soccer scoreboards.
 * Each league has its own endpoint that returns JSON with today's matches.
 */
const LEAGUES = [
  { slug: "eng.1", name: "English Premier League", country: "England" },
  { slug: "esp.1", name: "La Liga", country: "Spain" },
  { slug: "ger.1", name: "Bundesliga", country: "Germany" },
  { slug: "ita.1", name: "Serie A", country: "Italy" },
  { slug: "fra.1", name: "Ligue 1", country: "France" },
  { slug: "ned.1", name: "Eredivisie", country: "Netherlands" },
  { slug: "por.1", name: "Primeira Liga", country: "Portugal" },
  { slug: "usa.1", name: "MLS", country: "USA" },
  { slug: "uefa.champions", name: "UEFA Champions League", country: "Europe" },
  { slug: "uefa.europa", name: "UEFA Europa League", country: "Europe" },
  { slug: "uefa.europa.conf", name: "UEFA Conference League", country: "Europe" },
  { slug: "eng.fa", name: "FA Cup", country: "England" },
  { slug: "esp.copa_del_rey", name: "Copa del Rey", country: "Spain" },
  { slug: "global.world_cup", name: "FIFA World Cup", country: "International" },
];

const ESPN_BASE =
  "https://site.api.espn.com/apis/site/v2/sports/soccer";

let cache = { ts: 0, data: null };
const CACHE_MS = Number(process.env.CACHE_MS || 60_000); // 60s cache

/**
 * Map an ESPN status type to a simpler status string.
 */
function mapStatus(statusType, statusDetail) {
  const name = statusType?.name;
  const detail = statusDetail?.trim();

  if (name === "STATUS_FULL_TIME" || name === "STATUS_FINAL") return "FT";
  if (name === "STATUS_HALFTIME") return "HT";
  if (name === "STATUS_POSTPONED") return "Postponed";
  if (name === "STATUS_CANCELED") return "Cancelled";
  if (name === "STATUS_SUSPENDED") return "Suspended";
  if (name === "STATUS_DELAYED") return "Delayed";
  if (name === "STATUS_ABANDONED") return "Abandoned";
  if (name === "STATUS_IN_PROGRESS" || name === "STATUS_FIRST_HALF" || name === "STATUS_SECOND_HALF")
    return detail || "Live";
  if (name === "STATUS_SCHEDULED") return "Scheduled";
  if (name === "STATUS_END_OF_EXTRATIME" || name === "STATUS_FULL_TIME_EXTRA_TIME") return "AET";
  if (name === "STATUS_PENALTIES" || name === "STATUS_END_OF_PENALTIES") return "PEN";
  return detail || name || "Unknown";
}

/**
 * Parse a single ESPN event object into our match format.
 */
function parseEvent(event, leagueMeta) {
  const competition = event.competitions?.[0];
  if (!competition) return null;

  const competitors = competition.competitors || [];
  const home = competitors.find((c) => c.homeAway === "home");
  const away = competitors.find((c) => c.homeAway === "away");

  if (!home || !away) return null;

  const homeScore = Number(home.score);
  const awayScore = Number(away.score);
  const hasScore =
    Number.isFinite(homeScore) && Number.isFinite(awayScore);

  const statusObj = competition.status || event.status || {};
  const statusType = statusObj.type || {};
  const statusDetail = statusType.shortDetail || statusType.detail || "";
  const status = mapStatus(statusType, statusDetail);

  // Build time string from the event date
  const eventDate = new Date(event.date);
  const time = eventDate.toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
  });

  return {
    country: leagueMeta.country,
    league: leagueMeta.name,
    time,
    dateUTC: event.date,
    status,
    statusDetail,
    home: home.team?.displayName || home.team?.shortDisplayName || "Unknown",
    away: away.team?.displayName || away.team?.shortDisplayName || "Unknown",
    score: hasScore ? `${homeScore} - ${awayScore}` : null,
    homeScore: hasScore ? homeScore : null,
    awayScore: hasScore ? awayScore : null,
  };
}

/**
 * Fetch today's matches for a single league from the ESPN API.
 */
async function fetchLeague(league) {
  const url = `${ESPN_BASE}/${league.slug}/scoreboard`;
  try {
    const res = await axios.get(url, {
      timeout: 10_000,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (compatible; SoccerScoresAPI/1.0)",
        Accept: "application/json",
      },
    });

    const events = res.data?.events || [];
    return events
      .map((ev) => parseEvent(ev, league))
      .filter(Boolean);
  } catch (err) {
    // If a league has no games today, ESPN may 404 — just skip it
    console.warn(`[WARN] Could not fetch ${league.slug}: ${err.message}`);
    return [];
  }
}

/**
 * Fetch today's matches across all configured leagues (in parallel).
 */
async function fetchToday() {
  const now = Date.now();
  if (cache.data && now - cache.ts < CACHE_MS) return cache.data;

  const results = await Promise.allSettled(
    LEAGUES.map((l) => fetchLeague(l))
  );

  const matches = results
    .filter((r) => r.status === "fulfilled")
    .flatMap((r) => r.value);

  const payload = {
    source: "ESPN",
    dateISO: new Date().toISOString().slice(0, 10),
    count: matches.length,
    matches,
  };

  cache = { ts: now, data: payload };
  return payload;
}

// --- Routes (mounted under /soccer by server.js) ---

/**
 * GET /soccer/today
 * Returns all matches across all leagues for the current matchday.
 */
router.get("/today", async (req, res) => {
  try {
    const data = await fetchToday();
    res.json(data);
  } catch (err) {
    res.status(500).json({
      error: "Failed to fetch scores",
      details: err?.message || String(err),
    });
  }
});

/**
 * GET /soccer/league/:slug
 * Returns matches for a specific league by its ESPN slug.
 * Example: /soccer/league/eng.1
 */
router.get("/league/:slug", async (req, res) => {
  const { slug } = req.params;
  const leagueMeta = LEAGUES.find((l) => l.slug === slug);
  if (!leagueMeta) {
    return res.status(404).json({
      error: `Unknown league slug: ${slug}`,
      availableLeagues: LEAGUES.map((l) => ({
        slug: l.slug,
        name: l.name,
      })),
    });
  }

  try {
    const matches = await fetchLeague(leagueMeta);
    res.json({
      source: "ESPN",
      league: leagueMeta.name,
      country: leagueMeta.country,
      dateISO: new Date().toISOString().slice(0, 10),
      count: matches.length,
      matches,
    });
  } catch (err) {
    res.status(500).json({
      error: "Failed to fetch scores",
      details: err?.message || String(err),
    });
  }
});

/**
 * GET /soccer/leagues
 * Lists all available league slugs.
 */
router.get("/leagues", (req, res) => {
  res.json({
    leagues: LEAGUES.map((l) => ({
      slug: l.slug,
      name: l.name,
      country: l.country,
    })),
  });
});

export default router;
