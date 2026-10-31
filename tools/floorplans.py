#!/usr/bin/env python3
"""Floorplans: the pictures in the Blob store, data/floorplans.json (the index) and docs/floorplans.html.

    python3 tools/floorplans.py collect --cores-dir E:/MiSTer-Cores --cores-dir E:/MiSTer-Devel --out <folder>
    cd tools && BLOB_READ_WRITE_TOKEN=... node blob_upload.mjs <folder> --index <folder>/upload.json
    python3 tools/floorplans.py page

``data/floorplans_page.json`` lists the systems in page order, each with its revisions: the repository the
picture comes from, a label, and (filled by ``collect``) the fit date and the per-block resource table. Each picture
is ``<repo>/docs/floorplan/<rev>.png`` with ``<rev>_groups.md``, written by the core's ``scripts/floorplan.py``
from its compiled design. To add a core, add its entry there and run ``collect``.

``collect`` copies each picture unchanged to ``<folder>`` as ``fp-<rev>-<first 10 hex of its sha256>.png`` (a new
picture is a new name, so the one-year cache never serves a stale one), rewrites ``data/floorplans.json``
(``{rev: {"file", "w", "h"}}``, read by ``mmc`` for the Cores tab and by ``page``) and writes ``<folder>/upload.json``
listing every picture for blob_upload.mjs, which skips what its ``uploaded.json`` in the same folder says was sent. ``page`` writes ``docs/floorplans.html``
with each picture at ``<image-base>/<file>`` (the meta tag in docs/index.html) and MiSTer-kun from
``docs/mister_kun.svg``.
"""
from __future__ import annotations

import argparse
import hashlib
import html
import json
import os
import re
import shutil
import struct
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
INDEX = os.path.join(ROOT, "data", "floorplans.json")
LAYOUT = os.path.join(ROOT, "data", "floorplans_page.json")
PAGE = os.path.join(ROOT, "docs", "floorplans.html")
SITE = os.path.join(ROOT, "docs", "index.html")

# MiSTer-kun (baxysquare/mister_kun, after HeWhoisRed's original) over the HPS: the fabric hole at X>=51, Y>=37
# that no core places anything in. Picture geometry is floorplan.py's: 8 px per site, die at (0, 24), legend
# 360 px to the right, 30 px below.
HPS_X, HPS_Y = 51, 37


