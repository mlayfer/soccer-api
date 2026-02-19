import { Router } from "express";
import axios from "axios";
import * as cheerio from "cheerio";

const router = Router();

// ──────────────────────────────────────────────────────────────
//  INSTAGRAM — scraping (profile, stories by username)
//  Note: Instagram may show login wall; stories often need session.
// ──────────────────────────────────────────────────────────────

const IG_BASE = "https://www.instagram.com";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const defaultHeaders = {
  "User-Agent": UA,
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Cache-Control": "no-cache",
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "none",
  "Upgrade-Insecure-Requests": "1",
};

const RAPIDAPI_KEY = process.env.INSTAGRAM_RAPIDAPI_KEY || process.env.RAPIDAPI_KEY;
const RAPIDAPI_HOST = process.env.INSTAGRAM_RAPIDAPI_HOST || process.env.RAPIDAPI_INSTAGRAM_HOST;

// Session: per-request header X-Instagram-Session (for RapidAPI/BYOA) or env INSTAGRAM_SESSION_COOKIE (dev).
function getRequestConfig(req = null) {
  const config = { headers: { ...defaultHeaders }, timeout: 15_000, maxRedirects: 3 };
  const fromHeader = req?.get?.("x-instagram-session") ?? req?.headers?.["x-instagram-session"];
  const session = fromHeader ?? process.env.INSTAGRAM_SESSION_COOKIE;
  if (session && typeof session === "string") {
    config.headers.Cookie = session.includes("sessionid=") ? session : `sessionid=${session.trim()}`;
  }
  return config;
}

const IG_APP_ID = "936619743392459";
const USER_AGENTS = [
  UA,
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
  "Instagram 269.0.0.18.75 (iPhone14,2; iOS 16_0; en_US; en; scale=3.00; 1170x2532; 481736869)",
];

/** Fetch profile + reel without cookie: try __a=1, AJAX headers, embed, multiple UAs. */
async function fetchWithoutCookie(username) {
  const encoded = encodeURIComponent(username);
  const opts = { timeout: 12_000, maxRedirects: 3, validateStatus: () => true };

  try {
    const r1 = await axios.get(`${IG_BASE}/${encoded}/?__a=1&__d=dis`, {
      ...opts,
      headers: { ...defaultHeaders, Accept: "application/json", "X-Requested-With": "XMLHttpRequest", "X-IG-App-ID": IG_APP_ID, Referer: `${IG_BASE}/` },
    });
    if (r1.status === 200 && r1.data && typeof r1.data === "object" && (r1.data.graphql?.user || r1.data.user)) {
      const profile = normalizeProfile(r1.data, username);
      if (profile) {
        const reel = r1.data.graphql?.user?.reel ?? r1.data.user?.reel ?? r1.data.reel;
        const reelNorm = reel ? normalizeReel(reel?.items ? { items: reel.items } : reel, username) : null;
        return { profile, reel: reelNorm };
      }
    }
  } catch (_) {}

  try {
    const r2 = await axios.get(`${IG_BASE}/${encoded}/`, {
      ...opts,
      headers: { ...defaultHeaders, Accept: "application/json", "X-Requested-With": "XMLHttpRequest", "X-IG-App-ID": IG_APP_ID, Referer: `${IG_BASE}/` },
    });
    if (r2.status === 200 && r2.data && typeof r2.data === "object") {
      const profile = normalizeProfile(r2.data, username);
      if (profile) {
        const reel = findInObject(r2.data, "reel_media") ?? findInObject(r2.data, "reel");
        const reelNorm = reel ? normalizeReel(Array.isArray(reel) ? { items: reel } : reel, username) : null;
        return { profile, reel: reelNorm };
      }
    }
  } catch (_) {}

  try {
    const r3 = await axios.get(`${IG_BASE}/${encoded}/embed/`, { ...opts, headers: defaultHeaders });
    if (r3.status === 200 && typeof r3.data === "string" && !r3.data.includes("login_required") && !r3.data.includes("login_and_signup")) {
      const { profile: pData, reel: rData } = extractProfileData(r3.data);
      const profile = pData ? normalizeProfile(pData, username) : null;
      if (profile) {
        let reelNorm = rData ? normalizeReel(rData, username) : null;
        if (!reelNorm && pData) {
          const user = findInObject(pData, "user");
          const rm = user?.reel_media ?? user?.reel;
          if (rm) reelNorm = normalizeReel(Array.isArray(rm) ? { items: rm } : rm, username);
        }
        return { profile, reel: reelNorm };
      }
    }
  } catch (_) {}

  for (const ua of USER_AGENTS) {
    try {
      const r4 = await axios.get(`${IG_BASE}/${encoded}/`, { ...opts, headers: { ...defaultHeaders, "User-Agent": ua } });
      if (r4.status !== 200 || typeof r4.data !== "string") continue;
      const html = r4.data;
      if (html.includes("login_required") || html.includes("login_and_signup_page") || html.includes("Login • Instagram")) continue;
      const { profile: pData, reel: rData } = extractProfileData(html);
      const profile = pData ? normalizeProfile(pData, username) : null;
      if (profile) {
        let reelNorm = rData ? normalizeReel(rData, username) : null;
        if (!reelNorm && pData) {
          const user = findInObject(pData, "user");
          const rm = user?.reel_media ?? user?.reel;
          if (rm) reelNorm = normalizeReel(Array.isArray(rm) ? { items: rm } : rm, username);
        }
        return { profile, reel: reelNorm };
      }
    } catch (_) {}
  }
  return null;
}

