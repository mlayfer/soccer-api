import { Router } from "express";
import axios from "axios";
import * as cheerio from "cheerio";
import OpenAI from "openai";

const router = Router();

// ──────────────────────────────────────────────────────────────
//  INSTAGRAM — scraping (profile, stories by username)
//  Note: Instagram may show login wall; stories often need session.
// ──────────────────────────────────────────────────────────────

const IG_BASE = "https://www.instagram.com";
const IG_API_BASE = "https://i.instagram.com";
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
        const user = r1.data.graphql?.user ?? r1.data.user;
        const reel = user?.reel ?? r1.data.reel;
        const reelNorm = reel ? normalizeReel(reel?.items ? { items: reel.items } : reel, username) : null;
        const timeline = user?.edge_owner_to_timeline_media ?? findInObject(r1.data, "edge_owner_to_timeline_media");
        const postsNorm = timeline ? normalizePosts(timeline, username) : null;
        return { profile, reel: reelNorm, posts: postsNorm };
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
        const timeline = findInObject(r2.data, "edge_owner_to_timeline_media");
        const postsNorm = timeline ? normalizePosts(timeline, username) : null;
        return { profile, reel: reelNorm, posts: postsNorm };
      }
    }
  } catch (_) {}

  try {
    const r3 = await axios.get(`${IG_BASE}/${encoded}/embed/`, { ...opts, headers: defaultHeaders });
    if (r3.status === 200 && typeof r3.data === "string" && !r3.data.includes("login_required") && !r3.data.includes("login_and_signup")) {
      const { profile: pData, reel: rData, posts: pPosts } = extractProfileData(r3.data);
      const profile = pData ? normalizeProfile(pData, username) : null;
      if (profile) {
        let reelNorm = rData ? normalizeReel(rData, username) : null;
        if (!reelNorm && pData) {
          const user = findInObject(pData, "user");
          const rm = user?.reel_media ?? user?.reel;
          if (rm) reelNorm = normalizeReel(Array.isArray(rm) ? { items: rm } : rm, username);
        }
        let postsNorm = pPosts ? normalizePosts(pPosts, username) : null;
        if (!postsNorm && pData) {
          const timeline = findInObject(pData, "edge_owner_to_timeline_media");
          if (timeline) postsNorm = normalizePosts(timeline, username);
        }
        return { profile, reel: reelNorm, posts: postsNorm };
      }
    }
  } catch (_) {}

  for (const ua of USER_AGENTS) {
    try {
      const r4 = await axios.get(`${IG_BASE}/${encoded}/`, { ...opts, headers: { ...defaultHeaders, "User-Agent": ua } });
      if (r4.status !== 200 || typeof r4.data !== "string") continue;
      const html = r4.data;
      if (html.includes("login_required") || html.includes("login_and_signup_page") || html.includes("Login • Instagram")) continue;
      const { profile: pData, reel: rData, posts: pPosts } = extractProfileData(html);
      const profile = pData ? normalizeProfile(pData, username) : null;
      if (profile) {
        let reelNorm = rData ? normalizeReel(rData, username) : null;
        if (!reelNorm && pData) {
          const user = findInObject(pData, "user");
          const rm = user?.reel_media ?? user?.reel;
          if (rm) reelNorm = normalizeReel(Array.isArray(rm) ? { items: rm } : rm, username);
        }
        let postsNorm = pPosts ? normalizePosts(pPosts, username) : null;
        if (!postsNorm && pData) {
          const timeline = findInObject(pData, "edge_owner_to_timeline_media");
          if (timeline) postsNorm = normalizePosts(timeline, username);
        }
        return { profile, reel: reelNorm, posts: postsNorm };
      }
    } catch (_) {}
  }
  return null;
}

const STORY_QUERY_HASH = "303a4ae99711322310f25250d988f3b7";
const POSTS_QUERY_HASH = "17888483320059182";

/** Fetch user posts via Instagram GraphQL (no cookie). Needs userId from profile. */
async function fetchPostsViaGraphQL(userId, username) {
  if (!userId) return null;
  const variables = {
    id: String(userId),
    first: 50,
    after: null,
  };
  const url = `${IG_BASE}/graphql/query/?query_hash=${POSTS_QUERY_HASH}&variables=${encodeURIComponent(JSON.stringify(variables))}`;
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
    const user = data?.data?.user ?? findInObject(data, "user");
    const timeline = user?.edge_owner_to_timeline_media ?? findInObject(data, "edge_owner_to_timeline_media");
    if (!timeline || !timeline.edges) return null;
    return normalizePosts(timeline, username);
  } catch (_) {
    return null;
  }
}

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
    const postsRaw =
      data.posts ?? data.data?.posts ?? user?.posts ?? data.media ?? data.data?.media ?? user?.media ??
      user?.edge_owner_to_timeline_media ?? data.edge_owner_to_timeline_media ?? [];
    const posts = normalizeRapidApiPosts(postsRaw, username);
    return { profile, stories, posts };
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

