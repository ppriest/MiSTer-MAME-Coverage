"""Where things live. Everything derived is under ``work/`` (not committed) except the published
outputs, which go to ``docs/`` so a static host (Vercel today) can serve them."""
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WORK = os.environ.get("MMC_WORK", os.path.join(ROOT, "work"))
CACHE = os.path.join(WORK, "cache")
REPOS = os.path.join(WORK, "repos")
DOCS = os.path.join(ROOT, "docs")
DATA = os.path.join(ROOT, "data")
