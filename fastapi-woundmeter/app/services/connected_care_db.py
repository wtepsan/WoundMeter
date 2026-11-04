from __future__ import annotations

import base64
import hashlib
import inspect
import re
import hmac
import json
import secrets
from app.services import postgres as db
import threading
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple
from uuid import uuid4, uuid5, NAMESPACE_URL

import cv2
import numpy as np

from app.config import Settings
from app.services.errors import ProcessingFailure
from app.services.identity_protection import (
    IdentifierProtector,
    is_valid_thai_citizen_id,
    mask_identifier,
    normalize_citizen_id,
    normalize_name,
    thai_citizen_id_check_digit,
)
from app.services.mask_mapping import contour_from_mask, encode_mask_png
from app.services.model_comparison import calculate_dice_and_iou, rasterize_polygon_boundary
from app.services.pipeline import MeasurementPipeline
from app.services.clinical_scoring import calculate_braden_score, calculate_clinical_priority
from app.services.review_workflow import DEMO_CLINICAL_ACCOUNTS
from app.services.demo_assets import synthetic_image_kind
from app.services.private_storage import StorageConnection
from app.services.database_storage import DatabaseStorageError, storage_root, validate_schema, validate_encryption_context
from app.services.image_decoder import inspect_image
from app.services.measurement_contract import mask_hash, strict_polygon_mask, corrected_gate, reaches_outside_photo
from app.services.wound_measurement import calculate_measurements


from app.services.permission_policy import (
    MEDICAL_ROLES, PERMISSIONS, CAREGIVER_ACTIONS, PATIENT_ACTIONS, effective_permissions,
)
from app.services.wound_summary import SUMMARY_SERIES_PREFIX, build_wound_summary, summarise_narratives

# Compatibility exports for existing modules and integrations.
CLINICAL_ROLES = MEDICAL_ROLES
QUALIFIED_SIGNOFF_ROLES = {"CLINICIAN", "NURSE", "SUPERVISOR"}
CAREGIVER_ROLES = {"FAMILY_CAREGIVER"}
PATIENT_ROLES = {"PATIENT"}
ALL_VALID_ROLES = CLINICAL_ROLES | CAREGIVER_ROLES | PATIENT_ROLES | {"RESEARCHER", "ADMIN"}
CLINICAL_PERMISSIONS = tuple(PERMISSIONS)
PERMISSION_DENIED_CODES = {
    "SIGN_OFF": "QUALIFIED_SIGNOFF_REQUIRED",
    "MANAGE_CARE_PLAN": "QUALIFIED_SIGNOFF_REQUIRED",
    "DIAGNOSE": "DIAGNOSIS_NOT_PERMITTED",
    "STAGE": "STAGING_NOT_PERMITTED",
}
_NURSE_PERMISSIONS = ["REGISTER_PATIENT", "REGISTER_WOUND", "ASSESS", "STAGE", "MANAGE_CARE_PLAN", "SIGN_OFF", "DELETE_RECORD", "AUTHORIZE_RESTORE"]
DEMO_PERMISSIONS: Dict[str, List[str]] = {
    "nurse.ward01": _NURSE_PERMISSIONS,
    "nurse.ward02": _NURSE_PERMISSIONS,
    "supervisor.ward01": _NURSE_PERMISSIONS,
    "clinician.somchai": list(CLINICAL_PERMISSIONS),
    "clinician.other_org": list(CLINICAL_PERMISSIONS),
    "homecare.nida": ["ASSESS"],
}
DEMO_QUALIFICATIONS: Dict[str, Tuple[str, str]] = {
    "nurse.ward01": ("Registered Nurse", "RN-DEMO-0101"),
    "nurse.ward02": ("Registered Nurse", "RN-DEMO-0102"),
    "supervisor.ward01": ("Registered Nurse (Supervisor)", "RN-DEMO-0201"),
    "clinician.somchai": ("Physician — Wound Care", "MD-DEMO-1001"),
    "clinician.other_org": ("Physician", "MD-DEMO-9901"),
    "homecare.nida": ("Registered Nurse (Community)", "RN-DEMO-0301"),
}
DEMO_PATIENT_NAMESPACE = "https://woundwise.demo/patient/"


class SubmissionPendingError(Exception):
    pass


class SubmissionSupersededError(SubmissionPendingError):
    """A late attempt lost its claim to a retry; its writes must roll back."""


class SubmissionFailedError(Exception):
    pass


# Bounded for a single-instance prototype: queueing plus local/SAM inference is far shorter.
SUBMISSION_STALE_AFTER = timedelta(minutes=5)


# The four explicit confirmations a clinician gives before sign-off. Each must be exactly true;
# none is implied by a completed review step.
APPROVAL_ATTESTATIONS: Dict[str, str] = {
    "photo_reviewed": "the photograph has been reviewed and is suitable",
    "boundary_verified": "the wound boundary has been verified or corrected",
    "measurements_reviewed": "the measurements and calibration status have been reviewed",
    "assessment_reviewed": "the clinical assessment and findings have been reviewed",
}
# On a 0 cm² record there is no boundary: the same request field confirms that no open wound is visible,
# and the signed record stores it under its own name.
ZERO_AREA_ATTESTATION = "no_open_wound_confirmed"


class AttestationRequiredError(ValueError):
    """Approval refused because explicit confirmations are missing; `missing` lists them."""

    def __init__(self, missing: List[str]):
        self.missing = missing
        labels = [APPROVAL_ATTESTATIONS.get(key, "the signing attestation") for key in missing]
        super().__init__("Clinical approval requires four explicit confirmations. Missing: " + "; ".join(labels) + ".")


class ClinicalConflictError(ValueError):
    """A clinical record changed or a finalisation request conflicts with a prior one."""


class RateLimitedError(Exception):
    pass


class DuplicatePatientError(ValueError):
    def __init__(self, code: str, message: str, duplicates: Dict[str, Any]):
        super().__init__(message)
        self.code = code
        self.message = message
        self.duplicates = duplicates


