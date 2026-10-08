"""Command line: ``python -m mmc [step] [--mame-version 0289] [--no-sync|--no-fetch] [--refresh-mame]``.

Steps:
  mame     download + parse the MAME -listxml release asset (cached under work/)
  mister   clone/refresh the MRA repositories, parse MRAs, read their add dates, and merge the
           observations into the committed ledger (data/ledger.json)
  mamehist when each set entered MAME: release tag dates + mame.lst per release -> data/mame_added.json
  report   MAME + ledger -> docs/data/*.json; needs no repositories at all
  build    mister then report (the default)
"""
from __future__ import annotations

import argparse
import json
import os
import sys

from . import mame as mame_mod
from . import mister as mister_mod
from . import paths
from . import ledger as ledger_mod
from . import mamehist
from . import reconcile, report


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="mmc")
    ap.add_argument("step", choices=["mame", "mister", "mamehist", "report", "build"], nargs="?", default="build")
    ap.add_argument("--mame-version", help="e.g. 0289; default: newest release asset found")
    ap.add_argument("--refresh-mame", action="store_true", help="re-parse the MAME XML even if cached")
    ap.add_argument("--no-sync", action="store_true", help="do not clone/fetch repositories; use what is in work/repos")
    ap.add_argument("--no-fetch", action="store_true", help="clone missing repositories but do not refresh existing ones")
    ap.add_argument("--workers", type=int, default=8)
    a = ap.parse_args(argv)

    os.makedirs(paths.CACHE, exist_ok=True)
    mister_cache = os.path.join(paths.CACHE, "mister.json")

    mister_meta: dict = {}
    if a.step in ("mame", "report", "build"):
        mame = mame_mod.load_mame(a.mame_version, refresh=a.refresh_mame)
        print(f"[mame] {mame['build']}: {len(mame['machines'])} machines")
    if a.step in ("mister", "build"):
        mister = mister_mod.build_mister(no_sync=a.no_sync, fetch_existing=not a.no_fetch, workers=a.workers)
        with open(mister_cache, "w", encoding="utf-8") as f:
            json.dump(mister, f, ensure_ascii=False)
        print(f"[mister] {len(mister['mras'])} MRAs, {len(mister['first_seen'])} dated sets, {len(mister['cores'])} cores")
        observed = reconcile.observe(mister)
        mister_mod.save_core_repos(observed["core_repos"])
        repos = {r["repo"] for r in mister["repos"]} | {c.get("repo") for c in observed["cores"].values()}
        n = len(mister_mod.scan_repo_sources(r for r in repos if r))
        print(f"[mister] source check: {n} repositories in data/repo_source.json")
        led = ledger_mod.load()
        summary = ledger_mod.merge(led, observed, note=f"alamone {mister.get('alamone_generated', '')[:10]}")
        ledger_mod.save(led)
        print(f"[ledger] {ledger_mod.LEDGER}: +{summary['cores']} cores, +{summary['sets']} sets, "
              f"+{summary['pairs']} set/core pairs, {summary['dates_improved']} dates improved, "
              f"{summary.get('cores_removed', 0)} excluded cores removed")
        mister_meta = {k: mister.get(k) for k in ("generated", "alamone_generated", "repos", "errors")}
    if a.step in ("mamehist", "build"):
        if a.step == "mamehist":
            mame = mame_mod.load_mame(a.mame_version, refresh=a.refresh_mame)
        mh = mamehist.build(int(mame["version"]))
        print(f"[mamehist] {len(mh['sets'])} sets dated, {len(mh['versions'])} tagged versions")
    if a.step in ("report", "build"):
        led = ledger_mod.load()
        if not led["support"]:
            print("no ledger yet: run `python -m mmc mister` first", file=sys.stderr)
            return 1
        if not mister_meta and os.path.exists(mister_cache):
            with open(mister_cache, encoding="utf-8") as f:
                m = json.load(f)
            mister_meta = {k: m.get(k) for k in ("generated", "alamone_generated", "repos", "errors")}
        result = reconcile.build(mame, led, mister_meta)
        report.write(result)
    return 0


if __name__ == "__main__":
    sys.exit(main())
