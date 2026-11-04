"""Demo mode only, no sign-in: the real wound-record workflow for one photo, held in the browser.

`/measure` runs the same pipeline as a real wound update (`submit_wound_observation`: AprilTag
calibration, colour calibration, YOLO + Meta SAM 3.1 compare, measurement, quality gate) and returns
an observation record with the same shape the record screen loads, built in memory with the same
geometry contract. The browser keeps that record; the other endpoints are stateless versions of the
record actions, using the same code as the real ones:

  /preview         measure an edited boundary   (ConnectedCareService.preview_observation_measurement)
  /refine          Done editing: a new version  (ConnectedCareService.clinician_refine_observation_mask)
  /ai-observations Muse Spark visual findings   (ClinicalAIService.generate_visual_observations)
  /ai-revise       Ask AI wording suggestion    (ClinicalAIService.revise_draft)

Nothing is written to the database (no patient, wound, observation, image, measurement, AI or audit
row) or to patient storage. There is no patient and no wound location. Only when
WOUNDMETER_DEMO_KEEP_PHOTOS=true is each measured photo kept, with its rectified/colour-corrected views
and a result.json, in a separate demo folder (WOUNDMETER_DEMO_PHOTO_DIR, default /app/demo-data/images,
bind-mounted from ./demo-data on the host), one folder per measurement. When Meta AI is enabled
(META_AI_ENABLED=true and META_API_KEY), photos and crops are sent to the Meta API, exactly as the
real workflow does.
"""
from __future__ import annotations

import base64
import binascii
import hashlib
import json
import logging
import os
import threading
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional
from uuid import uuid4

import cv2
import numpy as np
from fastapi import APIRouter
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from app.api.connected_care import care_service
from app.api.wound_measure import pipeline
from app.services.clinical_ai_service import (
    COLOUR_RULES, OBSERVATION_SCHEMA, OBSERVATION_SYSTEM_PROMPT, REVISION_SCHEMA, REVISION_SYSTEM_PROMPT,
    REVISION_TYPE_RULES, ClinicalAIService, guard_visual_findings, revision_flags,
)
from app.services.connected_care_db import BOUNDARY_KIND_REGION, MEASUREMENT_REGIONS, measurement_lines
from app.services.apriltag_detector import EXPECTED_IDS, detect_all_markers, detect_ruler_markers
from app.services.errors import ProcessingFailure
from app.services.image_decoder import decode_image
from app.services.retake_guidance import guidance_for_failure
from app.services.ruler_geometry import estimate_ruler_geometry
from app.services.mask_mapping import contour_from_mask
from app.services.measurement_contract import corrected_gate, mask_hash, reaches_outside_photo, strict_polygon_mask
from app.services.meta_client import MetaApiError
from app.services.wound_measurement import calculate_measurements

router = APIRouter(prefix="/v2/demo", tags=["demo"])
logger = logging.getLogger(__name__)
# Several demo measurements may run at once (the local YOLO step itself is serialised inside
# YoloSegmenter); extra requests wait for a free slot instead of being refused straight away.
MAX_PARALLEL = 4
QUEUE_WAIT_SECONDS = 90
_slots = threading.BoundedSemaphore(MAX_PARALLEL)
DEMO_SUBJECT = "demo.viewer"


def _json(body, status_code: int = 200) -> JSONResponse:
    return JSONResponse(status_code=status_code, content=body, headers={"Cache-Control": "no-store"})


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _disabled() -> Optional[JSONResponse]:
    if not care_service.settings.demo_mode:
        return _json({"code": "NOT_AVAILABLE", "message": "Demo measurement is disabled."}, 404)
    if pipeline is None:
        return _json({"code": "PIPELINE_NOT_READY", "message": "Measurement pipeline not configured."}, 503)
    return None


def _meta_status() -> dict:
    s = care_service.settings
    return {"enabled": s.meta_configured, "segmentation_model": s.meta_segmentation_model,
            "reasoning_model": s.meta_reasoning_model, "observations_enabled": s.meta_configured and s.meta_observations_enabled}


