import axios from "axios";
const userId = "2142613333";
const username = "hazinor";
const variables = {
  reel_ids: [userId],
  tag_names: [],
  location_ids: [],
  highlight_reel_ids: [],
  precomposed_overlay: false,
  show_story_viewer_list: false,
  story_viewer_fetch_count: 50,
};
const url = `https://www.instagram.com/graphql/query/?query_hash=303a4ae99711322310f25250d988f3b7&variables=${encodeURIComponent(JSON.stringify(variables))}`;
const headers = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  Accept: "*/*",
  "X-Requested-With": "XMLHttpRequest",
  "X-IG-App-ID": "936619743392459",
  Referer: "https://www.instagram.com/",
};
const res = await axios.get(url, { headers, validateStatus: () => true });
console.log("Status:", res.status);
console.log("Data keys:", res.data ? Object.keys(res.data) : []);
if (res.data?.data?.reels_media) {
  const reels = res.data.data.reels_media;
  console.log("Reels count:", reels.length);
  if (reels[0]) {
    const items = reels[0].items ?? reels[0].media?.items ?? [];
    console.log("Items count:", items.length);
    if (items[0]) console.log("First item keys:", Object.keys(items[0]));
  }
} else {
  console.log("Sample response:", JSON.stringify(res.data).slice(0, 500));
}
