import { Router } from "express";
import axios from "axios";

const router = Router();

// ──────────────────────────────────────────────────────────────
//  LEAGUES
// ──────────────────────────────────────────────────────────────
const LEAGUES = [
  // Top 5 European leagues
  { slug: "eng.1", name: "English Premier League", country: "England" },
  { slug: "esp.1", name: "La Liga", country: "Spain" },
  { slug: "ger.1", name: "Bundesliga", country: "Germany" },
  { slug: "ita.1", name: "Serie A", country: "Italy" },
  { slug: "fra.1", name: "Ligue 1", country: "France" },
  // More European
  { slug: "ned.1", name: "Eredivisie", country: "Netherlands" },
  { slug: "por.1", name: "Primeira Liga", country: "Portugal" },
  { slug: "tur.1", name: "Süper Lig", country: "Turkey" },
  { slug: "sco.1", name: "Scottish Premiership", country: "Scotland" },
  { slug: "bel.1", name: "Belgian Pro League", country: "Belgium" },
  // Americas
  { slug: "usa.1", name: "MLS", country: "USA" },
  { slug: "bra.1", name: "Brasileirão", country: "Brazil" },
  { slug: "arg.1", name: "Liga Profesional", country: "Argentina" },
  { slug: "mex.1", name: "Liga MX", country: "Mexico" },
  // UEFA
  { slug: "uefa.champions", name: "UEFA Champions League", country: "Europe" },
  { slug: "uefa.europa", name: "UEFA Europa League", country: "Europe" },
  { slug: "uefa.europa.conf", name: "UEFA Conference League", country: "Europe" },
  // Cups
  { slug: "eng.fa", name: "FA Cup", country: "England" },
  { slug: "eng.league_cup", name: "EFL Cup", country: "England" },
  { slug: "esp.copa_del_rey", name: "Copa del Rey", country: "Spain" },
  // International
  { slug: "global.world_cup", name: "FIFA World Cup", country: "International" },
  { slug: "global.world_cup_qual.uefa", name: "World Cup Qualifiers (UEFA)", country: "International" },
  { slug: "uefa.euro", name: "UEFA Euro", country: "Europe" },
  { slug: "conmebol.america", name: "Copa America", country: "South America" },
  // Second divisions
  { slug: "eng.2", name: "EFL Championship", country: "England" },
  { slug: "esp.2", name: "La Liga 2", country: "Spain" },
  { slug: "ger.2", name: "2. Bundesliga", country: "Germany" },
  { slug: "ita.2", name: "Serie B", country: "Italy" },
  { slug: "fra.2", name: "Ligue 2", country: "France" },
];

const ESPN_BASE = "https://site.api.espn.com/apis/site/v2/sports/soccer";
const ESPN_STANDINGS = "https://site.api.espn.com/apis/v2/sports/soccer";

// ──────────────────────────────────────────────────────────────
//  CACHE
// ──────────────────────────────────────────────────────────────
const cache = new Map();
const CACHE_MS = Number(process.env.CACHE_MS || 60_000); // 60s

function cached(key) {
  const entry = cache.get(key);
  if (entry && Date.now() - entry.ts < CACHE_MS) return entry.data;
  return null;
}
function setCache(key, data, ttl = CACHE_MS) {
  cache.set(key, { data, ts: Date.now(), ttl });
  return data;
}

// ──────────────────────────────────────────────────────────────
//  HELPERS
// ──────────────────────────────────────────────────────────────

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

/** Parse a team competitor into a clean object. */
function parseTeam(comp) {
  if (!comp) return null;
  const team = comp.team || {};
  const rec = comp.records?.[0];
  return {
    id: team.id || null,
    name: team.displayName || team.shortDisplayName || "Unknown",
    shortName: team.shortDisplayName || team.abbreviation || null,
    abbreviation: team.abbreviation || null,
    logo: team.logo || null,
    color: team.color ? `#${team.color}` : null,
    score: Number.isFinite(Number(comp.score)) ? Number(comp.score) : null,
    form: comp.form || null,
    record: rec?.summary || null,
    winner: comp.winner || false,
  };
}