const STORY_QUERY_HASH = "303a4ae99711322310f25250d988f3b7";

/** Extract numeric user id from profile page HTML (no cookie). */
function extractUserIdFromHtml(html, username) {
  if (!html || typeof html !== "string") return null;
  const m1 = html.match(/profilePage_(\d+)/);
  if (m1) return m1[1];
  const m2 = html.match(/"id"\s*:\s*"(\d+)"[\s\S]{0,200}"username"\s*:\s*"[^"]*"/);
  if (m2) return m2[1];
  const m3 = html.match(/"username"\s*:\s*"([^"]+)"[\s\S]{0,200}"id"\s*:\s*"(\d+)"/);
  if (m3 && m3[1].toLowerCase() === username.toLowerCase()) return m3[2];
  const m4 = html.match(/"pk"\s*:\s*"(\d+)"/);
  if (m4) return m4[1];
  const $ = cheerio.load(html, { decodeEntities: false });
  let foundId = null;
  $('script[type="application/json"]').each((_, el) => {
    const content = $(el).html() || "";
    if (content.length < 500 || !content.includes(username)) return;
    try {
      const data = JSON.parse(content);
      const str = JSON.stringify(data);
      const idMatch = str.match(new RegExp(`"username"\\s*:\\s*"${username.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"[\\s\\S]{0,500}?"id"\\s*:\\s*"?(\d+)"?`));
      if (idMatch) foundId = idMatch[1];
      if (!foundId) {
        const found = findInObject(data, "id");
        if (found && /^\d+$/.test(String(found))) foundId = String(found);
      }
    } catch (_) {}
  });
  return foundId;
}

/** Fetch story reel via Instagram GraphQL (no cookie). Needs userId from profile. */
async function fetchReelViaGraphQL(userId, username) {
  if (!userId) return null;
  const variables = {
    reel_ids: [String(userId)],
    tag_names: [],
    location_ids: [],
    highlight_reel_ids: [],
    precomposed_overlay: false,
    show_story_viewer_list: false,
    story_viewer_fetch_count: 50,
  };
  const url = `${IG_BASE}/graphql/query/?query_hash=${STORY_QUERY_HASH}&variables=${encodeURIComponent(JSON.stringify(variables))}`;
  try {
    const res = await axios.get(url, {
      timeout: 12_000,
      validateStatus: () => true,
      maxRedirects: 3,
      headers: {
        ...defaultHeaders,
        Accept: "*/*",
        "X-Requested-With": "XMLHttpRequest",
        "X-IG-App-ID": IG_APP_ID,
        "X-ASBD-ID": "129477",
        Referer: `${IG_BASE}/`,
        "Sec-Fetch-Dest": "empty",
        "Sec-Fetch-Mode": "cors",
      },
    });
    if (res.status !== 200 || !res.data || typeof res.data !== "object") return null;
    const data = res.data;
    const reels = data?.data?.reels_media ?? data?.reels_media ?? findInObject(data, "reels_media");
    if (!Array.isArray(reels) || reels.length === 0) return null;
    const reel = reels[0];
    const items = reel?.items ?? reel?.media?.items ?? [];
    const stories = items.map((item) => {
      const isVideo = !!(item.video_url ?? item.media_type === 2);
      const url = item.video_url ?? item.display_url ?? item.image_versions2?.candidates?.[0]?.url ?? item.display_src ?? item.src;
      const thumbnail = item.display_url ?? item.image_versions2?.candidates?.[0]?.url ?? url;
      const timestamp = item.taken_at ?? item.timestamp ?? item.taken_at_timestamp;
      return {
        id: item.id ?? item.pk,
        url: url ?? null,
        thumbnail: thumbnail ?? null,
        isVideo,
        timestamp: timestamp ?? null,
        expiresAt: item.expiring_at ?? (timestamp ? timestamp + 86400 : null),
      };
    }).filter((s) => s.url);
    return { username, userId, count: stories.length, stories };
  } catch (_) {
    return null;
  }
}

/**
 * Try to fetch profile + stories via RapidAPI (no cookie needed).
 * Set INSTAGRAM_RAPIDAPI_KEY and INSTAGRAM_RAPIDAPI_HOST to use.
 * Returns { profile, stories } or null on failure.
 */
