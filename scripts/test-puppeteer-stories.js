/**
 * Test Puppeteer story fetch for hazinor with session.
 * Run: node scripts/test-puppeteer-stories.js
 */
const session = "36278988810%3AdrMTz2liQbkIdD%3A22%3AAYjsnaGGzzO-nASbxOo_X0C7riV6tnUsfBWPqUTUFg";
const username = "hazinor";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0 Safari/537.36";

function findEdges(obj) {
  if (!obj || typeof obj !== "object") return undefined;
  if (Object.prototype.hasOwnProperty.call(obj, "edges") && Array.isArray(obj.edges)) return obj.edges;
  for (const v of Object.values(obj)) {
    const found = findEdges(v);
    if (found !== undefined) return found;
  }
  return undefined;
}

async function main() {
  const puppeteer = await import("puppeteer").then((m) => m.default);
  console.log("Launching browser...");
  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });
  const page = await browser.newPage();
  await page.setUserAgent(UA);
  const sessionValue = session.includes("sessionid=") ? session.replace(/^sessionid=/, "").trim() : session.trim();
  await page.setCookie({
    name: "sessionid",
    value: sessionValue,
    domain: ".instagram.com",
    path: "/",
  });

  let captured = null;
  const jsonUrls = [];
  const allJsonUrls = [];
  page.on("response", async (response) => {
    try {
      const url = response.url();
      if (!url.includes("instagram.com") || !response.ok()) return;
      const ct = response.headers()["content-type"] || "";
      if (!ct.includes("application/json")) return;
      allJsonUrls.push(url);
      const text = await response.text();
      if (url.includes("graphql")) {
        jsonUrls.push({ url: url.slice(0, 180), len: text.length, text: text.slice(0, 2000), full: text });
      }
      if (!text.includes("display_url") && !text.includes("video_url") && !text.includes("image_versions2")) return;
      const data = JSON.parse(text);
      const reels = data?.reels_media ?? data?.data?.reels_media;
      if (Array.isArray(reels) && reels.length > 0 && reels[0].items) {
        captured = reels[0].items;
        console.log("Captured from reels_media:", captured.length, "items");
      }
      const items = data?.items;
      if (!captured && Array.isArray(items) && items.length > 0 && (items[0].display_url || items[0].video_url || items[0].image_versions2)) {
        captured = items;
        console.log("Captured from items:", captured.length);
      }
      const edges = data?.data?.xdt_api__v1__feed__reels_media__connection?.edges ?? findEdges(data);
      if (!captured && Array.isArray(edges) && edges.length > 0) {
        const nodes = edges.map((e) => e.node || e).filter(Boolean);
        const withMedia = nodes.filter((n) => n.image_versions2 || n.video_versions || n.display_url || n.video_url);
        if (withMedia.length > 0) {
          captured = withMedia;
          console.log("Captured from edges (nodes with media):", captured.length);
        } else {
          for (const n of nodes) {
            const media = n.media;
            if (Array.isArray(media) && media.length > 0 && media[0] && (media[0].image_versions2 || media[0].video_versions || media[0].display_url || media[0].video_url)) {
              captured = media;
              console.log("Captured from node.media:", captured.length);
              break;
            }
          }
        }
      }
    } catch (_) {}
  });

  console.log("Navigating to stories page...");
  await page.goto(`https://www.instagram.com/stories/${username}/`, {
    waitUntil: "networkidle2",
    timeout: 25000,
  });
  console.log("Waiting 4s for API...");
  await new Promise((r) => setTimeout(r, 4000));

  if (captured) {
    console.log("Stories count:", captured.length);
    if (captured[0]) console.log("First story keys:", Object.keys(captured[0]));
  } else {
    console.log("No reel captured from network. Trying page.evaluate...");
    const fromPage = await page.evaluate(() => {
      const scripts = document.querySelectorAll('script[type="application/json"]');
      for (const s of scripts) {
        try {
          const d = JSON.parse(s.textContent || "{}");
          const j = JSON.stringify(d);
          if (!j.includes("display_url")) continue;
          const find = (o) => {
            if (Array.isArray(o) && o[0] && (o[0].display_url || o[0].video_url)) return o;
            if (o && typeof o === "object") for (const v of Object.values(o)) { const t = find(v); if (t) return t; }
            return null;
          };
          const arr = find(d);
          if (arr) return arr;
        } catch (_) {}
      }
      return null;
    });
    if (fromPage) {
      captured = fromPage;
      console.log("From page:", captured.length);
    }
  }

  const html = await page.evaluate(() => document.documentElement.outerHTML).catch(() => "");
  console.log("Page HTML length:", html.length);
  console.log("HTML contains hazinor:", html.includes("hazinor"));
  console.log("HTML contains reels_media:", html.includes("reels_media"));
  console.log("HTML contains display_url:", html.includes("display_url"));
  const scriptCount = (html.match(/script[^>]*type="application\/json"/g) || []).length;
  console.log("application/json script tags:", scriptCount);

  await browser.close();
  console.log("GraphQL responses:", jsonUrls.length);
  jsonUrls.forEach((u, i) => {
    const t = u.full || u.text || "";
    console.log(`  [${i}] len=${u.len} reels_media=${t.includes("reels_media")} xdt_api=${t.includes("xdt_api")} hazinor=${t.includes("hazinor")} timeline=${t.includes("timeline")}`);
  });
  const gql = jsonUrls.find((u) => u.text && (u.text.includes("reel") || u.text.includes("story")));
  if (gql) {
    const t = gql.text;
    if (t.includes("display_url")) console.log("Has display_url in graphql");
    if (t.includes("video_url")) console.log("Has video_url in graphql");
    if (t.includes("image_versions2")) console.log("Has image_versions2 in graphql");
    const urlMatch = t.match(/https:\/\/[^"\\]+\.(cdninstagram|fbcdn)[^"\\]*/);
    if (urlMatch) console.log("CDN URL sample:", urlMatch[0].slice(0, 100));
    const keys = t.match(/"([a-z_]+)":/g);
    if (keys) console.log("Some keys:", [...new Set(keys)].slice(0, 25).join(" "));
    if (gql.full) {
      const fs = await import("fs");
      fs.writeFileSync("scripts/gql-response.json", gql.full, "utf8");
      console.log("Wrote full response to scripts/gql-response.json");
    }
  }
  console.log("Done. Captured:", captured ? captured.length : 0);
  console.log("All JSON response URLs:", allJsonUrls.length);
  allJsonUrls.forEach((u) => console.log("  ", u.slice(0, 140)));
  const reelUrls = allJsonUrls.filter((u) => /reel|stories|reels_media/i.test(u));
  if (reelUrls.length) console.log("URLs with reel/stories:", reelUrls);
}

main().catch((e) => console.error(e));
