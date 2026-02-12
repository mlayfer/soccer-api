import { Router } from "express";
import axios from "axios";

const router = Router();

// ──────────────────────────────────────────────────────────────
//  ISRAEL RAIL API
// ──────────────────────────────────────────────────────────────
const RAIL_API_BASE = "https://rail-api.rail.co.il/rjpa/api/v1";
const RAIL_API_KEY = "5e64d66cf03f4547bcac5de2de06b566"; // Public key from rail.co.il front-end

const RAIL_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "ocp-apim-subscription-key": RAIL_API_KEY,
  "Content-Type": "application/json",
  Accept: "application/json",
};

/**
 * All Israel Rail stations.
 * Key = station ID used by the rail API; value = English name.
 */
const TRAIN_STATIONS = {
  "3700": "Tel Aviv-Savidor Center",
  "3500": "Hertsliya",
  "3400": "Bet Yehoshua",
  "3300": "Netanya",
  "3310": "Netanya-Sapir",
  "3100": "Hadera-West",
  "2800": "Binyamina",
  "2820": "Caesarea-Pardes Hana",
  "2500": "Atlit",
  "2200": "Haifa-Bat Galim",
  "2100": "Haifa Center-HaShmona",
  "2300": "Haifa-Hof HaKarmel",
  "1300": "Hutsot HaMifrats",
  "1220": "HaMifrats Central Station",
  "700":  "Kiryat Hayim",
  "1400": "Kiryat Motzkin",
  "1500": "Ako",
  "1600": "Nahariya",
  "1820": "Ahihud",
  "1840": "Karmiel",
  "1240": "Yokneam-Kfar Yehoshua",
  "1250": "Migdal HaEmek-Kfar Barukh",
  "1260": "Afula R.Eitan",
  "1280": "Beit Shean",
  "8700": "Kfar Sava-Nordau",
  "8800": "Rosh HaAyin-North",
  "9200": "Hod HaSharon-Sokolov",
  "2940": "Raanana West",
  "2960": "Raanana South",
  "4100": "Bnei Brak",
  "4170": "Petah Tikva-Kiryat Arye",
  "4250": "Petah Tikva-Segula",
  "3600": "Tel Aviv-University",
  "4600": "Tel Aviv-HaShalom",
  "4900": "Tel Aviv-HaHagana",
  "4800": "Kfar Habad",
  "5000": "Lod",
  "5150": "Lod-Gane Aviv",
  "5010": "Ramla",
  "5200": "Rehovot",
  "5300": "Beer Yaakov",
  "5410": "Yavne-East",
  "9000": "Yavne-West",
  "5800": "Ashdod-Ad Halom",
  "5900": "Ashkelon",
  "9100": "Rishon LeTsiyon-HaRishonim",
  "9800": "Rishon LeTsiyon-Moshe Dayan",
  "4640": "Holon Junction",
  "4660": "Holon-Wolfson",
  "4680": "Bat Yam-Yoseftal",
  "4690": "Bat Yam-Komemiyut",
  "6300": "Bet Shemesh",
  "6500": "Jerusalem-Biblical Zoo",
  "680":  "Jerusalem-Yitzhak Navon",
  "6700": "Jerusalem-Malha",
  "6900": "Mazkeret Batya",
  "6150": "Kiryat Malakhi-Yoav",
  "7000": "Kiryat Gat",
  "7300": "Beer Sheva-North/University",
  "7320": "Beer Sheva-Center",
  "8550": "Lehavim-Rahat",
  "7500": "Dimona",
  "9600": "Sderot",
  "9650": "Netivot",
  "9700": "Ofakim",
  "300":  "Paate Modiin",
  "400":  "Modiin-Center",
  "8600": "Ben Gurion Airport",
};

/**
 * Build a reverse lookup so users can search by name fragment.
 */
const STATION_NAME_TO_ID = Object.fromEntries(
  Object.entries(TRAIN_STATIONS).map(([id, name]) => [name.toLowerCase(), id])
);

