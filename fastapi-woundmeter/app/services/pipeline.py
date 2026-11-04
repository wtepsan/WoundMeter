from __future__ import annotations

import base64
from dataclasses import replace
from datetime import datetime, timezone
from typing import Any, Dict, List, Literal, Optional, Tuple
from uuid import uuid4

import cv2
import numpy as np

from app.config import Settings
from app.schemas.response import (
    CanonicalImageResponse,
    GeometryResponse,
    ImageQualityResponse,
    MeasurementsResponse,
    ProvenanceMetadata,
    QualityGateResponse,
    RulerResponse,
    SegmentationCandidateResponse,
    SegmentationMode,
    SegmentationResponse,
    WoundMeasureResponse,
)

from .apriltag_detector import DetectedMarker, detect_ruler_markers
from .canonical_crop import create_canonical_crop
from .colour_calibration import ColourProfile, calibrate_colour, load_colour_profile
from .errors import ProcessingFailure
from .image_decoder import DecodedImage, decode_image
from .mask_mapping import connected_components, contour_from_mask, encode_mask_png, map_inner_mask_to_canonical
from .meta_client import DEFAULT_SAM_CONCEPT, MetaApiError, MetaModelClient
from .model_comparison import compare_models
from .quiet_zone import validate_marker_quiet_zones
from .retake_guidance import guidance_for_failure
from .measurement_contract import WOUND_OUTSIDE_PHOTO_MESSAGE, reaches_outside_photo
from .ruler_geometry import estimate_ruler_geometry, verify_crop_available
from .ruler_template import RulerTemplate
from .sam_guidance import clean_boundary_mask, guidance_seeds, mask_dice

# Concept prompts tried in order, only to locate the wound for the box + point pass. "red wound"
# is the only phrase that located the synthetic phantoms; as a boundary it omits non-red tissue.
SAM_LOCATOR_CONCEPTS = ("wound", "red wound")
# Below this Dice with the refined boundary, the red-tissue boundary is offered as an alternative.
SAM_ALTERNATIVE_DICE = 0.90
# ...and only when it covers at least this fraction of the whole-wound area.
SAM_ALTERNATIVE_MIN_FRACTION = 0.20
# Outlines sharing at least this fraction of the smaller one's area describe the same wound.
SAM_SAME_WOUND_OVERLAP = 0.5
from .wound_measurement import calculate_measurements
from .yolo_segmenter import YoloSegmenter

# guided: concept pass, then one box + interior-point spatial pass per wound region (default).
# concept: a single noun-phrase call (reproduces the earlier behaviour for benchmarks).
SamStrategy = Literal["guided", "concept"]
# original: SAM sees the rectified photograph. colour_corrected: the colour-corrected crop, only when
# a correction was accepted; used for evaluation until it is shown to help.
SamInput = Literal["original", "colour_corrected"]


def _largest_component(mask: np.ndarray) -> np.ndarray:
    return max(connected_components(mask), key=lambda c: int(np.count_nonzero(c)))


def _overlap_of_smaller(a: np.ndarray, b: np.ndarray) -> float:
    a, b = a > 0, b > 0
    smaller = min(int(a.sum()), int(b.sum()))
    return int(np.logical_and(a, b).sum()) / smaller if smaller else 0.0


def _one_outline_per_wound(outlines: List, yolo_union: Optional[np.ndarray]) -> List:
    """Overlapping outlines describe the same wound, so only one of them is offered.

    Preferred: the outline closest to the local YOLO mask when it ran, otherwise the larger outline
    (the whole wound includes slough). Outlines that do not overlap stay separate wounds.
    """
    def rank(outline):
        agreement = mask_dice(outline.mask, yolo_union) if yolo_union is not None else 0.0
        return agreement, int(np.count_nonzero(outline.mask))

    kept: List = []
    for outline in sorted(outlines, key=rank, reverse=True):
        if all(_overlap_of_smaller(outline.mask, k.mask) < SAM_SAME_WOUND_OVERLAP for k in kept):
            kept.append(outline)
    return kept


def _red_tissue_alternative(wound, concept: List):
    """At most one red-tissue outline per wound: the red patches touching it, merged into one outline.

    Patches split by slough are merged before the largest region is kept, so fragments are never
    offered as separate choices. None when it matches the whole wound closely (nothing to choose).
    """
    touching = [c for c in concept if np.any((c.mask > 0) & (wound.mask > 0))]
    if not touching:
        return None
    # Red tissue lies inside the wound; clipping keeps a concept region that spreads over the
    # surrounding scar or new skin from being offered as a larger "red tissue" outline.
    union = (np.any(np.stack([c.mask > 0 for c in touching]), axis=0) & (wound.mask > 0)).astype(np.uint8)
    mask, _, _ = clean_boundary_mask(union)
    if not np.any(mask):
        return None
    mask = _largest_component(mask)
    if mask_dice(mask, wound.mask) >= SAM_ALTERNATIVE_DICE:
        return None
    # A sliver of the wound is not a usable "red tissue only" measurement, only another choice.
    if np.count_nonzero(mask) < SAM_ALTERNATIVE_MIN_FRACTION * np.count_nonzero(wound.mask):
        return None
    best = max(touching, key=lambda c: c.confidence or 0.0)
    return replace(best, mask=mask)


