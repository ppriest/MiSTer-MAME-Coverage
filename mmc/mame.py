"""MAME side: fetch the ``-listxml`` output that mamedev attaches to every GitHub release
(``mame0XXXlx.zip``) and reduce it to the arcade machines we care about.

The reduced form is cached as JSON so later steps never touch the 300 MB XML again.
"""
from __future__ import annotations

import io
import json
import os
import re
import urllib.request
import xml.etree.ElementTree as ET
import zipfile

from . import paths

RELEASE_URL = "https://github.com/mamedev/mame/releases/download/mame{v}/mame{v}lx.zip"


def _head_ok(url: str) -> bool:
    req = urllib.request.Request(url, method="HEAD")
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status == 200
    except Exception:
        return False


def latest_version(start: int = 289, limit: int = 40) -> str:
    """Probe release assets upward from ``start`` until one is missing; return e.g. ``"0289"``."""
    v = start
    found = None
    for _ in range(limit):
        if _head_ok(RELEASE_URL.format(v=f"{v:04d}")):
            found = v
            v += 1
        else:
            if found is not None:
                break
            v += 1
    if found is None:
        raise RuntimeError("no MAME listxml release asset found; pass --mame-version")
    return f"{found:04d}"


def fetch_listxml(version: str) -> str:
    """Download ``mame<version>lx.zip`` into the cache (if absent) and return the zip path."""
    os.makedirs(paths.CACHE, exist_ok=True)
    dest = os.path.join(paths.CACHE, f"mame{version}lx.zip")
    if not os.path.exists(dest):
        url = RELEASE_URL.format(v=version)
        print(f"[mame] downloading {url}")
        with urllib.request.urlopen(url, timeout=120) as r, open(dest + ".part", "wb") as f:
            while chunk := r.read(1 << 20):
                f.write(chunk)
        os.replace(dest + ".part", dest)
    return dest


def parse_listxml(zip_path: str) -> dict:
    """Stream the XML and keep one compact record per runnable, non-device machine."""
    machines: dict[str, dict] = {}
    build = None
    with zipfile.ZipFile(zip_path) as z:
        name = next(n for n in z.namelist() if n.endswith(".xml"))
        with z.open(name) as raw:
            stream = io.BufferedReader(raw, buffer_size=1 << 20)
            for event, el in ET.iterparse(stream, events=("start", "end")):
                if event == "start":
                    if el.tag == "mame":
                        build = el.get("build")
                    continue
                if el.tag != "machine":
                    continue
                try:
                    if el.get("isdevice") == "yes" or el.get("runnable") == "no":
                        continue
                    rec = _machine_record(el)
                    machines[rec["name"]] = rec
                finally:
                    el.clear()
    return {"build": build, "machines": machines}


def _machine_record(el: ET.Element) -> dict:
    drv = el.find("driver")
    inp = el.find("input")
    disp = el.find("display")
    rec = {
        "name": el.get("name"),
        "desc": (el.findtext("description") or "").strip(),
        "year": (el.findtext("year") or "").strip(),
        "manufacturer": (el.findtext("manufacturer") or "").strip(),
        "sourcefile": el.get("sourcefile") or "",
        "cloneof": el.get("cloneof"),
        "romof": el.get("romof"),
        "isbios": el.get("isbios") == "yes",
        "mechanical": el.get("ismechanical") == "yes",
        "status": drv.get("status") if drv is not None else None,
        "emulation": drv.get("emulation") if drv is not None else None,
        "coins": int(inp.get("coins")) if inp is not None and inp.get("coins") else 0,
        "players": int(inp.get("players")) if inp is not None and inp.get("players") else 0,
        "display": disp.get("type") if disp is not None else None,
        "rotate": int(disp.get("rotate")) if disp is not None and disp.get("rotate") else None,
        "width": int(disp.get("width")) if disp is not None and disp.get("width") else None,
        "height": int(disp.get("height")) if disp is not None and disp.get("height") else None,
        "softlist": el.find("softwarelist") is not None,
        "cpus": sorted({c.get("name") for c in el.findall("chip") if c.get("type") == "cpu"}),
    }
    return rec