function findStationId(input) {
  if (!input) return null;
  const s = input.trim();

  // Direct ID match
  if (TRAIN_STATIONS[s]) return s;

  // Exact name match (case-insensitive)
  const lower = s.toLowerCase();
  if (STATION_NAME_TO_ID[lower]) return STATION_NAME_TO_ID[lower];

  // Partial name match
  const match = Object.entries(TRAIN_STATIONS).find(([, name]) =>
    name.toLowerCase().includes(lower)
  );
  return match ? match[0] : null;
}

/**
 * Parse a single train route from the rail API response.
 */
function parseTrainRoute(travel) {
  const trains = (travel.trains || []).map((t) => ({
    trainNumber: t.trainNumber ?? null,
    originStation: TRAIN_STATIONS[String(t.orignStation)] || String(t.orignStation),
    originStationId: String(t.orignStation),
    destinationStation: TRAIN_STATIONS[String(t.destinationStation)] || String(t.destinationStation),
    destinationStationId: String(t.destinationStation),
    departureTime: t.departureTime,
    arrivalTime: t.arrivalTime,
    originPlatform: t.originPlatform ?? null,
    destinationPlatform: t.destPlatform ?? null,
    stopStations: (t.stopStations || []).map((ss) => ({
      station: TRAIN_STATIONS[String(ss.stationId)] || String(ss.stationId),
      stationId: String(ss.stationId),
      arrivalTime: ss.arrivalTime,
      departureTime: ss.departureTime,
      platform: ss.platform ?? null,
    })),
  }));

  return {
    departureTime: trains[0]?.departureTime || null,
    arrivalTime: trains[trains.length - 1]?.arrivalTime || null,
    changes: Math.max(0, trains.length - 1),
    trains,
  };
}

// ──────────────────────────────────────────────────────────────
//  OPEN BUS STRIDE API (buses)
// ──────────────────────────────────────────────────────────────
const BUS_API_BASE = "https://open-bus-stride-api.hasadna.org.il";

/**
 * Known Israeli bus operators with English names.
 * The Open Bus API returns Hebrew names; we map them to English for convenience.
 */
const BUS_OPERATORS = {
  2: "Nateev Express",
  3: "Egged",
  4: "Egged Taavura",
  5: "Dan",
  6: "N.T.A. (NTA Metropolitan)",
  7: "Kavim Mivtzait",
  8: "G.B. Tours",
  10: "Nazareth Transport & Tourism",
  14: "Golan Regional Transport",
  15: "Metropoline",
  16: "Superbus",
  18: "Kavim",
  20: "Carmelit",
  21: "CityPass (Jerusalem Light Rail)",
  23: "Galim",
  24: "Nazareth Unbs",
  25: "Afikim",
  31: "Dan South",
  32: "Dan Beer Sheva",
  33: "Dan Bney Darom",
  34: "Tnufa",
  35: "Dan North Beersheba",
  37: "Electra Afikim",
  38: "Extra Metropoline",
  42: "TelAviv-Ramat Gan NTA Line",
  44: "TelAviv-Bnei-Brak-Petah-Tikva NTA Line",
  45: "TelAviv-Bat Yam NTA Line",
  47: "TelAviv-Tel-Aviv NTA Line",
  49: "TelAviv-Herzliya-Bnei-Brak-Petah-Tikva NTA Line",
  50: "TelAviv-Holon NTA Line",
  51: "TelAviv-Kiryat-Ono NTA Line",
  91: "Rail - Israel Railways",
  93: "Rail - Israel Railways North",
  97: "Afikim Mivtzait",
  98: "Light Rail Lines 4-5",
};

// ──────────────────────────────────────────────────────────────
//  ROUTES — TRAINS
// ──────────────────────────────────────────────────────────────

/**
 * GET /israel-transit/trains/stations
 * List all Israel Rail stations.
 */
router.get("/trains/stations", (req, res) => {
  const stations = Object.entries(TRAIN_STATIONS).map(([id, name]) => ({
    id,
    name,
  }));
  res.json({ count: stations.length, stations });
});

