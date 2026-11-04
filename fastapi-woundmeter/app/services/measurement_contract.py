"""Canonical geometry and mask-dependent checks shared by capture and correction."""
from __future__ import annotations
import hashlib
import cv2
import numpy as np
from .mask_mapping import connected_components
from .model_comparison import rasterize_polygon_boundary


def mask_hash(mask: np.ndarray) -> str:
    binary = np.ascontiguousarray(mask > 0, dtype=np.uint8)
    return hashlib.sha256(str(binary.shape).encode() + binary.tobytes()).hexdigest()


def strict_polygon_mask(points, width: int, height: int, bounds) -> np.ndarray:
    if points is None:
        raise ValueError('An explicit boundary polygon is required; no automatic shape is substituted.')
    pts = np.asarray(points, dtype=np.float64)
    if pts.ndim != 2 or pts.shape[1] != 2 or not 3 <= len(pts) <= 2048 or not np.isfinite(pts).all():
        raise ValueError('Boundary must contain 3–2048 finite coordinate pairs.')
    if np.array_equal(pts[0], pts[-1]):
        pts = pts[:-1]
    pts = np.rint(pts)
    if len(pts) < 3 or len(np.unique(pts, axis=0)) != len(pts):
        raise ValueError('Boundary vertices must be distinct at the stored pixel resolution.')
    left, top, right, bottom = bounds
    if not (0 <= left < right <= width and 0 <= top < bottom <= height):
        raise ValueError('Stored geometry is invalid. Recapture this observation.')
    if ((pts[:, 0] < left) | (pts[:, 0] >= right) | (pts[:, 1] < top) | (pts[:, 1] >= bottom)).any():
        raise ValueError('Boundary must stay inside the stored ruler measurement window.')
    # Reject crossings/touching non-adjacent edges, including collinear overlap.
    def cross(a, b):
        return a[..., 0] * b[..., 1] - a[..., 1] * b[..., 0]
    ends = np.roll(pts, -1, axis=0)
    for i in range(len(pts)):
        js = np.arange(i + 2, len(pts))
        if i == 0:
            js = js[js != len(pts) - 1]
        a, b, c, d = pts[i], ends[i], pts[js], ends[js]
        bbox = (np.maximum(np.minimum(a, b), np.minimum(c, d)) <= np.minimum(np.maximum(a, b), np.maximum(c, d))).all(axis=1)
        hits = (cross(b-a, c-a) * cross(b-a, d-a) <= 0) & (cross(d-c, a-c) * cross(d-c, b-c) <= 0) & bbox
        if hits.any():
            raise ValueError('Boundary must be a simple polygon without crossing edges.')
    if cv2.contourArea(pts.astype(np.float32)) <= 0:
        raise ValueError('Boundary has no measurable area.')
    mask = rasterize_polygon_boundary(pts.tolist(), width, height, tuple(bounds))
    if len(connected_components(mask)) != 1:
        raise ValueError('Boundary must enclose one connected nonempty wound region.')
    return mask


def corrected_gate(previous, mask, bounds, image_quality_status):
    checks = dict(previous.get('checks', {}))
    # Retain capture/calibration warnings; re-evaluate mask-dependent checks.
    for key in ('boundary_within_window', 'measurement_completeness', 'component_selection', 'model_agreement'):
        checks.pop(key, None)
    left, top, right, bottom = bounds
    ys, xs = np.nonzero(mask)
    touches = bool(xs.min() <= left + 12 or xs.max() >= right - 13 or ys.min() <= top + 12 or ys.max() >= bottom - 13)
    checks.update(image_quality='PASS' if image_quality_status == 'valid' else 'REVIEW_REQUIRED',
                  boundary_within_window='REVIEW_REQUIRED' if touches else 'PASS', measurement_completeness='PASS',
                  component_selection='PASS', model_agreement='REVIEW_REQUIRED')
    reasons = ['Clinician changed the selected mask; model agreement has not been re-evaluated.']
    if touches:
        reasons.append('The wound boundary touches the measurement window edge.')
    if image_quality_status != 'valid':
        reasons.append('Image quality is not evaluated or requires review.')
    if checks.get('calibration_geometry') == 'REVIEW_REQUIRED':
        reasons.append('Calibration geometry requires review.')
    return {**previous, 'checks': checks, 'status': 'REVIEW_REQUIRED', 'review_reasons': reasons,
            'blocking_reasons': [], 'contour_touches_measurement_edge': touches}


# ---- Photo coverage: a ruler square that runs partly outside the photo -----------------------------------
# The rectified (canonical) image is the ruler's square. When part of that square lies outside the photo,
# those canonical pixels are blank. A measurement is accepted only if the wound boundary stays clear of the
# blank part, so no wound area is ever missing; dimensions are never guessed.

OUTSIDE_PHOTO_TOLERANCE_MM = 1.0
MIN_INNER_COVERAGE = 0.5
WOUND_OUTSIDE_PHOTO_MESSAGE = ("The wound reaches the part of the ruler's square that is outside the photo, so part of it "
                               "could be missing. Step back so the wound and the area around it are in the photo, and retake.")


def photo_coverage_polygon(homography, image_width: int, image_height: int, margin_px: float):
    """The photo's own edges (inset by `margin_px`) in canonical pixels."""
    m = float(margin_px)
    corners = np.array([[[m, m], [image_width - 1 - m, m], [image_width - 1 - m, image_height - 1 - m], [m, image_height - 1 - m]]], np.float64)
    return [[round(float(x), 2), round(float(y), 2)] for x, y in cv2.perspectiveTransform(corners, np.asarray(homography, np.float64))[0]]


def coverage_mask(polygon, width: int, height: int) -> np.ndarray:
    """1 where a canonical pixel comes from the photo, 0 where it lies outside it."""
    covered = np.zeros((height, width), np.uint8)
    cv2.fillPoly(covered, [np.rint(np.asarray(polygon, np.float64)).astype(np.int32)], 1)
    return covered


def reaches_outside_photo(mask, polygon, pixels_per_mm: float) -> bool:
    """True if the wound mask is within OUTSIDE_PHOTO_TOLERANCE_MM of canonical area that is outside the photo.

    `polygon` is None when the whole ruler square is in the photo (and for measurements made before this check)."""
    if polygon is None or mask is None:
        return False
    binary = (np.asarray(mask) > 0).astype(np.uint8)
    if not binary.any():
        return False
    missing = coverage_mask(polygon, binary.shape[1], binary.shape[0]) == 0
    if not missing.any():
        return False
    radius = max(1, int(round(OUTSIDE_PHOTO_TOLERANCE_MM * float(pixels_per_mm))))
    grown = cv2.dilate(binary, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * radius + 1, 2 * radius + 1)))
    return bool((grown.astype(bool) & missing).any())
