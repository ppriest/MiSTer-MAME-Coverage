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
   repository the arcade table of the MiSTer wiki's `Cores.md` links (including ones not named
   `Arcade-*`, such as N64_MiSTer, SMS_MiSTer and Saturn_MiSTer) and any `MiSTer-devel/Arcade-*`
   link elsewhere in the wiki, every repository shmup-deck's
   `cores.json` points at (shmupfan's own cores get the `shmupfan` source), and the hand-kept
   `EXTRA_REPOS` and `ROMSET_FILES` lists.
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

### What `mamehist` does

Records when each set entered MAME, in `data/mame_added.json` (committed, append-only):

- `versions`: release dates from mamedev/mame's git tags (a tree-less, depth-1 fetch of
  `refs/tags/mame0*`, under 2 MB); versions before the first tag (0.121, 2007) and the "u"/"b"
  releases between tags are interpolated from a short table of known dates in `mmc/mamehist.py`.
- `sets`: the version that first listed each set, from three sources, each treated as an upper
  bound so a date only ever moves earlier: the `[VerAdded]` section of the catver.ini copies (to
  0.180); M.A.S.H.'s MAMEUI `Version*.ini` folder files (`MAMEUI-inifiles-0XXX.zip` in
  [MASHinfo/mameinfo](https://github.com/MASHinfo/mameinfo), every release and "u" update from
  0.129u5 to the current version; the repository is listed blob-less and only the one zip is
  fetched); and `src/mame/mame.lst` at every release tag from 0.180 on (a set in N but not N−1
  was added in N). Only versions and files not seen before are fetched.
- A set re-listed later under the same name (after a rename or a re-dump) keeps its first date;
  a set whose name changed is dated by the new name. A set counts as "in MAME" from its first
  release even if it was not working then.

`report` attaches `mame_added` and `mame_date` to every set and `mame_date` (earliest set) to
every title; the "MAME and MiSTer over time" chart is the cumulative count of working arcade sets
by those dates against the cumulative count on MiSTer. The page's "In MAME since" filter (year
and month dropdowns, or a drag across that chart) selects titles by that earliest date. The
"On MiSTer since" filter does the same with the title's first MiSTer support date (`date`, or
`date_working` in the working-only view); titles not on MiSTer have no such date and drop out
whenever it is set.

## Unreleased jtcores (pull requests and branches)

`data/pending_cores.json` lists source-available cores that sit in open pull requests of
`jotego/jtcores` and have no published MRA or build yet (name, PR number, date of the core's first
commit, MAME sets; `pr` or, for cores on a branch such as `andrea-cores`, `branch`). `observe` turns each into a `jtpr:<name>` core with those sets. When a PR
merges, set `"merged": true` (the placeholder is then removed from the ledger and the real `jt:`
core takes over). Sets are those the PR's `mame2mra.toml` selects, checked against MAME by hand.

## HBMAME (homebrew and hacks)

`python -m mmc hbmame` (part of `build`) reads the set names of the newest HBMAME release tag of
`Robbbert/hbmame` (`tag2893` = 0.289.3) from the `GAME(...)` lines of `src/hbmame/drivers` (sparse
clone, redone only when a newer tag appears) into `data/hbmame.json`. `report` flags every
unmatched set that exists there (`unmatched[].hbmame`, `meta.hbmame`); the Unmatched tab labels
them **homebrew/hacks** and has a show / hide / only filter. HBMAME publishes no machine list, so
hacks defined outside `src/hbmame/drivers` are not seen. The same lines carry what a `-listxml` would (year, parent, manufacturer, description), stored per set and shown on the Unmatched tab. **`-listxml`:** HBMAME is Windows-only, so `.github/workflows/hbmame.yml` runs `hbmame.exe -listxml` on a Windows runner (daily, or on demand) and publishes it as `hbmame-lx.zip` on this repository's `hbmame-listxml` release; `mmc hbmame` prefers that file (parsed like MAME's listxml) and falls back to the source parse until it exists. The workflow takes the newest archive linked from <https://hbmame.1emulation.com/> (falling back to a `Robbbert/hbmame` release asset), or the `HBMAME_URL` repository variable / the `url` run input to pin one.

## Titles filters

The Titles tab keeps the search box, sort and Reset in a bar; the other filters sit in a collapsible
**Filters** panel (grouped: MiSTer support, MAME, Dates; open/closed is remembered per browser).
Every filter that is not at its default shows as a removable **chip** under the bar (with a
**Clear all**), and a badge on the button counts them. **Quick** buttons apply a preset (a set of
control values: not on MiSTer, partly covered, drivers with no core, binary-only, added this
month, vertical not on MiSTer); edit the `PRESETS` list in `docs/app.js` to change them. The
state is still the URL hash, so links keep working.

## Databases tab

One row per source (`DB_TITLES`): cores, working arcade titles and sets loaded by at least one core
of that source, its location and Downloader database URL (`SOURCE_PAGES`, `DB_SOURCES` in
`mmc/mister.py`). Clicking a row sets the Titles tab's **Database** filter (any core from that source).