def load_mame(version: str | None, refresh: bool = False) -> dict:
    """Return ``{"version", "build", "machines"}`` from cache, parsing the XML if needed."""
    if not version:
        version = latest_version()
    cache = os.path.join(paths.CACHE, f"mame{version}.json")
    if os.path.exists(cache) and not refresh:
        with open(cache, encoding="utf-8") as f:
            return json.load(f)
    zp = fetch_listxml(version)
    print(f"[mame] parsing {zp} (this takes a few minutes)")
    data = parse_listxml(zp)
    data["version"] = version
    with open(cache, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
    return data


# --- arcade selection ------------------------------------------------------------------------

# Driver source folders (and single driver files) that hold gambling / fruit-machine hardware.
# These are "arcade" in MAME's sense (coin operated) but are not what FPGA arcade cores target.
# They stay in the data with a category so the page can show them, they are just not counted
# by default.
GAMBLING_DIRS = {
    "aristocrat", "barcrest", "bfm", "jpm", "maygay", "igt", "merit", "sigma", "atronic", "amatic",
    "ace", "novag", "ecp", "astrocorp", "subsino", "amcoe", "bordun", "funworld", "dgrm",
}
GAMBLING_FILES = {
    "aristmk5", "aristmk6", "goldstar", "goldnpkr", "calomega", "norautp", "igs_m027", "gei",
    "multfish", "highvdeo", "jackpool", "lucky74", "magicfly", "majorpkr", "peplus", 
    "snookr10", "spool99", "videopkr", "witch", "wms", "igs011_gamble", "ampoker2", "blitz", "blitz68k", "cb2001",
    "coinmstr", "fortecar", "igs009", "jangou", "jclub2",
    "lucky74", "mgavegas", "miniboy7", "mpu4", "murogem", "nsmpoker", "pinkiri8",
    "rbmk", "roul", "sanremo", "sfbonus", "silverball", "skylncr", "spoker", "splus",
    "stellafr", "tmspoker", "umipoker", "vroulet", 
}
GAMBLING_DESC = re.compile(
    r"\b(poker|slot|jackpot|casino|bingo|keno|blackjack|roulette|fruit|cherry|lottery|pachinko|"
    r"pachislot|gambl|medal|tarot|horse racing|dice|craps|baccarat|lotto)\b", re.I)
MAHJONG_DESC = re.compile(r"mahjong|mah-jong|mahjan|janshi|jong\b|hanafuda|janputer|shougi|shogi", re.I)
MAHJONG_FILES = {"royalmah", "ddenlovr", "hnayayoi", "jangou", "homedata"}


def classify(m: dict) -> str:
    """Rough category: arcade / mahjong / gambling / mechanical / other (consoles, computers).

    Coin inputs are the signal for coin-op hardware; a coin-op machine with no video display is a
    fruit machine or similar; some manufacturer folders, driver files and description words mark
    gambling boards; mahjong boards are a category of their own (many are gambling-adjacent).
    """
    if m["mechanical"]:
        return "mechanical"
    if m["coins"] <= 0:
        return "other"
    if m["display"] is None:
        return "gambling"
    folder, _, fn = m["sourcefile"].rpartition("/")
    fn = fn[:-4] if fn.endswith(".cpp") else fn
    if folder in GAMBLING_DIRS or fn in GAMBLING_FILES:
        return "gambling"
    if fn in MAHJONG_FILES or fn.startswith("nbmj") or MAHJONG_DESC.search(m["desc"]):
        return "mahjong"
    if GAMBLING_DESC.search(m["desc"]):
        return "gambling"
    return "arcade"


def is_working(m: dict) -> bool:
    """MAME's MACHINE_NOT_WORKING flag is what sets ``emulation="preliminary"`` in -listxml."""
    return m.get("emulation") != "preliminary"
