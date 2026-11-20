// Upload the screenshots named in data/images.json (made by tools/shots.py) to a public Vercel Blob store or
// Cloudflare R2 bucket.
//
//   cd tools && npm install            (once; installs @vercel/blob and aws4fetch)
//   BLOB_READ_WRITE_TOKEN=... node blob_upload.mjs <upload-folder> [--dry-run] [--limit N] [--index images.json]
//   R2_ACCOUNT_ID=... R2_ACCESS_KEY_ID=... R2_SECRET_ACCESS_KEY=... R2_BUCKET=... R2_PUBLIC_URL=... //     node blob_upload.mjs <upload-folder> --target r2 [...]
//
// Only files images.json names are sent (parent sets that are titles on the page); anything else in the folder
// stays local. Files keep their hashed names at the root of the store (no random suffix, overwriting allowed) with
// a one-year cache, so both targets serve the same paths and switching is a change of base URL.
// `uploaded.json` (Vercel) or `uploaded-r2.json` in the folder records the store and the SHA-256 of each file sent,
// so a re-run sends only new or changed files. Each file sent is one Blob advanced operation (Hobby includes 2,000
// a month) or one R2 Class A operation (1 million a month free): --dry-run counts them, --limit sends at most N.
// Prints the base URL for the `image-base` meta tag of docs/index.html.
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const { values: opt, positionals: [dir] } = parseArgs({ allowPositionals: true, options: {
  "dry-run": { type: "boolean" }, limit: { type: "string" }, target: { type: "string", default: "vercel" },
  index: { type: "string", default: join(dirname(fileURLToPath(import.meta.url)), "..", "data", "images.json") },
} });
if (!dir || !["vercel", "r2"].includes(opt.target)) {
  console.error("usage: node blob_upload.mjs <upload-folder> [--target vercel|r2] [--dry-run] [--limit N] [--index images.json]"); process.exit(2);
}
const env = k => (process.env[k] || "").trim();   // a CRLF env file would otherwise leave a carriage return on each value
const CACHE = 31536000;
let store, base, put;
if (opt.target === "vercel") {
  const token = env("BLOB_READ_WRITE_TOKEN");
  if (!token && !opt["dry-run"]) { console.error("set BLOB_READ_WRITE_TOKEN (Vercel dashboard > Storage > your Blob store > .env.local)"); process.exit(2); }
  store = token.split("_")[3] || "";   // vercel_blob_rw_<store id>_<secret>; the id is public (it is in the URLs)
  base = store && `https://${store.toLowerCase()}.public.blob.vercel-storage.com`;
  const blob = await import("@vercel/blob");
  put = (f, body, contentType) => blob.put(f, body, {
    token, access: "public", addRandomSuffix: false, allowOverwrite: true, contentType, cacheControlMaxAge: CACHE,
  });
} else {
  const need = ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET", "R2_PUBLIC_URL"];
  const unset = need.filter(k => !env(k));
  if (unset.length && !opt["dry-run"]) {
    console.error(`set ${unset.join(", ")} (Cloudflare dashboard > R2: the bucket, its public r2.dev URL or custom domain, and an API token with Object Read & Write on it)`);
    process.exit(2);
  }
  store = env("R2_ACCOUNT_ID") && `${env("R2_ACCOUNT_ID")}/${env("R2_BUCKET")}`;
  base = env("R2_PUBLIC_URL").replace(/\/+$/, "");
  const { AwsClient } = await import("aws4fetch");
  const r2 = new AwsClient({ accessKeyId: env("R2_ACCESS_KEY_ID"), secretAccessKey: env("R2_SECRET_ACCESS_KEY"), service: "s3", region: "auto" });
  const endpoint = `https://${env("R2_ACCOUNT_ID")}.r2.cloudflarestorage.com/${env("R2_BUCKET")}`;
  put = async (f, body, contentType) => {
    const r = await r2.fetch(`${endpoint}/${encodeURIComponent(f)}`, { method: "PUT", body,
      headers: { "Content-Type": contentType, "Cache-Control": `public, max-age=${CACHE}` } });
    if (!r.ok) throw new Error(`HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
  };
}

const TYPES = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" };
const files = [...new Set(Object.values(JSON.parse(await readFile(opt.index, "utf8"))).flatMap(Object.values).filter(v => typeof v === "string"))].sort();      // (floorplans.json also has sizes)
const manifestPath = join(dir, opt.target === "vercel" ? "uploaded.json" : `uploaded-${opt.target}.json`);
let manifest = {};
try { manifest = JSON.parse(await readFile(manifestPath, "utf8")); } catch { /* first run */ }
if (!manifest.files || (store && manifest.store !== store)) manifest = { store, base, files: {} };  // new store: send all

const todo = [];
let missing = 0;
for (const f of files) {
  let sha;
  try { sha = createHash("sha256").update(await readFile(join(dir, f))).digest("hex"); }
  catch { missing++; console.error(`${f}: named in ${opt.index} but not in ${dir}`); continue; }
  if (manifest.files[f] !== sha) todo.push([f, sha]);
}
const send = opt.limit ? todo.slice(0, Number(opt.limit)) : todo;
console.log(`${files.length} files in images.json: ${files.length - missing - todo.length} already in the store, ${todo.length} to send` +
  (missing ? `, ${missing} missing` : "") + (send.length < todo.length ? `; sending ${send.length} (--limit)` : ""));
if (opt["dry-run"]) process.exit(missing ? 1 : 0);

let next = 0, sent = 0, failed = 0, saving = Promise.resolve();
const save = () => (saving = saving.then(() => writeFile(manifestPath, JSON.stringify(manifest))));
async function worker() {
  while (next < send.length) {
    const [f, sha] = send[next++];
    try {
      const r = await put(f, await readFile(join(dir, f)), TYPES[extname(f).toLowerCase()]);
      manifest.base = r?.url ? r.url.slice(0, r.url.lastIndexOf("/")) : base;
      manifest.files[f] = sha;
      if (++sent % 500 === 0) { save(); console.log(`${sent}/${send.length}`); }
    } catch (e) { failed++; console.error(`${f}: ${e.message}`); }
  }
}
await Promise.all(Array.from({ length: 6 }, worker));
await save();
console.log(`${sent} uploaded, ${failed} failed, ${todo.length - send.length} left for a later run`);
console.log(`image base URL: ${manifest.base || "(known after the first upload)"}`);
process.exit(failed || missing ? 1 : 0);
