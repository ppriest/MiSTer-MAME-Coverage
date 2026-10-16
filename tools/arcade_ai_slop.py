#!/usr/bin/env python3
"""Build the arcade-ai-slop MiSTer Downloader database: purely references to other databases.

    python tools/arcade_ai_slop.py            # writes docs/arcade-ai-slop/, served at <site>/arcade-ai-slop/

Downloader has no "include another database" field, but it reads *drop-in* files: any ``.ini`` in
``/media/fat/downloader/`` next to ``downloader.ini`` can add database sections (see Downloader's
docs/drop-in-databases.md). So this database installs one tiny drop-in ``.ini`` per referenced database,
``downloader/<db_id>.ini``:

    [their_db_id]
    db_url = https://.../db.json.zip

and the next Downloader run then updates every referenced database like any other. Nothing from the
referenced databases is copied; the user's single entry in ``downloader.ini`` is this database.

``data/arcade_ai_slop.json`` lists the databases (``enabled: false`` keeps a candidate documented but out). Each enabled one
is fetched on every build to read its ``db_id`` (the section name must equal it); a source that cannot be
reached keeps its previous entry, and one that is not a valid database is skipped with a warning.

Output in ``--out`` (``docs/arcade-ai-slop/``, published with the site):
    db.json, db.json.zip   the Downloader database (the zip is what downloader.ini points at)
    downloader/*.ini       the drop-in files it installs
    sources-index.json     which source each drop-in came from (lets a build keep an entry while its source is down)
    sources.md             human-readable list of what is referenced
    status.json            when the last check ran, and the list the front page shows

Standard library only.
"""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import io
import json
import os
import re
import sys
import urllib.request
import zipfile

SITE = "https://mister-mame-coverage-docs.vercel.app/arcade-ai-slop"
DB_VERSION = 1      # "version" of the Downloader database format (a spec field, not a build counter)
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def fetch_db(url: str) -> dict:
    """Download a Downloader database (plain JSON or a zip holding one JSON file) and parse it."""
    req = urllib.request.Request(url, headers={"User-Agent": "arcade-ai-slop-builder"})
    with urllib.request.urlopen(req, timeout=60) as r:
        data = r.read()
    if zipfile.is_zipfile(io.BytesIO(data)):
        with zipfile.ZipFile(io.BytesIO(data)) as z:
            data = z.read(z.namelist()[0])
    return json.loads(data)


def safe_name(db_id: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]+", "_", db_id).strip("._") or "db"


def ini_text(db_id: str, db_url: str, description: str) -> str:
    desc = description.replace("'", "").replace("\n", " ")
    return f"[{db_id}]\ndb_url = {db_url}\ndescription = '{desc}'\n"


