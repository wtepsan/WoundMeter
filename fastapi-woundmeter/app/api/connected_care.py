from __future__ import annotations

import base64
import binascii
from app.services import postgres as db
import logging
from app.services.database_storage import DatabaseStorageError
from typing import Any, Dict, List, Literal, Optional

from fastapi import APIRouter, Body, Header, Query, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, StrictBool

from app.api.wound_measure import pipeline
from app.config import settings
from app.services.auth_service import AuthService, SessionIdentity
from app.services.connected_care_db import (
    AccessDeniedError,
    AttestationRequiredError,
    ConnectedCareService,
    ClinicalConflictError,
    SubmissionPendingError,
    SubmissionFailedError,
    DuplicatePatientError,
    RateLimitedError,
    RecordConflictError,
    make_incomplete_ruler_image_bytes,
)
from app.services.demo_assets import COLOUR_STRIP_DEMO_IMAGE, read_demo_asset
from app.services.errors import ProcessingFailure
from app.services.review_workflow import DEMO_CLINICAL_ACCOUNTS


router = APIRouter(prefix="/v2/care", tags=["connected-care"])
care_service = ConnectedCareService(settings)


def record_lifecycle_service():
    from app.services.record_lifecycle import RecordLifecycleService
    from app.api.nursing import nursing_service
    return RecordLifecycleService(care_service, nursing_service if nursing_service.care is care_service else None)


class RecordReasonRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    actor_subject: Optional[str] = None
    reason: str = Field(min_length=1, max_length=1000)


class DeleteRecordRequest(RecordReasonRequest):
    expected_status: str = Field(min_length=1, max_length=80)


@router.post("/records/{record_type}/{record_id}/delete")
async def delete_record(record_type: Literal["observation", "report", "wound"], record_id: str,
                        body: DeleteRecordRequest, x_reviewer_token: Optional[str] = Header(default=None)):
    try:
        actor = _resolve_actor_subject(x_reviewer_token, body.actor_subject)
        return _json(record_lifecycle_service().delete(actor_subject=actor, record_type=record_type,
            record_id=record_id, reason=body.reason, expected_status=body.expected_status))
    except Exception as exc:
        return _error(exc)


@router.get("/patients/{patient_id}/deleted-records")
async def deleted_records(patient_id: str, actor_subject: Optional[str] = Query(default=None),
                          x_reviewer_token: Optional[str] = Header(default=None)):
    try:
        actor = _resolve_actor_subject(x_reviewer_token, actor_subject)
        return _json({"records": record_lifecycle_service().list_deleted(actor_subject=actor, patient_id=patient_id)})
    except Exception as exc:
        return _error(exc)


@router.post("/deleted-records/{deletion_id}/authorize-restore")
async def authorize_restore(deletion_id: str, body: RecordReasonRequest,
                            x_reviewer_token: Optional[str] = Header(default=None)):
    try:
        actor = _resolve_actor_subject(x_reviewer_token, body.actor_subject)
        return _json(record_lifecycle_service().authorize_restore(actor_subject=actor, deletion_id=deletion_id, reason=body.reason))
    except Exception as exc:
        return _error(exc)


def _json(body: Any, status_code: int = 200) -> JSONResponse:
    return JSONResponse(
        status_code=status_code,
        content=body,
        headers={"Cache-Control": "no-store"},
    )


class AuthenticationRequired(Exception):
    def __init__(self, code: str = "AUTHENTICATION_REQUIRED", message: str = "Sign in to continue."):
        super().__init__(message)
        self.code = code
        self.message = message


def resolve_identity(x_reviewer_token: Optional[str]) -> Optional[SessionIdentity]:
    """Server-side session lookup. The token is opaque; identity comes only from the session store."""
    if not x_reviewer_token:
        return None
    identity = AuthService(care_service).resolve(x_reviewer_token)
    if identity is None:
        raise AuthenticationRequired("INVALID_AUTH_TOKEN", "Your session has expired. Please sign in again.")
    return identity


def _resolve_actor_subject(
    x_reviewer_token: Optional[str],
    explicit_actor_subject: Optional[str],
) -> str:
    identity = resolve_identity(x_reviewer_token)
    if identity:
        return identity.subject
    # Unsigned identities are accepted only by the isolated test configuration.
    if care_service.settings.allow_unsigned_actor_subject and explicit_actor_subject:
        return explicit_actor_subject.strip()
    raise AuthenticationRequired()


