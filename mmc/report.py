"""Write the published outputs: ``docs/data/coverage.json`` (full reconciliation) and
``docs/data/summary.json`` (small roll-up). The page in ``docs/`` is static and reads them."""
from __future__ import annotations

import json
import os

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
    g = result["meta"].get("genre", {})
    if g.get("unmapped"):
        print(f"[report] genre strings not in data/genre_map.json (mapped to default): "
              + ", ".join(f"{u['raw']} ({u['sets']})" for u in g["unmapped"][:25]))
    c = result["meta"]["counts"]
    print(f"[report] wrote {full} ({os.path.getsize(full) // 1024} KB)")
    print(f"[report] working arcade titles: {c['working_arcade_titles_covered']}/{c['working_arcade_titles']} covered; "
          f"sets: {c['working_arcade_sets_covered']}/{c['working_arcade_sets']}; cores: {c['cores']}; "
          f"MiSTer sets unknown to MAME: {c['unmatched_sets']}")
