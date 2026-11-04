"""Inpatient nursing API: ward shifts, ward board, admissions, nursing assessments and care checklists.

Replaces the retired nurse-form `/api/v1` service. Identity comes from the same server-side
session as `/v2/care`; every rule is enforced in `NursingService`.
"""
from __future__ import annotations

from typing import List, Literal, Optional

from fastapi import APIRouter, Header, Query
from pydantic import BaseModel, Field

from app.api.connected_care import _error, _json, _resolve_actor_subject, care_service
from app.services.nursing_service import NursingService, NursingStateError


router = APIRouter(prefix="/v2/nursing", tags=["nursing"])
nursing_service = NursingService(care_service)

Priority = Literal["RED", "YELLOW", "GREEN"]
AssessmentType = Literal["ADMISSION", "DAILY", "REASSESSMENT"]


def _nursing_error(exc: Exception):
    if isinstance(exc, NursingStateError):
        return _json({"code": exc.code, "message": exc.message}, 409)
    return _error(exc)


class StartShiftRequest(BaseModel):
    ward_code: str
    shift: Literal["DAY", "EVENING", "NIGHT"]


class AdmitRequest(BaseModel):
    ward_code: Optional[str] = None
    bed: str = Field(min_length=1, max_length=50)
    consent_state: str = Field(default="NOT_REQUIRED", max_length=30)
    target_wound_location: str = "NOT_APPLICABLE"
    baseline_wound_status: str = "NO_WOUND"
    individual_care_plan_available: bool = False
    family_participation_enabled: bool = False


class TransferRequest(BaseModel):
    ward_code: str
    bed: str = Field(min_length=1, max_length=50)


class DischargeRequest(BaseModel):
    reason: str = Field(min_length=2, max_length=500)
    exception_reason: Optional[str] = Field(default=None, max_length=500)


class AssessmentPayload(BaseModel):
    red_flag_present: bool = False
    new_abnormality: bool = False
    skin_status: str = "STABLE"
    wound_trend: str = "STABLE"
    pain_issue: str = "NO"
    moisture_issue: str = "NO"
    mobility_issue: str = "INDEPENDENT"
    sensory_perception: int = Field(ge=1, le=4)
    moisture: int = Field(ge=1, le=4)
    activity: int = Field(ge=1, le=4)
    mobility: int = Field(ge=1, le=4)
    nutrition: int = Field(ge=1, le=4)
    friction_and_shear: int = Field(ge=1, le=3)
    nurse_priority: Optional[Priority] = None
    override_reason: Optional[str] = None
    next_review_at: Optional[str] = None


class AssessmentRequest(BaseModel):
    assessment_type: AssessmentType
    payload: AssessmentPayload


class CareActivityInput(BaseModel):
    activity_type: Literal["POSITIONING", "PRESSURE_REDUCTION", "WOUND_CARE", "ESCALATION"]
    critical: bool = False
    due_at: str


class CareChecklistRequest(BaseModel):
    activities: List[CareActivityInput]


class UnableRequest(BaseModel):
    reason: str = Field(min_length=2, max_length=100)


@router.get("/context")
async def nursing_context(x_reviewer_token: Optional[str] = Header(default=None)):
    try:
        actor = _resolve_actor_subject(x_reviewer_token, None)
        return _json(nursing_service.context(actor_subject=actor))
    except Exception as exc:
        return _nursing_error(exc)


@router.post("/shifts")
async def start_shift(body: StartShiftRequest, x_reviewer_token: Optional[str] = Header(default=None)):
    try:
        actor = _resolve_actor_subject(x_reviewer_token, None)
        return _json(nursing_service.start_shift(actor_subject=actor, ward_code=body.ward_code, shift=body.shift), 201)
    except Exception as exc:
        return _nursing_error(exc)


@router.post("/shifts/{shift_id}/end")
async def end_shift(shift_id: str, x_reviewer_token: Optional[str] = Header(default=None)):
    try:
        actor = _resolve_actor_subject(x_reviewer_token, None)
        return _json(nursing_service.end_shift(actor_subject=actor, shift_id=shift_id))
    except Exception as exc:
        return _nursing_error(exc)


@router.get("/wards/{ward_code}/board")
async def ward_board(ward_code: str, x_reviewer_token: Optional[str] = Header(default=None)):
    try:
        actor = _resolve_actor_subject(x_reviewer_token, None)
        return _json(nursing_service.ward_board(actor_subject=actor, ward_code=ward_code))
    except Exception as exc:
        return _nursing_error(exc)


@router.get("/admissions")
async def list_admissions(
    status: str = Query(default="active"),
    ward_code: Optional[str] = Query(default=None),
    x_reviewer_token: Optional[str] = Header(default=None),
):
    try:
        actor = _resolve_actor_subject(x_reviewer_token, None)
        items = nursing_service.list_admissions(actor_subject=actor, status=status, ward_code=ward_code)
        return _json({"admissions": items})
    except Exception as exc:
        return _nursing_error(exc)