/** Parse match incidents (goals, cards, etc.) */
function parseDetails(details, homeId, awayId) {
  if (!details || !details.length) return { goals: [], cards: [] };

  const goals = [];
  const cards = [];

  for (const d of details) {
    const minute = d.clock?.displayValue || null;
    const player = d.athletesInvolved?.[0]?.displayName || null;
    const teamId = d.team?.id || null;
    const side = teamId === homeId ? "home" : teamId === awayId ? "away" : null;

    if (d.scoringPlay) {
      goals.push({
        minute,
        player,
        side,
        ownGoal: d.ownGoal || false,
        penalty: d.penaltyKick || false,
      });
    }
    if (d.yellowCard || d.redCard) {
      cards.push({
        minute,
        player,
        side,
        type: d.redCard ? "red" : "yellow",
      });
    }
  }

  return { goals, cards };
}

/** Parse match statistics from competitors. */
function parseMatchStats(competitors) {
  const result = {};
  for (const comp of competitors) {
    const side = comp.homeAway;
    const stats = {};
    for (const s of comp.statistics || []) {
      stats[s.name] = s.displayValue;
    }
    if (Object.keys(stats).length > 0) {
      result[side] = stats;
    }
  }
  return Object.keys(result).length > 0 ? result : null;
}

/**
 * Parse a single ESPN event into a rich match object.
 * `full` = true returns incidents, stats, venue; false = compact summary.
 */
function parseEvent(event, leagueMeta, full = false) {
  const competition = event.competitions?.[0];
  if (!competition) return null;

  const competitors = competition.competitors || [];
  const homeComp = competitors.find((c) => c.homeAway === "home");
  const awayComp = competitors.find((c) => c.homeAway === "away");
  if (!homeComp || !awayComp) return null;

  const home = parseTeam(homeComp);
  const away = parseTeam(awayComp);

  const statusObj = competition.status || event.status || {};
  const statusType = statusObj.type || {};
  const statusDetail = statusType.shortDetail || statusType.detail || "";
  const status = mapStatus(statusType, statusDetail);

  const eventDate = new Date(event.date);
  const time = eventDate.toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
  });

  const venue = competition.venue;
  const hasScore = home.score !== null && away.score !== null;

  const match = {
    id: event.id,
    country: leagueMeta.country,
    league: leagueMeta.name,
    leagueSlug: leagueMeta.slug,
    dateUTC: event.date,
    time,
    status,
    statusDetail,
    clock: statusObj.displayClock || null,
    period: statusObj.period || null,
    home: home.name,
    away: away.name,
    homeShort: home.shortName,
    awayShort: away.shortName,
    homeLogo: home.logo,
    awayLogo: away.logo,
    homeColor: home.color,
    awayColor: away.color,
    score: hasScore ? `${home.score} - ${away.score}` : null,
    homeScore: home.score,
    awayScore: away.score,
    homeForm: home.form,
    awayForm: away.form,
    homeRecord: home.record,
    awayRecord: away.record,
    venue: venue
      ? {
          name: venue.fullName || null,
          city: venue.address?.city || null,
          country: venue.address?.country || null,
        }
      : null,
    attendance: competition.attendance || null,
    broadcasts: (competition.broadcasts || [])
      .flatMap((b) => b.names || []),
  };

  if (full) {
    const { goals, cards } = parseDetails(
      competition.details,
      homeComp.team?.id,
      awayComp.team?.id
    );
    match.goals = goals;
    match.cards = cards;
    match.statistics = parseMatchStats(competitors);
    match.headlines = (competition.headlines || []).map((h) => ({
      type: h.type,
      text: h.shortLinkText || h.description || null,
    }));
  }

  return match;
}

// ──────────────────────────────────────────────────────────────
//  DATA FETCHING
// ──────────────────────────────────────────────────────────────

