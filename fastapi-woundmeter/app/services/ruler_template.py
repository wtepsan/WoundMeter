from __future__ import annotations

import hashlib
from dataclasses import dataclass, replace
from pathlib import Path

import numpy as np
import yaml

from .errors import TemplateConfigurationError


EXPECTED_IDS = {0, 1, 10}


@dataclass(frozen=True)
class MarkerTemplate:
    marker_id: int
    name: str
    pattern_size_mm: float
    quiet_zone_mm: float
    detector_corner_order: tuple[int, int, int, int]
    corners_mm: np.ndarray


@dataclass(frozen=True)
class RulerTemplate:
    template_id: str
    version: str
    checksum: str
    pixels_per_mm: float
    x_min_mm: float
    x_max_mm: float
    y_min_mm: float
    y_max_mm: float
    markers: dict[int, MarkerTemplate]
    crop_mm: np.ndarray
    inner_region_mm: tuple[float, float, float, float]
    colour_patches: list[dict]
    max_reprojection_error_mm: float
    source_safety_margin_px: float
    quiet_zone_min_mean_luma: float = 0.0
    quiet_zone_max_dark_fraction: float = 1.0
    manufacturing_tolerance_mm: float = 0.0
    validated: bool = False

    @property
    def width_px(self) -> int:
        return round((self.x_max_mm - self.x_min_mm) * self.pixels_per_mm)

    @property
    def height_px(self) -> int:
        return round((self.y_max_mm - self.y_min_mm) * self.pixels_per_mm)

    def mm_to_px(self, points_mm: np.ndarray) -> np.ndarray:
        points = np.asarray(points_mm, dtype=np.float32)
        return np.column_stack(
            (
                self.pixels_per_mm * (points[:, 0] - self.x_min_mm),
                self.pixels_per_mm * (self.y_max_mm - points[:, 1]),
            )
        ).astype(np.float32)

    def inner_bounds_px(self) -> tuple[int, int, int, int]:
        x_min, x_max, y_min, y_max = self.inner_region_mm
        left = round((x_min - self.x_min_mm) * self.pixels_per_mm)
        right = round((x_max - self.x_min_mm) * self.pixels_per_mm)
        top = round((self.y_max_mm - y_max) * self.pixels_per_mm)
        bottom = round((self.y_max_mm - y_min) * self.pixels_per_mm)
        if not (0 <= left < right <= self.width_px and 0 <= top < bottom <= self.height_px):
            raise TemplateConfigurationError("Inner measurement region is outside canonical bounds.")
        return left, top, right, bottom

    def for_complete_ruler_length_cm(self, length_cm: int) -> "RulerTemplate":
        if length_cm in EXPECTED_IDS or not 6 <= length_cm <= 30:
            raise TemplateConfigurationError(
                "The fourth marker ID must encode a complete ruler size between 6 and 30 cm."
            )
        complete_ruler_length_mm = float(length_cm * 10)
        marker = self.markers[0]
        complete_marker_size_mm = marker.pattern_size_mm + 2.0 * marker.quiet_zone_mm
        centre_span_mm = complete_ruler_length_mm - complete_marker_size_mm
        if centre_span_mm <= marker.pattern_size_mm:
            raise TemplateConfigurationError("Encoded ruler length is too short for the marker geometry.")

        marker_1 = replace(
            self.markers[1],
            corners_mm=np.asarray(
                [[10, centre_span_mm - 10], [-10, centre_span_mm - 10],
                 [-10, centre_span_mm + 10], [10, centre_span_mm + 10]],
                dtype=np.float32,
            ),
        )
        marker_10 = replace(
            self.markers[10],
            corners_mm=np.asarray(
                [[centre_span_mm + 10, -10], [centre_span_mm - 10, -10],
                 [centre_span_mm - 10, 10], [centre_span_mm + 10, 10]],
                dtype=np.float32,
            ),
        )
        outer_half_mm = marker.pattern_size_mm / 2.0 + marker.quiet_zone_mm
        x_min = -outer_half_mm
        y_min = -outer_half_mm
        x_max = centre_span_mm + outer_half_mm
        y_max = centre_span_mm + outer_half_mm
        dynamic_checksum = hashlib.sha256(
            f"{self.checksum}:complete-ruler-length-cm:{length_cm}".encode("utf-8")
        ).hexdigest()
        dynamic = replace(
            self,
            version=f"{self.version}-id{length_cm}-{length_cm}cm-complete",
            checksum=dynamic_checksum,
            x_min_mm=x_min,
            x_max_mm=x_max,
            y_min_mm=y_min,
            y_max_mm=y_max,
            markers={0: self.markers[0], 1: marker_1, 10: marker_10},
            crop_mm=np.asarray(
                [[x_min, y_min], [x_min, y_max], [x_max, y_max], [x_max, y_min]],
                dtype=np.float32,
            ),
            inner_region_mm=(outer_half_mm, x_max, outer_half_mm, y_max),
        )
        dynamic.inner_bounds_px()
        return dynamic

