"""Genre for every title, from the best source available, cascaded parent <-> clones, and remapped
to a short common vocabulary that is editable in ``data/genre_map.json``.

Sources, in order of preference:

1. ``catver.ini``, the MAME category file maintained by progettosnaps. A current copy placed at
   ``data/catver.ini`` wins; otherwise the copy libretro vendors (based on catver 0.239) is
   downloaded. Entries look like ``sf2=Fighter / Versus`` and may carry ``* Mature *``.
2. The MiSTer Arcade Database (``MiSTer-devel/ArcadeDatabase_MiSTer``, ``ArcadeDatabase.csv``),
   the curated per-MRA metadata the Arcade Organizer uses; same vocabulary with `` - ``.
3. The ``<category>`` tag of the MRAs themselves (135 spellings across the sources; kept in the
   ledger so ``report`` needs no repositories).

A set with no category from any source takes its parent's, then any clone's.
"""
from __future__ import annotations

import collections
import csv
import html
import json
import os
import re
import urllib.request

from . import paths

# catver.ini copies reachable on GitHub, most recent category data first. progettosnaps itself
# (the origin) publishes a current file; put one at data/catver.ini and it takes precedence.
# The mame2003-plus copy is based on catver 0.239 but lists only that core's ~5k sets; the
# mame2016 copy is older (MAME 0.17x) but covers ~35k sets. Merged in this order, first wins.
CATVER_URLS = [
    ("mame2003plus", "https://raw.githubusercontent.com/libretro/mame2003-plus-libretro/master/metadata/catver.ini"),
    ("mame2016", "https://raw.githubusercontent.com/libretro/mame2016-libretro/master/metadata/catver.ini"),
]
MAD_CSV_URL = "https://raw.githubusercontent.com/MiSTer-devel/ArcadeDatabase_MiSTer/main/ArcadeDatabase.csv"
GENRE_MAP = os.path.join(paths.DATA, "genre_map.json")
GENRE_OVERRIDES = os.path.join(paths.DATA, "genre_overrides.json")


def _fetch(url: str, dest: str) -> str | None:
    if os.path.exists(dest):
        return dest
    try:
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        with urllib.request.urlopen(url, timeout=60) as r, open(dest, "wb") as f:
            f.write(r.read())
        return dest
    except Exception as e:
        print(f"[genre] could not fetch {url}: {e}")
        return None


def _parse_catver(path: str) -> tuple[dict[str, str], str]:
    out: dict[str, str] = {}
    origin = ""
    section = None
    with open(path, encoding="utf-8", errors="replace") as f:
        for line in f:
            line = line.strip()
            if line.startswith(";") and not origin:
                origin = line.lstrip("; #").strip()
            if line.startswith("[") and line.endswith("]"):
                section = line[1:-1].lower()
                continue
            if section == "category" and "=" in line:
                k, v = line.split("=", 1)
                out[k.strip().lower()] = v.strip()
    return out, origin or os.path.basename(path)


def load_catver() -> tuple[dict[str, str], str]:
    """``{set: raw category}`` merged from data/catver.ini (if present) and the GitHub copies,
    first source wins per set. The origin string lists what was used."""
    merged: dict[str, str] = {}
    origins = []
    local = os.path.join(paths.DATA, "catver.ini")
    sources = [("local", local)] if os.path.exists(local) else []
    for name, url in CATVER_URLS:
        path = _fetch(url, os.path.join(paths.CACHE, f"catver_{name}.ini"))
        if path:
            sources.append((name, path))
    for name, path in sources:
        cats, origin = _parse_catver(path)
        added = 0
        for k, v in cats.items():
            if k not in merged:
                merged[k] = v
                added += 1
        origins.append(f"{name}: {origin} ({len(cats)} sets, {added} used)")
    return merged, "; ".join(origins)


def load_mad() -> dict[str, str]:
    """``{set: raw category}`` from the MiSTer Arcade Database CSV."""
    path = _fetch(MAD_CSV_URL, os.path.join(paths.CACHE, "ArcadeDatabase.csv"))
    out: dict[str, str] = {}
    if not path:
        return out
    with open(path, encoding="utf-8-sig", errors="replace", newline="") as f:
        for row in csv.DictReader(f):
            s, c = (row.get("setname") or "").strip().lower(), (row.get("category") or "").strip()
            if s and c:
                out[s] = html.unescape(c)
    return out


# --- remapping ---------------------------------------------------------------------------------

def load_map() -> dict:
    with open(GENRE_MAP, encoding="utf-8") as f:
        return json.load(f)


