#!/usr/bin/env python3
"""Build the arcade-ai-slop contributor list: the downloader.ini sections of the source-available AI-assisted arcade
cores' databases, ready to paste.

    python tools/arcade_ai_slop.py            # writes docs/arcade-ai-slop/, served at <site>/arcade-ai-slop/

Downloader databases can neither reference other databases (a database may not install ``downloader/*.ini`` drop-ins) nor
share files with them (the database id, i.e. the ``.ini`` section, owns the files in it), so this is not a database. It is a
curated list: each enabled source in ``data/arcade_ai_slop.json`` is fetched to read its ``db_id`` (the section name has to
equal it), and one section per contributor is written:

    [their_db_id]
    db_url = https://.../db.json.zip
    description = 'Name'

Every contributor keeps their own database id. The front page shows the sections with copy buttons, and
``downloader_arcade-ai-slop.ini`` holds all of them: a user can paste them into ``downloader.ini`` or save the file next to it
as a drop-in. A source that cannot be fetched keeps the section it had last time; one that is not a valid database is skipped.

Output in ``--out`` (``docs/arcade-ai-slop/``, published with the site):
    downloader_arcade-ai-slop.ini   every section, one per contributor
    sources.md                      human-readable list
    status.json                     when the last check ran and the list the front page shows (with each section's text)

Standard library only.
"""
from __future__ import annotations

import argparse
import datetime as dt
import io
import json
import os
import sys
import urllib.request
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
INI_NAME = "downloader_arcade-ai-slop.ini"


def fetch_db_id(url: str) -> str:
    """Download a Downloader database (plain JSON or a zip holding one JSON file) and return its db_id."""
    req = urllib.request.Request(url, headers={"User-Agent": "arcade-ai-slop-builder"})
    with urllib.request.urlopen(req, timeout=90) as r:
        data = r.read()
    if zipfile.is_zipfile(io.BytesIO(data)):
        with zipfile.ZipFile(io.BytesIO(data)) as z:
            data = z.read(z.namelist()[0])
    db = json.loads(data)
    if not db.get("db_id") or not isinstance(db.get("files"), dict):
        raise ValueError("not a Downloader database (needs db_id and files)")
    return str(db["db_id"])


def section(db_id: str, url: str, name: str) -> str:
    desc = name.replace("'", "").replace("\n", " ")
    return f"[{db_id}]\ndb_url = {url}\ndescription = '{desc}'\n"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=os.path.join(ROOT, "docs", "arcade-ai-slop"))
    ap.add_argument("--sources", default=os.path.join(ROOT, "data", "arcade_ai_slop.json"))
    a = ap.parse_args()

    with open(a.sources, encoding="utf-8") as f:
        cfg = json.load(f)
    os.makedirs(a.out, exist_ok=True)
    try:
        with open(os.path.join(a.out, "status.json"), encoding="utf-8") as f:
            before = {s["db_url"]: s for s in json.load(f).get("sources", []) if s.get("section")}
    except (OSError, ValueError, KeyError):
        before = {}

    listing: list[dict] = []
    seen: dict[str, str] = {}
    for s in cfg["sources"]:
        if not s.get("enabled", True):
            continue
        url = s["db_url"]
        try:
            db_id = fetch_db_id(url)
            text, status = section(db_id, url, s["name"]), "ok"
        except Exception as e:                      # unreachable or broken: keep last time's section, if there was one
            print(f"[warn] {s['name']}: {e}", file=sys.stderr)
            old = before.get(url)
            if not old:
                listing.append({**s, "status": "skipped (unreachable or invalid)"})
                continue
            db_id, text, status = old["db_id"], old["section"], "kept previous (source unreachable)"
        if db_id.lower() in seen:
            print(f"[warn] {s['name']}: db_id {db_id!r} is already used by {seen[db_id.lower()]}; skipped", file=sys.stderr)
            listing.append({**s, "db_id": db_id, "status": "skipped (duplicate db_id)"})
            continue
        seen[db_id.lower()] = s["name"]
        listing.append({**s, "db_id": db_id, "section": text, "status": status})

    live = [e for e in listing if e.get("section")]
    install = "\n".join(e["section"] for e in live)
    with open(os.path.join(a.out, INI_NAME), "w", encoding="utf-8") as f:
        f.write(install)
    now = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    with open(os.path.join(a.out, "sources.md"), "w", encoding="utf-8") as f:
        f.write(f"# arcade-ai-slop\n\n{cfg.get('description', '')}\n\nLast checked {now}.\n\n"
                "**Don't use both these and [MiSTer_Ongo](https://github.com/OngoGablogian/MiSTer_Ongo):** they overlap heavily "
                "(it republishes many of the same cores).\n\n| Database | db_id | Status |\n|---|---|---|\n")
        for e in listing:
            f.write(f"| [{e['name']}]({e['home']}) | {e.get('db_id', '')} | {e['status']} |\n")
        off = [s for s in cfg["sources"] if not s.get("enabled", True)]
        if off:
            f.write("\n## Not included\n\n")
            for s in off:
                f.write(f"- [{s['name']}]({s['home']}): {s.get('note', 'disabled')}\n")
    with open(os.path.join(a.out, "status.json"), "w", encoding="utf-8") as f:
        json.dump({"checked": now, "databases": len(live), "description": cfg.get("description", ""), "install": install, "ini": INI_NAME,
                   "sources": [{"name": e["name"], "home": e["home"], "db_id": e.get("db_id"), "db_url": e["db_url"],
                                "section": e.get("section"), "status": e["status"]} for e in listing]}, f, indent=1)
    print(f"{len(live)} databases listed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
