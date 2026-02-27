const express = require("express");
const path = require("path");

const app = express();
const port = Number(process.env.PORT || 3000);
const apiBase = (process.env.BOT_API_BASE_URL || "http://127.0.0.1:8787").replace(/\/+$/, "");

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: false }));
const staticDir = path.join(__dirname, "dist");
app.use(express.static(staticDir));

function joinUrl(base, suffix) {
  const trimmedSuffix = suffix.startsWith("/") ? suffix : `/${suffix}`;
  return `${base}${trimmedSuffix}`;
}

function forwardHeaders(req) {
  const headers = { "Content-Type": "application/json" };
  const ua = req.get("user-agent");
  if (ua) headers["User-Agent"] = ua;
  return headers;
}

async function proxyJson(req, res, targetPath) {
  const target = joinUrl(apiBase, targetPath);
  try {
    const upstream = await fetch(target, {
      method: req.method,
      headers: forwardHeaders(req),
      body: req.method === "GET" ? undefined : JSON.stringify(req.body || {}),
    });
    const text = await upstream.text();
    let parsed;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch (_err) {
      parsed = { ok: false, error: text || "Invalid upstream response" };
    }
    res.status(upstream.status).json(parsed);
  } catch (err) {
    res.status(502).json({
      ok: false,
      error: `Failed to reach bot API at ${apiBase}: ${err.message}`,
    });
  }
}

app.get("/api/health", async (req, res) => {
  const target = joinUrl(apiBase, "/api/health");
  try {
    const upstream = await fetch(target, { method: "GET" });
    const text = await upstream.text();
    let parsed;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch (_err) {
      parsed = { ok: false, error: text || "Invalid upstream response" };
    }
    res.status(upstream.status).json(parsed);
  } catch (err) {
    res.status(502).json({
      ok: false,
      error: `Failed to reach bot API at ${apiBase}: ${err.message}`,
    });
  }
});

app.get("/api/state", async (req, res) => {
  const sessionId = req.query.session_id;
  if (!sessionId) {
    return res.status(400).json({ ok: false, error: "session_id is required" });
  }
  const target = joinUrl(apiBase, `/api/state?session_id=${encodeURIComponent(sessionId)}`);
  try {
    const upstream = await fetch(target, { method: "GET" });
    const text = await upstream.text();
    let parsed;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch (_err) {
      parsed = { ok: false, error: text || "Invalid upstream response" };
    }
    res.status(upstream.status).json(parsed);
  } catch (err) {
    res.status(502).json({
      ok: false,
      error: `Failed to reach bot API at ${apiBase}: ${err.message}`,
    });
  }
});

app.post("/api/new_game", async (req, res) => {
  await proxyJson(req, res, "/api/new_game");
});

app.post("/api/new_hand", async (req, res) => {
  await proxyJson(req, res, "/api/new_hand");
});

app.post("/api/action", async (req, res) => {
  await proxyJson(req, res, "/api/action");
});

app.get("*", (_req, res) => {
  res.sendFile(path.join(staticDir, "index.html"));
});

app.listen(port, () => {
  console.log(`Poker frontend listening on http://0.0.0.0:${port}`);
  console.log(`Proxying bot API -> ${apiBase}`);
});
