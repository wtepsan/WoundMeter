"""Meta AI clinical assistance API: visual observations, report and summary drafts, Ask AI revisions, assistant, voice.

Clinical staff only. Identity comes from the same server-side session as `/v2/care`; every rule
is enforced in `ClinicalAIService` through the existing ConnectedCareService and NursingService checks.
"""
from __future__ import annotations

from typing import Dict, List, Literal, Optional

from fastapi import APIRouter, Header
from pydantic import BaseModel, Field

from app.api import connected_care
from app.api.connected_care import _error, _json, _resolve_actor_subject, care_service
from app.api.nursing import nursing_service
from app.services.clinical_ai_service import AIUnavailableError, ClinicalAIService
from app.services.meta_client import MetaModelClient

router = APIRouter(prefix="/v2/care", tags=["clinical-ai"])
_standalone_meta = MetaModelClient(care_service.settings)


def _meta_client() -> MetaModelClient:
    # Share the measurement pipeline's client (one usage counter and concurrency limit).
    return connected_care.pipeline.meta_client if connected_care.pipeline is not None else _standalone_meta


clinical_ai_service = ClinicalAIService(care_service, nursing_service, _meta_client)


def _ai_error(exc: Exception):
    if isinstance(exc, AIUnavailableError):
        return _json({"code": exc.code.upper(), "message": exc.message}, 503)
    return _error(exc)


class GenerateObservationsRequest(BaseModel):
    actor_subject: Optional[str] = None


class ClinicianFinding(BaseModel):
    category: str = "other"
    observation: str = Field(max_length=500)
    assessment_status: str = "observed"


class ReviewObservationsRequest(BaseModel):
    actor_subject: Optional[str] = None
    decision: Literal["accept", "reject", "edit"]
    clinician_findings: Optional[List[ClinicianFinding]] = None
    notes: str = Field(default="", max_length=1000)
    ai_revision_ids: List[str] = Field(default_factory=list, max_length=20)


class DraftReportRequest(BaseModel):
    actor_subject: Optional[str] = None
    anchor_observation_id: Optional[str] = None
    include_nursing: bool = False


class ReviewReportRequest(BaseModel):
    actor_subject: Optional[str] = None
    decision: Literal["edit", "reject", "sign"]
    sections: Optional[Dict[str, str]] = None
    reason: str = Field(default="", max_length=1000)
    attested: bool = False
    confirm_flagged_content: bool = False
    # Section key -> Ask AI suggestions (revision IDs) the clinician applied before saving the edit.
    ai_revisions: Optional[Dict[str, List[str]]] = None


class SummaryDraftRequest(BaseModel):
    actor_subject: Optional[str] = None
    mode: Literal["ai", "manual"] = "ai"
    text: str = Field(default="", max_length=2000)
    revision_reason: str = Field(default="", max_length=500)
    ai_revision_ids: List[str] = Field(default_factory=list, max_length=20)


class ReviseDraftRequest(BaseModel):
    actor_subject: Optional[str] = None
    draft_type: Literal["summary_progress", "care_instructions", "clinical_note", "visual_observations", "report_section"]
    text: str = Field(min_length=1, max_length=6000)
    instruction: str = Field(min_length=1, max_length=1000)
    base_text: str = Field(default="", max_length=6000)
    target_id: Optional[str] = Field(default=None, max_length=80)
    field: Optional[str] = Field(default=None, max_length=80)
    history: List[str] = Field(default_factory=list, max_length=8)


class ChatMessage(BaseModel):
    role: Literal["user", "assistant"]
    content: str = Field(max_length=4000)


class AssistantRequest(BaseModel):
    actor_subject: Optional[str] = None
    messages: List[ChatMessage] = Field(min_length=1, max_length=20)


class TranscribeRequest(BaseModel):
    actor_subject: Optional[str] = None
    audio_base64: str = Field(max_length=4_300_000)
    language: Literal["auto", "th", "en"] = "auto"


@router.post("/observations/{observation_id}/ai-observations")
def generate_ai_observations(observation_id: str, body: GenerateObservationsRequest = GenerateObservationsRequest(),
                             x_reviewer_token: Optional[str] = Header(default=None)):
    try:
        actor = _resolve_actor_subject(x_reviewer_token, body.actor_subject)
        return _json(clinical_ai_service.generate_visual_observations(actor_subject=actor, observation_id=observation_id), 201)
    except Exception as exc:
        return _ai_error(exc)