/**
 * GET /israel-transit/trains/routes
 * Search train routes between two stations.
 *
 * Query params:
 *   from  – station ID or name (required)
 *   to    – station ID or name (required)
 *   date  – YYYY-MM-DD (optional, defaults to today)
 *   hour  – HH:MM (optional, defaults to current hour)
 */
router.get("/trains/routes", async (req, res) => {
  const { from, to, date, hour } = req.query;

  if (!from || !to) {
    return res.status(400).json({
      error: "Missing required query params: from, to",
      example: "/israel-transit/trains/routes?from=Tel Aviv&to=Jerusalem&date=2026-02-12&hour=08:00",
    });
  }

  const fromId = findStationId(from);
  const toId = findStationId(to);

  if (!fromId) {
    return res.status(404).json({
      error: `Station not found: "${from}"`,
      hint: "Use /israel-transit/trains/stations to see all valid stations.",
    });
  }
  if (!toId) {
    return res.status(404).json({
      error: `Station not found: "${to}"`,
      hint: "Use /israel-transit/trains/stations to see all valid stations.",
    });
  }

  const now = new Date();
  const dateStr =
    date || now.toLocaleDateString("en-CA", { timeZone: "Asia/Jerusalem" }); // YYYY-MM-DD
  const hourStr =
    hour ||
    now.toLocaleTimeString("en-GB", {
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "Asia/Jerusalem",
    });

  try {
    const railRes = await axios.post(
      `${RAIL_API_BASE}/timetable/searchTrain`,
      {
        fromStation: fromId,
        toStation: toId,
        date: dateStr,
        hour: hourStr,
        scheduleType: "ByDeparture",
        systemType: "2",
        languageId: "English",
      },
      { headers: RAIL_HEADERS, timeout: 15_000 }
    );

    const result = railRes.data?.result;
    if (!result) {
      return res.json({ routes: [], count: 0, message: "No results from Israel Rail." });
    }

    const size = result.numOfResultsToShow || result.travels?.length || 0;
    const startIdx = result.startFromIndex || 0;
    const travels = (result.travels || []).slice(startIdx, startIdx + size);

    const routes = travels.map(parseTrainRoute);

    res.json({
      source: "Israel Rail (rail.co.il)",
      date: dateStr,
      from: { id: fromId, name: TRAIN_STATIONS[fromId] },
      to: { id: toId, name: TRAIN_STATIONS[toId] },
      count: routes.length,
      routes,
    });
  } catch (err) {
    console.error("[Israel Rail Error]", err?.response?.data || err.message);
    res.status(502).json({
      error: "Failed to fetch train schedule from Israel Rail",
      details: err?.response?.data || err.message,
    });
  }
});

// ──────────────────────────────────────────────────────────────
//  ROUTES — BUSES
// ──────────────────────────────────────────────────────────────

/**
 * GET /israel-transit/buses/agencies
 * List known bus operators (agencies) in Israel.
 */
router.get("/buses/agencies", async (req, res) => {
  try {
    const apiRes = await axios.get(`${BUS_API_BASE}/gtfs_agencies/list`, {
      params: { limit: 100 },
      timeout: 10_000,
    });

    const agencies = (apiRes.data || []).map((a) => ({
      operatorRef: a.operator_ref,
      nameHebrew: a.agency_name,
      name: BUS_OPERATORS[a.operator_ref] || a.agency_name,
      url: a.agency_url || null,
    }));

    res.json({ source: "Open Bus Stride API", count: agencies.length, agencies });
  } catch (err) {
    console.error("[Bus Agencies Error]", err.message);
    res.status(502).json({
      error: "Failed to fetch bus agencies",
      details: err.message,
    });
  }
});

/**
 * GET /israel-transit/buses/routes
 * Search bus routes by line number.
 *
 * Query params:
 *   line      – line/route short name, e.g. "480" (required)
 *   operator  – operator ref number (optional, e.g. 3 = Egged)
 *   date      – YYYY-MM-DD (optional, defaults to today)
 *   limit     – max results (optional, default 50)
 */