def _to_measurements_response(measurement, pixels_per_mm: float = 10.0) -> MeasurementsResponse:
    return MeasurementsResponse(
        area_cm2=round(measurement.area_cm2, 4),
        length_cm=round(measurement.length_cm, 4),
        length_method="maximum_vertical_chord",
        width_cm=round(measurement.width_cm, 4),
        width_method="maximum_horizontal_chord",
        perimeter_cm=round(measurement.perimeter_cm, 4),
        algorithm_version="measurement-v3-single-component",
        length_line_px=measurement.length_line_px,
        width_line_px=measurement.width_line_px,
        clinical_length_cm=round(getattr(measurement, "clinical_length_cm", measurement.length_cm), 4),
        clinical_length_method="maximum_feret_major_axis",
        clinical_width_cm=round(getattr(measurement, "clinical_width_cm", measurement.width_cm), 4),
        clinical_width_method="maximum_perpendicular_span_to_major_axis",
        clinical_length_line_px=getattr(measurement, "clinical_length_line_px", []),
        clinical_width_line_px=getattr(measurement, "clinical_width_line_px", []),
        canonical_grid_spacing_mm=round(1.0 / max(0.1, pixels_per_mm), 4),
    )


def _check_contour_touches_inner_edge(
    canonical_mask: Optional[np.ndarray],
    inner_bounds: Tuple[int, int, int, int],
    margin_px: int = 12,
) -> bool:
    """Return True if any segmented wound pixel lies within `margin_px` of the inner measurement window border."""
    if canonical_mask is None or not np.any(canonical_mask > 0):
        return False
    left, top, right, bottom = inner_bounds
    ys, xs = np.nonzero(canonical_mask > 0)
    if len(xs) == 0:
        return False
    touches_left = bool(np.min(xs) <= left + margin_px)
    touches_right = bool(np.max(xs) >= right - 1 - margin_px)
    touches_top = bool(np.min(ys) <= top + margin_px)
    touches_bottom = bool(np.max(ys) >= bottom - 1 - margin_px)
    return touches_left or touches_right or touches_top or touches_bottom