def _require_demo_admin(x_reviewer_token: Optional[str]) -> None:
    if not care_service.settings.demo_mode:
        raise AccessDeniedError("DEMO_DISABLED", "Demo tools are disabled.")
    identity = resolve_identity(x_reviewer_token)
    if identity is None and care_service.settings.allow_unsigned_actor_subject:
        return
    if identity is None:
        raise AuthenticationRequired()
    if identity.role != "ADMIN":
        raise AccessDeniedError("ADMIN_REQUIRED", "Only an administrator can manage demo data.")


def _error(exc: Exception) -> JSONResponse:
    if isinstance(exc, (DatabaseStorageError, db.DatabaseError)):
        logging.getLogger(__name__).error("Database request failed: %s", exc)
        query_error = isinstance(exc, db.OperationalError) and any(
            reason in str(exc).lower() for reason in ("no such column", "no such table", "syntax error"))
        return _json({"code": "DATABASE_QUERY_FAILED" if query_error else "DATABASE_UNAVAILABLE",
                      "message": "Database query failed; check the deployed schema." if query_error else
                      "Database storage is unavailable. Check backend storage diagnostics and RESULTS_DIR."},
                     500 if query_error else 503)
    if isinstance(exc, AuthenticationRequired):
        return _json({"code": exc.code, "message": exc.message}, 401)
    if isinstance(exc, DuplicatePatientError):
        return _json({"code": exc.code, "message": exc.message, "duplicates": exc.duplicates}, 409)
    if isinstance(exc, RecordConflictError):
        return _json({"code": exc.code, "message": exc.message}, 409)
    if isinstance(exc, RateLimitedError):
        return _json({"code": "RATE_LIMITED", "message": str(exc)}, 429)
    if isinstance(exc, AccessDeniedError):
        return _json({"code": exc.code, "message": exc.message}, 403)
    if isinstance(exc, PermissionError):
        return _json({"code": "ALREADY_APPROVED", "message": str(exc)}, 409)
    if isinstance(exc, KeyError):
        return _json({"code": "NOT_FOUND", "message": str(exc).strip("'\"")}, 404)
    if isinstance(exc, ClinicalConflictError):
        return _json({"code": "CLINICAL_CONFLICT", "message": str(exc)}, 409)
    if isinstance(exc, SubmissionPendingError):
        return _json({"code": "SUBMISSION_PROCESSING", "message": str(exc)}, 409)
    if isinstance(exc, SubmissionFailedError):
        return _json({"code": "SUBMISSION_FAILED", "message": str(exc)}, 503)
    if isinstance(exc, ProcessingFailure):
        return _json({"code": exc.code, "message": exc.message}, exc.status_code)
    if isinstance(exc, AttestationRequiredError):
        return _json({"code": "ATTESTATION_REQUIRED", "message": str(exc), "missing_attestations": exc.missing}, 422)
    if isinstance(exc, ValueError):
        return _json({"code": "VALIDATION_ERROR", "message": str(exc)}, 422)
    raise exc


class RegisterPatientRequest(BaseModel):
    actor_subject: Optional[str] = None
    patient_code: Optional[str] = None
    display_name: Optional[str] = None
    full_name: Optional[str] = None
    date_of_birth: Optional[str] = None
    national_id: Optional[str] = None
    no_national_id_reason: Optional[str] = None
    hospital_number: Optional[str] = None
    contact_phone: Optional[str] = None
    age_group: str = "65_74"
    sex: str = "UNSPECIFIED"
    ward_code: Optional[str] = None
    patient_account_subject: Optional[str] = None
    assign_homecare_subject: Optional[str] = None
    confirm_not_duplicate: bool = False
    duplicate_override_reason: Optional[str] = None


class UpdatePatientIdentityRequest(BaseModel):
    actor_subject: Optional[str] = None
    reason: str = ""
    full_name: Optional[str] = None
    display_name: Optional[str] = None
    date_of_birth: Optional[str] = None
    national_id: Optional[str] = None
    no_national_id_reason: Optional[str] = None
    hospital_number: Optional[str] = None
    contact_phone: Optional[str] = None
    sex: Optional[str] = None
    age_group: Optional[str] = None


class DuplicateCheckRequest(BaseModel):
    full_name: str = ""
    date_of_birth: Optional[str] = None
    national_id: Optional[str] = None
    hospital_number: Optional[str] = None


