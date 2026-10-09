"""HBMAME (homebrew and hacks) set names, so MiSTer sets that MAME does not know can be labelled.

HBMAME publishes no machine list, so the set names are read from the ``GAME(...)`` lines of its
driver sources (``src/hbmame/drivers``) at the newest release tag of github.com/Robbbert/hbmame
(``tag2893`` = 0.289.3). Written to ``data/hbmame.json``; the clone is only redone when a newer tag
appears. Hacks defined in files outside that directory are not seen.
"""
from __future__ import annotations

import datetime as dt
import glob
import json
import os
import re
import shutil
import subprocess

from . import paths

REPO = "https://github.com/Robbbert/hbmame"
FILE = os.path.join(paths.DATA, "hbmame.json")
GAME_RE = re.compile(r"\s*GAME[A-Z]*\s*\(\s*[^,]+,\s*(\w+)\s*,")


def load() -> dict:
    try:
        with open(FILE, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {"tag": None, "sets": []}


def latest_tag() -> str | None:
    """Newest release tag: ``tagNNN`` / ``tagNNNP`` (0.NNN, patch P), e.g. tag2893 = 0.289.3."""
    try:
        out = subprocess.check_output(["git", "ls-remote", "--tags", REPO], text=True, timeout=120, stderr=subprocess.DEVNULL)
    except (subprocess.SubprocessError, OSError):
        return None
    best = None
    for line in out.splitlines():
        tag = line.split("refs/tags/")[-1]
        m = re.fullmatch(r"tag(\d{3})(\d*)", tag)
        if m:
            key = (int(m.group(1)), int(m.group(2) or 0))
            if best is None or key > best[0]:
                best = (key, tag)
    return best[1] if best else None


def version_of(tag: str) -> str:
    m = re.fullmatch(r"tag(\d{3})(\d*)", tag)
    return f"0.{m.group(1)}" + (f".{m.group(2)}" if m.group(2) else "")


def build(force: bool = False) -> dict:
    cur = load()
    tag = latest_tag()
    if not tag:
        print("[hbmame] cannot list tags; keeping", cur.get("tag"))
        return cur
    if tag == cur.get("tag") and not force:
        print(f"[hbmame] {tag} already read ({len(cur['sets'])} sets)")
        return cur
    d = os.path.join(paths.CACHE, "hbmame")
    shutil.rmtree(d, ignore_errors=True)
    os.makedirs(paths.CACHE, exist_ok=True)
    try:
        subprocess.run(["git", "clone", "-q", "--depth", "1", "--filter=blob:none", "--sparse", "--branch", tag, REPO, d],
                       check=True, timeout=1500, stderr=subprocess.DEVNULL)
        subprocess.run(["git", "-C", d, "sparse-checkout", "set", "src/hbmame/drivers"], check=True, timeout=1500,
                       stderr=subprocess.DEVNULL)
    except (subprocess.SubprocessError, OSError) as e:
        print(f"[hbmame] clone failed ({e}); keeping", cur.get("tag"))
        return cur
    names: set[str] = set()
    for f in glob.glob(os.path.join(d, "src", "hbmame", "drivers", "*.cpp")):
        with open(f, encoding="utf-8", errors="replace") as fh:
            for line in fh:
                m = GAME_RE.match(line)
                if m:
                    names.add(m.group(1).lower())
    if len(names) < 1000:
        print(f"[hbmame] only {len(names)} sets parsed; keeping", cur.get("tag"))
        return cur
    out = {"tag": tag, "version": version_of(tag), "updated": dt.date.today().isoformat(), "sets": sorted(names)}
    with open(FILE, "w", encoding="utf-8") as f:
        json.dump(out, f)
        f.write("\n")
    shutil.rmtree(d, ignore_errors=True)
    print(f"[hbmame] {tag} ({out['version']}): {len(names)} sets")
    return out
