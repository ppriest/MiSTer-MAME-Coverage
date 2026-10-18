# Brief: driver hardware summaries from a local MAME checkout

A self-contained task for a local project (or a local Claude session) that has **a checkout of MAME** and can
build or run it. It produces the data behind the ▸ twist-open on the *Drivers* tab of the MiSTer × MAME coverage
page (https://mister-mame-coverage-docs.vercel.app/, repository `ppriest/MiSTer-MAME-Coverage`).

## Goal

For **every driver on the Drivers tab** (all the candidates for MiSTer, whether or not a core exists yet; 971 today,
paths like `capcom/cps1.cpp`) write a short hardware summary:

* the **CPUs** and **sound chips**, with the **frequencies** they run at and how many of each there are,
* the **other chips/devices** (custom chips, EEPROMs, RAM, protection devices, video DACs...),
* the **optionality**: what only some of the driver's sets have (variants, optional boards, selectable slots),
* as a secondary source, the **comments and ASCII diagrams** in the driver file that describe the hardware.

The page shows it per driver, so output is split into **small files** (see *Output*): no single transfer may be large.

## Inputs

1. **The MAME checkout**, at the release the page reports (`docs/data/coverage.json` → `meta.mame_version`, e.g. `0289`
   = git tag `mame0289`). Check it out at that tag, or say which version the output is for. Drivers live in
   `src/mame/<manufacturer>/<name>.cpp`; the driver id used everywhere is the path below `src/mame/`.
2. **The driver list**: the file names to cover. Export them from the coverage data
   (`https://mister-mame-coverage-docs.vercel.app/data/summary.json`, or `docs/data/coverage.json` in the repository):

   ```python
   import json, urllib.request
   d = json.load(urllib.request.urlopen("https://mister-mame-coverage-docs.vercel.app/data/summary.json"))
   drivers = sorted(x["sourcefile"] for x in d["drivers"])      # e.g. "capcom/cps1.cpp"
   ```
3. A **MAME binary built from that checkout** (strongly recommended, see *Method*).

## Method

### Primary: MAME's declarations

What MAME declares in code is authoritative; never guess a chip or a clock.

* **Easiest and most reliable: `mame -listxml`** from a binary built from the same checkout. Per `<machine>` the
  `<chip type="cpu|audio" tag=".." name=".." clock="Hz"/>` lines are the resolved CPUs and sound chips with their
  actual clocks (XTAL expressions and dividers already evaluated). `sourcefile` on the machine says which driver it
  belongs to (same path form as the driver list). Also read `<device_ref>` (all devices, with `tag`) and
  `<slot>/<slotoption>` (selectable options). Skip machines with `isbios="yes"`, `isdevice="yes"` or `runnable="no"`.
  `-listxml` of a full build is about 300 MB: stream it (`iterparse` and clear elements).
* **Cross-check / fill-ins from the source** where listxml is silent or ambiguous: the `*_device`/`machine_config`
  functions of the driver (`M68000(config, m_maincpu, XTAL(12'000'000))`, `YM2151(config, "ymsnd", 3.579545_MHz_XTAL)`,
  `OKIM6295(config, m_oki, 1_MHz_XTAL, okim6295_device::PIN7_HIGH)`, divided clocks like `MASTER_CLOCK/2`, constants
  defined at the top of the file), and `GAME(...)`/`GAMEL(...)` lines, which tie each set to the machine
  configuration it uses. Where listxml and the source disagree, keep listxml and note the case.
* **Roles**: CPUs are `type="cpu"` chips (main, sound, MCU, DSP... all of them; the tag tells which). Sound chips are
  `type="audio"` chips except the generic `Speaker`. Everything else a machine declares via `device_ref` is a
  device; leave out the plumbing every machine has (screen, speaker, palette, gfxdecode, nvram, watchdog, timers,
  latches, input mergers, address-map banks, generic 74xx glue) and the devices that sit behind a chip already listed
  (a `device_ref` whose tag equals or starts with a listed chip's tag).

### Optionality

A driver usually has many sets (parent plus clones, bootlegs, regional versions) that differ in hardware. For each
CPU, sound chip and device compute **in how many of the driver's sets it appears** (`sets`) against the driver's
total (`sets` of the driver). `sets < total` means *variant or optional* (a different sound board, an added MCU, a
protection chip). For each chip also record every **clock** it runs at with the number of sets per clock (a driver can
mix 10 and 12 MHz 68000s). Selectable **slots** (plug-in cards, sound boards) are listed with their options as MAME
declares them. If the source says a part is optional in a comment (a sound board "not always fitted"), put that in the
notes rather than inventing a field.

### Secondary: comments and diagrams in the driver source

From the same `.cpp` extract the comment blocks that describe the hardware, **verbatim**:

* block comments (`/* ... */`) and runs of at least four `//` lines;
* keep a block when it contains an **ASCII diagram** (three or more lines with `+---+`, `|....|`, `----+` shapes), or
  when it names several chip/clock/board words (CPU names, `MHz`, `XTAL`, `PCB`, `ROM`, `RAM`, chip numbers like
  `YM2151`, `u12`, `IC5`...), at most about 120 lines, skipping licence headers and TODO lists;
* strip the comment markers and the common indentation, keep the layout (it is shown in a `<pre>`); at most about 140
  lines per driver in total.

Expect this to be wrong sometimes (a missed block, an unrelated one): prefer precision, and say so in the README.
(The reference implementation uses exactly these heuristics; see below.)

## Output

Directory `hardware/` (it will be copied to `docs/data/hardware/` of the coverage repository):

* **One file per first letter of the driver path**: `a.json`, `b.json`, ... `z.json`, and `0.json` for a path that does
  not start with a letter. The key of `capcom/cps1.cpp` is `c`; of `sega/model2.cpp` is `s`. This rule is fixed because
  the page computes the same key to know which file to fetch. Keep each file well under **200 KB**; report the largest
  and the total. If a letter is too large, tell the caller rather than changing the rule (the page must change with it).
* Compact JSON (no indentation), UTF-8, written only if a letter has drivers.
* Every driver of the list that has at least one runnable set appears exactly once; drivers with none are omitted.

Each file:

```json
{
  "mame": "0289",
  "tag": "mame0289",
  "drivers": {
    "capcom/cps1.cpp": {
      "sets": 233,
      "cpus": [
        {"name": "Motorola MC68000", "count": 1, "sets": 233, "clocks": [[10000000, 134], [12000000, 99]]},
        {"name": "Zilog Z80",        "count": 1, "sets": 233, "clocks": [[3579545, 214], [8000000, 19]]}
      ],
      "sound": [
        {"name": "YM2151 OPM",         "count": 1, "sets": 214, "clocks": [[3579545, 214]]},
        {"name": "QSound (HLE)",       "count": 1, "sets": 19,  "clocks": [[60000000, 19]]}
      ],
      "devices": [{"name": "93c46_8", "count": 1, "sets": 22}],
      "slots": {"slotname": ["optionA", "optionB"]},
      "notes": ["comment or ASCII diagram, verbatim, newline-separated lines"]
    }
  }
}
```

Field meanings: `sets` (driver level) = number of runnable sets; per row `count` = the most instances of that part any
one set has; `sets` = how many sets have it at all; `clocks` = `[Hz, sets using that Hz]`, most used first (omit or
use `[]` when a part has no clock, e.g. a RAM or EEPROM); `slots` = slot name → option names; `notes` = list of strings
(empty list when none). `name` for CPUs and sound chips is the long chip name MAME gives (`<chip name>`); for devices
it is the device short name (`<device_ref name>`). Keep the field names: the page reads them as they are.

## Acceptance checks

* The file set covers the driver list; print how many drivers have data, how many have `notes`, and any listed driver
  with no runnable set.
* Spot-check against MAME itself: `capcom/cps1.cpp` (see the sample above: 68000 at 10 and 12 MHz, Z80 at 3.579545
  and 8 MHz, YM2151 + OKI MSM6295 in most sets, QSound in 19), `rare/btoads.cpp` (TMS34020 32 MHz, Z80 6 MHz,
  TMS320C15 24 MHz, BSMT2000 24 MHz), and three drivers of your choice that use a multi-board layout.
* No clock or chip appears that is not in the checkout; every `notes` string is a literal substring (modulo comment
  markers and indentation) of the driver file.
* Re-running with the same inputs gives byte-identical output (sort everything).
* Largest file and total size reported.

## Reference implementation

`tools/hardware.py` in the coverage repository (branch `claude/mame-mister-arcade-coverage-am3yp4`, PR #76) does the
same from the published `mame0289lx.zip` (the release's `-listxml`) plus the driver sources fetched from GitHub, for
the 440 drivers already supported, into a single file. Use it for the plumbing list, the notes heuristics and the
shape of the records; the new project replaces its inputs (a local build and checkout) and its output layout (the
per-letter files above, all drivers).

## Delivery

Hand back the `hardware/` directory and a short README (MAME version, how to re-run, the counts and sizes, known gaps).
The coverage repository loads it unchanged; wiring it into the page (the ▸ on every driver row, fetching
`data/hardware/<key>.json` on first open) is done there.
