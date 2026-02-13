import express from "express";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import soccerScoresRoutes from "./routes/soccer-scores.js";
import israelTransitRoutes from "./routes/israel-transit.js";
import bibleRoutes from "./routes/bible.js";
import pokemonRoutes from "./routes/pokemon.js";
import jokesRoutes from "./routes/jokes.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// Serve the client UI
app.use(express.static(join(__dirname, "client")));

// Optional: protect your origin if you want only Rapid requests to hit it
const RAPID_PROXY_SECRET = process.env.RAPID_PROXY_SECRET || null;

app.use((req, res, next) => {
  if (!RAPID_PROXY_SECRET) return next();
  const secret = req.header("X-RapidAPI-Proxy-Secret");
  if (secret !== RAPID_PROXY_SECRET) {
    return res.status(403).json({ error: "Forbidden" });
  }
  next();
});

// Health check
app.get("/health", (req, res) => res.json({ ok: true }));

// Mount route files
app.use("/soccer", soccerScoresRoutes);
app.use("/israel-transit", israelTransitRoutes);
app.use("/bible", bibleRoutes);
app.use("/pokemon", pokemonRoutes);
app.use("/jokes", jokesRoutes);

app.listen(PORT, () => console.log(`API running on http://localhost:${PORT}`));
