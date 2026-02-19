import axios from "axios";
const h = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0",
  Accept: "text/html",
  Referer: "https://www.instagram.com/",
};
const res = await axios.get("https://www.instagram.com/stories/hazinor/", {
  headers: h,
  validateStatus: () => true,
});
const html = typeof res.data === "string" ? res.data : "";
const idx = html.indexOf("2142613333");
if (idx !== -1) {
  console.log("Context around user id:", html.slice(idx - 100, idx + 400));
}
const itemsIdx = html.indexOf('"items"');
if (itemsIdx !== -1) {
  console.log("Context around items:", html.slice(itemsIdx - 50, itemsIdx + 300));
}
const displayUrlIdx = html.indexOf("display_url");
console.log("display_url in stories page:", displayUrlIdx !== -1);
if (displayUrlIdx !== -1) {
  console.log("Around display_url:", html.slice(displayUrlIdx - 100, displayUrlIdx + 250));
}
