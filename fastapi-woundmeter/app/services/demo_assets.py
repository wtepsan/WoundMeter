"""Synthetic demo phantoms rendered by scripts/make_synthetic_demo_images.py (no patient data)."""
from __future__ import annotations

import hashlib
import json
from functools import lru_cache
from typing import Dict, Optional

from app.config import APP_ROOT

DEMO_ASSETS_DIR = APP_ROOT / "demo_assets"
BASELINE_IMAGE = "synthetic_phantom_baseline_18cm.jpg"
FOLLOWUP_IMAGE = "synthetic_phantom_followup_18cm.jpg"
# Visits 2-6 of the wound-history sample (scripts/seed_history_sample.py); visit 1 is BASELINE_IMAGE.
HISTORY_IMAGES = tuple(f"synthetic_phantom_history_visit{n}_18cm.jpg" for n in range(2, 7))
# Visits 1-6 of the worsening sample (scripts/seed_worsening_sample.py): a second phantom that grows.
WORSENING_IMAGES = tuple(f"synthetic_phantom_worsening_visit{n}_18cm.jpg" for n in range(1, 7))
# The eight-patch colour-strip phantoms (scripts/make_colour_calibration_phantoms.py); the warm cast is the demo photo.
COLOUR_STRIP_DEMO_IMAGE = "colour/colour_strip_warm_18cm.jpg"
COLOUR_STRIP_IMAGES = tuple(f"colour/colour_strip_{name}_18cm.jpg"
                            for name in ("warm", "cool", "mixed", "dim", "occluded", "glare", "covered"))


def read_demo_asset(name: str) -> bytes:
    # Never fall back to a photograph when a synthetic asset is missing.
    path = DEMO_ASSETS_DIR / name
    if not path.is_file():
        raise FileNotFoundError(f"Synthetic demo image {path} is missing; run scripts/make_synthetic_demo_images.py.")
    return path.read_bytes()


# Earlier versions of these images (before they were re-rendered on the real ruler artwork). Uploads
# stored from them stay labelled as synthetic; see demo_assets/README.md.
LEGACY_HASHES_FILE = DEMO_ASSETS_DIR / "legacy_synthetic_hashes.json"


@lru_cache(maxsize=1)
def _kinds_by_hash() -> Dict[str, str]:
    kinds = {}
    if LEGACY_HASHES_FILE.is_file():
        for version in json.loads(LEGACY_HASHES_FILE.read_text()).get("versions", []):
            kinds.update({entry["sha256"]: entry["kind"] for entry in version["images"].values()})
    named = [(BASELINE_IMAGE, "synthetic_phantom"), (FOLLOWUP_IMAGE, "simulated_followup")]
    named += [(name, "simulated_followup") for name in HISTORY_IMAGES]
    named += [(WORSENING_IMAGES[0], "synthetic_phantom")]
    named += [(name, "simulated_deterioration") for name in WORSENING_IMAGES[1:]]
    named += [(name, "synthetic_phantom") for name in COLOUR_STRIP_IMAGES]
    for name, kind in named:
        path = DEMO_ASSETS_DIR / name
        if path.is_file():
            kinds[hashlib.sha256(path.read_bytes()).hexdigest()] = kind
    return kinds


def synthetic_image_kind(sha256_hash: Optional[str]) -> Optional[str]:
    """Label an upload byte-identical to a generated phantom, however it was submitted."""
    return _kinds_by_hash().get(sha256_hash or "")
