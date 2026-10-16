#!/usr/bin/env python3
"""Build the arcade-ai-slop MiSTer Downloader database: one database that carries the files of many others.

    python tools/arcade_ai_slop.py            # writes docs/arcade-ai-slop/, served at <site>/arcade-ai-slop/

Downloader databases cannot reference other databases (a database may not install ``downloader/*.ini`` drop-ins:
"Path can't contain root folders"), so this one is a *merged* database. Each enabled source in
``data/arcade_ai_slop.json`` is fetched, and its ``files`` and ``folders`` are folded into one ``db.json``. Nothing is
copied: every file entry keeps the source's own md5, size and an absolute URL (the source's ``base_files_url`` plus the
path, or its per-file ``url``), so the contributors' repositories stay the single source of truth. Tags are re-numbered into
one ``tag_dictionary``. The daily build keeps it current, and a contributor is added by editing the list: users only ever
add this one database.

Rules:
  * the first source in the list wins a path that two sources both ship (reported in ``sources.md``);
  * a source that cannot be fetched keeps the files it contributed last time (``sources-index.json`` records them);
  * a source that is not a valid database, or that uses zip archives (not merged), is skipped with a warning.

Output in ``--out`` (``docs/arcade-ai-slop/``, published with the site):
    db.json, db.json.zip   the Downloader database (the zip is what downloader.ini points at)
    sources.md             human-readable list of what is merged
    status.json            when the last check ran, and the list the front page shows
    sources-index.json     per source: the files and folders it contributed (lets a build survive a source being down)

Standard library only.
"""
from __future__ import annotations

import argparse
import datetime as dt
import io
import json
import os
import sys
import urllib.parse
import urllib.request
import zipfile

SITE = "https://mister-mame-coverage-docs.vercel.app/arcade-ai-slop"
DB_VERSION = 1      # "v": the version of the Downloader database format (the field Downloader reads), not a build counter
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def fetch_db(url: str) -> dict:
    """Download a Downloader database (plain JSON or a zip holding one JSON file) and parse it."""
    req = urllib.request.Request(url, headers={"User-Agent": "arcade-ai-slop-builder"})
    with urllib.request.urlopen(req, timeout=90) as r:
        data = r.read()
    if zipfile.is_zipfile(io.BytesIO(data)):
        with zipfile.ZipFile(io.BytesIO(data)) as z:
            data = z.read(z.namelist()[0])
    return json.loads(data)


