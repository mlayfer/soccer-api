/**
 * Debug: find story/reel data structure for hazinor.
 * Run: node scripts/debug-ig.js
 */
import axios from "axios";
import * as cheerio from "cheerio";
import { writeFileSync } from "fs";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const headers = {
  "User-Agent": UA,
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  Referer: "https://www.instagram.com/",
};

const username = "hazinor";
const base = `https://www.instagram.com/${username}`;
const storiesUrl = `https://www.instagram.com/stories/${username}/`;

function findPaths(obj, targetKey, path = "") {
  const paths = [];
  if (!obj || typeof obj !== "object") return paths;
  for (const [k, v] of Object.entries(obj)) {
    const p = path ? `${path}.${k}` : k;
    if (k === targetKey) paths.push(p);
    if (typeof v === "object" && v !== null) {
      paths.push(...findPaths(v, targetKey, p));
    }
  }
  return paths;
}

async function main() {
  console.log("=== Trying STORIES page:", storiesUrl);
  const resStories = await axios.get(storiesUrl, {
    headers,
    timeout: 15000,
    validateStatus: () => true,
    maxRedirects: 5,
  });
  const htmlStories = typeof resStories.data === "string" ? resStories.data : JSON.stringify(resStories.data);
  console.log("Stories page status:", resStories.status, "length:", htmlStories.length);
  console.log("Has reels_media:", htmlStories.includes("reels_media"));
  console.log("Has tray:", htmlStories.includes("tray"));
  console.log("Has login:", htmlStories.includes("login_required"));
  const trayMatch = htmlStories.match(/"reels_media":\s*(\[[\s\S]*?\])\s*[,}]/);
  if (trayMatch) {
    try {
      const arr = JSON.parse(trayMatch[1]);
      console.log("reels_media count:", arr.length);
      if (arr[0]) console.log("First reel keys:", Object.keys(arr[0]));
    } catch (e) {
      console.log("Parse reels_media err:", e.message);
    }
  }
  const reelMatch = htmlStories.match(/"items":\s*(\[[\s\S]*?\])\s*,\s*"id"/);
  if (reelMatch) {
    try {
      const arr = JSON.parse(reelMatch[1]);
      console.log("items count:", arr.length);
      if (arr[0]) console.log("First item keys:", Object.keys(arr[0]), "display_url:", !!arr[0].display_url);
    } catch (e) {}
  }
  const $s = cheerio.load(htmlStories, { decodeEntities: false });
  $s('script[type="application/json"]').each((i, el) => {
    const content = $s(el).html() || "";
    if (content.length < 1000 || !content.includes("tray")) return;
    try {
      const data = JSON.parse(content);
      const str = JSON.stringify(data);
      const idx = str.indexOf('"tray"');
      if (idx !== -1) {
        console.log("\nFound tray in script", i, "snippet:", str.slice(idx, idx + 400));
      }
      function findTray(o) {
        if (!o || typeof o !== "object") return null;
        if (Array.isArray(o) && o.length > 0 && o[0] && (o[0].items || o[0].id)) return o;
        if (o.tray && Array.isArray(o.tray)) return o.tray;
        for (const v of Object.values(o)) {
          const t = findTray(v);
          if (t) return t;
        }
        return null;
      }
      const tray = findTray(data);
      if (tray) console.log("findTray found array length:", tray.length, "first keys:", tray[0] ? Object.keys(tray[0]) : []);
    } catch (e) {}
  });

  console.log("\n=== Now profile page:", base + "/");
  const res = await axios.get(base + "/", {
    headers,
    timeout: 15000,
    validateStatus: () => true,
    maxRedirects: 3,
  });
  const html = typeof res.data === "string" ? res.data : JSON.stringify(res.data);
  const $ = cheerio.load(html, { decodeEntities: false });
  const scripts = $('script[type="application/json"]');

  for (let i = 0; i < scripts.length; i++) {
    const content = $(scripts[i]).html() || "";
    if (content.length < 200) continue;
    if (!content.includes("reel") && !content.includes("items") && !content.includes("profilePage")) continue;
    try {
      const data = JSON.parse(content);
      const str = JSON.stringify(data);
      if (str.includes("reel_media") || str.includes("xdt_api") || str.includes("profilePage")) {
        console.log("\n=== Script", i, "contains profile/reel data ===");
        const reelPaths = findPaths(data, "reel_media");
        const itemsPaths = findPaths(data, "items");
        const userPaths = findPaths(data, "user");
        console.log("Paths to reel_media:", reelPaths.slice(0, 5));
        console.log("Paths to items:", itemsPaths.slice(0, 5));
        console.log("Paths to user:", userPaths.slice(0, 5));
        if (reelPaths.length || str.includes("display_url") || str.includes("video_url")) {
          writeFileSync("scripts/ig-script-" + i + ".json", JSON.stringify(data, null, 2).slice(0, 100000));
          console.log("Saved scripts/ig-script-" + i + ".json (first 100k chars)");
        }
      }
    } catch (e) {}
  }

  const reelMediaMatch = html.match(/"reel_media":\s*(\[[\s\S]*?\])\s*[,}]/);
  if (reelMediaMatch) {
    console.log("\nFound reel_media array, length:", reelMediaMatch[1].length);
    const parsed = JSON.parse(reelMediaMatch[1]);
    console.log("Items count:", parsed.length);
    if (parsed[0]) console.log("First item keys:", Object.keys(parsed[0]));
  }

  console.log("\nContains display_url:", html.includes("display_url"));
  console.log("Contains xdt_api__v1:", html.includes("xdt_api__v1"));
  console.log("Contains profilePage_", html.includes("profilePage_"));
  console.log("Contains edge_highlight_reels:", html.includes("edge_highlight_reels"));
  const re = /"([^"]*reel[^"]*)"\s*:\s*(\{[^{}]+\}|\[[^\]]{0,200}\])/g;
  let m;
  let count = 0;
  while ((m = re.exec(html)) !== null && count++ < 3) {
    console.log("Reel-like key:", m[1], "sample:", String(m[2]).slice(0, 150));
  }
  const requireMatch = html.match(/ScheduledServerJS["\s]*\)[\s\S]*?handle["\s]*,[\s\S]*?null[\s]*,[\s]*(\[[\s\S]{100,5000}?\])\s*\]\s*\]/);
  if (requireMatch) {
    try {
      const arr = JSON.parse(requireMatch[1]);
      const str = JSON.stringify(arr);
      if (str.includes("biography") || str.includes("edge_followed_by")) {
        console.log("\nFound ScheduledServerJS payload with profile-like data");
        const deep = (o, depth) => {
          if (depth > 15) return;
          if (Array.isArray(o)) o.forEach((x, i) => deep(x, depth + 1));
          else if (o && typeof o === "object") {
            for (const [k, v] of Object.entries(o)) {
              if (k === "reel_media" || k === "edge_highlight_reels" || (k === "items" && Array.isArray(v) && v.length > 0 && v[0] && (v[0].display_url || v[0].video_url))) {
                console.log("Found key:", k, "length:", Array.isArray(v) ? v.length : typeof v);
              }
              deep(v, depth + 1);
            }
          }
        };
        deep(arr, 0);
      }
    } catch (e) {
      console.log("Parse ScheduledServerJS err:", e.message);
    }
  }
}

main().catch((e) => console.error(e));
