#!/usr/bin/env python3
"""Hardware summary of every MAME driver we support, for the twist-open on the Drivers tab.

    python3 tools/hardware.py                  # writes docs/data/hardware.json

A driver is "supported" when at least one of its titles is on MiSTer (docs/data/coverage.json, written by
``python -m mmc report``, which runs this tool). For each one the file holds

  cpus, sound   the ``<chip>`` declarations of MAME's ``-listxml`` for every set of the driver: name, count per
                machine, the clocks (Hz) with the number of sets using each, and ``sets`` = in how many of the
                driver's sets the chip appears. A chip that is in only some sets is optional or a variant.
  devices       the other devices the machines declare (custom chips, RAM, EEPROMs...), the same way, without the
                chips above and the plumbing every machine has
  slots         slots with selectable options (plug-in cards and the like), as MAME declares them
  notes         the comments and ASCII diagrams of the driver source (the mame<version> tag, fetched from GitHub)
                that describe the hardware; the secondary source, kept as written

The -listxml is read from work/cache (mmc has downloaded it) and parsed once per MAME version.
"""
from __future__ import annotations

import argparse
import collections
import concurrent.futures as cf
import json
import os
import re
import sys
import urllib.request
import xml.etree.ElementTree as ET
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
from mmc import paths  # noqa: E402

COVERAGE = os.path.join(paths.DOCS, "data", "coverage.json")
OUT = os.path.join(paths.DOCS, "data", "hardware.json")
SRC_URL = "https://raw.githubusercontent.com/mamedev/mame/{tag}/src/mame/{path}"

# Devices every machine has, or that only plumb other devices together: not worth listing.
PLUMBING = {
    "screen", "speaker", "palette", "gfxdecode", "nvram", "watchdog_timer", "timer", "ticket_dispenser", "hopper",
    "generic_latch_8", "generic_latch_16", "input_merger", "input_merger_any_high", "input_merger_all_high", "ram",
    "address_map_bank", "output_latch", "ls259", "ls157", "ls153", "ls74", "ls138", "ls139", "ls245", "ls373",
    "ls374", "ls244", "ls273", "ls175", "ls161", "ls393", "ls32", "ls08", "ls04", "ls00", "ls02", "ls86", "ls10",
    "ttl74123", "ttl7474", "ttl74153", "ttl74161", "ttl74175", "ttl74259", "pwm_display", "sensorboard", "bitmap",
    "mb_vcu", "diserial", "dac_bit_interface", "vcc", "gnd", "buffered_spriteram8", "buffered_spriteram16",
    "buffered_spriteram32", "ldv1000", "software_list", "romcs", "rom_region",
}


def mame_version() -> str:
    with open(COVERAGE, encoding="utf-8") as f:
        return json.load(f)["meta"]["mame_version"]


def supported_drivers() -> list[str]:
    with open(COVERAGE, encoding="utf-8") as f:
        return sorted(d["sourcefile"] for d in json.load(f)["drivers"] if d["covered"] > 0)


# ---------------------------------------------------------------------------------------------
# -listxml
# ---------------------------------------------------------------------------------------------

def parse_listxml(zpath: str, wanted: set[str]) -> dict[str, list[dict]]:
    """driver source file -> one record per set: its chips, devices and slots."""
    out: dict[str, list[dict]] = collections.defaultdict(list)
    with zipfile.ZipFile(zpath) as z, z.open(z.namelist()[0]) as f:
        for _ev, el in ET.iterparse(f, events=("end",)):
            if el.tag != "machine":
                continue
            src = el.get("sourcefile")
            if src in wanted and el.get("isbios") != "yes" and el.get("isdevice") != "yes" and el.get("runnable") != "no":
                chips = [(c.get("type"), c.get("tag") or "", c.get("name") or "", int(c.get("clock") or 0))
                         for c in el.findall("chip") if c.get("type") in ("cpu", "audio") and c.get("name") != "Speaker"]
                tags = [c[1] for c in chips]
                devs = []
                for d in el.findall("device_ref"):
                    tag = (d.get("tag") or "").lstrip(":")
                    if any(tag == t or tag.startswith(t + ":") for t in tags):
                        continue            # the device behind a chip listed above
                    if d.get("name") in PLUMBING:
                        continue
                    devs.append(d.get("name"))
                slots = {s.get("name"): [(o.get("devname") or o.get("name"), o.get("default") == "yes") for o in s.findall("slotoption")]
                         for s in el.findall("slot")}
                out[src].append({"set": el.get("name"), "chips": chips, "devices": devs, "slots": {k: v for k, v in slots.items() if v}})
            el.clear()
    return out


def summarise(machines: list[dict]) -> dict:
    n = len(machines)

    def tally(per_machine: list[collections.Counter]) -> list[dict]:
        names = collections.OrderedDict()
        for m in per_machine:
            for k in m:
                names.setdefault(k, None)
        rows = []
        for k in names:
            have = [m for m in per_machine if m[k]]
            rows.append({"name": k, "count": max(m[k] for m in have), "sets": len(have)})
        return rows

    cpus_m = [collections.Counter(c[2] for c in m["chips"] if c[0] == "cpu") for m in machines]
    snd_m = [collections.Counter(c[2] for c in m["chips"] if c[0] == "audio") for m in machines]
    cpus, sound = tally(cpus_m), tally(snd_m)
    for rows, typ in ((cpus, "cpu"), (sound, "audio")):
        for r in rows:
            clocks = collections.Counter(c[3] for m in machines for c in set(x for x in m["chips"] if x[0] == typ and x[2] == r["name"]))
            r["clocks"] = [[hz, k] for hz, k in sorted(clocks.items(), key=lambda x: (-x[1], x[0]))]
    devs = tally([collections.Counter(m["devices"]) for m in machines])
    slots: dict[str, dict[str, int]] = {}
    for m in machines:
        for s, opts in m["slots"].items():
            for o, _d in opts:
                slots.setdefault(s, {}).setdefault(o, 0)
    return {"sets": n, "cpus": cpus, "sound": sound, "devices": devs,
            "slots": {s: sorted(o) for s, o in sorted(slots.items())}}


