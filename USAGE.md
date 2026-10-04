# Usage

How to run, update and publish the MiSTer × MAME coverage data and page. The README gives the
overview; this is the operating manual.

## Requirements

- Python 3.10 or newer, standard library only.
- git 2.36 or newer (partial clones with `--filter` and `sparse-checkout`).
- Network access to `github.com` and `raw.githubusercontent.com`. The MAME listxml asset is
  downloaded from mamedev's GitHub release; alamone's results and the MiSTer_Ongo README come from
  raw.githubusercontent.com.

## The three steps

```
python -m mmc mister     # observe the MiSTer side and merge it into the ledger
python -m mmc report     # MAME + ledger -> docs/data/*.json
python -m mmc build      # mister, then report (the default when no step is given)
python -m mmc mame       # only download and parse MAME (cached under work/)
```

Options:

| Option | Effect |
|---|---|
| `--mame-version 0289` | Use that MAME release. Default: probe upward from 0.289 for the newest `mame0XXXlx.zip` asset. |
| `--refresh-mame` | Re-parse the MAME XML even if `work/cache/mameXXXX.json` exists. |
| `--no-sync` | `mister` reads the repositories already in `work/repos` without cloning or fetching. |
| `--no-fetch` | `mister` clones repositories missing from `work/repos` but does not refresh existing ones. |
| `--workers N` | Parallel clones/scans (default 8). |

### What `mister` does

1. Downloads alamone's `results.json` (every arcade core build known to the MiSTer databases, with
   the set names its MRAs load) and the MiSTer_Ongo README (links to the repositories it ships).
2. Builds the repository plan: the distribution repositories listed in `mister.DISTRIBUTIONS`,
   every repository alamone names, every GitHub repository the Ongo README links, every
   `MiSTer-devel/Arcade-*` repository the MiSTer wiki links, and the hand-kept `EXTRA_REPOS` and
   `ROMSET_FILES` lists.
3. Clones each one with `--filter=blob:limit=1m --no-checkout` (history, trees and small files such
   as MRAs; no core builds), then checks out only the MRA files. jtbin's pull-request refs are
   fetched too, because they still reach the history that was squashed in May 2024.
4. Parses every MRA at HEAD (`<setname>`, `<rbf>`, `<name>`) and, from `git log --diff-filter=A`,
   reads every MRA ever added at the commit that added it, so renamed and deleted MRAs still date
   their sets. Per-repository results are cached in `work/cache/history/`.
