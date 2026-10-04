"""Command line: ``python -m mmc build [--mame-version 0289] [--no-sync] [--refresh-mame]``.

Steps (each cached under ``work/``):
  mame     download + parse the MAME -listxml release asset
  mister   clone/refresh the MRA repositories, parse MRAs, read their add dates
  build    all of the above, then reconcile and write docs/data/*.json
"""
from __future__ import annotations

import argparse
import json
import os
import sys

from . import mame as mame_mod
from . import mister as mister_mod
from . import paths
from . import reconcile, report


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="mmc")
    ap.add_argument("step", choices=["mame", "mister", "build"], nargs="?", default="build")
    ap.add_argument("--mame-version", help="e.g. 0289; default: newest release asset found")
    ap.add_argument("--refresh-mame", action="store_true", help="re-parse the MAME XML even if cached")
    ap.add_argument("--no-sync", action="store_true", help="do not clone/fetch repositories; use what is in work/repos")
    ap.add_argument("--no-fetch", action="store_true", help="clone missing repositories but do not refresh existing ones")
    ap.add_argument("--workers", type=int, default=8)
    a = ap.parse_args(argv)

    os.makedirs(paths.CACHE, exist_ok=True)
    mister_cache = os.path.join(paths.CACHE, "mister.json")

    if a.step in ("mame", "build"):
        mame = mame_mod.load_mame(a.mame_version, refresh=a.refresh_mame)
        print(f"[mame] {mame['build']}: {len(mame['machines'])} machines")
    if a.step in ("mister", "build"):
        mister = mister_mod.build_mister(no_sync=a.no_sync, fetch_existing=not a.no_fetch, workers=a.workers)
        with open(mister_cache, "w", encoding="utf-8") as f:
            json.dump(mister, f, ensure_ascii=False)
        print(f"[mister] {len(mister['mras'])} MRAs, {len(mister['first_seen'])} dated sets, {len(mister['cores'])} cores")
    if a.step == "build":
        result = reconcile.build(mame, mister)
        report.write(result)
    return 0


if __name__ == "__main__":
    sys.exit(main())