@router.post("/ai-observations/{ai_observation_id}/review")
def review_ai_observations(ai_observation_id: str, body: ReviewObservationsRequest,
                           x_reviewer_token: Optional[str] = Header(default=None)):
    try:
        actor = _resolve_actor_subject(x_reviewer_token, body.actor_subject)
        result = clinical_ai_service.review_visual_observations(
            actor_subject=actor, ai_observation_id=ai_observation_id, decision=body.decision,
            clinician_findings=[f.model_dump() for f in body.clinician_findings or []], notes=body.notes,
            ai_revision_ids=body.ai_revision_ids)
        return _json(result, 200)
    except Exception as exc:
        return _ai_error(exc)


@router.post("/patients/{patient_id}/wounds/{wound_id}/reports")
def draft_report(patient_id: str, wound_id: str, body: DraftReportRequest = DraftReportRequest(),
                 x_reviewer_token: Optional[str] = Header(default=None)):
    try:
        actor = _resolve_actor_subject(x_reviewer_token, body.actor_subject)
        report = clinical_ai_service.draft_report(actor_subject=actor, patient_id=patient_id, wound_id=wound_id,
                                                  anchor_observation_id=body.anchor_observation_id,
                                                  include_nursing=body.include_nursing)
        return _json(report, 201)
    except Exception as exc:
        return _ai_error(exc)


@router.get("/patients/{patient_id}/reports")
def list_reports(patient_id: str, actor_subject: Optional[str] = None, x_reviewer_token: Optional[str] = Header(default=None)):
    try:
        actor = _resolve_actor_subject(x_reviewer_token, actor_subject)
        return _json({"reports": clinical_ai_service.list_reports(actor_subject=actor, patient_id=patient_id)}, 200)
    except Exception as exc:
        return _ai_error(exc)


@router.post("/reports/{report_id}/review")
def review_report(report_id: str, body: ReviewReportRequest, x_reviewer_token: Optional[str] = Header(default=None)):
    try:
        actor = _resolve_actor_subject(x_reviewer_token, body.actor_subject)
        result = clinical_ai_service.review_report(
            actor_subject=actor, report_id=report_id, decision=body.decision, sections=body.sections,
            reason=body.reason, attested=body.attested, confirm_flagged_content=body.confirm_flagged_content,
            ai_revisions=body.ai_revisions)
        return _json(result, 200)
    except Exception as exc:
        return _ai_error(exc)


@router.post("/patients/{patient_id}/wounds/{wound_id}/summary-drafts")
def draft_wound_summary(patient_id: str, wound_id: str, body: SummaryDraftRequest = SummaryDraftRequest(),
                        x_reviewer_token: Optional[str] = Header(default=None)):
    """Progress-summary draft (Muse Spark or the clinician's text); edited, signed or rejected through /reports/{id}/review."""
    try:
        actor = _resolve_actor_subject(x_reviewer_token, body.actor_subject)
        return _json(clinical_ai_service.draft_wound_summary(
            actor_subject=actor, patient_id=patient_id, wound_id=wound_id, mode=body.mode, text=body.text,
            revision_reason=body.revision_reason, ai_revision_ids=body.ai_revision_ids), 201)
    except Exception as exc:
        return _ai_error(exc)


@router.post("/patients/{patient_id}/wounds/{wound_id}/ai-revise")
def revise_draft(patient_id: str, wound_id: str, body: ReviseDraftRequest, x_reviewer_token: Optional[str] = Header(default=None)):
    """Ask AI: a suggested revision of an editable draft. Returns text only; nothing in the record changes."""
    try:
        actor = _resolve_actor_subject(x_reviewer_token, body.actor_subject)
        return _json(clinical_ai_service.revise_draft(
            actor_subject=actor, patient_id=patient_id, wound_id=wound_id, draft_type=body.draft_type, text=body.text,
            instruction=body.instruction, base_text=body.base_text, target_id=body.target_id, field=body.field,
            history=body.history), 200)
    except Exception as exc:
        return _ai_error(exc)


@router.post("/patients/{patient_id}/assistant")
def assistant(patient_id: str, body: AssistantRequest, x_reviewer_token: Optional[str] = Header(default=None)):
    try:
        actor = _resolve_actor_subject(x_reviewer_token, body.actor_subject)
        answer = clinical_ai_service.assistant(actor_subject=actor, patient_id=patient_id,
                                               messages=[m.model_dump() for m in body.messages])
        return _json(answer, 200)
    except Exception as exc:
        return _ai_error(exc)


@router.post("/voice/transcribe")
def transcribe(body: TranscribeRequest, x_reviewer_token: Optional[str] = Header(default=None)):
    try:
        actor = _resolve_actor_subject(x_reviewer_token, body.actor_subject)
        return _json(clinical_ai_service.transcribe(actor_subject=actor, audio_base64=body.audio_base64,
                                                    language=body.language), 200)
    except Exception as exc:
        return _ai_error(exc)