# ---------------------------------------------------------------------------------------------
# driver source comments
# ---------------------------------------------------------------------------------------------

_BLOCK = re.compile(r"/\*(.*?)\*/", re.S)
_HW = re.compile(r"\b(cpu|z80|6502|6809|68000|68k|8085|8088|8086|tms\d+|ym\d+|ay-?3|oki|msm\d+|k05\d+|mhz|khz|clock|xtal|crystal|pcb|board|rom|eprom|prom|"
                 r"ram|sram|dram|custom|asic|fpga|pal|gal|ppi|pia|via|sound|dac|chip|ic\d+|u\d+)\b", re.I)
_DIAG = re.compile(r"[+|]\s*[-=_]{3,}|[-=_]{3,}\s*[+|]|\|[^|\n]{2,}\|")
_LICENSE = re.compile(r"license:|copyright-holders", re.I)


def _clean(block: str) -> list[str]:
    lines = [ln.rstrip() for ln in block.expandtabs(4).splitlines()]
    lines = [re.sub(r"^\s*\*\s?", "", ln) if re.match(r"^\s*\*(?!/)", ln) else ln for ln in lines]
    while lines and not lines[0].strip():
        lines.pop(0)
    while lines and not lines[-1].strip():
        lines.pop()
    lead = min((len(ln) - len(ln.lstrip()) for ln in lines if ln.strip()), default=0)
    return [ln[lead:] for ln in lines]


def extract_notes(text: str, max_lines: int = 140) -> list[str]:
    """Comment blocks that describe the hardware: ASCII diagrams, or text naming several chips, clocks or boards."""
    blocks: list[str] = []
    for m in _BLOCK.finditer(text):
        blocks.append(m.group(1))
    # runs of // comment lines are blocks too
    run: list[str] = []
    for ln in text.splitlines() + [""]:
        s = ln.strip()
        if s.startswith("//") and not _LICENSE.search(s):
            run.append(s[2:])
        else:
            if len(run) >= 4:
                blocks.append("\n".join(run))
            run = []
    notes, used = [], 0
    for b in blocks:
        if _LICENSE.search(b) and len(b) < 200:
            continue
        lines = _clean(b)
        if len(lines) < 3:
            continue
        diag = sum(1 for ln in lines if _DIAG.search(ln))
        hw = len({m.group(1).lower() for m in _HW.finditer(b)})
        # TODO lists and ROM dump chatter are not hardware descriptions
        if diag >= 3 or (hw >= 5 and len(lines) <= 120 and not re.match(r"\s*(todo|notes?:?\s*todo)", lines[0], re.I)):
            if used + len(lines) > max_lines:
                break
            notes.append("\n".join(lines))
            used += len(lines)
    return notes


def fetch_source(tag: str, path: str, cache_dir: str) -> str | None:
    dest = os.path.join(cache_dir, path.replace("/", "__"))
    if os.path.exists(dest):
        with open(dest, encoding="utf-8", errors="replace") as f:
            return f.read()
    try:
        req = urllib.request.Request(SRC_URL.format(tag=tag, path=path), headers={"User-Agent": "mister-mame-coverage"})
        with urllib.request.urlopen(req, timeout=60) as r:
            data = r.read()
    except Exception:
        return None
    os.makedirs(cache_dir, exist_ok=True)
    with open(dest, "wb") as f:
        f.write(data)
    return data.decode("utf-8", errors="replace")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--no-source", action="store_true", help="skip the driver source comments")
    ap.add_argument("--out", default=OUT)
    a = ap.parse_args()

    version = mame_version()
    zpath = os.path.join(paths.CACHE, f"mame{version.replace('.', '')}lx.zip")
    if not os.path.exists(zpath):
        print(f"[hardware] {zpath} missing; run `python -m mmc mame` first", file=sys.stderr)
        return 1
    drivers = supported_drivers()
    cache = os.path.join(paths.CACHE, f"hardware_{version}.json")
    parsed = None
    if os.path.exists(cache):
        with open(cache, encoding="utf-8") as f:
            parsed = json.load(f)
        if set(drivers) - set(parsed):
            parsed = None
    if parsed is None:
        raw = parse_listxml(zpath, set(drivers))
        parsed = {d: summarise(raw[d]) for d in drivers if raw.get(d)}
        with open(cache, "w", encoding="utf-8") as f:
            json.dump(parsed, f, separators=(",", ":"))
    tag = "mame" + version.replace(".", "")
    src_dir = os.path.join(paths.CACHE, "mamesrc", tag)
    if not a.no_source:
        with cf.ThreadPoolExecutor(8) as ex:
            texts = dict(zip(drivers, ex.map(lambda d: fetch_source(tag, d, src_dir), drivers)))
        for d, rec in parsed.items():
            rec["notes"] = extract_notes(texts[d]) if texts.get(d) else []
    out = {"mame": version, "tag": tag, "drivers": {d: parsed[d] for d in sorted(parsed)}}
    os.makedirs(os.path.dirname(a.out), exist_ok=True)
    with open(a.out, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
    n_notes = sum(1 for r in parsed.values() if r.get("notes"))
    print(f"hardware: {len(parsed)} of {len(drivers)} supported drivers, {n_notes} with notes from the source -> {os.path.relpath(a.out, ROOT)} ({os.path.getsize(a.out) // 1024} KB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
