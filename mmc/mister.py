"""MiSTer side: which ROM sets do the cores load, and since when.

Two kinds of input:

* **alamone/fpga-verified-against** ``results.json``: one record per arcade core build found in
  every known MiSTer database or GitHub repository, with the set names its MRAs load, the source
  repository and the build date. We use it as the registry of cores and as the set list for
  cores whose MRAs live somewhere we do not clone.
* **git repositories that carry MRA files** (the official distribution, jotego's jtbin, Coin-Op
  Collection, OngoGablogian's database, the per-core ``releases/`` folders, …). They are cloned
  without blobs (``--filter=blob:none``) so that ``git log`` can tell when each MRA was first
  added, which is the date a set became playable on MiSTer. Only the MRA files at HEAD are then
  checked out and parsed.
"""
from __future__ import annotations

import collections
import concurrent.futures as cf
import datetime as dt
import json
import os
import re
import shutil
import subprocess
import urllib.request

from . import paths

ALAMONE_RESULTS = "https://raw.githubusercontent.com/alamone/fpga-verified-against/main/results/results.json"
ONGO_README = "https://raw.githubusercontent.com/OngoGablogian/MiSTer_Ongo/main/README.md"

# Blobs up to this size come with the clone: every MRA (a few KB) but no core build (.rbf, MBs).
# With them local, the content of an MRA that was later renamed or deleted can still be read.
CLONE_FILTER = "blob:limit=1m"

# Repositories whose git history is the primary record of MRA availability. ``dirs`` are the
# folders that hold MRAs (sparse checkout + history scan), ``source`` the label shown on the page.
DISTRIBUTIONS = [
    # (source id, title, owner/repo, MRA folders)
    ("dist", "MiSTer official distribution", "MiSTer-devel/Distribution_MiSTer", ["_Arcade"]),
    ("dist", "MiSTer official distribution", "MiSTer-devel/MRA-Alternatives_MiSTer", ["."]),
    ("jt", "JTCORES (jotego)", "jotego/jtbin", ["mra"]),
    ("coinop", "Coin-Op Collection", "Coin-OpCollection/Distribution-MiSTerFPGA", ["_Arcade"]),
    ("ongo", "MiSTer_Ongo (OngoGablogian)", "OngoGablogian/MiSTer_Ongo", ["_Arcade"]),
]

# Developer databases alamone tracks whose cores we can only see through its results (no git
# history of MRAs for us to read). Their sets get the build date as an approximate date.
SKIP_REPOS = {"MiSTer-devel/Main_MiSTer"}

# Repositories with history worth reading that no database or registry points at any more:
# the official mirrors of jotego's first cores (2019-2020) and jotego's own early MRA folder.
EXTRA_REPOS = [
    ("jt", "MiSTer-devel/Arcade-1942_MiSTer", None),
    ("jt", "MiSTer-devel/Arcade-1943_MiSTer", None),
    ("jt", "MiSTer-devel/Arcade-gng_MiSTer", None),
    ("jt", "jotego/jtcores", ["rom/mra"]),
]
# Cores that load ROM sets from a list instead of MRAs: (source, repo, file, core name).
ROMSET_FILES = [
    ("dist", "MiSTer-devel/NeoGeo_MiSTer", "releases/romsets.xml", "NeoGeo"),
]

# jtbin's history was squashed in May 2024, but its pull-request refs still reach the old commits
# (back to 2019), so fetch those too.
PULL_REFS = {"jotego/jtbin"}

# jtcores is enormous; clone it without any blobs and let git fetch the few historical MRAs lazily.
FILTER_OVERRIDES = {"jotego/jtcores": "blob:none"}

WIKI_REPO = "https://github.com/MiSTer-devel/Wiki_MiSTer.wiki.git"

DB_TITLES = {
    "dist": "MiSTer official distribution",
    "jt": "JTCORES (jotego)",
    "coinop": "Coin-Op Collection",
    "ongo": "MiSTer_Ongo (OngoGablogian)",
    "meat": "MeatCores (meathax)",
    "slop": "Slop Cores (TheJesusFish)",
    "kuze": "kuzecores (kuzearcade)",
    "jlrh": "jlrh",
    "arcfpga": "arcfpga (bmo00)",
    "blahm1d": "blahm1d",
    "repo": "GitHub repository only",
}


