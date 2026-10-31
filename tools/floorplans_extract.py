#!/usr/bin/env python3
"""Prepare the floorplan pictures for the Blob store and write data/floorplans.json (the index the build and the page read).

    python3 tools/floorplans_extract.py --out <folder>                    # the pictures embedded in docs/floorplans.html
    python3 tools/floorplans_extract.py --out <folder> --from-dir DIR      # DIR/<revision>.png, e.g. a core's debug/floorplan/

Each picture is saved as ``fp-<revision>-<first 10 hex of its sha256>.png`` (a new picture is a new name, so the one-year cache
never serves a stale one), and ``data/floorplans.json`` becomes ``{revision: {"file": name, "w": width, "h": height}}``. Then upload:

    cd tools && BLOB_READ_WRITE_TOKEN=... node blob_upload.mjs <folder> --index ../data/floorplans.json

(the same store as the screenshots, ``image-base`` in docs/index.html). ``mmc`` ties each revision to the core whose build name it carries
(``MS32.png`` is JalecoMS32) and the Cores tab shows the picture from ``<image-base>/<file>``.
"""
import argparse
import base64
import hashlib
import json
import re
import struct
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def png_size(b: bytes) -> tuple[int, int]:
    return struct.unpack(">II", b[16:24])


def from_page(path: Path) -> dict[str, bytes]:
    html = path.read_text(encoding="utf-8")
    out = {}
    for m in re.finditer(r'<img alt="Floorplan of ([^"]+)" src="data:image/png;base64,([A-Za-z0-9+/=]+)"', html):
        out[m.group(1)] = base64.b64decode(m.group(2))
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True, help="folder to put the pictures in (they are uploaded from there)")
    ap.add_argument("--from-dir", help="read DIR/<revision>.png instead of docs/floorplans.html")
    ap.add_argument("--page", default=str(ROOT / "docs" / "floorplans.html"))
    ap.add_argument("--index", default=str(ROOT / "data" / "floorplans.json"))
    a = ap.parse_args()
    pics = {p.stem: p.read_bytes() for p in sorted(Path(a.from_dir).glob("*.png"))} if a.from_dir else from_page(Path(a.page))
    if not pics:
        print("no floorplan pictures found", file=sys.stderr)
        return 1
    out = Path(a.out); out.mkdir(parents=True, exist_ok=True)
    index = {}
    for rev, data in sorted(pics.items()):
        if data[:8] != b"\x89PNG\r\n\x1a\n":
            print(f"{rev}: not a PNG, skipped", file=sys.stderr); continue
        name = f"fp-{re.sub(r'[^A-Za-z0-9_-]', '', rev)}-{hashlib.sha256(data).hexdigest()[:10]}.png"
        (out / name).write_bytes(data)
        w, h = png_size(data)
        index[rev] = {"file": name, "w": w, "h": h}
    Path(a.index).write_text(json.dumps(index, indent=1) + "\n", encoding="utf-8")
    print(f"{len(index)} floorplans -> {out} and {a.index}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
