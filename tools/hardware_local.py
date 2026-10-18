#!/usr/bin/env python3
"""Driver hardware summaries from a local MAME checkout and build, as tools/hardware-local.md describes.

    python hardware_local.py --mame E:/mame/mame.exe --src E:/mame --out hardware

Per-letter files hardware/<key>.json (key = first character of the driver path if a letter, else "0").
CPUs, sound chips, devices and slots come from `mame -listxml` streamed from the binary; notes are the
hardware comments and ASCII diagrams of each driver source in the checkout, verbatim. The plumbing list, the
note heuristics and the record shape are tools/hardware.py's (PR #76).
"""
import argparse
import collections
import json
import os
import re
import subprocess
import sys
import urllib.request
import xml.etree.ElementTree as ET

SUMMARY_URL = "https://mister-mame-coverage-docs.vercel.app/data/summary.json"

PLUMBING = {
    "screen", "speaker", "palette", "gfxdecode", "nvram", "watchdog_timer", "timer", "ticket_dispenser", "hopper",
    "generic_latch_8", "generic_latch_16", "input_merger", "input_merger_any_high", "input_merger_all_high", "ram",
    "address_map_bank", "output_latch", "ls259", "ls157", "ls153", "ls74", "ls138", "ls139", "ls245", "ls373",
    "ls374", "ls244", "ls273", "ls175", "ls161", "ls393", "ls32", "ls08", "ls04", "ls00", "ls02", "ls86", "ls10",
    "ttl74123", "ttl7474", "ttl74153", "ttl74161", "ttl74175", "ttl74259", "pwm_display", "sensorboard", "bitmap",
    "mb_vcu", "diserial", "dac_bit_interface", "vcc", "gnd", "buffered_spriteram8", "buffered_spriteram16",
    "buffered_spriteram32", "ldv1000", "software_list", "romcs", "rom_region",
}


def driver_list(path=None):
    if path:
        d = json.load(open(path, encoding="utf-8"))
    else:
        req = urllib.request.Request(SUMMARY_URL, headers={"User-Agent": "mister-mame-coverage"})
        d = json.load(urllib.request.urlopen(req, timeout=60))
    return sorted({x["sourcefile"] for x in d["drivers"]}), d.get("meta", {}).get("mame_version")


def parse_listxml(exe, wanted):
    """driver source -> one record per runnable set. Streams `exe -listxml` (no 300 MB file)."""
    out = collections.defaultdict(list)
    p = subprocess.Popen([exe, "-listxml"], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                         cwd=os.path.dirname(exe) or None)
    build = None
    for ev, el in ET.iterparse(p.stdout, events=("start", "end")):
        if ev == "start":
            if el.tag == "mame":
                build = el.get("build")
            continue
        if el.tag != "machine":
            continue
        src = el.get("sourcefile")
        if src in wanted and el.get("isbios") != "yes" and el.get("isdevice") != "yes" and el.get("runnable") != "no":
            chips = [(c.get("type"), (c.get("tag") or "").lstrip(":"), c.get("name") or "", int(c.get("clock") or 0))
                     for c in el.findall("chip") if c.get("type") in ("cpu", "audio") and c.get("name") != "Speaker"]
            tags = [c[1] for c in chips]
            devs = []
            for d in el.findall("device_ref"):
                tag = (d.get("tag") or "").lstrip(":")
                if any(tag == t or tag.startswith(t + ":") for t in tags):
                    continue
                if d.get("name") in PLUMBING:
                    continue
                devs.append(d.get("name"))
            slots = {s.get("name"): [o.get("name") for o in s.findall("slotoption")] for s in el.findall("slot")}
            out[src].append({"set": el.get("name"), "chips": chips, "devices": devs,
                             "slots": {k: v for k, v in slots.items() if v}})
        el.clear()
    p.wait()
    return out, build


def summarise(machines):
    n = len(machines)

    def tally(per_machine):
        rows = []
        for k in sorted({k for m in per_machine for k in m}):
            have = [m for m in per_machine if m[k]]
            rows.append({"name": k, "count": max(m[k] for m in have), "sets": len(have)})
        return sorted(rows, key=lambda r: (-r["sets"], r["name"]))

    cpus = tally([collections.Counter(c[2] for c in m["chips"] if c[0] == "cpu") for m in machines])
    sound = tally([collections.Counter(c[2] for c in m["chips"] if c[0] == "audio") for m in machines])
    for rows, typ in ((cpus, "cpu"), (sound, "audio")):
        for r in rows:
            clocks = collections.Counter()
            for m in machines:
                for hz in {c[3] for c in m["chips"] if c[0] == typ and c[2] == r["name"]}:
                    clocks[hz] += 1
            r["clocks"] = [[hz, k] for hz, k in sorted(clocks.items(), key=lambda x: (-x[1], x[0])) if hz]
    devs = tally([collections.Counter(m["devices"]) for m in machines])
    slots = {}
    for m in machines:
        for s, opts in m["slots"].items():
            slots.setdefault(s, set()).update(opts)
    return {"sets": n, "cpus": cpus, "sound": sound, "devices": devs,
            "slots": {s: sorted(o) for s, o in sorted(slots.items())}}