def fetch(url: str, dest: str, max_age_h: float = 6.0) -> str:
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    if os.path.exists(dest):
        age = (dt.datetime.now().timestamp() - os.path.getmtime(dest)) / 3600
        if age < max_age_h:
            return dest
    print(f"[mister] fetching {url}")
    with urllib.request.urlopen(url, timeout=120) as r, open(dest, "wb") as f:
        f.write(r.read())
    return dest


def load_alamone() -> dict:
    p = fetch(ALAMONE_RESULTS, os.path.join(paths.CACHE, "alamone_results.json"))
    with open(p, encoding="utf-8") as f:
        return json.load(f)


def wiki_repos() -> list[str]:
    """``MiSTer-devel/Arcade-*`` repositories linked from the MiSTer wiki (the official core list),
    including cores no longer in the distribution database."""
    d = os.path.join(paths.CACHE, "wiki")
    if not os.path.isdir(os.path.join(d, ".git")):
        os.makedirs(paths.CACHE, exist_ok=True)
        subprocess.run(["git", "clone", "-q", "--depth", "1", WIKI_REPO, d], check=False, capture_output=True)
    else:
        subprocess.run(["git", "pull", "-q", "--depth", "1"], cwd=d, check=False, capture_output=True)
    found = set()
    for root, _dirs, files in os.walk(d):
        if ".git" in root:
            continue
        for fn in files:
            try:
                text = open(os.path.join(root, fn), encoding="utf-8", errors="replace").read()
            except OSError:
                continue
            found.update(m.group(1) for m in re.finditer(r"github\.com/(MiSTer-devel/Arcade-[\w.-]+?)(?:\.git)?(?:[/)\s#]|$)", text))
    return sorted(found)


def ongo_repos() -> list[str]:
    """GitHub repositories linked from the MiSTer_Ongo README's core table."""
    p = fetch(ONGO_README, os.path.join(paths.CACHE, "ongo_README.md"))
    text = open(p, encoding="utf-8").read()
    return sorted({m.group(1) for m in re.finditer(r"https://github\.com/([\w.-]+/[\w.-]+?)(?:/|\)|\s)", text)})


# --- git plumbing ----------------------------------------------------------------------------

def git(*args: str, cwd: str | None = None, check: bool = True) -> subprocess.CompletedProcess:
    return subprocess.run(["git", *args], cwd=cwd, check=check, capture_output=True, text=True,
                          errors="replace")


def repo_dir(full: str) -> str:
    return os.path.join(paths.REPOS, full.replace("/", "__"))


def sync_repo(full: str, dirs: list[str] | None = None, fetch_existing: bool = True) -> tuple[str, str | None]:
    """Clone (blob-less) or update ``owner/repo`` and check out only its MRA files.

    Returns ``(full, error)``; a repository that cannot be reached is reported, not fatal.
    """
    d = repo_dir(full)
    url = f"https://github.com/{full}"
    try:
        filt = FILTER_OVERRIDES.get(full, CLONE_FILTER)
        if os.path.isdir(os.path.join(d, ".git")):
            have = git("config", "remote.origin.partialclonefilter", cwd=d, check=False).stdout.strip()
            if have != filt:  # cloned with another filter: start over
                shutil.rmtree(d)
        if not os.path.isdir(os.path.join(d, ".git")):
            os.makedirs(paths.REPOS, exist_ok=True)
            git("clone", "-q", f"--filter={filt}", "--no-checkout", url, d)
        elif fetch_existing:
            git("fetch", "-q", f"--filter={filt}", "origin", cwd=d)
        if full in PULL_REFS and (fetch_existing or not git("rev-parse", "-q", "--verify", "refs/remotes/origin/pr/1", cwd=d, check=False).stdout):
            git("fetch", "-q", f"--filter={filt}", "origin", "+refs/pull/*/head:refs/remotes/origin/pr/*", cwd=d, check=False)
            head = git("symbolic-ref", "refs/remotes/origin/HEAD", cwd=d, check=False).stdout.strip()
            if head:
                git("reset", "-q", "--soft", head, cwd=d)
        # Sparse checkout of just the MRA files keeps the lazy blob fetch to one batch per repo.
        mras = [p for p in ls_files(d) if p.lower().endswith(".mra")]
        if dirs is not None and dirs != ["."]:
            mras = [p for p in mras if any(p.startswith(x.rstrip("/") + "/") for x in dirs)]
        mras += [f for _s, r, f, _c in ROMSET_FILES if r == full]
        git("sparse-checkout", "init", "--no-cone", cwd=d)
        with open(os.path.join(d, ".git", "info", "sparse-checkout"), "w", encoding="utf-8") as f:
            f.write("".join("/" + p.replace("[", "\\[").replace("]", "\\]") + "\n" for p in mras) or "/nonexistent\n")
        git("checkout", "-q", "--force", cwd=d)
        return full, None
    except subprocess.CalledProcessError as e:
        return full, (e.stderr or str(e)).strip().splitlines()[-1] if (e.stderr or "").strip() else str(e)


