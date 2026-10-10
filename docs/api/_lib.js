// Shared helpers for the wishlist API (Vercel Node functions; files starting with "_" are not routes).
// Storage: Neon Postgres through the Vercel Marketplace integration (DATABASE_URL / POSTGRES_URL).
// Voters are identified by an HMAC of their IP address, never the address itself.
const crypto = require("crypto");
const { neon } = require("@neondatabase/serverless");

const url = process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.POSTGRES_URL_NON_POOLING;
const sql = url ? neon(url) : null;

// VOTE_SALT is the HMAC key; without it one is derived from the database URL (a secret as well).
const SALT = process.env.VOTE_SALT || (url ? crypto.createHash("sha256").update(url).digest("hex") : "");

let ready;
function ensure() {
  if (!sql) throw new Error("no database configured");
  ready = ready || sql`CREATE TABLE IF NOT EXISTS votes (
    kind        text NOT NULL CHECK (kind IN ('title', 'driver')),
    key         text NOT NULL,
    ip_hash     text NOT NULL,
    nickname    text NOT NULL DEFAULT 'Anonymous',
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (kind, key, ip_hash)
  )`.then(() => sql`CREATE INDEX IF NOT EXISTS votes_ip_time ON votes (ip_hash, updated_at)`);
  return ready.then(() => sql);
}

function clientIp(req) {
  const h = req.headers;
  const raw = h["x-vercel-forwarded-for"] || h["x-real-ip"] || h["x-forwarded-for"] || (req.socket && req.socket.remoteAddress) || "";
  return String(raw).split(",")[0].trim();
}

function ipHash(req) {
  return crypto.createHmac("sha256", SALT).update(clientIp(req) || "unknown").digest("hex").slice(0, 40);
}

function json(res, status, body, cache = "no-store") {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", cache);
  res.end(JSON.stringify(body));
}

// Browsers send Origin on cross-site writes; only accept our own host.
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try { return new URL(origin).host === req.headers.host; } catch (e) { return false; }
}

function cleanNickname(v) {
  const s = String(v == null ? "" : v).replace(/[\u0000-\u001f\u007f<>]/g, "").replace(/\s+/g, " ").trim().slice(0, 32);
  return s || "Anonymous";
}

const KEY_RE = { title: /^[a-z0-9_]{1,40}$/, driver: /^[a-z0-9_./-]{1,80}$/ };

// The published keys (titles and drivers that exist), fetched from our own static site and kept for 10 minutes.
let keysCache = { at: 0, data: null };
async function knownKeys(req) {
  if (keysCache.data && Date.now() - keysCache.at < 600000) return keysCache.data;
  try {
    const host = req.headers["x-forwarded-host"] || req.headers.host;
    const r = await fetch(`https://${host}/data/keys.json`);
    if (r.ok) {
      const d = await r.json();
      keysCache = { at: Date.now(), data: { title: new Set(d.titles), driver: new Set(d.drivers) } };
      return keysCache.data;
    }
  } catch (e) { /* fall back to format checks */ }
  return null;
}

async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  const chunks = [];
  for await (const c of req) chunks.push(c);
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch (e) { return {}; }
}

const hasDb = () => !!url;

module.exports = { hasDb, ensure, ipHash, json, sameOrigin, cleanNickname, KEY_RE, knownKeys, readBody };