def _number(value: object, label: str) -> float:
    if value is None or isinstance(value, bool):
        raise TemplateConfigurationError(f"Missing measured template value: {label}.")
    try:
        number = float(value)
    except (TypeError, ValueError) as exc:
        raise TemplateConfigurationError(f"Invalid template number: {label}.") from exc
    if not np.isfinite(number):
        raise TemplateConfigurationError(f"Invalid template number: {label}.")
    return number


def _point(value: object, label: str) -> list[float]:
    if not isinstance(value, list) or len(value) != 2:
        raise TemplateConfigurationError(f"{label} must contain two measured coordinates.")
    return [_number(value[0], f"{label}.x"), _number(value[1], f"{label}.y")]


def load_ruler_template(path: Path) -> RulerTemplate:
    raw_bytes = path.read_bytes()
    data = yaml.safe_load(raw_bytes)
    if not isinstance(data, dict) or data.get("configured") is not True:
        raise TemplateConfigurationError(
            "The manufactured ruler template is not configured. Replace every null measurement and set configured: true."
        )

    canonical = data.get("canonical") or {}
    x_min = _number(canonical.get("x_min_mm"), "canonical.x_min_mm")
    x_max = _number(canonical.get("x_max_mm"), "canonical.x_max_mm")
    y_min = _number(canonical.get("y_min_mm"), "canonical.y_min_mm")
    y_max = _number(canonical.get("y_max_mm"), "canonical.y_max_mm")
    ppm = _number(canonical.get("pixels_per_mm"), "canonical.pixels_per_mm")
    if x_max <= x_min or y_max <= y_min or ppm <= 0:
        raise TemplateConfigurationError("Canonical bounds and pixels_per_mm must be positive.")

    marker_data = data.get("markers") or {}
    marker_ids = {int(key) for key in marker_data}
    if marker_ids != EXPECTED_IDS:
        raise TemplateConfigurationError("Template must define exactly AprilTag IDs 0, 1, and 10.")

    markers: dict[int, MarkerTemplate] = {}
    for marker_id in sorted(EXPECTED_IDS):
        item = marker_data.get(marker_id, marker_data.get(str(marker_id))) or {}
        corners = item.get("corners_mm") or {}
        points = np.asarray(
            [_point(corners.get(f"corner_{index}"), f"markers.{marker_id}.corner_{index}") for index in range(4)],
            dtype=np.float32,
        )
        order = item.get("detector_corner_order")
        if not isinstance(order, list) or sorted(order) != [0, 1, 2, 3]:
            raise TemplateConfigurationError(
                f"markers.{marker_id}.detector_corner_order must be a permutation of 0,1,2,3."
            )
        markers[marker_id] = MarkerTemplate(
            marker_id=marker_id,
            name=str(item.get("name") or marker_id),
            pattern_size_mm=_number(item.get("pattern_size_mm"), f"markers.{marker_id}.pattern_size_mm"),
            quiet_zone_mm=_number(item.get("quiet_zone_mm"), f"markers.{marker_id}.quiet_zone_mm"),
            detector_corner_order=tuple(int(value) for value in order),
            corners_mm=points,
        )

    crop_data = data.get("crop") or {}
    crop = np.asarray(
        [
            _point(crop_data.get("bottom_left_mm"), "crop.bottom_left_mm"),
            _point(crop_data.get("top_left_mm"), "crop.top_left_mm"),
            _point(crop_data.get("top_right_mm"), "crop.top_right_mm"),
            _point(crop_data.get("bottom_right_mm"), "crop.bottom_right_mm"),
        ],
        dtype=np.float32,
    )
    expected_crop = np.asarray(
        [[x_min, y_min], [x_min, y_max], [x_max, y_max], [x_max, y_min]], dtype=np.float32
    )
    if not np.allclose(crop, expected_crop, atol=1e-6):
        raise TemplateConfigurationError(
            "Canonical bounds must exactly match the template crop vertices."
        )
    inner = data.get("inner_measurement_region") or {}
    validation = data.get("validation") or {}
    colour_patches_raw = data.get("colour_patches")
    if not isinstance(colour_patches_raw, list) or not colour_patches_raw:
        raise TemplateConfigurationError("At least one measured colour-patch rectangle is required.")
    colour_patches: list[dict] = []
    for index, patch in enumerate(colour_patches_raw):
        if not isinstance(patch, dict) or not patch.get("name"):
            raise TemplateConfigurationError(f"colour_patches.{index} requires a name.")
        rectangle = patch.get("rectangle_mm")
        if not isinstance(rectangle, list) or len(rectangle) != 4:
            raise TemplateConfigurationError(f"colour_patches.{index}.rectangle_mm requires four values.")
        x1, y1, x2, y2 = [
            _number(value, f"colour_patches.{index}.rectangle_mm") for value in rectangle
        ]
        if not (x_min <= x1 < x2 <= x_max and y_min <= y1 < y2 <= y_max):
            raise TemplateConfigurationError(f"colour_patches.{index} is outside canonical bounds.")
        colour_patches.append({"name": str(patch["name"]), "rectangle_mm": [x1, y1, x2, y2]})

    template = RulerTemplate(
        template_id=str(data.get("template_id") or ""),
        version=str(data.get("version") or ""),
        checksum=hashlib.sha256(raw_bytes).hexdigest(),
        pixels_per_mm=ppm,
        x_min_mm=x_min,
        x_max_mm=x_max,
        y_min_mm=y_min,
        y_max_mm=y_max,
        markers=markers,
        crop_mm=crop,
        inner_region_mm=(
            _number(inner.get("x_min_mm"), "inner_measurement_region.x_min_mm"),
            _number(inner.get("x_max_mm"), "inner_measurement_region.x_max_mm"),
            _number(inner.get("y_min_mm"), "inner_measurement_region.y_min_mm"),
            _number(inner.get("y_max_mm"), "inner_measurement_region.y_max_mm"),
        ),
        colour_patches=colour_patches,
        max_reprojection_error_mm=_number(
            validation.get("max_reprojection_error_mm"), "validation.max_reprojection_error_mm"
        ),
        source_safety_margin_px=_number(
            validation.get("source_safety_margin_px"), "validation.source_safety_margin_px"
        ),
        quiet_zone_min_mean_luma=_number(
            validation.get("quiet_zone_min_mean_luma"), "validation.quiet_zone_min_mean_luma"
        ),
        quiet_zone_max_dark_fraction=_number(
            validation.get("quiet_zone_max_dark_fraction"), "validation.quiet_zone_max_dark_fraction"
        ),
        manufacturing_tolerance_mm=_number(
            (data.get("manufacturing") or {}).get("tolerance_mm"), "manufacturing.tolerance_mm"
        ),
        validated=data.get("validated") is True,
    )
    if not template.template_id or not template.version:
        raise TemplateConfigurationError("Template ID and version are required.")
    if not (0 <= template.quiet_zone_min_mean_luma <= 255):
        raise TemplateConfigurationError("quiet_zone_min_mean_luma must be between 0 and 255.")
    if not (0 <= template.quiet_zone_max_dark_fraction <= 1):
        raise TemplateConfigurationError("quiet_zone_max_dark_fraction must be between 0 and 1.")
    if template.manufacturing_tolerance_mm <= 0:
        raise TemplateConfigurationError("Manufacturing tolerance must be positive.")
    if template.max_reprojection_error_mm <= 0 or template.source_safety_margin_px < 0:
        raise TemplateConfigurationError("Geometry validation thresholds are invalid.")
    for marker in template.markers.values():
        side_lengths = np.linalg.norm(marker.corners_mm - np.roll(marker.corners_mm, -1, axis=0), axis=1)
        if not np.allclose(
            side_lengths,
            marker.pattern_size_mm,
            atol=template.manufacturing_tolerance_mm,
            rtol=0,
        ):
            raise TemplateConfigurationError(
                f"AprilTag {marker.marker_id} corner geometry does not match pattern_size_mm."
            )
        lower = np.min(marker.corners_mm, axis=0) - marker.quiet_zone_mm
        upper = np.max(marker.corners_mm, axis=0) + marker.quiet_zone_mm
        if lower[0] < x_min or lower[1] < y_min or upper[0] > x_max or upper[1] > y_max:
            raise TemplateConfigurationError(
                f"AprilTag {marker.marker_id} quiet-zone footprint is outside canonical bounds."
            )
    template.inner_bounds_px()
    return template