def ls_files(d: str) -> list[str]:
    return git("ls-tree", "-r", "--name-only", "HEAD", cwd=d).stdout.splitlines()


def mra_history(d: str, dirs: list[str] | None = None) -> list[tuple[str, str, str]]:
    """Every ``.mra`` path ever added to the repository: ``(path, date, commit)`` of its first add.

    ``--no-renames`` matters twice: a rename counts as a fresh add (its old content is read from
    the old path) and rename detection would otherwise make git fetch blobs of a partial clone.
    Dates are committer dates (``%cs``).
    """
    spec = [x for x in (dirs or ["."]) if x] or ["."]
    out = git("log", "--all", "--no-renames", "--diff-filter=A", "--name-only",
              "--format=%x00%H %cs", "--", *spec, cwd=d, check=False).stdout
    first: dict[str, tuple[str, str]] = {}
    commit = date = None
    for line in out.splitlines():
        if line.startswith("\x00"):
            commit, date = line[1:].split(" ", 1)
            continue
        if not line or not line.lower().endswith(".mra") or date is None:
            continue
        if line not in first or date < first[line][0]:
            first[line] = (date, commit)
    return sorted((p, dt_, c) for p, (dt_, c) in first.items())


def read_blobs(d: str, specs: list[str]) -> dict[str, bytes | None]:
    """``git cat-file --batch`` for ``<commit>:<path>`` specs; missing objects map to None."""
    if not specs:
        return {}
    proc = subprocess.run(["git", "cat-file", "--batch"], cwd=d, input="\n".join(specs).encode() + b"\n",
                          capture_output=True, check=False)
    out, i, res = proc.stdout, 0, {}
    for spec in specs:
        nl = out.find(b"\n", i)
        header = out[i:nl].decode(errors="replace")
        i = nl + 1
        if header.endswith(" missing") or " " not in header:
            res[spec] = None
            continue
        size = int(header.rsplit(" ", 1)[1])
        res[spec] = out[i:i + size]
        i += size + 1
    return res


# --- MRA parsing -----------------------------------------------------------------------------

_TAG = re.compile(r"<(setname|rbf|name|mameversion|year|manufacturer|parent)\b[^>]*>\s*(.*?)\s*</\1>", re.S | re.I)


def parse_mra_text(s: str) -> dict:
    # Drop comments before looking for tags so a commented-out <setname> cannot win.
    s = re.sub(r"<!--.*?-->", "", s, flags=re.S)
    rec: dict = {}
    for m in _TAG.finditer(s):
        k = m.group(1).lower()
        if k not in rec:
            rec[k] = re.sub(r"\s+", " ", m.group(2)).strip()
    setn = rec.get("setname", "").lower()
    rec["setname"] = setn if re.fullmatch(r"[a-z0-9_]{1,32}", setn) else None
    rec["rbf"] = rec.get("rbf") or None
    return rec


def parse_mra(path: str) -> dict:
    with open(path, encoding="utf-8", errors="replace") as f:
        return parse_mra_text(f.read())