## Developer database vs loose repository

When a developer's own Downloader database (a `DB_SOURCES` entry whose owner matches the repository
owner) lists a build whose repository is also known as a loose `repo:` record (same repository, same
build name), the database record wins and the `repo:` record is dropped, so each build is listed once
(for example `shmupfan:1945kiii`, `ppriest:seta`).

## Ongo copies

MiSTer_Ongo only republishes other developers' builds. `report` shows an Ongo core on a set only
when no other source supports that set (its date and source/binary status still count), and drops
Ongo cores that no set is shown under, so each build is listed under its own developer.

## Binary-only support

A core is **binary-only** when no public source is known for it: none of the repositories tied to
it (its linked `repo` plus the repositories its MRAs live in, kept in `data/core_repos.json`)
contains HDL files (`.v .sv .vhd .qsf .qip .qpf`), or it has no repository at all (Patreon drops,
database-only builds). Whether a repository holds source is read from its git tree at sync time
into `data/repo_source.json` (repositories not checked out keep their last answer; unchecked ones
get the benefit of the doubt). `mister.BINARY_ONLY_CORES` / `SOURCE_AVAILABLE_CORES` override per
core id. `report` derives a tristate for every set and title: `source` (some core loading it
has public source), `binary` (every core loading it is binary-only) or `none` (unsupported);
`title.support` covers all sets, `title.support_working` the working ones. Cores carry
`binary_only`, `meta.counts` has `working_arcade_titles_source` / `_binary_only`, and the page has
a "MiSTer source code" filter on the Titles and Cores tabs (it narrows what counts as being on MiSTer; MAME totals in the charts ignore it), and a `bin` flag next to binary-only titles (in the covered/sets column), core badges and core names. `mister.SOURCE_REPOS` maps cores published by one repository but built from another (the official distribution's cores) to their source repository; files under `games/` are ignored when looking for HDL (disk images are `.vhd` too).

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

- The one exception to append-only: cores that a source rule now excludes (`observe()` returns
  them as `excluded`, see `MULTI_PLATFORM`) are removed from the ledger together with the sets
  only they supported. The run summary records how many.
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

## Genres

Every title gets a `genre` (a short common value), with `genre_raw` and `genre_source` saying
where it came from. Sources, in order of preference, with cascading from parent to clones and
back when a set has no category of its own:

1. **`catver.ini`**, MAME's category file maintained by progettosnaps. Put a current copy at
   `data/catver.ini` (download it from progettosnaps.net/catver and commit it; ~2 MB) and it
   wins for every set it names. Without one, the copies libretro vendors on GitHub are merged:
   `mame2003-plus` (catver 0.239, about 5k sets) first, then `mame2016` (older, about 37k sets).
2. **MiSTer Arcade Database** (`MiSTer-devel/ArcadeDatabase_MiSTer`, `ArcadeDatabase.csv`), the
   curated per-MRA metadata behind the Arcade Organizer.
3. **MRA `<category>`** tags, read during `mister` and kept in the ledger (`categories`), so
   `report` needs no repositories. `mra_source_order` in the map decides which source's tag wins.

Raw strings are normalised (lower case, HTML entities decoded, `/`, ` - ` and `>` unified to
`/`, the `* Mature *` marker split off into `mature`) and remapped by **`data/genre_map.json`**:

- `full`: whole normalised string, e.g. `"platform/shooter scrolling": "Run and Gun"`;
- `main`: the part before the first `/`, e.g. `"driving": "Racing"`;
- `prefix`: starts-with rules, e.g. `"army/": "Shooter"`;
- `ignore` and `ignore_prefix`: strings that carry no genre (`arcade`, `home systems/…`);
- `default`: what everything else becomes (`Other`).

Scrolling shooters are kept apart from the rest: `Shmup` covers catver's "Flying Vertical /
Horizontal / Diagonal" (the last being isometric scrollers such as Zaxxon), "Misc. Vertical /
Horizontal", "Driving Horizontal" (Moon Patrol-style vehicle scrollers), "Command" (Missile
Command-style defence shooters) and "Walking" (on-foot scrolling shooters: Commando, Ikari
Warriors, Guwange, Out Zone) and the MRA spellings of shoot 'em up, while `Shooter` keeps
gallery (fixed-screen), gun, vertical and diagonal vehicle ("Driving Vertical / Diagonal"),
first- and third-person and chase-view shooters. "Platform / Shooter Scrolling" (Metal Slug,
Contra) stays Run and Gun. Individual games can be moved with `data/genre_overrides.json` (empty by default; see
the shmup-deck comparison below). Move strings between the two in `full` if you
disagree with a placement.

Local corrections go in **`data/genre_overrides.json`**:

- `"categories": {set name: raw category}` supplies a catver-style category (for example
  `"slspirit": "Shooter / Flying Vertical"`) for sets no source classifies, typically games newer
  than the catver copies on GitHub. It is remapped like catver's own entries and wins over every
  source; the title's genre source reads `local`.
- `"sets": {set name: genre}` forces a final common genre, applied after the map; a parent's entry
  cascades to its clones; the source reads `override`.