def load(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def dump(obj, path):
    text = json.dumps(obj, indent=1, ensure_ascii=False)
    # a list of strings (a table row) on one line
    text = re.sub(r'\[\n\s+("(?:[^"\\]|\\.)*"(?:,\n\s+"(?:[^"\\]|\\.)*")*)\n\s+\]',
                  lambda m: "[" + re.sub(r",\n\s+", ", ", m.group(1)) + "]", text)
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write(text + "\n")


def groups_table(md):
    """The block table of <rev>_groups.md as rows of cells, the header first."""
    rows = [ln for ln in md.splitlines() if ln.startswith("|") and not ln.startswith("|---")]
    return [[c.strip() for c in r.strip("|").split("|")] for r in rows]


def collect(args):
    layout, index = load(LAYOUT), load(INDEX)
    os.makedirs(args.out, exist_ok=True)
    changed = []
    for system in layout["systems"]:
        for e in system["floorplans"]:
            src = next((os.path.join(d, e["repo"], "docs", "floorplan") for d in args.cores_dir
                        if os.path.isdir(os.path.join(d, e["repo"]))), None)
            if not src:
                sys.exit(f"{e['repo']} is in none of {args.cores_dir}")
            data = open(os.path.join(src, f"{e['rev']}.png"), "rb").read()
            if data[:8] != b"\x89PNG\r\n\x1a\n":
                sys.exit(f"{e['repo']}/docs/floorplan/{e['rev']}.png is not a PNG")
            md = open(os.path.join(src, f"{e['rev']}_groups.md"), encoding="utf-8").read()
            name = f"fp-{re.sub(r'[^A-Za-z0-9_-]', '', e['rev'])}-{hashlib.sha256(data).hexdigest()[:10]}.png"
            with open(os.path.join(args.out, name), "wb") as f:
                f.write(data)
            w, h = struct.unpack(">II", data[16:24])
            if index.get(e["rev"], {}).get("file") != name:
                changed.append(e["rev"])
            index[e["rev"]] = {"file": name, "w": w, "h": h}
            e["fitted"] = md.splitlines()[0].lstrip("# ").replace("Floorplan: ", "")
            e["groups"] = groups_table(md)
    dump(dict(sorted(index.items())), INDEX)
    dump(layout, LAYOUT)
    dump({r: {"floorplan": v["file"]} for r, v in sorted(index.items())}, os.path.join(args.out, "upload.json"))
    print(f"{sum(len(s['floorplans']) for s in layout['systems'])} floorplans -> {args.out}; "
          f"changed in the index: {', '.join(changed) or 'none'}; upload with --index {args.out}/upload.json")


def overlay(w, h):
    W, H = (w - 360) // 8, (h - 30) // 8
    left, top = HPS_X * 8, 24
    right, bottom = W * 8, (H - 1 - HPS_Y) * 8 + 24 + 8
    pct = lambda v, t: f"{100 * v / t:.3f}%"
    return (f'<div class="kun" style="left:{pct(left, w)};top:{pct(top, h)};'
            f'width:{pct(right - left, w)};height:{pct(bottom - top, h)}">'
            f'<img alt="" src="mister_kun.svg"></div>')


def table(rows):
    out = ["<table>"]
    for i, r in enumerate(rows):
        tag = "th" if i == 0 else "td"
        out.append("<tr>" + "".join(f"<{tag}>{html.escape(c)}</{tag}>" for c in r) + "</tr>")
    return "\n".join(out + ["</table>"])


def page(args):
    layout, index = load(LAYOUT), load(INDEX)
    m = re.search(r'<meta name="image-base" content="([^"]*)"', open(SITE, encoding="utf-8").read())
    base = (m.group(1) if m else "").rstrip("/")
    if not base:
        sys.exit("no image-base meta in docs/index.html")
    parts, toc = [], []
    for system in layout["systems"]:
        title = system["system"]
        anchor = re.sub(r"\W+", "-", title.lower()).strip("-")
        toc.append(f'<li><a href="#{anchor}">{html.escape(title)}</a></li>')
        parts.append(f'<h2 id="{anchor}">{html.escape(title)}</h2>')
        for e in system["floorplans"]:
            pic = index.get(e["rev"])
            if not pic or "groups" not in e:
                sys.exit(f"{e['rev']}: not collected yet (run collect)")
            label = e["label"] + " — " if e["label"] else ""
            parts.append(f"<h3>{html.escape(label)}revision <code>{html.escape(e['rev'])}</code></h3>")
            parts.append(f'<p class="meta">{html.escape(e["fitted"])}</p>')
            parts.append(f'<div class="fp"><img alt="Floorplan of {html.escape(e["rev"])}" loading="lazy" '
                         f'width="{pic["w"]}" height="{pic["h"]}" src="{base}/{pic["file"]}">'
                         f'{overlay(pic["w"], pic["h"])}</div>')
            parts.append(f"<details><summary>Resources per block</summary>{table(e['groups'])}</details>")
    out = f"""<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>MiSTer Core Floorplans</title>
<style>
body{{background:#111214;color:#ddd;font:15px/1.5 system-ui,sans-serif;margin:0 auto;max-width:1120px;padding:16px}}
h1{{font-size:24px}} h2{{border-bottom:1px solid #333;padding-bottom:4px;margin-top:40px}}
h3{{font-size:16px;margin-bottom:2px}} .meta{{color:#999;margin:0 0 8px}}
.fp>img{{max-width:100%;height:auto;image-rendering:pixelated;border:1px solid #333}}
table{{border-collapse:collapse;font-size:13px;margin:8px 0}} td,th{{border:1px solid #333;padding:2px 8px;text-align:right}}
td:first-child,th:first-child{{text-align:left}} a{{color:#8ab4f8}} code{{color:#ffd479}}
summary{{cursor:pointer;color:#aaa;margin:6px 0}}
.fp{{position:relative;display:inline-block;max-width:100%;line-height:0}}
.kun{{position:absolute;display:flex;align-items:center;justify-content:center;pointer-events:none}}
.kun img{{width:78%;height:78%}}
</style></head><body>
<p class="meta"><a href="./">&larr; MiSTer &times; MAME arcade coverage</a></p>
<h1>MiSTer core floorplans</h1>
<p>Where each core's logic sits on the DE10-nano's Cyclone V (5CSEBA6), read from the latest compiled
build of each revision with <code>scripts/floorplan.py</code>; nothing was recompiled for this page. One cell per LAB, M10K or DSP
site, coloured by the block owning most of it, brighter when fuller. The thin columns are M10K and
DSP; the empty area at the top right is the HPS; grey is the MiSTer framework. Colours mean the same
kind of block in every core (red main CPU, yellow/orange sound, green tilemaps, cyan sprites, purple
work RAM, blue SDRAM). LUT counts are combinational cells, two per ALM.</p>
<p class="meta">MiSTer-kun sits on the HPS: the ARM side, where the fabric has no logic sites.
Mascot by HeWhoisRed, remastered by baxysquare (github.com/baxysquare/mister_kun).</p>
<ul>{''.join(toc)}</ul>
{''.join(parts)}
</body></html>
"""
    with open(PAGE, "w", encoding="utf-8", newline="\n") as f:
        f.write(out)
    print(f"{os.path.relpath(PAGE, ROOT)}: {sum(len(s['floorplans']) for s in layout['systems'])} floorplans, "
          f"{len(out) // 1024} KB")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    c = sub.add_parser("collect")
    c.add_argument("--cores-dir", action="append", required=True)
    c.add_argument("--out", required=True)
    sub.add_parser("page")
    a = ap.parse_args()
    collect(a) if a.cmd == "collect" else page(a)


if __name__ == "__main__":
    main()
