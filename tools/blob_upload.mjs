// Upload the hashed screenshot files made by tools/shots.py to Vercel Blob (public store).
//
//   cd tools && npm install            (once; installs @vercel/blob)
//   BLOB_READ_WRITE_TOKEN=... node blob_upload.mjs ~/mame-shots/upload
//
// Files keep their hashed names (no random suffix) and are served with a one-year immutable cache. An
// `uploaded.json` manifest next to the files records what is already in the store, so a re-run only sends new
// or changed files. Prints the store's base URL: put it in the `image-base` meta tag of docs/index.html.
import { put } from "@vercel/blob";
import { readdir, readFile, writeFile, stat } from "node:fs/promises";
import { join, extname } from "node:path";

const dir = process.argv[2];
if (!dir) { console.error("usage: node blob_upload.mjs <upload-folder>"); process.exit(2); }
if (!process.env.BLOB_READ_WRITE_TOKEN) { console.error("set BLOB_READ_WRITE_TOKEN (Vercel dashboard > Storage > your Blob store > .env.local)"); process.exit(2); }

const TYPES = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" };
const manifestPath = join(dir, "uploaded.json");
let manifest = {};
try { manifest = JSON.parse(await readFile(manifestPath, "utf8")); } catch { /* first run */ }

const files = (await readdir(dir)).filter(f => TYPES[extname(f).toLowerCase()]);
let sent = 0, skipped = 0, failed = 0, base = manifest.__base || "";
let next = 0;
async function worker() {
  while (next < files.length) {
    const f = files[next++];
    const size = (await stat(join(dir, f))).size;
    if (manifest[f] === size) { skipped++; continue; }
    try {
      const r = await put(f, await readFile(join(dir, f)), {
        access: "public", addRandomSuffix: false, allowOverwrite: true,
        contentType: TYPES[extname(f).toLowerCase()], cacheControlMaxAge: 31536000,
      });
      base = base || r.url.slice(0, r.url.lastIndexOf("/"));
      manifest[f] = size; sent++;
    } catch (e) { failed++; console.error(`${f}: ${e.message}`); }
    if ((sent + skipped + failed) % 200 === 0) console.log(`${sent + skipped + failed}/${files.length}`);
  }
}
await Promise.all(Array.from({ length: 6 }, worker));
manifest.__base = base;
await writeFile(manifestPath, JSON.stringify(manifest));
console.log(`${sent} uploaded, ${skipped} already there, ${failed} failed (of ${files.length})`);
console.log(`image base URL: ${base}`);
process.exit(failed ? 1 : 0);