_BLOCK = re.compile(r"/\*(.*?)\*/", re.S)
_HW = re.compile(r"\b(cpu|z80|6502|6809|68000|68k|8085|8088|8086|tms\d+|ym\d+|ay-?3|oki|msm\d+|k05\d+|mhz|khz|clock|xtal|crystal|pcb|board|rom|eprom|prom|"
                 r"ram|sram|dram|custom|asic|fpga|pal|gal|ppi|pia|via|sound|dac|chip|ic\d+|u\d+)\b", re.I)
_DIAG = re.compile(r"[+|]\s*[-=_]{3,}|[-=_]{3,}\s*[+|]|\|[^|\n]{2,}\|")
_LICENSE = re.compile(r"license:|copyright-holders", re.I)


def _clean(block):
    lines = [ln.rstrip() for ln in block.expandtabs(4).splitlines()]
    lines = [re.sub(r"^\s*\*\s?", "", ln) if re.match(r"^\s*\*(?!/)", ln) else ln for ln in lines]
    while lines and not lines[0].strip():
        lines.pop(0)
    while lines and not lines[-1].strip():
        lines.pop()
    lead = min((len(ln) - len(ln.lstrip()) for ln in lines if ln.strip()), default=0)
    return [ln[lead:] for ln in lines]


def extract_notes(text, max_lines=140):
    blocks = [m.group(1) for m in _BLOCK.finditer(text)]
    run = []
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
        if diag >= 3 or (hw >= 5 and len(lines) <= 120 and not re.match(r"\s*(todo|notes?:?\s*todo)", lines[0], re.I)):
            if used + len(lines) > max_lines:
                break
            notes.append("\n".join(lines))
            used += len(lines)
    return notes


_SOURCES = None


def moved_sources(src, sets):
    """Driver sources in the checkout that define any of these sets with GAME*/CONS*/SYST* lines."""
    global _SOURCES
    root = os.path.join(src, "src", "mame")
    if _SOURCES is None:
        _SOURCES = {}
        rx = re.compile(r"^\s*(?:GAME|GAMEL|CONS|COMP|SYST)\s*\(\s*[^,]+,\s*(\w+)\s*,", re.M)
        for dp, _dn, fn in os.walk(root):
            for f in fn:
                if f.endswith(".cpp"):
                    path = os.path.join(dp, f)
                    rel = os.path.relpath(path, root).replace(os.sep, "/")
                    for m in rx.finditer(open(path, encoding="utf-8", errors="replace").read()):
                        _SOURCES.setdefault(m.group(1), set()).add(rel)
    return sorted({f for s in sets for f in _SOURCES.get(s, ())})


def key_of(path):
    c = path[:1].lower()
    return c if "a" <= c <= "z" else "0"


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--mame", required=True, help="MAME binary built from the checkout")
    ap.add_argument("--src", required=True, help="MAME checkout root")
    ap.add_argument("--drivers", help="summary.json or coverage.json (default: the live summary.json)")
    ap.add_argument("--listxml-cache", help="parsed listxml records, reused if present")
    ap.add_argument("--out", default="hardware")
    a = ap.parse_args()

    drivers, page_version = driver_list(a.drivers)
    tag = subprocess.run(["git", "-C", a.src, "describe", "--tags"], capture_output=True, text=True).stdout.strip()
    if a.listxml_cache and os.path.exists(a.listxml_cache):
        cached = json.load(open(a.listxml_cache, encoding="utf-8"))
        raw, build = cached["raw"], cached["build"]
    else:
        raw, build = parse_listxml(a.mame, set(drivers))
        if a.listxml_cache:
            json.dump({"build": build, "raw": raw}, open(a.listxml_cache, "w", encoding="utf-8"), separators=(",", ":"))
    version = re.match(r"[\d.]+", build or "").group(0).replace(".", "")

    files = collections.defaultdict(dict)
    missing_src, with_notes, none_runnable = [], 0, []
    for d in drivers:
        if not raw.get(d):
            none_runnable.append(d)
            continue
        rec = summarise(raw[d])
        p = os.path.join(a.src, "src", "mame", *d.split("/"))
        if os.path.exists(p):
            rec["notes"] = extract_notes(open(p, encoding="utf-8", errors="replace").read())
        else:
            # moved or split since the binary's version: the files whose GAME() lines define its sets
            moved = moved_sources(a.src, {m["set"] for m in raw[d]})
            text = "\n".join(open(os.path.join(a.src, "src", "mame", *f.split("/")), encoding="utf-8",
                                   errors="replace").read() for f in moved)
            rec["notes"] = extract_notes(text) if moved else []
            missing_src.append({d: moved})
        with_notes += bool(rec["notes"])
        files[key_of(d)][d] = rec

    os.makedirs(a.out, exist_ok=True)
    sizes = {}
    for k in sorted(files):
        body = {"mame": version, "tag": tag, "drivers": dict(sorted(files[k].items()))}
        path = os.path.join(a.out, f"{k}.json")
        with open(path, "w", encoding="utf-8", newline="\n") as f:
            json.dump(body, f, ensure_ascii=False, separators=(",", ":"))
        sizes[k] = os.path.getsize(path)
    report = {
        "binary": build, "source": tag, "page_mame": page_version,
        "drivers_listed": len(drivers), "drivers_with_data": sum(len(v) for v in files.values()),
        "drivers_with_notes": with_notes, "no_runnable_set": none_runnable, "source_missing": missing_src,
        "largest": max(sizes.items(), key=lambda x: x[1]), "total": sum(sizes.values()), "sizes": sizes,
    }
    json.dump(report, sys.stdout, indent=1)
    print()


if __name__ == "__main__":
    main()