/** Extract posts from profile/timeline data (edge_owner_to_timeline_media or similar). */
function extractPostsFromProfile(profileData) {
  const timeline =
    findInObject(profileData, "edge_owner_to_timeline_media") ??
    findInObject(profileData, "edge_media_to_tagged_user") ??
    findInObject(profileData, "media");
  if (!timeline || typeof timeline !== "object") return null;
  const edges = timeline.edges ?? timeline.media ?? (Array.isArray(timeline) ? timeline.map((n) => ({ node: n })) : null);
  if (!Array.isArray(edges) || edges.length === 0) return null;
  const nodes = edges.map((e) => (e && typeof e === "object" && (e.node || e.media)) ? (e.node ?? e.media ?? e) : e).filter(Boolean);
  return nodes;
}

/** Normalize post items to consistent shape (mimics stories structure). */
function normalizePosts(postsData, username) {
  const user = findInObject(postsData, "user");
  const rawNodes = Array.isArray(postsData)
    ? postsData
    : extractPostsFromProfile(postsData) ?? postsData?.edges?.map((e) => e.node ?? e) ?? postsData?.media ?? [];
  const posts = rawNodes.map((node) => {
    const item = node?.node ?? node;
    const isVideo = !!(item.video_url ?? item.video_versions ?? item.__typename === "GraphVideo" ?? item.media_type === 2);
    const url = item.video_url ?? item.display_url ?? item.image_versions2?.candidates?.[0]?.url ?? item.display_src ?? item.src;
    const thumbnail = item.display_url ?? item.thumbnail ?? item.image_versions2?.candidates?.[0]?.url ?? url;
    const caption = getStoryCaption(item);
    return {
      id: item.id ?? item.pk,
      shortcode: item.shortcode ?? null,
      url: url ?? null,
      thumbnail: thumbnail ?? null,
      isVideo,
      timestamp: item.taken_at ?? item.taken_at_timestamp ?? item.timestamp ?? null,
      caption: caption || null,
      likesCount: item.edge_liked_by?.count ?? item.like_count ?? item.likes ?? null,
      commentsCount: item.edge_media_to_comment?.count ?? item.comment_count ?? item.comments ?? null,
    };
  }).filter((p) => p.url);
  return {
    username: user?.username ?? username,
    userId: user?.id ?? user?.pk ?? null,
    count: posts.length,
    posts,
  };
}

const POSTS_LAST_24H_SECONDS = 24 * 60 * 60;

/** Filter posts to only those from the last 24 hours. */
function filterPostsLast24Hours(posts) {
  if (!Array.isArray(posts)) return [];
  const cutoff = Math.floor(Date.now() / 1000) - POSTS_LAST_24H_SECONDS;
  return posts.filter((p) => {
    const ts = p.timestamp ?? p.taken_at ?? p.taken_at_timestamp;
    return ts != null && Number(ts) >= cutoff;
  });
}

