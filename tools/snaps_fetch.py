#!/usr/bin/env python3
"""Download the Progetto-SNAPS "Snap" (in-game) and "Titles" packs and turn them into the folder layout
``tools/shots.py`` reads.

    python3 tools/snaps_fetch.py --work D:/mame-shots            # find the packs, download, extract
    python3 tools/snaps_fetch.py --work D:/mame-shots --shots    # ... and run shots.py (needs IMAGE_SALT)

Layout under --work:  downloads/<pack>.zip,  src/ingame/<set>.png (Snap),  src/title/<set>.png (Titles),
src/versions.json (the MAME version each folder is at). Nothing here is committed to git.

First run: the newest full set (``pS_snap_fullset_<v>.zip``), then every update after it (``pS_snap_upd_<v>.zip``)
in version order, later files overwriting earlier ones. Later runs apply only the updates newer than
versions.json. The site keeps only the last few updates; if one in the gap is gone, the folder is rebuilt from
the newest full set (also with --full). Zips already in downloads/ are reused. The full sets hold their images
in a .7z inside the zip, unpacked with 7-Zip or bsdtar (Windows 10+ tar.exe).

https://www.progettosnaps.net/snapshots/ links each pack as ``/download/?tipo=...&file=<url of the zip>``, a
counter that redirects to the zip; no Referer or cookie is needed. Overrides, each a URL or a local zip whose
name ends in ``_<version>.zip``: --snap-full --snap-upd --titles-full --titles-upd.
"""
from __future__ import annotations

import argparse
import html.parser
import json
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile

PAGE = "https://www.progettosnaps.net/snapshots/"
UA = "Mozilla/5.0 (compatible; mister-mame-coverage-snaps/1.0)"
IMG = (".png", ".jpg", ".jpeg", ".webp")
PACKS = (("snap", "ingame"), ("titles", "title"))           # Progetto-SNAPS pack -> folder under src/
NAME = re.compile(r"^pS_(snap|titles)_(fullset|upd)_(\d+)\.zip$")  # excludes the +SL (software list) packs


class Links(html.parser.HTMLParser):
    def __init__(self):
        super().__init__()
        self.links: list[str] = []

    def handle_starttag(self, tag, attrs):
        href = dict(attrs).get("href") if tag == "a" else None
        if href:
            self.links.append(href)


def request(url: str, method: str = "GET"):
    return urllib.request.urlopen(urllib.request.Request(url, method=method, headers={"User-Agent": UA}), timeout=120)


def zip_url(href: str, page: str) -> str:
    """The zip a link points at: the file= parameter of a /download/ counter link, else the link itself."""
    url = urllib.parse.urljoin(page, href)
    target = urllib.parse.parse_qs(urllib.parse.urlparse(url).query).get("file")
    return urllib.parse.urljoin(page, target[0]) if target else url


def discover(page: str) -> dict[tuple[str, str], tuple[int, str]]:
    """{(pack, 'fullset'|'upd'): (version, zip url)}, the newest of each."""
    p = Links()
    with request(page) as r:
        p.feed(r.read().decode("utf-8", "replace"))
    best: dict[tuple[str, str], tuple[int, str]] = {}
    for href in p.links:
        url = zip_url(href, page)
        m = NAME.match(os.path.basename(urllib.parse.unquote(urllib.parse.urlparse(url).path)))
        if m and int(m[3]) > best.get((m[1], m[2]), (-1, ""))[0]:
            best[(m[1], m[2])] = (int(m[3]), url)
    return best


def override(value: str) -> tuple[int, str]:
    m = re.search(r"_(\d+)\.zip$", os.path.basename(urllib.parse.unquote(urllib.parse.urlparse(value).path)))
    if not m:
        raise SystemExit(f"{value}: cannot read the MAME version (expected a name ending in _<version>.zip)")
    return int(m[1]), value


def available(url: str, dl: str) -> bool:
    if os.path.exists(os.path.join(dl, os.path.basename(url))):
        return True
    try:
        with request(url, "HEAD") as r:
            return r.status == 200 and "zip" in r.headers.get("Content-Type", "")
    except urllib.error.URLError:
        return False


