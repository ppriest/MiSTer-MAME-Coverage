"""The committed ledger: everything learned about MiSTer coverage that is expensive or impossible
to re-derive, kept in ``data/ledger.json`` and merged into on every run.

Why a JSON file in git rather than a database: the facts are append-mostly (a set's first
availability date never gets later, cores are rarely removed), the file diffs cleanly in pull
requests, git history is the audit trail, and the static page needs JSON anyway. Upstream history
is the fragile part: jotego's jtbin was squashed in 2024 and several linked repositories are
already gone, so once a date has been observed it is kept here even if its source vanishes.

Shape::

    {"meta": {"created", "updated", "runs": [...]},
     "cores": {core id: {...metadata..., "first_recorded", "last_seen"}},
     "support": {set name: {core id: {"date", "date_quality", "via", "wip", "alt",
                                      "first_repo", "first_path", "first_recorded", "last_seen"}}}}

Merge rules: a new (set, core) pair is added; an existing one keeps the earliest date (a git
date beats an approximate build date) and gets ``last_seen`` bumped; nothing is ever deleted,
so a core that leaves a database still counts as having covered its sets. Core metadata that
changes over time (latest build, verification reading) is refreshed from the newest observation.
"""
from __future__ import annotations

import datetime as dt
import json
import os

from . import paths

LEDGER = os.path.join(paths.DATA, "ledger.json")

_QUALITY_RANK = {"git": 4, "git-other": 3, "build": 2, "observed": 1, "none": 0}


def _today() -> str:
    return dt.date.today().isoformat()


def load() -> dict:
    if os.path.exists(LEDGER):
        with open(LEDGER, encoding="utf-8") as f:
            return json.load(f)
    return {"meta": {"created": _today(), "updated": None, "runs": []}, "cores": {}, "support": {}}


def save(ledger: dict) -> None:
    os.makedirs(paths.DATA, exist_ok=True)
    ledger["support"] = {k: dict(sorted(v.items())) for k, v in sorted(ledger["support"].items())}
    ledger["cores"] = dict(sorted(ledger["cores"].items()))
    ledger["categories"] = dict(sorted(ledger.get("categories", {}).items()))
    tmp = LEDGER + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(ledger, f, ensure_ascii=False, indent=0, sort_keys=False)
        f.write("\n")
    os.replace(tmp, LEDGER)


def better(new: dict, old: dict) -> bool:
    """Is the new observation's date more trustworthy or earlier than the recorded one?"""
    if not new.get("date"):
        return False
    if not old.get("date"):
        return True
    nq, oq = _QUALITY_RANK.get(new.get("date_quality"), 0), _QUALITY_RANK.get(old.get("date_quality"), 0)
    if nq != oq:
        return nq > oq
    return new["date"] < old["date"]


def merge(ledger: dict, observed: dict, note: str = "") -> dict:
    """Fold one run's observations (``reconcile.observe``) into the ledger; returns a summary."""
    today = _today()
    added_sets = added_pairs = updated_dates = added_cores = 0
    for cid, c in observed["cores"].items():
        old = ledger["cores"].get(cid)
        rec = {k: v for k, v in c.items() if k != "alamone_sets"}
        if old is None:
            rec["first_recorded"] = today
            added_cores += 1
        else:
            rec["first_recorded"] = old.get("first_recorded", today)
            # Keep an alias list union and the earliest known build date.
            rec["aliases"] = sorted(set(old.get("aliases", [])) | set(rec.get("aliases", [])))
        rec["last_seen"] = today
        ledger["cores"][cid] = rec
    for setn, recs in observed["support"].items():
        slot = ledger["support"].setdefault(setn, {})
        if not slot:
            added_sets += 1
        for cid, rec in recs.items():
            old = slot.get(cid)
            if old is None:
                new = dict(rec, first_recorded=today, last_seen=today)
                if not new.get("date"):  # no history anywhere: the day we first saw it is the date
                    new.update(date=today, date_quality="observed")
                slot[cid] = new
                added_pairs += 1
                continue
            if better(rec, old):
                old.update({k: rec[k] for k in ("date", "date_quality", "first_repo", "first_path") if k in rec})
                updated_dates += 1
            old["wip"] = old.get("wip", False) and rec.get("wip", False)
            old["alt"] = old.get("alt", False) and rec.get("alt", False)
            old["last_seen"] = today
    # The ledger is append-only except for cores a source rule now excludes (for example
    # NeptUNO+-only cores of bmo00/arcfpga-cores): those, and the sets only they supported, go.
    removed = 0
    for cid in observed.get("excluded", []):
        if ledger["cores"].pop(cid, None) is not None:
            removed += 1
        for setn in list(ledger["support"]):
            if ledger["support"][setn].pop(cid, None) is not None and not ledger["support"][setn]:
                del ledger["support"][setn]
    cats = ledger.setdefault("categories", {})
    for setn, per_src in observed.get("categories", {}).items():
        cats.setdefault(setn, {}).update(per_src)
    summary = {"date": today, "note": note, "cores": added_cores, "sets": added_sets, "pairs": added_pairs, "dates_improved": updated_dates, "cores_removed": removed}
    ledger["meta"]["updated"] = today
    ledger["meta"]["runs"] = (ledger["meta"].get("runs") or [])[-50:] + [summary]
    return summary
