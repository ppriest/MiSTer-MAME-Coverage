"""Join the two sides: every MAME arcade set, which MiSTer cores load it, and since when."""
from __future__ import annotations

import collections
import datetime as dt
import os
import re

from . import genre as genre_mod
from . import mamehist
from . import mame as mame_mod
from . import mister as mister_mod


def display_name(name: str) -> str:
    """Core name for display: the "Arcade-" prefix is an artifact of how the distribution names
    its repositories and builds (``Arcade-NMK16_Afega``), not part of the core's name."""
    return re.sub(r"^arcade[-_ ]+", "", name, flags=re.I) or name


def core_id(source: str, rbf: str | None) -> str:
    return f"{source}:{mister_mod.norm_rbf(rbf) or '?'}"


def core_registry(mister: dict) -> tuple[dict[str, dict], dict[str, str], dict[tuple[str, str], str]]:
    """Cores keyed by id, plus lookups: repository -> core id and (source, rbf stem) -> core id."""
    cores: dict[str, dict] = {}
    by_repo: dict[str, str] = {}
    by_rbf: dict[tuple[str, str], str] = {}
    for c in mister["cores"]:
        cid = core_id(c["db"], c["rbf"])
        if cid in cores:  # same build listed twice (channels); keep the first
            continue
        sc = c.get("score") or {}
        cores[cid] = {
            "id": cid,
            "name": c["core"],
            "source": c["db"],
            "source_title": mister_mod.DB_TITLES.get(c["db"], c["db"]),
            "channel": c.get("channel"),
            "rbf": c["rbf"],
            "repo": c.get("repo"),
            "url": f"https://github.com/{c['repo']}" if c.get("repo") else None,
            "build_date": c.get("build_commit_date") or c.get("build_published"),
            "status": c.get("status"),
            "reading": c.get("reading"),
            "score": sc.get("score"),
            "mame_drivers": c.get("mame_drivers") or [],
            "note": c.get("note"),
            "alamone_sets": c.get("setnames") or [],
        }
        if c.get("repo") and c["db"] != "jt":
            by_repo.setdefault(c["repo"], cid)
        stem = mister_mod.norm_rbf(c["rbf"])
        if stem:
            by_rbf.setdefault((c["db"], stem), cid)
            by_rbf.setdefault(("*", stem), cid)
    return cores, by_repo, by_rbf


# Database owners prefix the build names of cores they redistribute (MiSTer_Ongo ships kuzecores
# as ``kuze_namcos2_std``, MeatCores as ``meathax_ssv``). Strip the owner tag before comparing.
_OWNER_PREFIX = re.compile(r"^(kuze|meathax|meat|blahm1d|jlrh|slop|rm|xn|ff|jv)[_-]?")


def _stem_key(stem: str) -> str:
    return re.sub(r"[^a-z0-9]", "", _OWNER_PREFIX.sub("", stem))


def merge_duplicate_cores(cores: dict[str, dict], sets_by_core: dict[str, set[str]]) -> dict[str, str]:
    """Map cores we created from MRAs onto alamone's records when they are plainly the same
    build under another name: at least 80% of the sets in common and matching names once the
    owner prefix is gone. Independent re-implementations of the same games keep separate ids."""
    alias: dict[str, str] = {}
    known = [(cid, c) for cid, c in cores.items() if c.get("status")]
    for cid, c in cores.items():
        if c.get("status"):
            continue
        mine = sets_by_core.get(cid, set())
        if not mine:
            continue
        key = _stem_key(mister_mod.norm_rbf(c["rbf"]) or "")
        best = None
        for kid, k in known:
            theirs = set(k["alamone_sets"]) | sets_by_core.get(kid, set())
            overlap = len(mine & theirs) / len(mine)
            if overlap < 0.8:
                continue
            kkey = _stem_key(mister_mod.norm_rbf(k["rbf"]) or "")
            if key and kkey and (key == kkey or key in kkey or kkey in key):
                if best is None or overlap > best[0]:
                    best = (overlap, kid)
        if best:
            alias[cid] = best[1]
    return alias