/** Fetch scoreboard for a single league. date = "YYYYMMDD" or null for today. */
async function fetchLeague(league, date = null, full = false) {
  let url = `${ESPN_BASE}/${league.slug}/scoreboard`;
  if (date) url += `?dates=${date}`;
  try {
    const res = await axios.get(url, {
      timeout: 10_000,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; SoccerAPI/2.0)" },
    });
    return (res.data?.events || [])
      .map((ev) => parseEvent(ev, league, full))
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** Fetch today's matches across all leagues. */
async function fetchToday() {
  const key = "today";
  const hit = cached(key);
  if (hit) return hit;

  const results = await Promise.allSettled(
    LEAGUES.map((l) => fetchLeague(l))
  );
  const matches = results
    .filter((r) => r.status === "fulfilled")
    .flatMap((r) => r.value);

  return setCache(key, {
    source: "ESPN",
    dateISO: new Date().toISOString().slice(0, 10),
    count: matches.length,
    matches,
  });
}

/** Fetch standings for a league. */
async function fetchStandings(leagueSlug) {
  const key = `standings_${leagueSlug}`;
  const hit = cached(key);
  if (hit) return hit;

  const url = `${ESPN_STANDINGS}/${leagueSlug}/standings`;
  const { data } = await axios.get(url, {
    timeout: 10_000,
    headers: { "User-Agent": "Mozilla/5.0 (compatible; SoccerAPI/2.0)" },
  });

  const group = data.children?.[0];
  const entries = group?.standings?.entries || [];

  const table = entries.map((e) => {
    const team = e.team || {};
    const statsMap = {};
    for (const s of e.stats || []) {
      statsMap[s.name] = s.displayValue || s.value;
    }
    return {
      rank: Number(statsMap.rank) || null,
      team: team.displayName || team.name || "Unknown",
      abbreviation: team.abbreviation || null,
      logo: team.logos?.[0]?.href || null,
      played: Number(statsMap.gamesPlayed) || 0,
      wins: Number(statsMap.wins) || 0,
      draws: Number(statsMap.ties) || 0,
      losses: Number(statsMap.losses) || 0,
      goalsFor: Number(statsMap.pointsFor) || 0,
      goalsAgainst: Number(statsMap.pointsAgainst) || 0,
      goalDifference: statsMap.pointDifferential || "0",
      points: Number(statsMap.points) || 0,
      form: statsMap.overall || null,
      note: e.note?.description || null,
      noteColor: e.note?.color || null,
    };
  });

  // Sort by rank
  table.sort((a, b) => (a.rank || 99) - (b.rank || 99));

  return setCache(
    key,
    {
      source: "ESPN",
      league: data.name || leagueSlug,
      season: data.season?.displayName || null,
      count: table.length,
      table,
    },
    300_000 // 5 min cache for standings
  );
}

// ──────────────────────────────────────────────────────────────
//  ROUTES
// ──────────────────────────────────────────────────────────────

/**
 * GET /soccer/leagues
 * List all available leagues with slugs.
 */
router.get("/leagues", (req, res) => {
  res.json({
    count: LEAGUES.length,
    leagues: LEAGUES.map((l) => ({
      slug: l.slug,
      name: l.name,
      country: l.country,
    })),
  });
});

/**
 * GET /soccer/today
 * All matches across all leagues for the current matchday.
 */
router.get("/today", async (req, res) => {
  try {
    const data = await fetchToday();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch scores", details: err.message });
  }
});

/**
 * GET /soccer/league/:slug
 * Matches for a specific league. Optionally filter by date.
 * Query: ?date=YYYYMMDD (optional)
 */
router.get("/league/:slug", async (req, res) => {
  const { slug } = req.params;
  const leagueMeta = LEAGUES.find((l) => l.slug === slug);
  if (!leagueMeta) {
    return res.status(404).json({
      error: `Unknown league slug: ${slug}`,
      hint: "Use /soccer/leagues to list all available leagues.",
    });
  }

  const dateParam = req.query.date || null;

  try {
    const matches = await fetchLeague(leagueMeta, dateParam, true);
    res.json({
      source: "ESPN",
      league: leagueMeta.name,
      country: leagueMeta.country,
      dateISO: dateParam
        ? `${dateParam.slice(0, 4)}-${dateParam.slice(4, 6)}-${dateParam.slice(6, 8)}`
        : new Date().toISOString().slice(0, 10),
      count: matches.length,
      matches,
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch scores", details: err.message });
  }
});

/**
 * GET /soccer/match/:league/:id
 * Full detail for a single match (goals, cards, stats, venue, etc.).
 */
router.get("/match/:league/:id", async (req, res) => {
  const { league: slug, id: matchId } = req.params;
  const leagueMeta = LEAGUES.find((l) => l.slug === slug);
  if (!leagueMeta) {
    return res.status(404).json({ error: `Unknown league slug: ${slug}` });
  }

  try {
    // ESPN event endpoint
    const url = `${ESPN_BASE}/${slug}/summary?event=${matchId}`;
    const { data } = await axios.get(url, {
      timeout: 10_000,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; SoccerAPI/2.0)" },
    });

    // The summary has a different structure — boxscore, plays, etc.
    // Fall back to the scoreboard event for consistent parsing
    const matches = await fetchLeague(leagueMeta, null, true);
    const match = matches.find((m) => m.id === matchId);

    if (!match) {
      return res.status(404).json({ error: `Match not found: ${matchId}` });
    }

    // Enrich with summary data if available
    if (data.boxscore) {
      const teams = data.boxscore.teams || [];
      const statsObj = {};
      for (const t of teams) {
        const side = t.homeAway;
        const teamStats = {};
        for (const s of t.statistics || []) {
          teamStats[s.label || s.name] = s.displayValue;
        }
        if (Object.keys(teamStats).length > 0) {
          statsObj[side] = teamStats;
        }
      }
      if (Object.keys(statsObj).length > 0) {
        match.statistics = statsObj;
      }
    }

    // Add lineup info from summary rosters
    if (data.rosters) {
      match.lineups = data.rosters.map((r) => ({
        side: r.homeAway,
        team: r.team?.displayName || null,
        formation: r.formation || null,
        players: (r.roster || []).map((p) => ({
          name: p.athlete?.displayName || null,
          jersey: p.jersey || null,
          position: p.position?.abbreviation || null,
          starter: p.starter || false,
          subbedIn: p.subbedIn || false,
          subbedOut: p.subbedOut || false,
        })),
      }));
    }

    // Add key events from plays
    if (data.keyEvents) {
      match.keyEvents = data.keyEvents.map((ke) => ({
        clock: ke.clock?.displayValue || null,
        text: ke.text || null,
        type: ke.type?.text || null,
        team: ke.team?.displayName || null,
        player: ke.participants?.[0]?.athlete?.displayName || null,
      }));
    }

    res.json({ source: "ESPN", match });
  } catch (err) {
    // If summary fails, try basic info from scoreboard
    try {
      const matches = await fetchLeague(leagueMeta, null, true);
      const match = matches.find((m) => m.id === matchId);
      if (match) {
        return res.json({ source: "ESPN", match });
      }
    } catch { /* ignore */ }
    res.status(500).json({ error: "Failed to fetch match details", details: err.message });
  }
});

/**
 * GET /soccer/standings/:slug
 * League table / standings for a specific league.
 */
router.get("/standings/:slug", async (req, res) => {
  const { slug } = req.params;
  const leagueMeta = LEAGUES.find((l) => l.slug === slug);
  if (!leagueMeta) {
    return res.status(404).json({
      error: `Unknown league slug: ${slug}`,
      hint: "Use /soccer/leagues to list all available leagues.",
    });
  }

  try {
    const data = await fetchStandings(slug);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch standings", details: err.message });
  }
});

export default router;
