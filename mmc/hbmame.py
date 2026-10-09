"""HBMAME (homebrew and hacks) set names, so MiSTer sets that MAME does not know can be labelled.

Preferred source: the ``hbmame.exe -listxml`` that .github/workflows/hbmame.yml publishes as a
release asset (HBMAME is Windows-only, so it runs on a Windows runner). Until one exists, the set names are read from the ``GAME(...)`` lines of its
driver sources (``src/hbmame/drivers``) at the newest release tag of github.com/Robbbert/hbmame
(``tag2893`` = 0.289.3). The same lines carry the metadata a ``-listxml`` would (year, parent,
manufacturer, description), which is stored per set. HBMAME ships Windows binaries only,
so ``-listxml`` itself cannot be run here. Written to ``data/hbmame.json``; the clone is only redone when a newer tag
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
GAME_RE = re.compile(r"\s*GAME[A-Z]*\s*\((.*)\)\s*(?://.*)?$")


NAME_RE = re.compile(r"\s*GAME[A-Z]*\s*\(\s*[^,]+,\s*(\w+)\s*,")


def split_args(text: str) -> list[str]:
    """Split a macro argument list on top-level commas (quotes and nested parentheses respected)."""
    out, cur, depth, q = [], [], 0, False
    for ch in text:
        if ch == '"' and (not cur or cur[-1] != "\\"):
            q = not q
        elif not q:
            if ch == "(":
                depth += 1
            elif ch == ")":
                depth -= 1
            elif ch == "," and depth == 0:
                out.append("".join(cur).strip())
                cur = []
                continue
        cur.append(ch)
    out.append("".join(cur).strip())
    return out


def parse_game(line: str) -> tuple[str, dict] | None:
    """``GAME(year, name, parent, machine, input, class, init, rotation, "company", "description", flags)``."""
    m = GAME_RE.match(line)
    if not m:
        return None
    a = split_args(m.group(1))
    if len(a) < 10 or not re.fullmatch(r"\w+", a[1]):
        return None
    unq = lambda x: x.strip('"')
    parent = a[2] if re.fullmatch(r"\w+", a[2]) and a[2] != "0" else None
    return a[1].lower(), {"year": unq(a[0]), "parent": parent, "manufacturer": unq(a[8]), "desc": unq(a[9])}


def load() -> dict:
    try:
        with open(FILE, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {"tag": None, "sets": {}}


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


LISTXML_URL = "https://github.com/ppriest/MiSTer-MAME-Coverage/releases/download/hbmame-listxml/hbmame-lx.zip"


def from_listxml(cur: dict, force: bool) -> dict | None:
    """Use the ``hbmame.exe -listxml`` published by .github/workflows/hbmame.yml, when there is one."""
    import urllib.request

    from . import mame as mame_mod
    try:
        req = urllib.request.Request(LISTXML_URL, method="HEAD")
        with urllib.request.urlopen(req, timeout=60) as r:
            size = int(r.headers.get("Content-Length") or 0)
    except Exception:
        return None
    if not force and cur.get("asset") == size and cur.get("from") == "listxml":
        print(f"[hbmame] listxml unchanged ({len(cur['sets'])} sets)")
        return cur
    dest = os.path.join(paths.CACHE, "hbmame-lx.zip")
    os.makedirs(paths.CACHE, exist_ok=True)
    try:
        with urllib.request.urlopen(LISTXML_URL, timeout=300) as r, open(dest, "wb") as f:
            shutil.copyfileobj(r, f)
        parsed = mame_mod.parse_listxml(dest)
    except Exception as e:
        print(f"[hbmame] listxml unusable ({e}); falling back to the driver sources")
        return None
    sets = {n: {k: v for k, v in {"year": m["year"], "parent": m["cloneof"], "manufacturer": m["manufacturer"],
                                  "desc": m["desc"], "source": m["sourcefile"]}.items() if v}
            for n, m in sorted(parsed["machines"].items())}
    if len(sets) < 1000:
        return None
    out = {"from": "listxml", "tag": parsed.get("build"), "version": parsed.get("build"), "asset": size,
           "updated": dt.date.today().isoformat(), "sets": sets}
    with open(FILE, "w", encoding="utf-8") as f:
        json.dump(out, f)
        f.write("\n")
    print(f"[hbmame] -listxml {parsed.get('build')}: {len(sets)} sets")
    return out


def build(force: bool = False) -> dict:
    cur = load()
    got = from_listxml(cur, force)
    if got:
        return got
    tag = latest_tag()
    if not tag:
        print("[hbmame] cannot list tags; keeping", cur.get("tag"))
        return cur
    if tag == cur.get("tag") and cur.get("from") != "listxml" and not force:
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
    names: dict[str, dict] = {}
    for f in sorted(glob.glob(os.path.join(d, "src", "hbmame", "drivers", "*.cpp"))):
        src = os.path.basename(f)
        with open(f, encoding="utf-8", errors="replace") as fh:
            for line in fh:
                g = parse_game(line)
                if g:
                    names.setdefault(g[0], dict(g[1], source=src))
                else:           # a line the argument parser cannot read still names the set
                    m = NAME_RE.match(line)
                    if m:
                        names.setdefault(m.group(1).lower(), {"source": src})
    if len(names) < 1000:
        print(f"[hbmame] only {len(names)} sets parsed; keeping", cur.get("tag"))
        return cur
    out = {"from": "source", "tag": tag, "version": version_of(tag), "updated": dt.date.today().isoformat(), "sets": dict(sorted(names.items()))}
    with open(FILE, "w", encoding="utf-8") as f:
        json.dump(out, f)
        f.write("\n")
    shutil.rmtree(d, ignore_errors=True)
    print(f"[hbmame] {tag} ({out['version']}): {len(names)} sets")
    return out