function normalizeRapidApiPosts(postsRaw, username) {
  const items = Array.isArray(postsRaw)
    ? postsRaw
    : postsRaw?.edges?.map((e) => e.node ?? e) ?? postsRaw?.media ?? postsRaw?.data ?? [];
  const posts = items.map((item) => {
    const url = item.video_url ?? item.display_url ?? item.url ?? item.image_versions2?.candidates?.[0]?.url ?? item.src;
    const thumb = item.display_url ?? item.thumbnail ?? url;
    return {
      id: item.id ?? item.pk,
      shortcode: item.shortcode ?? null,
      url: url ?? null,
      thumbnail: thumb ?? null,
      isVideo: !!(item.video_url ?? item.media_type === 2),
      timestamp: item.taken_at ?? item.taken_at_timestamp ?? item.timestamp ?? null,
      caption: getStoryCaption(item) || null,
      likesCount: item.edge_liked_by?.count ?? item.like_count ?? item.likes ?? null,
      commentsCount: item.edge_media_to_comment?.count ?? item.comment_count ?? item.comments ?? null,
    };
  }).filter((p) => p.url);
  return { username, count: posts.length, posts };
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
  let posts = null;

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
      if (str.includes("edge_owner_to_timeline_media") || str.includes("edge_media_to_tagged_user")) {
        posts = findInObject(data, "edge_owner_to_timeline_media") ?? findInObject(data, "edge_media_to_tagged_user");
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

  if (!posts && profile) {
    posts = findInObject(profile, "edge_owner_to_timeline_media");
  }

  return { profile, reel, posts };
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

    const captured = [];
    const mergeItems = (items) => {
      if (!Array.isArray(items)) return;
      for (const item of items) {
        const id = item.id ?? item.pk;
        if (!id) continue;
        if (captured.some((c) => (c.id ?? c.pk) === id)) continue;
        captured.push(item);
      }
    };
    const requested = (username || "").toLowerCase();
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
        if (Array.isArray(reels) && reels.length > 0) {
          for (const reel of reels) {
            if (reel?.items?.length > 0) {
              const u = (reel.user?.username || reel.owner?.username || "").toLowerCase();
              if (u === requested) mergeItems(reel.items);
            }
          }
        }
        let items = data?.items ?? findInObject(data, "items");
        if (Array.isArray(items) && items.length > 0 && (items[0].display_url || items[0].video_url)) {
          const owner = (items[0]?.user?.username ?? items[0]?.owner?.username ?? "").toLowerCase();
          if (owner === requested) mergeItems(items);
        }
        const edges = data?.data?.xdt_api__v1__feed__reels_media__connection?.edges ?? findInObject(data, "edges");
        if (Array.isArray(edges) && edges.length > 0) {
          const nodes = edges.map((e) => e.node || e).filter(Boolean);
          const withMedia = nodes.filter((n) => n.image_versions2 || n.video_versions || n.display_url || n.video_url);
          if (withMedia.length > 0) {
            const name = (withMedia[0]?.user?.username ?? withMedia[0]?.owner?.username ?? "").toLowerCase();
            if (name === requested) mergeItems(withMedia);
          } else {
            for (const n of nodes) {
              const media = n.media;
              if (Array.isArray(media) && media.length > 0 && media[0] && (media[0].image_versions2 || media[0].video_versions || media[0].display_url || media[0].video_url)) {
                const name = (n?.media?.user?.username ?? n?.user?.username ?? "").toLowerCase();
                if (name === requested) mergeItems(media);
                break;
              }
            }
          }
        }
        const arr = findReelItemsArray(data);
        if (Array.isArray(arr) && arr.length > 0) {
          const owner = (arr[0]?.user?.username ?? arr[0]?.owner?.username ?? "").toLowerCase();
          if (owner && owner === requested) mergeItems(arr);
        }
      } catch (_) {}
    };
    page.on("response", onResponse);

    await page.goto(`${IG_BASE}/stories/${encodeURIComponent(username)}/`, {
      waitUntil: "networkidle2",
      timeout: 25000,
    });
    await new Promise((r) => setTimeout(r, 6000));
    if (captured.length === 0 && page) {
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
      if (reelFromPage && reelFromPage.length) {
        for (const item of reelFromPage) {
          const id = item.id ?? item.pk;
          if (id && !captured.some((c) => (c.id ?? c.pk) === id)) captured.push(item);
        }
      }
    }

    await browser.close();
    browser = null;

    if (!captured.length) return null;
    captured.sort((a, b) => (a.taken_at ?? a.timestamp ?? 0) - (b.taken_at ?? b.timestamp ?? 0));
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
        caption: getStoryCaption(item),
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
 * Fetch posts using Puppeteer (real browser). Captures API responses containing timeline/posts.
 * Requires session cookie. Returns { username, count, posts } or null.
 */