class PatientSearchRequest(BaseModel):
    search_type: Literal["NATIONAL_ID", "HN", "NAME", "REFERENCE"]
    query: str
    date_of_birth: Optional[str] = None


class CreateWoundRequest(BaseModel):
    actor_subject: Optional[str] = None
    wound_id: Optional[str] = None
    anatomical_site: str = "SACRUM"
    laterality: str = "MIDLINE"
    wound_type: str = "PRESSURE_INJURY"
    pressure_injury_stage: str = "STAGE_3"


class CreateAccessGrantRequest(BaseModel):
    actor_subject: Optional[str] = None
    grantee_subject: str = "caregiver.suda"
    wound_id: Optional[str] = None
    permissions: Optional[List[str]] = None
    auto_accept: bool = True
    expires_in_days: int = 90
    legal_basis_note: str = (
        "Patient/representative sharing authorisation recorded for home monitoring; "
        "clinical data processing governed separately under institutional healthcare delivery basis."
    )


class RevokeGrantRequest(BaseModel):
    actor_subject: Optional[str] = None
    reason: str = "Access grant revoked by patient or clinical care team."


class SubmitObservationRequest(BaseModel):
    corrects_observation_id: Optional[str] = None
    correction_reason: str = Field(default="", max_length=512)
    submission_id: Optional[str] = Field(default=None, max_length=128, pattern=r"^[a-zA-Z0-9_.-]+$")
    actor_subject: Optional[str] = None
    capture_location_category: Literal["HOSPITAL", "HOME", "COMMUNITY"] = "HOME"
    segmentation_mode: Literal["yolo", "sam", "compare"] = "compare"
    sam_prompt: str = "wound"
    image_base64: Optional[str] = None
    image_variant: Literal["hospital_baseline", "home_followup_day4", "incomplete_ruler", "colour_strip_phantom"] = "home_followup_day4"
    pain_score_0_10: Optional[int] = Field(default=3, ge=0, le=10)
    odor_observed: bool = False
    dressing_intact: bool = True
    redness_around_wound: bool = False
    drainage_change: bool = False
    fever_or_chills: bool = False
    concern_flag: bool = False
    non_diagnostic_notes: str = ""
    capture_datetime_override_utc: Optional[str] = None
    drainage_level: Optional[Literal["NONE", "SMALL", "MODERATE", "LARGE", "UNSURE"]] = None
    dressing_condition: Optional[Literal["INTACT", "LOOSE", "WET", "OTHER", "UNSURE"]] = None
    redness_observed: Optional[Literal["YES", "NO", "UNSURE"]] = None
    concern_reported: bool = False


class RefineObservationMaskRequest(BaseModel):
    amends_assessment_id: Optional[str] = None
    expected_measurement_id: Optional[str] = None
    selected_candidate_id: Optional[int] = None
    actor_subject: Optional[str] = None
    edited_boundary_px: Optional[List[List[float]]] = None
    nudge_outward_px: int = 2
    correction_notes: str = "Clinician refined Meta SAM 3.1 boundary at wound margin."
    measurement_region: Optional[Literal["whole_wound", "red_tissue"]] = None


class MeasurePreviewRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    actor_subject: Optional[str] = None
    edited_boundary_px: List[List[float]] = Field(min_length=3, max_length=4000)
    expected_measurement_id: Optional[str] = None


class ApprovalAttestations(BaseModel):
    """The four sign-off confirmations. Each must be sent as JSON true; nothing defaults to true."""

    model_config = ConfigDict(extra="forbid")

    photo_reviewed: Optional[StrictBool] = None
    boundary_verified: Optional[StrictBool] = None
    measurements_reviewed: Optional[StrictBool] = None
    assessment_reviewed: Optional[StrictBool] = None