5. Resolves each MRA to a core (same-database `<rbf>` match, then the repository when it holds one
   core, then any database, else a new core record) and folds duplicate records of the same build
   (for example Ongo's `kuze_` and `meathax_` prefixed copies) when sets and names agree.
6. Merges the observations into `data/ledger.json` and prints what changed.

### What `report` does

Reads the cached MAME data and the ledger, classifies every MAME machine (arcade, mahjong,
gambling, mechanical, other; working or not; BIOS sets are dropped), groups sets into titles under their parent, attaches
the cores and dates from the ledger, rolls up per driver and per core, and writes:

- `docs/data/coverage.json`: everything the page shows (titles with their sets and cores, cores,
  drivers, unmatched sets, metadata and counts).
- `docs/data/summary.json`: the same without the titles (metadata, cores, drivers, unmatched).

`report` needs no repositories, so a fresh checkout can rebuild the page from the committed ledger
plus the MAME download alone.

## The ledger (`data/ledger.json`)

The ledger is the durable record. It is committed, merged into incrementally, and never pruned.

```
meta.runs[]                 one summary per mister run (date, counts added, dates improved)
cores[id]                   core metadata; first_recorded / last_seen
support[set][core id]       date, date_quality, via (source), wip, alt,
                            first_repo, first_path (where the earliest MRA was found),
                            first_recorded, last_seen
```

Merge rules (`mmc/ledger.py`):

- A set/core pair not yet in the ledger is appended with today's `first_recorded`.
- An existing pair keeps its date unless the new observation is better: a `git` date beats a
  `git-other` date beats a `build` date, and at equal quality an earlier date wins.
- `last_seen` is bumped for everything observed in this run. Nothing is deleted: a core that
  leaves a database, or a repository that disappears, keeps the coverage it had.
- Core metadata that changes over time (latest build date, repository, alamone's verification
  reading and score) is replaced by the newest observation; `aliases` are unioned.

`date_quality` values: `git` (the MRA's own source history), `git-other` (history from another
source, used for a core whose own repository we do not clone), `build` (the core's latest build
date, approximate), `observed` (no history anywhere: the day this tool first saw the MRA),
`none`.

Review the ledger diff before committing a run: a large number of new sets usually means a new
source was added, a date moving earlier means a repository with older history was reached.

### Why a JSON file and not a database

The data is append-mostly and small (about 2 MB, one entry per line). A JSON file diffs cleanly in
a pull request, git history is the audit trail, nothing needs installing, and the page consumes
JSON anyway. A SQLite file would be opaque in review and conflict between branches. If the file
ever becomes unwieldy, split it per source rather than changing the format.

## Adding or fixing sources

All in `mmc/mister.py`:

- `DISTRIBUTIONS`: repositories whose MRA folders are the primary record (official distribution,
  jtbin, Coin-Op Collection, MiSTer_Ongo). Give the source id, title, `owner/repo` and MRA folders.
- `EXTRA_REPOS`: repositories no database or registry points at any more (the official mirrors of
  jotego's first cores, jotego's early `rom/mra` folder). Add a fork of a repository whose history
  was lost, for example.
- `ROMSET_FILES`: cores that load sets from a list instead of MRAs (the NeoGeo core's
  `releases/romsets.xml`).
- `DB_SOURCES`: developer downloader databases (`db.json.zip` URLs). Their MRAs are fetched and
  parsed directly, so a core published only as builds (Patreon releases such as blahm1d's, which
  have no source repository) still counts through the MRAs its database ships. These files carry
  no dates: a set first seen only here is dated by the run that first saw it (`date_quality:
  observed`), which is why running `mister` regularly matters. An unreachable host is reported in
  `meta.repo_errors` and the run continues with alamone's copy of that database's set list.
- `PULL_REFS`: repositories whose pull-request refs should be fetched because they keep squashed
  history alive.
- `FILTER_OVERRIDES`: use `blob:none` for a repository whose small files are still too big to
  clone wholesale (jotego/jtcores).
- `SKIP_REPOS`: repositories alamone names that are not worth cloning.
- `DB_TITLES`: display names for source ids.

MAME classification lives in `mmc/mame.py` (`GAMBLING_DIRS`, `GAMBLING_FILES`, `GAMBLING_DESC`,
`MAHJONG_FILES`, `MAHJONG_DESC`). Core de-duplication rules are in `mmc/reconcile.py`
(`_OWNER_PREFIX`, `merge_duplicate_cores`).

After changing any of these, run `python -m mmc mister --no-fetch` (or `--no-sync` if nothing new
needs cloning) and then `python -m mmc report`.

## Publishing on GitHub Pages

Everything the page needs is static and committed under `docs/`: `index.html`, `app.js`,
`style.css`, `data/coverage.json`, `data/summary.json` and an empty `.nojekyll`.

1. Repository settings → Pages → Source: *Deploy from a branch*, branch `main`, folder `/docs`.
2. The page is then served at `https://<owner>.github.io/<repo>/`. The data files are plain URLs
   next to it (`.../data/coverage.json`) and can be consumed by other tools.

Locally, serve the folder over HTTP (`python -m http.server -d docs 8000`); browsers refuse
`fetch()` of the JSON from `file://`.

The page is vanilla HTML/CSS/JS with no external dependencies: filters, sorting, the burndown and
per-year charts all run client side. Filter state is kept in the URL hash, so a filtered view can
be linked.

## Keeping it fresh

`.github/workflows/update.yml` runs every Monday (after alamone's weekly refresh) and on demand:
it runs `python -m mmc build`, then commits `data/ledger.json` and `docs/data/` if anything
changed. The MAME download is cached between runs. To change the MAME version used by CI, pass
`--mame-version` in the workflow or leave it to probe for the newest release.

Private or deleted repositories linked by a source fail to clone; they are reported on the About
tab (`meta.repo_errors`) and otherwise ignored. The ledger keeps whatever was learned from them
before they disappeared.

## Troubleshooting

- *`no ledger yet`*: run `python -m mmc mister` once; `report` needs `data/ledger.json`.
- *Clone very slow or `work/repos` very large*: a repository is pulling blobs it should not. Check
  that `FILTER_OVERRIDES` covers it and that `git log` is run with `--no-renames` (rename detection
  fetches every blob of a partial clone).
- *A set shows the wrong core*: look at `support[set]` in the ledger for `first_repo` and
  `first_path`, then at `resolve_core` in `mmc/reconcile.py`.
- *A date looks too late*: the earliest MRA may live in a repository not in the plan. Add it to
  `EXTRA_REPOS`; a later date never overwrites an earlier one, so re-running is safe.