def contribution(db: dict) -> dict:
    """The source's files and folders as self-contained entries: absolute URLs, tags as names (not indices)."""
    names = {i: n for n, i in (db.get("tag_dictionary") or {}).items()}
    base = db.get("base_files_url") or ""

    def convert(entry: dict, path: str | None) -> dict:
        e = dict(entry)
        if "tags" in e:
            e["tags"] = [names.get(t, t) for t in e["tags"]]
        if path is not None and not e.get("url"):
            if not base:
                raise ValueError(f"file {path!r} has no url and the database has no base_files_url")
            e["url"] = base + urllib.parse.quote(path)
        return e

    return {"files": {p: convert(e, p) for p, e in db.get("files", {}).items()},
            "folders": {p: convert(e, None) for p, e in db.get("folders", {}).items()}}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=os.path.join(ROOT, "docs", "arcade-ai-slop"))
    ap.add_argument("--base-url", default=SITE, help="where --out is served (the db_url inside db.json)")
    ap.add_argument("--sources", default=os.path.join(ROOT, "data", "arcade_ai_slop.json"))
    ap.add_argument("--force", action="store_true", help="publish even if nothing changed")
    a = ap.parse_args()

    with open(a.sources, encoding="utf-8") as f:
        cfg = json.load(f)
    own_id = cfg.get("db_id") or "arcade-ai-slop"
    os.makedirs(a.out, exist_ok=True)

    def load(name: str, default):
        try:
            with open(os.path.join(a.out, name), encoding="utf-8") as f:
                return json.load(f)
        except (OSError, ValueError):
            return default
    previous = load("db.json", {})
    kept = load("sources-index.json", {})             # db_url -> {"files": ..., "folders": ...} contributed last time

    merged: list[tuple[dict, dict]] = []               # (source config, contribution) in list order
    listing: list[dict] = []
    index: dict[str, dict] = {}
    for s in cfg["sources"]:
        if not s.get("enabled", True):
            continue
        url = s["db_url"]
        try:
            db = fetch_db(url)
            if not db.get("db_id") or not isinstance(db.get("files"), dict) or not isinstance(db.get("folders"), dict):
                raise ValueError("not a Downloader database (needs db_id, files and folders)")
            if db.get("zips") or db.get("archives"):
                raise ValueError("uses zip archives, which are not merged")
            c = contribution(db)
            status = "ok"
            db_id = db["db_id"]
        except Exception as e:                         # unreachable or broken: keep what this source gave last time
            print(f"[warn] {s['name']}: {e}", file=sys.stderr)
            if url in kept:
                c, status, db_id = kept[url]["contribution"], "kept previous (source unreachable)", kept[url].get("db_id", "")
            else:
                listing.append({**s, "status": "skipped (unreachable or invalid)"})
                continue
        index[url] = {"db_id": db_id, "contribution": c}
        merged.append((s, c))
        listing.append({**s, "db_id": db_id, "files": len(c["files"]), "status": status})

    # fold everything into one database; the first source wins a path two sources ship
    tags: dict[str, int] = {}
    files: dict[str, dict] = {}
    folders: dict[str, dict] = {}
    owner: dict[str, str] = {}
    clashes: list[str] = []

    def encode_tags(e: dict) -> dict:
        e = dict(e)
        if "tags" in e:
            e["tags"] = [tags.setdefault(t, len(tags)) if isinstance(t, str) else t for t in e["tags"]]
        return e

    for s, c in merged:
        for p, e in c["files"].items():
            key = p.lower()
            if key in owner:
                clashes.append(f"`{p}` is shipped by {owner[key]} and {s['name']}; {owner[key]} wins")
                continue
            owner[key] = s["name"]
            files[p] = encode_tags(e)
        for p, e in c["folders"].items():
            folders.setdefault(p, encode_tags(e))
    for p in files:                                    # every parent folder of a file is listed
        parts = p.split("/")[:-1]
        for i in range(1, len(parts) + 1):
            folders.setdefault("/".join(parts[:i]), {})

    db = {"db_id": own_id, "db_url": f"{a.base_url}/db.json.zip", "v": DB_VERSION,
          "timestamp": int(dt.datetime.now(dt.timezone.utc).timestamp()),
          "tag_dictionary": tags, "files": dict(sorted(files.items())), "folders": dict(sorted(folders.items()))}
    sig = lambda d: (json.dumps(d.get("files"), sort_keys=True), json.dumps(d.get("folders"), sort_keys=True), d.get("v"))
    changed = sig(db) != sig(previous) or a.force
    if changed:
        with open(os.path.join(a.out, "db.json"), "w", encoding="utf-8") as f:
            json.dump(db, f, sort_keys=True, separators=(",", ":"))
        with zipfile.ZipFile(os.path.join(a.out, "db.json.zip"), "w", zipfile.ZIP_DEFLATED) as z:
            z.write(os.path.join(a.out, "db.json"), "db.json")
        with open(os.path.join(a.out, "sources-index.json"), "w", encoding="utf-8") as f:
            json.dump(index, f, sort_keys=True, separators=(",", ":"))

    now = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    with open(os.path.join(a.out, "sources.md"), "w", encoding="utf-8") as f:
        f.write(f"# {own_id}\n\n{cfg.get('description', '')}\n\nLast checked {now}. {len(files)} files from {len(merged)} databases.\n\n"
                "**Don't use both this and [MiSTer_Ongo](https://github.com/OngoGablogian/MiSTer_Ongo):** they overlap heavily "
                "(it republishes many of the same cores).\n\n| Database | db_id | Files | Status |\n|---|---|---|---|\n")
        for e in listing:
            f.write(f"| [{e['name']}]({e['home']}) | {e.get('db_id', '')} | {e.get('files', '')} | {e['status']} |\n")
        if clashes:
            f.write("\n## Path clashes\n\n" + "".join(f"- {c}\n" for c in clashes))
        off = [s for s in cfg["sources"] if not s.get("enabled", True)]
        if off:
            f.write("\n## Not included\n\n")
            for s in off:
                f.write(f"- [{s['name']}]({s['home']}): {s.get('note', 'disabled')}\n")
    with open(os.path.join(a.out, "status.json"), "w", encoding="utf-8") as f:
        json.dump({"checked": now, "changed": bool(changed), "databases": len(merged), "files": len(files), "description": cfg.get("description", ""),
                   "install": f"[{own_id}]\ndb_url = {a.base_url}/db.json.zip",
                   "sources": [{"name": e["name"], "home": e["home"], "db_id": e.get("db_id"), "status": e["status"]} for e in listing]}, f, indent=1)
    print(f"{len(files)} files from {len(merged)} databases; {'published' if changed else 'unchanged'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