def resolve_core(m: dict, cores, by_repo, by_rbf, repo_count) -> str:
    """Which core an MRA belongs to.

    The ``<rbf>`` tag against the same database wins; then the repository, when it holds exactly
    one core whose build name agrees with the tag (a mono-repository such as bmo00/arcfpga-cores
    holds many cores under one alamone record, so the tag has to agree); then the tag against
    any database; else a new core record is made.
    """
    src = m["source"]
    stem = mister_mod.norm_rbf(m.get("rbf"))
    if stem and (src, stem) in by_rbf:
        return by_rbf[(src, stem)]
    rid = by_repo.get(m["repo"])
    if rid and repo_count.get(m["repo"], 0) == 1:
        rstem = mister_mod.norm_rbf(cores[rid]["rbf"])
        if not stem or stem == rstem or _stem_key(stem) == _stem_key(rstem or ""):
            return rid
    if stem and ("*", stem) in by_rbf:
        return by_rbf[("*", stem)]
    if rid and repo_count.get(m["repo"], 0) == 1 and not stem:
        return rid
    cid = core_id(src, m.get("rbf"))
    if cid not in cores:
        cores[cid] = {
            "id": cid, "name": m.get("rbf") or "?", "source": src,
            "source_title": mister_mod.DB_TITLES.get(src, src), "channel": None,
            "rbf": (m.get("rbf") or "") + ".rbf", "repo": None if m["repo"].startswith("db:") else m["repo"],
            "url": None if m["repo"].startswith("db:") else f"https://github.com/{m['repo']}", "build_date": None, "status": None,
            "reading": None, "score": None, "mame_drivers": [], "note": None, "alamone_sets": [],
        }
    return cid


def observe(mister: dict) -> dict:
    """One run's view of the MiSTer side: ``{"cores": {id: core}, "support": {set: {id: rec}}}``.
    This is what gets merged into the committed ledger (see ``ledger.py``)."""
    cores, by_repo, by_rbf = core_registry(mister)
    repo_count = collections.Counter(c["repo"] for c in cores.values() if c.get("repo"))
    first_seen = mister["first_seen"]

    # set name -> {core id -> support record}
    support: dict[str, dict[str, dict]] = collections.defaultdict(dict)

    def add(setn: str, cid: str, date: str | None, quality: str, via: str, wip: bool = False, alt: bool = False,
            first_repo: str | None = None, first_path: str | None = None):
        rec = support[setn].get(cid)
        if rec is None:
            support[setn][cid] = {"core": cid, "date": date, "date_quality": quality, "via": via, "wip": wip, "alt": alt,
                                  "first_repo": first_repo, "first_path": first_path}
            return
        if date and (rec["date"] is None or date < rec["date"] or (rec["date_quality"] != "git" and quality == "git")):
            rec.update(date=date, date_quality=quality, first_repo=first_repo, first_path=first_path)
        rec["wip"] = rec["wip"] and wip
        rec["alt"] = rec["alt"] and alt

    # 1. MRAs we parsed from git checkouts: exact set names, dated by history.
    for m in mister["mras"]:
        cid = resolve_core(m, cores, by_repo, by_rbf, repo_count)
        fs = first_seen.get(m["setname"])
        date = None
        quality = "none"
        if fs:
            # Prefer the date from this MRA's own source, fall back to the earliest anywhere.
            date = fs["by_source"].get(m["source"]) or fs["date"]
            quality = "git"
        add(m["setname"], cid, date, quality, m["source"], m.get("wip", False), m.get("alt", False),
            fs and fs["repo"], fs and fs["path"])

    # 2. Sets alamone attributes to cores we have no MRA checkout for (developer databases).
    for cid, c in cores.items():
        for setn in c["alamone_sets"]:
            if not re.fullmatch(r"[a-z0-9_]{1,32}", setn):
                continue
            if cid in support.get(setn, {}):
                continue
            fs = first_seen.get(setn)
            if fs:
                add(setn, cid, fs["date"], "git-other", c["source"], first_repo=fs["repo"], first_path=fs["path"])
            else:
                add(setn, cid, c["build_date"], "build", c["source"])

    # 2b. Fold duplicate core records (same build redistributed under another name).
    sets_by_core: dict[str, set[str]] = collections.defaultdict(set)
    for setn, recs in support.items():
        for cid in recs:
            sets_by_core[cid].add(setn)
    alias = merge_duplicate_cores(cores, sets_by_core)
    for setn, recs in support.items():
        for cid in list(recs):
            if cid in alias:
                rec = recs.pop(cid)
                target = alias[cid]
                add(setn, target, rec["date"], rec["date_quality"], rec["via"], rec["wip"], rec["alt"],
                    rec.get("first_repo"), rec.get("first_path"))
    for cid, target in alias.items():
        cores[target].setdefault("aliases", []).append(cid)
        del cores[cid]
    # MRA <category> tags, per set and source (kept in the ledger for the genre step).
    categories: dict[str, dict[str, str]] = collections.defaultdict(dict)
    for m in mister["mras"]:
        cat = (m.get("category") or "").strip()
        if cat and m.get("setname"):
            categories[m["setname"]].setdefault(m["source"], cat)
    return {"cores": cores, "support": {k: v for k, v in support.items() if v}, "categories": dict(categories)}


