---
name: mame-screenshots
description: Refresh the hover screenshots (title screens and in-game snaps) of the MiSTer × MAME coverage page. Downloads the Progetto-SNAPS (progettosnaps) Snap and Titles packs, extracts them, hashes the names with tools/shots.py, uploads the images to Vercel Blob, sets the image-base URL and opens a PR. Use when asked to update or refresh the screenshots, snaps, titles or hover images, fetch new progettosnaps packs, or upload images to blob.
---

# Refresh the hover screenshots

Progetto-SNAPS zips → `<work>/src/{ingame,title}/<set>.png` → hashed copies in `<work>/upload` and
`data/images.json` → Vercel Blob → `image-base` meta in `docs/index.html` → PR. The page reads each title's
`img` from `docs/data/coverage.json`, which `mmc report` (the daily build, `.github/workflows/update.yml`) merges
in from `data/images.json`.

## Rules

- **Nothing but `data/images.json` and `docs/index.html` is committed by this pipeline.** Images, zips, the
  upload folder, `uploaded.json` and secrets stay in the work folder. Before every commit `git status --short`
  must list nothing else (no `*.png *.zip *.7z secrets.env uploaded.json`).
- **Secrets** live in `<work>/secrets.env`, outside the repository, one `KEY=value` per line: `IMAGE_SALT` and
  `BLOB_READ_WRITE_TOKEN`. Load them only inside the command that needs them, with
  `set -a; . <(tr -d '\r' < "$WORK/secrets.env"); set +a`. Never `cat`, `echo`, `env`, `set -x` or log them; check
  presence with `grep -c '^IMAGE_SALT=' "$WORK/secrets.env"`.
- **No `IMAGE_SALT`: stop and ask.** Never make a new one while `images.json` has entries: a new salt renames
  every file, so everything is uploaded again and the old blobs are orphaned.
- **Ask first** before: `snaps_fetch.py --full`; deleting anything in the work folder; deleting blobs; an upload
  of more than 2,000 files on a Vercel Hobby team; pointing `image-base` at a different store; pushing or opening
  the PR.

## Setup

- Work folder: `D:/mame-shots` on the maintainer's Windows machine; elsewhere ask. `WORK=D:/mame-shots`.
- Python 3.10+ (stdlib only). 7-Zip (`7z`, or `C:\Program Files\7-Zip\7z.exe`) or bsdtar (Windows 10+ `tar.exe`):
  the full sets keep their images in a `.7z` inside the zip.
- Node 20+. If `node` is not on PATH, use the portable copy:
  `export PATH="$(ls -d "$WORK"/node/node-*/ | tail -1):$PATH"`. Once: `cd tools && npm install`.
- A **public** Vercel Blob store (Vercel → Storage → Create → Blob → access Public). Its `BLOB_READ_WRITE_TOKEN`
  (store → `.env.local`) goes into `secrets.env`.

## A + B. Download and extract

```bash
python3 -I tools/snaps_fetch.py --work "$WORK"
```

- Reads https://www.progettosnaps.net/snapshots/ for the newest `pS_snap_fullset_<v>`, `pS_snap_upd_<v>`,
  `pS_titles_fullset_<v>`, `pS_titles_upd_<v>`; the `+SL` (software list) and other packs are ignored. The page
  links `/download/?tipo=…&file=<zip url>`; the zip URL is fetched directly, no Referer or cookie needed.
- `src/versions.json` records the MAME version each folder is at. Later runs apply only the newer update zips, in
  order. The server keeps only the last few updates; if one in the gap is gone, the folder is rebuilt from the
  newest full set plus the updates after it. Zips in `downloads/` are reused.
- If the page changes: `--snap-full --snap-upd --titles-full --titles-upd`, each a URL or a local zip named
  `…_<version>.zip`.
- Report the per-zip lines (images, replaced, new, before → after). "at N, newest N" for both packs means nothing
  new: stop unless `docs/data/keys.json` changed (then run C, which may add sets).

## C. Hash and index

```bash
(set -a; . <(tr -d '\r' < "$WORK/secrets.env"); set +a; python3 -I tools/shots.py --src "$WORK/src" --out "$WORK/upload")
```

Copies each image of a set in `keys.json` unchanged under `HMAC(IMAGE_SALT, "<kind>/<set>")[:24]` and rewrites
`data/images.json` from scratch. Check that every file it names is in the upload folder:

```bash
python3 -I -c "import json,os,sys; d=json.load(open('data/images.json')); up=set(os.listdir(sys.argv[1])); f=[x for v in d.values() for x in v.values()]; print(len(d),'sets',len(f),'files',sum(x not in up for x in f),'missing')" "$WORK/upload"
```

## D. Upload

```bash
cd tools
(set -a; . <(tr -d '\r' < "$WORK/secrets.env"); set +a; node blob_upload.mjs "$WORK/upload" --dry-run)
(set -a; . <(tr -d '\r' < "$WORK/secrets.env"); set +a; node blob_upload.mjs "$WORK/upload")
```

- Run `--dry-run` first and give the user the count. Each file sent is one Blob advanced operation: Hobby
  includes 2,000 a month and blocks Blob for 30 days past that (ask, then `--limit N`); Pro bills about $5 per
  million.
- Only files named in `images.json` are sent. `uploaded.json` (store id and SHA-256 per file) skips what is
  already there; a different token's store starts over.
- It prints `image base URL: https://<store>.public.blob.vercel-storage.com`. Check three files:

```bash
BASE=<printed base URL>
for f in $(python3 -I -c "import json; d=json.load(open('data/images.json')); print(*[x for v in list(d.values())[:2] for x in v.values()][:3])"); do curl -sSI "$BASE/$f" | grep -iE '^(HTTP|content-type|cache-control)'; done
```

  Expect `200`, `image/png`, `Cache-Control: public, max-age=31536000` (Blob sets only the max-age; it has no
  option for `immutable`).

## E. Publish

1. Put the base URL in `<meta name="image-base" content="…">` in `docs/index.html` (the only place it is set).
2. Check in a browser. The committed `coverage.json` gets `img` only at the next daily build, so serve a scratch
   copy of `docs/` with it merged in (what `mmc report` does), then open http://localhost:8000:

   ```bash
   T=$(mktemp -d); cp -r docs "$T/docs"
   python3 -I -c "import json,sys; p=sys.argv[1]; c=json.load(open(p,encoding='utf-8')); i=json.load(open('data/images.json')); [t.__setitem__('img',i[t['name']]) for t in c['titles'] if t['name'] in i]; json.dump(c,open(p,'w',encoding='utf-8'),ensure_ascii=False,separators=(',',':'))" "$T/docs/data/coverage.json"
   python3 -m http.server -d "$T/docs" 8000
   ```

   Hovering a title with images shows both side by side at native size (shrunk only if the window is too
   narrow); a title without images shows nothing and requests nothing from the store.
3. New branch from the branch that has the hover feature (`main` once it is merged), stage only
   `data/images.json docs/index.html`, check `git status --short`, commit, then ask before
   `git push` and `gh pr create`. The hover goes live after the merge and the next daily build.

## Notes

- File names hash kind and set, not content. An image that a later update replaces keeps its name and is
  overwritten in the store; the CDN serves the new one within about a minute, but a browser that cached the old
  one keeps it until its one-year cache runs out.
- Blobs of sets that leave `images.json` stay in the store; removing them (`del()`) is free but ask first.