async function fetchPostsWithBrowser(username, sessionCookie) {
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

    const captured = [];
    const requested = (username || "").toLowerCase();

    const toPostItem = (item) => {
      const media = item.media ?? item;
      const id = media.id ?? media.pk ?? item.id ?? item.pk;
      if (!id) return null;
      if (captured.some((c) => (c.id ?? c.pk) === id)) return null;
      const url = media.video_url ?? media.display_url ?? media.display_uri ?? media.image_versions2?.candidates?.[0]?.url ?? media.display_src ?? media.src;
      if (!url) return null;
      return {
        id: media.id ?? media.pk ?? id,
        shortcode: media.code ?? media.shortcode ?? null,
        display_url: url,
        video_url: media.video_url ?? null,
        image_versions2: media.image_versions2,
        taken_at: media.taken_at ?? media.taken_at_timestamp ?? null,
        like_count: media.like_count ?? media.edge_liked_by?.count ?? null,
        comment_count: media.comment_count ?? media.edge_media_to_comment?.count ?? null,
        caption: media.caption?.text ?? getStoryCaption(media) ?? null,
        media_type: media.media_type ?? null,
      };
    };

    const mergePost = (item) => {
      const post = toPostItem(item);
      if (post && !captured.some((c) => (c.id ?? c.pk) === (post.id ?? post.pk))) captured.push(post);
    };

    const extractFromTimeline = (data) => {
      const timeline = data?.data?.xdt_api__v1__feed__timeline__connection ?? findInObject(data, "xdt_api__v1__feed__timeline__connection");
      const edges = timeline?.edges ?? findInObject(data, "edges");
      if (!Array.isArray(edges)) return;
      for (const e of edges) {
        const node = e.node ?? e;
        if (!node) continue;
        const media = node.media ?? node;
        const user = media?.user ?? node?.media?.user ?? node?.user;
        const u = (user?.username ?? "").toLowerCase();
        if (u === requested && media && (media.display_url || media.image_versions2 || media.display_uri)) mergePost({ media, ...media });
      }
    };

    const extractFromProfileTimeline = (data) => {
      const timeline = findInObject(data, "edge_owner_to_timeline_media");
      const edges = timeline?.edges ?? [];
      if (!Array.isArray(edges)) return;
      for (const e of edges) {
        const node = e.node ?? e;
        if (node && (node.display_url || node.image_versions2 || node.shortcode)) mergePost(node);
      }
    };

    const onResponse = async (response) => {
      try {
        const url = response.url();
        if (!url.includes("instagram.com") || !response.ok()) return;
        const ct = response.headers()["content-type"] || "";
        if (!ct.includes("application/json")) return;
        const text = await response.text();
        if (!text || (!text.includes("display_url") && !text.includes("image_versions2") && !text.includes("edge_owner_to_timeline"))) return;
        const data = JSON.parse(text);
        extractFromTimeline(data);
        extractFromProfileTimeline(data);
        const user = data?.data?.user ?? findInObject(data, "user");
        const timeline = user?.edge_owner_to_timeline_media ?? findInObject(data, "edge_owner_to_timeline_media");
        if (timeline?.edges) {
          for (const e of timeline.edges) {
            const node = e.node ?? e;
            if (node) mergePost(node);
          }
        }
      } catch (_) {}
    };
    page.on("response", onResponse);

    await page.goto(`${IG_BASE}/${encodeURIComponent(username)}/`, {
      waitUntil: "networkidle2",
      timeout: 25000,
    });
    await new Promise((r) => setTimeout(r, 5000));

    if (captured.length === 0 && page) {
      const postsFromPage = await page.evaluate((requestedUser) => {
        const requested = (requestedUser || "").toLowerCase();
        const scripts = document.querySelectorAll('script[type="application/json"]');
        const findTimeline = (o) => {
          if (!o || typeof o !== "object") return null;
          if (Object.prototype.hasOwnProperty.call(o, "edge_owner_to_timeline_media")) {
            const edges = o.edge_owner_to_timeline_media?.edges ?? [];
            return edges.map((e) => e.node ?? e).filter((n) => n && (n.display_url || n.image_versions2 || n.shortcode));
          }
          for (const v of Object.values(o)) {
            const t = findTimeline(v);
            if (t && t.length) return t;
          }
          return null;
        };
        for (const s of scripts) {
          const raw = s.textContent || "";
          if (!raw.includes("edge_owner_to_timeline") && !raw.includes("display_url")) continue;
          try {
            const d = JSON.parse(raw);
            const nodes = findTimeline(d);
            if (nodes && nodes.length) {
              const first = nodes[0];
              const u = (first?.owner?.username ?? first?.user?.username ?? "").toLowerCase();
              if (!u || u === requested) return nodes;
            }
          } catch (_) {}
        }
        return null;
      }, username).catch(() => null);
      if (postsFromPage && postsFromPage.length) {
        for (const item of postsFromPage) {
          mergePost(item);
        }
      }
    }

    await browser.close();
    browser = null;

    if (!captured.length) return null;
    captured.sort((a, b) => (a.taken_at ?? 0) - (b.taken_at ?? 0));
    const posts = captured.map((item) => ({
      id: item.id,
      shortcode: item.shortcode ?? null,
      url: item.display_url ?? null,
      thumbnail: item.display_url ?? null,
      isVideo: !!(item.video_url ?? item.media_type === 2),
      timestamp: item.taken_at ?? null,
      caption: item.caption || null,
      likesCount: item.like_count ?? null,
      commentsCount: item.comment_count ?? null,
    })).filter((p) => p.url);
    return { username, count: posts.length, posts };
  } catch (err) {
    console.error("Puppeteer posts error:", err.message);
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

/** Extract caption/transcription from a story item (all known Instagram fields). */
function getStoryCaption(item) {
  if (!item || typeof item !== "object") return "";
  const s =
    item.accessibility_caption ??
    item.caption?.text ??
    (typeof item.caption === "string" ? item.caption : null) ??
    item.edge_media_to_caption?.edges?.[0]?.node?.text ??
    item.title ??
    "";
  return typeof s === "string" ? s.trim() : "";
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
      caption: getStoryCaption(item),
    };
  }).filter((s) => s.url);

  return {
    username: user?.username ?? username,
    userId: user?.id ?? user?.pk ?? null,
    count: stories.length,
    stories,
  };
}

