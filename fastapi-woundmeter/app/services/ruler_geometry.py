from __future__ import annotations

from dataclasses import dataclass
from itertools import product
from typing import List, Optional

import cv2
import numpy as np

from .apriltag_detector import DetectedMarker
from .errors import ProcessingFailure
from .ruler_template import RulerTemplate


@dataclass(frozen=True)
class GeometryResult:
    homography: np.ndarray
    inverse_homography: np.ndarray
    mean_error_mm: float
    maximum_error_mm: float
    per_tag_error_mm: dict[str, float]
    inlier_count: int
    warnings: list[str]


def _build_correspondences(
    detections: dict[int, DetectedMarker],
    template: RulerTemplate,
    corner_shifts: dict[int, int] | None = None,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    source: list[np.ndarray] = []
    destination: list[np.ndarray] = []
    labels: list[int] = []
    for marker_id in (0, 1, 10):
        marker = template.markers[marker_id]
        detected = detections[marker_id].corners_px
        # The template records which detector corner belongs to each physical corner.
        order = np.asarray(marker.detector_corner_order)
        shift = (corner_shifts or {}).get(marker_id, 0)
        ordered_source = detected[np.roll(order, -shift)]
        source.extend(ordered_source)
        destination.extend(template.mm_to_px(marker.corners_mm))
        labels.extend([marker_id] * 4)
    return (
        np.asarray(source, dtype=np.float32),
        np.asarray(destination, dtype=np.float32),
        np.asarray(labels, dtype=np.int32),
    )


def _select_corner_correspondences(
    detections: dict[int, DetectedMarker], template: RulerTemplate
) -> tuple[np.ndarray, np.ndarray, np.ndarray, dict[int, int]]:
    """Select the cyclic detector-corner orientation that best fits one ruler plane."""
    best: tuple[tuple[float, float], np.ndarray, np.ndarray, np.ndarray, dict[int, int]] | None = None
    for shifts in product(range(4), repeat=3):
        corner_shifts = dict(zip((0, 1, 10), shifts))
        source, destination, labels = _build_correspondences(detections, template, corner_shifts)
        candidate, _ = cv2.findHomography(source, destination, method=0)
        if candidate is None or not np.isfinite(candidate).all():
            continue
        if _local_handedness(candidate, np.mean(source, axis=0)) <= 0:
            continue
        projected = cv2.perspectiveTransform(source.reshape(1, -1, 2), candidate)[0]
        errors = np.linalg.norm(projected - destination, axis=1) / template.pixels_per_mm
        score = (float(np.max(errors)), float(np.mean(errors)))
        if best is None or score < best[0]:
            best = (score, source, destination, labels, corner_shifts)
    if best is None:
        raise ProcessingFailure("invalid_homography", "The AprilTag corner orientation could not be resolved.")
    return best[1], best[2], best[3], best[4]


def _local_handedness(homography: np.ndarray, point: np.ndarray) -> float:
    sample = np.asarray([point, point + [1.0, 0.0], point + [0.0, 1.0]], dtype=np.float32)
    mapped = cv2.perspectiveTransform(sample.reshape(1, -1, 2), homography)[0]
    dx = mapped[1] - mapped[0]
    dy = mapped[2] - mapped[0]
    return float(dx[0] * dy[1] - dx[1] * dy[0])


def estimate_ruler_geometry(
    detections: dict[int, DetectedMarker], template: RulerTemplate
) -> GeometryResult:
    source, destination, labels, corner_shifts = _select_corner_correspondences(detections, template)
    threshold_px = template.max_reprojection_error_mm * template.pixels_per_mm
    homography, inlier_mask = cv2.findHomography(
        source, destination, method=cv2.RANSAC, ransacReprojThreshold=threshold_px
    )
    if homography is None or inlier_mask is None or not np.isfinite(homography).all():
        raise ProcessingFailure("invalid_homography", "The ruler perspective could not be calibrated.")

    inliers = inlier_mask.reshape(-1).astype(bool)

    def errors_for(candidate: np.ndarray) -> np.ndarray:
        projected = cv2.perspectiveTransform(source.reshape(1, -1, 2), candidate)[0]
        return np.linalg.norm(projected - destination, axis=1) / template.pixels_per_mm

    errors_mm = errors_for(homography)
    all_ransac_inliers = bool(np.all(inliers))
    # RANSAC's binary inlier classification can reject a valid sub-pixel corner
    # near the threshold. Refit all 12 known correspondences and judge the final
    # geometry by its measured residual instead.
    if not all_ransac_inliers:
        all_corner_homography, _ = cv2.findHomography(source, destination, method=0)
        if all_corner_homography is not None and np.isfinite(all_corner_homography).all():
            all_corner_errors = errors_for(all_corner_homography)
            if float(np.max(all_corner_errors)) < float(np.max(errors_mm)):
                homography = all_corner_homography
                errors_mm = all_corner_errors

    per_tag = {
        str(marker_id): float(np.max(errors_mm[labels == marker_id]))
        for marker_id in (0, 1, 10)
    }
    maximum_error_mm = float(np.max(errors_mm))
    allowed_error_mm = template.max_reprojection_error_mm + template.manufacturing_tolerance_mm
    if maximum_error_mm > allowed_error_mm:
        worst_tag = max(per_tag, key=per_tag.get)
        raise ProcessingFailure(
            "invalid_ruler_geometry",
            (
                f"AprilTag {worst_tag} corners differ from the ruler template by "
                f"{per_tag[worst_tag]:.2f} mm (allowed {allowed_error_mm:.2f} mm)."
            ),
        )
    # All 12 correspondences have now been checked directly against the final
    # residual threshold. RANSAC's preliminary binary mask is no longer the
    # authority for a corner that the refined homography places within tolerance.
    inliers = np.ones(len(source), dtype=bool)
    warnings: list[str] = []
    normalized_ids = [str(marker_id) for marker_id, shift in corner_shifts.items() if shift]
    if normalized_ids:
        warnings.append(
            f"AprilTag corner orientation was normalized for IDs: {', '.join(normalized_ids)}."
        )
    if maximum_error_mm > template.max_reprojection_error_mm:
        warnings.append(
            "Ruler geometry used the configured manufacturing tolerance; review marker alignment."
        )
    if _local_handedness(homography, np.mean(source, axis=0)) <= 0:
        raise ProcessingFailure("invalid_ruler_geometry", "The calibrated ruler geometry is mirrored.")

    try:
        inverse = np.linalg.inv(homography)
    except np.linalg.LinAlgError as exc:
        raise ProcessingFailure("invalid_homography", "The ruler calibration is singular.") from exc
    return GeometryResult(
        homography=homography,
        inverse_homography=inverse,
        mean_error_mm=float(np.mean(errors_mm)),
        maximum_error_mm=maximum_error_mm,
        per_tag_error_mm=per_tag,
        inlier_count=int(np.count_nonzero(inliers)),
        warnings=warnings,
    )


def verify_crop_available(
    geometry: GeometryResult, template: RulerTemplate, image_width: int, image_height: int
) -> Optional[List[List[float]]]:
    """Check how much of the ruler's square is in the photo.

    Returns None when the whole square is in the photo. When part of it is outside, returns the photo's
    edges in canonical pixels: the measurement continues and is refused later only if the wound reaches
    the missing part (measurement_contract.reaches_outside_photo). Refused here only when less than half
    of the measurement window is in the photo.
    """
    from .measurement_contract import MIN_INNER_COVERAGE, coverage_mask, photo_coverage_polygon

    crop_px = template.mm_to_px(template.crop_mm)
    source_crop = cv2.perspectiveTransform(
        crop_px.reshape(1, -1, 2), geometry.inverse_homography
    )[0]
    margin = template.source_safety_margin_px
    if not (
        np.any(source_crop[:, 0] < margin)
        or np.any(source_crop[:, 1] < margin)
        or np.any(source_crop[:, 0] > image_width - 1 - margin)
        or np.any(source_crop[:, 1] > image_height - 1 - margin)
    ):
        return None
    polygon = photo_coverage_polygon(geometry.homography, image_width, image_height, margin)
    left, top, right, bottom = template.inner_bounds_px()
    covered = coverage_mask(polygon, template.width_px, template.height_px)[top:bottom, left:right]
    if float(covered.mean()) < MIN_INNER_COVERAGE:
        raise ProcessingFailure(
            "canonical_crop_outside_image",
            "Less than half of the ruler's measurement area is in the photo. Move farther away and retake.",
        )
    return polygon