class ReviewObservationRequest(BaseModel):
    amends_assessment_id: Optional[str] = None
    amendment_reason: Optional[str] = Field(default=None, max_length=512)
    expected_record_revision: Optional[int] = Field(default=None, ge=0)
    factual_fields: Optional[Dict[str, Any]] = None
    actor_subject: Optional[str] = None
    decision: Optional[Literal["approve", "request_retake", "reject"]] = None
    approval_request_id: Optional[str] = None
    expected_measurement_id: Optional[str] = None
    expected_measurement_version: Optional[int] = None
    reviewer_attested: StrictBool = False
    attestations: Optional[ApprovalAttestations] = None
    wound_type: Optional[str] = None
    pressure_injury_stage: Optional[str] = None
    diagnosis: Optional[str] = None
    wound_bed_appearance: Optional[str] = None
    exudate_amount: Optional[str] = None
    surrounding_skin: Optional[str] = None
    wound_trend: Optional[str] = None
    sensory_perception: Optional[int] = Field(default=None, ge=1, le=4)
    moisture: Optional[int] = Field(default=None, ge=1, le=4)
    activity: Optional[int] = Field(default=None, ge=1, le=4)
    mobility: Optional[int] = Field(default=None, ge=1, le=4)
    nutrition: Optional[int] = Field(default=None, ge=1, le=4)
    friction_and_shear: Optional[int] = Field(default=None, ge=1, le=3)
    clinical_interpretation: Optional[str] = None
    care_decisions: Optional[str] = None
    ai_draft_disposition: Optional[str] = None
    final_documentation_text: Optional[str] = None
    review_notes: Optional[str] = None
    # Ask AI suggestions applied to the record's text fields before signing (provenance only).
    ai_revision_ids: Optional[List[str]] = Field(default=None, max_length=20)


class AmendClinicalAssessmentRequest(BaseModel):
    actor_subject: Optional[str] = None
    amendment_reason: str
    updated_clinical_interpretation: str
    updated_final_documentation_text: str
    updated_wound_trend: Optional[str] = None


class CreateCarePlanRequest(BaseModel):
    actor_subject: Optional[str] = None
    title: str = "Home Sacral Pressure Injury Care & Offloading Plan"
    purpose: str = "Protect granulating wound bed, maintain moisture balance, and monitor progression between clinic visits."
    approved_instructions: str = (
        "1. Keep gentle silicone foam dressing dry and intact.\n"
        "2. Reposition and offload sacral area every 2–3 hours using 30-degree wedge pillow.\n"
        "3. Capture calibrated follow-up photograph with the 18 cm AprilTag ruler every 3 days.\n"
        "4. Report new redness, odor, fever, or pain >= 6/10 through the Caregiver Portal."
    )
    assigned_caregiver_subject: str = ""
    task_frequency: str = "Daily offloading + Photo every 3 days"
    tasks: Optional[List[Dict[str, str]]] = None
    # Required when the approved instructions or frequency of the active plan change (audited).
    revision_reason: Optional[str] = Field(default=None, max_length=500)
    carry_over_tasks: bool = False
    ai_revision_ids: List[str] = Field(default_factory=list, max_length=20)
    expected_care_plan_id: Optional[str] = Field(default=None, max_length=80)


class CompleteCareTaskRequest(BaseModel):
    actor_subject: Optional[str] = None
    status: Literal["COMPLETED", "CONCERN_REPORTED"] = "COMPLETED"
    caregiver_notes: str = "Completed per clinician instructions; dressing clean and intact."


@router.get("/personas")
async def list_connected_care_personas():
    """Demo mode only: the fictional personas available for hospital, home-care, caregiver and patient roles."""
    if not care_service.settings.demo_mode:
        return _json({"personas": []}, 200)
    personas = [
        {
            "subject": sub,
            "display_name": info["display_name"],
            "role": info["role"],
            "org_id": info.get("org_id", "ORG-WARD01-HOSP"),
        }
        for sub, info in DEMO_CLINICAL_ACCOUNTS.items()
    ]
    return _json({"personas": personas}, 200)






@router.get("/patients")
async def list_patients(
    actor_subject: Optional[str] = Query(default=None),
    x_reviewer_token: Optional[str] = Header(default=None),
):
    try:
        actor = _resolve_actor_subject(x_reviewer_token, actor_subject)
        return _json({"patients": care_service.list_authorized_patients(actor_subject=actor)}, 200)
    except Exception as exc:
        return _error(exc)


@router.post("/patients/search")
async def search_patients_endpoint(
    body: PatientSearchRequest,
    x_reviewer_token: Optional[str] = Header(default=None),
):
    """POST so identifiers never appear in URLs or access logs."""
    try:
        actor = _resolve_actor_subject(x_reviewer_token, None)
        result = care_service.search_patients(
            actor_subject=actor,
            search_type=body.search_type,
            query=body.query,
            date_of_birth=body.date_of_birth,
        )
        return _json(result, 200)
    except Exception as exc:
        return _error(exc)