// ──── GET /instagram/media — proxy media URL (throttle + random delay + retries)
const MEDIA_PROXY_CONCURRENCY = 6;
const mediaProxyQueue = [];
let mediaProxyActive = 0;

function waitMediaSlot() {
  if (mediaProxyActive < MEDIA_PROXY_CONCURRENCY) {
    mediaProxyActive++;
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    mediaProxyQueue.push(resolve);
  });
}

function releaseMediaSlot() {
  mediaProxyActive--;
  if (mediaProxyQueue.length > 0) {
    mediaProxyActive++;
    const next = mediaProxyQueue.shift();
    if (next) next();
  }
}

async function fetchMediaStream(decodedUrl) {
  const isVideo = /\.(mp4|webm|video)|video_versions|video_url/i.test(decodedUrl);
  const accept = isVideo
    ? "video/webm,video/mp4,video/*,*/*;q=0.8"
    : "image/avif,image/webp,image/apng,image/*,*/*;q=0.8";
  const { data, headers } = await axios.get(decodedUrl, {
    responseType: "stream",
    timeout: 30_000,
    maxRedirects: 5,
    headers: {
      "User-Agent": UA,
      Referer: "https://www.instagram.com/",
      Accept: accept,
    },
    validateStatus: (s) => s === 200,
  });
  return { data, contentType: headers["content-type"] };
}

router.get("/media", async (req, res) => {
  try {
    const rawUrl = req.query.url;
    if (!rawUrl || typeof rawUrl !== "string") {
      return res.status(400).json({ error: "Missing url query" });
    }
    let decoded;
    try {
      decoded = decodeURIComponent(rawUrl);
    } catch (_) {
      return res.status(400).json({ error: "Invalid url" });
    }
    if (!/^https:\/\/(www\.)?instagram\.com|^https:\/\/[^/]*\.(fbcdn\.net|cdninstagram\.com)\//i.test(decoded)) {
      return res.status(400).json({ error: "URL must be from Instagram or Facebook CDN" });
    }

    await waitMediaSlot();
    try {
      const delay = 50 + Math.floor(Math.random() * 200);
      await new Promise((r) => setTimeout(r, delay));

      const retryDelays = [600, 1500, 3000];
      let result = null;
      let lastErr = null;
      for (let attempt = 0; attempt <= 3; attempt++) {
        try {
          result = await fetchMediaStream(decoded);
          break;
        } catch (err) {
          lastErr = err;
          if (attempt < 3) {
            await new Promise((r) => setTimeout(r, retryDelays[attempt]));
          }
        }
      }

      if (!result) throw lastErr || new Error("Failed after retries");
      if (result.contentType) res.set("Content-Type", result.contentType);
      res.set("Cache-Control", "public, max-age=3600, stale-while-revalidate=86400");
      res.set("Access-Control-Allow-Origin", "*");
      result.data.pipe(res);
    } finally {
      releaseMediaSlot();
    }
  } catch (err) {
    if (!res.headersSent) {
      res.status(502).json({ error: "Failed to fetch media", details: err.message });
    }
  }
});

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

// ──── POST /instagram/posts/top-10 ────────────────────────────
//  Must be before GET /posts/:username to avoid :username matching "top-10"
//  AI-curated top 10 most important posts from multiple accounts (last 24h).

