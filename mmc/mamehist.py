"""When did each set enter MAME? Two sources, merged into the committed ``data/mame_added.json``:

* ``catver.ini``'s ``[VerAdded]`` section (the libretro mame2016 copy reaches 0.180), giving the
  version that first listed each set, e.g. ``10yard = .108u5``;
* ``src/mame/mame.lst`` at every release tag from 0.180 on, fetched raw from GitHub: a set that is
  in version N's list and not in N-1's was added in N.

* M.A.S.H.'s MAMEUI "Version" folder files (``MAMEUI-inifiles-0XXX.zip`` in
  https://github.com/MASHinfo/mameinfo, ``folders/Version*.ini``): the sets added in every release
  and "u" update from 0.129u5 to the current version, with update granularity. Every source can
  only move a set's date earlier, so a set re-listed after a rename keeps its first appearance.

Version dates come from the release tags of mamedev/mame (a tree-less, depth-1 fetch of
``refs/tags/mame0*`` is under 2 MB). Versions older than the first tag (0.121, 2007) and the
"u" updates between tags are interpolated from a short table of known release dates.

Set renames are ignored on purpose: a renamed set looks like a removal plus an addition, so it is
dated by its new name's first appearance. The file is append-only: a run only fetches the
``mame.lst`` of versions it has not seen.
"""
from __future__ import annotations

import datetime as dt
import json
import os
import re
import subprocess
import urllib.request

from . import paths

MAME_ADDED = os.path.join(paths.DATA, "mame_added.json")
MASH_REPO = "https://github.com/MASHinfo/mameinfo"
MASH_RAW = "https://raw.githubusercontent.com/MASHinfo/mameinfo/main/download/"
MASH_DIR = os.path.join(paths.CACHE, "mash")
TAGS_DIR = os.path.join(paths.CACHE, "mametags")
LST_DIR = os.path.join(paths.CACHE, "mamelst")
LST_URL = "https://raw.githubusercontent.com/mamedev/mame/mame{v}/src/mame/mame.lst"
FIRST_LST = 180  # mame.lst diffs start here; catver's VerAdded covers what came before

# Release dates for versions without a git tag (before 0.121) or between tags; approximate.
ANCHORS = {
    "0.001": "1997-02-05", "0.020": "1997-06-01", "0.030": "1998-03-01", "0.034": "1998-07-01",
    "0.035": "1999-06-01", "0.036": "2000-01-15", "0.037": "2000-07-01", "0.053": "2001-08-01",
    "0.060": "2002-05-01", "0.062": "2002-12-01", "0.070": "2003-06-01", "0.078": "2003-12-25",
    "0.080": "2004-03-10", "0.090": "2005-01-01", "0.100": "2005-09-26", "0.110": "2006-11-01",
    "0.120": "2007-10-22", "0.121": "2007-11-15",
}


def _git(*args, cwd=TAGS_DIR):
    return subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True, check=False)


def fetch_version_dates() -> dict[str, str]:
    """``{"0.289": "2026-07-30", "0.121u1": ...}`` from mamedev/mame's release tags."""
    os.makedirs(TAGS_DIR, exist_ok=True)
    if not os.path.isdir(os.path.join(TAGS_DIR, ".git")):
        _git("init", "-q")
        _git("remote", "add", "origin", "https://github.com/mamedev/mame")
    _git("fetch", "-q", "--filter=tree:0", "--depth=1", "origin", "refs/tags/mame0*:refs/tags/mame0*")
    out = _git("for-each-ref", "--format=%(refname:short) %(creatordate:short)", "refs/tags").stdout
    dates = {}
    for line in out.splitlines():
        tag, date = line.split()
        m = re.fullmatch(r"mame0(\d{3})([ub]\d+)?", tag)
        if m:
            dates[f"0.{m.group(1)}{m.group(2) or ''}"] = date
    return dates


def _vkey(v: str) -> tuple[int, int]:
    """Sort key: ``0.034b2`` (a beta before 0.34) < ``0.034`` < ``0.034u1`` (an update after it)."""
    m = re.fullmatch(r"0\.(\d{1,3})(?:(u|b)(\d+))?", v)
    if not m:
        return (0, 0)
    major, kind, n = int(m.group(1)), m.group(2), int(m.group(3) or 0)
    return (major, n if kind == "u" else -100 + n if kind == "b" else 0)


