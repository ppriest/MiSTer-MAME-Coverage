#!/usr/bin/env python3
"""Regenerate MiSTer_Cores.md: ppriest's arcade cores, their games and other versions, read from
each core repository's ``releases/*.mra`` (parents) and ``releases/_alternatives/**`` (other versions).

    python3 tools/cores_doc.py CHECKOUT_DIR... --mame work/cache/mame0289.json -o MiSTer_Cores.md

Each CHECKOUT_DIR is ``Title=path`` (the section title) or just a path. Parents/clones follow MAME's
``cloneof``; a clone whose parent is not in the same core is listed as a game of its own.
"""
import argparse
import json
import re
import sys
from pathlib import Path

# rbf stem -> sub-heading, for cores with more than one build
BOARDS = {"Seta": "Seta board", "SetaDowntown": "DownTown board"}


def tag(text: str, name: str) -> str:
    m = re.search(rf"<{name}>(.*?)</{name}>", text, re.S)
    return (m.group(1).strip() if m else "").replace("&amp;", "&").replace("&apos;", "'").replace("&quot;", '"')


def read_mras(root: Path, mame: dict):
    games, alts = [], []
    rel = root / "releases"
    for f in sorted(rel.glob("*.mra")):
        games.append(f)
    for f in sorted((rel / "_alternatives").glob("**/*.mra")):
        alts.append(f)
    out = []
    for kind, files in (("game", games), ("alt", alts)):
        for f in files:
            t = f.read_text(errors="ignore")
            s = tag(t, "setname")
            out.append({"kind": kind, "name": tag(t, "name"), "set": s, "year": tag(t, "year"),
                        "mfr": tag(t, "manufacturer"), "rbf": tag(t, "rbf")})
    return out


def render(cores, mame):
    machines = mame["machines"]
    sections, tg, ta = [], 0, 0
    for title, root in cores:
        recs = read_mras(root, mame)
        by_set = {r["set"]: r for r in recs}
        parent_of = {}
        for r in recs:
            p = r["set"]
            seen = set()
            while machines.get(p, {}).get("cloneof") and p not in seen:
                seen.add(p)
                p = machines[p]["cloneof"]
            parent_of[r["set"]] = p
        tops = []   # parents to list as games
        for r in recs:
            p = parent_of[r["set"]]
            if r["kind"] == "game" or p not in by_set or p == r["set"]:
                tops.append(r)
        top_sets = {r["set"] for r in tops}
        kids = {}
        for r in recs:
            if r["set"] in top_sets:
                continue
            p = parent_of[r["set"]]
            kids.setdefault(p if p in top_sets else None, []).append(r)
        orphans = kids.pop(None, [])
        tops += orphans
        rbfs = sorted({r["rbf"] for r in tops})
        key = lambda r: r["name"].casefold()
        lines, ngames, nalts = [], 0, 0
        groups = {}
        for r in sorted(tops, key=key):
            groups.setdefault(r["rbf"], []).append(r)
        for rbf in sorted(groups, key=lambda x: list(BOARDS).index(x) if x in BOARDS else 99):
            if len(rbfs) > 1:
                lines += [f"### {BOARDS.get(rbf, rbf)}", ""]
            for r in groups[rbf]:
                ngames += 1
                lines.append(f"* {r['name']} ({r['year']}, {r['mfr']}) `{r['set']}`")
                for k in sorted(kids.get(r["set"], []), key=key):
                    nalts += 1
                    diff = ([k["year"]] if k["year"] != r["year"] else []) + ([k["mfr"]] if k["mfr"] != r["mfr"] else [])
                    extra = f" ({', '.join(diff)})" if diff else ""
                    lines.append(f"  * {k['name']}{extra} `{k['set']}`")
            if len(rbfs) > 1:
                lines.append("")
        if len(rbfs) == 1:
            lines.append("")
        sections.append((title, ngames, nalts, lines))
        tg += ngames
        ta += nalts
    out = ["# MiSTer arcade cores", "",
           f"{len(sections)} cores, {tg} games, {ta} other versions, from each core's `releases/*.mra`. MAME set names in `code`.", ""]
    for title, g, a, lines in sections:
        out += [f"## {title}", "", f"{g} games, {a} other versions.", ""] + lines
    return "\n".join(out).rstrip("\n") + "\n"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cores", nargs="+", help="Title=checkout")
    ap.add_argument("--mame", required=True)
    ap.add_argument("-o", "--out", required=True)
    a = ap.parse_args()
    mame = json.load(open(a.mame))
    cores = []
    for c in a.cores:
        t, _, p = c.partition("=")
        cores.append((t, Path(p)))
    Path(a.out).write_text(render(cores, mame))


if __name__ == "__main__":
    main()
