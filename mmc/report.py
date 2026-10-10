"""Write the published outputs: ``docs/data/coverage.json`` (full reconciliation) and
``docs/data/summary.json`` (small roll-up). The page in ``docs/`` is static and reads them."""
from __future__ import annotations

import json
import os

import subprocess
import sys

from . import paths


def write(result: dict) -> None:
    os.makedirs(os.path.join(paths.DOCS, "data"), exist_ok=True)
    full = os.path.join(paths.DOCS, "data", "coverage.json")
    with open(full, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, separators=(",", ":"))
    summary = {
        "meta": result["meta"],
        "cores": result["cores"],
        "drivers": result["drivers"],
        "unmatched": result["unmatched"],
    }
    with open(os.path.join(paths.DOCS, "data", "summary.json"), "w", encoding="utf-8") as f:
        json.dump(summary, f, ensure_ascii=False, indent=1)
    # The titles and drivers a wishlist vote may name (the /api/vote function checks against this file).
    keys = {"titles": sorted(t["name"] for t in result["titles"]),
            "drivers": sorted({t["sourcefile"] for t in result["titles"] if t["sourcefile"]} | {d["sourcefile"] for d in result["drivers"]})}
    with open(os.path.join(paths.DOCS, "data", "keys.json"), "w", encoding="utf-8") as f:
        json.dump(keys, f, separators=(",", ":"))
    g = result["meta"].get("genre", {})
    if g.get("unmapped"):
        print(f"[report] genre strings not in data/genre_map.json (mapped to default): "
              + ", ".join(f"{u['raw']} ({u['sets']})" for u in g["unmapped"][:25]))
    # Regenerate the shmup-deck comparison (reports/shmup-deck.md) from the data just written.
    tool = os.path.join(paths.ROOT, "tools", "reconcile_shmups.py")
    if os.path.exists(tool):
        r = subprocess.run([sys.executable, tool], capture_output=True, text=True, check=False)
        last = (r.stdout.strip().splitlines() or [""])[-1]
        print(f"[report] {last}" if r.returncode == 0 else f"[report] reconcile_shmups.py failed: {(r.stderr or r.stdout).strip().splitlines()[-1:]}")
    c = result["meta"]["counts"]
    print(f"[report] wrote {full} ({os.path.getsize(full) // 1024} KB)")
    print(f"[report] working arcade titles: {c['working_arcade_titles_covered']}/{c['working_arcade_titles']} covered; "
          f"sets: {c['working_arcade_sets_covered']}/{c['working_arcade_sets']}; cores: {c['cores']}; "
          f"MiSTer sets unknown to MAME: {c['unmatched_sets']}")