def fetch(url: str, dl: str) -> str:
    """Local path of the zip, downloading it into dl unless it is already there (or url is a local file)."""
    if os.path.isfile(url):
        return url
    dest = os.path.join(dl, os.path.basename(urllib.parse.unquote(urllib.parse.urlparse(url).path)))
    if os.path.exists(dest) and zipfile.is_zipfile(dest):
        print(f"  have {os.path.basename(dest)}")
        return dest
    with request(url) as r, open(dest + ".part", "wb") as f:
        print(f"  downloading {url} ({int(r.headers.get('Content-Length') or 0) >> 20} MB)", flush=True)
        while chunk := r.read(1 << 20):
            f.write(chunk)
    if not zipfile.is_zipfile(dest + ".part"):
        raise SystemExit(f"{url} did not return a zip; download it in a browser and pass the file with --snap-full etc.")
    os.replace(dest + ".part", dest)
    return dest


def unpack_7z(archive: str, out: str) -> None:
    """The full sets hold their images in a .7z inside the zip: unpack it with 7-Zip, else bsdtar (Windows tar.exe)."""
    for exe in ("7z", "7zz", "7za", r"C:\Program Files\7-Zip\7z.exe"):
        if path := shutil.which(exe):
            subprocess.run([path, "x", "-y", "-bso0", "-bsp0", f"-o{out}", archive], check=True)
            return
    for exe in (os.path.join(os.environ.get("SystemRoot", r"C:\Windows"), "System32", "tar.exe"), "bsdtar"):
        if path := shutil.which(exe):
            os.makedirs(out, exist_ok=True)
            subprocess.run([path, "-xf", archive, "-C", out], check=True)
            return
    raise SystemExit("the full sets are .7z inside the zip: install 7-Zip (7z) or bsdtar")


def images(zip_path: str, tmp: str) -> dict[str, tuple[str, zipfile.ZipInfo | None]]:
    """{lowercased file name: (zip, entry) or (unpacked file, None)} for the images in a pack, wherever they sit in it."""
    found: dict[str, tuple[str, zipfile.ZipInfo | None]] = {}
    with zipfile.ZipFile(zip_path) as z:
        for i in z.infolist():
            ext = os.path.splitext(i.filename)[1].lower()
            if i.is_dir():
                continue
            if ext in IMG:
                found[os.path.basename(i.filename).lower()] = (zip_path, i)
            elif ext == ".7z":
                print(f"  unpacking {i.filename} from {os.path.basename(zip_path)}", flush=True)
                inner = z.extract(i, tmp)
                unpack_7z(inner, os.path.join(tmp, "x"))
                os.remove(inner)
                for root, _, files in os.walk(os.path.join(tmp, "x")):
                    found.update((f.lower(), (os.path.join(root, f), None)) for f in files if os.path.splitext(f)[1].lower() in IMG)
    return found


