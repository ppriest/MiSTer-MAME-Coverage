"""Keeps ``data/pending_cores.json`` (source-available cores in open pull requests of jotego/jtcores) up to date.

Per open PR the files it adds are listed through the GitHub API; every new ``cores/<name>/cfg/mame2mra.toml`` is a new core.
Its MAME sets are the machines of the driver files named by ``[parse] sourcefile`` minus ``skip.setnames`` (and, with
``skip.bootlegs``, the bootlegs): an approximation of what mame2mra selects, marked ``"sets_auto": true`` so a hand-checked list can
replace it (entries that exist are never rewritten). A PR already in the file that has since merged or closed gets
``"merged": true``. Entries on a branch (``branch`` instead of ``pr``) are hand-maintained. Needs the GitHub API
(``GITHUB_TOKEN`` in CI); on any failure the file is left as it was.
"""
from __future__ import annotations

import json
import re
import tomllib
import urllib.parse

from . import mister as mister_mod, releases

REPO = "jotego/jtcores"
CORE_TOML = re.compile(r"^cores/([^/]+)/cfg/mame2mra\.toml$")


def _get(path: str, accept: str = "application/vnd.github+json"):
    with releases._open(f"{releases.API}{path}", accept) as r:
        return r.read()


def _json(path: str):
    return json.loads(_get(path))


def _sets(cfg: dict, machines: dict) -> list[str]:
    parse = cfg.get("parse") or {}
    files = {str(f).replace("\\", "/").split("/")[-1] for f in (parse.get("sourcefile") or [])}
    skip = set((parse.get("skip") or {}).get("setnames") or [])
    nobootleg = bool((parse.get("skip") or {}).get("bootlegs"))
    out = []
    for name, m in machines.items():
        if m.get("isbios") or m.get("mechanical") or name in skip:
            continue
        if (m.get("sourcefile") or "").split("/")[-1] not in files:
            continue
        if nobootleg and "bootleg" in (m.get("desc") or "").lower():
            continue
        out.append(name)
    return sorted(out)


def sync(machines: dict) -> list[str]:
    """Update the pending file; returns a list of messages (errors included)."""
    msgs = []
    pending = mister_mod.load_pending()
    by_name = {p["name"].lower(): p for p in pending}
    changed = False
    try:
        prs = []
        for page in range(1, 6):
            got = _json(f"/repos/{REPO}/pulls?state=open&per_page=100&page={page}")
            prs += got
            if len(got) < 100:
                break
        open_nums = {p["number"] for p in prs}
        for pr in prs:
            n = pr["number"]
            files = []
            for page in range(1, 4):
                got = _json(f"/repos/{REPO}/pulls/{n}/files?per_page=100&page={page}")
                files += got
                if len(got) < 100:
                    break
            for f in files:
                m = CORE_TOML.match(f.get("filename", ""))
                if not m or f.get("status") != "added":
                    continue
                name = "jt" + m.group(1)
                if name in by_name:
                    continue
                head = pr["head"]
                raw = _get(f"/repos/{head['repo']['full_name']}/contents/{urllib.parse.quote(f['filename'])}?ref={head['sha']}",
                           "application/vnd.github.raw+json")
                sets = _sets(tomllib.loads(raw.decode("utf-8", "replace")), machines)
                if not sets:
                    msgs.append(f"PR #{n} {name}: no MAME sets resolved, skipped")
                    continue
                first = _json(f"/repos/{REPO}/pulls/{n}/commits?per_page=1")
                date = ((first[0]["commit"].get("author") or {}).get("date") or pr["created_at"])[:10] if first else pr["created_at"][:10]
                entry = {"name": name, "game": pr.get("title") or name, "pr": n, "date": date, "sets": sets,
                         "sets_auto": True, "merged": False}
                pending.append(entry)
                by_name[name] = entry
                changed = True
                msgs.append(f"new pending core {name} (PR #{n}, {len(sets)} sets)")
        for p in pending:
            if p.get("pr") and not p.get("merged") and p["pr"] not in open_nums:
                info = _json(f"/repos/{REPO}/pulls/{p['pr']}")
                if info.get("state") == "closed":
                    p["merged"] = True
                    changed = True
                    msgs.append(f"{p['name']}: PR #{p['pr']} {'merged' if info.get('merged') else 'closed'}")
    except Exception as e:                              # offline, rate-limited, bad TOML: keep the file
        return msgs + [f"jtcores PR sync failed: {e}"]
    if changed:
        with open(mister_mod.PENDING_FILE, "w", encoding="utf-8") as f:
            json.dump(pending, f, indent=1, ensure_ascii=False)
            f.write("\n")
    return msgs
