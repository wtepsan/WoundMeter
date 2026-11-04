from __future__ import annotations

import base64
from typing import List, Optional, Tuple

import cv2
import numpy as np

from app.schemas.response import MeasurementsResponse, ModelComparisonResponse


def calculate_dice_and_iou(mask_a: np.ndarray, mask_b: np.ndarray) -> Tuple[float, float]:
    """Calculate Dice similarity coefficient and Intersection-over-Union between two binary masks."""
    bin_a = (mask_a > 0).astype(np.uint8)
    bin_b = (mask_b > 0).astype(np.uint8)
    if bin_a.shape != bin_b.shape:
        bin_b = cv2.resize(
            bin_b, (bin_a.shape[1], bin_a.shape[0]), interpolation=cv2.INTER_NEAREST
        )
    intersection = float(np.count_nonzero(bin_a & bin_b))
    sum_a = float(np.count_nonzero(bin_a))
    sum_b = float(np.count_nonzero(bin_b))
    union = float(np.count_nonzero(bin_a | bin_b))

    if sum_a + sum_b == 0:
        return 1.0, 1.0
    dice = (2.0 * intersection) / (sum_a + sum_b)
    iou = intersection / union if union > 0 else 0.0
    return round(dice, 4), round(iou, 4)


def compare_models(
    yolo_mask: Optional[np.ndarray],
    yolo_meas: Optional[MeasurementsResponse],
    yolo_latency_ms: Optional[float],
    sam_mask: Optional[np.ndarray],
    sam_meas: Optional[MeasurementsResponse],
    sam_latency_ms: Optional[float],
    *,
    sam_model_name: str = "Meta SAM 3.1 (sam-3.1)",
    sam_error: Optional[str] = None,
) -> ModelComparisonResponse:
    """Compare YOLO and Meta SAM 3.1 masks and physical measurements deterministically."""
    if yolo_mask is None or sam_mask is None or yolo_meas is None or sam_meas is None:
        return ModelComparisonResponse(
            status="unavailable" if sam_mask is None and yolo_mask is None else "partial",
            secondary_model=sam_model_name,
            yolo_latency_ms=round(yolo_latency_ms, 2) if yolo_latency_ms is not None else None,
            sam_latency_ms=round(sam_latency_ms, 2) if sam_latency_ms is not None else None,
            agreement_level="not_applicable",
            disagreement_warning=(
                sam_error
                or "Comparison requires both YOLO and Meta SAM 3.1 masks to be present."
            ),
        )

    dice, iou = calculate_dice_and_iou(yolo_mask, sam_mask)
    area_diff = abs(yolo_meas.area_cm2 - sam_meas.area_cm2)
    mean_area = max(0.001, (yolo_meas.area_cm2 + sam_meas.area_cm2) / 2.0)
    area_diff_pct = (area_diff / mean_area) * 100.0

    y_perim = yolo_meas.perimeter_cm or 0.0
    s_perim = sam_meas.perimeter_cm or 0.0
    perim_diff = abs(y_perim - s_perim)
    length_diff = abs(yolo_meas.length_cm - sam_meas.length_cm)
    width_diff = abs(yolo_meas.width_cm - sam_meas.width_cm)

    if dice >= 0.85 and area_diff_pct <= 15.0:
        agreement = "high"
        warning = None
    elif dice >= 0.70 and area_diff_pct <= 25.0:
        agreement = "moderate"
        warning = (
            f"Moderate boundary variation between YOLO and SAM 3.1 (Dice {dice:.2f}, "
            f"area difference {area_diff:.2f} cm² / {area_diff_pct:.1f}%). Inspect the wound margin carefully."
        )
    else:
        agreement = "low_disagreement_warning"
        warning = (
            f"Substantial disagreement between YOLO and Meta SAM 3.1 (Dice {dice:.2f}, IoU {iou:.2f}, "
            f"area difference {area_diff:.2f} cm² / {area_diff_pct:.1f}%). Mandatory human boundary "
            "review or manual boundary correction is strongly advised before accepting measurements."
        )

    return ModelComparisonResponse(
        status="completed",
        secondary_model=sam_model_name,
        dice_coefficient=dice,
        iou=iou,
        area_diff_cm2=round(area_diff, 4),
        area_diff_pct=round(area_diff_pct, 2),
        perimeter_diff_cm=round(perim_diff, 4),
        length_diff_cm=round(length_diff, 4),
        width_diff_cm=round(width_diff, 4),
        yolo_latency_ms=round(yolo_latency_ms, 2) if yolo_latency_ms is not None else None,
        sam_latency_ms=round(sam_latency_ms, 2) if sam_latency_ms is not None else None,
        agreement_level=agreement,
        disagreement_warning=warning,
    )


def decode_mask_png_base64(mask_b64: str, expected_width: int, expected_height: int) -> np.ndarray:
    """Decode a base64 PNG mask into a binary (H, W) uint8 array."""
    raw_bytes = base64.b64decode(mask_b64, validate=True)
    arr = np.frombuffer(raw_bytes, dtype=np.uint8)
    decoded = cv2.imdecode(arr, cv2.IMREAD_UNCHANGED)
    if decoded is None:
        raise ValueError("Could not decode base64 PNG mask.")
    if decoded.ndim == 3:
        if decoded.shape[2] == 4:
            # Check if alpha channel or RGB channel holds the mask
            rgb_max = np.max(decoded[:, :, :3], axis=2)
            gray = np.maximum(rgb_max, decoded[:, :, 3]) if np.min(decoded[:, :, 3]) < 255 else rgb_max
        else:
            gray = np.max(decoded[:, :, :3], axis=2)
    else:
        gray = decoded
    if gray.shape != (expected_height, expected_width):
        gray = cv2.resize(
            gray, (expected_width, expected_height), interpolation=cv2.INTER_NEAREST
        )
    return (gray >= 128).astype(np.uint8)


def rasterize_polygon_boundary(
    boundary_px: List[List[float | int]],
    canonical_width: int,
    canonical_height: int,
    inner_bounds: Optional[Tuple[int, int, int, int]] = None,
) -> np.ndarray:
    """Rasterize a polygon boundary into a binary canonical mask clipped to the inner ruler window."""
    mask = np.zeros((canonical_height, canonical_width), dtype=np.uint8)
    if len(boundary_px) < 3:
        return mask
    pts = np.asarray([[round(p[0]), round(p[1])] for p in boundary_px], dtype=np.int32)
    cv2.fillPoly(mask, [pts.reshape(-1, 1, 2)], 1)
    if inner_bounds is not None:
        left, top, right, bottom = inner_bounds
        clipped = np.zeros_like(mask)
        clipped[top:bottom, left:right] = mask[top:bottom, left:right]
        return clipped
    return mask