router.get("/buses/routes", async (req, res) => {
  const { line, operator, date, limit } = req.query;

  if (!line) {
    return res.status(400).json({
      error: "Missing required query param: line",
      example: "/israel-transit/buses/routes?line=480",
    });
  }

  const dateStr =
    date || new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Jerusalem" });

  const params = {
    route_short_name: line,
    date_from: dateStr,
    date_to: dateStr,
    limit: Number(limit) || 50,
    order_by: "date desc",
  };
  if (operator) params.operator_ref = operator;

  try {
    const apiRes = await axios.get(`${BUS_API_BASE}/gtfs_routes/list`, {
      params,
      timeout: 10_000,
    });

    const routes = (apiRes.data || []).map((r) => ({
      id: r.id,
      date: r.date,
      lineRef: r.line_ref,
      operatorRef: r.operator_ref,
      routeShortName: r.route_short_name,
      routeLongName: r.route_long_name,
      routeDirection: r.route_direction,
      routeAlternative: r.route_alternative,
      agencyName: BUS_OPERATORS[r.operator_ref] || r.agency_name,
      agencyNameHebrew: r.agency_name,
      routeType: r.route_type,
    }));

    res.json({
      source: "Open Bus Stride API",
      line,
      date: dateStr,
      count: routes.length,
      routes,
    });
  } catch (err) {
    console.error("[Bus Routes Error]", err.message);
    res.status(502).json({
      error: "Failed to fetch bus routes",
      details: err.message,
    });
  }
});

/**
 * GET /israel-transit/buses/rides
 * Get scheduled and real-time ride data for a bus line on a given date.
 *
 * Query params:
 *   line       – line/route short name, e.g. "480" (required)
 *   operator   – operator ref (optional)
 *   date       – YYYY-MM-DD (optional, defaults to today)
 *   limit      – max results (optional, default 50)
 */
router.get("/buses/rides", async (req, res) => {
  const { line, operator, date, limit } = req.query;

  if (!line) {
    return res.status(400).json({
      error: "Missing required query param: line",
      example: "/israel-transit/buses/rides?line=480",
    });
  }

  const dateStr =
    date || new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Jerusalem" });

  const params = {
    "gtfs_route__route_short_name": line,
    "gtfs_route__date_from": dateStr,
    "gtfs_route__date_to": dateStr,
    limit: Number(limit) || 50,
    order_by: "gtfs_ride__start_time_from asc",
  };
  if (operator) params["gtfs_route__operator_refs"] = operator;

  try {
    const apiRes = await axios.get(`${BUS_API_BASE}/siri_rides/list`, {
      params,
      timeout: 15_000,
    });

    const rides = (apiRes.data || []).map((r) => ({
      siriRideId: r.id,
      journeyRef: r.journey_ref,
      scheduledStartTime: r.scheduled_start_time,
      vehicleRef: r.vehicle_ref,
      siriRoute: r.siri_route
        ? {
            lineRef: r.siri_route.line_ref,
            operatorRef: r.siri_route.operator_ref,
          }
        : null,
      gtfsRide: r.gtfs_ride
        ? {
            gtfsRouteId: r.gtfs_ride.gtfs_route_id,
            startTime: r.gtfs_ride.start_time,
            journeyRef: r.gtfs_ride.journey_ref,
          }
        : null,
      gtfsRoute: r.gtfs_route
        ? {
            routeShortName: r.gtfs_route.route_short_name,
            routeLongName: r.gtfs_route.route_long_name,
            agencyName: BUS_OPERATORS[r.siri_route?.operator_ref] || r.gtfs_route.agency_name,
            agencyNameHebrew: r.gtfs_route.agency_name,
            routeDirection: r.gtfs_route.route_direction,
          }
        : null,
    }));

    res.json({
      source: "Open Bus Stride API",
      line,
      date: dateStr,
      count: rides.length,
      rides,
    });
  } catch (err) {
    console.error("[Bus Rides Error]", err.message);
    res.status(502).json({
      error: "Failed to fetch bus rides",
      details: err.message,
    });
  }
});

export default router;
