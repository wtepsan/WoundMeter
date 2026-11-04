from __future__ import annotations

from dataclasses import dataclass

import cv2
import numpy as np

from .errors import ProcessingFailure


EXPECTED_IDS = {0, 1, 10}


@dataclass(frozen=True)
class DetectedMarker:
    marker_id: int
    corners_px: np.ndarray

    @property
    def center_px(self) -> np.ndarray:
        return np.mean(self.corners_px, axis=0)


def _aruco_detector():
    if not hasattr(cv2, "aruco"):
        raise ProcessingFailure(
            "backend_not_ready",
            "AprilTag support is unavailable on the measurement service.",
            status_code=503,
        )
    dictionary = cv2.aruco.getPredefinedDictionary(cv2.aruco.DICT_APRILTAG_36h11)
    parameters = cv2.aruco.DetectorParameters()
    parameters.cornerRefinementMethod = cv2.aruco.CORNER_REFINE_SUBPIX
    return cv2.aruco.ArucoDetector(dictionary, parameters)


def detect_all_markers(image_bgr: np.ndarray) -> dict[int, list[DetectedMarker]]:
    gray = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2GRAY)
    corners, ids, _rejected = _aruco_detector().detectMarkers(gray)
    if ids is None:
        raise ProcessingFailure("missing_marker", "Required AprilTags 0, 1, and 10 were not detected.")

    found: dict[int, list[DetectedMarker]] = {}
    for marker_corners, marker_id_raw in zip(corners, ids.flatten()):
        marker_id = int(marker_id_raw)
        found.setdefault(marker_id, []).append(
            DetectedMarker(
                marker_id=marker_id,
                corners_px=np.asarray(marker_corners[0], dtype=np.float32),
            )
        )
    return found


def detect_required_markers(image_bgr: np.ndarray) -> dict[int, DetectedMarker]:
    found = detect_all_markers(image_bgr)

    missing = sorted(EXPECTED_IDS - set(found))
    if missing:
        raise ProcessingFailure(
            "missing_marker", f"Missing required AprilTag IDs: {', '.join(map(str, missing))}."
        )
    duplicate = sorted(marker_id for marker_id, values in found.items() if len(values) != 1)
    if duplicate:
        raise ProcessingFailure(
            "duplicate_marker", f"Duplicate required AprilTag IDs: {', '.join(map(str, duplicate))}."
        )

    return {marker_id: found[marker_id][0] for marker_id in EXPECTED_IDS}


def detect_ruler_markers(
    image_bgr: np.ndarray,
    supported_length_ids: set[int],
) -> tuple[dict[int, DetectedMarker], DetectedMarker]:
    found = detect_all_markers(image_bgr)
    missing = sorted(EXPECTED_IDS - set(found))
    if missing:
        raise ProcessingFailure(
            "missing_marker", f"Missing required AprilTag IDs: {', '.join(map(str, missing))}."
        )
    duplicate = sorted(marker_id for marker_id in EXPECTED_IDS if len(found[marker_id]) != 1)
    if duplicate:
        raise ProcessingFailure(
            "duplicate_marker", f"Duplicate required AprilTag IDs: {', '.join(map(str, duplicate))}."
        )
    required = {marker_id: found[marker_id][0] for marker_id in EXPECTED_IDS}

    start = required[0].center_px
    end = required[10].center_px
    baseline = end - start
    baseline_length_sq = float(baseline @ baseline)
    if baseline_length_sq <= 1.0:
        raise ProcessingFailure("invalid_ruler_geometry", "The horizontal ruler baseline is degenerate.")
    baseline_length = float(np.sqrt(baseline_length_sq))

    candidates: list[DetectedMarker] = []
    for marker_id, detections in found.items():
        if marker_id in EXPECTED_IDS:
            continue
        for detection in detections:
            offset = detection.center_px - start
            position = float(offset @ baseline / baseline_length_sq)
            perpendicular = abs(float(baseline[0] * offset[1] - baseline[1] * offset[0])) / baseline_length
            if 0.15 <= position <= 0.85 and perpendicular <= 0.25 * baseline_length:
                candidates.append(detection)

    if not candidates:
        raise ProcessingFailure(
            "missing_length_marker",
            "The ruler-length AprilTag between IDs 0 and 10 was not detected.",
        )
    if len(candidates) != 1:
        raise ProcessingFailure(
            "ambiguous_length_marker",
            "More than one possible ruler-length AprilTag was detected between IDs 0 and 10.",
        )
    length_marker = candidates[0]
    if length_marker.marker_id not in supported_length_ids:
        raise ProcessingFailure(
            "unsupported_length_marker",
            f"Length marker ID {length_marker.marker_id} is not configured for a physical ruler length.",
        )
    return required, length_marker