async function curateTop10WithAI(posts) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;
  const client = new OpenAI({ apiKey });
  const items = posts.slice(0, 100).map((p, i) => ({
    index: i,
    username: p.username || "unknown",
    caption: (p.caption || "").slice(0, 500),
    likes: p.likesCount ?? 0,
    comments: p.commentsCount ?? 0,
  }));
  const prompt = `You are curating the top 10 Instagram posts from the last 24 hours for an Israeli audience that wants a balanced mix.

CONTENT MIX (important): About 50% culture & entertainment, 50% news.
- Culture & entertainment: celebrities, music, TV, movies, influencers, lifestyle, fashion, sports, viral moments, gossip, reality shows.
- News: politics, security, economy, local events, world news.

Importance factors:
- High engagement (likes + comments) = more important
- Trending topics (covered by multiple accounts) = more important
- Balance the mix: do NOT favor only news. Include entertainment, culture, and fun content.

GROUP similar posts together. Each item = one story/topic. If multiple posts cover the same story, put their indices in postIndices.

Return a JSON object with key "items" - an array of up to 10 items. Each item MUST have:
- "summary": "סיכום קצר בעברית" (single line, condensed, IN HEBREW)
- "postIndices": [0, 2, 5] (array of original indices - posts that cover this story)
- "funnyHeadlines": ["כותרת מצחיקה 1", "כותרת מצחיקה 2", "כותרת מצחיקה 3"] (REQUIRED: exactly 3 funny headlines IN HEBREW. Be creative: sarcastic, exaggerated, puns, clickbait-style, witty. Each headline max ~10 words.)

Example: {"items":[{"summary":"ממשלה מאשרת רפורמה","postIndices":[0,3],"funnyHeadlines":["..."]},{"summary":"אומן X מודיע על הופעה","postIndices":[5,7],"funnyHeadlines":["..."]}]}
Order by importance. Alternate between news and entertainment when possible.`;

  const top10Schema = {
    type: "json_schema",
    json_schema: {
      name: "top10_curation",
      strict: true,
      schema: {
        type: "object",
        properties: {
          items: {
            type: "array",
            items: {
              type: "object",
              properties: {
                summary: { type: "string", description: "סיכום קצר בעברית" },
                postIndices: { type: "array", items: { type: "integer" }, description: "מערך אינדקסים" },
                funnyHeadlines: {
                  type: "array",
                  items: { type: "string" },
                  description: "בדיוק 3 כותרות מצחיקות בעברית - חובה לכל אייטם",
                },
              },
              required: ["summary", "postIndices", "funnyHeadlines"],
              additionalProperties: false,
            },
          },
        },
        required: ["items"],
        additionalProperties: false,
      },
    },
  };

  const makeRequest = (responseFormat) =>
    client.chat.completions.create({
      model: process.env.OPENAI_MODEL || "gpt-4o-mini",
      messages: [
        { role: "system", content: "You return only valid JSON. Use key 'items' for the array. No markdown, no explanation." },
        { role: "user", content: `${prompt}\n\nPosts:\n${JSON.stringify(items)}` },
      ],
      temperature: 0.3,
      response_format: responseFormat,
    });

  try {
    let completion;
    try {
      completion = await makeRequest(top10Schema);
    } catch (schemaErr) {
      const msg = String(schemaErr?.message || schemaErr);
      const isSchemaError = schemaErr?.status === 400 || /schema|json_schema|structured|not supported/i.test(msg);
      if (isSchemaError) {
        console.warn("[top-10] Structured output failed, falling back to json_object:", msg);
        completion = await makeRequest({ type: "json_object" });
      } else throw schemaErr;
    }
    const text = completion.choices?.[0]?.message?.content?.trim() || "{}";
    const json = text.replace(/^```json?\s*|\s*```$/g, "");
    const parsed = JSON.parse(json);
    const selected = Array.isArray(parsed) ? parsed : (parsed?.items ?? parsed?.top10 ?? []);
    if (!Array.isArray(selected) || selected.length === 0) return null;
    return selected;
  } catch (err) {
    console.error("OpenAI curate error:", err.message);
    return null;
  }
}

