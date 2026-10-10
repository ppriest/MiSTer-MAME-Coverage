// Upload the screenshots named in data/images.json (made by tools/shots.py) to a public Vercel Blob store.
//
//   cd tools && npm install            (once; installs @vercel/blob)
//   BLOB_READ_WRITE_TOKEN=... node blob_upload.mjs <upload-folder> [--dry-run] [--limit N] [--index images.json]
//
// Only files images.json names are sent (parent sets that are titles on the page); anything else in the folder
// stays local. Files keep their hashed names (no random suffix, overwriting allowed) with a one-year cache.
// `uploaded.json` in the folder records the store and the SHA-256 of each file sent, so a re-run sends only new or
// changed files. Each file sent is one Blob advanced operation (Hobby includes 2,000 a month): --dry-run counts
// them, --limit sends at most N. Prints the store's base URL for the `image-base` meta tag of docs/index.html.
import { put } from "@vercel/blob";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const { values: opt, positionals: [dir] } = parseArgs({ allowPositionals: true, options: {
  "dry-run": { type: "boolean" }, limit: { type: "string" },
  index: { type: "string", default: join(dirname(fileURLToPath(import.meta.url)), "..", "data", "images.json") },
} });
if (!dir) { console.error("usage: node blob_upload.mjs <upload-folder> [--dry-run] [--limit N] [--index images.json]"); process.exit(2); }
const token = (process.env.BLOB_READ_WRITE_TOKEN || "").trim();
if (!token && !opt["dry-run"]) { console.error("set BLOB_READ_WRITE_TOKEN (Vercel dashboard > Storage > your Blob store > .env.local)"); process.exit(2); }
const store = token.split("_")[3] || "";   // vercel_blob_rw_<store id>_<secret>; the id is public (it is in the URLs)

const TYPES = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" };
const files = [...new Set(Object.values(JSON.parse(await readFile(opt.index, "utf8"))).flatMap(Object.values))].sort();
const manifestPath = join(dir, "uploaded.json");
let manifest = {};
try { manifest = JSON.parse(await readFile(manifestPath, "utf8")); } catch { /* first run */ }
if (!manifest.files || (store && manifest.store !== store)) manifest = { store, base: "", files: {} };  // new store: send all

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
      const r = await put(f, await readFile(join(dir, f)), {
        token, access: "public", addRandomSuffix: false, allowOverwrite: true,
        contentType: TYPES[extname(f).toLowerCase()], cacheControlMaxAge: 31536000,
      });
      manifest.base ||= r.url.slice(0, r.url.lastIndexOf("/"));
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