**Checking Shmup against shmup-deck.** `tools/reconcile_shmups.py` compares our Shmup titles with
the curated list in [shmupfan/shmup-deck](https://github.com/shmupfan/shmup-deck)
(`shmup_deck/app/games.json`, every shoot 'em up it knows a MiSTer core for, with MAME set names).
`report` runs it after writing the data, so `reports/shmup-deck.md` is always current. It prints (A) deck games we do not call Shmup, grouped by raw category so you can tell a wrong
category from a wrong single game, (B) titles we call Shmup, on MiSTer, that the deck lacks, and
(C) deck sets unknown to this MAME version. The same report is written to `reports/shmup-deck.md`
(committed, so the latest comparison is readable on GitHub). `--write-overrides` records the games in (A) as Shmup
in `data/genre_overrides.json` (`--keep-raw CATEGORY` excludes a raw category from that). Run
`python -m mmc report` afterwards.

`report` prints every raw string that fell through to the default, with how many sets it
affects; add those to the map and run `report` again. The page's genre filter, sort, column and
"Coverage by genre" chart all use the common value.

## Adding or fixing sources

All in `mmc/mister.py`:

- `DISTRIBUTIONS`: repositories whose MRA folders are the primary record (official distribution,
  jtbin, Coin-Op Collection, MiSTer_Ongo). Give the source id, title, `owner/repo` and MRA folders.
- `EXTRA_REPOS`: repositories no database or registry points at any more (the official mirrors of
  jotego's first cores, jotego's early `rom/mra` folder). Add a fork of a repository whose history
  was lost, for example.
- `SUPERSEDED_CORES`: old core id -> replacement id (for example `repo:hyperng64` -> `ppriest:hyperng64`);
  the old record is removed from the ledger like an excluded core, but only once the replacement was
  observed in that run, so no support is lost while the replacement's source is unreachable.
- `ROMSET_FILES`: cores that load sets from a list instead of MRAs (the NeoGeo core's
  `releases/romsets.xml`).
- `DB_SOURCES`: developer downloader databases (ppriest's own `MiSTer_ppriest` among them, which is
  unreachable, and listed as such on the About tab, until that repository is published); (`db.json.zip` URLs, or a plain `db.json` such as
  shmupfan's Distribution). Their MRAs are fetched and
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
- `MULTI_PLATFORM`: repositories that publish cores for several FPGA boards, currently
  `bmo00/arcfpga-cores` (mostly NeptUNO+). Only MRAs under `cores/<name>/` are read, and one
  counts as MiSTer coverage when the repository's own `cores.json` lists a `mister` release for
  that core (CPS3, Rastan, Mysterious Stones) or when it loads a jotego core that other sources
  already provide as a MiSTer build. Everything else, such as NeptUNO+-only ports of other
  authors' cores (Splash!, the copy of Marble Madness II, alternate regional sets of jlrh's
  cores), is excluded, and its dates never date another source's MRA.
- `DB_TITLES`: display names for source ids.

MAME classification lives in `mmc/mame.py` (`GAMBLING_DIRS`, `GAMBLING_FILES`, `GAMBLING_DESC`,
`MAHJONG_FILES`, `MAHJONG_DESC`). Core de-duplication rules are in `mmc/reconcile.py`
(`_OWNER_PREFIX`, `merge_duplicate_cores`).

After changing any of these, run `python -m mmc mister --no-fetch` (or `--no-sync` if nothing new
needs cloning) and then `python -m mmc report`.

## Hosting

Everything the page needs is static and committed under `docs/`: `index.html`, `app.js`,
`style.css`, `data/coverage.json` and `data/summary.json` (the empty `.nojekyll` only matters if
the folder is ever served by GitHub Pages, which strips underscore paths otherwise).

The live site is **https://mister-mame-coverage-docs.vercel.app/**, a Vercel project whose root
directory is `docs/` with no build step; it redeploys on every push to `main`, so the daily
data refresh goes live on its own. The data files are plain URLs next to the page
(`https://mister-mame-coverage-docs.vercel.app/data/coverage.json`) and can be consumed by other
tools. Nothing in the page depends on the host: any static file server pointed at `docs/` works.

Locally, serve the folder over HTTP (`python -m http.server -d docs 8000`); browsers refuse
`fetch()` of the JSON from `file://`.

The page is vanilla HTML/CSS/JS with no external dependencies: filters, sorting, the burndown and
per-year charts all run client side. Filter state is kept in the URL hash, so a filtered view can
be linked.

## Keeping it fresh

`.github/workflows/update.yml` runs daily (05:17 UTC) and on demand:
it runs `python -m mmc build`, then commits `data/`, `docs/data/` and `reports/` if anything
changed. Runs are serialised (`concurrency`). If the push is rejected because `main` moved during
the run (for example a PR merged meanwhile), the job resets to the new `origin/main` and rebuilds
on top of it, up to three times; the ledger is append-only, so nothing is lost. The MAME download
is cached between runs. To change the MAME version used by CI, pass
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
