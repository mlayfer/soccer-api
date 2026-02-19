/**
 * Fetch hazinor profile + stories page with hardcoded session and look for story data.
 */
import axios from "axios";
import * as cheerio from "cheerio";

const session = "36278988810%3AdrMTz2liQbkIdD%3A22%3AAYjsnaGGzzO-nASbxOo_X0C7riV6tnUsfBWPqUTUFg";
const cookie = session.includes("sessionid=") ? session : `sessionid=${session}`;
const headers = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  Cookie: cookie,
  Referer: "https://www.instagram.com/",
};

async function main() {
  console.log("1. Fetching profile /hazinor/ ...");
  const profileRes = await axios.get("https://www.instagram.com/hazinor/", {
    headers,
    timeout: 15000,
    validateStatus: () => true,
  });
  const profileHtml = typeof profileRes.data === "string" ? profileRes.data : "";
  console.log("   Status:", profileRes.status, "Length:", profileHtml.length);
  console.log("   Has login_required:", profileHtml.includes("login_required"));
  console.log("   Has display_url:", profileHtml.includes("display_url"));
  console.log("   Has video_url:", profileHtml.includes("video_url"));
  console.log("   Has reel_media:", profileHtml.includes("reel_media"));

  console.log("\n2. Fetching stories /stories/hazinor/ ...");
  const storiesRes = await axios.get("https://www.instagram.com/stories/hazinor/", {
    headers,
    timeout: 15000,
    validateStatus: () => true,
    maxRedirects: 5,
  });
  const storiesHtml = typeof storiesRes.data === "string" ? storiesRes.data : "";
  console.log("   Status:", storiesRes.status, "Length:", storiesHtml.length);
  console.log("   Has login_required:", storiesHtml.includes("login_required"));
  console.log("   Has display_url:", storiesHtml.includes("display_url"));
  console.log("   Has video_url:", storiesHtml.includes("video_url"));

  const $ = cheerio.load(storiesHtml, { decodeEntities: false });
  let found = 0;
  $('script[type="application/json"]').each((i, el) => {
    const content = $(el).html() || "";
    if (content.includes("display_url") || content.includes("video_url")) {
      found++;
      try {
        const data = JSON.parse(content);
        const str = JSON.stringify(data);
        const idx = str.indexOf("display_url");
        if (idx !== -1) console.log("   Script", i, "has display_url at", idx, "snippet:", str.slice(idx, idx + 80));
      } catch (e) {}
    }
  });
  console.log("   Scripts with display_url/video_url:", found);
}

main().catch((e) => console.error(e));
