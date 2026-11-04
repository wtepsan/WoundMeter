from __future__ import annotations

import cv2
import numpy as np

from .errors import ProcessingFailure
from .ruler_template import RulerTemplate


def validate_marker_quiet_zones(canonical_bgr: np.ndarray, template: RulerTemplate) -> list[str]:
    gray = cv2.cvtColor(canonical_bgr, cv2.COLOR_BGR2GRAY)
    warnings: list[str] = []
    for marker_id, marker in template.markers.items():
        x_min, y_min = np.min(marker.corners_mm, axis=0)
        x_max, y_max = np.max(marker.corners_mm, axis=0)
        quiet = marker.quiet_zone_mm
        outer_mm = np.asarray(
            [[x_min - quiet, y_min - quiet], [x_max + quiet, y_min - quiet],
             [x_max + quiet, y_max + quiet], [x_min - quiet, y_max + quiet]],
            dtype=np.float32,
        )
        outer_px = np.rint(template.mm_to_px(outer_mm)).astype(np.int32)
        inner_px = np.rint(template.mm_to_px(marker.corners_mm)).astype(np.int32)
        band_mask = np.zeros(gray.shape, dtype=np.uint8)
        cv2.fillConvexPoly(band_mask, outer_px, 1)
        cv2.fillConvexPoly(band_mask, inner_px, 0)
        values = gray[band_mask > 0]
        if values.size == 0:
            raise ProcessingFailure("clipped_marker", f"AprilTag {marker_id} quiet zone is outside the ruler crop.")
        mean_luma = float(np.mean(values))
        dark_fraction = float(np.mean(values < template.quiet_zone_min_mean_luma))
        if (
            mean_luma < template.quiet_zone_min_mean_luma
            or dark_fraction > template.quiet_zone_max_dark_fraction
        ):
            warnings.append(
                f"AprilTag {marker_id} quiet zone has low contrast; geometry remained valid."
            )
    return warnings