async function fetchViaRapidApi(username) {
  if (!RAPIDAPI_KEY || !RAPIDAPI_HOST) return null;
  const base = `https://${RAPIDAPI_HOST.replace(/^https?:\/\//, "").split("/")[0]}`;
  const headers = {
    "X-RapidAPI-Key": RAPIDAPI_KEY,
    "X-RapidAPI-Host": RAPIDAPI_HOST.split("/")[0],
  };
  try {
    // Common patterns: /v1/user?username=, /user?username=, /profile?username=
    const urlsToTry = [
      `${base}/v1/user?username=${encodeURIComponent(username)}`,
      `${base}/v1/profile?username=${encodeURIComponent(username)}`,
      `${base}/user?username=${encodeURIComponent(username)}`,
      `${base}/profile?username=${encodeURIComponent(username)}`,
    ];
    let data = null;
    for (const url of urlsToTry) {
      const res = await axios.get(url, { headers, timeout: 12_000, validateStatus: () => true });
      if (res.status === 200 && res.data) {
        data = res.data;
        break;
      }
    }
    if (!data) return null;

    const user = data.user ?? data.data?.user ?? data.profile ?? data.data?.profile ?? data;
    const profile = normalizeRapidApiProfile(user, username);
    const storiesRaw = data.stories ?? data.data?.stories ?? user?.stories ?? data.reel?.items ?? user?.reel_media ?? [];
    const stories = normalizeRapidApiStories(storiesRaw, username);
    return { profile, stories };
  } catch (_) {
    return null;
  }
}

function normalizeRapidApiProfile(user, username) {
  if (!user || typeof user !== "object") return null;
  return {
    id: user.id ?? user.pk ?? null,
    username: user.username ?? username,
    fullName: user.full_name ?? user.fullName ?? user.name ?? "",
    biography: user.biography ?? user.bio ?? "",
    externalUrl: user.external_url ?? user.external_lynx_url ?? null,
    followers: user.edge_followed_by?.count ?? user.follower_count ?? user.followers ?? null,
    following: user.edge_follow?.count ?? user.following_count ?? user.following ?? null,
    postsCount: user.edge_owner_to_timeline_media?.count ?? user.media_count ?? user.posts_count ?? null,
    profilePicUrl: user.profile_pic_url_hd ?? user.profile_pic_url ?? user.profilePicture ?? null,
    isPrivate: !!(user.is_private ?? user.isPrivate),
    isVerified: !!(user.is_verified ?? user.verified),
  };
}

function normalizeRapidApiStories(storiesRaw, username) {
  const items = Array.isArray(storiesRaw) ? storiesRaw : storiesRaw?.items ?? [];
  const stories = items.map((item) => {
    const url = item.video_url ?? item.display_url ?? item.url ?? item.image_versions2?.candidates?.[0]?.url ?? item.src;
    const thumb = item.display_url ?? item.thumbnail ?? url;
    return {
      id: item.id ?? item.pk,
      url: url ?? null,
      thumbnail: thumb ?? null,
      isVideo: !!(item.video_url ?? item.media_type === 2),
      timestamp: item.taken_at ?? item.timestamp ?? null,
      expiresAt: item.expiring_at ?? null,
    };
  }).filter((s) => s.url);
  return { username, count: stories.length, stories };
}

/**
 * Extract JSON from Instagram profile page scripts.
 * Looks for embedded data in script tags (e.g. xdt_api, profilePage, reel).
 */
