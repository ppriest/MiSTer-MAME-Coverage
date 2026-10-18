# Driver hardware data (tools/hardware-local.md)

Per-letter files `hardware/<key>.json` for the Drivers tab of the MiSTer × MAME coverage page, in the format
the brief gives. Copy `hardware/` to `docs/data/hardware/` in the coverage repository.

## Inputs

* **Chips, clocks, devices, slots:** `-listxml` of the full MAME **0.289 release** binary
  (`0.289 (mame0289)`). `E:/mame` has no full build: its `mame.exe` is a subtarget build that describes 117
  machines. A full build of the checkout would bring the chips and clocks up to the checkout's version.
* **Notes:** the driver sources of the checkout `E:/mame` at `mame0289-1527-gdedb5227403` (the `tag` field), newer than 0.289.
  Two drivers moved or split since 0.289; their notes come from the files that now hold their sets'
  `GAME()` lines:
* `dataeast/dec8.cpp` → `dataeast/cobracom.cpp`, `dataeast/ghostb.cpp`, `dataeast/lastmisn.cpp`, `dataeast/oscar.cpp`, `dataeast/srdarwin.cpp`
* `misc/pkscram.cpp` → `cosmo/pkscram.cpp`
* **Driver list:** the live `summary.json` (971 drivers, MAME 0289).

## Counts and sizes

* 971 of 971 drivers have data; 504 have notes; none has no runnable set.
* Total 1938 KB; largest `m.json`, 280 KB.
* **Over the brief's 200 KB:** `m.json`, `t.json`, `s.json`. Notes are most of each (m: 237 of 279 KB).
  Served gzipped (Vercel compresses JSON) they are 80, 61 and 61 KB. The key rule is unchanged; a lower
  notes budget per driver (now 140 lines) would bring them under.

| file | size |
|---|---|
| `m.json` | 280 KB |
| `t.json` | 260 KB |
| `s.json` | 229 KB |
| `k.json` | 188 KB |
| `d.json` | 133 KB |
| `n.json` | 132 KB |
| `a.json` | 120 KB |
| `i.json` | 84 KB |
| `c.json` | 72 KB |
| `p.json` | 65 KB |
| `e.json` | 58 KB |
| `w.json` | 56 KB |
| `g.json` | 56 KB |
| `j.json` | 35 KB |
| `b.json` | 31 KB |
| `o.json` | 31 KB |
| `v.json` | 30 KB |
| `u.json` | 25 KB |
| `y.json` | 21 KB |
| `z.json` | 17 KB |
| `f.json` | 10 KB |
| `r.json` | 4 KB |

## Checks run

* `capcom/cps1.cpp` matches the brief's sample: 233 sets, 68000 at 10 MHz (134) and 12 MHz (99), Z80 at
  3.579545 MHz (214) and 8 MHz (19), YM2151 and OKI MSM6295 in 214, QSound in 19.
* `rare/btoads.cpp`: TMS34020 32 MHz, Z80 6 MHz, TMS320C15 24 MHz, BSMT2000 24 MHz.
* Multi-board: `sega/model2.cpp` (i960 plus TGP / SHARC / TGPx4 variants, SCSP or M1 sound board),
  `namco/namcos2.cpp` (C65 vs C68 I/O MCU by set), `taito/taito_f3.cpp` (ES5505 sound system in 98 of 100).
* Every non-empty notes line is found verbatim (modulo indentation) in its driver source: 0 misses.
* A fresh `-listxml` run gives byte-identical files.

## Re-run

    python hardware_local.py --mame <full mame.exe> --src E:/mame --out hardware > report.json
    python checks.py

`--drivers summary.json` uses a saved driver list instead of the live one.

## Known gaps

* Notes heuristics are tools/hardware.py's: some hardware blocks are missed and some unrelated blocks kept
  (467 drivers have no notes, `rare/btoads.cpp` among them).
* Generic devices not in the plumbing list (`clock`, `watchdog`, `generic_fifo_*`) are listed as devices.