/** Generate 3 funny Hebrew headlines per summary via AI. Returns array of headlines arrays. */
async function generateFunnyHeadlines(summaries) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey || !summaries?.length) return [];
  const client = new OpenAI({ apiKey });
  const prompt = `אתה כותב כותרות מצחיקות לידיעות חדשות בעברית.

לכל ידיעה - כתוב בדיוק 3 כותרות שונות, כל אחת בגישה אחרת:
- סרקסטית / צינית לגבי התוכן
- הגזמה אבסורדית או משחק מילים על הנושא
- סגנון קליקבייט או "תאמינו או לא" שמתאים ספציפית לידיעה

חשוב: כל כותרת חייבת להתייחס ישירות לתוכן הידיעה - לשמות, לאירוע, להקשר. אסור להשתמש בתבניות כלליות. כל ידיעה מקבלת כותרות ייחודיות לה.
אורך: עד 30 מילים לכותרות, לא לחתוך באמצע משפט.

החזר JSON: {"headlines":[[כותרת1,כותרת2,כותרת3],[...],...]} - מערך של 3 מחרוזות לכל ידיעה, באותו סדר.

הידיעות:
${summaries.map((s, i) => `${i + 1}. ${s}`).join("\n\n")}`;
  try {
    const headlinesModel = process.env.OPENAI_HEADLINES_MODEL || process.env.OPENAI_MODEL || "gpt-4o";
    const completion = await client.chat.completions.create({
      model: headlinesModel,
      messages: [
        { role: "system", content: "You return only valid JSON. No markdown, no explanation. Key: headlines." },
        { role: "user", content: prompt },
      ],
      temperature: 0.9,
      response_format: { type: "json_object" },
    });
    const text = completion.choices?.[0]?.message?.content?.trim() || "{}";
    const parsed = JSON.parse(text.replace(/^```json?\s*|\s*```$/g, ""));
    const arr = parsed?.headlines ?? parsed?.items ?? [];
    return Array.isArray(arr) ? arr : [];
  } catch (err) {
    console.error("OpenAI headlines error:", err.message);
    return [];
  }
}

router.post("/posts/top-10", async (req, res) => {
  try {
    const body = req.body || {};
    let posts = body.posts ?? [];
    if (!Array.isArray(posts) || posts.length === 0) {
      return res.status(400).json({
        error: "Missing or empty posts array",
        message: "Send { posts: [{ id, shortcode, url, thumbnail, caption, username, likesCount, commentsCount }, ...] }",
      });
    }

    if (!process.env.OPENAI_API_KEY) {
      return res.status(503).json({
        error: "AI curation unavailable",
        message: "Set OPENAI_API_KEY in environment to enable top-10 curation.",
      });
    }

    const filtered = filterPostsLast24Hours(posts);
    if (filtered.length === 0) {
      return res.json({
        ok: true,
        total: posts.length,
        top10: [],
        message: "No posts from the last 24 hours.",
      });
    }

    const selected = await curateTop10WithAI(filtered);
    if (!selected || selected.length === 0) {
      return res.json({
        ok: true,
        total: filtered.length,
        top10: filtered.slice(0, 10).map((p) => ({
          summary: (p.caption || "").slice(0, 80),
          funnyHeadlines: [],
          posts: [p],
        })),
        message: "AI ranking unavailable; returning first 10 by default.",
      });
    }

    const top10 = selected.map((s, i) => {
      const indices = Array.isArray(s.postIndices) ? s.postIndices : (s.index != null ? [s.index] : []);
      const posts = indices.map((idx) => filtered[idx]).filter(Boolean);
      if (posts.length === 0) return null;
      return {
        rank: i + 1,
        summary: s.summary || (posts[0].caption || "").slice(0, 80),
        posts: posts.map((p) => ({
          id: p.id,
          shortcode: p.shortcode,
          url: p.url,
          thumbnail: p.thumbnail,
          username: p.username,
          likesCount: p.likesCount,
          commentsCount: p.commentsCount,
        })),
      };
    }).filter(Boolean);

    res.json({
      ok: true,
      total: filtered.length,
      top10,
    });
  } catch (err) {
    console.error("Instagram posts top-10 error:", err.message);
    res.status(500).json({
      error: "Failed to curate top 10",
      details: err.message,
    });
  }
});

// ──── POST /instagram/posts/headlines ───────────────────────
//  Standalone endpoint: generate funny headlines for summaries. Client calls this separately.
router.post("/posts/headlines", async (req, res) => {
  try {
    const summaries = req.body?.summaries ?? [];
    if (!Array.isArray(summaries) || summaries.length === 0) {
      return res.status(400).json({ error: "Missing summaries array", message: "Send { summaries: [\"סיכום 1\", \"סיכום 2\", ...] }" });
    }
    if (!process.env.OPENAI_API_KEY) {
      return res.status(503).json({ error: "AI unavailable", message: "Set OPENAI_API_KEY" });
    }
    const headlines = await generateFunnyHeadlines(summaries);
    const fallback = (s) => {
      const t = (s || "").slice(0, 50);
      return t ? [`"${t}" - כן, זה קרה`, `בקצרה: ${t}`, `החדשות: ${t}`] : ["ידיעה חשובה", "עוד כותרת", "והנה עוד אחת"];
    };
    const result = summaries.map((s, i) => {
      const h = headlines[i];
      const arr = Array.isArray(h) ? h.slice(0, 3).map((x) => String(x ?? "").trim()).filter(Boolean) : [];
      return arr.length >= 3 ? arr : fallback(s);
    });
    res.json({ ok: true, headlines: result });
  } catch (err) {
    console.error("Headlines error:", err.message);
    res.status(500).json({ error: "Headlines failed", details: err.message });
  }
});