def normalize(raw: str) -> tuple[str, bool]:
    """Lower-case, HTML-unescape, unify the separators the sources use, and split off the
    ``* Mature *`` marker. ``"Shooter - Flying Vertical"`` -> ``("shooter/flying vertical", False)``."""
    s = html.unescape(raw or "").strip()
    mature = bool(re.search(r"\*\s*mature\s*\*", s, re.I))
    s = re.sub(r"\*\s*mature\s*\*", "", s, flags=re.I)
    s = s.lower().replace("’", "'").replace("‘", "'")
    s = re.sub(r"\s*(?:/|\s-\s|>|:)\s*", "/", s)
    s = re.sub(r"\s+", " ", s).strip(" /")
    return s, mature


def remap(raw: str, gmap: dict) -> tuple[str | None, bool]:
    """Common genre for a raw category string, or None when the string says nothing
    (``"Arcade"``, ``"Tests"``)."""
    key, mature = normalize(raw)
    if not key:
        return None, mature
    if key in gmap.get("ignore", []) or any(key.startswith(x) for x in gmap.get("ignore_prefix", [])):
        return None, mature
    full = gmap.get("full", {})
    if key in full:
        return full[key], mature
    main = key.split("/", 1)[0].strip()
    if main in full:
        return full[main], mature
    mains = gmap.get("main", {})
    if main in mains:
        return mains[main], mature
    for prefix, genre in gmap.get("prefix", {}).items():
        if key.startswith(prefix):
            return genre, mature
    return gmap.get("default", "Other"), mature


def resolve(machines: dict, mra_categories: dict[str, dict[str, str]]) -> tuple[dict[str, dict], dict]:
    """``{set: {"genre", "raw", "source", "mature"}}`` for every machine, plus a summary with the
    raw strings that fell through to the default so the map can be extended."""
    gmap = load_map()
    catver, catver_origin = load_catver()
    mad = load_mad()
    mra_pref = gmap.get("mra_source_order", ["dist", "jt", "coinop", "ongo", "kuze", "meat", "slop", "jlrh", "arcfpga", "blahm1d", "repo"])

    def mra_raw(setn: str) -> str | None:
        cats = mra_categories.get(setn) or {}
        for src in mra_pref:
            if cats.get(src):
                r, _ = remap(cats[src], gmap)
                if r is not None:
                    return cats[src]
        for v in cats.values():
            if v:
                return v
        return None

    def own(setn: str) -> tuple[str, str] | None:
        if setn in catver:
            return catver[setn], "catver"
        if setn in mad:
            return mad[setn], "mad"
        r = mra_raw(setn)
        if r:
            return r, "mra"
        return None

    out: dict[str, dict] = {}
    unmapped: collections.Counter = collections.Counter()
    children: dict[str, list[str]] = collections.defaultdict(list)
    for name, m in machines.items():
        if m.get("cloneof"):
            children[m["cloneof"]].append(name)

    def finish(setn: str, raw: str, source: str) -> dict:
        genre, mature = remap(raw, gmap)
        if genre == gmap.get("default", "Other"):
            unmapped[normalize(raw)[0]] += 1
        return {"genre": genre, "raw": raw, "source": source, "mature": mature}

    for name, m in machines.items():
        o = own(name)
        if o:
            out[name] = finish(name, o[0], o[1])
    # Cascade: parent -> clones, then clones -> parent.
    for name, m in machines.items():
        if name in out:
            continue
        parent = m.get("cloneof")
        if parent and parent in out:
            out[name] = dict(out[parent], source="parent")
            continue
        for c in children.get(name, []):
            if c in out and out[c]["source"] != "parent":
                out[name] = dict(out[c], source="clone")
                break
    for name, m in machines.items():  # second pass for clones whose parent got a clone's genre
        if name not in out and m.get("cloneof") in out:
            out[name] = dict(out[m["cloneof"]], source="parent")

    # Per-set overrides (data/genre_overrides.json), e.g. from tools/reconcile_shmups.py. A parent's
    # override cascades to its clones; a clone's applies to that set only.
    overrides: dict[str, str] = {}
    if os.path.exists(GENRE_OVERRIDES):
        with open(GENRE_OVERRIDES, encoding="utf-8") as f:
            overrides = {k.lower(): v for k, v in json.load(f).get("sets", {}).items()}
    applied = 0
    for name, m in machines.items():
        g = overrides.get(name) or (overrides.get(m["cloneof"]) if m.get("cloneof") else None)
        if g:
            prev = out.get(name) or {"raw": None, "mature": False}
            out[name] = {"genre": g, "raw": prev["raw"], "source": "override", "mature": prev["mature"]}
            applied += 1

    summary = {
        "overrides": applied,
        "catver": catver_origin, "catver_entries": len(catver), "mad_entries": len(mad),
        "mra_entries": len(mra_categories),
        "unmapped": [{"raw": k, "sets": v} for k, v in unmapped.most_common(100)],
    }
    return out, summary
