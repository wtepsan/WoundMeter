"""Seeds for the guided Meta SAM 3.1 pass (concept locator → box + interior point per wound).

A concept prompt alone can return part of a wound: on the slough-heavy phantoms "red wound"
returns only the red bed (−11 % and −17 % area), and "wound" or "ulcer" return nothing. The guided
strategy uses the concept result only to locate the wound, then sends one spatial prompt per wound
region: a box around it, widened by a margin, plus a positive point at its most interior pixel, so
SAM can return the whole object. Measured on the phantoms, negative corner points and box-only
prompts were less reliable, so neither is used.

When YOLO ran on the same crop, every YOLO component seeds SAM at its own extent. On real photos
"wound" also matches skin-marker dashes, healed scar and new epithelium, so nothing is seeded when
YOLO ran and found no wound, and concept components only add regions YOLO did not find. Without YOLO,
concept components are the seeds. Any seed under MIN_SEED_FRACTION of the largest one is dropped
(dashes, specks). All coordinates are inner-crop pixels, so seeds can never reach the ruler arms or the colour strip, which lie outside
the inner measurement region.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, List, Optional, Sequence, Tuple

import cv2
import numpy as np

from .mask_mapping import connected_components

MIN_SEED_AREA_PX = 200  # 2 mm² on the 10 px/mm canonical plane
MAX_SEED_OBJECTS = 4
# Seeds smaller than this fraction of the largest seed are not sent to SAM.
MIN_SEED_FRACTION = 0.10
BOX_MARGIN_FRACTION = 0.10
BOX_MARGIN_MIN_PX = 15


@dataclass(frozen=True)
class SamSeed:
    mask: np.ndarray
    source: str  # "concept", "concept+yolo" or "yolo"
    box: Tuple[int, int, int, int]  # left, top, right_exclusive, bottom_exclusive
    point: Tuple[int, int]

    def as_prompt_object(self) -> Dict:
        return {"box": self.box, "points": [{"x": self.point[0], "y": self.point[1], "label": "positive"}]}

    def summary(self) -> Dict:
        return {"source": self.source, "box_px": list(self.box), "point_px": list(self.point),
                "seed_area_px": int(np.count_nonzero(self.mask))}


def _components(masks: Sequence[np.ndarray]) -> List[np.ndarray]:
    return [c for mask in masks for c in connected_components(mask) if np.count_nonzero(c) >= MIN_SEED_AREA_PX]


def _expanded_box(mask: np.ndarray) -> Tuple[int, int, int, int]:
    height, width = mask.shape
    ys, xs = np.nonzero(mask)
    left, top, right, bottom = int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1
    margin_x = max(BOX_MARGIN_MIN_PX, round(BOX_MARGIN_FRACTION * (right - left)))
    margin_y = max(BOX_MARGIN_MIN_PX, round(BOX_MARGIN_FRACTION * (bottom - top)))
    return (max(0, left - margin_x), max(0, top - margin_y),
            min(width, right + margin_x), min(height, bottom + margin_y))


def _interior_point(mask: np.ndarray) -> Tuple[int, int]:
    # The most interior pixel lies inside even a concave or ring-shaped component; a centroid may not.
    distance = cv2.distanceTransform(np.pad(mask.astype(np.uint8), 1), cv2.DIST_L2, 5)[1:-1, 1:-1]
    y, x = np.unravel_index(int(np.argmax(distance)), distance.shape)
    return int(x), int(y)


def clean_boundary_mask(mask: np.ndarray) -> Tuple[np.ndarray, int, int]:
    """Fill holes inside each outer wound edge and drop specks below 2 mm².

    The reviewed outline is the external contour, so islands of non-red tissue (slough) inside it
    belong to the wound area, as they would for a hand-drawn polygon. Returns the mask, the filled
    hole area and the removed speck area in pixels, both recorded in the SAM provenance.
    """
    binary = (mask > 0).astype(np.uint8)
    contours, _ = cv2.findContours(binary, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    kept = [c for c in contours if cv2.contourArea(c) >= MIN_SEED_AREA_PX]
    cleaned = np.zeros_like(binary)
    cv2.drawContours(cleaned, kept, -1, 1, thickness=cv2.FILLED)
    filled = int(np.count_nonzero(cleaned & (1 - binary)))
    removed = int(np.count_nonzero(binary & (1 - cleaned)))
    return cleaned, filled, removed


def mask_dice(a: np.ndarray, b: np.ndarray) -> float:
    a, b = a > 0, b > 0
    total = int(a.sum()) + int(b.sum())
    return 2.0 * int(np.logical_and(a, b).sum()) / total if total else 0.0


def guidance_seeds(
    concept_masks: Sequence[np.ndarray], yolo_masks: Optional[Sequence[np.ndarray]]
) -> List[SamSeed]:
    """`yolo_masks` is None when YOLO did not run, and empty when it ran and found no wound."""
    concept = _components(concept_masks)
    if yolo_masks is None:
        return _to_seeds([(component, "concept") for component in concept])
    yolo = _components(yolo_masks)
    if not yolo:
        # Both models must find a wound: "wound" alone also matches healed scar and new pink skin.
        return []
    # Every YOLO region seeds SAM at its own extent. The concept region is not merged in: on healing
    # wounds it spans scar and new epithelium around the open area, and widening the box to it makes
    # SAM outline that whole zone. Concept regions YOLO did not find are added; the size floor in
    # _to_seeds then drops the small ones (skin-marker dashes, specks).
    seeds: List[Tuple[np.ndarray, str]] = [
        (component, "yolo+concept" if any(np.any(component & other) for other in concept) else "yolo")
        for component in yolo
    ]
    seeds += [(component, "concept") for component in concept
              if not any(np.any(component & other) for other in yolo)]
    return _to_seeds(seeds)


def _to_seeds(seeds: List[Tuple[np.ndarray, str]]) -> List[SamSeed]:
    # Overlapping seeds (concept fragments from different masks) become one object.
    merged_seeds: List[Tuple[np.ndarray, str]] = []
    for mask, source in seeds:
        for index, (existing, existing_source) in enumerate(merged_seeds):
            if np.any(existing & mask):
                merged_seeds[index] = (existing | mask, existing_source)
                break
        else:
            merged_seeds.append((mask, source))
    if not merged_seeds:
        return []
    merged_seeds.sort(key=lambda item: -int(np.count_nonzero(item[0])))
    floor = MIN_SEED_FRACTION * int(np.count_nonzero(merged_seeds[0][0]))
    merged_seeds = [item for item in merged_seeds if np.count_nonzero(item[0]) >= floor]
    return [SamSeed(mask=mask, source=source, box=_expanded_box(mask), point=_interior_point(mask))
            for mask, source in merged_seeds[:MAX_SEED_OBJECTS]]
