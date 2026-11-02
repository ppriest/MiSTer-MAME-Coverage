#!/usr/bin/env python3
"""Adds the per-set lists to the existing docs/data/hardware/*.json without touching the notes: every chip or device
that not all of a driver's sets have gets "in" (the sets that do), and a chip with several clocks lists the sets of each.
Input: a MAME listxml (the release's mameNNNNlx.zip, unzipped to .xml, or a mame binary) of the version the files are from.

    python3 tools/hardware_sets.py mame0289.xml
"""
import json, os, sys
sys.path.insert(0, os.path.dirname(__file__))
import hardware_local as hw

def main():
    src = sys.argv[1]
    root = os.path.join(os.path.dirname(__file__), "..", "docs", "data", "hardware")
    files = {f: json.load(open(os.path.join(root, f), encoding="utf-8")) for f in os.listdir(root) if f.endswith(".json")}
    wanted = {d for j in files.values() for d in j["drivers"]}
    raw, build = hw.parse_listxml(src, wanted)
    bad = 0
    for f, j in files.items():
        for d, old in j["drivers"].items():
            new = hw.summarise(raw[d]) if raw.get(d) else None
            if not new or new["sets"] != old["sets"]:
                bad += 1; print("set count differs (left alone):", d, old["sets"], new and new["sets"]); continue
            for k in ("cpus", "sound", "devices"):
                nm = {r["name"]: r for r in new[k]}
                for r in old[k]:
                    n = nm.get(r["name"])
                    if not n or n["sets"] != r["sets"]:
                        bad += 1; print("differs:", d, k, r["name"]); continue
                    if "in" in n: r["in"] = n["in"]
                    if k != "devices" and r.get("clocks"):
                        r["clocks"] = n["clocks"]
        with open(os.path.join(root, f), "w", encoding="utf-8") as fh:
            json.dump(j, fh, ensure_ascii=False, separators=(",", ":"))
    print("build", build, "mismatches", bad)

main()