@router.post("/patients/duplicate-check")
async def duplicate_check_endpoint(
    body: DuplicateCheckRequest,
    x_reviewer_token: Optional[str] = Header(default=None),
):
    try:
        actor = _resolve_actor_subject(x_reviewer_token, None)
        result = care_service.check_duplicates(
            actor_subject=actor,
            full_name=body.full_name,
            date_of_birth=body.date_of_birth,
            national_id=body.national_id,
            hospital_number=body.hospital_number,
        )
        return _json(result, 200)
    except Exception as exc:
        return _error(exc)


@router.post("/patients")
async def register_patient_endpoint(
    body: RegisterPatientRequest,
    x_reviewer_token: Optional[str] = Header(default=None),
):
    try:
        actor = _resolve_actor_subject(x_reviewer_token, body.actor_subject)
        patient = care_service.register_patient(
            actor_subject=actor,
            patient_code=body.patient_code,
            display_name=body.display_name,
            full_name=body.full_name,
            date_of_birth=body.date_of_birth,
            national_id=body.national_id,
            no_national_id_reason=body.no_national_id_reason,
            hospital_number=body.hospital_number,
            contact_phone=body.contact_phone,
            age_group=body.age_group,
            sex=body.sex,
            ward_code=body.ward_code,
            patient_account_subject=body.patient_account_subject,
            assign_homecare_subject=body.assign_homecare_subject,
            confirm_not_duplicate=body.confirm_not_duplicate,
            duplicate_override_reason=body.duplicate_override_reason,
        )
        return _json(patient, 201)
    except Exception as exc:
        return _error(exc)


@router.get("/review-queue")
async def review_queue_endpoint(x_reviewer_token: Optional[str] = Header(default=None)):
    try:
        actor = _resolve_actor_subject(x_reviewer_token, None)
        return _json({"items": care_service.list_review_queue(actor_subject=actor)}, 200)
    except Exception as exc:
        return _error(exc)


@router.get("/patients/{patient_id}")
async def get_patient_record_endpoint(
    patient_id: str,
    actor_subject: Optional[str] = Query(default=None),
    x_reviewer_token: Optional[str] = Header(default=None),
):
    try:
        actor = _resolve_actor_subject(x_reviewer_token, actor_subject)
        record = care_service.get_patient_complete_record(actor_subject=actor, patient_id=patient_id)
        return _json(record, 200)
    except Exception as exc:
        return _error(exc)


@router.patch("/patients/{patient_id}")
async def update_patient_identity_endpoint(
    patient_id: str,
    body: UpdatePatientIdentityRequest,
    x_reviewer_token: Optional[str] = Header(default=None),
):
    """Identity corrections are separate from registration and need existing access to the patient."""
    try:
        actor = _resolve_actor_subject(x_reviewer_token, body.actor_subject)
        patient = care_service.update_patient_identity(
            actor_subject=actor,
            patient_id=patient_id,
            **body.model_dump(exclude={"actor_subject"}),
        )
        return _json(patient, 200)
    except Exception as exc:
        return _error(exc)


@router.post("/patients/{patient_id}/wounds")
async def create_wound_endpoint(
    patient_id: str,
    body: CreateWoundRequest,
    x_reviewer_token: Optional[str] = Header(default=None),
):
    try:
        actor = _resolve_actor_subject(x_reviewer_token, body.actor_subject)
        wound = care_service.create_wound(
            actor_subject=actor,
            patient_id=patient_id,
            wound_id=body.wound_id,
            anatomical_site=body.anatomical_site,
            laterality=body.laterality,
            wound_type=body.wound_type,
            pressure_injury_stage=body.pressure_injury_stage,
        )
        return _json(wound, 201)
    except Exception as exc:
        return _error(exc)


@router.post("/patients/{patient_id}/grants")
async def create_access_grant_endpoint(
    patient_id: str,
    body: CreateAccessGrantRequest,
    x_reviewer_token: Optional[str] = Header(default=None),
):
    try:
        actor = _resolve_actor_subject(x_reviewer_token, body.actor_subject)
        grant = care_service.create_and_accept_caregiver_grant(
            actor_subject=actor,
            patient_id=patient_id,
            grantee_subject=body.grantee_subject,
            wound_id=body.wound_id,
            permissions=body.permissions,
            auto_accept=body.auto_accept,
            expires_in_days=body.expires_in_days,
            legal_basis_note=body.legal_basis_note,
        )
        return _json(grant, 201)
    except Exception as exc:
        return _error(exc)