def apply(zips: list[str], out: str, tmp: str) -> None:
    """Put the zips' images into out, later zips overwriting earlier ones. Bytes are copied unchanged, with the
    archive's file time, so shots.py does not recopy images that did not change."""
    final: dict[str, tuple[str, zipfile.ZipInfo | None]] = {}
    for zp in zips:
        got = images(zp, os.path.join(tmp, os.path.basename(zp)))
        replaced = sum(1 for n in got if n in final)
        before = len(final)
        final.update(got)
        print(f"  {os.path.basename(zp)}: {len(got)} images, {replaced} replace earlier ones, {len(final) - before} new; {before} -> {len(final)}")
    os.makedirs(out, exist_ok=True)
    open_zips: dict[str, zipfile.ZipFile] = {}
    try:
        for n, (src, i) in final.items():
            dest = os.path.join(out, n)
            if i is None:                     # unpacked from a .7z: move it (same drive, keeps its time)
                os.replace(src, dest)
                continue
            z = open_zips.get(src) or open_zips.setdefault(src, zipfile.ZipFile(src))
            with z.open(i) as f, open(dest, "wb") as g:
                g.write(f.read())
            t = time.mktime(i.date_time + (0, 0, -1))
            os.utime(dest, (t, t))
    finally:
        for z in open_zips.values():
            z.close()
        shutil.rmtree(tmp, ignore_errors=True)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--work", required=True, help="working folder on your machine (not in the repository)")
    ap.add_argument("--page", default=PAGE)
    for k in ("snap-full", "snap-upd", "titles-full", "titles-upd"):
        ap.add_argument(f"--{k}", metavar="URL|ZIP", help=f"use this {k.replace('-', ' ')} zip instead of the page's")
    ap.add_argument("--full", action="store_true", help="rebuild src/ from the full set even if updates would do")
    ap.add_argument("--shots", action="store_true", help="then run tools/shots.py (IMAGE_SALT must be set)")
    a = ap.parse_args()

    manual = {("snap", "fullset"): a.snap_full, ("snap", "upd"): a.snap_upd,
              ("titles", "fullset"): a.titles_full, ("titles", "upd"): a.titles_upd}
    found = {} if all(manual.values()) else discover(a.page)
    links = {k: override(v) if v else found.get(k) for k, v in manual.items()}
    for (pack, part), v in links.items():
        print(f"{pack:6} {part:7} " + (f"{v[0]}  {v[1]}" if v else "NOT FOUND"))

    dl, src = os.path.join(a.work, "downloads"), os.path.join(a.work, "src")
    os.makedirs(dl, exist_ok=True)
    state_path = os.path.join(src, "versions.json")
    try:
        with open(state_path, encoding="utf-8") as f:
            state = json.load(f)
    except (OSError, ValueError):
        state = {}
    for pack, folder in PACKS:
        full, upd = links[(pack, "fullset")], links[(pack, "upd")]
        newest = max(v[0] for v in (full, upd) if v) if full or upd else None
        have = None if a.full else state.get(pack)
        print(f"{pack}: src/{folder} at {have or 'nothing'}, newest {newest}")
        if newest is None:
            print(f"  no {pack} pack found; pass --{pack}-full / --{pack}-upd", file=sys.stderr)
            return 1
        if have is not None and have >= newest:
            continue
        upd_dir = upd[1].rsplit("/", 1)[0] if upd and not os.path.isfile(upd[1]) else None

        def upd_url(v: int) -> str | None:
            if upd and v == upd[0]:
                return upd[1]
            return f"{upd_dir}/pS_{pack}_upd_{v}.zip" if upd_dir and available(f"{upd_dir}/pS_{pack}_upd_{v}.zip", dl) else None

        steps = [upd_url(v) for v in range(have + 1, newest + 1)] if have is not None else [None]
        if None in steps:                     # nothing yet, a missing update, or --full: start from the full set
            if not full:
                print(f"  no full {pack} set found; pass --{pack}-full", file=sys.stderr)
                return 1
            steps = [full[1]] + [upd_url(v) for v in range(full[0] + 1, newest + 1)]
            if None in steps:
                missing = [v for v, s in zip(range(full[0] + 1, newest + 1), steps[1:]) if s is None]
                print(f"  updates {missing} after full set {full[0]} are not on the server", file=sys.stderr)
                return 1
        apply([fetch(s, dl) for s in steps], os.path.join(src, folder), os.path.join(a.work, "tmp"))
        state[pack] = newest
        with open(state_path, "w", encoding="utf-8") as f:
            json.dump(state, f)
    print(f"images in {src}: " + ", ".join(f"{d} {len(os.listdir(os.path.join(src, d)))}" for _, d in PACKS if os.path.isdir(os.path.join(src, d))))
    if a.shots:
        tool = os.path.join(os.path.dirname(os.path.abspath(__file__)), "shots.py")
        return subprocess.call([sys.executable, tool, "--src", src, "--out", os.path.join(a.work, "upload")])
    return 0


if __name__ == "__main__":
    sys.exit(main())