@router.get("/patients/{patient_id}")
async def patient_summary(patient_id: str, x_reviewer_token: Optional[str] = Header(default=None)):
    try:
        actor = _resolve_actor_subject(x_reviewer_token, None)
        return _json(nursing_service.patient_summary(actor_subject=actor, patient_id=patient_id))
    except Exception as exc:
        return _nursing_error(exc)


@router.post("/patients/{patient_id}/admissions")
async def admit_patient(patient_id: str, body: AdmitRequest, x_reviewer_token: Optional[str] = Header(default=None)):
    try:
        actor = _resolve_actor_subject(x_reviewer_token, None)
        return _json(nursing_service.admit_patient(actor_subject=actor, patient_id=patient_id, **body.model_dump()), 201)
    except Exception as exc:
        return _nursing_error(exc)


@router.get("/admissions/{admission_id}")
async def admission_detail(admission_id: str, x_reviewer_token: Optional[str] = Header(default=None)):
    try:
        actor = _resolve_actor_subject(x_reviewer_token, None)
        return _json(nursing_service.admission_detail(actor_subject=actor, admission_id=admission_id))
    except Exception as exc:
        return _nursing_error(exc)


@router.get("/admissions/{admission_id}/report")
async def admission_report(admission_id: str, x_reviewer_token: Optional[str] = Header(default=None)):
    try:
        actor = _resolve_actor_subject(x_reviewer_token, None)
        return _json(nursing_service.admission_report(actor_subject=actor, admission_id=admission_id))
    except Exception as exc:
        return _nursing_error(exc)


@router.post("/admissions/{admission_id}/transfer")
async def transfer(admission_id: str, body: TransferRequest, x_reviewer_token: Optional[str] = Header(default=None)):
    try:
        actor = _resolve_actor_subject(x_reviewer_token, None)
        return _json(nursing_service.transfer(actor_subject=actor, admission_id=admission_id, **body.model_dump()))
    except Exception as exc:
        return _nursing_error(exc)


@router.post("/admissions/{admission_id}/discharge")
async def discharge(admission_id: str, body: DischargeRequest, x_reviewer_token: Optional[str] = Header(default=None)):
    try:
        actor = _resolve_actor_subject(x_reviewer_token, None)
        return _json(nursing_service.discharge(actor_subject=actor, admission_id=admission_id, **body.model_dump()))
    except Exception as exc:
        return _nursing_error(exc)


@router.post("/admissions/{admission_id}/assessments/preview")
async def preview_assessment(admission_id: str, body: AssessmentRequest,
                             x_reviewer_token: Optional[str] = Header(default=None)):
    try:
        actor = _resolve_actor_subject(x_reviewer_token, None)
        result = nursing_service.preview_assessment(
            actor_subject=actor, admission_id=admission_id, assessment_type=body.assessment_type,
            payload=body.payload.model_dump(),
        )
        return _json(result)
    except Exception as exc:
        return _nursing_error(exc)


@router.post("/admissions/{admission_id}/assessments")
async def submit_assessment(admission_id: str, body: AssessmentRequest,
                            x_reviewer_token: Optional[str] = Header(default=None)):
    try:
        actor = _resolve_actor_subject(x_reviewer_token, None)
        result = nursing_service.submit_assessment(
            actor_subject=actor, admission_id=admission_id, assessment_type=body.assessment_type,
            payload=body.payload.model_dump(),
        )
        return _json(result, 201)
    except Exception as exc:
        return _nursing_error(exc)


@router.post("/assessments/{assessment_id}/care-checklist")
async def set_care_checklist(assessment_id: str, body: CareChecklistRequest,
                             x_reviewer_token: Optional[str] = Header(default=None)):
    try:
        actor = _resolve_actor_subject(x_reviewer_token, None)
        items = nursing_service.set_care_checklist(
            actor_subject=actor, assessment_id=assessment_id, activities=[a.model_dump() for a in body.activities]
        )
        return _json({"care_activities": items})
    except Exception as exc:
        return _nursing_error(exc)


@router.post("/care-activities/{activity_id}/complete")
async def complete_care_activity(activity_id: str, x_reviewer_token: Optional[str] = Header(default=None)):
    try:
        actor = _resolve_actor_subject(x_reviewer_token, None)
        return _json(nursing_service.complete_care_activity(actor_subject=actor, activity_id=activity_id))
    except Exception as exc:
        return _nursing_error(exc)


@router.post("/care-activities/{activity_id}/unable")
async def unable_care_activity(activity_id: str, body: UnableRequest,
                               x_reviewer_token: Optional[str] = Header(default=None)):
    try:
        actor = _resolve_actor_subject(x_reviewer_token, None)
        return _json(nursing_service.mark_care_activity_unable(actor_subject=actor, activity_id=activity_id, reason=body.reason))
    except Exception as exc:
        return _nursing_error(exc)