@router.post("/grants/{grant_id}/revoke")
async def revoke_access_grant_endpoint(
    grant_id: str,
    body: RevokeGrantRequest = Body(default_factory=RevokeGrantRequest),
    x_reviewer_token: Optional[str] = Header(default=None),
):
    try:
        actor = _resolve_actor_subject(x_reviewer_token, body.actor_subject)
        revoked = care_service.revoke_access_grant(actor_subject=actor, grant_id=grant_id, reason=body.reason)
        return _json(revoked, 200)
    except Exception as exc:
        return _error(exc)


@router.post("/patients/{patient_id}/wounds/{wound_id}/observations")
def submit_observation_endpoint(
    patient_id: str,
    wound_id: str,
    body: SubmitObservationRequest = Body(default_factory=SubmitObservationRequest),
    x_reviewer_token: Optional[str] = Header(default=None),
):
    if pipeline is None:
        return _json({"code": "PIPELINE_NOT_READY", "message": "Measurement pipeline not configured."}, 503)
    try:
        actor = _resolve_actor_subject(x_reviewer_token, body.actor_subject)
        if body.corrects_observation_id:
            if body.capture_datetime_override_utc:
                raise ValueError("Photo corrections retain their new capture time; backdating is not permitted.")
            original = care_service.photo_correction_context(actor,body.corrects_observation_id)
            if not body.correction_reason.strip():
                raise ValueError('A matching original record and correction reason are required.')
            # Resolve both aliases before any new image is saved.
            with care_service._connect() as conn:
                _, patient = care_service.authorize_patient_access(conn,actor,patient_id,wound_id=original['wound_id'],required_permission='UPLOAD_HOME_PHOTO')
                wound = care_service._resolve_wound(conn,patient['patient_id'],wound_id)
                if (patient['patient_id'], wound['wound_id']) != (original['patient_id'],original['wound_id']):
                    raise ValueError('Photo corrections must use the original patient and wound.')
        if body.image_base64:
            raw_b64 = body.image_base64
            if "," in raw_b64:
                raw_b64 = raw_b64.split(",", 1)[1]
            if len(raw_b64) > 4 * ((care_service.settings.max_upload_bytes + 2) // 3):
                raise ProcessingFailure("file_too_large", "The selected image is too large.", status_code=413)
            try:
                img_bytes = base64.b64decode(raw_b64, validate=True)
            except (binascii.Error, ValueError) as exc:
                raise ValueError("The image must be valid base64 data.") from exc
        else:
            if not care_service.settings.demo_mode:
                raise ValueError("Attach a photograph.")
            base_bytes = _find_demo_sample_bytes()
            if body.image_variant == "incomplete_ruler":
                img_bytes = make_incomplete_ruler_image_bytes(base_bytes)
            elif body.image_variant == "colour_strip_phantom":
                img_bytes = read_demo_asset(COLOUR_STRIP_DEMO_IMAGE)
            elif body.image_variant == "home_followup_day4":
                img_bytes = _find_demo_followup_bytes()
            else:
                img_bytes = base_bytes

        obs = care_service.submit_wound_observation(
            submission_id=body.submission_id,
            corrects_observation_id=body.corrects_observation_id,
            correction_reason=body.correction_reason,
            actor_subject=actor,
            patient_id=patient_id,
            wound_id=wound_id,
            image_bytes=img_bytes,
            capture_location_category=body.capture_location_category,
            segmentation_mode=body.segmentation_mode,
            sam_prompt=body.sam_prompt,
            pain_score_0_10=body.pain_score_0_10,
            odor_observed=body.odor_observed,
            dressing_intact=body.dressing_intact,
            redness_around_wound=body.redness_around_wound,
            drainage_change=body.drainage_change,
            fever_or_chills=body.fever_or_chills,
            concern_flag=body.concern_flag,
            non_diagnostic_notes=body.non_diagnostic_notes,
            pipeline=pipeline,
            capture_datetime_override_utc=body.capture_datetime_override_utc,
            drainage_level=body.drainage_level,
            dressing_condition=body.dressing_condition,
            redness_observed=body.redness_observed,
            concern_reported=body.concern_reported,
        )
        return _json(obs, 201)
    except Exception as exc:
        return _error(exc)


@router.get("/patients/{patient_id}/wounds/{wound_id}/submissions/{submission_id}")
def submission_status_endpoint(patient_id: str, wound_id: str, submission_id: str,
                               actor_subject: Optional[str] = Query(default=None),
                               x_reviewer_token: Optional[str] = Header(default=None)):
    try:
        actor = _resolve_actor_subject(x_reviewer_token, actor_subject)
        return _json(care_service.submission_status(actor_subject=actor, patient_id=patient_id, wound_id=wound_id, submission_id=submission_id))
    except Exception as exc:
        return _error(exc)


@router.post("/observations/{observation_id}/refine-mask")
async def refine_observation_mask_endpoint(
    observation_id: str,
    body: RefineObservationMaskRequest = Body(default_factory=RefineObservationMaskRequest),
    x_reviewer_token: Optional[str] = Header(default=None),
):
    try:
        actor = _resolve_actor_subject(x_reviewer_token, body.actor_subject)
        obs = care_service.clinician_refine_observation_mask(
            actor_subject=actor,
            observation_id=observation_id,
            amends_assessment_id=body.amends_assessment_id,
            edited_boundary_px=body.edited_boundary_px,
            expected_measurement_id=body.expected_measurement_id,
            selected_candidate_id=body.selected_candidate_id,
            nudge_outward_px=body.nudge_outward_px,
            correction_notes=body.correction_notes,
            measurement_region=body.measurement_region,
        )
        return _json(obs, 200)
    except Exception as exc:
        return _error(exc)


@router.post("/observations/{observation_id}/measure-preview")
async def measure_preview_endpoint(
    observation_id: str,
    body: MeasurePreviewRequest,
    x_reviewer_token: Optional[str] = Header(default=None),
):
    """Live measurement of an unsaved boundary edit; same algorithm as saving, nothing stored."""
    try:
        actor = _resolve_actor_subject(x_reviewer_token, body.actor_subject)
        return _json(care_service.preview_observation_measurement(
            actor_subject=actor, observation_id=observation_id,
            edited_boundary_px=body.edited_boundary_px, expected_measurement_id=body.expected_measurement_id,
        ), 200)
    except Exception as exc:
        return _error(exc)


@router.post("/observations/{observation_id}/review")
async def review_observation_endpoint(
    observation_id: str,
    body: ReviewObservationRequest = Body(default_factory=ReviewObservationRequest),
    x_reviewer_token: Optional[str] = Header(default=None),
):
    try:
        actor = _resolve_actor_subject(x_reviewer_token, body.actor_subject)
        obs = care_service.clinician_review_and_approve_observation(
            amends_assessment_id=body.amends_assessment_id,
            amendment_reason=body.amendment_reason,
            expected_record_revision=body.expected_record_revision,
            factual_fields=body.factual_fields,
            actor_subject=actor,
            observation_id=observation_id,
            decision=body.decision,
            approval_request_id=body.approval_request_id,
            expected_measurement_id=body.expected_measurement_id,
            expected_measurement_version=body.expected_measurement_version,
            reviewer_attested=body.reviewer_attested,
            attestations=body.attestations.model_dump() if body.attestations else None,
            wound_type=body.wound_type,
            pressure_injury_stage=body.pressure_injury_stage,
            diagnosis=body.diagnosis,
            wound_bed_appearance=body.wound_bed_appearance,
            exudate_amount=body.exudate_amount,
            surrounding_skin=body.surrounding_skin,
            wound_trend=body.wound_trend,
            sensory_perception=body.sensory_perception,
            moisture=body.moisture,
            activity=body.activity,
            mobility=body.mobility,
            nutrition=body.nutrition,
            friction_and_shear=body.friction_and_shear,
            clinical_interpretation=body.clinical_interpretation,
            care_decisions=body.care_decisions,
            ai_draft_disposition=body.ai_draft_disposition,
            final_documentation_text=body.final_documentation_text,
            review_notes=body.review_notes,
            ai_revision_ids=body.ai_revision_ids,
        )
        return _json(obs, 200)
    except Exception as exc:
        return _error(exc)


@router.post("/assessments/{assessment_id}/amend")
async def amend_assessment_endpoint(
    assessment_id: str,
    body: AmendClinicalAssessmentRequest,
    x_reviewer_token: Optional[str] = Header(default=None),
):
    try:
        actor = _resolve_actor_subject(x_reviewer_token, body.actor_subject)
        amended = care_service.amend_signed_clinical_assessment(
            actor_subject=actor,
            assessment_id=assessment_id,
            amendment_reason=body.amendment_reason,
            updated_clinical_interpretation=body.updated_clinical_interpretation,
            updated_final_documentation_text=body.updated_final_documentation_text,
            updated_wound_trend=body.updated_wound_trend,
        )
        return _json(amended, 201)
    except Exception as exc:
        return _error(exc)


@router.post("/patients/{patient_id}/wounds/{wound_id}/care-plans")
async def create_care_plan_endpoint(
    patient_id: str,
    wound_id: str,
    body: CreateCarePlanRequest = Body(default_factory=CreateCarePlanRequest),
    x_reviewer_token: Optional[str] = Header(default=None),
):
    try:
        actor = _resolve_actor_subject(x_reviewer_token, body.actor_subject)
        plan = care_service.create_or_update_care_plan(
            actor_subject=actor,
            patient_id=patient_id,
            wound_id=wound_id,
            title=body.title,
            purpose=body.purpose,
            approved_instructions=body.approved_instructions,
            assigned_caregiver_subject=body.assigned_caregiver_subject,
            task_frequency=body.task_frequency,
            tasks=body.tasks,
            revision_reason=body.revision_reason,
            carry_over_tasks=body.carry_over_tasks,
            ai_revision_ids=body.ai_revision_ids,
            expected_care_plan_id=body.expected_care_plan_id,
        )
        return _json(plan, 201)
    except Exception as exc:
        return _error(exc)


@router.post("/tasks/{task_id}/complete")
async def complete_care_task_endpoint(
    task_id: str,
    body: CompleteCareTaskRequest = Body(default_factory=CompleteCareTaskRequest),
    x_reviewer_token: Optional[str] = Header(default=None),
):
    try:
        actor = _resolve_actor_subject(x_reviewer_token, body.actor_subject)
        task = care_service.complete_care_task(
            actor_subject=actor, task_id=task_id, status=body.status, caregiver_notes=body.caregiver_notes
        )
        return _json(task, 200)
    except Exception as exc:
        return _error(exc)


@router.get("/images/{image_id}")
async def serve_signed_private_image(
    image_id: str,
    sig: str = Query(...),
    exp: int = Query(...),
    actor_subject: Optional[str] = Query(default=None),
    x_reviewer_token: Optional[str] = Header(default=None),
):
    """
    Serve a private wound photograph or mask only when the expiring HMAC signature is valid
    AND the signed-in viewer is still authorised for the patient (revocation is immediate).
    """
    try:
        actor = _resolve_actor_subject(x_reviewer_token, actor_subject)
        raw_bytes, media_type = care_service.read_private_image(
            image_id=image_id, sig=sig, exp=exp, actor_subject=actor
        )
        return Response(content=raw_bytes, media_type=media_type, headers={"Cache-Control": "private, no-store"})
    except Exception as exc:
        return _error(exc)


class RecordDraftRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')
    actor_subject: Optional[str] = None
    fields: Dict[str, Any]
    expected_revision: int = Field(ge=0)
    base_assessment_id: Optional[str] = None
    amendment_reason: str = Field(default='', max_length=512)
    submit: StrictBool = False
    ai_revision_ids: List[str] = Field(default_factory=list, max_length=20)


@router.post('/observations/{observation_id}/record-draft')
def save_record_draft_endpoint(observation_id: str, body: RecordDraftRequest, x_reviewer_token: Optional[str] = Header(default=None)):
    try:
        actor = _resolve_actor_subject(x_reviewer_token, body.actor_subject)
        return _json(care_service.save_record_draft(actor_subject=actor, observation_id=observation_id,
            fields=body.fields, expected_revision=body.expected_revision, base_assessment_id=body.base_assessment_id,
            amendment_reason=body.amendment_reason, submit=body.submit, ai_revision_ids=body.ai_revision_ids), 200)
    except Exception as exc:
        return _error(exc)


def _find_demo_sample_bytes():
    raise AccessDeniedError("DEMO_DISABLED", "Demo assets are not installed in production.")

_find_demo_followup_bytes = _find_demo_sample_bytes