class MeasurementPipeline:
    def __init__(
        self,
        settings: Settings,
        template: RulerTemplate,
        segmenter: YoloSegmenter,
        meta_client: Optional[MetaModelClient] = None,
    ):
        self.settings = settings
        self.template = template
        self.segmenter = segmenter
        self.meta_client = meta_client or MetaModelClient(settings)
        self.colour_profile: Optional[ColourProfile] = (
            load_colour_profile(settings.colour_profile_path) if settings.colour_profile_path.is_file() else None
        )

    def process(
        self,
        data: bytes,
        request_id: str | None = None,
        *,
        segmentation_mode: SegmentationMode = "yolo",
        sam_text_prompt: str = DEFAULT_SAM_CONCEPT,
        sam_box_xyxy: Optional[Tuple[int, int, int, int]] = None,
        sam_points: Optional[List[Dict[str, int | str]]] = None,
        selected_candidate_id: Optional[int] = None,
        include_ai_explanation: bool = False,
        historical_delta: Optional[Dict[str, float]] = None,
        sam_strategy: SamStrategy = "guided",
        sam_input: SamInput = "original",
    ) -> WoundMeasureResponse:
        request_id = request_id or str(uuid4())
        now_utc = datetime.now(timezone.utc).isoformat()
        decoded = decode_image(data, self.settings)
        supported_length_ids = set(range(6, 31)) - {10}
        detections, length_marker = detect_ruler_markers(decoded.bgr, supported_length_ids)
        dynamic_template = self.template.for_complete_ruler_length_cm(length_marker.marker_id)
        geometry = estimate_ruler_geometry(detections, dynamic_template)
        photo_coverage = verify_crop_available(geometry, dynamic_template, decoded.width, decoded.height)
        crop = create_canonical_crop(decoded.bgr, geometry, dynamic_template)
        quiet_zone_warnings = validate_marker_quiet_zones(crop.image_bgr, dynamic_template)
        measurement_pixels_per_mm = dynamic_template.pixels_per_mm

        base = self._base_response(
            request_id,
            decoded,
            detections,
            length_marker,
            dynamic_template,
            measurement_pixels_per_mm,
            geometry,
            crop.image_bgr,
        )
        base.warnings.extend(quiet_zone_warnings)
        if photo_coverage is not None:
            base.geometry.photo_coverage_px = photo_coverage
            base.warnings.append(
                "Part of the ruler's square is outside the photo; the measurement is accepted only if the wound stays clear of it."
            )
        colour = calibrate_colour(
            decoded.bgr, geometry.homography, dynamic_template, length_marker.marker_id,
            self.colour_profile, crop.image_bgr,
        )
        base.colour = colour.response
        sam_inner = None
        if sam_input == "colour_corrected" and colour.corrected_canonical_bgr is not None:
            left, top, right, bottom = crop.inner_bounds
            sam_inner = colour.corrected_canonical_bgr[top:bottom, left:right].copy()

        run_yolo = segmentation_mode in {"yolo", "compare"}
        run_sam = segmentation_mode in {"sam", "compare"}

        yolo_seg_resp: Optional[SegmentationResponse] = None
        yolo_meas_resp: Optional[MeasurementsResponse] = None
        yolo_canonical_mask: Optional[np.ndarray] = None

        sam_seg_resp: Optional[SegmentationResponse] = None
        sam_meas_resp: Optional[MeasurementsResponse] = None
        sam_canonical_mask: Optional[np.ndarray] = None
        sam_error_msg: Optional[str] = None

        # 1. Run YOLO Segmentation if requested (or as fallback if SAM fails)
        if run_yolo:
            yolo_seg_resp, yolo_meas_resp, yolo_canonical_mask = self._run_yolo_branch(
                crop,
                dynamic_template,
                measurement_pixels_per_mm,
                selected_candidate_id=selected_candidate_id if segmentation_mode == "yolo" else None,
            )

        # 2. Run Meta SAM 3.1 Segmentation if requested
        if run_sam:
            sam_seg_resp, sam_meas_resp, sam_canonical_mask, sam_error_msg = self._run_sam_branch(
                crop,
                dynamic_template,
                measurement_pixels_per_mm,
                text_prompt=sam_text_prompt,
                box_xyxy=sam_box_xyxy,
                points=sam_points,
                selected_candidate_id=selected_candidate_id,
                strategy=sam_strategy,
                yolo_inner_masks=self._inner_masks(yolo_seg_resp, crop.inner_bounds),
                inner_bgr=sam_inner,
            )
            if sam_error_msg:
                base.warnings.append(f"Meta SAM 3.1 notice: {sam_error_msg}")
                # Reliability requirement: If SAM was requested alone and failed, fall back to YOLO
                if segmentation_mode == "sam" and yolo_seg_resp is None:
                    base.warnings.append(
                        "Meta SAM 3.1 was unavailable; automatically continued with local YOLO segmentation."
                    )
                    yolo_seg_resp, yolo_meas_resp, yolo_canonical_mask = self._run_yolo_branch(
                        crop,
                        dynamic_template,
                        measurement_pixels_per_mm,
                        selected_candidate_id=selected_candidate_id,
                    )

        base.yolo_segmentation = yolo_seg_resp
        base.yolo_measurements = yolo_meas_resp
        base.sam_segmentation = sam_seg_resp
        base.sam_measurements = sam_meas_resp

        # 3. Model Comparison when both branches were attempted
        if segmentation_mode == "compare" or (yolo_seg_resp is not None and sam_seg_resp is not None):
            base.model_comparison = compare_models(
                yolo_canonical_mask,
                yolo_meas_resp,
                yolo_seg_resp.inference_time_ms if yolo_seg_resp else None,
                sam_canonical_mask,
                sam_meas_resp,
                sam_seg_resp.inference_time_ms if sam_seg_resp else None,
                sam_model_name=f"Meta SAM 3.1 ({self.settings.meta_segmentation_model})",
                sam_error=sam_error_msg,
            )
            if base.model_comparison.disagreement_warning and base.model_comparison.status == "completed":
                base.warnings.append(base.model_comparison.disagreement_warning)

        # 4. Determine active primary segmentation & measurement for response
        active_source = "yolo"
        primary_seg = yolo_seg_resp
        primary_meas = yolo_meas_resp
        primary_mask = yolo_canonical_mask

        if segmentation_mode in {"sam", "compare"} and sam_seg_resp is not None and sam_meas_resp is not None:
            active_source = "sam"
            primary_seg = sam_seg_resp
            primary_meas = sam_meas_resp
            primary_mask = sam_canonical_mask
        elif primary_seg is None and sam_seg_resp is not None:
            active_source = "sam"
            primary_seg = sam_seg_resp
            primary_meas = sam_meas_resp
            primary_mask = sam_canonical_mask

        if primary_seg is None:
            primary_seg = SegmentationResponse(status="not_attempted")

        base.segmentation = primary_seg.model_copy(deep=True)
        base.measurements = primary_meas.model_copy(deep=True) if primary_meas is not None else None

        # 5. Evaluate structured Quality & Safety Gate (PASS, REVIEW_REQUIRED, RETAKE_REQUIRED)
        touches_edge = _check_contour_touches_inner_edge(primary_mask, crop.inner_bounds)
        # A wound that reaches the part of the ruler's square outside the photo may be cut off: never measured.
        wound_cut = primary_meas is not None and reaches_outside_photo(primary_mask, photo_coverage, measurement_pixels_per_mm)
        review_reasons: List[str] = []
        blocking_reasons: List[str] = []
        gate_checks: Dict[str, str] = {
            "ruler_detection": "PASS",
            "calibration_geometry": "PASS",
            "image_quality": "PASS" if decoded.quality_status == "valid" else "REVIEW_REQUIRED",
            "boundary_within_window": "REVIEW_REQUIRED" if touches_edge else "PASS",
            "model_agreement": "PASS",
            "measurement_completeness": "PASS" if primary_meas is not None else "RETAKE_REQUIRED",
            "boundary_within_photo": "RETAKE_REQUIRED" if wound_cut else "PASS",
        }
        if decoded.quality_status != "valid":
            review_reasons.append("Image quality is not evaluated or requires review.")
        if touches_edge:
            edge_msg = "The wound boundary extends to or touches the measurement region edge."
            review_reasons.append(edge_msg)
            base.warnings.append(edge_msg)
        if geometry.maximum_error_mm > dynamic_template.max_reprojection_error_mm:
            gate_checks["calibration_geometry"] = "REVIEW_REQUIRED"
            review_reasons.append(
                f"Calibration reprojection residual ({geometry.maximum_error_mm:.2f} mm) is in the warning band."
            )
        if base.model_comparison and base.model_comparison.status == "completed":
            if base.model_comparison.agreement_level in {"moderate", "low_disagreement_warning"}:
                gate_checks["model_agreement"] = "REVIEW_REQUIRED"
                review_reasons.append("The segmentation models disagree. Manual inspection is required.")

        if segmentation_mode in {"sam", "compare"}:
            sam_no_mask = sam_seg_resp is not None and sam_seg_resp.status == "no_wound_detected"
            if sam_seg_resp is not None and sam_seg_resp.status in {"success", "multiple_wounds_detected"}:
                meta_exec_status = "sam_live_inference"
            elif yolo_seg_resp is not None and yolo_seg_resp.status in {"success", "multiple_wounds_detected"}:
                meta_exec_status = "yolo_local_fallback"
                review_reasons.append(
                    "Meta SAM 3.1 returned no usable mask; local YOLO fallback is active."
                    if sam_no_mask
                    else "Meta SAM 3.1 was unavailable; local YOLO fallback is active."
                )
            else:
                meta_exec_status = "sam_no_valid_mask" if sam_no_mask else "api_unavailable"
        else:
            meta_exec_status = "live_api_connected" if self.settings.meta_configured else "local_yolo_only"

        # 6. Set overall status and review workflow state
        if primary_seg.status == "no_wound_detected":
            failure_stage, retake_guidance = guidance_for_failure("no_wound_detected")
            base.overall_status = "retake_required"
            base.error_code = "no_wound_detected"
            base.failure_stage = failure_stage
            base.retake_guidance = retake_guidance
            base.message = (
                "No wound could be detected. The photograph may contain no wound, or the model may not "
                "have identified the visible wound. No measurement was produced."
            )
            blocking_reasons.append("The physical measurement cannot be calculated reliably (no wound detected).")
            review_state = "RETAKE_REQUIRED"
            meas_status = "retake_required"
            gate_status = "RETAKE_REQUIRED"
        elif wound_cut:
            failure_stage, retake_guidance = guidance_for_failure("wound_outside_photo")
            base.overall_status = "retake_required"
            base.error_code = "wound_outside_photo"
            base.failure_stage = failure_stage
            base.retake_guidance = retake_guidance
            base.message = WOUND_OUTSIDE_PHOTO_MESSAGE
            blocking_reasons.append(WOUND_OUTSIDE_PHOTO_MESSAGE)
            # Withhold the figures: part of the wound may lie outside the photo.
            base.measurements = None
            primary_meas = None
            review_state = "RETAKE_REQUIRED"
            meas_status = "retake_required"
            gate_status = "RETAKE_REQUIRED"
        elif primary_seg.status == "multiple_wounds_detected":
            base.overall_status = "review_required"
            if (primary_seg.sam_guidance or {}).get("alternatives_offered"):
                base.message = (
                    "Meta SAM 3.1 proposed alternative boundaries: the whole wound after box refinement and the "
                    "concept boundary, which can leave out non-red tissue such as slough. Choose the boundary "
                    "that follows the wound edge, or refine it, before accepting measurements."
                )
                review_reasons.append("Alternative SAM boundaries proposed; clinician selection is required.")
            else:
                base.message = (
                    "Multiple wound regions were detected; select the target wound candidate or refine the "
                    "boundary before accepting measurements."
                )
                review_reasons.append("Multiple wound candidates detected; clinician selection is required.")
            review_state = "PENDING_HUMAN_MEASUREMENT_REVIEW"
            meas_status = "provisional"
            gate_status = "REVIEW_REQUIRED"
        elif primary_meas is not None:
            base.overall_status = "success"
            review_state = "PENDING_HUMAN_MEASUREMENT_REVIEW"
            meas_status = "provisional"
            gate_status = "REVIEW_REQUIRED" if review_reasons else "PASS"
        else:
            base.overall_status = "retake_required"
            blocking_reasons.append("The physical measurement cannot be calculated reliably.")
            review_state = "RETAKE_REQUIRED"
            meas_status = "retake_required"
            gate_status = "RETAKE_REQUIRED"

        gate_checks["component_selection"] = "REVIEW_REQUIRED" if primary_seg.status == "multiple_wounds_detected" else "PASS"
        base.quality_gate = QualityGateResponse(
            status=gate_status,
            blocking_reasons=blocking_reasons,
            review_reasons=review_reasons,
            checks=gate_checks,
            contour_touches_measurement_edge=touches_edge,
            meta_execution_status=meta_exec_status,
        )

        base.provenance = ProvenanceMetadata(
            measurement_status=meas_status,
            review_state=review_state,
            boundary_provenance="ai_predicted",
            active_model_source=active_source,
            segmentation_mode=segmentation_mode,
            yolo_model_version=yolo_seg_resp.model_version if yolo_seg_resp else None,
            yolo_model_checksum=yolo_seg_resp.model_checksum if yolo_seg_resp else None,
            sam_model_version=self.settings.meta_segmentation_model if sam_seg_resp else None,
            reasoning_model_version=self.settings.meta_reasoning_model if include_ai_explanation else None,
            measurement_algorithm_version="measurement-v3-single-component",
            ruler_template_version=dynamic_template.version,
            ruler_template_checksum=dynamic_template.checksum,
            created_at_utc=now_utc,
        )

        # 6. Optional Muse Spark Explainable AI commentary
        if include_ai_explanation and primary_meas is not None:
            base.ai_explanation = self.generate_explanation(base, historical_delta=historical_delta)

        base.audit_trail.append(
            {
                "timestamp_utc": now_utc,
                "action": "AI_MEASUREMENT_GENERATED",
                "actor": "system:pipeline-v2",
                "review_state": review_state,
                "segmentation_mode": segmentation_mode,
                "active_model_source": active_source,
                "area_cm2": primary_meas.area_cm2 if primary_meas else None,
            }
        )
        return base

    def generate_explanation(
        self,
        response: WoundMeasureResponse,
        *,
        historical_delta: Optional[Dict[str, float]] = None,
    ):
        return self.meta_client.explain_measurements_with_muse(
            self.explanation_context(response, historical_delta=historical_delta))

    @staticmethod
    def explanation_context(
        response: WoundMeasureResponse,
        *,
        historical_delta: Optional[Dict[str, float]] = None,
    ) -> Dict[str, Any]:
        """The server-calculated facts the draft-note explanation is written from (numbers only)."""
        meas = response.measurements
        return {
            "measurement_status": response.provenance.measurement_status,
            "area_cm2": meas.area_cm2 if meas else None,
            "length_cm": meas.length_cm if meas else None,
            "width_cm": meas.width_cm if meas else None,
            "perimeter_cm": meas.perimeter_cm if meas else None,
            "calibration_status": response.geometry.status,
            "ruler_length_cm": response.ruler.ruler_length_cm,
            "segmentation_model": response.provenance.active_model_source.upper(),
            "boundary_provenance": response.provenance.boundary_provenance,
            "human_review_status": response.provenance.review_state,
            "quality_warnings": [*response.warnings, *response.image_quality.warnings],
            "model_comparison": response.model_comparison.model_dump(mode="json")
            if response.model_comparison
            else None,
            "historical_delta": historical_delta,
        }

    def _run_yolo_branch(
        self,
        crop,
        dynamic_template: RulerTemplate,
        pixels_per_mm: float,
        *,
        selected_candidate_id: Optional[int] = None,
    ) -> Tuple[SegmentationResponse, Optional[MeasurementsResponse], Optional[np.ndarray]]:
        segmentation = self.segmenter.segment(crop.inner_bgr)
        inner_h, inner_w = crop.inner_bgr.shape[:2]

        if not segmentation.masks:
            return (
                SegmentationResponse(
                    status="no_wound_detected",
                    model_version=segmentation.model_version,
                    model_checksum=segmentation.model_checksum,
                    input_width_px=inner_w,
                    input_height_px=inner_h,
                    mask_threshold=self.settings.mask_threshold,
                    wound_count=0,
                    inference_time_ms=segmentation.inference_time_ms,
                ),
                None,
                None,
            )

        candidates: List[SegmentationCandidateResponse] = []
        canonical_masks: List[np.ndarray] = []
        for idx, raw_mask in enumerate(segmentation.masks):
            c_mask = map_inner_mask_to_canonical(
                raw_mask, crop.inner_bounds, dynamic_template.width_px, dynamic_template.height_px
            )
            for c_mask in connected_components(c_mask):
                boundary = contour_from_mask(c_mask)
                if not boundary:
                    continue
                meas = _to_measurements_response(calculate_measurements(c_mask, pixels_per_mm))
                conf = segmentation.confidences[idx] if idx < len(segmentation.confidences) else None
                canonical_masks.append(c_mask)
                candidates.append(
                    SegmentationCandidateResponse(
                        candidate_id=len(candidates),
                        source_model="yolo",
                        confidence=conf,
                        canonical_boundary_px=boundary,
                        canonical_mask_png_base64=encode_mask_png(c_mask),
                        measurements=meas,
                    )
                )

        if not candidates:
            raise ProcessingFailure("no_wound_detected", "The segmentation mask was empty.")

        if len(candidates) > 1 and selected_candidate_id is None:
            preview = candidates[0]
            return (SegmentationResponse(status="multiple_wounds_detected", model_version=segmentation.model_version,
                model_checksum=segmentation.model_checksum, input_width_px=inner_w, input_height_px=inner_h,
                wound_count=len(candidates), candidates=candidates, canonical_boundary_px=preview.canonical_boundary_px,
                canonical_mask_png_base64=preview.canonical_mask_png_base64, inference_time_ms=segmentation.inference_time_ms),
                preview.measurements, canonical_masks[0])

        chosen_idx = 0
        if selected_candidate_id is not None and selected_candidate_id not in {c.candidate_id for c in candidates}:
            raise ProcessingFailure("invalid_component", "The selected wound component does not exist.")
        if selected_candidate_id is not None:
            for i, cand in enumerate(candidates):
                if cand.candidate_id == selected_candidate_id:
                    chosen_idx = i
                    break

        chosen = candidates[chosen_idx]
        chosen_mask = canonical_masks[chosen_idx]
        return (
            SegmentationResponse(
                status="success",
                model_version=segmentation.model_version,
                model_checksum=segmentation.model_checksum,
                input_width_px=inner_w,
                input_height_px=inner_h,
                confidence=chosen.confidence,
                mask_threshold=self.settings.mask_threshold,
                wound_count=len(candidates),
                canonical_boundary_px=chosen.canonical_boundary_px,
                canonical_mask_png_base64=chosen.canonical_mask_png_base64,
                inference_time_ms=segmentation.inference_time_ms,
                candidates=candidates,
                selected_candidate_id=chosen.candidate_id,
            ),
            chosen.measurements,
            chosen_mask,
        )

    def _run_sam_branch(
        self,
        crop,
        dynamic_template: RulerTemplate,
        pixels_per_mm: float,
        *,
        text_prompt: str = DEFAULT_SAM_CONCEPT,
        box_xyxy: Optional[Tuple[int, int, int, int]] = None,
        points: Optional[List[Dict[str, int | str]]] = None,
        selected_candidate_id: Optional[int] = None,
        strategy: SamStrategy = "guided",
        yolo_inner_masks: Optional[List[np.ndarray]] = None,
        inner_bgr: Optional[np.ndarray] = None,
    ) -> Tuple[SegmentationResponse, Optional[MeasurementsResponse], Optional[np.ndarray], Optional[str]]:
        input_label = "original" if inner_bgr is None else "colour_corrected"
        inner_bgr = crop.inner_bgr if inner_bgr is None else inner_bgr
        inner_h, inner_w = inner_bgr.shape[:2]
        guidance: Optional[Dict] = None
        try:
            if box_xyxy is not None or points or strategy == "concept":
                sam_candidates, elapsed_ms, prompt_used = self.meta_client.segment_with_sam(
                    inner_bgr,
                    text_prompt=text_prompt,
                    box_xyxy=box_xyxy,
                    points=points,
                )
                guidance = {"strategy": "spatial" if (box_xyxy is not None or points) else "concept",
                            "concept_prompt": None if (box_xyxy is not None or points) else prompt_used}
            else:
                sam_candidates, elapsed_ms, prompt_used, guidance = self._guided_sam(
                    inner_bgr, text_prompt, yolo_inner_masks
                )
        except MetaApiError as exc:
            return (
                SegmentationResponse(
                    # A completed call with no usable mask is not an outage.
                    status="no_wound_detected" if exc.code == "meta_no_valid_mask" else "unavailable",
                    model_version=self.settings.meta_segmentation_model,
                    input_width_px=inner_w,
                    input_height_px=inner_h,
                    wound_count=0,
                    error_message=exc.message,
                ),
                None,
                None,
                exc.message,
            )
        except Exception as exc:
            err_text = f"SAM 3.1 segmentation failed: {exc}"
            return (
                SegmentationResponse(
                    status="unavailable",
                    model_version=self.settings.meta_segmentation_model,
                    input_width_px=inner_w,
                    input_height_px=inner_h,
                    wound_count=0,
                    error_message=err_text,
                ),
                None,
                None,
                err_text,
            )

        candidates: List[SegmentationCandidateResponse] = []
        canonical_masks: List[np.ndarray] = []
        left_off, top_off, _, _ = crop.inner_bounds

        kinds = (guidance or {}).get("candidate_kinds") or []
        for idx, parsed in enumerate(sam_candidates):
            c_mask = map_inner_mask_to_canonical(
                parsed.mask, crop.inner_bounds, dynamic_template.width_px, dynamic_template.height_px
            )
            for c_mask in connected_components(c_mask):
                boundary = contour_from_mask(c_mask)
                if not boundary:
                    continue
                meas = _to_measurements_response(calculate_measurements(c_mask, pixels_per_mm))
                bx1, by1, bx2, by2 = parsed.box_xyxy
                canonical_box = [bx1 + left_off, by1 + top_off, bx2 + left_off, by2 + top_off]
                canonical_masks.append(c_mask)
                candidates.append(
                    SegmentationCandidateResponse(
                        candidate_id=len(candidates),
                        source_model=self.settings.meta_segmentation_model,
                        boundary_kind=kinds[idx] if idx < len(kinds) else None,
                        confidence=parsed.confidence,
                        bounding_box_px=canonical_box,
                        canonical_boundary_px=boundary,
                        canonical_mask_png_base64=encode_mask_png(c_mask),
                        measurements=meas,
                    )
                )

        if not candidates:
            return (
                SegmentationResponse(
                    status="no_wound_detected",
                    model_version=self.settings.meta_segmentation_model,
                    input_width_px=inner_w,
                    input_height_px=inner_h,
                    wound_count=0,
                    inference_time_ms=round(elapsed_ms, 2),
                    prompt_used=prompt_used,
                    sam_guidance=guidance,
                    input_image=input_label,
                ),
                None,
                None,
                None,
            )

        if len(candidates) > 1 and selected_candidate_id is None:
            # Do not automatically pick the largest as clinically authoritative when multiple candidates exist;
            # expose all candidates and also return candidate 0 for comparison preview while flagging review_required.
            preview_cand = candidates[0]
            preview_mask = canonical_masks[0]
            return (
                SegmentationResponse(
                    status="multiple_wounds_detected",
                    model_version=self.settings.meta_segmentation_model,
                    input_width_px=inner_w,
                    input_height_px=inner_h,
                    confidence=preview_cand.confidence,
                    wound_count=len(candidates),
                    canonical_boundary_px=preview_cand.canonical_boundary_px,
                    canonical_mask_png_base64=preview_cand.canonical_mask_png_base64,
                    inference_time_ms=round(elapsed_ms, 2),
                    prompt_used=prompt_used,
                    sam_guidance=guidance,
                    input_image=input_label,
                    candidates=candidates,
                    selected_candidate_id=None,
                ),
                preview_cand.measurements,
                preview_mask,
                None,
            )

        chosen_idx = 0
        if selected_candidate_id is not None and selected_candidate_id not in {c.candidate_id for c in candidates}:
            raise ProcessingFailure("invalid_component", "The selected wound component does not exist.")
        if selected_candidate_id is not None:
            for i, cand in enumerate(candidates):
                if cand.candidate_id == selected_candidate_id:
                    chosen_idx = i
                    break

        chosen = candidates[chosen_idx]
        chosen_mask = canonical_masks[chosen_idx]
        return (
            SegmentationResponse(
                status="success",
                model_version=self.settings.meta_segmentation_model,
                input_width_px=inner_w,
                input_height_px=inner_h,
                confidence=chosen.confidence,
                wound_count=len(candidates),
                canonical_boundary_px=chosen.canonical_boundary_px,
                canonical_mask_png_base64=chosen.canonical_mask_png_base64,
                inference_time_ms=round(elapsed_ms, 2),
                prompt_used=prompt_used,
                    sam_guidance=guidance,
                    input_image=input_label,
                candidates=candidates,
                selected_candidate_id=chosen.candidate_id,
            ),
            chosen.measurements,
            chosen_mask,
            None,
        )

    @staticmethod
    def _inner_masks(
        seg: Optional[SegmentationResponse], inner_bounds: Tuple[int, int, int, int]
    ) -> Optional[List[np.ndarray]]:
        """YOLO candidate masks cut back to inner-crop pixels, to seed the guided SAM pass.

        None when YOLO did not complete; an empty list when it ran and found no wound.
        """
        if seg is None or seg.status not in ("success", "multiple_wounds_detected", "no_wound_detected"):
            return None
        left, top, right, bottom = inner_bounds
        masks = []
        for candidate in seg.candidates:
            if not candidate.canonical_mask_png_base64:
                continue
            raw = np.frombuffer(base64.b64decode(candidate.canonical_mask_png_base64), dtype=np.uint8)
            mask = cv2.imdecode(raw, cv2.IMREAD_GRAYSCALE)
            if mask is not None:
                masks.append((mask[top:bottom, left:right] > 0).astype(np.uint8))
        return masks

    def _guided_sam(self, inner_bgr: np.ndarray, concept: str, yolo_inner_masks: Optional[List[np.ndarray]]):
        """Locate with concept prompts, refine each wound with box + interior point, in one time budget.

        Candidates: the refined whole-wound boundary, plus the concept boundary as an alternative
        when the two disagree materially, so the reviewer chooses between them. YOLO agreement only
        orders the alternatives; it never replaces a SAM boundary.

        Per wound at most two outlines are offered: overlapping refined outlines are one wound, and all
        red patches touching it are merged into a single red-tissue alternative.
        """
        deadline = self.meta_client.sam_deadline()
        concept_candidates: List = []
        concept_error: Optional[MetaApiError] = None
        concept_ms, concept_prompt, tried = 0.0, None, []
        for phrase in dict.fromkeys([concept, *SAM_LOCATOR_CONCEPTS]):
            tried.append(phrase)
            try:
                concept_candidates, elapsed, concept_prompt = self.meta_client.segment_with_sam(
                    inner_bgr, text_prompt=phrase, deadline=deadline
                )
                concept_ms += elapsed
                break
            except MetaApiError as exc:
                if exc.code != "meta_no_valid_mask":
                    raise
                concept_error = exc
        concept_masks = [c.mask for c in concept_candidates]
        seeds = guidance_seeds(concept_masks, yolo_inner_masks)
        guidance: Dict = {
            "strategy": "guided",
            "concept_prompts_tried": tried,
            "concept_prompt": concept_prompt,
            "concept_candidate_count": len(concept_candidates),
            "concept_area_px": int(sum(int(np.count_nonzero(m)) for m in concept_masks)),
            "concept_latency_ms": round(concept_ms, 2),
            "seeds": [seed.summary() for seed in seeds],
        }
        if not seeds:
            raise concept_error or MetaApiError(
                "meta_no_valid_mask", "Meta returned no usable mask; local fallback or recapture is required.", 502
            )
        try:
            spatial, spatial_ms, spatial_prompt = self.meta_client.segment_with_sam(
                inner_bgr, objects=[seed.as_prompt_object() for seed in seeds], deadline=deadline
            )
        except MetaApiError as exc:
            if not concept_candidates:
                raise
            # The concept boundary is still a usable SAM result; the reviewer is told it was not refined.
            spatial, spatial_ms, spatial_prompt = [], 0.0, None
            guidance.update(spatial_status="failed", spatial_error=exc.code)

        filled_px, removed_px = 0, 0
        refined: List = []
        concept: List = []
        for target, parsed_list in ((refined, spatial), (concept, concept_candidates)):
            for parsed in parsed_list:
                mask, filled, removed = clean_boundary_mask(parsed.mask)
                filled_px, removed_px = filled_px + filled, removed_px + removed
                if np.any(mask):
                    target.append(replace(parsed, mask=mask))

        # Kept minimal for the reviewer: one outline per wound, plus at most one red-tissue
        # alternative for it. Without refinement the concept boundary is the wound outline.
        yolo_union = np.any(np.stack(yolo_inner_masks), axis=0) if yolo_inner_masks else None
        if refined:
            # One box + point prompt describes one object; detached islands are not separate wounds.
            refined = [replace(c, mask=_largest_component(c.mask)) for c in refined]
            wounds, wound_kind = _one_outline_per_wound(refined, yolo_union), "sam_refined_whole_wound"
        else:
            concept_outlines = [replace(c, mask=_largest_component(c.mask)) for c in concept]
            wounds, wound_kind = _one_outline_per_wound(concept_outlines, yolo_union), "sam_concept"
        candidates, kinds = [], []
        for wound in wounds:
            candidates.append(wound)
            kinds.append(wound_kind)
            alternative = _red_tissue_alternative(wound, concept) if refined else None
            if alternative is not None:
                candidates.append(alternative)
                kinds.append("sam_concept")
        if not candidates:
            raise concept_error or MetaApiError(
                "meta_no_valid_mask", "Meta returned no usable mask; local fallback or recapture is required.", 502
            )
        if yolo_union is not None and len(wounds) > 1:
            guidance["ordered_by"] = "agreement_with_local_yolo"
        guidance["outlines_returned"] = len(spatial) + len(concept_candidates)
        guidance.update(
            spatial_status=guidance.get("spatial_status", "completed"),
            spatial_latency_ms=round(spatial_ms, 2),
            spatial_area_px=int(sum(int(np.count_nonzero(c.mask)) for c in spatial)),
            candidate_kinds=kinds,
            alternatives_offered="sam_concept" in kinds and "sam_refined_whole_wound" in kinds,
            holes_filled_px=filled_px,
            specks_removed_px=removed_px,
        )
        sources = sorted({seed.source for seed in seeds})
        description = (f"guided: locator {concept_prompt} → {len(seeds)} box+point object(s) seeded by "
                       f"{'/'.join(sources)}; {spatial_prompt or 'refinement unavailable'}")
        return candidates, concept_ms + spatial_ms, description, guidance

    def _base_response(
        self,
        request_id: str,
        decoded: DecodedImage,
        detections: dict[int, DetectedMarker],
        length_marker: DetectedMarker,
        template: RulerTemplate,
        measurement_pixels_per_mm: float,
        geometry,
        canonical_bgr,
    ):
        ok, encoded = cv2.imencode(".jpg", canonical_bgr, [cv2.IMWRITE_JPEG_QUALITY, 90])
        if not ok:
            raise ProcessingFailure(
                "processing_error", "The canonical review image could not be encoded.", status_code=500
            )
        response = WoundMeasureResponse(
            request_id=request_id,
            overall_status="processing",
            image_quality=ImageQualityResponse(
                status=decoded.quality_status,
                warnings=decoded.warnings,
                original_width_px=decoded.width,
                original_height_px=decoded.height,
            ),
            ruler=RulerResponse(
                detected_ids=sorted([*detections, length_marker.marker_id]),
                template_id=template.template_id,
                template_version=template.version,
                template_checksum=template.checksum,
                pixels_per_mm=measurement_pixels_per_mm,
                validated=template.validated,
                length_marker_id=length_marker.marker_id,
                ruler_length_cm=float(length_marker.marker_id),
                calibration_source="fourth_marker_id_cm",
            ),
            geometry=GeometryResponse(
                status="valid",
                canonical_width_px=template.width_px,
                canonical_height_px=template.height_px,
                inner_bounds_px=list(template.inner_bounds_px()),
                mean_reprojection_error_mm=geometry.mean_error_mm,
                maximum_reprojection_error_mm=geometry.maximum_error_mm,
                per_tag_error_mm=geometry.per_tag_error_mm,
                inlier_count=geometry.inlier_count,
                all_tags_contributed=True,
                warnings=geometry.warnings,
            ),
            canonical_image=CanonicalImageResponse(
                width_px=template.width_px,
                height_px=template.height_px,
                data_base64=base64.b64encode(encoded.tobytes()).decode("ascii"),
            ),
        )
        if not template.validated:
            response.warnings.append(
                "Prototype ruler geometry: verify the printed ruler with physical measurements before clinical use."
            )
        return response