def _b64(data: str, limit: int) -> bytes:
    raw = data.split(",", 1)[1] if "," in data else data
    if len(raw) > 4 * ((limit + 2) // 3):
        raise ProcessingFailure("file_too_large", "The selected image is too large.", status_code=413)
    try:
        return base64.b64decode(raw, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise ProcessingFailure("INVALID_IMAGE", "The image must be valid base64 data.") from exc


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _image_ref(role: str, data_b64: Optional[str], width: Optional[int], height: Optional[int]) -> Dict[str, Any]:
    """An image reference shaped like a stored one; the bytes travel inline instead of a signed URL."""
    raw = base64.b64decode(data_b64) if data_b64 else b""
    media = "image/png" if raw[:4] == b"\x89PNG" else "image/jpeg"
    return {"image_id": f"DEMO-IMG-{role}", "image_role": role, "media_type": media, "width_px": width, "height_px": height,
            "sha256_hash": _sha(raw) if raw else None,
            "signed_url": f"data:{media};base64,{data_b64}" if data_b64 else "", "expires_at_epoch": 0}


def _check_geometry(geometry: Dict[str, Any]) -> Dict[str, Any]:
    """The browser sends the geometry back: accept it only if it matches the server's own ruler template."""
    try:
        marker = int((geometry.get("ruler") or {}).get("length_marker_id"))
        template = pipeline.template.for_complete_ruler_length_cm(marker)
    except Exception as exc:
        raise ValueError("The demo calibration is not valid. Measure the photo again.") from exc
    if (geometry.get("canonical_width_px"), geometry.get("canonical_height_px")) != (template.width_px, template.height_px) \
            or list(geometry.get("inner_bounds_px") or []) != list(template.inner_bounds_px()) \
            or float(geometry.get("pixels_per_mm") or 0) != float(template.pixels_per_mm):
        raise ValueError("The demo calibration does not match the ruler template. Measure the photo again.")
    return geometry


def _diagnose(image_bytes: bytes, exc: ProcessingFailure) -> Dict[str, Any]:
    """Why a photo failed calibration: replays the pipeline's own detection steps (read-only) and reports
    the tags found and, when the ruler could be calibrated, the measurement window that must fit in the photo."""
    stage, guidance = guidance_for_failure(exc.code)
    out: Dict[str, Any] = {"code": exc.code, "message": exc.message, "stage": stage, "guidance": guidance,
                           "required_ids": sorted(EXPECTED_IDS), "markers": [], "crop_outline_px": None}
    try:
        bgr = decode_image(image_bytes, care_service.settings).bgr
    except ProcessingFailure:
        try:  # quality checks failed: still show the tags, on the photo as the browser displays it
            from io import BytesIO
            from PIL import Image, ImageOps
            rgb = np.asarray(ImageOps.exif_transpose(Image.open(BytesIO(image_bytes))).convert("RGB"))
            bgr = cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)
        except Exception:
            return out
    out["width_px"], out["height_px"] = int(bgr.shape[1]), int(bgr.shape[0])
    try:
        found = detect_all_markers(bgr)
    except ProcessingFailure:
        found = {}
    length_id = None
    try:
        required, length_marker = detect_ruler_markers(bgr, set(range(6, 31)) - {10})
        length_id = length_marker.marker_id
        template = pipeline.template.for_complete_ruler_length_cm(length_id)
        geometry = estimate_ruler_geometry(required, template)
        crop = cv2.perspectiveTransform(template.mm_to_px(template.crop_mm).reshape(1, -1, 2), geometry.inverse_homography)[0]
        out["crop_outline_px"] = [[round(float(x), 1), round(float(y), 1)] for x, y in crop]
        out["safety_margin_px"] = float(template.source_safety_margin_px)
    except Exception:
        pass
    for marker_id, detections in sorted(found.items()):
        for d in detections:
            out["markers"].append({
                "id": marker_id,
                "role": "required" if marker_id in EXPECTED_IDS else "length" if marker_id == length_id else "other",
                "corners_px": [[round(float(x), 1), round(float(y), 1)] for x, y in d.corners_px],
                "size_px": round(float(np.sqrt(cv2.contourArea(d.corners_px.astype(np.float32)))), 1),
            })
    return out


def _keep_photo(obs_id: str, image_bytes: bytes, *, session=None, failure: Optional[Dict[str, Any]] = None) -> Optional[str]:
    """Keep the demo photo and its result in the demo folder (separate from patient data). Never fails the request."""
    s = care_service.settings
    if not (s.demo_mode and s.demo_keep_photos):
        return None
    try:
        now = datetime.now(timezone.utc)
        relative = f"{now:%Y-%m-%d}/{now:%H%M%S}_{obs_id}"
        folder = s.demo_photo_dir / relative
        folder.mkdir(parents=True, exist_ok=False)
        for d in (folder.parent, folder):
            os.chmod(d, 0o2775)

        def write(name: str, data: bytes) -> None:
            path = folder / name
            path.write_bytes(data)
            os.chmod(path, 0o664)

        ext = "png" if image_bytes[:4] == b"\x89PNG" else "webp" if image_bytes[8:12] == b"WEBP" else "jpg"
        write(f"original.{ext}", image_bytes)
        result: Dict[str, Any] = {"observation_id": obs_id, "captured_at_utc": now.isoformat(), "original_sha256": _sha(image_bytes),
                                  "meta_ai": _meta_status(), "note": "Demo photo: not part of any patient record."}
        if session is not None:
            if session.canonical_image and session.canonical_image.data_base64:
                write("rectified.jpg", base64.b64decode(session.canonical_image.data_base64))
            if session.colour.corrected_canonical_image_base64:
                write("colour-corrected.jpg", base64.b64decode(session.colour.corrected_canonical_image_base64))
            m = session.measurements
            result.update({
                "overall_status": session.overall_status, "message": session.message,
                "active_model": session.provenance.active_model_source, "segmentation_mode": session.provenance.segmentation_mode,
                "measurement": m.model_dump(exclude={"length_line_px", "width_line_px", "clinical_length_line_px", "clinical_width_line_px"}) if m else None,
                "quality_gate": session.quality_gate.model_dump(), "image_quality": session.image_quality.model_dump(),
                "ruler": session.ruler.model_dump(),
                "colour": session.colour.model_dump(exclude={"corrected_canonical_image_base64", "patches"}),
                "model_comparison": session.model_comparison.model_dump() if session.model_comparison else None,
                "warnings": session.warnings,
            })
        if failure is not None:
            result.update({"overall_status": "calibration_failed", "diagnostics": failure})
        write("result.json", json.dumps(result, indent=2, ensure_ascii=False, default=str).encode())
        return relative
    except Exception:
        logger.exception("Could not keep the demo photo")
        return None


# ---- Measure: the record, as submit_wound_observation + get_observation_detail would show it ------------

class MeasureRequest(BaseModel):
    image_base64: str


def _record(session, image_bytes: bytes, explanation) -> Dict[str, Any]:
    now = _now()
    obs_id = f"DEMO-OBS-{uuid4().hex[:8].upper()}"
    active_seg, active_meas = session.segmentation, session.measurements
    use_sam = session.provenance.active_model_source == "sam"
    source_model = "meta-sam-3.1" if use_sam else "yolov8-seg"
    gate = session.quality_gate
    colour = session.colour
    images = [_image_ref("ORIGINAL_UPLOAD", None, session.image_quality.original_width_px, session.image_quality.original_height_px)]
    images[0]["sha256_hash"] = _sha(image_bytes)  # the browser shows its own copy of the photo
    if session.canonical_image and session.canonical_image.data_base64:
        images.append(_image_ref("CANONICAL_RECTIFIED", session.canonical_image.data_base64,
                                 session.canonical_image.width_px, session.canonical_image.height_px))
    if colour.corrected_canonical_image_base64:
        images.append(_image_ref("COLOUR_CORRECTED", colour.corrected_canonical_image_base64,
                                 session.geometry.canonical_width_px, session.geometry.canonical_height_px))
    colour_record = {**colour.model_dump(exclude={"corrected_canonical_image_base64"}), "source_image_sha256": _sha(image_bytes),
                     "corrected_image_sha256": images[-1]["sha256_hash"] if colour.corrected_canonical_image_base64 else None}
    versions: List[Dict[str, Any]] = []
    if active_meas is not None and active_seg is not None:
        mask = cv2.imdecode(np.frombuffer(base64.b64decode(active_seg.canonical_mask_png_base64), np.uint8), cv2.IMREAD_GRAYSCALE)
        contract = {
            "canonical_width_px": session.geometry.canonical_width_px,
            "canonical_height_px": session.geometry.canonical_height_px,
            "inner_bounds_px": session.geometry.inner_bounds_px,
            "pixels_per_mm": session.ruler.pixels_per_mm,
            "calibration_id": session.request_id,
            "ruler": session.ruler.model_dump(),
            "selected_component_id": active_seg.selected_candidate_id,
            "selection_required": active_seg.status == "multiple_wounds_detected",
            "mask_sha256": mask_hash(mask), "model_source": source_model,
            "model_version": active_seg.model_version, "measurement_version": 1,
            "measurement_algorithm_version": active_meas.algorithm_version,
            "quality_gate": gate.model_dump(),
            "candidates": [c.model_dump() for c in active_seg.candidates],
            "sam_guidance": active_seg.sam_guidance,
            "colour_status": colour.status,
            "measurement_lines": measurement_lines(active_meas),
            "photo_coverage_px": session.geometry.photo_coverage_px,
        }
        versions.append({
            "measurement_id": "DEMO-MEAS-1", "version_number": 1, "measurement_stage": "PROVISIONAL_AI",
            "source_model": source_model, "was_human_corrected": 0, "source_measurement_id": None,
            "area_cm2": active_meas.area_cm2, "length_cm": active_meas.length_cm, "width_cm": active_meas.width_cm,
            "clinical_length_cm": active_meas.clinical_length_cm, "clinical_width_cm": active_meas.clinical_width_cm,
            "perimeter_cm": active_meas.perimeter_cm, "length_method": active_meas.length_method,
            "width_method": active_meas.width_method, "pixels_per_mm": session.ruler.pixels_per_mm,
            "boundary_px_json": json.dumps(active_seg.canonical_boundary_px), "geometry": contract,
            "created_by_subject": DEMO_SUBJECT, "created_at_utc": now,
        })
    measured = bool(versions) and gate.status != "RETAKE_REQUIRED"
    working = versions[-1] if versions else None
    return {
        "observation_id": obs_id, "patient_id": "DEMO-PATIENT", "wound_id": "DEMO-WOUND",
        "session_request_id": session.request_id, "capture_datetime_utc": now,
        "uploading_user_subject": DEMO_SUBJECT, "uploading_user_role": "CLINICIAN", "capture_location_category": "HOSPITAL",
        "image_quality_status": session.error_code or session.image_quality.status,
        "quality_gate_status": gate.status, "ai_segmentation_provenance": "ai_predicted",
        "meta_execution_status": gate.meta_execution_status,
        "review_state": "AWAITING_CLINICAL_REVIEW" if measured else "RETAKE_REQUESTED",
        "review_notes": None if measured else (session.message or "No measurement could be produced."),
        "capture_quality_reason": None if measured else (session.error_code if session.error_code in ("no_wound_detected", "wound_outside_photo") else "image_quality"),
        "measurements_versions": versions, "record_working_measurement": working, "provisional_or_working_measurement": working,
        "approved_measurement": None, "clinical_assessments_versions": [], "latest_clinical_assessment": None,
        "caregiver_report": None,
        "ai_explanation": explanation.model_dump(mode="json") if explanation is not None else None,
        "draft_status": "current" if explanation is not None else "none",
        "images": images, "colour_calibration": colour_record, "ai_visual_observations": [],
        "provisional_hidden_for_non_clinician": False, "image_integrity_verified": True,
        "record_revision": 0, "record_draft": {}, "record_history": [], "record_base_assessment_id": None,
        "synthetic_demo_image": None,
    }


@router.get("/status")
def demo_status():
    if (off := _disabled()) is not None:
        return off
    return _json({"demo_mode": True, "pipeline_ready": True, "meta": _meta_status(),
                  "keeps_photos": care_service.settings.demo_keep_photos})


@router.post("/measure")
def demo_measure(body: MeasureRequest):
    if (off := _disabled()) is not None:
        return off
    try:
        image_bytes = _b64(body.image_base64, care_service.settings.max_upload_bytes)
    except ProcessingFailure as exc:
        return _json({"code": exc.code, "message": exc.message}, exc.status_code)
    if not _slots.acquire(timeout=QUEUE_WAIT_SECONDS):
        return _json({"code": "BUSY", "message": f"{MAX_PARALLEL} demo measurements are already running. Try again in a minute."}, 429)
    try:
        meta = _meta_status()
        # As the real capture: YOLO and Meta SAM 3.1 compared, SAM preferred when it succeeds.
        try:
            session = pipeline.process(image_bytes, segmentation_mode="compare" if meta["enabled"] else "yolo",
                                       include_ai_explanation=False)
        except ProcessingFailure as exc:
            # As the real capture: a calibration failure becomes a retake request, nothing measured.
            record = {
                "observation_id": f"DEMO-OBS-{uuid4().hex[:8].upper()}", "patient_id": "DEMO-PATIENT", "wound_id": "DEMO-WOUND",
                "capture_datetime_utc": _now(), "uploading_user_subject": DEMO_SUBJECT, "uploading_user_role": "CLINICIAN",
                "capture_location_category": "HOSPITAL", "image_quality_status": exc.code, "quality_gate_status": "RETAKE_REQUIRED",
                "ai_segmentation_provenance": "calibration_rejected", "meta_execution_status": "quality_gate_halted",
                "review_state": "RETAKE_REQUESTED", "review_notes": f"Quality Gate Rejected ({exc.code}): {exc.message}",
                "measurements_versions": [], "clinical_assessments_versions": [], "images": [],
                "provisional_hidden_for_non_clinician": False,
            }
            diagnostics = _diagnose(image_bytes, exc)
            kept = _keep_photo(record["observation_id"], image_bytes, failure=diagnostics)
            return _json({"record": record, "meta": meta, "diagnostics": diagnostics, "kept_photo": kept, "stored": False})
        # As the real capture, the draft note is not written here; the page asks /explain afterwards so
        # the record opens as soon as segmentation is done. These are the facts it is written from.
        context = pipeline.explanation_context(session) if session.measurements is not None else None
        record = _record(session, image_bytes, None)
        kept = _keep_photo(record["observation_id"], image_bytes, session=session)
        return _json({"record": record, "explain_context": context, "meta": meta, "kept_photo": kept, "stored": False})
    except Exception:
        logger.exception("Demo measurement failed")
        return _json({"code": "PROCESSING_ERROR", "message": "The photo could not be measured."}, 500)
    finally:
        _slots.release()


class ExplainRequest(BaseModel):
    context: Dict[str, Any]


@router.post("/explain")
def demo_explain(body: ExplainRequest):
    """The draft note for the AI measurement: Muse Spark, or the labelled deterministic summary when Meta AI is off."""
    if (off := _disabled()) is not None:
        return off
    allowed = {"measurement_status", "area_cm2", "length_cm", "width_cm", "perimeter_cm", "calibration_status",
               "ruler_length_cm", "segmentation_model", "boundary_provenance", "human_review_status",
               "quality_warnings", "model_comparison", "historical_delta"}
    context = {k: v for k, v in body.context.items() if k in allowed}
    return _json(pipeline.meta_client.explain_measurements_with_muse(context).model_dump(mode="json"))


# ---- Boundary editing ---------------------------------------------------------------------------------

class PreviewRequest(BaseModel):
    geometry: Dict[str, Any]
    base_measurement_id: str = "DEMO-MEAS-1"
    edited_boundary_px: List[List[float]]


@router.post("/preview")
def demo_preview(body: PreviewRequest):
    if (off := _disabled()) is not None:
        return off
    try:
        g = _check_geometry(body.geometry)
        mask = strict_polygon_mask(body.edited_boundary_px, g["canonical_width_px"], g["canonical_height_px"], g["inner_bounds_px"])
        if reaches_outside_photo(mask, g.get("photo_coverage_px"), g["pixels_per_mm"]):
            raise ValueError("The boundary reaches the part of the ruler's square that is outside the photo. Keep it inside the photo.")
        m = calculate_measurements(mask, g["pixels_per_mm"])
    except ValueError as exc:
        return _json({"code": "VALIDATION_ERROR", "message": str(exc)}, 422)
    return _json({
        "base_measurement_id": body.base_measurement_id, "pixels_per_mm": g["pixels_per_mm"],
        "area_cm2": round(m.area_cm2, 4), "length_cm": round(m.length_cm, 4), "width_cm": round(m.width_cm, 4),
        "clinical_length_cm": round(m.clinical_length_cm, 4), "clinical_width_cm": round(m.clinical_width_cm, 4),
        "perimeter_cm": round(m.perimeter_cm, 4), "lines": measurement_lines(m), "saved": False,
    })


class RefineRequest(BaseModel):
    geometry: Dict[str, Any]
    base_measurement_id: str
    next_version: int
    image_quality_status: str = "valid"
    edited_boundary_px: Optional[List[List[float]]] = None
    selected_candidate_id: Optional[int] = None
    measurement_region: Optional[str] = None


@router.post("/refine")
def demo_refine(body: RefineRequest):
    """Done editing: the new HUMAN_CORRECTED version the real refine creates, returned instead of stored."""
    if (off := _disabled()) is not None:
        return off
    try:
        if body.measurement_region is not None and body.measurement_region not in MEASUREMENT_REGIONS:
            raise ValueError("Measurement region must be whole_wound or red_tissue.")
        contract = _check_geometry(body.geometry)
        width, height = contract["canonical_width_px"], contract["canonical_height_px"]
        inner_bounds, ppm = contract["inner_bounds_px"], contract["pixels_per_mm"]
        if body.selected_candidate_id is not None:
            if body.edited_boundary_px is not None:
                raise ValueError("Select a component or edit its boundary, not both in one request.")
            candidate = next((c for c in contract.get("candidates", []) if c.get("candidate_id") == body.selected_candidate_id), None)
            if candidate is None or not candidate.get("canonical_mask_png_base64"):
                raise ValueError("Selected component does not exist in this measurement version.")
            new_mask = cv2.imdecode(np.frombuffer(base64.b64decode(candidate["canonical_mask_png_base64"]), np.uint8), cv2.IMREAD_GRAYSCALE)
            if new_mask is None or new_mask.shape != (height, width):
                raise ValueError("Stored component geometry is invalid. Recapture.")
            candidate_region = BOUNDARY_KIND_REGION.get(candidate.get("boundary_kind"))
            if body.measurement_region and candidate_region and body.measurement_region != candidate_region:
                raise ValueError("The selected candidate measures a different region; choose the matching candidate.")
            region = candidate_region or body.measurement_region
        else:
            new_mask = strict_polygon_mask(body.edited_boundary_px, width, height, inner_bounds)
            region = body.measurement_region or contract.get("measurement_region")
        if reaches_outside_photo(new_mask, contract.get("photo_coverage_px"), ppm):
            raise ValueError("The boundary reaches the part of the ruler's square that is outside the photo. Keep it inside the photo.")
        m = calculate_measurements(new_mask, ppm)
        gate = corrected_gate(contract.get("quality_gate", {}), new_mask, inner_bounds, body.image_quality_status)
    except ValueError as exc:
        return _json({"code": "VALIDATION_ERROR", "message": str(exc)}, 422)
    contract = {**contract, "mask_sha256": mask_hash(new_mask), "measurement_version": body.next_version,
                "selected_component_id": body.selected_candidate_id, "selection_required": False, "quality_gate": gate,
                "measurement_region": region, "measurement_lines": measurement_lines(m)}
    return _json({
        "measurement": {
            "measurement_id": f"DEMO-MEAS-{body.next_version}", "source_measurement_id": body.base_measurement_id,
            "version_number": body.next_version, "measurement_stage": "HUMAN_CORRECTED",
            "source_model": f"{contract.get('model_source')}+human_corrected", "was_human_corrected": 1,
            "area_cm2": round(m.area_cm2, 4), "length_cm": round(m.length_cm, 4), "width_cm": round(m.width_cm, 4),
            "clinical_length_cm": round(m.clinical_length_cm, 4), "clinical_width_cm": round(m.clinical_width_cm, 4),
            "perimeter_cm": round(m.perimeter_cm, 4), "length_method": "maximum_vertical_chord",
            "width_method": "maximum_horizontal_chord", "pixels_per_mm": ppm,
            "boundary_px_json": json.dumps(contour_from_mask(new_mask)), "geometry": contract,
            "created_by_subject": DEMO_SUBJECT, "created_at_utc": _now(),
        },
        "quality_gate_status": gate["status"], "saved": False,
    })


# ---- AI assistance -----------------------------------------------------------------------------------

def _meta_unavailable(feature: str) -> JSONResponse:
    return _json({"code": "META_AI_UNAVAILABLE", "message": f"{feature} needs Meta AI, which is not enabled on this server."}, 503)


class ObservationsRequest(BaseModel):
    observation_id: str
    version_number: int = 1
    measurement: Dict[str, Any]
    colour_calibration: Optional[Dict[str, Any]] = None
    canonical_image_base64: str
    corrected_image_base64: Optional[str] = None


@router.post("/ai-observations")
def demo_ai_observations(body: ObservationsRequest):
    """Muse Spark visual findings, built like generate_visual_observations, returned instead of stored."""
    if (off := _disabled()) is not None:
        return off
    s = care_service.settings
    if not (s.meta_configured and s.meta_observations_enabled):
        return _meta_unavailable("AI visual observations")
    working = body.measurement
    try:
        _check_geometry(working.get("geometry") or {})
        boundary = json.loads(working.get("boundary_px_json") or "[]")
        colour = body.colour_calibration or {}
        colour_allowed = bool(colour.get("colour_interpretation_allowed"))
        use_corrected = bool(colour_allowed and body.corrected_image_base64)
        source = _b64(body.corrected_image_base64 if use_corrected else body.canonical_image_base64, s.max_upload_bytes)
        image = cv2.imdecode(np.frombuffer(source, np.uint8), cv2.IMREAD_COLOR)
        if image is None:
            raise ValueError("The calibrated review image is not available.")
    except ProcessingFailure as exc:
        return _json({"code": exc.code, "message": exc.message}, exc.status_code)
    except ValueError as exc:
        return _json({"code": "VALIDATION_ERROR", "message": str(exc)}, 422)
    jpeg = ClinicalAIService._wound_view(image, boundary)
    context = {
        "image": ("Crop of the perspective-corrected photograph around the wound. The AprilTag ruler was detected by "
                  "software and lies outside this crop; scale is not your concern."),
        "wound": {"site": "not recorded (demo)", "laterality": "not recorded (demo)", "type_recorded_at_registration": "not recorded (demo)"},
        "latest_clinician_signed_classification": None,
        "deterministic_measurements": {k: working.get(k) for k in ("area_cm2", "length_cm", "width_cm", "perimeter_cm")},
        "colour_calibration_status": colour.get("status", "not recorded"),
        "caregiver_report": None,
    }
    rule = COLOUR_RULES["unavailable" if not colour_allowed else ("unverified" if colour.get("status") == "UNVERIFIED_REFERENCE" else "verified")]
    messages = [
        {"role": "system", "content": OBSERVATION_SYSTEM_PROMPT.format(colour_rule=rule)},
        {"role": "user", "content": [
            {"type": "text", "text": "Context (JSON):\n" + json.dumps(context, ensure_ascii=False)},
            {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64," + base64.b64encode(jpeg).decode("ascii")}},
        ]},
    ]
    try:
        raw, latency = pipeline.meta_client.muse_structured(messages, OBSERVATION_SCHEMA, "wound_visual_observations")
    except MetaApiError as exc:
        return _json({"code": "META_AI_UNAVAILABLE", "message": f"Muse Spark did not return observations ({exc.message}). Nothing was saved."}, 503)
    findings, flags = guard_visual_findings(raw, colour_allowed)
    return _json({
        "ai_observation_id": f"DEMO-AIO-{uuid4().hex[:8].upper()}", "observation_id": body.observation_id,
        "version_number": body.version_number, "status": "AI_DRAFT", "model_id": s.meta_reasoning_model,
        "input": {"image_role": "COLOUR_CORRECTED" if use_corrected else "CANONICAL_RECTIFIED",
                  "colour_status": colour.get("status", "not recorded"), "colour_interpretation_allowed": colour_allowed},
        "findings": findings, "guard_flags": flags, "clinician_findings": None, "clinician_notes": None,
        "latency_ms": round(latency, 1), "created_by_subject": DEMO_SUBJECT, "created_at_utc": _now(),
        "reviewed_by_subject": None, "reviewed_at_utc": None,
    })


class ReviseRequest(BaseModel):
    draft_type: str
    text: str
    instruction: str
    base_text: str = ""
    history: Optional[List[str]] = None
    field: Optional[str] = None
    measurement: Optional[Dict[str, Any]] = None


@router.post("/ai-revise")
def demo_ai_revise(body: ReviseRequest):
    """Ask AI: a suggested rewording, built like revise_draft, with a demo context instead of a patient record."""
    if (off := _disabled()) is not None:
        return off
    s = care_service.settings
    if not (s.meta_configured and s.meta_assistant_enabled):
        return _meta_unavailable("Ask AI")
    text, instruction, base_text = body.text.strip(), body.instruction.strip(), body.base_text.strip()
    if body.draft_type not in REVISION_TYPE_RULES:
        return _json({"code": "VALIDATION_ERROR", "message": "Unsupported draft type."}, 422)
    if not text:
        return _json({"code": "VALIDATION_ERROR", "message": "There is no text to revise yet."}, 422)
    if not instruction:
        return _json({"code": "VALIDATION_ERROR", "message": "Say what should change."}, 422)
    m = body.measurement or {}
    context = {"patient_reference": "DEMO (no patient)", "wound": {"code": "DEMO", "site": "not recorded (demo)", "laterality": "not recorded (demo)"},
               "current_measurement": {k: m.get(k) for k in ("area_cm2", "length_cm", "width_cm", "perimeter_cm", "measurement_stage")}}
    payload = {"current_text": {"untrusted_text": text[:6000]}}
    if base_text and base_text != text:
        payload["text_before_earlier_suggestions"] = {"untrusted_text": base_text[:6000]}
    earlier = [str(h).strip()[:300] for h in (body.history or [])[-5:] if str(h).strip()]
    messages = [
        {"role": "system", "content": REVISION_SYSTEM_PROMPT.format(type_rule=REVISION_TYPE_RULES[body.draft_type])},
        {"role": "user", "content": "Record (JSON, de-identified):\n" + json.dumps(context, ensure_ascii=False)
         + "\n\nText to revise (JSON):\n" + json.dumps(payload, ensure_ascii=False)
         + ("\n\nEarlier instructions in this conversation, already applied to current_text:\n- " + "\n- ".join(earlier) if earlier else "")
         + "\n\nThe clinician's instruction:\n" + instruction[:1000]},
    ]
    try:
        raw, latency = pipeline.meta_client.muse_structured(messages, REVISION_SCHEMA, "draft_revision")
    except MetaApiError as exc:
        return _json({"code": "META_AI_UNAVAILABLE", "message": f"Muse Spark did not suggest a revision ({exc.message}). Nothing was changed."}, 503)
    suggestion = str(raw.get("revised_text") or "").strip()[:6000]
    if not suggestion:
        return _json({"code": "EMPTY_SUGGESTION", "message": "Muse Spark returned no text. Nothing was changed."}, 503)
    return _json({"revision_id": f"DEMO-AIR-{uuid4().hex[:8].upper()}", "draft_type": body.draft_type, "suggestion": suggestion,
                  "change_summary": str(raw.get("change_summary") or "").strip()[:300],
                  "flags": revision_flags(suggestion, [text, base_text], context, body.draft_type),
                  "model": s.meta_reasoning_model, "latency_ms": round(latency, 1),
                  "notice": "AI suggestion. Nothing has changed: compare it, then use, edit or discard it."})