function extractProfileData(html) {
  const $ = cheerio.load(html, { decodeEntities: false });
  const scripts = $('script[type="application/json"]').toArray();
  let profile = null;
  let reel = null;

  for (const el of scripts) {
    const content = $(el).html() || "";
    if (!content.trim()) continue;
    try {
      const data = JSON.parse(content);
      // React/Instagram often nest: require("...").r(d). then d has xdt_api__v1 or similar
      const str = JSON.stringify(data);
      if (str.includes("profilePage") || str.includes("xdt_api__v1__media__web_info")) {
        profile = data;
      }
      if (str.includes("reel") && (str.includes("reel_media") || str.includes("items"))) {
        reel = data;
      }
      // Single big blob
      if (data?.xdt_api__v1__media__web_info?.xdt_api__v1__media__web_info__user) {
        profile = data;
      }
      if (data?.xdt_api__v1__media__reel__user) {
        reel = data;
      }
    } catch (_) {}
  }

  // Also try inline script (older pattern)
  $('script:not([type="application/json"])').each((_, el) => {
    const content = $(el).html() || "";
    const match = content.match(/window\._sharedData\s*=\s*(\{[\s\S]*?\});?\s*(?:<\/script>|$)/m);
    if (match) {
      try {
        profile = JSON.parse(match[1]);
      } catch (_) {}
    }
    const requireMatch = content.match(/require\s*\(\s*["']ScheduledServerJS["']\)\s*\.\s*\w+\s*\(\s*(\{[\s\S]*?\})\s*\)/);
    if (requireMatch) {
      try {
        const parsed = JSON.parse(requireMatch[1]);
        if (parsed?.require) profile = parsed;
      } catch (_) {}
    }
  });

  return { profile, reel };
}

/**
 * Extract story items from /stories/username/ page HTML (when logged in).
 */
function extractReelFromStoriesPage(html, username) {
  const $ = cheerio.load(html, { decodeEntities: false });
  let items = [];
  $('script[type="application/json"]').each((_, el) => {
    const content = $(el).html() || "";
    if (content.length < 500) return;
    try {
      const data = JSON.parse(content);
      const str = JSON.stringify(data);
      if (!str.includes("display_url") && !str.includes("video_url")) return;
      const deepItems = (o) => {
        if (!o || typeof o !== "object") return;
        if (Array.isArray(o) && o.length > 0) {
          const first = o[0];
          if (first && (first.display_url || first.video_url || first.image_versions2)) {
            items = o;
            return;
          }
        }
        if (o.items && Array.isArray(o.items)) {
          items = o.items;
          return;
        }
        for (const v of Object.values(o)) {
          if (items.length) return;
          deepItems(v);
        }
      };
      deepItems(data);
    } catch (_) {}
  });
  if (items.length === 0) {
    const itemsMatch = html.match(/"items":\s*(\[[\s\S]*?"(?:display_url|video_url)"[\s\S]*?\])/);
    if (itemsMatch) {
      try {
        items = JSON.parse(itemsMatch[1]);
      } catch (_) {}
    }
  }
  if (items.length === 0) return null;
  return { items, user: { username } };
}

/**
 * Fetch stories using Puppeteer (real browser). Captures the API response that contains reel media.
 * Requires session cookie. Returns { username, count, stories } or null.
 */
async function fetchStoriesWithBrowser(username, sessionCookie) {
  let browser;
  try {
    const puppeteer = await import("puppeteer").then((m) => m.default).catch(() => null);
    if (!puppeteer) return null;

    browser = await puppeteer.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    });
    const page = await browser.newPage();
    await page.setUserAgent(UA);
    await page.setCookie({
      name: "sessionid",
      value: sessionCookie.includes("sessionid=") ? sessionCookie.replace(/^sessionid=/, "").trim() : sessionCookie.trim(),
      domain: ".instagram.com",
      path: "/",
    });

    let captured = null;
    const onResponse = async (response) => {
      try {
        const url = response.url();
        if (!url.includes("instagram.com") || !response.ok()) return;
        const ct = response.headers()["content-type"] || "";
        if (!ct.includes("application/json")) return;
        const text = await response.text();
        if (!text || (!text.includes("display_url") && !text.includes("video_url") && !text.includes("image_versions2"))) return;
        const data = JSON.parse(text);
        const str = JSON.stringify(data);
        if (!str.includes("display_url") && !str.includes("video_url") && !str.includes("image_versions2")) return;
        const reels = data?.reels_media ?? data?.data?.reels_media ?? findInObject(data, "reels_media");
        let items = data?.items ?? findInObject(data, "items");
        if (Array.isArray(reels) && reels.length > 0 && reels[0].items) {
          captured = reels[0].items;
          return;
        }
        if (Array.isArray(items) && items.length > 0 && (items[0].display_url || items[0].video_url)) {
          captured = items;
          return;
        }
        const edges = data?.data?.xdt_api__v1__feed__reels_media__connection?.edges ?? findInObject(data, "edges");
        if (Array.isArray(edges) && edges.length > 0) {
          const nodes = edges.map((e) => e.node || e).filter(Boolean);
          const withMedia = nodes.filter((n) => n.image_versions2 || n.video_versions || n.display_url || n.video_url);
          if (withMedia.length > 0) captured = withMedia;
          else {
            for (const n of nodes) {
              const media = n.media;
              if (Array.isArray(media) && media.length > 0 && media[0] && (media[0].image_versions2 || media[0].video_versions || media[0].display_url || media[0].video_url)) {
                captured = media;
                break;
              }
            }
          }
          if (captured && typeof username === "string") {
            const name = (captured[0]?.user?.username ?? captured[0]?.owner?.username ?? "").toLowerCase();
            if (name && name !== username.toLowerCase()) captured = null;
          }
        }
        if (!captured) {
          const arr = findReelItemsArray(data);
          if (Array.isArray(arr) && arr.length > 0) {
            const owner = (arr[0]?.user?.username ?? arr[0]?.owner?.username ?? "").toLowerCase();
            if (!owner || owner === username.toLowerCase()) captured = arr;
          }
        }
      } catch (_) {}
    };
    page.on("response", onResponse);

    await page.goto(`${IG_BASE}/stories/${encodeURIComponent(username)}/`, {
      waitUntil: "networkidle2",
      timeout: 20000,
    });
    await new Promise((r) => setTimeout(r, 3000));
    if (!captured && page) {
      const reelFromPage = await page.evaluate((requestedUser) => {
        const requested = (requestedUser || "").toLowerCase();
        const scripts = document.querySelectorAll('script[type="application/json"]');
        const hasMedia = (item) => item && typeof item === "object" && (item.display_url || item.video_url || item.image_versions2 || item.display_uri);
        const findReelArray = (o) => {
          if (Array.isArray(o) && o.length > 0) {
            const first = o[0];
            if (hasMedia(first)) {
              const u = (first.user?.username || first.owner?.username || "").toLowerCase();
              if (u && u === requested) return o;
            }
          }
          if (o && typeof o === "object") {
            for (const v of Object.values(o)) {
              const t = findReelArray(v);
              if (t) return t;
            }
          }
          return null;
        };
        const findReelsMedia = (o) => {
          if (!o || typeof o !== "object") return null;
          if (Object.prototype.hasOwnProperty.call(o, "reels_media")) {
            const rm = o.reels_media;
            if (Array.isArray(rm) && rm.length > 0) {
              for (const reel of rm) {
                if (reel && reel.items && Array.isArray(reel.items) && reel.items.length > 0) {
                  const u = (reel.user?.username || reel.owner?.username || "").toLowerCase();
                  if (u === requested) return reel.items;
                }
              }
            }
          }
          for (const v of Object.values(o)) {
            const t = findReelsMedia(v);
            if (t) return t;
          }
          return null;
        };
        const scriptContents = [];
        for (const s of scripts) {
          const raw = s.textContent || "";
          if (!raw.includes("reels_media") && !raw.includes("display_url") && !raw.includes("image_versions2")) continue;
          scriptContents.push(raw);
        }
        const withUser = scriptContents.filter((raw) => raw.toLowerCase().includes(requested));
        const toSearch = withUser.length > 0 ? withUser : scriptContents;
        for (const raw of toSearch) {
          try {
            const d = JSON.parse(raw);
            let arr = findReelsMedia(d);
            if (!arr) arr = findReelArray(d);
            if (arr && arr.length) return arr;
          } catch (_) {}
        }
        return null;
      }, username).catch(() => null);
      if (reelFromPage && reelFromPage.length) captured = reelFromPage;
    }

    await browser.close();
    browser = null;

    if (!captured || !captured.length) return null;
    const stories = captured.map((item) => {
      const url = item.video_url ?? item.display_url ?? item.display_uri ?? item.image_versions2?.candidates?.[0]?.url ?? item.display_src ?? item.src;
      const thumb = item.display_url ?? item.display_uri ?? item.image_versions2?.candidates?.[0]?.url ?? url;
      return {
        id: item.id ?? item.pk,
        url: url ?? null,
        thumbnail: thumb ?? null,
        isVideo: !!(item.video_url ?? item.media_type === 2),
        timestamp: item.taken_at ?? item.timestamp ?? null,
        expiresAt: item.expiring_at ?? null,
      };
    }).filter((s) => s.url);
    return { username, count: stories.length, stories };
  } catch (err) {
    console.error("Puppeteer stories error:", err.message);
    if (browser) await browser.close().catch(() => {});
    return null;
  }
}

/**
 * Recursively find a value by key in nested objects (for varying Instagram structures).
 */
function findInObject(obj, key) {
  if (!obj || typeof obj !== "object") return undefined;
  if (Object.prototype.hasOwnProperty.call(obj, key)) return obj[key];
  for (const v of Object.values(obj)) {
    const found = findInObject(v, key);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** Find first array that looks like reel/story items (have media URLs). */
function findReelItemsArray(obj) {
  if (!obj || typeof obj !== "object") return undefined;
  if (Array.isArray(obj) && obj.length > 0) {
    const first = obj[0];
    if (first && typeof first === "object" && (first.image_versions2 || first.video_versions || first.display_url || first.video_url)) return obj;
  }
  for (const v of Object.values(obj)) {
    const found = findReelItemsArray(v);
    if (found !== undefined) return found;
  }
  return undefined;
}

/**
 * Normalize user profile from various embedded shapes.
 */
function normalizeProfile(profileData, username) {
  const user = findInObject(profileData, "user") ?? findInObject(profileData, "graphql")?.user;
  if (!user) return null;

  const id = user.id ?? user.pk;
  const biography = user.biography ?? user.bio ?? "";
  const externalUrl = user.external_url ?? user.external_lynx_url ?? null;
  const followers = user.edge_followed_by?.count ?? user.follower_count ?? user.followers?.count;
  const following = user.edge_follow?.count ?? user.following_count ?? user.following?.count;
  const fullName = user.full_name ?? user.fullName ?? "";
  const isPrivate = user.is_private ?? user.isPrivate ?? false;
  const isVerified = user.is_verified ?? user.verified ?? false;
  const profilePic = user.profile_pic_url_hd ?? user.profile_pic_url ?? user.profile_pic_url_hd ?? user.hd_profile_pic_url_info?.url ?? null;
  const postsCount = user.edge_owner_to_timeline_media?.count ?? user.media_count ?? user.edge_owner_to_timeline_media?.count;

  return {
    id,
    username: user.username ?? username,
    fullName,
    biography,
    externalUrl,
    followers: followers ?? null,
    following: following ?? null,
    postsCount: postsCount ?? null,
    profilePicUrl: profilePic ?? null,
    isPrivate: !!isPrivate,
    isVerified: !!isVerified,
  };
}

/**
 * Normalize story reel from embedded data.
 */
function normalizeReel(reelData, username) {
  const reel = findInObject(reelData, "reel") ?? findInObject(reelData, "items");
  const user = findInObject(reelData, "user");
  const items = Array.isArray(reel)
    ? reel
    : reel?.items ?? reel?.media?.items ?? findInObject(reelData, "items") ?? [];

  const stories = items.map((item) => {
    const isVideo = item.video_url ?? item.__typename === "GraphVideo" ?? item.media_type === 2;
    const url = item.video_url ?? item.display_url ?? item.image_versions2?.candidates?.[0]?.url ?? item.display_src ?? item.src;
    const thumbnail = item.display_url ?? item.image_versions2?.candidates?.[0]?.url ?? url;
    const timestamp = item.taken_at ?? item.timestamp ?? item.taken_at_timestamp;
    return {
      id: item.id ?? item.pk,
      url: url ?? null,
      thumbnail: thumbnail ?? null,
      isVideo: !!isVideo,
      timestamp: timestamp ?? null,
      expiresAt: item.expiring_at ?? (timestamp ? timestamp + 86400 : null),
    };
  }).filter((s) => s.url);

  return {
    username: user?.username ?? username,
    userId: user?.id ?? user?.pk ?? null,
    count: stories.length,
    stories,
  };
}

// ──── GET /instagram/profile/:username ───────────────────────

router.get("/profile/:username", async (req, res) => {
  try {
    const username = (req.params.username || "").trim().replace(/^@/, "");
    if (!username) {
      return res.status(400).json({ error: "Username is required" });
    }

    const noCookie = await fetchWithoutCookie(username);
    if (noCookie?.profile) {
      let profile = noCookie.profile;
      if (!profile.id) {
        try {
          const profilePage = await axios.get(`${IG_BASE}/${encodeURIComponent(username)}/`, {
            headers: defaultHeaders,
            timeout: 10_000,
            validateStatus: () => true,
          });
          if (typeof profilePage.data === "string") {
            const uid = extractUserIdFromHtml(profilePage.data, username);
            if (uid) profile = { ...profile, id: uid };
          }
        } catch (_) {}
      }
      return res.json({ ok: true, profile, source: "scrape_no_cookie" });
    }
    const rapid = await fetchViaRapidApi(username);
    if (rapid?.profile) {
      return res.json({ ok: true, profile: rapid.profile, source: "rapidapi" });
    }

    const url = `${IG_BASE}/${encodeURIComponent(username)}/`;
    const { data: html, status } = await axios.get(url, {
      ...getRequestConfig(req),
      validateStatus: () => true,
    });

    if (status === 404) {
      return res.status(404).json({ error: "User not found", username });
    }

    const isLoginWall =
      typeof html === "string" &&
      (html.includes('"login_required"') ||
        html.includes("login_and_signup_page") ||
        html.includes("Login • Instagram"));

    if (isLoginWall) {
      return res.status(401).json({
        error: "Instagram login required",
        message:
          "Send your Instagram session in header X-Instagram-Session (value: sessionid=... from browser cookies). We do not store it.",
        username,
      });
    }

    const { profile } = extractProfileData(html);
    const normalized = profile ? normalizeProfile(profile, username) : null;

    if (!normalized) {
      return res.status(502).json({
        error: "Could not parse profile data",
        message:
          "Instagram page structure may have changed or profile is restricted. Try RapidAPI: set INSTAGRAM_RAPIDAPI_KEY and INSTAGRAM_RAPIDAPI_HOST.",
        username,
      });
    }

    res.json({
      ok: true,
      profile: normalized,
      source: "scrape",
    });
  } catch (err) {
    console.error("Instagram profile error:", err.message);
    const status = err.response?.status ?? 502;
    res.status(status).json({
      error: "Failed to fetch profile",
      details: err.message,
    });
  }
});

// ──── GET /instagram/stories/:username ─────────────────────────
//  Priority: stories by username. May require session cookie.

router.get("/stories/:username", async (req, res) => {
  try {
    const username = (req.params.username || "").trim().replace(/^@/, "");
    if (!username) {
      return res.status(400).json({ error: "Username is required" });
    }

    const noCookie = await fetchWithoutCookie(username);
    const hasSession = !!(req?.get?.("x-instagram-session") ?? req?.headers?.["x-instagram-session"]) || !!process.env.INSTAGRAM_SESSION_COOKIE;
    if (noCookie?.profile && (noCookie.reel?.count > 0 || !hasSession)) {
      let stories = noCookie.reel ?? { username, count: 0, stories: [] };
      if (stories.count > 0) {
        return res.json({
          ok: true,
          username: stories.username ?? username,
          userId: noCookie.profile?.id ?? null,
          count: stories.count,
          stories: stories.stories ?? [],
          source: "scrape_no_cookie",
        });
      }
      if (!hasSession) {
        const userId = noCookie.profile?.id ?? null;
        let uid = userId;
        if (!uid) {
          try {
            const profilePage = await axios.get(`${IG_BASE}/${encodeURIComponent(username)}/`, {
              headers: defaultHeaders,
              timeout: 10_000,
              validateStatus: () => true,
            });
            if (typeof profilePage.data === "string") uid = extractUserIdFromHtml(profilePage.data, username);
          } catch (_) {}
        }
        if (uid) {
          const graphqlReel = await fetchReelViaGraphQL(uid, username);
          if (graphqlReel && graphqlReel.count > 0) {
            return res.json({
              ok: true,
              username: graphqlReel.username,
              userId: graphqlReel.userId ?? uid,
              count: graphqlReel.count,
              stories: graphqlReel.stories,
              source: "scrape_no_cookie_graphql",
            });
          }
        }
        return res.json({
          ok: true,
          username,
          userId: noCookie.profile?.id ?? null,
          count: 0,
          stories: [],
          source: "scrape_no_cookie",
          message: "No stories without session. Send X-Instagram-Session header with your sessionid for stories.",
        });
      }
    }
    const rapid = await fetchViaRapidApi(username);
    if (rapid?.profile) {
      const stories = rapid.stories ?? { username, count: 0, stories: [] };
      return res.json({
        ok: true,
        username: stories.username,
        userId: rapid.profile?.id ?? null,
        count: stories.count,
        stories: stories.stories ?? [],
        source: "rapidapi",
      });
    }

    const url = `${IG_BASE}/${encodeURIComponent(username)}/`;
    const { data: html, status } = await axios.get(url, {
      ...getRequestConfig(req),
      validateStatus: () => true,
    });

    if (status === 404) {
      return res.status(404).json({ error: "User not found", username });
    }

    const isLoginWall =
      typeof html === "string" &&
      (html.includes('"login_required"') ||
        html.includes("login_and_signup_page") ||
        html.includes("Login • Instagram"));

    if (isLoginWall) {
      return res.status(401).json({
        error: "Login required for stories",
        message:
          "Send your Instagram session in header X-Instagram-Session (value: sessionid=... from browser cookies). We do not store it.",
        username,
      });
    }

    const { profile, reel } = extractProfileData(html);

    let reelPayload = reel;
    if (!reelPayload && profile) {
      const user = findInObject(profile, "user");
      const reelMedia = user?.reel_media ?? user?.reel ?? findInObject(profile, "reel_media");
      if (reelMedia) reelPayload = { items: Array.isArray(reelMedia) ? reelMedia : reelMedia?.items ?? [] };
    }

    if (!reelPayload || (reelPayload?.items && reelPayload.items.length === 0)) {
      const storiesUrl = `${IG_BASE}/stories/${encodeURIComponent(username)}/`;
      try {
        const storiesRes = await axios.get(storiesUrl, {
          ...getRequestConfig(req),
          timeout: 12_000,
          validateStatus: () => true,
        });
        if (storiesRes.status === 200 && typeof storiesRes.data === "string") {
          const storiesHtml = storiesRes.data;
          if (!storiesHtml.includes("login_required")) {
            const parsed = extractReelFromStoriesPage(storiesHtml, username);
            if (parsed && parsed.items?.length > 0) reelPayload = parsed;
          }
        }
      } catch (_) {}
    }

    let normalized = reelPayload ? normalizeReel(reelPayload, username) : null;

    if (!normalized || normalized.count === 0) {
      const session = req?.get?.("x-instagram-session") ?? req?.headers?.["x-instagram-session"] ?? process.env.INSTAGRAM_SESSION_COOKIE;
      if (session) {
        const browserStories = await fetchStoriesWithBrowser(username, session);
        if (browserStories && browserStories.count > 0) {
          return res.json({
            ok: true,
            username: browserStories.username,
            userId: null,
            count: browserStories.count,
            stories: browserStories.stories,
            source: "browser",
          });
        }
      }
      return res.json({
        ok: true,
        username,
        count: 0,
        stories: [],
        message:
          "No stories in response. With session: try X-Instagram-Session (sessionid from instagram.com cookies). Ensure Puppeteer is installed (npm install puppeteer) for browser-based story fetch.",
      });
    }

    res.json({
      ok: true,
      username: normalized.username,
      userId: normalized.userId,
      count: normalized.count,
      stories: normalized.stories,
      source: "scrape",
    });
  } catch (err) {
    console.error("Instagram stories error:", err.message);
    const status = err.response?.status ?? 502;
    res.status(status).json({
      error: "Failed to fetch stories",
      details: err.message,
    });
  }
});

// ──── GET /instagram/user/:username ───────────────────────────
//  Combined: profile + stories in one call.

router.get("/user/:username", async (req, res) => {
  try {
    const username = (req.params.username || "").trim().replace(/^@/, "");
    if (!username) {
      return res.status(400).json({ error: "Username is required" });
    }

    const noCookie = await fetchWithoutCookie(username);
    if (noCookie?.profile) {
      const stories = noCookie.reel ?? { count: 0, stories: [] };
      return res.json({
        ok: true,
        username,
        profile: noCookie.profile,
        stories: { count: stories.count ?? 0, items: stories.stories ?? [] },
        source: "scrape_no_cookie",
      });
    }
    const rapid = await fetchViaRapidApi(username);
    if (rapid?.profile) {
      return res.json({
        ok: true,
        username,
        profile: rapid.profile,
        stories: {
          count: rapid.stories?.count ?? 0,
          items: rapid.stories?.stories ?? [],
        },
        source: "rapidapi",
      });
    }

    const url = `${IG_BASE}/${encodeURIComponent(username)}/`;
    const { data: html, status } = await axios.get(url, {
      ...getRequestConfig(req),
      validateStatus: () => true,
    });

    if (status === 404) {
      return res.status(404).json({ error: "User not found", username });
    }

    const isLoginWall =
      typeof html === "string" &&
      (html.includes('"login_required"') ||
        html.includes("login_and_signup_page") ||
        html.includes("Login • Instagram"));

    if (isLoginWall) {
      return res.status(401).json({
        error: "Instagram login required",
        message:
          "Send your Instagram session in header X-Instagram-Session (value: sessionid=... from browser cookies). We do not store it.",
        username,
      });
    }

    const { profile, reel } = extractProfileData(html);
    const profileNormalized = profile ? normalizeProfile(profile, username) : null;

    let reelPayload = reel;
    if (!reelPayload && profile) {
      const user = findInObject(profile, "user");
      const reelMedia = user?.reel_media ?? user?.reel ?? findInObject(profile, "reel_media");
      if (reelMedia) reelPayload = { items: Array.isArray(reelMedia) ? reelMedia : reelMedia?.items ?? [] };
    }
    const storiesNormalized = reelPayload ? normalizeReel(reelPayload, username) : { username, count: 0, stories: [] };

    res.json({
      ok: true,
      username,
      profile: profileNormalized,
      stories: {
        count: storiesNormalized.count,
        items: storiesNormalized.stories ?? [],
      },
      source: "scrape",
    });
  } catch (err) {
    console.error("Instagram user error:", err.message);
    const status = err.response?.status ?? 502;
    res.status(status).json({
      error: "Failed to fetch user",
      details: err.message,
    });
  }
});

// ──── GET /instagram/info ─────────────────────────────────────
//  API info and capabilities.

router.get("/info", (req, res) => {
  res.json({
    name: "Instagram Scraper",
    description: "Profile and stories by username. Safe for RapidAPI: each user sends their own session in a header; we never store it.",
    endpoints: [
      { method: "GET", path: "/instagram/profile/:username", description: "Get profile by username" },
      { method: "GET", path: "/instagram/stories/:username", description: "Get stories by username" },
      { method: "GET", path: "/instagram/user/:username", description: "Get profile + stories in one call" },
      { method: "GET", path: "/instagram/info", description: "This info" },
    ],
    auth_for_stories: {
      header: "X-Instagram-Session",
      description: "Optional. For profile/stories/user: send the caller's Instagram session so we can fetch stories. Value: sessionid=... (from browser cookies when logged in to instagram.com). Not stored; used only for that request. Ideal for RapidAPI: add this as an optional header in your API listing so subscribers pass their own session.",
    },
    auth_options: [
      {
        name: "Per-request header (RapidAPI / BYOA)",
        header: "X-Instagram-Session",
        note: "Caller sends their own session (sessionid=...) in the header. We do not store it. Add as optional header in RapidAPI.",
      },
      {
        name: "RapidAPI proxy (no session)",
        env: "INSTAGRAM_RAPIDAPI_KEY + INSTAGRAM_RAPIDAPI_HOST",
        note: "If set, we use this API for profile/stories; no Instagram session needed.",
      },
      {
        name: "Dev only: server env",
        env: "INSTAGRAM_SESSION_COOKIE",
        note: "Optional. For local testing only; do not use in production or when publishing to RapidAPI.",
      },
    ],
  });
});

export default router;
