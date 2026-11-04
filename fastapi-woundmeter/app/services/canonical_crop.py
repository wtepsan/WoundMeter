from __future__ import annotations

from dataclasses import dataclass

import cv2
import numpy as np

from .ruler_geometry import GeometryResult
from .ruler_template import RulerTemplate


@dataclass(frozen=True)
class CanonicalCrop:
    image_bgr: np.ndarray
    inner_bgr: np.ndarray
    inner_bounds: tuple[int, int, int, int]


def create_canonical_crop(
    image_bgr: np.ndarray, geometry: GeometryResult, template: RulerTemplate
) -> CanonicalCrop:
    canonical = cv2.warpPerspective(
        image_bgr,
        geometry.homography,
        dsize=(template.width_px, template.height_px),
        flags=cv2.INTER_LINEAR,
        borderMode=cv2.BORDER_CONSTANT,
    )
    left, top, right, bottom = template.inner_bounds_px()
    return CanonicalCrop(
        image_bgr=canonical,
        inner_bgr=canonical[top:bottom, left:right].copy(),
        inner_bounds=(left, top, right, bottom),
    )