def norm_rbf(rbf: str | None) -> str | None:
    """Core identity from an MRA ``<rbf>`` tag or a build file name.

    Build names carry dates and prefixes the MRAs do not (``Arcade-NMK16_Afega_20260920.rbf`` is
    loaded by ``<rbf>NMK16_Afega</rbf>``), so compare on a normalised stem.
    """
    if not rbf:
        return None
    s = rbf.strip().lower()
    s = s.split("/")[-1]
    s = re.sub(r"\.rbf$", "", s)
    s = re.sub(r"_\d{8}$", "", s)
    s = re.sub(r"_mister$", "", s)
    s = re.sub(r"^arcade-", "", s)
    return s


def _wip(path: str) -> bool:
    return bool(re.search(r"wip|experimental|unstable|beta|alpha|test", path, re.I))


def scan_repo(source: str, full: str, dirs: list[str] | None) -> dict:
    """Parse the MRAs at HEAD, and every MRA ever added (at the commit that added it)."""
    d = repo_dir(full)
    empty = {"repo": full, "source": source, "mras": [], "history": []}
    if not os.path.isdir(os.path.join(d, ".git")):
        return empty
    paths_ = [p for p in ls_files(d) if p.lower().endswith(".mra")]
    if dirs is not None and dirs != ["."]:
        paths_ = [p for p in paths_ if any(p.startswith(x.rstrip("/") + "/") for x in dirs)]
    mras = []
    for p in paths_:
        fp = os.path.join(d, p)
        if not os.path.exists(fp):
            continue
        rec = parse_mra(fp)
        if not rec.get("setname"):
            continue
        rec.update(path=p, repo=full, source=source, wip=_wip(p), alt="_alternatives" in p.lower())
        mras.append(rec)
    # History: (path, date, setname) for every add, reading the file as it was when added.
    adds = mra_history(d, dirs)
    cache_file = os.path.join(paths.CACHE, "history", full.replace("/", "__") + ".json")
    cache: dict[str, str | None] = {}
    if os.path.exists(cache_file):
        with open(cache_file, encoding="utf-8") as f:
            cache = json.load(f)
    specs = [f"{c}:{p}" for p, _dt, c in adds if f"{c}:{p}" not in cache]
    for i in range(0, len(specs), 2000):
        for spec, blob in read_blobs(d, specs[i:i + 2000]).items():
            cache[spec] = parse_mra_text(blob.decode("utf-8", errors="replace")).get("setname") if blob else None
    os.makedirs(os.path.dirname(cache_file), exist_ok=True)
    with open(cache_file, "w", encoding="utf-8") as f:
        json.dump(cache, f)
    history = [(p, date, cache.get(f"{c}:{p}")) for p, date, c in adds]
    for src, r, f, core in ROMSET_FILES:
        if r == full:
            m, h = scan_romsets(d, src, full, f, core)
            mras += m
            history += h
    return {"repo": full, "source": source, "mras": mras, "history": history}


_ROMSET = re.compile(r"<romset\s[^>]*?\bname\s*=\s*\"([^\"]+)\"[^>]*?(?:altname\s*=\s*\"([^\"]*)\")?", re.I)


def scan_romsets(d: str, source: str, full: str, path: str, core: str):
    """A ``romsets.xml`` list: every set it names now, and the first commit that named each."""
    fp = os.path.join(d, path)
    mras, history = [], []
    if not os.path.exists(fp):
        return mras, history
    text = open(fp, encoding="utf-8", errors="replace").read()
    for m in _ROMSET.finditer(re.sub(r"<!--.*?-->", "", text, flags=re.S)):
        setn = m.group(1).lower()
        if re.fullmatch(r"[a-z0-9_]{1,32}", setn):
            mras.append({"setname": setn, "rbf": core, "name": m.group(2) or setn, "path": path, "repo": full,
                         "source": source, "wip": False, "alt": False})
    # Oldest first: the first version naming a set dates it.
    log = git("log", "--all", "--reverse", "--format=%H %cs", "--", path, cwd=d, check=False).stdout.split()
    commits = list(zip(log[0::2], log[1::2]))
    seen: set[str] = set()
    for commit, blob in read_blobs(d, [f"{c}:{path}" for c, _ in commits]).items():
        if not blob:
            continue
        date = dict(commits)[commit.split(":")[0]]
        for m in _ROMSET.finditer(blob.decode("utf-8", errors="replace")):
            setn = m.group(1).lower()
            if setn not in seen:
                seen.add(setn)
                history.append((path, date, setn))
    return mras, history