class RecordConflictError(Exception):
    """A create request named a record that already exists. Creation never updates the existing record."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


# Fictional, checksum-valid demo identifier. The leading 0 keeps it outside real ID ranges.
DEMO_P001_CITIZEN_ID = "000000000001" + thai_citizen_id_check_digit("000000000001")


class AccessDeniedError(PermissionError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


def sign_image_access_token(
    image_id: str,
    secret: str,
    ttl_seconds: int = 900,
    viewer_subject: str = "nurse.ward01",
) -> Tuple[str, int]:
    exp = int(time.time()) + ttl_seconds
    msg = f"{image_id}:{viewer_subject}:{exp}".encode("utf-8")
    sig = hmac.new(secret.encode("utf-8"), msg, hashlib.sha256).hexdigest()
    return sig, exp


def verify_image_access_token(
    image_id: str,
    sig: str,
    exp: int,
    secret: str,
    viewer_subject: str = "nurse.ward01",
) -> bool:
    if int(time.time()) > int(exp):
        return False
    msg = f"{image_id}:{viewer_subject}:{int(exp)}".encode("utf-8")
    expected = hmac.new(secret.encode("utf-8"), msg, hashlib.sha256).hexdigest()
    return hmac.compare_digest(sig, expected)


def make_incomplete_ruler_image_bytes(baseline_bytes: bytes) -> bytes:
    """
    Create a representative invalid-calibration photograph by occluding the AprilTag
    anchors across the top half of the image, triggering RETAKE_REQUIRED and blocking sign-off.
    """
    arr = np.frombuffer(baseline_bytes, dtype=np.uint8)
    img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if img is None:
        return baseline_bytes
    out = img.copy()
    h, w = out.shape[:2]
    cv2.rectangle(out, (0, 0), (w, int(h * 0.62)), (245, 245, 245), -1)
    ok, buf = cv2.imencode(".png", out)
    return buf.tobytes() if ok else baseline_bytes


from app.services.record_workflow import RecordWorkflow, facts_raise_concern

# What a boundary outlines. Whole-wound and red-tissue areas are different measurements and are
# never compared or substituted for each other.
MEASUREMENT_REGIONS = ("whole_wound", "red_tissue")
BOUNDARY_KIND_REGION = {"sam_refined_whole_wound": "whole_wound", "sam_concept": "red_tissue"}

# "No visible open wound": a 0 cm² measurement version with no boundary and no mask. It keeps the photo's
# ruler calibration, so a clinician can still draw an outline if a wound is visible.
ZERO_AREA_AI = "ai_no_visible_wound"  # the AI found no wound on a calibrated photo (a proposal)
ZERO_AREA_CLINICIAN = "clinician_recorded_zero"  # a clinician recorded 0 cm² over an AI outline


def is_zero_area(contract: Any) -> bool:
    return isinstance(contract, dict) and bool(contract.get("zero_area"))


def zero_area_contract(base: Dict[str, Any], *, basis: str, version: int) -> Dict[str, Any]:
    """Geometry contract of a 0 cm² version: the calibration of `base`, no mask, no boundary, whole wound."""
    gate = dict(base.get("quality_gate") or {})
    gate.update(status="REVIEW_REQUIRED", blocking_reasons=[],
                review_reasons=["No visible open wound recorded (0 cm²); clinician verification is required."])
    return {**base, "zero_area": True, "zero_area_basis": basis, "measurement_region": "whole_wound",
            "mask_sha256": None, "selected_component_id": None, "selection_required": False,
            "measurement_lines": None, "measurement_version": version, "quality_gate": gate}


def measurement_region_of(geometry: Any, was_human_corrected: Any) -> Optional[str]:
    """What a boundary outlines: declared on save, else the chosen SAM candidate's kind; None when never
    recorded (older edits, local-model boundaries), never guessed. Mirrors measurementRegion() in
    nextjs-woundmeter/lib/care-format.ts."""
    if not isinstance(geometry, dict):
        return None
    if geometry.get("measurement_region") in MEASUREMENT_REGIONS:
        return geometry["measurement_region"]
    candidates = geometry.get("candidates") or []
    chosen = None
    if geometry.get("selected_component_id") is not None:
        chosen = next((c for c in candidates if c.get("candidate_id") == geometry["selected_component_id"]), None)
    elif not was_human_corrected and not geometry.get("selection_required") and len(candidates) == 1:
        chosen = candidates[0]
    return BOUNDARY_KIND_REGION.get((chosen or {}).get("boundary_kind"))


def measurement_lines(m: Any) -> Dict[str, Any]:
    """Where each measured dimension lies on the rectified image, so the photo can show it.

    Y is the longest vertical run (length_cm) and X the longest horizontal run (width_cm), both
    along the ruler axes; the clinical lines are the maximum span and its perpendicular.
    """
    def rounded(line: Any) -> List[List[float]]:
        return [[round(float(x), 2), round(float(y), 2)] for x, y in (line or [])]
    return {"length_line_px": rounded(m.length_line_px), "width_line_px": rounded(m.width_line_px),
            "clinical_length_line_px": rounded(m.clinical_length_line_px), "clinical_width_line_px": rounded(m.clinical_width_line_px)}


class ConnectedCareService(RecordWorkflow):
    """
    Persistent relational Patient Wound-Care Records & Home Monitoring service.
    Enforces organisation boundaries, patient-scoped caregiver/patient access grants,
    versioned measurements, immutable versioned clinical assessments, and private image storage.
    """

    def __init__(self, settings: Settings, *, initialize: bool = False):
        self.settings = settings
        self.root = storage_root(settings.results_dir)
        self.db_path = "postgresql://postgres:5432/woundmeter"
        self.private_storage_dir = self.root / "private_storage"
        self._initializing = False
        self._lock = threading.RLock()
        self._started_at = datetime.now(timezone.utc)
        self._last_audit_hash = "0" * 64
        self.protector = IdentifierProtector(settings)
        # Run inside the P001 demo reset transaction with the demo patient ids, before the patient
        # row is deleted, so modules with patient-linked tables (inpatient nursing) can clear them.
        self.demo_reset_hooks: List[Callable[[db.Connection, List[str]], None]] = []
        with self._connect() as conn:
            validate_schema(conn, "care")
            validate_encryption_context(conn, self.protector)

    def _connect(self) -> db.Connection:
        return StorageConnection()

    def _append_audit(
        self,
        conn: db.Connection,
        *,
        actor_subject: str,
        actor_role: str,
        actor_org_id: str,
        action: str,
        entity_type: str,
        entity_id: Optional[str] = None,
        patient_id: Optional[str] = None,
        wound_id: Optional[str] = None,
        outcome: str = "SUCCESS",
        detail: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        if outcome == "DENIED" and entity_type != "AUTH":
            # Clinical access denials must not commit partial record writes. Auth
            # denials intentionally persist lockout/MFA counters in their transaction.
            conn.rollback()
        now = datetime.now(timezone.utc).isoformat()
        conn.execute("SELECT pg_advisory_xact_lock(4456002)")
        row = conn.execute(
            "SELECT entry_hash FROM audit_events ORDER BY sequence_id DESC LIMIT 1"
        ).fetchone()
        prev_hash = row["entry_hash"] if row else "0" * 64
        event_id = f"AUD-{uuid4().hex[:12]}"
        detail_obj = detail or {}
        core = {
            "event_id": event_id,
            "timestamp_utc": now,
            "actor_subject": actor_subject,
            "actor_role": actor_role,
            "actor_org_id": actor_org_id,
            "patient_id": patient_id,
            "wound_id": wound_id,
            "action": action,
            "entity_type": entity_type,
            "entity_id": entity_id,
            "outcome": outcome,
            "detail": detail_obj,
            "prev_hash": prev_hash,
        }
        entry_hash = hashlib.sha256(json.dumps(core, sort_keys=True).encode("utf-8")).hexdigest()
        conn.execute(
            """
            INSERT INTO audit_events(
                event_id, timestamp_utc, actor_subject, actor_role, actor_org_id,
                patient_id, wound_id, action, entity_type, entity_id, outcome,
                detail_json, prev_hash, entry_hash
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                event_id,
                now,
                actor_subject,
                actor_role,
                actor_org_id,
                patient_id,
                wound_id,
                action,
                entity_type,
                entity_id,
                outcome,
                json.dumps(detail_obj),
                prev_hash,
                entry_hash,
            ),
        )
        if outcome == "DENIED":
            # Denials are usually followed by an exception, which would roll the transaction back;
            # commit now so refused attempts always reach the audit trail.
            conn.commit()
        return {**core, "entry_hash": entry_hash}

    def _create_notification(
        self,
        conn: db.Connection,
        *,
        recipient_subject: str,
        recipient_role: str,
        patient_id: str,
        wound_id: Optional[str],
        observation_id: Optional[str],
        notification_type: str,
        safe_preview_title: str,
        safe_preview_body: str,
        clinical_owner_subject: str = "nurse.ward01",
    ) -> str:
        """
        Create an in-app notification with privacy-safe preview text (never exposing sensitive PII in previews)
        and an explicit non-emergency SLA disclaimer.
        """
        notif_id = f"NTF-{uuid4().hex[:10].upper()}"
        now = datetime.now(timezone.utc).isoformat()
        sla_notice = (
            "Asynchronous clinical review queue — NOT an emergency medical service. "
            "No guaranteed real-time response; contact emergency services for urgent symptoms."
        )
        conn.execute(
            """
            INSERT INTO notifications(
                notification_id, recipient_subject, recipient_role, patient_id, wound_id,
                observation_id, notification_type, safe_preview_title, safe_preview_body,
                clinical_owner_subject, response_sla_notice, is_read, created_at_utc
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
            """,
            (
                notif_id,
                recipient_subject,
                recipient_role,
                patient_id,
                wound_id,
                observation_id,
                notification_type,
                safe_preview_title,
                safe_preview_body,
                clinical_owner_subject,
                sla_notice,
                now,
            ),
        )
        return notif_id

    def get_user_record(self, conn: db.Connection, subject: str) -> Dict[str, Any]:
        row = conn.execute("SELECT * FROM users WHERE subject = ? AND active = 1", (subject,)).fetchone()
        if not row:
            raise AccessDeniedError("UNAUTHENTICATED", f"Unknown or inactive user account: {subject}")
        return dict(row)

    def organisation_name(self, org_id: str) -> Optional[str]:
        with self._connect() as conn:
            row = conn.execute("SELECT name FROM organizations WHERE org_id = ?", (org_id,)).fetchone()
            return row["name"] if row else None

    @staticmethod
    def effective_permissions(user: Dict[str, Any]) -> List[str]:
        return effective_permissions(user)

    def user_has_permission(self, user: Dict[str, Any], permission: str) -> bool:
        return permission in self.effective_permissions(user)

    def require_permission(
        self,
        conn: db.Connection,
        user: Dict[str, Any],
        permission: str,
        *,
        patient_id: Optional[str] = None,
        wound_id: Optional[str] = None,
    ) -> None:
        if self.user_has_permission(user, permission):
            return
        self._append_audit(
            conn,
            actor_subject=user["subject"],
            actor_role=user["role"],
            actor_org_id=user["org_id"],
            action=f"DENIED_CLINICAL_PERMISSION:{permission}",
            entity_type="PATIENT" if patient_id else "USER",
            entity_id=patient_id or user["subject"],
            patient_id=patient_id,
            wound_id=wound_id,
            outcome="DENIED",
            detail={"missing_permission": permission},
        )
        messages = {
            "SIGN_OFF": (
                f"Role '{user['role']}' may assist with observations, but final clinical assessment sign-off "
                "requires a qualified clinician holding sign-off permission."
            ),
            "MANAGE_CARE_PLAN": "Care-plan orders require a qualified clinician holding care-plan permission.",
            "DIAGNOSE": "Recording a diagnosis requires a clinician authorised to diagnose.",
            "STAGE": "Changing wound classification or staging requires staging permission.",
        }
        raise AccessDeniedError(
            PERMISSION_DENIED_CODES.get(permission, "CLINICAL_PERMISSION_REQUIRED"),
            messages.get(permission, f"This action requires the '{permission}' clinical permission."),
        )

    @staticmethod
    def _active_access_grants(conn: db.Connection, actor_subject: str, patient_id: str) -> List[Dict[str, Any]]:
        now = datetime.now(timezone.utc).isoformat()
        return [dict(row) for row in conn.execute(
            """SELECT * FROM patient_access_grants
               WHERE patient_id = ? AND grantee_subject = ? AND status = 'ACTIVE'
                 AND revoked_at_utc IS NULL AND (expires_at_utc IS NULL OR expires_at_utc > ?)""",
            (patient_id, actor_subject, now),
        ).fetchall()]

    @staticmethod
    def _grant_allows(grant: Dict[str, Any], wound_id: Optional[str], permission: str) -> bool:
        # A wound-scoped grant may expose the patient header, but never a sibling
        # wound. Callers assembling a record must filter each wound separately.
        if wound_id and grant["wound_id"] and grant["wound_id"] != wound_id:
            return False
        permissions = json.loads(grant["permissions_json"] or "[]")
        return permission in CAREGIVER_ACTIONS and (permission in permissions or "ALL_CAREGIVER_ACTIONS" in permissions)

    def authorize_patient_access(
        self,
        conn: db.Connection,
        actor_subject: Optional[str],
        patient_id: str,
        *,
        wound_id: Optional[str] = None,
        required_permission: str = "VIEW_APPROVED_PROGRESS",
        require_clinical_role: bool = False,
        require_signoff_qualification: bool = False,
        clinical_permission: Optional[str] = None,
        include_deleted_wound: bool = False,
    ) -> Tuple[Dict[str, Any], Dict[str, Any]]:
        """
        Enforce strict identity, role, organisation boundary, and patient-scoped access grant checks.
        Logs denied access attempts in `audit_events`.
        """
        if not actor_subject:
            raise AccessDeniedError("AUTHENTICATION_REQUIRED", "Authenticated user session required.")
        user = self.get_user_record(conn, actor_subject)
        role = user["role"]
        org_id = user["org_id"]

        pat_row = conn.execute(
            "SELECT * FROM patients WHERE patient_id = ? OR patient_code = ?",
            (patient_id, patient_id),
        ).fetchone()
        if not pat_row:
            raise KeyError(f"Patient '{patient_id}' not found.")
        patient = dict(pat_row)
        resolved_pid = patient["patient_id"]
        if patient["record_status"] != "ACTIVE":
            self._append_audit(conn, actor_subject=actor_subject, actor_role=role, actor_org_id=org_id,
                action="ARCHIVED_PATIENT_ACCESS_DENIED", entity_type="PATIENT", entity_id=resolved_pid,
                patient_id=resolved_pid, outcome="DENIED")
            raise AccessDeniedError("PATIENT_ARCHIVED", "This patient is archived and is not in the active dataset.")
        if wound_id:
            wound_id = self._resolve_wound(conn, resolved_pid, wound_id, include_deleted=include_deleted_wound)["wound_id"]
        if role == "ADMIN":
            self._append_audit(
                conn, actor_subject=actor_subject, actor_role=role, actor_org_id=org_id,
                action=f"PATIENT_ACCESS_DENIED:{required_permission}", entity_type="PATIENT",
                entity_id=resolved_pid, patient_id=resolved_pid, wound_id=wound_id,
                outcome="DENIED", detail={"reason": "Administrative access does not grant clinical access."},
            )
            raise AccessDeniedError("CLINICAL_ROLE_REQUIRED", "Administrators manage access, not clinical records.")

        if require_clinical_role and role not in CLINICAL_ROLES:
            self._append_audit(
                conn,
                actor_subject=actor_subject,
                actor_role=role,
                actor_org_id=org_id,
                action=f"DENIED_CLINICAL_ACTION:{required_permission}",
                entity_type="PATIENT",
                entity_id=resolved_pid,
                patient_id=resolved_pid,
                wound_id=wound_id,
                outcome="DENIED",
                detail={"reason": "Role is not authorised for clinical verification or care-plan sign-off."},
            )
            raise AccessDeniedError(
                "CLINICAL_ROLE_REQUIRED",
                f"Role '{role}' is not authorised to perform clinical approvals, diagnoses, or care-plan changes.",
            )

        if require_signoff_qualification:
            self.require_permission(conn, user, "SIGN_OFF", patient_id=resolved_pid, wound_id=wound_id)
        if clinical_permission:
            if role not in CLINICAL_ROLES:
                raise AccessDeniedError(
                    "CLINICAL_ROLE_REQUIRED", f"Role '{role}' is not authorised to perform clinical actions."
                )
            self.require_permission(conn, user, clinical_permission, patient_id=resolved_pid, wound_id=wound_id)

        # A patient link or a grant cannot override the account type's action ceiling.
        if role not in CLINICAL_ROLES:
            allowed = PATIENT_ACTIONS if role == "PATIENT" else CAREGIVER_ACTIONS if role in CAREGIVER_ROLES else set()
            if required_permission not in allowed:
                self._append_audit(conn, actor_subject=actor_subject, actor_role=role, actor_org_id=org_id,
                    action=f"PATIENT_ACTION_DENIED:{required_permission}", entity_type="PATIENT",
                    entity_id=resolved_pid, patient_id=resolved_pid, wound_id=wound_id, outcome="DENIED")
                raise AccessDeniedError("PATIENT_ACTION_DENIED", "This account type cannot perform this action.")
            if role == "PATIENT" and patient.get("patient_account_subject") != actor_subject:
                raise AccessDeniedError("PATIENT_ACCESS_DENIED", "Patients can only access their own linked record.")

        # 1. Medical staff: explicit care team, or an assigned ward in the same organisation.
        if role in CLINICAL_ROLES:
            in_same_org = org_id == patient["org_id"]
            on_care_team = (
                conn.execute(
                    """
                    SELECT 1 FROM patient_care_team_members
                    WHERE patient_id = ? AND user_subject = ? AND active = 1
                    """,
                    (resolved_pid, actor_subject),
                ).fetchone()
                is not None
            )
            ward_scope = in_same_org and patient.get("ward_code") in json.loads(user.get("wards_json") or "[]")
            if not (ward_scope or on_care_team):
                self._append_audit(
                    conn,
                    actor_subject=actor_subject,
                    actor_role=role,
                    actor_org_id=org_id,
                    action=f"CROSS_ORG_ACCESS_DENIED:{required_permission}",
                    entity_type="PATIENT",
                    entity_id=resolved_pid,
                    patient_id=resolved_pid,
                    wound_id=wound_id,
                    outcome="DENIED",
                    detail={"user_org": org_id, "patient_org": patient["org_id"]},
                )
                raise AccessDeniedError(
                    "CROSS_ORG_ACCESS_DENIED",
                    "No current care-team or ward assignment authorises access to this patient.",
                )
            return user, patient

        # 2. Patients can only read their own linked record.
        if role == "PATIENT":
            if patient.get("patient_account_subject") == actor_subject:
                return user, patient

        # 3. Family Caregiver (or representative): must hold an ACTIVE, non-expired, non-revoked grant for this patient
        valid_grant = next((
            grant for grant in self._active_access_grants(conn, actor_subject, resolved_pid)
            if self._grant_allows(grant, wound_id, required_permission)
        ), None)

        if not valid_grant:
            self._append_audit(
                conn,
                actor_subject=actor_subject,
                actor_role=role,
                actor_org_id=org_id,
                action=f"PATIENT_ACCESS_DENIED:{required_permission}",
                entity_type="PATIENT",
                entity_id=resolved_pid,
                patient_id=resolved_pid,
                wound_id=wound_id,
                outcome="DENIED",
                detail={"reason": "No active, non-expired patient access grant found."},
            )
            raise AccessDeniedError(
                "PATIENT_ACCESS_DENIED",
                f"User '{actor_subject}' ({role}) does not have an active access grant for patient '{resolved_pid}'.",
            )

        return user, patient

    # ------------------------------------------------------------------------------------
    # Patient registry: identity, duplicates, search
    # ------------------------------------------------------------------------------------

    def _public_patient(self, conn: db.Connection, patient: Dict[str, Any], user: Dict[str, Any]) -> Dict[str, Any]:
        """Return only the identity fields this viewer needs. Ciphertext and blind indexes never leave."""
        org = conn.execute("SELECT name FROM organizations WHERE org_id = ?", (patient["org_id"],)).fetchone()
        public = {
            "patient_id": patient["patient_id"],
            "patient_code": patient["patient_code"],
            "display_name": patient.get("full_name") or patient["display_name"],
            "full_name": patient.get("full_name"),
            "org_id": patient["org_id"],
            "org_name": org["name"] if org else None,
            "is_fictional_demo": patient.get("is_fictional_demo", 0),
            "record_status": patient.get("record_status"),
            "patient_account_subject": patient.get("patient_account_subject"),
            "primary_clinician_subject": patient.get("primary_clinician_subject"),
        }
        if user["role"] in CLINICAL_ROLES or (user["role"] == "PATIENT" and patient.get("patient_account_subject") == user["subject"]):
            public.update(
                {
                    "date_of_birth": patient.get("date_of_birth"),
                    "hospital_number": patient.get("hospital_number"),
                    "national_id_masked": mask_identifier(patient.get("national_id_last4")),
                    "has_national_id": bool(patient.get("national_id_blind_index")),
                    "no_national_id_reason": patient.get("no_national_id_reason"),
                    "age_group": patient.get("age_group"),
                    "sex": patient.get("sex"),
                    "ward_code": patient.get("ward_code"),
                }
            )
        return public

    def _scope_clause(self, user: Dict[str, Any]) -> Tuple[str, Tuple[Any, ...]]:
        return (
            """p.record_status = 'ACTIVE' AND (
                (p.org_id = ? AND p.ward_code IN (SELECT value FROM json_each(?)))
                OR EXISTS (SELECT 1 FROM patient_care_team_members m
                  WHERE m.patient_id = p.patient_id AND m.user_subject = ? AND m.active = 1))""",
            (user["org_id"], user.get("wards_json") or "[]", user["subject"]),
        )

    @staticmethod
    def _validate_name_and_birth_date(full_name: Optional[str], date_of_birth: Optional[str]) -> None:
        if not (full_name or "").strip() or len(full_name.strip()) < 2:
            raise ValueError("Enter the patient's full name.")
        try:
            dob = datetime.strptime(date_of_birth or "", "%Y-%m-%d").date()
        except ValueError as exc:
            raise ValueError("Enter the date of birth as YYYY-MM-DD.") from exc
        if dob > datetime.now(timezone.utc).date() or dob.year < 1900:
            raise ValueError("The date of birth is not plausible.")

    def _validate_identity(
        self,
        *,
        full_name: str,
        date_of_birth: str,
        national_id: Optional[str],
        no_national_id_reason: Optional[str],
    ) -> Optional[str]:
        self._validate_name_and_birth_date(full_name, date_of_birth)
        if national_id:
            digits = normalize_citizen_id(national_id)
            if not is_valid_thai_citizen_id(digits):
                # Never echo the submitted number back.
                raise ValueError("The Citizen ID is not a valid 13-digit Thai Citizen ID (check digit mismatch).")
            return digits
        if not (no_national_id_reason or "").strip():
            raise ValueError("Give a reason when the patient has no Citizen ID.")
        return None

    def find_potential_duplicates(
        self,
        conn: db.Connection,
        user: Dict[str, Any],
        *,
        full_name: str,
        date_of_birth: Optional[str],
        national_id_digits: Optional[str],
        hospital_number: Optional[str],
        exclude_patient_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Exact identifier matches are hard duplicates; name/DOB similarity only flags for review."""
        hard: Dict[str, Dict[str, Any]] = {}
        soft: Dict[str, Dict[str, Any]] = {}
        outside_scope_conflict = False

        def consider(row: db.Row, reason: str, is_hard: bool) -> None:
            nonlocal outside_scope_conflict
            pat = dict(row)
            if pat["patient_id"] == exclude_patient_id:
                return
            in_scope = pat["org_id"] == user["org_id"] or conn.execute(
                "SELECT 1 FROM patient_care_team_members WHERE patient_id = ? AND user_subject = ? AND active = 1",
                (pat["patient_id"], user["subject"]),
            ).fetchone() is not None
            if not in_scope:
                # Reveal only that a conflict exists, never the other organisation's record.
                if is_hard:
                    outside_scope_conflict = True
                return
            bucket = hard if is_hard else soft
            entry = bucket.setdefault(pat["patient_id"], {"patient": self._public_patient(conn, pat, user), "reasons": []})
            if reason not in entry["reasons"]:
                entry["reasons"].append(reason)

        if national_id_digits:
            idx = self.protector.blind_index("THAI_CITIZEN_ID", national_id_digits)
            for row in conn.execute("SELECT * FROM patients WHERE national_id_blind_index = ?", (idx,)):
                consider(row, "Same Citizen ID", True)
        if hospital_number:
            for row in conn.execute(
                "SELECT * FROM patients WHERE org_id = ? AND upper(hospital_number) = upper(?)",
                (user["org_id"], hospital_number.strip()),
            ):
                consider(row, "Same hospital number", True)
        name_norm = normalize_name(full_name)
        if name_norm:
            tokens = name_norm.split()
            for row in conn.execute("SELECT * FROM patients WHERE name_normalized IS NOT NULL"):
                other = row["name_normalized"] or ""
                same_dob = bool(date_of_birth) and row["date_of_birth"] == date_of_birth
                if other == name_norm and same_dob:
                    consider(row, "Same name and date of birth", False)
                elif other == name_norm:
                    consider(row, "Same name", False)
                elif same_dob and set(tokens) & set(other.split()):
                    consider(row, "Same date of birth and a similar name", False)
        for key in hard:
            soft.pop(key, None)
        return {
            "exact_matches": list(hard.values()),
            "possible_matches": list(soft.values()),
            "conflict_outside_scope": outside_scope_conflict,
        }

    def check_duplicates(
        self,
        *,
        actor_subject: str,
        full_name: str,
        date_of_birth: Optional[str],
        national_id: Optional[str],
        hospital_number: Optional[str],
    ) -> Dict[str, Any]:
        with self._lock, self._connect() as conn:
            user = self.get_user_record(conn, actor_subject)
            if user["role"] not in CLINICAL_ROLES:
                raise AccessDeniedError("CLINICAL_ROLE_REQUIRED", "Only medical staff can register patients.")
            self.require_permission(conn, user, "REGISTER_PATIENT")
            digits = normalize_citizen_id(national_id) if national_id else None
            if digits and not is_valid_thai_citizen_id(digits):
                raise ValueError("The Citizen ID is not a valid 13-digit Thai Citizen ID (check digit mismatch).")
            return self.find_potential_duplicates(
                conn,
                user,
                full_name=full_name,
                date_of_birth=date_of_birth,
                national_id_digits=digits,
                hospital_number=hospital_number,
            )

    _search_windows: Dict[str, List[float]] = {}

    def _check_search_rate(self, subject: str, limit: int = 30, window_s: float = 60.0) -> None:
        now = time.monotonic()
        recent = [t for t in self._search_windows.get(subject, []) if now - t < window_s]
        if len(recent) >= limit:
            raise RateLimitedError("Too many searches. Wait a minute and try again.")
        recent.append(now)
        self._search_windows[subject] = recent

    def search_patients(
        self,
        *,
        actor_subject: str,
        search_type: str,
        query: str,
        date_of_birth: Optional[str] = None,
    ) -> Dict[str, Any]:
        """
        Medical staff search within their assigned patient/ward scope.
        The search value is never written to logs or the audit trail.
        """
        search_type = (search_type or "").upper()
        with self._lock, self._connect() as conn:
            user = self.get_user_record(conn, actor_subject)
            if user["role"] not in CLINICAL_ROLES:
                self._append_audit(
                    conn,
                    actor_subject=actor_subject,
                    actor_role=user["role"],
                    actor_org_id=user["org_id"],
                    action="PATIENT_SEARCH_DENIED",
                    entity_type="PATIENT",
                    entity_id=None,
                    outcome="DENIED",
                    detail={"search_type": search_type},
                )
                raise AccessDeniedError(
                    "PATIENT_SEARCH_NOT_PERMITTED", "Only medical staff can search for patients."
                )
            self._check_search_rate(actor_subject)
            scope_sql, scope_args = self._scope_clause(user)
            q = (query or "").strip()
            rows: List[db.Row] = []
            if search_type == "NATIONAL_ID":
                digits = normalize_citizen_id(q)
                if not is_valid_thai_citizen_id(digits):
                    raise ValueError("Enter a valid 13-digit Thai Citizen ID.")
                idx = self.protector.blind_index("THAI_CITIZEN_ID", digits)
                rows = conn.execute(
                    f"SELECT p.* FROM patients p WHERE p.national_id_blind_index = ? AND {scope_sql}",
                    (idx, *scope_args),
                ).fetchall()
            elif search_type == "HN":
                if not q:
                    raise ValueError("Enter a hospital number.")
                rows = conn.execute(
                    f"SELECT p.* FROM patients p WHERE upper(p.hospital_number) = upper(?) AND {scope_sql}",
                    (q, *scope_args),
                ).fetchall()
            elif search_type == "REFERENCE":
                rows = conn.execute(
                    f"SELECT p.* FROM patients p WHERE upper(p.patient_code) = upper(?) AND {scope_sql}",
                    (q, *scope_args),
                ).fetchall()
            elif search_type == "NAME":
                name = normalize_name(q)
                if len(name) < 3:
                    raise ValueError("Enter at least 3 letters of the name.")
                sql = f"SELECT p.* FROM patients p WHERE p.name_normalized LIKE ? AND {scope_sql}"
                args: Tuple[Any, ...] = (f"%{name}%", *scope_args)
                if date_of_birth:
                    sql += " AND p.date_of_birth = ?"
                    args = (*args, date_of_birth)
                rows = conn.execute(sql + " ORDER BY p.name_normalized LIMIT 11", args).fetchall()
            else:
                raise ValueError("Choose how to search: Citizen ID, hospital number, name or reference.")

            truncated = len(rows) > 10
            results = []
            for row in rows[:10]:
                pat = dict(row)
                public = self._public_patient(conn, pat, user)
                public["on_care_team"] = conn.execute(
                    "SELECT 1 FROM patient_care_team_members WHERE patient_id = ? AND user_subject = ? AND active = 1",
                    (pat["patient_id"], user["subject"]),
                ).fetchone() is not None
                results.append(public)
            names = [r["display_name"].lower() for r in results]
            needs_verification = len(names) != len(set(names)) or (search_type == "NAME" and not date_of_birth and len(results) > 1)
            self._append_audit(
                conn,
                actor_subject=actor_subject,
                actor_role=user["role"],
                actor_org_id=user["org_id"],
                action="PATIENT_SEARCH",
                entity_type="PATIENT",
                entity_id=None,
                detail={"search_type": search_type, "result_count": len(results), "dob_filter": bool(date_of_birth)},
            )
            return {"results": results, "truncated": truncated, "needs_verification": needs_verification}

    def register_patient(
        self,
        *,
        actor_subject: str,
        patient_code: Optional[str] = None,
        display_name: Optional[str] = None,
        full_name: Optional[str] = None,
        date_of_birth: Optional[str] = None,
        national_id: Optional[str] = None,
        no_national_id_reason: Optional[str] = None,
        hospital_number: Optional[str] = None,
        contact_phone: Optional[str] = None,
        age_group: str = "65_74",
        sex: str = "FEMALE",
        ward_code: Optional[str] = None,
        patient_account_subject: Optional[str] = None,
        assign_homecare_subject: Optional[str] = None,
        confirm_not_duplicate: bool = False,
        duplicate_override_reason: Optional[str] = None,
    ) -> Dict[str, Any]:
        now = datetime.now(timezone.utc).isoformat()
        code = (patient_code or "").strip().upper() or None
        is_demo_p001 = self.settings.demo_mode and code == "P001"
        if is_demo_p001:
            # The fictional hackathon patient always carries the same fictional identity.
            full_name = full_name or "Somjai Rakdee"
            display_name = display_name or "Patient P001 (Somjai Rakdee — Fictional Demo)"
            date_of_birth = date_of_birth or "1950-03-14"
            hospital_number = hospital_number or "HN-DEMO-0001"
            national_id = national_id or DEMO_P001_CITIZEN_ID
            patient_account_subject = patient_account_subject or "patient.p001"
            assign_homecare_subject = assign_homecare_subject or "homecare.nida"
            age_group = "70_79" if age_group == "65_74" else age_group

        with self._lock, self._connect() as conn:
            user = self.get_user_record(conn, actor_subject)
            if user["role"] not in CLINICAL_ROLES:
                raise AccessDeniedError(
                    "CLINICAL_ROLE_REQUIRED", "Only authorised clinical staff may register patients."
                )
            self.require_permission(conn, user, "REGISTER_PATIENT")
            if not ward_code:
                # Default to the registering clinician's first assigned ward in their organisation.
                assigned = json.loads(user.get("wards_json") or "[]")
                own = [r["ward_code"] for r in conn.execute(
                    "SELECT ward_code FROM wards WHERE org_id = ? AND active = 1 ORDER BY ward_code", (user["org_id"],)
                ).fetchall() if r["ward_code"] in assigned]
                ward_code = own[0] if own else "WARD01"

            # Registration only ever creates. A reference that is already in use must not update that
            # patient or add the caller to its care team: the caller may have no access to it at all.
            # Identity changes go through update_patient_identity, which checks scope first.
            existing = (
                conn.execute("SELECT patient_id FROM patients WHERE upper(patient_code) = ?", (code,)).fetchone()
                if code else None
            )
            if existing:
                self._append_audit(
                    conn, actor_subject=actor_subject, actor_role=user["role"], actor_org_id=user["org_id"],
                    action="PATIENT_REGISTRATION_REFUSED", entity_type="PATIENT", entity_id=existing["patient_id"],
                    patient_id=existing["patient_id"], outcome="DENIED", detail={"reason": "PATIENT_CODE_IN_USE"},
                )
                raise RecordConflictError(
                    "PATIENT_CODE_IN_USE",
                    "This patient reference is already in use. Search for the existing patient instead of registering again.",
                )
            full_name = (full_name or display_name or "").strip()
            digits = self._validate_identity(
                full_name=full_name,
                date_of_birth=date_of_birth or "",
                national_id=national_id,
                no_national_id_reason=no_national_id_reason,
            )
            hn = (hospital_number or "").strip() or None
            dupes = self.find_potential_duplicates(
                conn,
                user,
                full_name=full_name,
                date_of_birth=date_of_birth,
                national_id_digits=digits,
                hospital_number=hn,
            )
            if dupes["exact_matches"] or dupes["conflict_outside_scope"]:
                raise DuplicatePatientError(
                    "DUPLICATE_PATIENT",
                    "A patient with this Citizen ID or hospital number already exists. Open the existing record instead.",
                    dupes,
                )
            if dupes["possible_matches"]:
                if not confirm_not_duplicate or not (duplicate_override_reason or "").strip():
                    raise DuplicatePatientError(
                        "POSSIBLE_DUPLICATE",
                        "Similar patients already exist. Check them before registering a new record.",
                        dupes,
                    )

            identity_values = {
                "full_name": full_name,
                "name_normalized": normalize_name(full_name),
                "date_of_birth": date_of_birth,
                "hospital_number": hn,
                "national_id_ciphertext": self.protector.encrypt(digits),
                "national_id_blind_index": self.protector.blind_index("THAI_CITIZEN_ID", digits) if digits else None,
                "national_id_last4": digits[-4:] if digits else None,
                "no_national_id_reason": None if digits else (no_national_id_reason or "").strip(),
                "contact_phone_ciphertext": self.protector.encrypt((contact_phone or "").strip() or None),
            }
            pid = str(uuid5(NAMESPACE_URL, DEMO_PATIENT_NAMESPACE + code)) if is_demo_p001 else str(uuid4())
            code = code or f"WW-{uuid4().hex[:6].upper()}"
            conn.execute(
                f"""
                INSERT INTO patients(
                    patient_id, patient_code, display_name, is_fictional_demo, age_group, sex,
                    org_id, ward_code, primary_clinician_subject, patient_account_subject,
                    record_status, created_by_subject, created_at_utc, updated_at_utc,
                    {", ".join(identity_values)}
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?, ?, {", ".join("?" for _ in identity_values)})
                """,
                (
                    pid,
                    code,
                    display_name or full_name,
                    1 if (is_demo_p001 or self.settings.demo_mode) else 0,
                    age_group,
                    sex,
                    user["org_id"],
                    ward_code,
                    actor_subject,
                    patient_account_subject,
                    actor_subject,
                    now,
                    now,
                    *identity_values.values(),
                ),
            )

            team_members = [(actor_subject, user["org_id"], user["role"], "Registering clinician")]
            if is_demo_p001:
                team_members = [(actor_subject, user["org_id"], user["role"], "Primary Ward Nurse")]
                specialist = conn.execute(
                    "SELECT org_id, role FROM users WHERE subject = 'clinician.somchai' AND subject != ?", (actor_subject,)
                ).fetchone()
                if specialist:
                    team_members.append(("clinician.somchai", specialist["org_id"], specialist["role"], "Attending Wound Specialist"))
            if assign_homecare_subject:
                hc_user = conn.execute(
                    "SELECT org_id, role FROM users WHERE subject = ?", (assign_homecare_subject,)
                ).fetchone()
                if hc_user:
                    team_members.append(
                        (assign_homecare_subject, hc_user["org_id"], hc_user["role"], "Community Home-Care RN")
                    )
            for m_sub, m_org, m_role, m_label in team_members:
                conn.execute(
                    """
                    INSERT INTO patient_care_team_members(
                        membership_id, patient_id, user_subject, org_id, team_role,
                        relationship_label, assigned_by_subject, active, created_at_utc
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?) ON CONFLICT (membership_id) DO UPDATE SET org_id=EXCLUDED.org_id, team_role=EXCLUDED.team_role, relationship_label=EXCLUDED.relationship_label, assigned_by_subject=EXCLUDED.assigned_by_subject, active=EXCLUDED.active, created_at_utc=EXCLUDED.created_at_utc
                    """,
                    (f"CTM-{pid}-{m_sub}", pid, m_sub, m_org, m_role, m_label, actor_subject, now),
                )

            self._append_audit(
                conn,
                actor_subject=actor_subject,
                actor_role=user["role"],
                actor_org_id=user["org_id"],
                action="PATIENT_REGISTERED",
                entity_type="PATIENT",
                entity_id=pid,
                patient_id=pid,
                detail={
                    "patient_code": code,
                    "has_national_id": bool(digits),
                    "duplicate_override_reason": duplicate_override_reason if dupes["possible_matches"] else None,
                },
            )
            row = conn.execute("SELECT * FROM patients WHERE patient_id = ?", (pid,)).fetchone()
            return self._public_patient(conn, dict(row), user)

    def update_patient_identity(
        self,
        *,
        actor_subject: str,
        patient_id: str,
        reason: str,
        full_name: Optional[str] = None,
        display_name: Optional[str] = None,
        date_of_birth: Optional[str] = None,
        national_id: Optional[str] = None,
        no_national_id_reason: Optional[str] = None,
        hospital_number: Optional[str] = None,
        contact_phone: Optional[str] = None,
        sex: Optional[str] = None,
        age_group: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Correct an existing patient's identity details. Scope is checked before anything is read or
        changed; ward, organisation and care-team membership are never changed here."""
        now = datetime.now(timezone.utc).isoformat()
        with self._lock, self._connect() as conn:
            user, patient = self.authorize_patient_access(
                conn, actor_subject, patient_id, required_permission="UPDATE_PATIENT_IDENTITY",
                require_clinical_role=True, clinical_permission="REGISTER_PATIENT",
            )
            pid = patient["patient_id"]
            if user["org_id"] != patient["org_id"]:
                # A care-team member from another organisation may treat the patient, but the identity
                # belongs to the registering organisation.
                self._append_audit(
                    conn, actor_subject=actor_subject, actor_role=user["role"], actor_org_id=user["org_id"],
                    action="PATIENT_IDENTITY_UPDATE_DENIED", entity_type="PATIENT", entity_id=pid, patient_id=pid,
                    outcome="DENIED", detail={"reason": "Not the registering organisation."},
                )
                raise AccessDeniedError(
                    "REGISTERING_ORGANISATION_REQUIRED",
                    "Only staff of the organisation that registered this patient can change identity details.",
                )
            if not (reason or "").strip():
                raise ValueError("Give a reason for changing the patient's identity details.")

            name = (full_name or "").strip() or patient.get("full_name") or ""
            dob = date_of_birth or patient.get("date_of_birth")
            self._validate_name_and_birth_date(name, dob)
            changes: Dict[str, Any] = {}
            if name != patient.get("full_name"):
                changes.update(full_name=name, name_normalized=normalize_name(name))
                # A display name that simply repeated the old full name follows the new one.
                if not display_name and patient.get("display_name") == patient.get("full_name"):
                    changes["display_name"] = name
            if display_name and display_name.strip() != patient.get("display_name"):
                changes["display_name"] = display_name.strip()
            if dob != patient.get("date_of_birth"):
                changes["date_of_birth"] = dob
            digits: Optional[str] = None
            if national_id:
                digits = self._validate_identity(full_name=name, date_of_birth=dob, national_id=national_id,
                                                 no_national_id_reason=None)
                changes.update(
                    national_id_ciphertext=self.protector.encrypt(digits),
                    national_id_blind_index=self.protector.blind_index("THAI_CITIZEN_ID", digits),
                    national_id_last4=digits[-4:],
                    no_national_id_reason=None,
                )
            elif (no_national_id_reason or "").strip():
                changes.update(national_id_ciphertext=None, national_id_blind_index=None, national_id_last4=None,
                               no_national_id_reason=no_national_id_reason.strip())
            hn = (hospital_number or "").strip() or None
            if hospital_number is not None and hn != patient.get("hospital_number"):
                changes["hospital_number"] = hn
            if contact_phone is not None:
                changes["contact_phone_ciphertext"] = self.protector.encrypt(contact_phone.strip() or None)
            if sex and sex != patient.get("sex"):
                changes["sex"] = sex
            if age_group and age_group != patient.get("age_group"):
                changes["age_group"] = age_group
            if not changes:
                return self._public_patient(conn, patient, user)

            dupes = self.find_potential_duplicates(
                conn, user, full_name=name, date_of_birth=dob, national_id_digits=digits,
                hospital_number=changes.get("hospital_number"), exclude_patient_id=pid,
            )
            if dupes["exact_matches"] or dupes["conflict_outside_scope"]:
                raise DuplicatePatientError(
                    "DUPLICATE_PATIENT",
                    "Another patient already has this Citizen ID or hospital number.",
                    dupes,
                )
            conn.execute(
                f"UPDATE patients SET {', '.join(f'{k} = ?' for k in changes)}, updated_at_utc = ? WHERE patient_id = ?",
                (*changes.values(), now, pid),
            )
            # Field names only: the audit trail never carries identifier values.
            changed = sorted({
                "national_id" if k.startswith("national_id") or k == "no_national_id_reason"
                else "contact_phone" if k.startswith("contact_phone")
                else "full_name" if k == "name_normalized" else k
                for k in changes
            })
            self._append_audit(
                conn, actor_subject=actor_subject, actor_role=user["role"], actor_org_id=user["org_id"],
                action="PATIENT_IDENTITY_UPDATED", entity_type="PATIENT", entity_id=pid, patient_id=pid,
                detail={"changed_fields": changed, "reason": reason.strip()},
            )
            row = conn.execute("SELECT * FROM patients WHERE patient_id = ?", (pid,)).fetchone()
            return self._public_patient(conn, dict(row), user)

    def _resolve_wound(self, conn: db.Connection, patient_id: str, wound_ref: str, *, include_deleted: bool = False) -> Dict[str, Any]:
        row = conn.execute(
            "SELECT * FROM wounds WHERE patient_id = ? AND (wound_id = ? OR upper(wound_code) = upper(?))",
            (patient_id, wound_ref, wound_ref),
        ).fetchone()
        if not row:
            raise KeyError(f"Wound '{wound_ref}' not found for this patient.")
        if not include_deleted:
            self.require_active_record(conn, "wound", row["wound_id"])
        return dict(row)

    def create_wound(
        self,
        *,
        actor_subject: str,
        patient_id: str,
        wound_id: Optional[str] = None,
        anatomical_site: str = "SACRUM",
        laterality: str = "MIDLINE",
        wound_type: str = "PRESSURE_INJURY",
        pressure_injury_stage: str = "STAGE_3",
    ) -> Dict[str, Any]:
        """`wound_id` from callers is the human-readable wound code; the key is always a UUID."""
        now = datetime.now(timezone.utc).isoformat()
        with self._lock, self._connect() as conn:
            user, patient = self.authorize_patient_access(
                conn, actor_subject, patient_id, require_clinical_role=True, clinical_permission="REGISTER_WOUND"
            )
            pid = patient["patient_id"]
            if not (anatomical_site or "").strip():
                raise ValueError("Choose the wound's anatomical location.")
            if (wound_type, pressure_injury_stage) != ("UNCLASSIFIED", "NOT_ASSESSED"):
                # Classifying or staging a wound is a separate clinical permission.
                self.require_permission(conn, user, "STAGE", patient_id=pid)
            count = conn.execute("SELECT COUNT(*) AS n FROM wounds WHERE patient_id = ?", (pid,)).fetchone()["n"]
            code = (wound_id or "").strip().upper()
            taken = {r["code"] for r in conn.execute("SELECT upper(wound_code) AS code FROM wounds WHERE patient_id = ?", (pid,))}
            if not code:
                # A new wound (no code given) always gets a free code, so it can never re-register an
                # existing wound.
                number = count + 1
                while f"WOUND-{number:03d}" in taken:
                    number += 1
                code = f"WOUND-{number:03d}"
            elif code in taken:
                # Creation never updates: changing an existing wound's site, type or stage, or reopening
                # it, would silently rewrite the context of its signed measures.
                raise RecordConflictError(
                    "WOUND_CODE_IN_USE",
                    f"{code} already exists for this patient. Open that wound, or leave the code blank to add a new wound.",
                )
            wid = str(uuid5(NAMESPACE_URL, f"{DEMO_PATIENT_NAMESPACE}{pid}/{code}")) if patient["patient_code"] == "P001" else str(uuid4())
            conn.execute(
                """
                INSERT INTO wounds(
                    wound_id, patient_id, anatomical_site, laterality, wound_type,
                    pressure_injury_stage, status, created_by_subject, created_at_utc, updated_at_utc, wound_code
                ) VALUES (?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?, ?, ?)
                """,
                (wid, pid, anatomical_site, laterality, wound_type, pressure_injury_stage, actor_subject, now, now, code),
            )
            self._append_audit(
                conn,
                actor_subject=actor_subject,
                actor_role=user["role"],
                actor_org_id=user["org_id"],
                action="WOUND_RECORD_CREATED",
                entity_type="WOUND",
                entity_id=wid,
                patient_id=pid,
                wound_id=wid,
                detail={"wound_code": code, "anatomical_site": anatomical_site, "wound_type": wound_type},
            )
            row = conn.execute("SELECT * FROM wounds WHERE wound_id = ?", (wid,)).fetchone()
            return dict(row)

    def list_review_queue(self, *, actor_subject: str) -> List[Dict[str, Any]]:
        """Pending reviews within assigned patient/ward scope; requires assessment permission."""
        with self._lock, self._connect() as conn:
            user = self.get_user_record(conn, actor_subject)
            if user["role"] not in CLINICAL_ROLES:
                raise AccessDeniedError("CLINICAL_ROLE_REQUIRED", "Only medical staff have a review queue.")
            self.require_permission(conn, user, "ASSESS")
            scope_sql, scope_args = self._scope_clause(user)
            rows = conn.execute(
                f"""
                SELECT r.*, w.anatomical_site, w.wound_code, p.patient_code
                FROM review_requests r
                JOIN patients p ON p.patient_id = r.patient_id
                JOIN wounds w ON w.wound_id = r.wound_id
                WHERE {scope_sql} AND NOT EXISTS (
                    SELECT 1 FROM record_deletions d WHERE ((d.record_type = 'observation' AND d.record_id = r.observation_id)
                    OR (d.record_type = 'wound' AND d.record_id = r.wound_id)) AND d.restored_at_utc IS NULL)
                ORDER BY CASE r.status WHEN 'AWAITING_CLINICAL_REVIEW' THEN 0 ELSE 1 END,
                         CASE r.priority_level WHEN 'RED' THEN 0 WHEN 'YELLOW' THEN 1 ELSE 2 END,
                         r.created_at_utc
                LIMIT 200
                """,
                scope_args,
            ).fetchall()
            out = []
            for r in rows:
                item = dict(r)
                pat = dict(conn.execute("SELECT * FROM patients WHERE patient_id = ?", (item["patient_id"],)).fetchone())
                item["patient"] = self._public_patient(conn, pat, user)
                out.append(item)
            return out

    def create_and_accept_caregiver_grant(
        self,
        *,
        actor_subject: str,
        patient_id: str,
        grantee_subject: str = "caregiver.suda",
        wound_id: Optional[str] = None,
        permissions: Optional[List[str]] = None,
        auto_accept: bool = True,
        expires_in_days: int = 90,
        legal_basis_note: str = (
            "Patient/representative sharing authorisation recorded for home monitoring; "
            "clinical data processing governed separately under institutional healthcare delivery basis."
        ),
    ) -> Dict[str, Any]:
        now_dt = datetime.now(timezone.utc)
        now = now_dt.isoformat()
        exp = (now_dt + timedelta(days=expires_in_days)).isoformat()
        perms = permissions if permissions is not None else [
            "VIEW_APPROVED_PROGRESS",
            "UPLOAD_HOME_PHOTO",
            "SUBMIT_CAREGIVER_REPORT",
            "COMPLETE_CARE_TASKS",
        ]
        if any(p not in CAREGIVER_ACTIONS | {"ALL_CAREGIVER_ACTIONS"} for p in perms):
            raise ValueError("Access grants may only contain caregiver actions.")
        with self._lock, self._connect() as conn:
            user, patient = self.authorize_patient_access(
                conn, actor_subject, patient_id, require_clinical_role=False
            )
            if user["role"] not in CLINICAL_ROLES and not (
                user["role"] == "PATIENT" and patient.get("patient_account_subject") == actor_subject
            ):
                raise AccessDeniedError(
                    "GRANT_AUTHORISATION_REQUIRED",
                    "Only authorised clinicians or the patient/representative may issue caregiver access grants.",
                )
            grantee = self.get_user_record(conn, grantee_subject)
            if grantee["role"] not in CAREGIVER_ROLES | PATIENT_ROLES:
                raise ValueError("Access grants are for family caregivers or patient representatives only.")
            if wound_id:
                wound_id = self._resolve_wound(conn, patient["patient_id"], wound_id)["wound_id"]
            grant_id = f"GRT-{uuid4().hex[:10].upper()}"
            invite_token = f"INV-{uuid4().hex[:16]}"
            status_val = "ACTIVE" if auto_accept else "INVITED"
            accepted_at = now if auto_accept else None

            # Revoke any previous active grants for the same patient + grantee to avoid duplicates
            conn.execute(
                """
                UPDATE patient_access_grants
                SET status = 'SUPERSEDED', revoked_at_utc = ?, revoked_by_subject = ?
                WHERE patient_id = ? AND grantee_subject = ? AND status = 'ACTIVE'
                """,
                (now, actor_subject, patient["patient_id"], grantee_subject),
            )

            conn.execute(
                """
                INSERT INTO patient_access_grants(
                    grant_id, patient_id, wound_id, grantee_subject, grantee_email, granted_role,
                    permissions_json, invite_token, status, invited_by_subject, accepted_at_utc,
                    expires_at_utc, legal_basis_note, created_at_utc
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    grant_id,
                    patient["patient_id"],
                    wound_id,
                    grantee_subject,
                    grantee.get("email"),
                    grantee["role"],
                    json.dumps(perms),
                    invite_token,
                    status_val,
                    actor_subject,
                    accepted_at,
                    exp,
                    legal_basis_note,
                    now,
                ),
            )
            self._append_audit(
                conn,
                actor_subject=actor_subject,
                actor_role=user["role"],
                actor_org_id=user["org_id"],
                action="ACCESS_GRANT_CREATED",
                entity_type="ACCESS_GRANT",
                entity_id=grant_id,
                patient_id=patient["patient_id"],
                wound_id=wound_id,
                detail={
                    "grantee_subject": grantee_subject,
                    "status": status_val,
                    "permissions": perms,
                    "expires_at_utc": exp,
                },
            )
            row = conn.execute(
                "SELECT * FROM patient_access_grants WHERE grant_id = ?", (grant_id,)
            ).fetchone()
            return dict(row)

    def revoke_access_grant(
        self,
        *,
        actor_subject: str,
        grant_id: str,
        reason: str = "Access revoked by patient or clinical care team.",
    ) -> Dict[str, Any]:
        now = datetime.now(timezone.utc).isoformat()
        with self._lock, self._connect() as conn:
            g_row = conn.execute(
                "SELECT * FROM patient_access_grants WHERE grant_id = ?", (grant_id,)
            ).fetchone()
            if not g_row:
                raise KeyError(f"Access grant '{grant_id}' not found.")
            grant = dict(g_row)
            user, patient = self.authorize_patient_access(
                conn, actor_subject, grant["patient_id"], require_clinical_role=False
            )
            if user["role"] not in CLINICAL_ROLES and not (
                user["role"] == "PATIENT" and patient.get("patient_account_subject") == actor_subject
            ):
                raise AccessDeniedError(
                    "REVOKE_NOT_PERMITTED",
                    "Only clinical staff or the patient/representative may revoke access grants.",
                )
            conn.execute(
                """
                UPDATE patient_access_grants
                SET status = 'REVOKED', revoked_at_utc = ?, revoked_by_subject = ?, revocation_reason = ?
                WHERE grant_id = ?
                """,
                (now, actor_subject, reason, grant_id),
            )
            self._append_audit(
                conn,
                actor_subject=actor_subject,
                actor_role=user["role"],
                actor_org_id=user["org_id"],
                action="ACCESS_GRANT_REVOKED",
                entity_type="ACCESS_GRANT",
                entity_id=grant_id,
                patient_id=grant["patient_id"],
                detail={"grantee_subject": grant["grantee_subject"], "reason": reason},
            )
            updated = conn.execute(
                "SELECT * FROM patient_access_grants WHERE grant_id = ?", (grant_id,)
            ).fetchone()
            return dict(updated)

    def _save_private_image(
        self,
        conn: db.Connection,
        *,
        observation_id: str,
        patient_id: str,
        wound_id: str,
        image_role: str,
        raw_bytes: bytes,
        media_type: str = "image/jpeg",
        width_px: Optional[int] = None,
        height_px: Optional[int] = None,
    ) -> Dict[str, Any]:
        now = datetime.now(timezone.utc).isoformat()
        image_id = f"IMG-{uuid4().hex[:12].upper()}"
        fmt, actual_width, actual_height = inspect_image(raw_bytes, self.settings)
        ext, media_type = {"PNG": ("png", "image/png"), "JPEG": ("jpg", "image/jpeg"), "WEBP": ("webp", "image/webp")}[fmt]
        width_px, height_px = actual_width, actual_height
        rel_key = f"{patient_id}/{observation_id}/{image_role.lower()}_{image_id}.{ext}"
        full_path = self.private_storage_dir / rel_key
        full_path.parent.mkdir(parents=True, exist_ok=True)
        # Never overwrite a historical file, including an unexpected identifier collision.
        with full_path.open("xb") as file:
            conn.track_file(full_path)
            written = file.write(raw_bytes)
        sha = hashlib.sha256(raw_bytes).hexdigest()
        if written != len(raw_bytes) or hashlib.sha256(full_path.read_bytes()).hexdigest() != sha:
            raise OSError("Private image write failed byte-integrity verification")

        conn.execute(
            """
            INSERT INTO wound_images(
                image_id, observation_id, patient_id, wound_id, image_role,
                storage_key, media_type, width_px, height_px, sha256_hash, created_at_utc
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                image_id,
                observation_id,
                patient_id,
                wound_id,
                image_role,
                rel_key,
                media_type,
                width_px,
                height_px,
                sha,
                now,
            ),
        )
        sig, exp = sign_image_access_token(image_id, self.settings.session_secret)
        return {
            "image_id": image_id,
            "image_role": image_role,
            "signed_url": f"/v2/care/images/{image_id}?sig={sig}&exp={exp}",
            "expires_at_epoch": exp,
            "sha256_hash": sha,
        }

    def submission_status(self, *, actor_subject: str, patient_id: str, wound_id: str, submission_id: str) -> Dict[str, Any]:
        # No process-wide inference lock: status reads must remain possible while processing.
        with self._connect() as conn:
            _, patient = self.authorize_patient_access(conn, actor_subject, patient_id, wound_id=wound_id)
            wound = self._resolve_wound(conn, patient["patient_id"], wound_id)
            row = conn.execute(
                "SELECT * FROM observation_submissions WHERE actor_subject = ? AND submission_id = ? AND patient_id = ? AND wound_id = ?",
                (actor_subject, submission_id, patient["patient_id"], wound["wound_id"]),
            ).fetchone()
            if not row:
                return {"submission_id": submission_id, "status": "NOT_FOUND", "observation": None}
            if self._submission_interrupted(row):
                # Nothing was saved and nothing is still running here, so the same identity may retry.
                return {"submission_id": submission_id, "status": "FAILED", "observation": None,
                        "error_code": "SUBMISSION_INTERRUPTED"}
            observation = self.get_observation_detail(actor_subject=actor_subject, observation_id=row["observation_id"], conn_override=conn) if row["status"] == "SUCCEEDED" else None
            return {"submission_id": submission_id, "status": row["status"], "observation": observation,
                    "error_code": row["error_code"]}

    def _submission_interrupted(self, row: db.Row) -> bool:
        if row["status"] != "PROCESSING":
            return False
        started = datetime.fromisoformat(row["started_at_utc"])
        # An attempt from an earlier process cannot still be running in this one; a hung one is bounded.
        return started < self._started_at or datetime.now(timezone.utc) - started > SUBMISSION_STALE_AFTER

    @staticmethod
    def _complete_submission(conn: db.Connection, *, actor_subject: str, submission_id: str,
                             attempt_id: Optional[str], observation_id: str) -> None:
        completed = conn.execute(
            "UPDATE observation_submissions SET status = 'SUCCEEDED', observation_id = ?, finished_at_utc = ?, error_code = NULL WHERE actor_subject = ? AND submission_id = ? AND attempt_id = ? AND status = 'PROCESSING'",
            (observation_id, datetime.now(timezone.utc).isoformat(), actor_subject, submission_id, attempt_id),
        ).rowcount
        if completed != 1:
            raise SubmissionSupersededError("A newer attempt of this submission is in progress. Check its status.")

    def submit_wound_observation(self, *, submission_id: Optional[str] = None, **kwargs) -> Dict[str, Any]:
        # Legacy callers may omit an ID; current clients retain their UUID across retries.
        submission_id = submission_id or str(uuid4())
        if not re.fullmatch(r"[a-zA-Z0-9_.-]{1,128}", submission_id):
            raise ValueError("A submission ID must contain 1–128 letters, digits, dots, underscores or hyphens.")
        bound = inspect.signature(self._submit_wound_observation_once).bind(submission_id=submission_id, **kwargs)
        bound.apply_defaults()
        values = dict(bound.arguments)
        actor = values["actor_subject"]
        inspect_image(values["image_bytes"], self.settings)
        with self._connect() as conn:
            conn.execute("SELECT pg_advisory_xact_lock(4456001)")
            user, patient = self.authorize_patient_access(conn, actor, values["patient_id"], required_permission="UPLOAD_HOME_PHOTO")
            wound = self._resolve_wound(conn, patient["patient_id"], values["wound_id"])
            self.authorize_patient_access(conn, actor, patient["patient_id"], wound_id=wound["wound_id"], required_permission="UPLOAD_HOME_PHOTO")
            if user["role"] in CLINICAL_ROLES:
                self.require_permission(conn, user, "CAPTURE", patient_id=patient["patient_id"], wound_id=wound["wound_id"])
            values.update(patient_id=patient["patient_id"], wound_id=wound["wound_id"])
            intent = {k: v for k, v in values.items() if k not in {"pipeline", "image_bytes", "submission_id", "attempt_id"}}
            for name in ('corrects_observation_id', 'correction_reason'):
                if not intent.get(name): intent.pop(name, None)
            intent["image_sha256"] = hashlib.sha256(values["image_bytes"]).hexdigest()
            fingerprint = hashlib.sha256(json.dumps(intent, sort_keys=True).encode()).hexdigest()
            attempt_id = values["attempt_id"] = uuid4().hex
            existing = conn.execute("SELECT * FROM observation_submissions WHERE actor_subject = ? AND submission_id = ?", (actor, submission_id)).fetchone()
            if existing:
                if existing["payload_hash"] != fingerprint:
                    raise ClinicalConflictError("This submission ID belongs to different photo/report content.")
                if existing["status"] == "SUCCEEDED":
                    return self.get_observation_detail(actor_subject=actor, observation_id=existing["observation_id"], conn_override=conn)
                if existing["status"] == "PROCESSING" and not self._submission_interrupted(existing):
                    raise SubmissionPendingError("The original submission is still processing. Check its status before retrying.")
                # A new attempt ID supersedes any interrupted attempt; only one can mark this submission saved.
                conn.execute("UPDATE observation_submissions SET status = 'PROCESSING', attempt_id = ?, started_at_utc = ?, finished_at_utc = NULL, error_code = NULL WHERE actor_subject = ? AND submission_id = ?",
                             (attempt_id, datetime.now(timezone.utc).isoformat(), actor, submission_id))
            else:
                conn.execute("INSERT INTO observation_submissions(actor_subject, submission_id, patient_id, wound_id, payload_hash, status, attempt_id, started_at_utc) VALUES (?, ?, ?, ?, ?, 'PROCESSING', ?, ?)",
                             (actor, submission_id, patient["patient_id"], wound["wound_id"], fingerprint, attempt_id, datetime.now(timezone.utc).isoformat()))
        try:
            return self._submit_wound_observation_once(**values)
        except Exception as exc:
            with self._connect() as conn:
                # Never overwrite a committed success or a newer attempt's claim.
                conn.execute("UPDATE observation_submissions SET status = 'FAILED', finished_at_utc = ?, error_code = 'SUBMISSION_FAILED' WHERE actor_subject = ? AND submission_id = ? AND attempt_id = ? AND status = 'PROCESSING'",
                             (datetime.now(timezone.utc).isoformat(), actor, submission_id, attempt_id))
            if isinstance(exc, (AccessDeniedError, ValueError, KeyError, SubmissionPendingError)):
                raise
            raise SubmissionFailedError("The submission could not be saved. Check its status, then retry the same photo and report.") from exc

    def _submit_wound_observation_once(
        self,
        *,
        actor_subject: str,
        submission_id: str,
        corrects_observation_id: Optional[str] = None,
        correction_reason: str = "",
        patient_id: str,
        wound_id: str,
        image_bytes: bytes,
        capture_location_category: str = "HOME",
        segmentation_mode: str = "compare",
        sam_prompt: str = "wound",
        pain_score_0_10: Optional[int] = None,
        odor_observed: bool = False,
        dressing_intact: bool = True,
        redness_around_wound: bool = False,
        drainage_change: bool = False,
        fever_or_chills: bool = False,
        concern_flag: bool = False,
        non_diagnostic_notes: str = "",
        pipeline: MeasurementPipeline,
        capture_datetime_override_utc: Optional[str] = None,
        drainage_level: Optional[str] = None,
        dressing_condition: Optional[str] = None,
        redness_observed: Optional[str] = None,
        concern_reported: bool = False,
        attempt_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """
        Capture or upload a wound photograph from Hospital, Home, or Community.
        Runs AprilTag calibration + YOLOv8-seg / Meta SAM 3.1 segmentation, stores private images,
        creates version 1 PROVISIONAL_AI measurement, records CaregiverReport, and routes a ReviewRequest
        and privacy-safe Notification to the clinical care team.
        """
        now = capture_datetime_override_utc or datetime.now(timezone.utc).isoformat()
        with self._lock, self._connect() as conn:
            # Capture location is user input, not an authorisation boundary.
            req_perm = "UPLOAD_HOME_PHOTO"
            user, patient = self.authorize_patient_access(
                conn,
                actor_subject,
                patient_id,
                required_permission=req_perm,
                require_clinical_role=False,
            )
            wound_id = self._resolve_wound(conn, patient["patient_id"], wound_id)["wound_id"]
            # Re-check with the resolved wound so wound-scoped grants are honoured.
            self.authorize_patient_access(
                conn, actor_subject, patient["patient_id"], wound_id=wound_id, required_permission=req_perm
            )
            if user["role"] in CLINICAL_ROLES:
                self.require_permission(conn, user, "CAPTURE", patient_id=patient["patient_id"], wound_id=wound_id)
            if dressing_condition:
                dressing_intact = dressing_condition.upper() == "INTACT"
            if redness_observed:
                redness_around_wound = redness_observed.upper() == "YES"

            if corrects_observation_id:
                original = conn.execute('SELECT * FROM wound_observations WHERE observation_id=?',(corrects_observation_id,)).fetchone()
                if not original or (original['patient_id'],original['wound_id']) != (patient['patient_id'],wound_id):
                    raise ValueError('Photo corrections must retain their original patient and wound.')
                self.require_active_record(conn,'observation',corrects_observation_id)
                if user['role'] not in CLINICAL_ROLES and original['uploading_user_subject'] != actor_subject:
                    raise AccessDeniedError('RECORD_EDIT_DENIED','Only the original authorised caregiver can correct this photo.')
                if not isinstance(correction_reason,str) or not correction_reason.strip() or len(correction_reason)>512 or capture_datetime_override_utc:
                    raise ValueError('A concise correction reason and an actual new capture time are required.')
            obs_id = f"OBS-{uuid4().hex[:10].upper()}"
            session_req_id = f"care-session-{obs_id.lower()}"

            # Run real calibrated vision pipeline (AprilTag homography + YOLO + Meta SAM 3.1)
            try:
                session = pipeline.process(
                    image_bytes,
                    request_id=session_req_id,
                    segmentation_mode=segmentation_mode,  # type: ignore[arg-type]
                    sam_text_prompt=sam_prompt,
                    include_ai_explanation=False,
                )
            except ProcessingFailure as exc:
                conn.execute("SELECT pg_advisory_xact_lock(4456001)")
                self.require_active_record(conn, "wound", wound_id)
                # Persist the quality-gate rejection so invalid calibration images are audited
                # and blocked from clinical approval (Scene F safety guardrail).
                conn.execute(
                    """
                    INSERT INTO wound_observations(
                        observation_id, patient_id, wound_id, session_request_id, capture_datetime_utc,
                        uploading_user_subject, uploading_user_role, capture_location_category,
                        image_quality_status, quality_gate_status, ai_segmentation_provenance,
                        meta_execution_status, review_state, review_notes, created_at_utc
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'RETAKE_REQUIRED', 'calibration_rejected', 'quality_gate_halted', 'RETAKE_REQUESTED', ?, ?)
                    """,
                    (
                        obs_id,
                        patient["patient_id"],
                        wound_id,
                        session_req_id,
                        now,
                        actor_subject,
                        user["role"],
                        capture_location_category,
                        exc.code,
                        exc.message,
                        now,
                    ),
                )
                self._save_private_image(
                    conn,
                    observation_id=obs_id,
                    patient_id=patient["patient_id"],
                    wound_id=wound_id,
                    image_role="ORIGINAL_UPLOAD",
                    raw_bytes=image_bytes,
                    media_type="image/png",
                )
                rev_id = f"REV-{uuid4().hex[:10].upper()}"
                conn.execute(
                    """
                    INSERT INTO review_requests(
                        review_request_id, observation_id, patient_id, wound_id, submitted_by_subject,
                        submitted_from_location, assigned_org_id, status, priority_level,
                        concern_summary, created_at_utc
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'RETAKE_REQUESTED', 'RED', ?, ?)
                    """,
                    (
                        rev_id,
                        obs_id,
                        patient["patient_id"],
                        wound_id,
                        actor_subject,
                        capture_location_category,
                        patient["org_id"],
                        f"Quality Gate Rejected ({exc.code}): {exc.message}",
                        now,
                    ),
                )
                self._append_audit(
                    conn,
                    actor_subject=actor_subject,
                    actor_role=user["role"],
                    actor_org_id=user["org_id"],
                    action="OBSERVATION_QUALITY_GATE_REJECTED",
                    entity_type="OBSERVATION",
                    entity_id=obs_id,
                    patient_id=patient["patient_id"],
                    wound_id=wound_id,
                    outcome="REJECTED",
                    detail={"error_code": exc.code, "message": exc.message},
                )
                self._journal_photo_correction(conn,user,patient['patient_id'],wound_id,obs_id,corrects_observation_id,correction_reason)
                self._complete_submission(conn, actor_subject=actor_subject, submission_id=submission_id,
                                          attempt_id=attempt_id, observation_id=obs_id)
                return self.get_observation_detail(
                    actor_subject=actor_subject, observation_id=obs_id, conn_override=conn
                )

            conn.execute("SELECT pg_advisory_xact_lock(4456001)")
            self.require_active_record(conn, "wound", wound_id)
            # The pipeline selects its working source before computing gates and drafts.
            active_seg, active_meas = session.segmentation, session.measurements
            use_sam = session.provenance.active_model_source == "sam"
            source_model = "meta-sam-3.1" if use_sam else "yolov8-seg"

            review_state = (
                "AWAITING_CLINICAL_REVIEW"
                if active_meas is not None and session.quality_gate.status != "RETAKE_REQUIRED"
                else "RETAKE_REQUESTED"
            )
            ai_exp_json = (
                session.ai_explanation.model_dump_json()
                if session.ai_explanation is not None
                else None
            )

            conn.execute(
                """
                INSERT INTO wound_observations(
                    observation_id, patient_id, wound_id, session_request_id, capture_datetime_utc,
                    uploading_user_subject, uploading_user_role, capture_location_category,
                    image_quality_status, quality_gate_status, ai_segmentation_provenance,
                    meta_execution_status, review_state, ai_explanation_json, created_at_utc
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ai_predicted', ?, ?, ?, ?)
                """,
                (
                    obs_id,
                    patient["patient_id"],
                    wound_id,
                    session_req_id,
                    now,
                    actor_subject,
                    user["role"],
                    capture_location_category,
                    session.error_code or session.image_quality.status,
                    session.quality_gate.status,
                    session.quality_gate.meta_execution_status,
                    review_state,
                    ai_exp_json,
                    now,
                ),
            )

            # Save private images (Original upload, Canonical rectified crop, and AI mask)
            original = self._save_private_image(
                conn,
                observation_id=obs_id,
                patient_id=patient["patient_id"],
                wound_id=wound_id,
                image_role="ORIGINAL_UPLOAD",
                raw_bytes=image_bytes,
                media_type="image/png",
                width_px=session.image_quality.original_width_px,
                height_px=session.image_quality.original_height_px,
            )
            if session.canonical_image and session.canonical_image.data_base64:
                self._save_private_image(
                    conn,
                    observation_id=obs_id,
                    patient_id=patient["patient_id"],
                    wound_id=wound_id,
                    image_role="CANONICAL_RECTIFIED",
                    raw_bytes=base64.b64decode(session.canonical_image.data_base64),
                    media_type="image/jpeg",
                    width_px=session.canonical_image.width_px,
                    height_px=session.canonical_image.height_px,
                )
            colour = session.colour
            corrected = None
            if colour.corrected_canonical_image_base64:
                # A new file beside the canonical image; the original upload is never modified.
                corrected = self._save_private_image(
                    conn,
                    observation_id=obs_id,
                    patient_id=patient["patient_id"],
                    wound_id=wound_id,
                    image_role="COLOUR_CORRECTED",
                    raw_bytes=base64.b64decode(colour.corrected_canonical_image_base64),
                )
            colour_record = {
                **colour.model_dump(exclude={"corrected_canonical_image_base64"}),
                "source_image_sha256": original["sha256_hash"],
                "corrected_image_id": corrected["image_id"] if corrected else None,
                "corrected_image_sha256": corrected["sha256_hash"] if corrected else None,
                "corrected_image_basis": "canonical rectified image; per-pixel colour transform, geometry unchanged"
                if corrected else None,
            }
            conn.execute("UPDATE wound_observations SET colour_calibration_json = ? WHERE observation_id = ?",
                         (json.dumps(colour_record), obs_id))
            if active_seg and active_seg.canonical_mask_png_base64:
                self._save_private_image(
                    conn,
                    observation_id=obs_id,
                    patient_id=patient["patient_id"],
                    wound_id=wound_id,
                    image_role="AI_MASK_SAM" if use_sam else "AI_MASK_YOLO",
                    raw_bytes=base64.b64decode(active_seg.canonical_mask_png_base64),
                    media_type="image/png",
                    width_px=session.geometry.canonical_width_px,
                    height_px=session.geometry.canonical_height_px,
                )

            # Save Version 1 PROVISIONAL_AI measurement (never exposed as approved finding to caregivers)
            prov_meas_id: Optional[str] = None
            if active_meas is not None:
                prov_meas_id = f"MEAS-{uuid4().hex[:10].upper()}"
                conn.execute(
                    """
                    INSERT INTO wound_measurements(
                        measurement_id, observation_id, patient_id, wound_id, version_number,
                        measurement_stage, source_model, was_human_corrected, area_cm2, length_cm,
                        width_cm, clinical_length_cm, clinical_width_cm, perimeter_cm,
                        length_method, width_method, pixels_per_mm, boundary_px_json,
                        created_by_subject, created_at_utc
                    ) VALUES (?, ?, ?, ?, 1, 'PROVISIONAL_AI', ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        prov_meas_id,
                        obs_id,
                        patient["patient_id"],
                        wound_id,
                        source_model,
                        active_meas.area_cm2,
                        active_meas.length_cm,
                        active_meas.width_cm,
                        active_meas.clinical_length_cm,
                        active_meas.clinical_width_cm,
                        active_meas.perimeter_cm,
                        active_meas.length_method,
                        active_meas.width_method,
                        session.ruler.pixels_per_mm,
                        json.dumps(active_seg.canonical_boundary_px if active_seg else []),
                        actor_subject,
                        now,
                    ),
                )
                mask = cv2.imdecode(np.frombuffer(base64.b64decode(active_seg.canonical_mask_png_base64), dtype=np.uint8), cv2.IMREAD_GRAYSCALE)
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
                    "quality_gate": session.quality_gate.model_dump(),
                    "candidates": [c.model_dump() for c in active_seg.candidates],
                    "sam_guidance": active_seg.sam_guidance,
                    "colour_status": colour.status,
                    "measurement_lines": measurement_lines(active_meas),
                    "photo_coverage_px": session.geometry.photo_coverage_px,
                }
                conn.execute("UPDATE wound_measurements SET geometry_json = ? WHERE measurement_id = ?", (json.dumps(contract), prov_meas_id))
                conn.execute(
                    "UPDATE wound_observations SET provisional_measurement_id = ?, draft_measurement_id = ?, draft_status = ? WHERE observation_id = ?",
                    (prov_meas_id, prov_meas_id if ai_exp_json else None, "current" if ai_exp_json else "none", obs_id),
                )
            elif session.error_code == "no_wound_detected" and session.canonical_image and session.geometry.canonical_width_px:
                # Calibrated photo, no wound found: keep the AI's "no visible open wound" proposal (0 cm², no
                # boundary) with the calibration. The record stays a retake until someone records 0 cm² or
                # draws an outline; a clinician must verify either before it counts.
                contract = zero_area_contract(
                    self._calibration_contract(session, colour.status), basis=ZERO_AREA_AI, version=1)
                prov_meas_id = self._insert_zero_measurement(
                    conn, observation_id=obs_id, patient_id=patient["patient_id"], wound_id=wound_id, version=1,
                    stage="PROVISIONAL_AI", source_model=ZERO_AREA_AI, human=False, contract=contract,
                    actor_subject=actor_subject, now=now)
                conn.execute("UPDATE wound_observations SET provisional_measurement_id = ?, draft_status = 'none' WHERE observation_id = ?",
                             (prov_meas_id, obs_id))

            # Record CaregiverReport if caregiver/patient observations were provided
            has_concern = bool(
                concern_flag
                or concern_reported
                or redness_observed == "YES"
                or odor_observed
                or redness_around_wound
                or drainage_change
                or fever_or_chills
                or (pain_score_0_10 is not None and pain_score_0_10 >= 6)
            )
            if (
                capture_location_category == "HOME"
                or pain_score_0_10 is not None
                or non_diagnostic_notes
                or has_concern
                or drainage_level
                or dressing_condition
                or redness_observed
            ):
                rep_id = f"RPT-{uuid4().hex[:10].upper()}"
                conn.execute(
                    """
                    INSERT INTO caregiver_reports(
                        report_id, observation_id, patient_id, wound_id, submitted_by_subject,
                        pain_score_0_10, odor_observed, dressing_intact, redness_around_wound,
                        drainage_change, fever_or_chills, concern_flag, non_diagnostic_notes, created_at_utc,
                        drainage_level, dressing_condition, redness_observed, concern_reported
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        rep_id,
                        obs_id,
                        patient["patient_id"],
                        wound_id,
                        actor_subject,
                        pain_score_0_10,
                        1 if odor_observed else 0,
                        1 if dressing_intact else 0,
                        1 if redness_around_wound else 0,
                        1 if drainage_change else 0,
                        1 if fever_or_chills else 0,
                        1 if has_concern else 0,
                        non_diagnostic_notes,
                        now,
                        (drainage_level or "").upper() or None,
                        (dressing_condition or "").upper() or None,
                        (redness_observed or "").upper() or None,
                        1 if concern_reported else 0,
                    ),
                )

            # Create ReviewRequest in the Clinician Review Inbox
            rev_id = f"REV-{uuid4().hex[:10].upper()}"
            priority_lvl = "RED" if has_concern else "YELLOW"
            concern_text = (
                f"Concern reported (pain={pain_score_0_10 if pain_score_0_10 is not None else 'not given'}/10): {non_diagnostic_notes}"
                if has_concern
                else (non_diagnostic_notes or "Routine follow-up wound photograph awaiting verification.")
            )
            conn.execute(
                """
                INSERT INTO review_requests(
                    review_request_id, observation_id, patient_id, wound_id, submitted_by_subject,
                    submitted_from_location, assigned_org_id, status, priority_level,
                    concern_summary, created_at_utc
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    rev_id,
                    obs_id,
                    patient["patient_id"],
                    wound_id,
                    actor_subject,
                    capture_location_category,
                    patient["org_id"],
                    review_state,
                    priority_lvl,
                    concern_text,
                    now,
                ),
            )

            # Notify assigned primary clinician/nurse (privacy-safe preview without sensitive PII)
            primary_nurse = patient["primary_clinician_subject"]
            self._create_notification(
                conn,
                recipient_subject=primary_nurse,
                recipient_role="NURSE",
                patient_id=patient["patient_id"],
                wound_id=wound_id,
                observation_id=obs_id,
                notification_type="CAREGIVER_CONCERN_ALERT" if has_concern else "NEW_CAREGIVER_SUBMISSION",
                safe_preview_title=(
                    f"Priority Review Required ({capture_location_category})"
                    if has_concern
                    else f"New {capture_location_category.title()} Wound Submission Ready for Review"
                ),
                safe_preview_body=(
                    f"Observation {obs_id} for linked wound record requires Stage 1 & Stage 2 clinician review."
                ),
                clinical_owner_subject=primary_nurse,
            )

            self._append_audit(
                conn,
                actor_subject=actor_subject,
                actor_role=user["role"],
                actor_org_id=user["org_id"],
                action="WOUND_OBSERVATION_SUBMITTED",
                entity_type="OBSERVATION",
                entity_id=obs_id,
                patient_id=patient["patient_id"],
                wound_id=wound_id,
                detail={
                    "capture_location_category": capture_location_category,
                    "source_model": source_model,
                    "meta_execution_status": session.quality_gate.meta_execution_status,
                    "review_state": review_state,
                    "has_concern": has_concern,
                },
            )
            self._journal_photo_correction(conn,user,patient['patient_id'],wound_id,obs_id,corrects_observation_id,correction_reason)
            self._complete_submission(conn, actor_subject=actor_subject, submission_id=submission_id,
                                      attempt_id=attempt_id, observation_id=obs_id)
            return self.get_observation_detail(
                actor_subject=actor_subject, observation_id=obs_id, conn_override=conn
            )

    def clinician_refine_observation_mask(
        self,
        *,
        actor_subject: str,
        observation_id: str,
        edited_boundary_px: Optional[List[List[float]]] = None,
        nudge_outward_px: int = 2,  # retained wire compatibility; never fabricates a polygon
        expected_measurement_id: Optional[str] = None,
        selected_candidate_id: Optional[int] = None,
        amends_assessment_id: Optional[str] = None,
        correction_notes: str = "Clinician refined Meta SAM 3.1 boundary at wound margin.",
        measurement_region: Optional[str] = None,
    ) -> Dict[str, Any]:
        """
        Stage 1 Human-in-the-Loop Boundary Correction on a submitted observation.
        Creates a new versioned `HUMAN_CORRECTED` measurement row (version 2) without overwriting
        the original `PROVISIONAL_AI` measurement row (version 1).
        """
        if measurement_region is not None and measurement_region not in MEASUREMENT_REGIONS:
            raise ValueError("Measurement region must be whole_wound or red_tissue.")
        now = datetime.now(timezone.utc).isoformat()
        with self._lock, self._connect() as conn:
            conn.execute("SELECT pg_advisory_xact_lock(4456001)")
            obs_row = conn.execute(
                "SELECT * FROM wound_observations WHERE observation_id = ?", (observation_id,)
            ).fetchone()
            if not obs_row:
                raise KeyError(f"Observation '{observation_id}' not found.")
            obs = dict(obs_row)
            user, _ = self.authorize_patient_access(
                conn,
                actor_subject,
                obs["patient_id"],
                wound_id=obs["wound_id"],
                require_clinical_role=True,
                clinical_permission="ASSESS",
            )
            self.require_active_record(conn, "observation", observation_id)
            if obs["review_state"] != "AWAITING_CLINICAL_REVIEW" or obs["final_approved_measurement_id"]:
                latest = conn.execute('SELECT assessment_id FROM clinical_assessments WHERE observation_id=? ORDER BY version_number DESC,sequence_id DESC LIMIT 1',(observation_id,)).fetchone()
                if obs['review_state'] != 'CLINICIAN_APPROVED' or not latest or amends_assessment_id != latest['assessment_id']:
                    raise ClinicalConflictError("Only a pending observation can be refined; signed records require an amendment.")
                self.verify_observation_image_integrity(conn, observation_id, actor_subject=actor_subject)

            prov_row = conn.execute(
                "SELECT * FROM wound_measurements WHERE measurement_id = ?",
                (obs["human_corrected_measurement_id"] or obs["provisional_measurement_id"],),
            ).fetchone()
            if not prov_row:
                raise ValueError("Observation has no provisional AI measurement to refine.")
            prov = dict(prov_row)
            if expected_measurement_id is not None and expected_measurement_id != prov["measurement_id"]:
                raise ClinicalConflictError("Measurement changed. Reload before correcting the boundary.")
            contract = json.loads(prov.get("geometry_json") or "null")
            if not contract or not contract.get("inner_bounds_px") or not contract.get("calibration_id"):
                raise ValueError("Stored geometry is unavailable for this legacy observation. Recapture; dimensions cannot be guessed.")
            width, height = contract["canonical_width_px"], contract["canonical_height_px"]
            inner_bounds = contract["inner_bounds_px"]
            ppm = contract["pixels_per_mm"]
            if not width or not height or not ppm or not np.isfinite(ppm) or ppm <= 0:
                raise ValueError("Stored calibration is invalid. Recapture this observation.")
            if selected_candidate_id is not None:
                if edited_boundary_px is not None:
                    raise ValueError("Select a component or edit its boundary, not both in one request.")
                candidate = next((c for c in contract.get("candidates", []) if c["candidate_id"] == selected_candidate_id), None)
                if candidate is None:
                    raise ValueError("Selected component does not exist in this measurement version.")
                new_mask = cv2.imdecode(np.frombuffer(base64.b64decode(candidate["canonical_mask_png_base64"]), dtype=np.uint8), cv2.IMREAD_GRAYSCALE)
                if new_mask is None or new_mask.shape != (height, width):
                    raise ValueError("Stored component geometry is invalid. Recapture.")
                candidate_region = BOUNDARY_KIND_REGION.get(candidate.get("boundary_kind"))
                if measurement_region and candidate_region and measurement_region != candidate_region:
                    raise ValueError("The selected candidate measures a different region; choose the matching candidate.")
                region = candidate_region or measurement_region
            else:
                new_mask = strict_polygon_mask(edited_boundary_px, width, height, inner_bounds)
                # An edit keeps the region it started from unless the clinician declares another.
                region = measurement_region or contract.get("measurement_region")
            if reaches_outside_photo(new_mask, contract.get("photo_coverage_px"), ppm):
                raise ValueError("The boundary reaches the part of the ruler's square that is outside the photo. Keep it inside the photo.")
            m_recalc = calculate_measurements(new_mask, ppm)
            new_poly = contour_from_mask(new_mask)

            # Save private human-corrected mask image
            mask_png_bytes = base64.b64decode(encode_mask_png(new_mask))
            self._save_private_image(
                conn,
                observation_id=observation_id,
                patient_id=obs["patient_id"],
                wound_id=obs["wound_id"],
                image_role="HUMAN_CORRECTED_MASK",
                raw_bytes=mask_png_bytes,
                media_type="image/png",
                width_px=width,
                height_px=height,
            )

            next_ver_row = conn.execute(
                "SELECT COALESCE(MAX(version_number), 1) + 1 AS next_v FROM wound_measurements WHERE observation_id = ?",
                (observation_id,),
            ).fetchone()
            next_v = int(next_ver_row["next_v"]) if next_ver_row else 2
            corr_meas_id = f"MEAS-{uuid4().hex[:10].upper()}"

            conn.execute(
                """
                INSERT INTO wound_measurements(
                    measurement_id, observation_id, patient_id, wound_id, version_number,
                    measurement_stage, source_model, was_human_corrected, area_cm2, length_cm,
                    width_cm, clinical_length_cm, clinical_width_cm, perimeter_cm,
                    length_method, width_method, pixels_per_mm, boundary_px_json,
                    created_by_subject, created_at_utc
                ) VALUES (?, ?, ?, ?, ?, 'HUMAN_CORRECTED', ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    corr_meas_id,
                    observation_id,
                    obs["patient_id"],
                    obs["wound_id"],
                    next_v,
                    "clinician_drawn_outline" if contract.get("model_source") in (ZERO_AREA_AI, ZERO_AREA_CLINICIAN)
                    else f"{contract['model_source']}+human_corrected",
                    round(m_recalc.area_cm2, 4),
                    round(m_recalc.length_cm, 4),
                    round(m_recalc.width_cm, 4),
                    round(m_recalc.clinical_length_cm, 4),
                    round(m_recalc.clinical_width_cm, 4),
                    round(m_recalc.perimeter_cm, 4),
                    "maximum_vertical_chord",
                    "maximum_horizontal_chord",
                    ppm,
                    json.dumps(new_poly),
                    actor_subject,
                    now,
                ),
            )
            gate = corrected_gate(contract.get("quality_gate", {}), new_mask, inner_bounds, obs["image_quality_status"])
            # A drawn boundary replaces a "no visible open wound" version; it is a normal outline from now on.
            contract = {k: v for k, v in contract.items() if k not in ("zero_area", "zero_area_basis")}
            contract = {**contract, "mask_sha256": mask_hash(new_mask), "measurement_version": next_v,
                        "selected_component_id": selected_candidate_id, "selection_required": False, "quality_gate": gate,
                        "measurement_region": region, "measurement_lines": measurement_lines(m_recalc)}
            conn.execute(
                "UPDATE wound_measurements SET source_measurement_id = ?, geometry_json = ? WHERE measurement_id = ?",
                (prov["measurement_id"], json.dumps(contract), corr_meas_id),
            )
            conn.execute(
                """
                UPDATE wound_observations
                SET human_corrected_measurement_id = ?, ai_segmentation_provenance = 'human_corrected',
                    quality_gate_status = ?, ai_explanation_json = NULL, draft_status = 'stale', draft_measurement_id = NULL
                WHERE observation_id = ?
                """,
                (corr_meas_id, gate["status"], observation_id),
            )
            self._append_audit(
                conn,
                actor_subject=actor_subject,
                actor_role=user["role"],
                actor_org_id=user["org_id"],
                action="OBSERVATION_MASK_HUMAN_CORRECTED",
                entity_type="MEASUREMENT",
                entity_id=corr_meas_id,
                patient_id=obs["patient_id"],
                wound_id=obs["wound_id"],
                detail={
                    "provisional_area_cm2": prov["area_cm2"],
                    "corrected_area_cm2": round(m_recalc.area_cm2, 4),
                    "version_number": next_v,
                    "correction_notes": correction_notes,
                    "measurement_region": region,
                },
            )
            return self.get_observation_detail(
                actor_subject=actor_subject, observation_id=observation_id, conn_override=conn
            )

    def preview_observation_measurement(
        self,
        *,
        actor_subject: str,
        observation_id: str,
        edited_boundary_px: List[List[float]],
        expected_measurement_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """
        Measure an edited boundary exactly as saving it would, without storing anything.

        Uses the same access rule, stored calibration, polygon rasterisation and
        `calculate_measurements` as `clinician_refine_observation_mask`, so the figures shown while
        editing equal the ones a save records. Only a denied access attempt is written (to the audit).
        """
        with self._connect() as conn:
            obs_row = conn.execute("SELECT * FROM wound_observations WHERE observation_id = ?", (observation_id,)).fetchone()
            if not obs_row:
                raise KeyError(f"Observation '{observation_id}' not found.")
            obs = dict(obs_row)
            self.authorize_patient_access(conn, actor_subject, obs["patient_id"], wound_id=obs["wound_id"],
                                          require_clinical_role=True, clinical_permission="ASSESS")
            self.require_active_record(conn, "observation", observation_id)
            base = conn.execute("SELECT measurement_id, geometry_json FROM wound_measurements WHERE measurement_id = ?",
                                (obs["human_corrected_measurement_id"] or obs["provisional_measurement_id"],)).fetchone()
            if not base:
                raise ValueError("Observation has no measurement to compare with.")
            if expected_measurement_id is not None and expected_measurement_id != base["measurement_id"]:
                raise ClinicalConflictError("Measurement changed. Reload before correcting the boundary.")
            contract = json.loads(base["geometry_json"] or "null")
            if not contract or not contract.get("inner_bounds_px") or not contract.get("calibration_id"):
                raise ValueError("Stored geometry is unavailable for this legacy observation. Recapture; dimensions cannot be guessed.")
            ppm = contract["pixels_per_mm"]
            if not contract["canonical_width_px"] or not contract["canonical_height_px"] or not ppm or not np.isfinite(ppm) or ppm <= 0:
                raise ValueError("Stored calibration is invalid. Recapture this observation.")
            mask = strict_polygon_mask(edited_boundary_px, contract["canonical_width_px"], contract["canonical_height_px"],
                                       contract["inner_bounds_px"])
            if reaches_outside_photo(mask, contract.get("photo_coverage_px"), ppm):
                raise ValueError("The boundary reaches the part of the ruler's square that is outside the photo. Keep it inside the photo.")
            m = calculate_measurements(mask, ppm)
            return {
                "base_measurement_id": base["measurement_id"],
                "pixels_per_mm": ppm,
                "area_cm2": round(m.area_cm2, 4),
                "length_cm": round(m.length_cm, 4),
                "width_cm": round(m.width_cm, 4),
                "clinical_length_cm": round(m.clinical_length_cm, 4),
                "clinical_width_cm": round(m.clinical_width_cm, 4),
                "perimeter_cm": round(m.perimeter_cm, 4),
                "lines": measurement_lines(m),
                "saved": False,
            }

    @staticmethod
    def _calibration_contract(session: Any, colour_status: Optional[str]) -> Dict[str, Any]:
        """The ruler calibration of a processed photo, in the shape of a measurement geometry contract."""
        return {
            "canonical_width_px": session.geometry.canonical_width_px,
            "canonical_height_px": session.geometry.canonical_height_px,
            "inner_bounds_px": session.geometry.inner_bounds_px,
            "pixels_per_mm": session.ruler.pixels_per_mm,
            "calibration_id": session.request_id,
            "ruler": session.ruler.model_dump(),
            "model_source": ZERO_AREA_AI,
            "model_version": session.segmentation.model_version if session.segmentation else None,
            "measurement_algorithm_version": None,
            "quality_gate": session.quality_gate.model_dump(),
            "candidates": [],
            "sam_guidance": None,
            "colour_status": colour_status,
            "photo_coverage_px": session.geometry.photo_coverage_px,
        }

    @staticmethod
    def _insert_zero_measurement(conn: db.Connection, *, observation_id: str, patient_id: str, wound_id: str,
                                 version: int, stage: str, source_model: str, human: bool, contract: Dict[str, Any],
                                 actor_subject: str, now: str, source_measurement_id: Optional[str] = None) -> str:
        meas_id = f"MEAS-{uuid4().hex[:10].upper()}"
        conn.execute(
            """
            INSERT INTO wound_measurements(
                measurement_id, observation_id, patient_id, wound_id, version_number,
                measurement_stage, source_model, was_human_corrected, area_cm2, length_cm,
                width_cm, clinical_length_cm, clinical_width_cm, perimeter_cm,
                length_method, width_method, pixels_per_mm, boundary_px_json,
                created_by_subject, created_at_utc, source_measurement_id, geometry_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0, 0, 0, 'maximum_vertical_chord', 'maximum_horizontal_chord',
                      ?, '[]', ?, ?, ?, ?)
            """,
            (meas_id, observation_id, patient_id, wound_id, version, stage, source_model, 1 if human else 0,
             contract["pixels_per_mm"], actor_subject, now, source_measurement_id, json.dumps(contract)),
        )
        return meas_id

    def record_zero_area(
        self,
        *,
        actor_subject: str,
        observation_id: str,
        intent: str = "record_zero",
        expected_measurement_id: Optional[str] = None,
        amends_assessment_id: Optional[str] = None,
        pipeline: Optional[MeasurementPipeline] = None,
    ) -> Dict[str, Any]:
        """Record "no visible open wound" (0 cm²) for clinician verification, or open a no-wound photo for drawing.

        - A calibrated photo on which the AI found no wound (a retake): `record_zero` sends its 0 cm² proposal to
          clinician review; a clinician's `draw_outline` opens it for review so a boundary can be drawn.
        - A pending (or, with an amendment, signed) record with an AI outline: a clinician records 0 cm² as a new
          version, e.g. when healed scar or new skin was outlined. Earlier versions are kept.
        Nothing here approves anything, invents a boundary or relaxes photo integrity checks.
        """
        if intent not in {"record_zero", "draw_outline"}:
            raise ValueError("Choose to record 0 cm² or to draw an outline.")
        now = datetime.now(timezone.utc).isoformat()
        with self._lock, self._connect() as conn:
            conn.execute("SELECT pg_advisory_xact_lock(4456001)")
            row = conn.execute("SELECT * FROM wound_observations WHERE observation_id = ?", (observation_id,)).fetchone()
            if not row:
                raise KeyError(f"Observation '{observation_id}' not found.")
            obs = dict(row)
            user = self.get_user_record(conn, actor_subject)
            clinical = user["role"] in CLINICAL_ROLES
            no_wound_retake = (obs["review_state"] == "RETAKE_REQUESTED" and obs["image_quality_status"] == "no_wound_detected"
                               and not obs["reviewing_clinician_subject"] and not obs["final_approved_measurement_id"])
            if no_wound_retake and intent == "record_zero" and not clinical:
                # The person who took the photo may propose 0 cm²; a clinician still has to verify it.
                self.authorize_patient_access(conn, actor_subject, obs["patient_id"], wound_id=obs["wound_id"],
                                              required_permission="UPLOAD_HOME_PHOTO")
                if obs["uploading_user_subject"] != actor_subject:
                    raise AccessDeniedError("RECORD_EDIT_DENIED", "Only the person who took this photo can record it as 0 cm².")
            else:
                self.authorize_patient_access(conn, actor_subject, obs["patient_id"], wound_id=obs["wound_id"],
                                              require_clinical_role=True, clinical_permission="ASSESS")
            self.require_active_record(conn, "observation", observation_id)
            current_id = obs["human_corrected_measurement_id"] or obs["provisional_measurement_id"]
            current = conn.execute("SELECT * FROM wound_measurements WHERE measurement_id = ?", (current_id,)).fetchone() if current_id else None
            current = dict(current) if current else None
            if expected_measurement_id is not None and current and expected_measurement_id != current["measurement_id"]:
                raise ClinicalConflictError("Measurement changed. Reload before recording 0 cm².")

            if no_wound_retake:
                if current is None:
                    # Photos taken before this feature kept no proposal: recompute the calibration from the stored
                    # original (ruler only; the AI result is unchanged) and check it matches the stored rectified image.
                    current = self._legacy_zero_proposal(conn, obs, actor_subject, now, pipeline)
                elif not is_zero_area(json.loads(current.get("geometry_json") or "null")):
                    raise ClinicalConflictError("This photo already has a measurement. Reload the record.")
                conn.execute(
                    """UPDATE wound_observations SET review_state = 'AWAITING_CLINICAL_REVIEW', quality_gate_status = 'REVIEW_REQUIRED'
                       WHERE observation_id = ?""", (observation_id,))
                summary = ("No visible open wound: 0 cm² proposed for clinician verification." if intent == "record_zero"
                           else "No wound found by the AI; opened for the clinician to draw the boundary.")
                conn.execute(
                    """UPDATE review_requests SET status = 'AWAITING_CLINICAL_REVIEW', priority_level = 'YELLOW', concern_summary = ?
                       WHERE observation_id = ?""", (summary, observation_id))
                if not clinical:
                    patient = conn.execute("SELECT primary_clinician_subject FROM patients WHERE patient_id = ?", (obs["patient_id"],)).fetchone()
                    if patient and patient["primary_clinician_subject"]:
                        self._create_notification(
                            conn, recipient_subject=patient["primary_clinician_subject"], recipient_role="NURSE",
                            patient_id=obs["patient_id"], wound_id=obs["wound_id"], observation_id=observation_id,
                            notification_type="NEW_CAREGIVER_SUBMISSION",
                            safe_preview_title="No Visible Wound Reported · Verification Needed",
                            safe_preview_body=f"Observation {observation_id} was recorded as 0 cm² and needs clinician verification.",
                            clinical_owner_subject=patient["primary_clinician_subject"])
                action, detail = ("OBSERVATION_ZERO_AREA_PROPOSED" if intent == "record_zero" else "OBSERVATION_OPENED_FOR_OUTLINE",
                                  {"measurement_id": current["measurement_id"], "basis": ZERO_AREA_AI})
            else:
                if intent != "record_zero":
                    raise ValueError("Draw the boundary with Edit boundary on the record.")
                if obs["review_state"] != "AWAITING_CLINICAL_REVIEW" or obs["final_approved_measurement_id"]:
                    latest = conn.execute('SELECT assessment_id FROM clinical_assessments WHERE observation_id=? ORDER BY version_number DESC,sequence_id DESC LIMIT 1', (observation_id,)).fetchone()
                    if obs['review_state'] != 'CLINICIAN_APPROVED' or not latest or amends_assessment_id != latest['assessment_id']:
                        raise ClinicalConflictError("Only a pending record can be changed to 0 cm²; signed records require an amendment.")
                    self.verify_observation_image_integrity(conn, observation_id, actor_subject=actor_subject)
                if current is None:
                    raise ValueError("This photo has no calibrated measurement. A new photo is needed.")
                base = json.loads(current.get("geometry_json") or "null")
                if not base or not base.get("calibration_id") or not base.get("pixels_per_mm"):
                    raise ValueError("Stored calibration is unavailable for this photo. A new photo is needed; 0 cm² cannot be recorded without it.")
                if is_zero_area(base) and current["measurement_stage"] != "FINAL_CLINICIAN_APPROVED" and obs["review_state"] == "AWAITING_CLINICAL_REVIEW":
                    return self.get_observation_detail(actor_subject=actor_subject, observation_id=observation_id, conn_override=conn)
                next_v = int(conn.execute("SELECT COALESCE(MAX(version_number), 1) + 1 AS v FROM wound_measurements WHERE observation_id = ?",
                                          (observation_id,)).fetchone()["v"])
                contract = zero_area_contract(base, basis=ZERO_AREA_CLINICIAN, version=next_v)
                meas_id = self._insert_zero_measurement(
                    conn, observation_id=observation_id, patient_id=obs["patient_id"], wound_id=obs["wound_id"], version=next_v,
                    stage="HUMAN_CORRECTED", source_model=ZERO_AREA_CLINICIAN, human=True, contract=contract,
                    actor_subject=actor_subject, now=now, source_measurement_id=current["measurement_id"])
                conn.execute(
                    """UPDATE wound_observations SET human_corrected_measurement_id = ?, ai_segmentation_provenance = 'human_corrected',
                       quality_gate_status = 'REVIEW_REQUIRED', ai_explanation_json = NULL, draft_status = 'stale', draft_measurement_id = NULL
                       WHERE observation_id = ?""", (meas_id, observation_id))
                action, detail = "OBSERVATION_ZERO_AREA_RECORDED", {
                    "measurement_id": meas_id, "version_number": next_v, "previous_area_cm2": current["area_cm2"],
                    "basis": ZERO_AREA_CLINICIAN}
            self._append_audit(conn, actor_subject=actor_subject, actor_role=user["role"], actor_org_id=user["org_id"],
                               action=action, entity_type="OBSERVATION", entity_id=observation_id,
                               patient_id=obs["patient_id"], wound_id=obs["wound_id"], detail=detail)
            return self.get_observation_detail(actor_subject=actor_subject, observation_id=observation_id, conn_override=conn)

    def _legacy_zero_proposal(self, conn: db.Connection, obs: Dict[str, Any], actor_subject: str, now: str,
                              pipeline: Optional[MeasurementPipeline]) -> Dict[str, Any]:
        if pipeline is None:
            raise ValueError("The measurement service is unavailable. Try again later.")
        images = {r["image_role"]: dict(r) for r in conn.execute(
            "SELECT * FROM wound_images WHERE observation_id = ? ORDER BY sequence_id", (obs["observation_id"],)).fetchall()}
        original, rectified = images.get("ORIGINAL_UPLOAD"), images.get("CANONICAL_RECTIFIED")
        if not original or not rectified:
            raise ValueError("This photo has no stored calibration. Take a new photo.")
        self.verify_observation_image_integrity(conn, obs["observation_id"], actor_subject=actor_subject)
        raw = (self.private_storage_dir / original["storage_key"]).read_bytes()
        try:
            session = pipeline.process(raw, request_id=f"recalibrate-{obs['observation_id'].lower()}", segmentation_mode="yolo")
        except ProcessingFailure as exc:
            raise ValueError("The ruler could not be calibrated on the stored photo. Take a new photo.") from exc
        if (session.geometry.canonical_width_px, session.geometry.canonical_height_px) != (rectified["width_px"], rectified["height_px"]):
            raise ValueError("The recomputed calibration does not match the stored photo. Take a new photo.")
        base = {**self._calibration_contract(session, None), "calibration_recomputed_from_original": True,
                "calibration_recomputed_at_utc": now}
        contract = zero_area_contract(base, basis=ZERO_AREA_AI, version=1)
        meas_id = self._insert_zero_measurement(
            conn, observation_id=obs["observation_id"], patient_id=obs["patient_id"], wound_id=obs["wound_id"], version=1,
            stage="PROVISIONAL_AI", source_model=ZERO_AREA_AI, human=False, contract=contract,
            actor_subject=actor_subject, now=now)
        conn.execute("UPDATE wound_observations SET provisional_measurement_id = ?, draft_status = 'none' WHERE observation_id = ?",
                     (meas_id, obs["observation_id"]))
        return dict(conn.execute("SELECT * FROM wound_measurements WHERE measurement_id = ?", (meas_id,)).fetchone())

    def set_wound_status(self, *, actor_subject: str, patient_id: str, wound_id: str, status: str, reason: str) -> Dict[str, Any]:
        """Mark a wound healed (clinician-confirmed, after a verified 0 cm² measurement) or reopen it."""
        if status not in {"HEALED", "ACTIVE"}:
            raise ValueError("Status must be HEALED or ACTIVE.")
        if not isinstance(reason, str) or not reason.strip() or len(reason) > 512:
            raise ValueError("A concise reason is required.")
        now = datetime.now(timezone.utc).isoformat()
        with self._lock, self._connect() as conn:
            conn.execute("SELECT pg_advisory_xact_lock(4456001)")
            user, patient = self.authorize_patient_access(conn, actor_subject, patient_id, wound_id=wound_id,
                                                          require_clinical_role=True, require_signoff_qualification=True,
                                                          clinical_permission="ASSESS")
            wound = self._resolve_wound(conn, patient["patient_id"], wound_id)
            self.require_active_record(conn, "wound", wound["wound_id"])
            if status == "HEALED":
                if wound["status"] != "ACTIVE":
                    raise ClinicalConflictError("Only an active wound can be marked healed. Reload the record.")
                latest = conn.execute(
                    """SELECT m.area_cm2, m.geometry_json, o.observation_id FROM wound_observations o
                       JOIN wound_measurements m ON m.measurement_id = o.final_approved_measurement_id
                       WHERE o.wound_id = ? AND o.review_state = 'CLINICIAN_APPROVED' AND NOT EXISTS (
                           SELECT 1 FROM record_deletions d WHERE d.record_type = 'observation'
                           AND d.record_id = o.observation_id AND d.restored_at_utc IS NULL)
                       ORDER BY o.capture_datetime_utc DESC LIMIT 1""", (wound["wound_id"],)).fetchone()
                if not latest or float(latest["area_cm2"]) != 0 or not is_zero_area(json.loads(latest["geometry_json"] or "null")):
                    raise ValueError("A wound can be marked healed only when its latest verified measurement is 0 cm² (no visible open wound).")
                conn.execute("UPDATE wounds SET status = 'HEALED', healed_at_utc = ?, healed_by_subject = ?, updated_at_utc = ? WHERE wound_id = ?",
                             (now, actor_subject, now, wound["wound_id"]))
                action, detail = "WOUND_MARKED_HEALED", {"reason": reason.strip(), "verified_observation_id": latest["observation_id"]}
            else:
                if wound["status"] != "HEALED":
                    raise ClinicalConflictError("Only a healed wound can be reopened. Reload the record.")
                conn.execute("UPDATE wounds SET status = 'ACTIVE', reopened_at_utc = ?, updated_at_utc = ? WHERE wound_id = ?",
                             (now, now, wound["wound_id"]))
                action, detail = "WOUND_REOPENED", {"reason": reason.strip()}
            self._append_audit(conn, actor_subject=actor_subject, actor_role=user["role"], actor_org_id=user["org_id"],
                               action=action, entity_type="WOUND", entity_id=wound["wound_id"],
                               patient_id=patient["patient_id"], wound_id=wound["wound_id"], detail=detail)
            return dict(conn.execute("SELECT * FROM wounds WHERE wound_id = ?", (wound["wound_id"],)).fetchone())

    @staticmethod
    def _reported_concern(conn: db.Connection, observation_id: str) -> bool:
        reports = conn.execute("SELECT * FROM caregiver_reports WHERE observation_id = ?", (observation_id,)).fetchall()
        return any(
            any(r[key] for key in ("concern_flag", "concern_reported", "odor_observed", "redness_around_wound", "drainage_change", "fever_or_chills"))
            or r["redness_observed"] == "YES" or (r["pain_score_0_10"] is not None and r["pain_score_0_10"] >= 6)
            for r in reports
        )

    def verify_observation_image_integrity(self, conn, observation_id, measurement=None, *, actor_subject=None):
        from app.services.image_integrity import ImageIntegrityError, verify_observation_images
        try:
            verify_observation_images(conn, self.private_storage_dir, observation_id, self.settings, measurement)
        except ImageIntegrityError as exc:
            if actor_subject:
                user = self.get_user_record(conn, actor_subject)
                row = conn.execute("SELECT patient_id,wound_id FROM wound_observations WHERE observation_id=?", (observation_id,)).fetchone()
                self._append_audit(conn, actor_subject=actor_subject, actor_role=user["role"], actor_org_id=user["org_id"],
                    action="IMAGE_INTEGRITY_SIGNOFF_BLOCKED", entity_type="OBSERVATION", entity_id=observation_id,
                    patient_id=row["patient_id"] if row else None, wound_id=row["wound_id"] if row else None,
                    outcome="DENIED", detail={"reason": "Persisted image evidence failed verification"})
            raise ClinicalConflictError(str(exc)) from exc

    def clinician_review_and_approve_observation(
        self,
        *,
        actor_subject: str,
        observation_id: str,
        amends_assessment_id: Optional[str] = None,
        amendment_reason: Optional[str] = None,
        expected_record_revision: Optional[int] = None,
        factual_fields: Optional[Dict[str, Any]] = None,
        decision: Optional[str] = None,  # "approve" | "request_retake" | "reject"
        approval_request_id: Optional[str] = None,
        expected_measurement_id: Optional[str] = None,
        expected_measurement_version: Optional[int] = None,
        reviewer_attested: bool = False,
        attestations: Optional[Dict[str, bool]] = None,
        wound_type: Optional[str] = None,
        pressure_injury_stage: Optional[str] = None,
        diagnosis: Optional[str] = None,
        wound_bed_appearance: Optional[str] = None,
        exudate_amount: Optional[str] = None,
        surrounding_skin: Optional[str] = None,
        wound_trend: Optional[str] = None,
        sensory_perception: Optional[int] = None,
        moisture: Optional[int] = None,
        activity: Optional[int] = None,
        mobility: Optional[int] = None,
        nutrition: Optional[int] = None,
        friction_and_shear: Optional[int] = None,
        clinical_interpretation: Optional[str] = None,
        care_decisions: Optional[str] = None,
        ai_draft_disposition: Optional[str] = None,
        final_documentation_text: Optional[str] = None,
        review_notes: Optional[str] = None,
        ai_revision_ids: Optional[List[str]] = None,
    ) -> Dict[str, Any]:
        """
        Mandatory Stage 1 + Stage 2 Clinician Review of an observation.
        Only CLINICAL_ROLES may execute this action.
        On approval, creates a versioned FINAL_CLINICIAN_APPROVED measurement and an immutable
        signed ClinicalAssessmentRecord, updates the ReviewRequest, and notifies the caregiver & patient.
        """
        # Capture the submitted intent before classification normalisation. Retries must
        # match the original actor and entire payload, not just an observation ID.
        intent = {k: v for k, v in locals().items() if k not in {"self", "approval_request_id"}}
        for key in ('amends_assessment_id', 'amendment_reason', 'expected_record_revision', 'factual_fields'):
            if intent[key] is None: intent.pop(key)
        if not intent['ai_revision_ids']: intent.pop('ai_revision_ids')  # absent or empty: same hash as before
        payload_hash = hashlib.sha256(json.dumps(intent, sort_keys=True).encode()).hexdigest()
        now = datetime.now(timezone.utc).isoformat()
        with self._lock, self._connect() as conn:
            conn.execute("SELECT pg_advisory_xact_lock(4456001)")
            obs_row = conn.execute(
                "SELECT * FROM wound_observations WHERE observation_id = ?", (observation_id,)
            ).fetchone()
            if not obs_row:
                raise KeyError(f"Observation '{observation_id}' not found.")
            obs = dict(obs_row)
            user, _ = self.authorize_patient_access(
                conn,
                actor_subject,
                obs["patient_id"],
                wound_id=obs["wound_id"],
                require_clinical_role=True,
                require_signoff_qualification=(decision == "approve"),
                clinical_permission="ASSESS",
            )

            if decision not in {"approve", "request_retake", "reject"}:
                raise ValueError("An explicit review decision is required.")
            receipt = conn.execute(
                "SELECT * FROM clinical_approval_receipts WHERE request_id = ?", (approval_request_id,)
            ).fetchone()
            if receipt:
                if (receipt["observation_id"] != observation_id or receipt["actor_subject"] != actor_subject
                        or receipt["payload_hash"] != payload_hash):
                    raise ClinicalConflictError("Approval request ID was already used for a different review.")
                return self.get_observation_detail(
                    actor_subject=actor_subject, observation_id=observation_id, conn_override=conn
                )
            if approval_request_id:
                # The original receipt table has one row per observation. Amendment
                # receipts live in the same append-only journal, with global nonce scope.
                for previous in conn.execute("SELECT entity_id,actor_subject,detail_json FROM audit_events WHERE action='RECORD_AMENDMENT_APPROVED' ORDER BY sequence_id DESC"):
                    previous_detail = json.loads(previous['detail_json'])
                    if previous_detail.get('approval_request_id') == approval_request_id:
                        if previous['entity_id'] != observation_id or previous['actor_subject'] != actor_subject or previous_detail.get('payload_hash') != payload_hash:
                            raise ClinicalConflictError('Approval request ID was already used for a different record or payload.')
                        return self.get_observation_detail(actor_subject=actor_subject, observation_id=observation_id, conn_override=conn)
            events = self._record_events(conn, observation_id)
            workspace = self._record_workspace(conn, obs, actor_subject, True)
            before_fields = workspace['record_published']
            if decision == 'approve' and workspace['record_has_draft'] and expected_record_revision is None:
                raise ClinicalConflictError('An edited draft requires the current record revision before signing.')
            for event in events:
                detail = event['detail']
                if detail.get('approval_request_id') == approval_request_id and approval_request_id:
                    if detail.get('payload_hash') != payload_hash or event['actor_subject'] != actor_subject:
                        raise ClinicalConflictError('Approval request ID belongs to another amendment payload.')
                    return self.get_observation_detail(actor_subject=actor_subject, observation_id=observation_id, conn_override=conn)
            latest_assessment = conn.execute('SELECT * FROM clinical_assessments WHERE observation_id=? ORDER BY version_number DESC,sequence_id DESC LIMIT 1', (observation_id,)).fetchone()
            original = dict(latest_assessment) if latest_assessment else None
            if amends_assessment_id:
                if decision != 'approve' or not original or original['assessment_id'] != amends_assessment_id or obs['review_state'] != 'CLINICIAN_APPROVED':
                    raise ClinicalConflictError('Amend the latest approved version; reload this record.')
                if not amendment_reason or not amendment_reason.strip():
                    raise ValueError('A concise amendment reason is required.')
            if expected_record_revision is not None and expected_record_revision != len(events):
                raise ClinicalConflictError('Record draft changed. Reload before approval.')
            if factual_fields is not None:
                from app.services.record_workflow import validate_fields
                validate_fields(factual_fields, False)
            self.require_active_record(conn, "observation", observation_id)
            if not amends_assessment_id and (obs["review_state"] != "AWAITING_CLINICAL_REVIEW" or obs["final_approved_measurement_id"]):
                raise ClinicalConflictError("Observation is no longer pending review. Signed records require an amendment.")
            if not review_notes or not review_notes.strip():
                raise ValueError("Explicit review_notes are required.")

            if decision == "request_retake":
                conn.execute(
                    """
                    UPDATE wound_observations
                    SET review_state = 'RETAKE_REQUESTED', reviewing_clinician_subject = ?, review_notes = ?
                    WHERE observation_id = ?
                    """,
                    (actor_subject, review_notes, observation_id),
                )
                conn.execute(
                    """
                    UPDATE review_requests
                    SET status = 'RETAKE_REQUESTED', reviewed_by_subject = ?, reviewed_at_utc = ?, resolution_notes = ?
                    WHERE observation_id = ?
                    """,
                    (actor_subject, now, review_notes, observation_id),
                )
                self._create_notification(
                    conn,
                    recipient_subject=obs["uploading_user_subject"],
                    recipient_role=obs["uploading_user_role"],
                    patient_id=obs["patient_id"],
                    wound_id=obs["wound_id"],
                    observation_id=observation_id,
                    notification_type="RETAKE_REQUESTED",
                    safe_preview_title="Please Recapture Wound Photograph",
                    safe_preview_body="Your care team requested a clearer photograph with all 4 AprilTag ruler corners visible.",
                    clinical_owner_subject=actor_subject,
                )
                self._append_audit(
                    conn, actor_subject=actor_subject, actor_role=user["role"], actor_org_id=user["org_id"],
                    action="OBSERVATION_" + decision.upper(), entity_type="OBSERVATION", entity_id=observation_id,
                    patient_id=obs["patient_id"], wound_id=obs["wound_id"], detail={"reason": review_notes},
                )
                return self.get_observation_detail(
                    actor_subject=actor_subject, observation_id=observation_id, conn_override=conn
                )

            if decision == "reject":
                conn.execute(
                    """
                    UPDATE wound_observations
                    SET review_state = 'REJECTED', reviewing_clinician_subject = ?, review_notes = ?
                    WHERE observation_id = ?
                    """,
                    (actor_subject, review_notes, observation_id),
                )
                conn.execute(
                    """
                    UPDATE review_requests
                    SET status = 'REJECTED', reviewed_by_subject = ?, reviewed_at_utc = ?, resolution_notes = ?
                    WHERE observation_id = ?
                    """,
                    (actor_subject, now, review_notes, observation_id),
                )
                self._append_audit(
                    conn, actor_subject=actor_subject, actor_role=user["role"], actor_org_id=user["org_id"],
                    action="OBSERVATION_" + decision.upper(), entity_type="OBSERVATION", entity_id=observation_id,
                    patient_id=obs["patient_id"], wound_id=obs["wound_id"], detail={"reason": review_notes},
                )
                return self.get_observation_detail(
                    actor_subject=actor_subject, observation_id=observation_id, conn_override=conn
                )

            # Decision == "approve"
            if obs["quality_gate_status"] == "RETAKE_REQUIRED":
                raise ValueError("Cannot approve an observation when quality_gate_status is RETAKE_REQUIRED.")

            # Classification/staging and diagnosis are separate clinical permissions.
            wound_row = dict(conn.execute("SELECT * FROM wounds WHERE wound_id = ?", (obs["wound_id"],)).fetchone())
            classification = original if amends_assessment_id else wound_row
            wound_type = wound_type or classification["wound_type"]
            pressure_injury_stage = pressure_injury_stage or classification["pressure_injury_stage"]
            staging_changed = (
                wound_type != classification["wound_type"] or pressure_injury_stage != classification["pressure_injury_stage"]
            )
            if staging_changed:
                self.require_permission(conn, user, "STAGE", patient_id=obs["patient_id"], wound_id=obs["wound_id"])
            if amends_assessment_id and diagnosis is None:
                diagnosis = original.get("diagnosis_text")
            diagnosis = (diagnosis or "").strip() or None
            if (diagnosis and not amends_assessment_id) or (amends_assessment_id and diagnosis != original.get("diagnosis_text")):
                self.require_permission(conn, user, "DIAGNOSE", patient_id=obs["patient_id"], wound_id=obs["wound_id"])

            required_text = {
                "wound_bed_appearance": wound_bed_appearance, "exudate_amount": exudate_amount,
                "surrounding_skin": surrounding_skin, "wound_trend": wound_trend,
                "clinical_interpretation": clinical_interpretation, "care_decisions": care_decisions,
                "final_documentation_text": final_documentation_text,
            }
            missing = [name for name, value in required_text.items() if not isinstance(value, str) or not value.strip()]
            if missing:
                raise ValueError("Explicit clinical inputs required: " + ", ".join(missing))
            allowed_findings = {
                "wound_bed_appearance": {"GRANULATING", "EPITHELIALIZING", "SLOUGH_PRESENT", "NECROTIC_ESCHAR", "CLOSED"},
                "exudate_amount": {"NONE", "SCANT", "MODERATE", "HEAVY"},
                "surrounding_skin": {"INTACT", "ERYTHEMA", "MACERATED"},
                "wound_trend": {"IMPROVING", "STABLE", "WORSENING", "NEW_WOUND"},
            }
            for name, choices in allowed_findings.items():
                if required_text[name] not in choices:
                    raise ValueError(f"Unsupported {name}; choose an explicit assessment value.")
            for name, value, maximum in (
                ("sensory_perception", sensory_perception, 4), ("moisture", moisture, 4),
                ("activity", activity, 4), ("mobility", mobility, 4), ("nutrition", nutrition, 4),
                ("friction_and_shear", friction_and_shear, 3),
            ):
                if type(value) is not int or not 1 <= value <= maximum:
                    raise ValueError(f"Explicit {name} score between 1 and {maximum} is required.")
            if ai_draft_disposition not in {"not_used", "accepted", "edited", "rejected"}:
                raise ValueError("An explicit AI draft disposition is required; manual notes may use not_used.")
            missing_attestations = [key for key in APPROVAL_ATTESTATIONS
                                    if not isinstance(attestations, dict) or attestations.get(key) is not True]
            if reviewer_attested is not True:
                missing_attestations.append("reviewer_attested")
            if missing_attestations:
                raise AttestationRequiredError(missing_attestations)
            if not approval_request_id or not approval_request_id.strip() or len(approval_request_id) > 128:
                raise ValueError("A nonempty approval_request_id of at most 128 characters is required.")
            if not expected_measurement_id or type(expected_measurement_version) is not int:
                raise ValueError("Expected measurement ID and version are required.")

            active_meas_id = obs["human_corrected_measurement_id"] or obs["provisional_measurement_id"]
            if not active_meas_id:
                raise ValueError("Cannot approve an observation without a calibrated measurement.")
            base_m = dict(
                conn.execute(
                    "SELECT * FROM wound_measurements WHERE measurement_id = ?", (active_meas_id,)
                ).fetchone()
            )
            if (active_meas_id != expected_measurement_id
                    or base_m["version_number"] != expected_measurement_version):
                raise ClinicalConflictError("Measurement changed. Reload and review the current photo, boundary and measurement before signing.")
            contract = json.loads(base_m.get("geometry_json") or "null")
            if contract and contract.get("selection_required"):
                raise ValueError("Select one wound component or explicitly correct its boundary before approval.")
            # 0 cm² (no visible open wound) is signed as a closed wound bed; a measured wound never is.
            zero_area = is_zero_area(contract) and float(base_m["area_cm2"]) == 0
            if zero_area and wound_bed_appearance != "CLOSED":
                raise ValueError("For 0 cm² (no visible open wound), record the wound bed as Closed.")
            if not zero_area and wound_bed_appearance == "CLOSED":
                raise ValueError("A wound bed recorded as Closed needs a 0 cm² measurement. Record no visible open wound, or choose another wound bed.")
            if ai_draft_disposition in {"accepted", "edited"} and (
                    obs.get("draft_status") != "current" or obs.get("draft_measurement_id") != active_meas_id or not obs.get("ai_explanation_json")):
                raise ValueError("AI draft is stale or unavailable for this measurement. Write a manual note instead.")
            self.verify_observation_image_integrity(conn, observation_id, base_m, actor_subject=actor_subject)
            next_v_row = conn.execute(
                "SELECT COALESCE(MAX(version_number), 1) + 1 AS next_v FROM wound_measurements WHERE observation_id = ?",
                (observation_id,),
            ).fetchone()
            next_v = int(next_v_row["next_v"]) if next_v_row else 2
            final_meas_id = f"MEAS-{uuid4().hex[:10].upper()}"

            conn.execute(
                """
                INSERT INTO wound_measurements(
                    measurement_id, observation_id, patient_id, wound_id, version_number,
                    measurement_stage, source_model, was_human_corrected, area_cm2, length_cm,
                    width_cm, clinical_length_cm, clinical_width_cm, perimeter_cm,
                    length_method, width_method, pixels_per_mm, boundary_px_json,
                    created_by_subject, created_at_utc
                ) VALUES (?, ?, ?, ?, ?, 'FINAL_CLINICIAN_APPROVED', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    final_meas_id,
                    observation_id,
                    obs["patient_id"],
                    obs["wound_id"],
                    next_v,
                    base_m["source_model"],
                    base_m["was_human_corrected"],
                    base_m["area_cm2"],
                    base_m["length_cm"],
                    base_m["width_cm"],
                    base_m["clinical_length_cm"],
                    base_m["clinical_width_cm"],
                    base_m["perimeter_cm"],
                    base_m["length_method"],
                    base_m["width_method"],
                    base_m["pixels_per_mm"],
                    base_m["boundary_px_json"],
                    actor_subject,
                    now,
                ),
            )

            braden_total, braden_band = calculate_braden_score(
                sensory_perception, moisture, activity, mobility, nutrition, friction_and_shear
            )
            sys_priority, _ = calculate_clinical_priority(
                red_flag_present=self._reported_concern(conn, observation_id) or facts_raise_concern(factual_fields or {}), wound_trend=wound_trend
            )
            assess_id = f"CLN-{uuid4().hex[:10].upper()}"
            conn.execute(
                """
                INSERT INTO clinical_assessments(
                    assessment_id, observation_id, patient_id, wound_id, version_number,
                    supersedes_assessment_id, wound_type, pressure_injury_stage, wound_bed_appearance,
                    exudate_amount, surrounding_skin, wound_trend, braden_total, braden_risk_band,
                    system_priority, nurse_priority, clinical_interpretation, care_decisions,
                    ai_draft_disposition, final_documentation_text, signed_by_subject,
                    signed_by_name, signed_by_role, signed_at_utc, is_immutable,
                    diagnosis_text, diagnosed_by_subject
                ) VALUES (?, ?, ?, ?, 1, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
                """,
                (
                    assess_id,
                    observation_id,
                    obs["patient_id"],
                    obs["wound_id"],
                    wound_type,
                    pressure_injury_stage,
                    wound_bed_appearance,
                    exudate_amount,
                    surrounding_skin,
                    wound_trend,
                    braden_total,
                    braden_band,
                    sys_priority,
                    sys_priority,
                    clinical_interpretation,
                    care_decisions,
                    ai_draft_disposition,
                    final_documentation_text,
                    actor_subject,
                    user["display_name"],
                    user["role"],
                    now,
                    diagnosis,
                    actor_subject if diagnosis else None,
                ),
            )
            final_contract = {**contract, "measurement_version": next_v} if contract else None
            conn.execute(
                "UPDATE wound_measurements SET source_measurement_id = ?, geometry_json = ? WHERE measurement_id = ?",
                (active_meas_id, json.dumps(final_contract) if final_contract else None, final_meas_id),
            )
            confirmed = {(ZERO_AREA_ATTESTATION if zero_area and key == "boundary_verified" else key): True
                         for key in APPROVAL_ATTESTATIONS}
            conn.execute(
                """UPDATE clinical_assessments SET reviewed_measurement_id = ?,
                   reviewed_measurement_version = ?, reviewer_attested_at_utc = ?, attestations_json = ? WHERE assessment_id = ?""",
                (active_meas_id, expected_measurement_version, now, json.dumps(confirmed), assess_id),
            )
            if amends_assessment_id:
                conn.execute('UPDATE clinical_assessments SET version_number=?, supersedes_assessment_id=?, amendment_reason=?, diagnosed_by_subject=? WHERE assessment_id=?',
                             (original['version_number']+1, amends_assessment_id, amendment_reason.strip(),
                              actor_subject if diagnosis != original.get('diagnosis_text') else original.get('diagnosed_by_subject'), assess_id))
            else:
                conn.execute("INSERT INTO clinical_approval_receipts VALUES (?, ?, ?, ?, ?, ?)",
                             (observation_id, approval_request_id, actor_subject, payload_hash, final_meas_id, assess_id))
            if staging_changed:
                conn.execute(
                    "UPDATE wounds SET wound_type = ?, pressure_injury_stage = ?, updated_at_utc = ? WHERE wound_id = ?",
                    (wound_type, pressure_injury_stage, now, obs["wound_id"]),
                )
            # A verified open wound on a healed wound's newest photo reopens it; its history is kept.
            if not zero_area and wound_row["status"] == "HEALED":
                newer = conn.execute(
                    """SELECT 1 FROM wound_observations WHERE wound_id = ? AND review_state = 'CLINICIAN_APPROVED'
                       AND observation_id <> ? AND capture_datetime_utc > ?""",
                    (obs["wound_id"], observation_id, obs["capture_datetime_utc"])).fetchone()
                if not newer:
                    conn.execute("UPDATE wounds SET status = 'ACTIVE', reopened_at_utc = ?, updated_at_utc = ? WHERE wound_id = ?",
                                 (now, now, obs["wound_id"]))
                    self._append_audit(conn, actor_subject=actor_subject, actor_role=user["role"], actor_org_id=user["org_id"],
                                       action="WOUND_REOPENED", entity_type="WOUND", entity_id=obs["wound_id"],
                                       patient_id=obs["patient_id"], wound_id=obs["wound_id"],
                                       detail={"reason": "A non-zero measurement was approved after the wound was marked healed.",
                                               "observation_id": observation_id, "area_cm2": base_m["area_cm2"]})

            conn.execute(
                """
                UPDATE wound_observations
                SET final_approved_measurement_id = ?,
                    review_state = 'CLINICIAN_APPROVED',
                    reviewing_clinician_subject = ?,
                    final_approval_timestamp_utc = ?,
                    review_notes = ?
                WHERE observation_id = ?
                """,
                (final_meas_id, actor_subject, now, review_notes, observation_id),
            )
            conn.execute(
                """
                UPDATE review_requests
                SET status = 'CLINICIAN_APPROVED', reviewed_by_subject = ?, reviewed_at_utc = ?, resolution_notes = ?
                WHERE observation_id = ?
                """,
                (actor_subject, now, review_notes, observation_id),
            )

            # Notify uploading caregiver and patient that the clinician approved the measurement
            patient_account = conn.execute(
                "SELECT patient_account_subject FROM patients WHERE patient_id = ?", (obs["patient_id"],)
            ).fetchone()["patient_account_subject"]
            for recip_sub, recip_role in [
                (obs["uploading_user_subject"], obs["uploading_user_role"]),
                (patient_account, "PATIENT"),
            ]:
                if recip_sub and recip_sub != actor_subject:
                    self._create_notification(
                        conn,
                        recipient_subject=recip_sub,
                        recipient_role=recip_role,
                        patient_id=obs["patient_id"],
                        wound_id=obs["wound_id"],
                        observation_id=observation_id,
                        notification_type="CLINICIAN_APPROVED_MEASUREMENT",
                        safe_preview_title="Wound Follow-Up Verified by Care Team",
                        safe_preview_body="Your clinician reviewed and approved the latest wound measurement and care plan.",
                        clinical_owner_subject=actor_subject,
                    )

            self._append_audit(
                conn,
                actor_subject=actor_subject,
                actor_role=user["role"],
                actor_org_id=user["org_id"],
                action="OBSERVATION_CLINICIAN_APPROVED",
                entity_type="OBSERVATION",
                entity_id=observation_id,
                patient_id=obs["patient_id"],
                wound_id=obs["wound_id"],
                detail={
                    "final_measurement_id": final_meas_id,
                    "assessment_id": assess_id,
                    "reviewed_measurement_id": active_meas_id,
                    "reviewed_measurement_version": expected_measurement_version,
                    "approval_request_id": approval_request_id,
                    "reviewer_attested": True,
                    "attestations": sorted(confirmed),
                    "approved_area_cm2": base_m["area_cm2"],
                },
            )
            from app.services.record_workflow import CLINICAL_FIELDS
            fields = {key: value for key, value in intent.items() if key in CLINICAL_FIELDS and value is not None}
            fields.update(factual_fields or {})
            before = before_fields
            if amends_assessment_id and not any(before.get(key) != value for key,value in fields.items()) and active_meas_id == original['reviewed_measurement_id']:
                raise ValueError('An amendment must change record details or the reviewed boundary.')
            self._append_audit(conn, actor_subject=actor_subject, actor_role=user['role'], actor_org_id=user['org_id'],
                patient_id=obs['patient_id'], wound_id=obs['wound_id'], entity_type='OBSERVATION', entity_id=observation_id,
                action='RECORD_AMENDMENT_APPROVED' if amends_assessment_id else 'RECORD_APPROVED',
                detail={'revision': len(events)+1, 'base_assessment_id': amends_assessment_id,
                        'assessment_id': assess_id, 'fields': fields,
                        'changes': {key: {'old': before.get(key), 'new': value} for key,value in fields.items() if before.get(key) != value},
                        'reason': amendment_reason or '', 'approval_request_id': approval_request_id, 'payload_hash': payload_hash,
                        # Ask AI suggestions used in the signed text fields (audited suggestions for this record).
                        **({'ai_revision_ids': self.validate_ai_revision_ids(
                            conn, ai_revision_ids, obs['patient_id'], obs['wound_id'], draft_types=('clinical_note',),
                            actor_subject=actor_subject, target_id=observation_id)} if ai_revision_ids else {})})
            return self.get_observation_detail(
                actor_subject=actor_subject, observation_id=observation_id, conn_override=conn
            )

    def amend_signed_clinical_assessment(
        self,
        *,
        actor_subject: str,
        assessment_id: str,
        amendment_reason: str,
        updated_clinical_interpretation: str,
        updated_final_documentation_text: str,
        updated_wound_trend: Optional[str] = None,
    ) -> Dict[str, Any]:
        """
        Signed clinical assessments are immutable and cannot be silently overwritten.
        Amendments create a new authenticated version referencing `supersedes_assessment_id`.
        """
        if not amendment_reason or not amendment_reason.strip():
            raise ValueError("An explicit amendment_reason is required to amend a signed clinical assessment.")
        now = datetime.now(timezone.utc).isoformat()
        with self._lock, self._connect() as conn:
            conn.execute("SELECT pg_advisory_xact_lock(4456001)")
            orig_row = conn.execute(
                "SELECT * FROM clinical_assessments WHERE assessment_id = ?", (assessment_id,)
            ).fetchone()
            if not orig_row:
                raise KeyError(f"Clinical assessment '{assessment_id}' not found.")
            orig = dict(orig_row)
            user, _ = self.authorize_patient_access(
                conn,
                actor_subject,
                orig["patient_id"],
                wound_id=orig["wound_id"],
                require_clinical_role=True,
                require_signoff_qualification=True,
            )

            self.require_active_record(conn, "observation", orig["observation_id"])
            max_v_row = conn.execute(
                "SELECT COALESCE(MAX(version_number), 1) AS max_v FROM clinical_assessments WHERE observation_id = ?",
                (orig["observation_id"],),
            ).fetchone()
            obs = conn.execute("SELECT * FROM wound_observations WHERE observation_id = ?", (orig["observation_id"],)).fetchone()
            if not obs or obs["review_state"] != "CLINICIAN_APPROVED":
                raise ClinicalConflictError("Only an approved observation can be amended.")
            latest = conn.execute(
                "SELECT assessment_id FROM clinical_assessments WHERE observation_id = ? ORDER BY version_number DESC, sequence_id DESC LIMIT 1",
                (orig["observation_id"],),
            ).fetchone()
            if latest["assessment_id"] != assessment_id:
                raise ClinicalConflictError("Assessment has been superseded. Reload and amend the latest signed version.")
            if not updated_clinical_interpretation.strip() or not updated_final_documentation_text.strip():
                raise ValueError("Amendments require nonempty interpretation and documentation.")
            if updated_wound_trend is not None and updated_wound_trend not in {"IMPROVING", "STABLE", "WORSENING", "NEW_WOUND"}:
                raise ValueError("An amended wound trend must be an explicit supported value.")
            self.verify_observation_image_integrity(conn, orig["observation_id"], actor_subject=actor_subject)
            new_v = int(max_v_row["max_v"]) + 1
            new_id = f"CLN-{uuid4().hex[:10].upper()}"

            conn.execute(
                """
                INSERT INTO clinical_assessments(
                    assessment_id, observation_id, patient_id, wound_id, version_number,
                    supersedes_assessment_id, wound_type, pressure_injury_stage, wound_bed_appearance,
                    exudate_amount, surrounding_skin, wound_trend, braden_total, braden_risk_band,
                    system_priority, nurse_priority, clinical_interpretation, care_decisions,
                    ai_draft_disposition, final_documentation_text, signed_by_subject,
                    signed_by_name, signed_by_role, signed_at_utc, amendment_reason, is_immutable
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
                """,
                (
                    new_id,
                    orig["observation_id"],
                    orig["patient_id"],
                    orig["wound_id"],
                    new_v,
                    assessment_id,
                    orig["wound_type"],
                    orig["pressure_injury_stage"],
                    orig["wound_bed_appearance"],
                    orig["exudate_amount"],
                    orig["surrounding_skin"],
                    updated_wound_trend or orig["wound_trend"],
                    orig["braden_total"],
                    orig["braden_risk_band"],
                    orig["system_priority"],
                    orig["nurse_priority"],
                    updated_clinical_interpretation,
                    orig["care_decisions"],
                    orig["ai_draft_disposition"],
                    updated_final_documentation_text,
                    actor_subject,
                    user["display_name"],
                    user["role"],
                    now,
                    amendment_reason.strip(),
                ),
            )
            priority, _ = calculate_clinical_priority(
                red_flag_present=self._reported_concern(conn, orig["observation_id"]),
                wound_trend=updated_wound_trend or orig["wound_trend"],
            )
            conn.execute(
                """UPDATE clinical_assessments SET diagnosis_text = ?, diagnosed_by_subject = ?,
                   reviewed_measurement_id = ?, reviewed_measurement_version = ?,
                   reviewer_attested_at_utc = ?, attestations_json = ?, system_priority = ? WHERE assessment_id = ?""",
                (orig["diagnosis_text"], orig["diagnosed_by_subject"], orig["reviewed_measurement_id"],
                 orig["reviewed_measurement_version"], orig["reviewer_attested_at_utc"], orig.get("attestations_json"),
                 priority, new_id),
            )
            self._append_audit(
                conn,
                actor_subject=actor_subject,
                actor_role=user["role"],
                actor_org_id=user["org_id"],
                action="CLINICAL_ASSESSMENT_AMENDED",
                entity_type="CLINICAL_ASSESSMENT",
                entity_id=new_id,
                patient_id=orig["patient_id"],
                wound_id=orig["wound_id"],
                detail={
                    "supersedes_assessment_id": assessment_id,
                    "version_number": new_v,
                    "amendment_reason": amendment_reason.strip(),
                },
            )
            row = conn.execute(
                "SELECT * FROM clinical_assessments WHERE assessment_id = ?", (new_id,)
            ).fetchone()
            return dict(row)

    def create_or_update_care_plan(
        self,
        *,
        actor_subject: str,
        patient_id: str,
        wound_id: str,
        title: str = "Home Sacral Pressure Injury Care & Offloading Plan",
        purpose: str = "Protect granulating wound bed, maintain moisture balance, and monitor progression between clinic visits.",
        approved_instructions: str = (
            "1. Keep gentle silicone foam dressing dry and intact.\n"
            "2. Reposition and offload sacral area every 2–3 hours using 30-degree wedge pillow.\n"
            "3. Capture calibrated follow-up photograph with the 18 cm AprilTag ruler every 3 days.\n"
            "4. Report new redness, odor, fever, or pain >= 6/10 through the Caregiver Portal."
        ),
        assigned_caregiver_subject: str = "caregiver.suda",
        task_frequency: str = "Daily offloading + Photo every 3 days",
        tasks: Optional[List[Dict[str, str]]] = None,
        revision_reason: Optional[str] = None,
        carry_over_tasks: bool = False,
        ai_revision_ids: Optional[List[str]] = None,
        expected_care_plan_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """
        Issue or revise a clinician-approved care plan and its scheduled care tasks.
        Only CLINICAL_ROLES may issue or modify care plans (Muse Spark is never allowed to
        independently generate treatment instructions for caregivers).

        A revision is a new version; the previous one is kept as SUPERSEDED. Changing the approved
        instructions or frequency of an active plan needs a reason (audited). `expected_care_plan_id`
        refuses a revision built on a plan that another clinician has since replaced. `carry_over_tasks`
        copies the active plan's tasks unchanged (status, due date, completion and caregiver notes) instead
        of issuing the standard ones. `ai_revision_ids` record that the clinician used Muse Spark wording
        suggestions (AI_DRAFT_REVISION_SUGGESTED audit events).
        """
        now_dt = datetime.now(timezone.utc)
        now = now_dt.isoformat()
        start_d = now_dt.date().isoformat()
        rev_d = (now_dt + timedelta(days=7)).date().isoformat()

        with self._lock, self._connect() as conn:
            user, patient = self.authorize_patient_access(
                conn,
                actor_subject,
                patient_id,
                require_clinical_role=True,
                clinical_permission="MANAGE_CARE_PLAN",
            )
            wound_id = self._resolve_wound(conn, patient["patient_id"], wound_id)["wound_id"]
            approved_instructions = (approved_instructions or "").strip()
            if not approved_instructions:
                raise ValueError("Care instructions cannot be empty.")
            if len(approved_instructions) > 6000:
                raise ValueError("Care instructions must contain at most 6000 characters.")
            active = conn.execute(
                "SELECT * FROM care_plans WHERE patient_id = ? AND wound_id = ? AND status = 'ACTIVE'",
                (patient["patient_id"], wound_id),
            ).fetchone()
            if expected_care_plan_id and (active["care_plan_id"] if active else None) != expected_care_plan_id:
                raise ClinicalConflictError("The care plan was changed by someone else. Reload it before revising.")
            changed = bool(active) and (active["approved_instructions"] != approved_instructions
                                        or active["task_frequency"] != task_frequency)
            if changed and not (revision_reason or "").strip():
                raise ValueError("Give a reason for changing the approved care instructions.")
            ai_ids = self.validate_ai_revision_ids(conn, ai_revision_ids, patient["patient_id"], wound_id,
                                                   draft_types=("care_instructions",), actor_subject=actor_subject,
                                                   target_id=active["care_plan_id"] if active else None)
            carried = [dict(t) for t in conn.execute("SELECT * FROM care_tasks WHERE care_plan_id = ? ORDER BY due_at_utc",
                                                      (active["care_plan_id"],)).fetchall()] if carry_over_tasks and tasks is None and active else []
            max_v_row = conn.execute(
                "SELECT COALESCE(MAX(version_number), 0) AS max_v FROM care_plans WHERE patient_id = ? AND wound_id = ?",
                (patient["patient_id"], wound_id),
            ).fetchone()
            next_v = int(max_v_row["max_v"]) + 1
            conn.execute(
                "UPDATE care_plans SET status = 'SUPERSEDED' WHERE patient_id = ? AND wound_id = ? AND status = 'ACTIVE'",
                (patient["patient_id"], wound_id),
            )
            plan_id = f"CPL-{uuid4().hex[:10].upper()}"
            conn.execute(
                """
                INSERT INTO care_plans(
                    care_plan_id, patient_id, wound_id, version_number, title, purpose,
                    approved_instructions, responsible_clinician_subject, assigned_caregiver_subject,
                    task_frequency, start_date, review_date, status, approved_at_utc, created_at_utc
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?)
                """,
                (
                    plan_id,
                    patient["patient_id"],
                    wound_id,
                    next_v,
                    title,
                    purpose,
                    approved_instructions,
                    actor_subject,
                    assigned_caregiver_subject,
                    task_frequency,
                    start_d,
                    rev_d,
                    now,
                    now,
                ),
            )

            default_tasks = tasks or [
                {
                    "title": "Check silicone foam dressing border & skin integrity",
                    "instructions": "Confirm border is sealed and surrounding skin has no new redness or warmth.",
                    "frequency": "Daily morning check",
                },
                {
                    "title": "30-degree lateral repositioning & sacral offloading",
                    "instructions": "Use foam wedge pillow to relieve direct pressure on sacrum.",
                    "frequency": "Every 3 hours while in bed",
                },
                {
                    "title": "Upload calibrated home wound photograph (18 cm AprilTag ruler)",
                    "instructions": "Place ruler flat in wound plane with all 4 corner tags visible.",
                    "frequency": "Every 3 days",
                },
            ]
            created_tasks: List[Dict[str, Any]] = []
            for t in carried:
                # Rewording instructions does not reset the caregiver's work: copy each task as it stands.
                task_id = f"TSK-{uuid4().hex[:10].upper()}"
                conn.execute(
                    """INSERT INTO care_tasks(task_id, care_plan_id, patient_id, wound_id, title, instructions, frequency,
                       due_at_utc, status, completed_by_subject, completed_at_utc, caregiver_notes, created_at_utc)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                    (task_id, plan_id, patient["patient_id"], wound_id, t["title"], t["instructions"], t["frequency"],
                     t["due_at_utc"], t["status"], t["completed_by_subject"], t["completed_at_utc"], t["caregiver_notes"], now),
                )
                created_tasks.append(dict(conn.execute("SELECT * FROM care_tasks WHERE task_id = ?", (task_id,)).fetchone()))
            for idx, t in enumerate([] if carried else default_tasks):
                task_id = f"TSK-{uuid4().hex[:10].upper()}"
                due_iso = (now_dt + timedelta(hours=12 * (idx + 1))).isoformat()
                conn.execute(
                    """
                    INSERT INTO care_tasks(
                        task_id, care_plan_id, patient_id, wound_id, title, instructions,
                        frequency, due_at_utc, status, created_at_utc
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?)
                    """,
                    (
                        task_id,
                        plan_id,
                        patient["patient_id"],
                        wound_id,
                        t["title"],
                        t["instructions"],
                        t["frequency"],
                        due_iso,
                        now,
                    ),
                )
                created_tasks.append(
                    dict(conn.execute("SELECT * FROM care_tasks WHERE task_id = ?", (task_id,)).fetchone())
                )

            if assigned_caregiver_subject:
                self._create_notification(
                    conn,
                    recipient_subject=assigned_caregiver_subject,
                    recipient_role="FAMILY_CAREGIVER",
                    patient_id=patient["patient_id"],
                    wound_id=wound_id,
                    observation_id=None,
                    notification_type="CARE_PLAN_UPDATED",
                    safe_preview_title="Updated Clinician-Approved Care Instructions",
                    safe_preview_body=f"Care plan v{next_v} has been approved by {user['display_name']}.",
                    clinical_owner_subject=actor_subject,
                )

            self._append_audit(
                conn,
                actor_subject=actor_subject,
                actor_role=user["role"],
                actor_org_id=user["org_id"],
                action="CARE_PLAN_APPROVED",
                entity_type="CARE_PLAN",
                entity_id=plan_id,
                patient_id=patient["patient_id"],
                wound_id=wound_id,
                detail={"version_number": next_v, "tasks_count": len(created_tasks),
                        "supersedes_care_plan_id": active["care_plan_id"] if active else None,
                        "instructions_changed": changed, "revision_reason": (revision_reason or "").strip()[:500] or None,
                        "ai_revision_ids": ai_ids},
            )
            plan_row = dict(
                conn.execute("SELECT * FROM care_plans WHERE care_plan_id = ?", (plan_id,)).fetchone()
            )
            plan_row["tasks"] = created_tasks
            return plan_row

    def complete_care_task(
        self,
        *,
        actor_subject: str,
        task_id: str,
        status: str = "COMPLETED",  # "COMPLETED" | "CONCERN_REPORTED"
        caregiver_notes: str = "Completed per clinician instructions; dressing clean and intact.",
    ) -> Dict[str, Any]:
        now = datetime.now(timezone.utc).isoformat()
        with self._lock, self._connect() as conn:
            t_row = conn.execute("SELECT * FROM care_tasks WHERE task_id = ?", (task_id,)).fetchone()
            if not t_row:
                raise KeyError(f"Care task '{task_id}' not found.")
            task = dict(t_row)
            user, patient = self.authorize_patient_access(
                conn,
                actor_subject,
                task["patient_id"],
                wound_id=task["wound_id"],
                required_permission="COMPLETE_CARE_TASKS",
                require_clinical_role=False,
            )
            plan = conn.execute("SELECT * FROM care_plans WHERE care_plan_id = ?", (task["care_plan_id"],)).fetchone()
            if plan["status"] != "ACTIVE":
                raise ClinicalConflictError("Tasks in a superseded care plan cannot be completed.")
            if user["role"] in CAREGIVER_ROLES and plan["assigned_caregiver_subject"] != actor_subject:
                raise AccessDeniedError("TASK_ASSIGNMENT_REQUIRED", "Only the assigned caregiver may complete this task.")
            if status not in {"COMPLETED", "CONCERN_REPORTED"}:
                raise ValueError("Unsupported task completion status.")
            conn.execute(
                """
                UPDATE care_tasks
                SET status = ?, completed_by_subject = ?, completed_at_utc = ?, caregiver_notes = ?
                WHERE task_id = ?
                """,
                (status, actor_subject, now, caregiver_notes, task_id),
            )
            if status == "CONCERN_REPORTED":
                self._create_notification(
                    conn,
                    recipient_subject=patient["primary_clinician_subject"],
                    recipient_role="NURSE",
                    patient_id=patient["patient_id"],
                    wound_id=task["wound_id"],
                    observation_id=None,
                    notification_type="CAREGIVER_CONCERN_ALERT",
                    safe_preview_title="Caregiver Reported Task Concern",
                    safe_preview_body=f"Task {task_id} flagged with concern by {user['display_name']}.",
                    clinical_owner_subject=patient["primary_clinician_subject"],
                )
            self._append_audit(
                conn,
                actor_subject=actor_subject,
                actor_role=user["role"],
                actor_org_id=user["org_id"],
                action="CARE_TASK_RECORDED",
                entity_type="CARE_TASK",
                entity_id=task_id,
                patient_id=patient["patient_id"],
                wound_id=task["wound_id"],
                detail={"status": status, "caregiver_notes": caregiver_notes},
            )
            return dict(conn.execute("SELECT * FROM care_tasks WHERE task_id = ?", (task_id,)).fetchone())

    @staticmethod
    def ai_observation_view(row: Dict[str, Any]) -> Dict[str, Any]:
        """Clinician view of one Muse visual-observation version (never sent to caregivers or patients)."""
        return {
            "ai_observation_id": row["ai_observation_id"],
            "observation_id": row["observation_id"],
            "version_number": row["version_number"],
            "status": row["status"],
            "model_id": row["model_id"],
            "input": json.loads(row["input_json"]),
            "findings": json.loads(row["findings_json"]),
            "guard_flags": json.loads(row["guard_flags_json"] or "[]"),
            "clinician_findings": json.loads(row["clinician_findings_json"] or "null"),
            "clinician_notes": row["clinician_notes"],
            "latency_ms": row["latency_ms"],
            "created_by_subject": row["created_by_subject"],
            "created_at_utc": row["created_at_utc"],
            "reviewed_by_subject": row["reviewed_by_subject"],
            "reviewed_at_utc": row["reviewed_at_utc"],
        }

    @staticmethod
    def validate_ai_revision_ids(conn: db.Connection, ids: Optional[List[str]], patient_id: str, wound_id: str, *,
                                 draft_types: Tuple[str, ...], actor_subject: str, target_id: Optional[str] = None) -> List[str]:
        """Muse Spark suggestions a clinician applied before saving. Each must be an audited suggestion that this
        clinician requested for this wound and kind of draft, and for this record when it named one."""
        clean = sorted({str(i).strip() for i in ids or [] if str(i).strip()})
        if len(clean) > 20:
            raise ValueError("Too many AI revision references.")
        for revision_id in clean:
            row = conn.execute(
                "SELECT actor_subject, detail_json FROM audit_events WHERE action = 'AI_DRAFT_REVISION_SUGGESTED' "
                "AND entity_id = ? AND patient_id = ? AND wound_id = ?", (revision_id, patient_id, wound_id),
            ).fetchone()
            detail = json.loads(row["detail_json"]) if row else {}
            if (not row or row["actor_subject"] != actor_subject or detail.get("draft_type") not in draft_types
                    or detail.get("target_id") not in (None, target_id)):
                raise ValueError(f"AI revision reference '{revision_id}' does not belong to this draft.")
        return clean

    @staticmethod
    def record_is_active(conn: db.Connection, record_type: str, record_id: str) -> bool:
        if conn.execute("""SELECT 1 FROM record_deletions WHERE record_type = ? AND record_id = ?
                           AND restored_at_utc IS NULL""", (record_type, record_id)).fetchone():
            return False
        if record_type in {"observation", "report"}:
            table, key = ("wound_observations", "observation_id") if record_type == "observation" else ("clinical_reports", "report_id")
            parent = conn.execute(f"SELECT wound_id FROM {table} WHERE {key} = ?", (record_id,)).fetchone()
            if parent and not ConnectedCareService.record_is_active(conn, "wound", parent["wound_id"]):
                return False
        if record_type == "report":
            row = conn.execute("SELECT evidence_json, anchor_observation_id FROM clinical_reports WHERE report_id = ?",
                               (record_id,)).fetchone()
            if row:
                evidence = json.loads(row["evidence_json"])
                sources = {v["observation_id"] for v in evidence.get("approved_visits", [])}
                if row["anchor_observation_id"]:
                    sources.add(row["anchor_observation_id"])
                return all(ConnectedCareService.record_is_active(conn, "observation", oid) for oid in sources)
        return True

    @staticmethod
    def require_active_record(conn: db.Connection, record_type: str, record_id: str) -> None:
        if not ConnectedCareService.record_is_active(conn, record_type, record_id):
            raise ClinicalConflictError("This record or one of its source observations has been deleted or voided. Reload the record.")

    def get_observation_detail(
        self,
        *,
        actor_subject: str,
        observation_id: str,
        conn_override: Optional[db.Connection] = None,
    ) -> Dict[str, Any]:
        def _fetch(conn: db.Connection) -> Dict[str, Any]:
            obs_row = conn.execute(
                "SELECT * FROM wound_observations WHERE observation_id = ?", (observation_id,)
            ).fetchone()
            if not obs_row:
                raise KeyError(f"Observation '{observation_id}' not found.")
            obs = dict(obs_row)
            user, _ = self.authorize_patient_access(
                conn, actor_subject, obs["patient_id"], wound_id=obs["wound_id"]
            )
            self.require_active_record(conn, "observation", observation_id)
            is_clinical = user["role"] in CLINICAL_ROLES

            meas_rows = [
                dict(r)
                for r in conn.execute(
                    "SELECT * FROM wound_measurements WHERE observation_id = ? ORDER BY version_number ASC",
                    (observation_id,),
                ).fetchall()
            ]
            if is_clinical:
                for measurement in meas_rows:
                    measurement["geometry"] = json.loads(measurement.pop("geometry_json", None) or "null")
            # Safety rule: Caregivers and patients must NOT see unapproved provisional AI measurements
            # presented as medical findings before clinician approval
            if not is_clinical:
                meas_rows = [
                    m for m in meas_rows if m["measurement_stage"] == "FINAL_CLINICIAN_APPROVED"
                ]

            assess_rows = [
                dict(r)
                for r in conn.execute(
                    "SELECT * FROM clinical_assessments WHERE observation_id = ? ORDER BY version_number DESC, sequence_id DESC",
                    (observation_id,),
                ).fetchall()
            ]
            rep_row = conn.execute(
                "SELECT * FROM caregiver_reports WHERE observation_id = ?", (observation_id,)
            ).fetchone()
            img_rows = conn.execute(
                "SELECT * FROM wound_images WHERE observation_id = ?", (observation_id,)
            ).fetchall()
            images = []
            for ir in img_rows:
                # Non-clinicians cannot access unapproved AI masks before clinician review
                if (
                    not is_clinical
                    and obs["review_state"] != "CLINICIAN_APPROVED"
                    and ir["image_role"] in {"AI_MASK_SAM", "AI_MASK_YOLO", "HUMAN_CORRECTED_MASK"}
                ):
                    continue
                if not is_clinical and ir["image_role"] == "COLOUR_CORRECTED":
                    continue
                sig, exp = sign_image_access_token(
                    ir["image_id"],
                    self.settings.session_secret,
                    viewer_subject=actor_subject,
                )
                images.append(
                    {
                        "image_id": ir["image_id"],
                        "image_role": ir["image_role"],
                        "media_type": ir["media_type"],
                        "width_px": ir["width_px"],
                        "height_px": ir["height_px"],
                        "sha256_hash": ir["sha256_hash"],
                        "signed_url": f"/v2/care/images/{ir['image_id']}?actor_subject={actor_subject}&sig={sig}&exp={exp}",
                        "expires_at_epoch": exp,
                    }
                )

            ai_exp = None
            if is_clinical and obs.get("ai_explanation_json"):
                try:
                    ai_exp = json.loads(obs["ai_explanation_json"])
                except Exception:
                    ai_exp = None

            approved = obs["review_state"] == "CLINICIAN_APPROVED"
            public_fields = (
                "observation_id", "patient_id", "wound_id", "capture_datetime_utc",
                "uploading_user_subject", "uploading_user_role", "capture_location_category",
                "review_state", "final_approval_timestamp_utc",
            )
            result = {key: obs.get(key) for key in public_fields}
            if is_clinical:
                clinical_fields = (
                    "session_request_id", "image_quality_status", "quality_gate_status",
                    "ai_segmentation_provenance", "meta_execution_status",
                    "provisional_measurement_id", "human_corrected_measurement_id",
                    "final_approved_measurement_id", "reviewing_clinician_subject", "review_notes", "draft_status",
                )
                result.update({key: obs.get(key) for key in clinical_fields})
                # Older observations have no colour record: reported as not recorded, never inferred.
                result["colour_calibration"] = json.loads(obs.get("colour_calibration_json") or "null")
                result["ai_visual_observations"] = [
                    self.ai_observation_view(dict(r)) for r in conn.execute(
                        "SELECT * FROM ai_visual_observations WHERE observation_id = ? ORDER BY version_number DESC",
                        (observation_id,),
                    ).fetchall()
                ]
            else:
                meas_rows = meas_rows if approved else []
                # Staff publish the latest signed findings; internal assessment
                # versions, AI dispositions and clinical risk metadata stay private.
                shared_fields = (
                    "assessment_id", "version_number", "wound_type", "pressure_injury_stage",
                    "wound_bed_appearance", "exudate_amount", "surrounding_skin", "wound_trend",
                    "clinical_interpretation", "care_decisions", "final_documentation_text",
                    "signed_by_name", "signed_by_role", "signed_at_utc", "diagnosis_text",
                )
                assess_rows = [{key: assess_rows[0].get(key) for key in shared_fields}] if approved and assess_rows else []
                result.update({
                    "reviewing_clinician_subject": obs.get("reviewing_clinician_subject") if approved else None,
                    "image_quality_status": obs["image_quality_status"] if approved else "PENDING_REVIEW",
                    "quality_gate_status": obs["quality_gate_status"] if approved else "PENDING_REVIEW",
                    "ai_segmentation_provenance": obs["ai_segmentation_provenance"] if approved else "PENDING_REVIEW",
                    "meta_execution_status": obs["meta_execution_status"] if approved else "PENDING_REVIEW",
                })
            if not is_clinical and (obs["review_state"] == "RETAKE_REQUESTED" or obs["quality_gate_status"] == "RETAKE_REQUIRED"):
                patient_owner = conn.execute("SELECT patient_account_subject FROM patients WHERE patient_id = ?", (obs["patient_id"],)).fetchone()[0]
                if actor_subject in {obs["uploading_user_subject"], patient_owner}:
                    code = obs["image_quality_status"]
                    ruler_codes = {"missing_marker", "duplicate_marker", "ambiguous_length_marker", "unsupported_length_marker", "missing_required_tags", "missing_length_marker", "multiple_length_markers",
                                   "clipped_marker", "invalid_ruler_geometry", "invalid_homography",
                                   "canonical_crop_outside_image", "missing_required_markers", "invalid_length_marker"}
                    result["capture_quality_reason"] = (
                        "wound_outside_photo" if code == "wound_outside_photo" else
                        "ruler_incomplete" if code in ruler_codes else
                        "no_wound_detected" if code == "no_wound_detected" else "image_quality"
                    )
            if not is_clinical:
                measurement_fields = (
                    "measurement_id", "version_number", "measurement_stage", "source_model",
                    "was_human_corrected", "area_cm2", "length_cm", "width_cm", "clinical_length_cm",
                    "clinical_width_cm", "perimeter_cm", "length_method", "width_method",
                    "pixels_per_mm", "boundary_px_json", "created_by_subject", "created_at_utc",
                )
                meas_rows = [{key: row.get(key) for key in measurement_fields} for row in meas_rows]
            report = dict(rep_row) if rep_row else None
            if report and not is_clinical and report["submitted_by_subject"] != actor_subject:
                report = None
            result.update({
                "measurements_versions": meas_rows,
                "approved_measurement": next(
                    (m for m in meas_rows if m["measurement_id"] == obs["final_approved_measurement_id"]), None,
                ),
                "provisional_or_working_measurement": next(
                    (m for m in meas_rows if m["measurement_id"] == (obs["final_approved_measurement_id"]
                        or obs["human_corrected_measurement_id"] or obs["provisional_measurement_id"])), None,
                ) if is_clinical else None,
                "clinical_assessments_versions": assess_rows if is_clinical else [],
                "latest_clinical_assessment": assess_rows[0] if assess_rows else None,
                "caregiver_report": report,
                "ai_explanation": ai_exp,
                "images": images,
                "provisional_hidden_for_non_clinician": not is_clinical and not approved,
                # Byte-identical to a generated demo phantom: label it wherever the observation is shown.
                "synthetic_demo_image": synthetic_image_kind(next(
                    (i["sha256_hash"] for i in images if i["image_role"] == "ORIGINAL_UPLOAD"), None)),
            })
            if is_clinical:
                result['record_working_measurement'] = next((m for m in meas_rows if m['measurement_id'] == (obs['human_corrected_measurement_id'] or obs['provisional_measurement_id'])), None)
            relationships = self._photo_relationships(conn, obs, actor_subject, is_clinical)
            if is_clinical or relationships['correction_of'] or relationships['photo_corrections']:
                result.update(relationships)
            if is_clinical or (user['role'] == 'FAMILY_CAREGIVER' and obs['uploading_user_subject'] == actor_subject
                               and obs['review_state'] in ('AWAITING_CLINICAL_REVIEW', 'CLINICIAN_APPROVED')):
                result.update(self._record_workspace(conn, obs, actor_subject, is_clinical))
                try:
                    self.verify_observation_image_integrity(conn, observation_id)
                    result['image_integrity_verified'] = True
                except ClinicalConflictError:
                    result['image_integrity_verified'] = False
            return result

        if conn_override is not None:
            return _fetch(conn_override)
        with self._lock, self._connect() as conn:
            return _fetch(conn)

    def get_patient_complete_record(
        self,
        *,
        actor_subject: str,
        patient_id: str,
    ) -> Dict[str, Any]:
        with self._lock, self._connect() as conn:
            user, patient = self.authorize_patient_access(conn, actor_subject, patient_id)
            pid = patient["patient_id"]
            is_clinical = user["role"] in CLINICAL_ROLES

            self._append_audit(
                conn,
                actor_subject=actor_subject,
                actor_role=user["role"],
                actor_org_id=user["org_id"],
                action="PATIENT_RECORD_VIEWED",
                entity_type="PATIENT",
                entity_id=pid,
                patient_id=pid,
                detail={"viewer_role": user["role"]},
            )

            care_team = [
                dict(r)
                for r in conn.execute(
                    "SELECT * FROM patient_care_team_members WHERE patient_id = ? AND active = 1",
                    (pid,),
                ).fetchall()
            ]
            grants = [
                dict(r)
                for r in conn.execute(
                    "SELECT * FROM patient_access_grants WHERE patient_id = ? ORDER BY created_at_utc DESC",
                    (pid,),
                ).fetchall()
            ]
            wounds_raw = [
                dict(r)
                for r in conn.execute(
                    """SELECT * FROM wounds w WHERE patient_id = ? AND NOT EXISTS (
                        SELECT 1 FROM record_deletions d WHERE d.record_type = 'wound'
                        AND d.record_id = w.wound_id AND d.restored_at_utc IS NULL) ORDER BY created_at_utc ASC""",
                    (pid,),
                ).fetchall()
            ]

            owns_record = user["role"] == "PATIENT" and patient.get("patient_account_subject") == actor_subject
            if not is_clinical and not owns_record:
                active_grants = self._active_access_grants(conn, actor_subject, pid)
                wounds_raw = [w for w in wounds_raw if any(
                    self._grant_allows(grant, w["wound_id"], "VIEW_APPROVED_PROGRESS")
                    for grant in active_grants
                )]
            # Invitation tokens, legal notes, other caregivers and audit details
            # are not part of a caregiver's clinical progress response.
            grant_fields = (
                "grant_id", "wound_id", "grantee_subject", "granted_role", "permissions_json",
                "status", "expires_at_utc", "created_at_utc", "revoked_at_utc",
            )
            grants = [
                {key: grant.get(key) for key in grant_fields}
                for grant in grants
                if is_clinical or owns_record or grant["grantee_subject"] == actor_subject
            ]

            wounds_detailed = []
            for w in wounds_raw:
                wid = w["wound_id"]
                obs_ids = [
                    r["observation_id"]
                    for r in conn.execute(
                        """SELECT observation_id FROM wound_observations o WHERE wound_id = ? AND NOT EXISTS (
                            SELECT 1 FROM record_deletions d WHERE d.record_type = 'observation'
                            AND d.record_id = o.observation_id AND d.restored_at_utc IS NULL)
                            ORDER BY capture_datetime_utc ASC""",
                        (wid,),
                    ).fetchall()
                ]
                observations = [
                    self.get_observation_detail(
                        actor_subject=actor_subject, observation_id=oid, conn_override=conn
                    )
                    for oid in obs_ids
                ]
                if not is_clinical:
                    observations = [ob for ob in observations if
                        ob["review_state"] == "CLINICIAN_APPROVED" or ob["uploading_user_subject"] == actor_subject
                    ]

                # Build verified timeline strictly from CLINICIAN_APPROVED observations
                approved_timeline = []
                prev_area: Optional[float] = None
                baseline_area: Optional[float] = None
                for ob in observations:
                    am = ob.get("approved_measurement")
                    if ob["review_state"] == "CLINICIAN_APPROVED" and am is not None:
                        area = float(am["area_cm2"])
                        if baseline_area is None:
                            baseline_area = area
                        delta_cm2 = round(area - prev_area, 4) if prev_area is not None else 0.0
                        # No percentage from 0 cm²: a wound that reopens after a verified 0 is flagged instead.
                        delta_pct = (
                            round((delta_cm2 / prev_area) * 100.0, 2)
                            if (prev_area is not None and prev_area > 0)
                            else (None if prev_area == 0 else 0.0)
                        )
                        reopened = prev_area == 0 and area > 0
                        prev_area = area
                        geometry_row = conn.execute(
                            "SELECT geometry_json FROM wound_measurements WHERE measurement_id = ?", (am["measurement_id"],)
                        ).fetchone()
                        approved_timeline.append(
                            {
                                "observation_id": ob["observation_id"],
                                "capture_datetime_utc": ob["capture_datetime_utc"],
                                "capture_location_category": ob["capture_location_category"],
                                "uploading_user_subject": ob["uploading_user_subject"],
                                "reviewing_clinician_subject": ob["reviewing_clinician_subject"],
                                "area_cm2": area,
                                "length_cm": am["length_cm"],
                                "width_cm": am["width_cm"],
                                "clinical_length_cm": am.get("clinical_length_cm"),
                                "clinical_width_cm": am.get("clinical_width_cm"),
                                "perimeter_cm": am.get("perimeter_cm"),
                                "length_method": am["length_method"],
                                "width_method": am["width_method"],
                                "source_model": am["source_model"],
                                "was_human_corrected": bool(am["was_human_corrected"]),
                                "delta_from_previous_cm2": delta_cm2,
                                "delta_from_previous_pct": delta_pct,
                                "zero_area": area == 0,
                                "reopened": reopened,
                                "quality_status": ob["quality_gate_status"],
                                # Whole wound vs red tissue only; the summary never compares different regions.
                                "measurement_region": measurement_region_of(
                                    json.loads((geometry_row["geometry_json"] if geometry_row else None) or "null"),
                                    am["was_human_corrected"],
                                ),
                            }
                        )

                unreviewed_observations = [
                    {
                        "observation_id": ob["observation_id"],
                        "capture_datetime_utc": ob["capture_datetime_utc"],
                        "capture_location_category": ob["capture_location_category"],
                        "uploading_user_subject": ob["uploading_user_subject"],
                        "review_state": ob["review_state"],
                        "quality_status": ob["quality_gate_status"],
                        "provisional_area_cm2": (
                            ob["provisional_or_working_measurement"]["area_cm2"]
                            if (is_clinical and ob.get("provisional_or_working_measurement"))
                            else None
                        ),
                        "caregiver_report": ob.get("caregiver_report"),
                    }
                    for ob in observations
                    if ob["review_state"] != "CLINICIAN_APPROVED"
                ]

                plans = [
                    dict(r)
                    for r in conn.execute(
                        "SELECT * FROM care_plans WHERE wound_id = ? ORDER BY version_number DESC",
                        (wid,),
                    ).fetchall()
                ]
                tasks = [
                    dict(r)
                    for r in conn.execute(
                        "SELECT * FROM care_tasks WHERE wound_id = ? ORDER BY due_at_utc ASC",
                        (wid,),
                    ).fetchall()
                ]
                wounds_detailed.append(
                    {
                        **w,
                        "allowed_actions": sorted(
                            CAREGIVER_ACTIONS if is_clinical else PATIENT_ACTIONS if owns_record else {
                                action for action in CAREGIVER_ACTIONS if any(
                                    self._grant_allows(grant, wid, action) for grant in active_grants
                                )
                            }
                        ),
                        "observations": observations,
                        "approved_timeline": approved_timeline,
                        "unreviewed_observations": unreviewed_observations,
                        "care_plans": plans,
                        "care_tasks": tasks,
                        "healing_epistemic_notice": (
                            "Reduction in projected 2D wound surface area does not automatically establish "
                            "clinical healing; depth, tissue bed, exudate, and clinician evaluation are required."
                        ),
                    }
                )

            notifications = [
                dict(r)
                for r in conn.execute(
                    """SELECT * FROM notifications n WHERE recipient_subject = ? AND patient_id = ? AND NOT EXISTS (
                        SELECT 1 FROM record_deletions d WHERE d.record_type = 'observation'
                        AND d.record_id = n.observation_id AND d.restored_at_utc IS NULL)
                        ORDER BY created_at_utc DESC LIMIT 25""",
                    (actor_subject, pid),
                ).fetchall()
            ]
            allowed_wounds = {w["wound_id"] for w in wounds_raw}
            notification_fields = (
                "notification_id", "notification_type", "safe_preview_title", "safe_preview_body", "created_at_utc",
            )
            notifications = [
                {key: notification.get(key) for key in notification_fields}
                for notification in notifications
                if notification["patient_id"] == pid
                and (not notification["wound_id"] or notification["wound_id"] in allowed_wounds)
            ]
            review_inbox = (
                [
                    dict(r)
                    for r in conn.execute(
                        """SELECT * FROM review_requests r WHERE patient_id = ? AND NOT EXISTS (
                            SELECT 1 FROM record_deletions d WHERE ((d.record_type = 'observation' AND d.record_id = r.observation_id)
                            OR (d.record_type = 'wound' AND d.record_id = r.wound_id)) AND d.restored_at_utc IS NULL)
                            ORDER BY created_at_utc DESC""",
                        (pid,),
                    ).fetchall()
                ]
                if is_clinical
                else []
            )
            audit_history = [
                dict(r)
                for r in conn.execute(
                    "SELECT * FROM audit_events WHERE patient_id = ? ORDER BY sequence_id DESC LIMIT 30",
                    (pid,),
                ).fetchall()
            ]
            self._attach_care_summaries(conn, wounds_detailed, review_inbox, user, is_clinical)

            return {
                "fictional_data_disclaimer": (
                    "FICTIONAL DEMO PATIENT RECORD: All patient, caregiver, and clinician identities "
                    "are synthetic demonstration records for the Meta Global AI Developer Hackathon 2026."
                ),
                "viewer": {
                    "subject": user["subject"],
                    "display_name": user["display_name"],
                    "role": user["role"],
                    "org_id": user["org_id"],
                    "is_clinical": is_clinical,
                },
                "patient": self._public_patient(conn, patient, user),
                "access": self._access_relation(conn, user, patient),
                "care_team": care_team,
                "access_grants": grants,
                "wounds": wounds_detailed,
                "review_inbox": review_inbox,
                "notifications": notifications,
                "audit_history": audit_history if is_clinical else [],
            }

    def _summary_report_rows(self, conn: db.Connection, wound_id: str) -> List[Dict[str, Any]]:
        """Progress-summary versions of one wound (clinical_reports in the summary series), excluding deleted ones."""
        rows = conn.execute(
            "SELECT * FROM clinical_reports WHERE wound_id = ? AND report_series_id LIKE ? ORDER BY created_at_utc, version_number",
            (wound_id, SUMMARY_SERIES_PREFIX + "%"),
        ).fetchall()
        return [dict(r) for r in rows if self.record_is_active(conn, "report", r["report_id"])]

    def _attach_care_summaries(self, conn: db.Connection, wounds: List[Dict[str, Any]],
                               review_inbox: List[Dict[str, Any]], user: Dict[str, Any], is_clinical: bool) -> None:
        """One care summary per wound, built from this viewer's already-filtered projection of the record."""
        narratives = {w["wound_id"]: self._summary_report_rows(conn, w["wound_id"]) for w in wounds}
        subjects = {r["created_by_subject"] for rows in narratives.values() for r in rows}
        for w in wounds:
            subjects.update(p.get(k) for p in w["care_plans"] for k in ("responsible_clinician_subject", "assigned_caregiver_subject"))
            subjects.update(p.get("reviewing_clinician_subject") for p in w["approved_timeline"])
            subjects.update(o.get("uploading_user_subject") for o in w["observations"])
        subjects.discard(None)
        names = {r["subject"]: r["display_name"] for r in conn.execute(
            f"SELECT subject, display_name FROM users WHERE subject IN ({','.join('?' * len(subjects))})", tuple(subjects)
        ).fetchall()} if subjects else {}
        for w in wounds:
            w["care_summary"] = build_wound_summary(
                w, clinical=is_clinical, viewer_subject=user["subject"], names=names,
                review_requests=[r for r in review_inbox if r["wound_id"] == w["wound_id"]],
                narratives=summarise_narratives(narratives[w["wound_id"]], names, is_clinical),
            )

    def _access_relation(self, conn: db.Connection, user: Dict[str, Any], patient: Dict[str, Any]) -> Dict[str, Any]:
        """Why this viewer can see the record (shown in the patient header)."""
        if user["role"] in CLINICAL_ROLES:
            on_team = conn.execute(
                "SELECT relationship_label FROM patient_care_team_members WHERE patient_id = ? AND user_subject = ? AND active = 1",
                (patient["patient_id"], user["subject"]),
            ).fetchone()
            if on_team:
                return {"relation": "CARE_TEAM", "label": on_team["relationship_label"]}
            return {"relation": "SAME_ORGANISATION", "label": "Same organisation"}
        if user["role"] == "PATIENT" and patient.get("patient_account_subject") == user["subject"]:
            return {"relation": "OWN_RECORD", "label": "Your record"}
        grant = next((grant for grant in self._active_access_grants(conn, user["subject"], patient["patient_id"])
                      if self._grant_allows(grant, None, "VIEW_APPROVED_PROGRESS")), None)
        return {"relation": "SHARED_ACCESS", "label": "Shared with you", "expires_at_utc": grant["expires_at_utc"] if grant else None}

    def list_authorized_patients(self, *, actor_subject: str) -> List[Dict[str, Any]]:
        """
        Medical staff: patients on their care team (others are found by search).
        Patients: their own record. Caregivers: patients with an active grant.
        """
        with self._lock, self._connect() as conn:
            user = self.get_user_record(conn, actor_subject)
            role = user["role"]
            if role in CLINICAL_ROLES:
                rows = conn.execute(
                    """
                    SELECT DISTINCT p.* FROM patients p
                    JOIN patient_care_team_members m ON p.patient_id = m.patient_id AND m.active = 1
                    WHERE m.user_subject = ? AND p.record_status = 'ACTIVE'
                    ORDER BY p.updated_at_utc DESC
                    """,
                    (actor_subject,),
                ).fetchall()
                return [self._public_patient(conn, dict(r), user) for r in rows]
            if role == "PATIENT":
                rows = conn.execute(
                    "SELECT * FROM patients WHERE patient_account_subject = ? AND record_status = 'ACTIVE'", (actor_subject,)
                ).fetchall()
                return [self._public_patient(conn, dict(r), user) for r in rows]
            if role not in CAREGIVER_ROLES:
                return []
            now_iso = datetime.now(timezone.utc).isoformat()
            rows = conn.execute(
                """
                SELECT DISTINCT p.* FROM patients p
                JOIN patient_access_grants g ON p.patient_id = g.patient_id
                WHERE g.grantee_subject = ? AND g.status = 'ACTIVE' AND g.revoked_at_utc IS NULL AND p.record_status = 'ACTIVE'
                  AND (g.expires_at_utc IS NULL OR g.expires_at_utc > ?)
                """,
                (actor_subject, now_iso),
            ).fetchall()
            return [self._public_patient(conn, dict(r), user) for r in rows if any(
                self._grant_allows(grant, None, "VIEW_APPROVED_PROGRESS")
                for grant in self._active_access_grants(conn, actor_subject, r["patient_id"])
            )]

    def read_private_image(
        self,
        *,
        image_id: str,
        sig: str,
        exp: int,
        actor_subject: Optional[str] = None,
    ) -> Tuple[bytes, str]:
        if not actor_subject:
            raise AccessDeniedError("AUTHENTICATION_REQUIRED", "Sign in to view patient images.")
        viewer = actor_subject.strip()
        if not verify_image_access_token(
            image_id,
            sig,
            exp,
            self.settings.session_secret,
            viewer_subject=viewer,
        ):
            raise AccessDeniedError("EXPIRED_OR_INVALID_IMAGE_TOKEN", "Signed image URL is invalid or expired.")
        with self._lock, self._connect() as conn:
            row = conn.execute("SELECT * FROM wound_images WHERE image_id = ?", (image_id,)).fetchone()
            if not row:
                raise KeyError(f"Image '{image_id}' not found.")
            img = dict(row)
            # Enforce request-time patient/grant authorization so revoked caregiver grants
            # immediately invalidate any previously issued signed image URL.
            user, _ = self.authorize_patient_access(
                conn, viewer, img["patient_id"], wound_id=img["wound_id"]
            )
            self.require_active_record(conn, "observation", img["observation_id"])
            obs_row = conn.execute(
                "SELECT review_state FROM wound_observations WHERE observation_id = ?",
                (img["observation_id"],),
            ).fetchone()
            if (
                obs_row
                and obs_row["review_state"] != "CLINICIAN_APPROVED"
                and user["role"] not in CLINICAL_ROLES
                and img["image_role"] in {"AI_MASK_SAM", "AI_MASK_YOLO", "HUMAN_CORRECTED_MASK"}
            ):
                raise AccessDeniedError(
                    "UNAPPROVED_AI_MASK_RESTRICTED",
                    "Unapproved AI segmentation masks cannot be accessed before clinician approval.",
                )
            if user["role"] not in CLINICAL_ROLES and img["image_role"] == "COLOUR_CORRECTED":
                raise AccessDeniedError(
                    "CLINICAL_ARTEFACT_RESTRICTED", "Colour-corrected review images are available to clinical staff only."
                )
            full_path = (self.private_storage_dir / img["storage_key"]).resolve()
            if not full_path.is_relative_to(self.private_storage_dir.resolve()):
                raise DatabaseStorageError("Stored image reference leaves private_storage; access refused.")
            if not full_path.is_file():
                raise KeyError("Stored image binary not found on disk.")
            return full_path.read_bytes(), img["media_type"]