def load_previous(out: str) -> dict:
    try:
        with open(os.path.join(out, "db.json"), encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=os.path.join(ROOT, "docs", "arcade-ai-slop"))
    ap.add_argument("--base-url", default=SITE, help="where --out is served (for the file URLs inside db.json)")
    ap.add_argument("--sources", default=os.path.join(ROOT, "data", "arcade_ai_slop.json"))
    ap.add_argument("--force", action="store_true", help="publish even if nothing changed")
    a = ap.parse_args()

    with open(a.sources, encoding="utf-8") as f:
        cfg = json.load(f)
    own_id = cfg.get("db_id") or "arcade-ai-slop"
    os.makedirs(os.path.join(a.out, "downloader"), exist_ok=True)
    previous = load_previous(a.out)
    prev_files = previous.get("files", {})
    try:
        with open(os.path.join(a.out, "sources-index.json"), encoding="utf-8") as f:
            prev_source = json.load(f)         # published path -> the source db_url it came from
    except (OSError, ValueError):
        prev_source = {}

    entries: dict[str, dict] = {}        # published path -> db entry
    listing: list[dict] = []
    seen_ids: dict[str, str] = {}
    for s in cfg["sources"]:
        if not s.get("enabled", True):
            continue
        url = s["db_url"]
        try:
            db = fetch_db(url)
            db_id = db.get("db_id")
            if not db_id or not isinstance(db.get("files", {}), dict):
                raise ValueError("not a Downloader database (no db_id)")
            ncores = sum(1 for p in db.get("files", {}) if p.lower().endswith((".rbf", ".mra")))
        except Exception as e:      # unreachable or broken: keep the previous entry for this source, if any
            print(f"[warn] {s['name']}: {e}", file=sys.stderr)
            old = next(((p, prev_files[p]) for p, u in prev_source.items() if u == url and p in prev_files), None)
            if old:
                entries[old[0]] = dict(old[1], source_url=url)
                listing.append({**s, "db_id": os.path.basename(old[0])[:-4], "status": "kept previous (source unreachable)"})
            else:
                listing.append({**s, "status": "skipped (unreachable or invalid)"})
            continue
        if db_id == own_id or db_id in seen_ids:
            print(f"[warn] {s['name']}: db_id {db_id!r} is already used by {seen_ids.get(db_id, 'this database')}; skipped", file=sys.stderr)
            listing.append({**s, "db_id": db_id, "status": "skipped (duplicate db_id)"})
            continue
        seen_ids[db_id] = s["name"]
        name = safe_name(db_id)
        text = ini_text(db_id, url, s["name"])
        data = text.encode("utf-8")
        with open(os.path.join(a.out, "downloader", name + ".ini"), "wb") as f:
            f.write(data)
        path = f"downloader/{name}.ini"
        entries[path] = {"hash": hashlib.md5(data).hexdigest(), "size": len(data),
                         "url": f"{a.base_url}/{path}", "source_url": url}
        listing.append({**s, "db_id": db_id, "cores": ncores, "status": "ok"})

    # drop-in files of sources that were removed from sources.json no longer belong on the branch
    live = {os.path.basename(p) for p in entries}
    for fn in os.listdir(os.path.join(a.out, "downloader")):
        if fn not in live:
            os.remove(os.path.join(a.out, "downloader", fn))

    db = {"db_id": own_id, "db_url": f"{a.base_url}/db.json.zip", "version": DB_VERSION,
          "timestamp": int(dt.datetime.now(dt.timezone.utc).timestamp()),
          "files": dict(sorted(entries.items())), "folders": {"downloader": {}}}
    # source_url is bookkeeping (sources-index.json) for keeping an entry while its source is unreachable; not published in db.json:
    publish = {k: ({kk: vv for kk, vv in v.items() if kk != "source_url"}) for k, v in db["files"].items()}
    signature = lambda d: {p: (e["hash"], e["size"]) for p, e in d.get("files", {}).items()}
    changed = signature(db) != signature(previous) or previous.get("version") != DB_VERSION or a.force
    if changed:
        clean = dict(db, files=publish)
        with open(os.path.join(a.out, "db.json"), "w", encoding="utf-8") as f:
            json.dump(clean, f, indent=1, sort_keys=True)
        with zipfile.ZipFile(os.path.join(a.out, "db.json.zip"), "w", zipfile.ZIP_DEFLATED) as z:
            z.write(os.path.join(a.out, "db.json"), "db.json")
        with open(os.path.join(a.out, "sources-index.json"), "w", encoding="utf-8") as f:
            json.dump({p: v["source_url"] for p, v in db["files"].items()}, f, indent=1, sort_keys=True)

    now = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    with open(os.path.join(a.out, "sources.md"), "w", encoding="utf-8") as f:
        f.write(f"# {own_id}\n\n{cfg.get('description', '')}\n\nLast checked {now}.\n\n**Don't use both this and [MiSTer_Ongo](https://github.com/OngoGablogian/MiSTer_Ongo):** they overlap heavily (it republishes many of the same cores).\n\n| Database | db_id | Cores+MRAs | Status |\n|---|---|---|---|\n")
        for e in listing:
            f.write(f"| [{e['name']}]({e['home']}) | {e.get('db_id', '')} | {e.get('cores', '')} | {e['status']} |\n")
        off = [s for s in cfg["sources"] if not s.get("enabled", True)]
        if off:
            f.write("\n## Not included\n\n")
            for s in off:
                f.write(f"- [{s['name']}]({s['home']}): {s.get('note', 'disabled')}\n")
    with open(os.path.join(a.out, "status.json"), "w", encoding="utf-8") as f:
        json.dump({"checked": now, "changed": bool(changed), "databases": len(entries), "description": cfg.get("description", ""),
                   "install": f"[{own_id}]\ndb_url = {a.base_url}/db.json.zip",
                   "sources": [{"name": e["name"], "home": e["home"], "db_id": e.get("db_id"), "status": e["status"]} for e in listing]}, f, indent=1)
    print(f"{len(entries)} databases referenced; {'published' if changed else 'unchanged'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
