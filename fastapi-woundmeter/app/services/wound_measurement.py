from __future__ import annotations

from dataclasses import dataclass, field

import cv2
import numpy as np

from .mask_mapping import connected_components


@dataclass(frozen=True)
class WoundMeasurements:
    area_cm2: float
    # Ruler-axis definitions (preserved for backward compatibility)
    length_cm: float
    width_cm: float
    perimeter_cm: float
    length_line_px: list[list[float]]
    width_line_px: list[list[float]]
    # Clinically oriented definitions (longest Feret major axis & perpendicular span)
    clinical_length_cm: float = 0.0
    clinical_width_cm: float = 0.0
    clinical_length_line_px: list[list[float]] = field(default_factory=list)
    clinical_width_line_px: list[list[float]] = field(default_factory=list)


def _longest_run(values: np.ndarray) -> tuple[int, int, int]:
    """Return the length and half-open bounds of the longest foreground run."""
    padded = np.pad(values.astype(np.int8), (1, 1))
    transitions = np.diff(padded)
    starts = np.flatnonzero(transitions == 1)
    ends = np.flatnonzero(transitions == -1)
    if not len(starts):
        return 0, 0, 0
    lengths = ends - starts
    best = int(np.argmax(lengths))
    return int(lengths[best]), int(starts[best]), int(ends[best])


def _maximum_axis_chords(
    binary: np.ndarray,
) -> tuple[float, np.ndarray, np.ndarray, float, np.ndarray, np.ndarray]:
    """Find continuous vertical and horizontal chords in rectified ruler coordinates."""
    best_vertical = (0, 0, 0, 0)
    for x in range(binary.shape[1]):
        length, start, end = _longest_run(binary[:, x])
        if length > best_vertical[0]:
            best_vertical = (length, x, start, end)

    best_horizontal = (0, 0, 0, 0)
    for y in range(binary.shape[0]):
        length, start, end = _longest_run(binary[y, :])
        if length > best_horizontal[0]:
            best_horizontal = (length, y, start, end)

    vertical_length, vertical_x, vertical_start, vertical_end = best_vertical
    horizontal_length, horizontal_y, horizontal_start, horizontal_end = best_horizontal
    vertical_line_start = np.asarray([vertical_x + 0.5, vertical_start], dtype=np.float32)
    vertical_line_end = np.asarray([vertical_x + 0.5, vertical_end], dtype=np.float32)
    horizontal_line_start = np.asarray([horizontal_start, horizontal_y + 0.5], dtype=np.float32)
    horizontal_line_end = np.asarray([horizontal_end, horizontal_y + 0.5], dtype=np.float32)
    return (
        float(vertical_length),
        vertical_line_start,
        vertical_line_end,
        float(horizontal_length),
        horizontal_line_start,
        horizontal_line_end,
    )


def _clinical_major_and_perpendicular_axes(
    contour: np.ndarray,
) -> tuple[float, list[list[float]], float, list[list[float]]]:
    """
    Compute clinically oriented longest wound length (maximum Feret diameter across
    convex hull vertices) and maximum perpendicular width in canonical pixel coordinates.
    """
    pts = contour.reshape(-1, 2).astype(np.float64)
    if len(pts) < 2:
        return 0.0, [], 0.0, []

    hull = cv2.convexHull(pts.astype(np.float32)).reshape(-1, 2).astype(np.float64)
    if len(hull) < 2:
        hull = pts

    # Pairwise distance across hull vertices for exact maximum Feret diameter
    diff = hull[:, None, :] - hull[None, :, :]
    dist_sq = np.sum(diff * diff, axis=2)
    flat_idx = int(np.argmax(dist_sq))
    i_max, j_max = divmod(flat_idx, len(hull))
    p_a = hull[i_max]
    p_b = hull[j_max]
    major_len_px = float(np.sqrt(dist_sq[i_max, j_max]))
    if major_len_px < 1e-6:
        return 0.0, [], 0.0, []

    # Unit vectors: u along major axis, v perpendicular to major axis
    u = (p_b - p_a) / major_len_px
    v = np.array([-u[1], u[0]], dtype=np.float64)

    # Project contour points onto perpendicular axis v
    rel = pts - p_a
    proj_v = rel @ v
    min_v_idx = int(np.argmin(proj_v))
    max_v_idx = int(np.argmax(proj_v))
    min_v = float(proj_v[min_v_idx])
    max_v = float(proj_v[max_v_idx])
    perp_width_px = max(0.0, max_v - min_v)

    # Place the perpendicular width visual line at the midpoint projection along u
    mid_u = 0.5 * (( pts[min_v_idx] - p_a ) @ u + ( pts[max_v_idx] - p_a ) @ u)
    base_pt = p_a + mid_u * u
    w_start = base_pt + min_v * v
    w_end = base_pt + max_v * v

    major_line = [[round(float(p_a[0]), 2), round(float(p_a[1]), 2)], [round(float(p_b[0]), 2), round(float(p_b[1]), 2)]]
    perp_line = [[round(float(w_start[0]), 2), round(float(w_start[1]), 2)], [round(float(w_end[0]), 2), round(float(w_end[1]), 2)]]
    return major_len_px, major_line, perp_width_px, perp_line


def calculate_measurements(mask: np.ndarray, pixels_per_mm: float) -> WoundMeasurements:
    if not np.isfinite(pixels_per_mm) or pixels_per_mm <= 0:
        raise ValueError("A positive finite calibration scale is required.")
    components = connected_components(mask)
    if len(components) != 1:
        raise ValueError("Select exactly one nonempty connected component before measuring.")
    binary = components[0]
    contours, _ = cv2.findContours(binary * 255, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    contour = max(contours, key=cv2.contourArea)
    length_px, length_start, length_end, width_px, width_start, width_end = _maximum_axis_chords(binary)
    clin_len_px, clin_len_line, clin_wid_px, clin_wid_line = _clinical_major_and_perpendicular_axes(contour)

    area_mm2 = float(np.count_nonzero(binary)) / (pixels_per_mm**2)
    perimeter_mm = float(cv2.arcLength(contour, True)) / pixels_per_mm
    return WoundMeasurements(
        area_cm2=area_mm2 / 100.0,
        length_cm=length_px / pixels_per_mm / 10.0,
        width_cm=width_px / pixels_per_mm / 10.0,
        perimeter_cm=perimeter_mm / 10.0,
        length_line_px=[length_start.astype(float).tolist(), length_end.astype(float).tolist()],
        width_line_px=[width_start.astype(float).tolist(), width_end.astype(float).tolist()],
        clinical_length_cm=clin_len_px / pixels_per_mm / 10.0,
        clinical_width_cm=clin_wid_px / pixels_per_mm / 10.0,
        clinical_length_line_px=clin_len_line,
        clinical_width_line_px=clin_wid_line,
    )