# --- putting the MiSTer picture together ------------------------------------------------------

def repo_plan(alamone: dict) -> list[tuple[str, str, list[str] | None]]:
    """``(source, owner/repo, dirs)`` for every repository worth cloning."""
    plan: dict[str, tuple[str, list[str] | None]] = {}
    for src, _title, full, dirs in DISTRIBUTIONS:
        plan[full] = (src, dirs)
    for c in alamone["cores"]:
        full = c.get("repo")
        # jotego/jtcores does not commit MRAs (jtbin carries them) and its history is enormous.
        if full and full not in plan and full not in SKIP_REPOS:
            plan[full] = (c["db"], None)
    for full in ongo_repos():
        if full not in plan:
            plan[full] = ("ongo", None)
    for full in wiki_repos():
        if full not in plan:
            plan[full] = ("dist", None)
    for src, full, dirs in EXTRA_REPOS:
        if full not in plan:
            plan[full] = (src, dirs)
    for src, full, _file, _core in ROMSET_FILES:
        if full not in plan:
            plan[full] = (src, [])
    return [(src, full, dirs) for full, (src, dirs) in plan.items()]


def sync_all(plan, workers: int = 8, fetch_existing: bool = True) -> list[tuple[str, str]]:
    errors = []
    with cf.ThreadPoolExecutor(workers) as ex:
        for full, err in ex.map(lambda t: sync_repo(t[1], t[2], fetch_existing), plan):
            if err:
                errors.append((full, err))
                print(f"[mister] {full}: {err}")
    return errors


def scan_all(plan, workers: int = 8) -> list[dict]:
    with cf.ThreadPoolExecutor(workers) as ex:
        return list(ex.map(lambda t: scan_repo(t[0], t[1], t[2]), plan))


def build_mister(refresh: bool = False, no_sync: bool = False, fetch_existing: bool = True, workers: int = 8) -> dict:
    """Produce ``work/cache/mister.json``: cores, MRAs and first-seen dates per set."""
    alamone = load_alamone()
    plan = repo_plan(alamone)
    errors = []
    if not no_sync:
        print(f"[mister] syncing {len(plan)} repositories")
        errors = sync_all(plan, workers, fetch_existing)
    scans = scan_all(plan, workers)

    # Set name per MRA basename: fallback for historical adds whose content could not be read.
    by_base: dict[str, set[str]] = collections.defaultdict(set)
    mras: list[dict] = []
    for sc in scans:
        for m in sc["mras"]:
            mras.append(m)
            by_base[os.path.basename(m["path"]).lower()].add(m["setname"])

    # Earliest date a set appeared in any repository, and in each source.
    first_seen: dict[str, dict] = {}
    for sc in scans:
        for p, date, setn in sc["history"]:
            cands = {setn} if setn else by_base.get(os.path.basename(p).lower(), set())
            for s in cands:
                rec = first_seen.setdefault(s, {"date": date, "repo": sc["repo"], "path": p, "source": sc["source"], "exact": bool(setn), "by_source": {}})
                if date < rec["date"]:
                    rec.update(date=date, repo=sc["repo"], path=p, source=sc["source"], exact=bool(setn))
                bs = rec["by_source"]
                if sc["source"] not in bs or date < bs[sc["source"]]:
                    bs[sc["source"]] = date

    return {
        "generated": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "alamone_generated": alamone["meta"].get("generated"),
        "alamone_mame_commit": None,
        "repos": [{"source": s, "repo": f, "dirs": d, "mras": len(next((x for x in scans if x["repo"] == f), {"mras": []})["mras"])} for s, f, d in plan],
        "errors": errors,
        "cores": alamone["cores"],
        "mras": mras,
        "first_seen": first_seen,
    }
