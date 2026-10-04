# MiSTer × MAME arcade coverage

Which arcade games that MAME emulates can be played on MiSTer FPGA cores, which cannot yet, and
how coverage has grown over time. Output is a JSON dataset plus a static web page with client-side
filters, sorting and charts, served from `docs/` (GitHub Pages).

**Live page:** https://ppriest.github.io/MiSTer-MAME-Coverage/ (once Pages is enabled for `docs/`)

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

## Running it

Python 3.10+ and git; no third-party packages.

```bash
python -m mmc build                     # newest MAME release asset found on GitHub
python -m mmc build --mame-version 0289 # a specific MAME version
python -m mmc build --no-sync           # reuse the repositories already in work/
python -m mmc mame | mister             # one step at a time
```

Downloads and clones go to `work/` (about 1 GB; not committed). The first run takes a few minutes
(the 300 MB MAME XML parses in ~20 s; ~330 repositories clone in parallel).

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

## Layout

```
mmc/           the tool (mame.py, mister.py, reconcile.py, report.py)
docs/          the static site: index.html, app.js, style.css, data/*.json
work/          caches and clones (git-ignored)
```

## Licenses

Code: GPL-3.0 (see LICENSE). Data derived from MAME's listxml (BSD-3-Clause / GPL-2.0+ project
data), alamone's results (CC BY 4.0) and the MRA repositories (their own licenses).