def build(mame: dict, ledger: dict, mister_meta: dict | None = None) -> dict:
    """Join MAME with the ledger: every arcade set, which cores load it, and since when."""
    machines = mame["machines"]
    cores = ledger["cores"]
    support = ledger["support"]
    mister_meta = mister_meta or {}
    genres, genre_summary = genre_mod.resolve(machines, ledger.get("categories", {}))
    added = mamehist.dates_for_sets(mamehist.load())

    # 3. Earliest date per set across cores; earliest per title across its sets.
    def earliest(recs):
        dates = [r["date"] for r in recs if r["date"]]
        return min(dates) if dates else None

    titles: dict[str, dict] = {}
    unmatched: list[dict] = []
    for setn, recs in support.items():
        if setn not in machines:
            unmatched.append({"set": setn, "cores": sorted(recs)})
    # Every machine that is arcade/gambling, or that MiSTer loads regardless of category.
    for name, m in machines.items():
        if m.get("isbios"):  # "Acclaim ZN-1", "Neo-Geo" and the like are not games
            continue
        cat = mame_mod.classify(m)
        if cat not in ("arcade", "mahjong", "gambling") and name not in support:
            continue
        parent = m["cloneof"] or name
        if parent not in machines:
            parent = name
        t = titles.setdefault(parent, {"name": parent, "sets": []})
        recs = support.get(name, {})
        t["sets"].append({
            "name": name,
            "desc": m["desc"],
            "year": m["year"],
            "manufacturer": m["manufacturer"],
            "working": mame_mod.is_working(m),
            "status": m["status"],
            "parent": name == parent,
            "mame_added": added.get(name, (None, None))[0],
            "mame_date": added.get(name, (None, None))[1],
            "cores": [{k: r.get(k) for k in ("core", "date", "date_quality", "via", "wip", "alt")}
                      for r in sorted(recs.values(), key=lambda r: (r["date"] or "9999", r["core"]))],
            "date": earliest(recs.values()),
        })

    out_titles = []
    for parent, t in titles.items():
        pm = machines[parent]
        sets = sorted(t["sets"], key=lambda s: (not s["parent"], s["name"]))
        working_sets = [s for s in sets if s["working"]]
        covered_sets = [s for s in sets if s["cores"]]
        covered_working = [s for s in working_sets if s["cores"]]
        all_cores = sorted({r["core"] for s in sets for r in s["cores"]})
        cat = mame_mod.classify(pm)
        g = genres.get(parent) or next((genres[s["name"]] for s in sets if s["name"] in genres), None)
        out_titles.append({
            "name": parent,
            "desc": pm["desc"],
            "year": pm["year"],
            "manufacturer": pm["manufacturer"],
            "sourcefile": pm["sourcefile"],
            "category": cat,
            "genre": g["genre"] if g else None,
            "genre_raw": g["raw"] if g else None,
            "genre_source": g["source"] if g else None,
            "mature": bool(g and g["mature"]),
            "working": any(s["working"] for s in sets),
            "status": pm["status"],
            "rotate": pm["rotate"],
            "display": pm["display"],
            "cpus": pm["cpus"],
            "players": pm["players"],
            "nsets": len(sets),
            "nworking": len(working_sets),
            "ncovered": len(covered_sets),
            "ncovered_working": len(covered_working),
            "covered": bool(covered_sets),
            "covered_working": bool(covered_working),
            "date": earliest(r for s in sets for r in s["cores"]),
            "date_working": earliest(r for s in working_sets for r in s["cores"]),
            "mame_date": min((s["mame_date"] for s in sets if s["mame_date"]), default=None),
            "cores": all_cores,
            "sets": sets,
        })
    out_titles.sort(key=lambda t: (t["desc"].lower(), t["name"]))

    # Driver (MAME source file) roll-up, counting working arcade titles only.
    drivers: dict[str, dict] = {}
    for t in out_titles:
        if t["category"] != "arcade" or not t["working"]:
            continue
        d = drivers.setdefault(t["sourcefile"], {"sourcefile": t["sourcefile"], "titles": 0, "covered": 0, "sets": 0, "sets_covered": 0, "cores": set(), "first": None})
        d["titles"] += 1
        d["covered"] += t["covered_working"]
        d["sets"] += t["nworking"]
        d["sets_covered"] += t["ncovered_working"]
        d["cores"].update(t["cores"])
        if t["date_working"] and (d["first"] is None or t["date_working"] < d["first"]):
            d["first"] = t["date_working"]
    for d in drivers.values():
        d["cores"] = sorted(d["cores"])
    # Cores that alamone links to a driver but which cover none of its titles still get a mention.
    for cid, c in cores.items():
        for drv in c["mame_drivers"]:
            if drv in drivers and cid not in drivers[drv]["cores"]:
                drivers[drv].setdefault("cores_claimed", []).append(cid)

    # Core roll-up: how many working arcade sets / titles each core loads.
    core_sets = collections.Counter()
    core_titles = collections.defaultdict(set)
    core_first = {}
    for t in out_titles:
        for s in t["sets"]:
            for r in s["cores"]:
                if s["working"] and t["category"] == "arcade":
                    core_sets[r["core"]] += 1
                    core_titles[r["core"]].add(t["name"])
                if r["date"] and (r["core"] not in core_first or r["date"] < core_first[r["core"]]):
                    core_first[r["core"]] = r["date"]
    out_cores = []
    for cid, c in cores.items():
        oc = {k: v for k, v in c.items() if k not in ("alamone_sets",)}
        oc["name"] = display_name(oc["name"])
        oc["nsets"] = core_sets[cid]
        oc["ntitles"] = len(core_titles[cid])
        oc["first_date"] = core_first.get(cid)
        out_cores.append(oc)
    out_cores.sort(key=lambda c: (c["source"], c["name"].lower()))

    working_arcade = [t for t in out_titles if t["category"] == "arcade" and t["working"]]
    meta = {
        "generated": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "mame_version": mame.get("version"),
        "mame_build": mame.get("build"),
        "mister_generated": mister_meta.get("generated"),
        "alamone_generated": mister_meta.get("alamone_generated"),
        "ledger_updated": ledger["meta"].get("updated"),
        "ledger_runs": ledger["meta"].get("runs", [])[-5:],
        "genre": genre_summary,
        "mame_added_updated": mamehist.load().get("updated"),
        "sources": mister_mod.DB_TITLES,
        "repos": mister_meta.get("repos", []),
        "repo_errors": mister_meta.get("errors", []),
        "counts": {
            "titles": len(out_titles),
            "working_arcade_titles": len(working_arcade),
            "working_arcade_titles_covered": sum(1 for t in working_arcade if t["covered_working"]),
            "working_arcade_sets": sum(t["nworking"] for t in working_arcade),
            "working_arcade_sets_covered": sum(t["ncovered_working"] for t in working_arcade),
            "cores": len(out_cores),
            "unmatched_sets": len(unmatched),
        },
    }
    return {"meta": meta, "cores": out_cores, "drivers": sorted(drivers.values(), key=lambda d: d["sourcefile"]),
            "titles": out_titles, "unmatched": sorted(unmatched, key=lambda u: u["set"])}
