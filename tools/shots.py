#!/usr/bin/env python3
"""Prepare the screenshots shown when hovering a title on the page.

    IMAGE_SALT=<secret> python3 tools/shots.py --src ./snaps --out ./upload

``--src`` holds two folders, ``title/`` and ``ingame/``, with one image per parent set named
``<set>.png`` (or .jpg/.webp). Each is copied unchanged (native size, no re-encoding) to ``--out`` under a
*hashed* file name, ``HMAC-SHA256(IMAGE_SALT, "<kind>/<set>")`` (first 24 hex digits) plus its extension, so the
bucket's file names cannot be guessed from the MAME set names. ``data/images.json`` records which sets have
which image ({set: {"title": "<hash>.png", "ingame": "<hash>.png"}}); ``mmc report`` merges it into each title of
coverage.json (``img``), and the page builds ``<image-base>/<file>`` and never probes for images that do not exist.
Upload the files images.json names (``tools/blob_upload.mjs`` for Vercel Blob) and put the bucket's public URL in
the ``image-base`` meta tag of ``docs/index.html``.

Keep IMAGE_SALT private (not in the repository): with it, the names are reproducible; without it they are not.
Hashed names deter guessing and bulk scraping, not a determined visitor, who can still read the file names the
page requests; add a referer rule on the bucket (e.g. Cloudflare WAF) if you want real hotlink protection.
"""
from __future__ import annotations

import argparse
import hashlib
import hmac
import json
import os
import shutil
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
KINDS = ("title", "ingame")
EXTS = (".png", ".jpg", ".jpeg", ".webp")


def name_hash(salt: str, kind: str, key: str) -> str:
    return hmac.new(salt.encode(), f"{kind}/{key}".encode(), hashlib.sha256).hexdigest()[:24]


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--src", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--index", default=os.path.join(ROOT, "data", "images.json"))
    ap.add_argument("--keys", default=os.path.join(ROOT, "docs", "data", "keys.json"), help="only sets that are titles in keys.json")
    a = ap.parse_args()
    salt = os.environ.get("IMAGE_SALT", "").strip()   # a CRLF env file would otherwise add "\r" and change every name
    if not salt:
        ap.error("set IMAGE_SALT (a private string) so the file names cannot be guessed")
    try:
        with open(a.keys, encoding="utf-8") as f:
            titles = set(json.load(f)["titles"])
    except OSError:
        titles = None
    index: dict[str, dict[str, str]] = {}    # rebuilt from --src every run, so it names only files this run wrote
    os.makedirs(a.out, exist_ok=True)
    done = skipped = ignored = 0
    for kind in KINDS:
        folder = os.path.join(a.src, kind)
        if not os.path.isdir(folder):
            print(f"no {kind}/ folder in {a.src}", file=sys.stderr)
            continue
        for fn in sorted(os.listdir(folder)):
            key, ext = os.path.splitext(fn)
            if ext.lower() not in EXTS:
                continue
            key = key.lower()
            if titles is not None and key not in titles:
                ignored += 1
                continue
            h = name_hash(salt, kind, key) + ext.lower()
            dest = os.path.join(a.out, h)
            src = os.path.join(folder, fn)
            if not (os.path.exists(dest) and os.path.getmtime(dest) >= os.path.getmtime(src) and os.path.getsize(dest) == os.path.getsize(src)):
                shutil.copyfile(src, dest)
                done += 1
            else:
                skipped += 1
            index.setdefault(key, {})[kind] = h
    with open(a.index, "w", encoding="utf-8", newline="\n") as f:
        json.dump(dict(sorted(index.items())), f, separators=(",", ":"))
        f.write("\n")
    named = {f for v in index.values() for f in v.values()}
    stale = [f for f in os.listdir(a.out) if os.path.splitext(f)[1].lower() in EXTS and f not in named]
    per_kind = ", ".join(f"{sum(1 for v in index.values() if k in v)} {k}" for k in KINDS)
    print(f"{done} written, {skipped} unchanged, {ignored} ignored (not a known title); {len(index)} sets ({per_kind}) in {a.index}")
    if stale:
        print(f"{len(stale)} files in {a.out} are not in the index (older runs); they are not uploaded")
    return 0


if __name__ == "__main__":
    sys.exit(main())
