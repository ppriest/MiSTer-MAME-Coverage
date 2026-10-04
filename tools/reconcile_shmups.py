#!/usr/bin/env python3
"""Reconcile our Shmup genre with shmupfan/shmup-deck's curated list of MiSTer shoot 'em ups.

    python3 tools/reconcile_shmups.py                 # report
    python3 tools/reconcile_shmups.py --write-overrides   # also record the deck's games as Shmup
                                                          # in data/genre_overrides.json

The deck (https://github.com/shmupfan/shmup-deck, shmup_deck/app/games.json) lists every shoot
'em up it knows a MiSTer core for, with the MAME set names of each. We read docs/data/coverage.json
(run ``python -m mmc report`` first) and compare:

  A. deck games that our data does not call Shmup: the raw category and where it came from, so the
     generic map (data/genre_map.json) can be fixed when a whole category is wrong, or the set
     written to data/genre_overrides.json when a single game is;
  B. titles our data calls Shmup, on MiSTer, that the deck does not list: candidates for the
     deck, or games our map wrongly calls Shmup;
  C. deck set names that do not exist in this MAME version.

Nothing is changed unless --write-overrides is given.
"""
from __future__ import annotations

import argparse
import collections
import json
import os
import sys
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
COVERAGE = os.path.join(ROOT, "docs", "data", "coverage.json")
OVERRIDES = os.path.join(ROOT, "data", "genre_overrides.json")
DECK_URL = "https://raw.githubusercontent.com/shmupfan/shmup-deck/main/shmup_deck/app/games.json"
# Our Shmup is 2D scrolling shooters only: vehicle ("Driving …") and isometric ("Flying Diagonal")
# shooters stay Shooter by decision, so the deck listing them is not treated as a disagreement to fix.
KEEP_RAW_DEFAULT = [
    "Shooter / Driving Vertical", "Shooter / Driving Horizontal", "Shooter / Driving Diagonal",
    "Shooter / Flying Diagonal", "Driving / Race",
]


def load_deck(path: str | None) -> list[dict]:
    if path:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    with urllib.request.urlopen(DECK_URL, timeout=60) as r:
        return json.loads(r.read().decode("utf-8"))


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--deck", help="local games.json instead of downloading it")
    ap.add_argument("--coverage", default=COVERAGE)
    ap.add_argument("--write-overrides", action="store_true",
                    help="record every deck game as Shmup in data/genre_overrides.json (one entry per parent set)")
    ap.add_argument("--include-uncovered", action="store_true",
                    help="in section B also list Shmup titles that are not on MiSTer")
    ap.add_argument("--keep-raw", action="append", default=None, metavar="CATEGORY",
                    help="raw categories whose placement we keep even when the deck disagrees "
                         "(repeatable; default: the vehicle and isometric shooter categories, which this "
                         "project deliberately keeps out of Shmup; pass '' to keep none)")
    a = ap.parse_args()
    keep_raw = {k.lower() for k in (a.keep_raw if a.keep_raw is not None else KEEP_RAW_DEFAULT) if k}

    with open(a.coverage, encoding="utf-8") as f:
        cov = json.load(f)
    deck = load_deck(a.deck)

    by_set: dict[str, dict] = {}
    for t in cov["titles"]:
        for s in t["sets"]:
            by_set[s["name"]] = t
    titles = {t["name"]: t for t in cov["titles"]}

    # --- A: deck games we do not call Shmup ---------------------------------------------------
    deck_titles: dict[str, list[dict]] = collections.defaultdict(list)   # our parent -> deck cards
    unknown: list[tuple[str, str]] = []
    for g in deck:
        hit = None
        for s in g.get("setnames") or [g["id"]]:
            if s in by_set:
                hit = by_set[s]
                break
        if hit is None:
            unknown.append((g["id"], g["title"]))
            continue
        deck_titles[hit["name"]].append(g)

    not_shmup = [(titles[p], cards) for p, cards in deck_titles.items() if titles[p]["genre"] != "Shmup"]
    not_shmup.sort(key=lambda x: (x[0]["genre"] or "", x[0]["genre_raw"] or "", x[0]["desc"]))
    print(f"Deck: {len(deck)} games -> {len(deck_titles)} MAME titles; {len(unknown)} not in MAME {cov['meta']['mame_version']}")
    print(f"\nA. Deck games our data does not call Shmup: {len(not_shmup)}")
    by_raw = collections.Counter((t["genre"], t["genre_raw"]) for t, _ in not_shmup)
    for (genre, raw), n in by_raw.most_common():
        print(f"   {n:3d}  {str(genre):12s} <- {raw!r}")
    print()
    for t, cards in not_shmup:
        names = ", ".join(sorted({c["title"] for c in cards}))
        kept = "  [kept: vehicle/isometric]" if (t["genre_raw"] or "").lower() in keep_raw else ""
        print(f"   {t['name']:<10} {t['desc'][:48]:<48} ours: {str(t['genre']):<10} raw: {t['genre_raw']!r} ({t['genre_source']})   deck: {names}{kept}")

    # --- B: our Shmups the deck does not list -------------------------------------------------
    ours = [t for t in cov["titles"] if t["genre"] == "Shmup" and t["category"] == "arcade" and t["working"]
            and t["name"] not in deck_titles and (a.include_uncovered or t["covered_working"])]
    ours.sort(key=lambda t: t["desc"].lower())
    print(f"\nB. Titles we call Shmup{'' if a.include_uncovered else ', on MiSTer,'} that the deck does not list: {len(ours)}")
    for t in ours:
        cores = ", ".join(t["cores"])
        print(f"   {t['name']:<10} {t['desc'][:48]:<48} {t['year']:<5} raw: {t['genre_raw']!r} ({t['genre_source']})   cores: {cores}")

    # --- C: deck sets unknown to MAME ---------------------------------------------------------
    print(f"\nC. Deck games with no set in MAME {cov['meta']['mame_version']}: {len(unknown)}")
    for i, title in unknown:
        print(f"   {i:<12} {title}")

    # --- summary -------------------------------------------------------------------------------
    agree = sum(1 for p in deck_titles if titles[p]["genre"] == "Shmup")
    print(f"\nAgreement: {agree}/{len(deck_titles)} deck titles are Shmup in our data "
          f"({100 * agree / max(1, len(deck_titles)):.1f}%); {len(ours)} of ours missing from the deck.")

    if a.write_overrides:
        existing = {}
        if os.path.exists(OVERRIDES):
            with open(OVERRIDES, encoding="utf-8") as f:
                existing = json.load(f)
        entries = existing.setdefault("sets", {})
        added = 0
        for t, cards in not_shmup:
            if (t["genre_raw"] or "").lower() in keep_raw:
                continue
            if entries.get(t["name"]) != "Shmup":
                entries[t["name"]] = "Shmup"
                added += 1
        existing.setdefault("_comment", "Per-set genre overrides applied after data/genre_map.json; a parent's entry cascades to its clones. Entries are set name -> common genre.")
        existing["sets"] = dict(sorted(entries.items()))
        with open(OVERRIDES, "w", encoding="utf-8") as f:
            json.dump(existing, f, indent=2, ensure_ascii=False)
            f.write("\n")
        print(f"\nWrote {added} new override(s) to {OVERRIDES}; run `python -m mmc report` to apply.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