def version_date(v: str, dates: dict[str, str]) -> str | None:
    """Date for a version: tagged, else interpolated between the nearest dated versions."""
    if v in dates:
        return dates[v]
    known = sorted(((_vkey(k), d) for k, d in {**ANCHORS, **dates}.items()), key=lambda x: x[0])
    k = _vkey(v)
    if not k[0]:
        return None
    before = [x for x in known if x[0] <= k]
    after = [x for x in known if x[0] > k]
    if not before:
        return known[0][1]
    if not after:
        return before[-1][1]
    (k0, d0), (k1, d1) = before[-1], after[0]
    frac = lambda kk: kk[0] + kk[1] / 200   # "u"/"b" releases as fractions of a version
    a, b = frac(k0), frac(k1)
    f = (frac(k) - a) / (b - a) if b > a else 0
    t0, t1 = dt.date.fromisoformat(d0), dt.date.fromisoformat(d1)
    return (t0 + (t1 - t0) * f).isoformat()


def parse_lst(path: str) -> set[str]:
    out = set()
    with open(path, encoding="utf-8", errors="replace") as f:
        for line in f:
            line = line.strip()
            if not line or line[0] in "@/#":
                continue
            name = line.split()[0]
            if re.fullmatch(r"[a-z0-9_]+", name):
                out.add(name)
    return out


def fetch_lst(v: int) -> str | None:
    os.makedirs(LST_DIR, exist_ok=True)
    dest = os.path.join(LST_DIR, f"mame0{v}.lst")
    if os.path.exists(dest) and os.path.getsize(dest) > 1000:
        return dest
    try:
        with urllib.request.urlopen(LST_URL.format(v=v), timeout=60) as r, open(dest, "wb") as f:
            f.write(r.read())
        return dest
    except Exception:
        if os.path.exists(dest):
            os.remove(dest)
        return None


def veradded_from_catver() -> dict[str, str]:
    """``{set: "0.108u5"}`` from the ``[VerAdded]`` sections of the cached catver copies."""
    from .genre import CATVER_URLS, _fetch
    out: dict[str, str] = {}
    sources = [os.path.join(paths.DATA, "catver.ini")] + [
        _fetch(url, os.path.join(paths.CACHE, f"catver_{name}.ini")) or "" for name, url in CATVER_URLS]
    for path in sources:
        if not path or not os.path.exists(path):
            continue
        section = None
        with open(path, encoding="utf-8", errors="replace") as f:
            for line in f:
                line = line.strip()
                if line.startswith("[") and line.endswith("]"):
                    section = line[1:-1].lower()
                    continue
                if section == "veradded" and "=" in line:
                    k, v = (x.strip() for x in line.split("=", 1))
                    v = v.lstrip(".")
                    m = re.fullmatch(r"(\d{1,3})(?:([ub])0*(\d+))?", v)
                    if m and k.lower() not in out:
                        suffix = f"{m.group(2)}{int(m.group(3))}" if m.group(2) else ""
                        out[k.lower()] = f"0.{int(m.group(1)):03d}{suffix}"
    return out