// ──── GET /instagram/posts/:username ───────────────────────────
//  Priority: posts by username. Mirrors stories flow. May require session cookie.

router.get("/posts/:username", async (req, res) => {
  try {
    const username = (req.params.username || "").trim().replace(/^@/, "");
    if (!username) {
      return res.status(400).json({ error: "Username is required" });
    }

    const noCookie = await fetchWithoutCookie(username);
    const hasSession = !!(req?.get?.("x-instagram-session") ?? req?.headers?.["x-instagram-session"]) || !!process.env.INSTAGRAM_SESSION_COOKIE;
    if (noCookie?.profile && (noCookie.posts?.count > 0 || !hasSession)) {
      let posts = noCookie.posts ?? { username, count: 0, posts: [] };
      if (posts.count > 0) {
        const filtered = filterPostsLast24Hours(posts.posts ?? []);
        return res.json({
          ok: true,
          username: posts.username ?? username,
          userId: noCookie.profile?.id ?? null,
          count: filtered.length,
          posts: filtered,
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
          const graphqlPosts = await fetchPostsViaGraphQL(uid, username);
          if (graphqlPosts && graphqlPosts.count > 0) {
            const filtered = filterPostsLast24Hours(graphqlPosts.posts ?? []);
            return res.json({
              ok: true,
              username: graphqlPosts.username,
              userId: graphqlPosts.userId ?? uid,
              count: filtered.length,
              posts: filtered,
              source: "scrape_no_cookie_graphql",
            });
          }
        }
        return res.json({
          ok: true,
          username,
          userId: noCookie.profile?.id ?? null,
          count: 0,
          posts: [],
          source: "scrape_no_cookie",
          message: "No posts without session. Send X-Instagram-Session header with your sessionid for posts.",
        });
      }
    }
    const rapid = await fetchViaRapidApi(username);
    if (rapid?.profile) {
      const posts = rapid.posts ?? { username, count: 0, posts: [] };
      const filtered = filterPostsLast24Hours(posts.posts ?? []);
      return res.json({
        ok: true,
        username: posts.username,
        userId: rapid.profile?.id ?? null,
        count: filtered.length,
        posts: filtered,
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
        error: "Login required for posts",
        message:
          "Send your Instagram session in header X-Instagram-Session (value: sessionid=... from browser cookies). We do not store it.",
        username,
      });
    }

    const { profile, posts: postsData } = extractProfileData(html);

    let postsPayload = postsData;
    if (!postsPayload && profile) {
      const timeline = findInObject(profile, "edge_owner_to_timeline_media");
      if (timeline) postsPayload = timeline;
    }

    let normalized = postsPayload ? normalizePosts(postsPayload, username) : null;

    if (!normalized || normalized.count === 0) {
      const session = req?.get?.("x-instagram-session") ?? req?.headers?.["x-instagram-session"] ?? process.env.INSTAGRAM_SESSION_COOKIE;
      if (session) {
        const browserPosts = await fetchPostsWithBrowser(username, session);
        if (browserPosts && browserPosts.count > 0) {
          const filtered = filterPostsLast24Hours(browserPosts.posts ?? []);
          return res.json({
            ok: true,
            username: browserPosts.username,
            userId: null,
            count: filtered.length,
            posts: filtered,
            source: "browser",
          });
        }
      }
      return res.json({
        ok: true,
        username,
        count: 0,
        posts: [],
        message:
          "No posts in response. With session: try X-Instagram-Session (sessionid from instagram.com cookies). Ensure Puppeteer is installed for browser-based post fetch.",
      });
    }

    const filtered = filterPostsLast24Hours(normalized.posts ?? []);
    res.json({
      ok: true,
      username: normalized.username,
      userId: normalized.userId,
      count: filtered.length,
      posts: filtered,
      source: "scrape",
    });
  } catch (err) {
    console.error("Instagram posts error:", err.message);
    const status = err.response?.status ?? 502;
    res.status(status).json({
      error: "Failed to fetch posts",
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
      { method: "GET", path: "/instagram/posts/:username", description: "Get posts by username (last 24 hours only)" },
      { method: "POST", path: "/instagram/posts/top-10", description: "AI-curated top 10 most important posts (body: { posts: [...] })" },
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
