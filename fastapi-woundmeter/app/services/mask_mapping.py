from __future__ import annotations

import base64

import cv2
import numpy as np


def map_inner_mask_to_canonical(
    inner_mask: np.ndarray,
    inner_bounds: tuple[int, int, int, int],
    canonical_width: int,
    canonical_height: int,
) -> np.ndarray:
    left, top, right, bottom = inner_bounds
    expected_width, expected_height = right - left, bottom - top
    if inner_mask.shape != (expected_height, expected_width):
        inner_mask = cv2.resize(
            inner_mask.astype(np.uint8),
            (expected_width, expected_height),
            interpolation=cv2.INTER_NEAREST,
        )
    canonical = np.zeros((canonical_height, canonical_width), dtype=np.uint8)
    canonical[top:bottom, left:right] = (inner_mask > 0).astype(np.uint8)
    return canonical


def contour_from_mask(mask: np.ndarray) -> list[list[int]]:
    contours, _ = cv2.findContours(
        (mask > 0).astype(np.uint8) * 255, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE
    )
    if not contours:
        return []
    contour = max(contours, key=cv2.contourArea)
    return [[int(x), int(y)] for x, y in contour.reshape(-1, 2)]


def encode_mask_png(mask: np.ndarray) -> str:
    ok, encoded = cv2.imencode(".png", (mask > 0).astype(np.uint8) * 255)
    if not ok:
        return ""
    return base64.b64encode(encoded.tobytes()).decode("ascii")


def connected_components(mask: np.ndarray) -> list[np.ndarray]:
    """Keep distinct regions separate; never aggregate their physical measurements."""
    count, labels = cv2.connectedComponents((mask > 0).astype(np.uint8), connectivity=8)
    return [(labels == label).astype(np.uint8) for label in range(1, count)]
