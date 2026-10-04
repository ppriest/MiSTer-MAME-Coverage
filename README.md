# MiSTer × MAME arcade coverage

Which arcade games that MAME emulates can be played on MiSTer FPGA cores, which cannot yet, and
how coverage has grown over time. Output is a JSON dataset plus a static web page with client-side
filters, sorting and charts, served from `docs/` (GitHub Pages).

**Live page:** https://ppriest.github.io/MiSTer-MAME-Coverage/ (once Pages is enabled for `docs/`)

**Operating manual:** [USAGE.md](USAGE.md) covers every command and option, the ledger's merge
rules, how to add sources, publishing on GitHub Pages and the weekly refresh.

## What it does

1. **MAME side.** Downloads the `-listxml` output mamedev attaches to every release
   (`mame0XXXlx.zip`) and keeps every runnable machine: name, description, year, manufacturer,
   driver source file, parent/clone, driver status, inputs, display. A machine is *arcade* when it
   takes coins, has a display and is not mechanical or in a gambling-only driver folder; it is
   *working* unless MAME flags it `MACHINE_NOT_WORKING` (`emulation="preliminary"`). Not-working
   sets are kept in the data but excluded from every default count.
2. **MiSTer side.** Reads [alamone/fpga-verified-against](https://github.com/alamone/fpga-verified-against)'s
   `results.json` (every arcade core build in every known MiSTer database and repository, with
   the set names their MRAs load) and clones, without large blobs, every repository that carries
   MRA files: the official distribution, `MRA-Alternatives`, jotego's `jtbin`, Coin-Op Collection,
   [OngoGablogian/MiSTer_Ongo](https://github.com/OngoGablogian/MiSTer_Ongo) and every repository
   it links, plus each core's own `releases/` folder. Every MRA is parsed for `<setname>` (the MAME
   set) and `<rbf>` (the core); `git log` gives the day each MRA was first committed.
3. **Reconcile.** A set is covered when any core has an MRA for it. A *title* (MAME parent set
   plus clones) is covered when any of its sets is, and is dated by the earliest MRA across all
   its sets and all sources. Cores are matched to alamone's registry by repository, by `<rbf>`
   name, and finally by set overlap for builds redistributed under another name.
4. **Report.** `docs/data/coverage.json` (titles, sets, cores, drivers, dates) and
   `docs/data/summary.json` (roll-up). `docs/index.html` renders them: headline numbers, a
   burndown / coverage-over-time chart, coverage by release year, and filterable tables of titles,
   drivers (MAME source files) and cores.

## The ledger: incremental, committed, no database

Most of the work is one-off: the date a set first appeared on MiSTer never gets later, and the
upstream history it comes from is fragile (jotego's `jtbin` was squashed in 2024; several linked
repositories are already gone). So every run merges what it observed into **`data/ledger.json`**,
which is committed:

- new sets, cores and set/core pairs are appended; nothing is ever deleted (a core that leaves a
  database still counts as having covered its sets, with `last_seen` recording when it was last
  observed);
- an existing pair keeps its earliest date, and a date read from git history always beats an
  approximate build date;
- mutable core metadata (latest build, repository, alamone's verification reading) is refreshed.

The ledger is a JSON file rather than a database on purpose: it diffs cleanly in pull requests,
git history is the audit trail, nothing needs installing, and the page consumes JSON anyway. A
SQLite file would not diff and would conflict between branches.

Because the ledger is committed, `python -m mmc report` rebuilds the whole site from a fresh
checkout plus the MAME download alone, with no repository clones. `python -m mmc mister` is the
only step that touches GitHub, and it can be run on any machine or in CI; its result is a diff to
`data/ledger.json` you can review before committing.

## Running it

Python 3.10+ and git; no third-party packages.

```bash
python -m mmc build                     # mister + report: refresh everything
python -m mmc report                    # MAME + ledger only: no clones needed (new MAME version, page changes)
python -m mmc mister                    # clone/refresh the repositories and update the ledger
python -m mmc mister --no-fetch         # clone only repositories that are new to work/repos
python -m mmc build --mame-version 0289 # pin a MAME version (default: newest release asset found)
```

Downloads and clones go to `work/` (about 2 GB; not committed). The first `mister` run takes a few
minutes (~340 repositories clone in parallel, without build files); later runs only fetch. The
300 MB MAME XML parses in about 20 s and is cached as JSON.

To view the page locally, serve `docs/` over HTTP (`python -m http.server -d docs`); browsers
block `fetch()` of the JSON from `file://`.

## Data notes

- Dates are the committer date of the commit that first added an MRA with that set name, in any
  repository, so a set is dated by whichever source shipped it first. Where no history is
  available (developer databases we only see through alamone's results) the core's build date is
  used and marked approximate (`date_quality`).
- jotego's `jtbin` history was squashed in May 2024 and the official distribution repository starts
  in September 2021; the per-core repositories (`MiSTer-devel/Arcade-*`) reach back to 2019.
  Cores that predate the MRA format (2018 to mid-2019) are dated by their first MRA.
- The MAME total is for one MAME version, so the early part of the curve is measured against
  today's MAME.
- Sets named by MRAs that do not exist in MAME (hacks, homebrew, renamed sets) are listed under
  *Unmatched* and ignored elsewhere.

## Publishing on GitHub Pages

Everything the page needs is static and committed: `docs/index.html`, `docs/app.js`,
`docs/style.css` and `docs/data/*.json`. In the repository settings, set Pages to serve from the
`docs/` folder of the default branch. The scripts that produce the data live in the same
repository (`mmc/`), and `.github/workflows/update.yml` re-runs them weekly, committing the updated
ledger and page data when anything changed.

## Layout

```
mmc/           the tool (mame.py, mister.py, ledger.py, reconcile.py, report.py)
data/          ledger.json: the committed, incrementally merged record of MiSTer coverage
docs/          the static site: index.html, app.js, style.css, data/*.json
work/          caches and clones (git-ignored)
```

## Licenses

Code: GPL-3.0 (see LICENSE). Data derived from MAME's listxml (BSD-3-Clause / GPL-2.0+ project
data), alamone's results (CC BY 4.0) and the MRA repositories (their own licenses).
