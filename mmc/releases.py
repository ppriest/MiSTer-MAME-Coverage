"""Cores that are published as GitHub *release* assets: a zip (or loose files) with the MRAs and the ``.rbf``, and nothing of the
sort in the repository tree. For each repository in ``mister.RELEASE_REPOS`` the newest release is looked up through the GitHub
API, its assets are downloaded and the ``.mra``/``.mgl``/``.rbf`` files expanded under ``work/releases/<owner>__<repo>/tree``
(skipped when the release and its assets are unchanged), then read like the MRAs of a repository: ``scan_release`` returns the
same shape as ``mister.scan_repo``. A set's date is the release's publication date; the ledger keeps the earliest one.

The API is GITHUB_TOKEN-authenticated when the variable is set (CI); ``MMC_RELEASE_API`` replaces ``https://api.github.com`` (tests).
"""
from __future__ import annotations

import datetime as dt
import io
import json
import os
import re
import urllib.request
import zipfile

from . import mister as mister_mod, paths

API = os.environ.get("MMC_RELEASE_API", "https://api.github.com").rstrip("/")
WANTED = (".mra", ".mgl", ".rbf")          # what is expanded from an archive
MAX_ASSET = 300 * 1024 * 1024


def release_dir(full: str) -> str:
    return os.path.join(os.path.dirname(paths.REPOS), "releases", full.replace("/", "__"))


def _open(url: str, accept: str | None = None):
    req = urllib.request.Request(url, headers={"User-Agent": "mister-mame-coverage", **({"Accept": accept} if accept else {})})
    token = os.environ.get("GITHUB_TOKEN")
    if token and url.startswith(API):
        req.add_header("Authorization", "Bearer " + token)
    return urllib.request.urlopen(req, timeout=120)


def latest_release(full: str) -> dict | None:
    """The newest published release (prereleases count: betas are what this is for)."""
    with _open(f"{API}/repos/{full}/releases?per_page=10", "application/vnd.github+json") as r:
        rels = [x for x in json.load(r) if not x.get("draft")]
    rels.sort(key=lambda x: x.get("published_at") or x.get("created_at") or "", reverse=True)
    return rels[0] if rels else None


def _safe(name: str) -> str | None:
    p = os.path.normpath(name.replace("\\", "/")).lstrip("/")
    return None if p.startswith("..") or p in ("", ".") else p


def _extract(data: bytes, into: str) -> list[str]:
    out = []
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        for info in z.infolist():
            rel = _safe(info.filename)
            if not rel or info.is_dir() or not rel.lower().endswith(WANTED):
                continue
            dest = os.path.join(into, rel)
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            with z.open(info) as src, open(dest, "wb") as f:
                f.write(src.read())
            out.append(rel)
    return out


def sync_release(full: str) -> str | None:
    """Download and expand the newest release of ``full``; returns an error message, or None."""
    d = release_dir(full)
    try:
        rel = latest_release(full)
        if rel is None:
            return "no release"
        assets = [a for a in rel.get("assets", []) if a["name"].lower().endswith((".zip",) + WANTED) and a.get("size", 0) <= MAX_ASSET]
        key = {"tag": rel.get("tag_name"), "published": rel.get("published_at"), "assets": sorted((a["id"], a.get("updated_at")) for a in assets)}
        stamp = os.path.join(d, "release.json")
        try:
            with open(stamp, encoding="utf-8") as f:
                if json.load(f).get("key") == key:
                    return None
        except (OSError, ValueError):
            pass
        tree = os.path.join(d, "tree")
        if os.path.isdir(tree):
            import shutil
            shutil.rmtree(tree)
        os.makedirs(tree, exist_ok=True)
        files: list[str] = []
        for a in assets:
            with _open(a["browser_download_url"]) as r:
                data = r.read()
            if a["name"].lower().endswith(".zip"):
                files += _extract(data, os.path.join(tree, os.path.splitext(a["name"])[0]))
            else:
                with open(os.path.join(tree, a["name"]), "wb") as f:
                    f.write(data)
                files.append(a["name"])
        with open(stamp, "w", encoding="utf-8") as f:
            json.dump({"key": key, "published": rel.get("published_at"), "tag": rel.get("tag_name"), "files": sorted(files)}, f)
        return None
    except Exception as e:                   # unreachable, rate limited, bad zip: reported, not fatal
        return (str(e).splitlines() or [type(e).__name__])[0]


def scan_release(full: str, source: str) -> dict:
    """The MRAs of the expanded release in the shape of ``mister.scan_repo``."""
    d = release_dir(full)
    empty = {"repo": full, "source": source, "mras": [], "history": []}
    try:
        with open(os.path.join(d, "release.json"), encoding="utf-8") as f:
            meta = json.load(f)
    except (OSError, ValueError):
        return empty
    date = (meta.get("published") or "")[:10] or dt.date.today().isoformat()
    tree = os.path.join(d, "tree")
    mras, history = [], []
    for root, _dirs, names in os.walk(tree):
        for n in sorted(names):
            if not mister_mod.is_launcher(n):
                continue
            fp = os.path.join(root, n)
            rel = os.path.relpath(fp, tree).replace(os.sep, "/")
            rec = mister_mod.parse_mra(fp)
            if not rec.get("setname") or not mister_mod.keep_launcher(n, rec):
                continue
            rec.update(path=rel, repo=full, source=source, wip=mister_mod._wip(rel), alt="_alternatives" in rel.lower())
            mras.append(rec)
            history.append((rel, date, rec["setname"]))
    return {"repo": full, "source": source, "mras": mras, "history": history, "release": meta.get("tag")}
