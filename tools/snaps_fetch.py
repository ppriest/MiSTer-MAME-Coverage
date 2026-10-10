#!/usr/bin/env python3
"""Download the Progetto-SNAPS "Snap" (in-game) and "Titles" packs, full + update zips, and turn them into
the folder layout ``tools/shots.py`` reads.

    python3 tools/snaps_fetch.py --work ~/mame-shots            # find the links, download, extract
    python3 tools/snaps_fetch.py --work ~/mame-shots --shots    # ... and run shots.py (needs IMAGE_SALT)

Layout produced under --work:  downloads/*.zip,  src/ingame/<set>.png (Snap),  src/title/<set>.png (Titles).
The update zips are extracted after the full zips and overwrite them. Nothing here is committed to git.

The page https://www.progettosnaps.net/snapshots/ is scraped for .zip links (snap/titles, full/upd). If it
cannot be parsed, pass the four links by hand: --snap-full URL --snap-upd URL --titles-full URL --titles-upd URL.
"""
from __future__ import annotations

import argparse
import html.parser
import os
import re
import subprocess
import sys
import urllib.parse
import urllib.request
import zipfile

PAGE = "https://www.progettosnaps.net/snapshots/"
UA = "Mozilla/5.0 (compatible; mister-mame-coverage-snaps/1.0)"
IMG = (".png", ".jpg", ".jpeg", ".webp")


class Links(html.parser.HTMLParser):
    def __init__(self):
        super().__init__()
        self.links: list[str] = []

    def handle_starttag(self, tag, attrs):
        if tag == "a":
            href = dict(attrs).get("href")
            if href:
                self.links.append(href)


def get(url: str, referer: str | None = None) -> urllib.request.addinfourl:
    req = urllib.request.Request(url, headers={"User-Agent": UA, **({"Referer": referer} if referer else {})})
    return urllib.request.urlopen(req, timeout=120)


def classify(link: str) -> tuple[str, str] | None:
    """('snap'|'titles', 'full'|'upd') from a download link, else None."""
    low = urllib.parse.unquote(link).lower()
    if ".zip" not in low:
        return None
    kind = "titles" if "title" in low else "snap" if "snap" in low else None
    if kind is None:
        return None
    return kind, ("upd" if re.search(r"upd|update", low) else "full")


def version_key(link: str) -> int:
    m = re.findall(r"\d+", os.path.basename(urllib.parse.unquote(link)))
    return int(m[-1]) if m else 0


def discover(page: str) -> dict[tuple[str, str], str]:
    p = Links()
    p.feed(get(page).read().decode("utf-8", "replace"))
    best: dict[tuple[str, str], str] = {}
    for href in p.links:
        c = classify(href)
        if not c:
            continue
        url = urllib.parse.urljoin(page, href)
        if c not in best or version_key(url) > version_key(best[c]):
            best[c] = url
    return best


def download(url: str, dest: str, referer: str, refresh: bool) -> None:
    if os.path.exists(dest) and not refresh and zipfile.is_zipfile(dest):
        print(f"  have {os.path.basename(dest)}")
        return
    print(f"  downloading {url}")
    with get(url, referer) as r, open(dest + ".part", "wb") as f:
        while chunk := r.read(1 << 20):
            f.write(chunk)
    os.replace(dest + ".part", dest)
    if not zipfile.is_zipfile(dest):
        raise SystemExit(f"{dest} is not a zip (the site may need a manual download); use --snap-full etc. with direct links")


def extract(zip_path: str, out_dir: str) -> int:
    os.makedirs(out_dir, exist_ok=True)
    n = 0
    with zipfile.ZipFile(zip_path) as z:
        for info in z.infolist():
            name = os.path.basename(info.filename)
            stem, ext = os.path.splitext(name)
            if info.is_dir() or ext.lower() not in IMG:
                continue
            with z.open(info) as src, open(os.path.join(out_dir, stem.lower() + ext.lower()), "wb") as dst:
                dst.write(src.read())
            n += 1
    return n


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--work", required=True, help="working folder on your machine (not in the repository)")
    ap.add_argument("--page", default=PAGE)
    for k in ("snap-full", "snap-upd", "titles-full", "titles-upd"):
        ap.add_argument(f"--{k}", help=f"direct link of the {k.replace('-', ' ')} zip")
    ap.add_argument("--refresh", action="store_true", help="download again even if the zip is already there")
    ap.add_argument("--shots", action="store_true", help="then run tools/shots.py (IMAGE_SALT must be set)")
    a = ap.parse_args()

    found = {}
    manual = {("snap", "full"): a.snap_full, ("snap", "upd"): a.snap_upd, ("titles", "full"): a.titles_full, ("titles", "upd"): a.titles_upd}
    if not all(manual.values()):
        try:
            found = discover(a.page)
        except Exception as e:
            print(f"could not read {a.page}: {e}", file=sys.stderr)
    links = {k: manual[k] or found.get(k) for k in manual}
    for k, v in links.items():
        print(f"{k[0]:6} {k[1]:4} {v or 'NOT FOUND'}")
    if not links[("snap", "full")] or not links[("titles", "full")]:
        print("The full Snap and Titles zips are required: pass them with --snap-full / --titles-full.", file=sys.stderr)
        return 1

    dl = os.path.join(a.work, "downloads")
    os.makedirs(dl, exist_ok=True)
    counts = {}
    for kind, folder in (("snap", "ingame"), ("titles", "title")):
        out = os.path.join(a.work, "src", folder)
        for part in ("full", "upd"):          # updates last, so they overwrite the full pack's images
            url = links[(kind, part)]
            if not url:
                print(f"  (no {kind} {part} zip)")
                continue
            dest = os.path.join(dl, f"{kind}_{part}_{os.path.basename(urllib.parse.urlparse(url).query or urllib.parse.unquote(url)).replace('/', '_')[-60:] or part}.zip")
            download(url, dest, a.page, a.refresh)
            counts[(kind, part)] = extract(dest, out)
            print(f"  {kind} {part}: {counts[(kind, part)]} images -> {out}")
    print(f"images in {os.path.join(a.work, 'src')}: " + ", ".join(f"{d} {len(os.listdir(os.path.join(a.work, 'src', d)))}" for d in ("ingame", "title")))
    if a.shots:
        tool = os.path.join(os.path.dirname(os.path.abspath(__file__)), "shots.py")
        return subprocess.call([sys.executable, tool, "--src", os.path.join(a.work, "src"), "--out", os.path.join(a.work, "upload")])
    return 0


if __name__ == "__main__":
    sys.exit(main())