def mash_versions() -> tuple[dict[str, str], str | None]:
    """``{set: "0.129u5"}`` from the newest ``MAMEUI-inifiles-*.zip`` in MASHinfo/mameinfo.

    The repository's download folder holds ~100 MB, so it is listed through a blob-less clone and
    only the one zip (about 1 MB) is fetched, by raw URL."""
    import urllib.parse
    import zipfile
    os.makedirs(MASH_DIR, exist_ok=True)
    repo = os.path.join(MASH_DIR, "repo")
    if not os.path.isdir(os.path.join(repo, ".git")):
        subprocess.run(["git", "clone", "-q", "--filter=blob:none", "--no-checkout", "--depth=1", MASH_REPO, repo],
                       capture_output=True, check=False)
    else:
        subprocess.run(["git", "fetch", "-q", "--depth=1", "origin"], cwd=repo, capture_output=True, check=False)
        subprocess.run(["git", "reset", "-q", "--soft", "origin/HEAD"], cwd=repo, capture_output=True, check=False)
    names = subprocess.run(["git", "ls-tree", "--name-only", "HEAD", "download/"], cwd=repo,
                           capture_output=True, text=True, check=False).stdout.splitlines()
    zips = sorted((m.group(1), n) for n in names if (m := re.search(r"MAMEUI-inifiles-0?(\d{3})\.zip$", n)))
    if not zips:
        return {}, None
    ver, name = zips[-1]
    dest = os.path.join(MASH_DIR, os.path.basename(name))
    if not os.path.exists(dest):
        url = MASH_RAW + urllib.parse.quote(os.path.basename(name))
        with urllib.request.urlopen(url, timeout=120) as r, open(dest, "wb") as f:
            f.write(r.read())
    out: dict[str, str] = {}
    with zipfile.ZipFile(dest) as z:
        for member in z.namelist():
            if not re.search(r"folders/Version[^/]*\.ini$", member):
                continue
            section = None
            for raw in z.read(member).decode("utf-8", errors="replace").splitlines():
                line = raw.strip()
                m = re.fullmatch(r"\[\.(\d{1,3})(u\d+)?\]", line)
                if m:
                    section = f"0.{int(m.group(1)):03d}{m.group(2) or ''}"
                    continue
                if line.startswith("["):
                    section = None
                    continue
                if section and re.fullmatch(r"[a-z0-9_]+", line):
                    cur = out.get(line)
                    if cur is None or _vkey(section) < _vkey(cur):
                        out[line] = section
    return out, f"0.{ver}"


def load() -> dict:
    if os.path.exists(MAME_ADDED):
        with open(MAME_ADDED, encoding="utf-8") as f:
            return json.load(f)
    return {"versions": {}, "sets": {}, "lst_versions": []}


def build(latest: int) -> dict:
    """Refresh ``data/mame_added.json`` up to MAME 0.<latest>; returns it."""
    data = load()
    data["versions"] = fetch_version_dates() or data.get("versions", {})
    sets: dict[str, str] = data.get("sets", {})
    if not sets:
        sets.update(veradded_from_catver())
        print(f"[mamehist] {len(sets)} sets dated by catver VerAdded")
    def earlier(name: str, version: str) -> bool:
        """Record ``version`` for ``name`` if it is the first we know of. Every source is an upper
        bound (a set re-listed after a rename or re-dump shows up again later), so dates only move
        earlier."""
        if name not in sets or _vkey(version) < _vkey(sets[name]):
            sets[name] = version
            return True
        return False

    mash, mash_ver = mash_versions()
    if mash:
        moved = sum(1 for k, v in mash.items() if earlier(k, v))
        data["mash_version"] = mash_ver
        print(f"[mamehist] M.A.S.H. Version.ini ({mash_ver}): {len(mash)} sets, {moved} dated or moved earlier")
    seen = set(data.get("lst_versions", []))
    prev: set[str] | None = None
    for v in range(FIRST_LST, latest + 1):
        path = fetch_lst(v)
        if not path:
            print(f"[mamehist] no mame.lst for 0.{v}")
            continue
        cur = parse_lst(path)
        if v == FIRST_LST:
            # Anything already in 0.180 is at least that old (an upper bound, like every source).
            n = sum(1 for s in cur if earlier(s, f"0.{FIRST_LST}"))
            if n:
                print(f"[mamehist] {n} sets in 0.{FIRST_LST}: dated 0.{FIRST_LST} or earlier")
        elif prev is not None and v not in seen:
            added = cur - prev
            for s in added:
                earlier(s, f"0.{v}")
            print(f"[mamehist] 0.{v}: +{len(added)} sets")
        prev = cur
        seen.add(v)
    data["sets"] = dict(sorted(sets.items()))
    data["lst_versions"] = sorted(seen)
    data["updated"] = dt.date.today().isoformat()
    os.makedirs(paths.DATA, exist_ok=True)
    with open(MAME_ADDED, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=0)
        f.write("\n")
    return data


def dates_for_sets(data: dict) -> dict[str, tuple[str, str | None]]:
    """``{set: (version, date)}`` with interpolated dates for untagged versions."""
    cache: dict[str, str | None] = {}
    out = {}
    for s, v in data.get("sets", {}).items():
        if v not in cache:
            cache[v] = version_date(v, data.get("versions", {}))
        out[s] = (v, cache[v])
    return out
