"""Cache-busting for the static page: ``style.css`` and ``app.js`` are linked from ``docs/index.html`` with a
``?v=<content hash>`` query, so a browser or CDN that cached an older file fetches the new one as soon as
its content changes. Run by ``mmc report`` (the daily refresh) and runnable on its own after editing the
page: ``python -m mmc.cachebust``."""
from __future__ import annotations

import hashlib
import os
import re

from . import paths

ASSETS = ("style.css", "app.js")


def stamp(page: str = "index.html") -> bool:
    """Rewrite the asset links in ``docs/<page>`` to carry the current content hash; True if the page changed."""
    path = os.path.join(paths.DOCS, page)
    with open(path, encoding="utf-8") as f:
        html = f.read()
    new = html
    for name in ASSETS:
        with open(os.path.join(paths.DOCS, name), "rb") as f:
            v = hashlib.sha1(f.read()).hexdigest()[:10]
        new = re.sub(rf'((?:href|src)="){re.escape(name)}(?:\?v=[0-9a-f]+)?(")', rf"\g<1>{name}?v={v}\g<2>", new)
    if new != html:
        with open(path, "w", encoding="utf-8", newline="") as f:
            f.write(new)
    return new != html


if __name__ == "__main__":
    print("index.html re-stamped" if stamp() else "index.html already current")
