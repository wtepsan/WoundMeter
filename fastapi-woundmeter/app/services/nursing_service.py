"""Inpatient nursing: ward shifts, admissions, nursing assessments (quick assessment + Braden + priority)
and care checklists.

Ported from the former nurse-form API (nextjs-nurseform/apps/api, archived) onto the WoundMeter
patient registry, sessions, permissions and hash-chained audit log. Admissions reference the existing
`patients.patient_id`; there is no second patient table. Tables are created additively on startup,
like the connected-care schema.

Access: qualified ward nurses and supervisors only (role NURSE or SUPERVISOR with the ASSESS
permission), on wards listed for them, for patients they may open. Administrators never gain
clinical access through this module.
"""
from __future__ import annotations

import json
from app.services import postgres as db
from datetime import date, datetime, timedelta, timezone, tzinfo
from typing import Any, Callable, Dict, List, Optional
from uuid import uuid4
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from app.services.clinical_scoring import (
    BRADEN_VERSION,
    PRIORITY_RANK,
    PRIORITY_RULE_VERSION,
    SUGGESTED_REVIEW_MINUTES,
    calculate_braden_score,
    calculate_clinical_priority,
    override_direction,
)
from app.services.connected_care_db import AccessDeniedError, ClinicalConflictError, ConnectedCareService

NURSING_ROLES = {"NURSE", "SUPERVISOR"}
SHIFTS = ("DAY", "EVENING", "NIGHT")
ASSESSMENT_TYPES = ("ADMISSION", "DAILY", "REASSESSMENT")
REQUIRED_ASSESSMENT_TYPES = {"ADMISSION", "DAILY"}
ACTIVE_ADMISSION_STATUSES = ("PENDING_ASSESSMENT", "ACTIVE")
OVERRIDE_REASONS = ("CLINICAL_JUDGMENT", "PATIENT_CONDITION", "WORKFLOW_CONTEXT", "DATA_ERROR", "OTHER")
CARE_ACTIVITY_TYPES = ("POSITIONING", "PRESSURE_REDUCTION", "WOUND_CARE", "ESCALATION")
TARGET_WOUND_LOCATIONS = ("SACRUM", "COCCYX", "HEEL", "TROCHANTER", "OTHER", "NOT_APPLICABLE")
BASELINE_WOUND_STATUSES = (
    "NO_WOUND", "STAGE_1", "STAGE_2", "STAGE_3", "STAGE_4", "UNSTAGEABLE", "DEEP_TISSUE_INJURY", "NOT_ASSESSED",
)
QUICK_ASSESSMENT_OPTIONS = {
    "skin_status": ("STABLE", "REDNESS", "WORSENING", "NOT_ASSESSED"),
    "wound_trend": ("STABLE", "IMPROVING", "WORSENING", "NEW_WOUND", "NOT_ASSESSED"),
    "pain_issue": ("NO", "YES_CONTROLLED", "YES_UNCONTROLLED", "NOT_ASSESSED"),
    "moisture_issue": ("NO", "YES_MANAGED", "YES_UNMANAGED", "NOT_ASSESSED"),
    "mobility_issue": ("INDEPENDENT", "LIMITED", "DEPENDENT", "NOT_ASSESSED"),
}
BRADEN_FIELDS = ("sensory_perception", "moisture", "activity", "mobility", "nutrition", "friction_and_shear")
# Reference wards, as seeded by the former nurse-form API.
DEFAULT_WARDS = (
    ("WARD01", "Medical Ward 01", "ORG-HOSP-01"),
    ("WARD02", "Surgical Ward 02", "ORG-HOSP-01"),
)


class NursingStateError(ClinicalConflictError):
    """The request conflicts with the admission, shift or assessment state (HTTP 409)."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


def _clinical_timezone(name: str) -> tzinfo:
    try:
        return ZoneInfo(name)
    except ZoneInfoNotFoundError:
        # Slim containers may lack tz data. Bangkok has no daylight saving, so UTC+7 is exact.
        if name == "Asia/Bangkok":
            return timezone(timedelta(hours=7), "Asia/Bangkok")
        raise


def _parse_utc(value: str) -> datetime:
    parsed = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _code(prefix: str) -> str:
    return f"{prefix}-{uuid4().hex[:8].upper()}"


class NursingService:
    def __init__(self, care: ConnectedCareService):
        self.care = care
        self.tz = _clinical_timezone(care.settings.clinical_timezone)
        self.clock: Callable[[], datetime] = lambda: datetime.now(timezone.utc)
        from app.services.database_storage import validate_schema
        with care._connect() as conn:
            validate_schema(conn, "nursing")
        care.demo_reset_hooks.append(self._delete_patient_rows)

    @staticmethod
    def _delete_patient_rows(conn: db.Connection, patient_ids: List[str]) -> None:
        """Demo reset hook: remove nursing rows for the fictional demo patient before its record is rebuilt."""
        for pid in patient_ids:
            admission_ids = "SELECT admission_id FROM admissions WHERE patient_id = ?"
            conn.execute(f"DELETE FROM nursing_care_activities WHERE admission_id IN ({admission_ids})", (pid,))
            conn.execute("DELETE FROM nursing_assessments WHERE patient_id = ?", (pid,))
            conn.execute(f"DELETE FROM admission_locations WHERE admission_id IN ({admission_ids})", (pid,))
            conn.execute("DELETE FROM admissions WHERE patient_id = ?", (pid,))

    # ------------------------------------------------------------------------------------
    # Access helpers
    # ------------------------------------------------------------------------------------

    def _deny(self, conn: db.Connection, user: Dict[str, Any], code: str, message: str, *,
              action: str, entity_type: str = "NURSING", entity_id: Optional[str] = None,
              patient_id: Optional[str] = None) -> AccessDeniedError:
        self.care._append_audit(
            conn,
            actor_subject=user["subject"],
            actor_role=user["role"],
            actor_org_id=user["org_id"],
            action=f"NURSING_DENIED:{action}",
            entity_type=entity_type,
            entity_id=entity_id,
            patient_id=patient_id,
            outcome="DENIED",
            detail={"code": code},
        )
        return AccessDeniedError(code, message)

    def _nursing_actor(self, conn: db.Connection, actor_subject: Optional[str], action: str) -> Dict[str, Any]:
        if not actor_subject:
            raise AccessDeniedError("AUTHENTICATION_REQUIRED", "Authenticated user session required.")
        user = self.care.get_user_record(conn, actor_subject)
        if user["role"] not in NURSING_ROLES or not self.care.user_has_permission(user, "ASSESS"):
            raise self._deny(
                conn, user, "NURSING_ROLE_REQUIRED",
                "Inpatient nursing records are limited to qualified ward nurses and supervisors.",
                action=action, entity_type="USER", entity_id=user["subject"],
            )
        return user

    def _actor_wards(self, conn: db.Connection, user: Dict[str, Any]) -> List[Dict[str, str]]:
        listed = set(json.loads(user.get("wards_json") or "[]"))
        rows = conn.execute(
            "SELECT ward_code, name FROM wards WHERE org_id = ? AND active = 1 ORDER BY ward_code",
            (user["org_id"],),
        ).fetchall()
        return [{"code": r["ward_code"], "name": r["name"]} for r in rows if r["ward_code"] in listed]

    def _require_ward(self, conn: db.Connection, user: Dict[str, Any], ward_code: str, action: str,
                      patient_id: Optional[str] = None) -> None:
        if ward_code not in {w["code"] for w in self._actor_wards(conn, user)}:
            raise self._deny(
                conn, user, "WARD_ACCESS_DENIED", f"You are not assigned to ward {ward_code}.",
                action=action, entity_type="WARD", entity_id=ward_code, patient_id=patient_id,
            )

    def _active_shift(self, conn: db.Connection, user: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        row = conn.execute(
            "SELECT * FROM shift_sessions WHERE user_subject = ? AND state = 'ACTIVE'", (user["subject"],)
        ).fetchone()
        return dict(row) if row else None

    def _require_shift(self, conn: db.Connection, user: Dict[str, Any], ward_code: str) -> Dict[str, Any]:
        shift = self._active_shift(conn, user)
        if not shift or shift["ward_code"] != ward_code:
            raise NursingStateError("SHIFT_REQUIRED", f"Start a shift on ward {ward_code} to record nursing care.")
        conn.execute(
            "UPDATE shift_sessions SET last_activity_at_utc = ? WHERE shift_id = ?",
            (self.clock().isoformat(), shift["shift_id"]),
        )
        return shift

    def _admission(self, conn: db.Connection, user: Dict[str, Any], admission_ref: str, action: str) -> Dict[str, Any]:
        row = conn.execute(
            "SELECT * FROM admissions WHERE admission_id = ? OR admission_code = ?", (admission_ref, admission_ref)
        ).fetchone()
        if not row:
            raise KeyError("Admission not found.")
        admission = dict(row)
        self._require_ward(conn, user, admission["ward_code"], action, admission["patient_id"])
        self.care.authorize_patient_access(
            conn, user["subject"], admission["patient_id"],
            required_permission=f"NURSING_{action}", require_clinical_role=True,
        )
        return admission

    def _audit(self, conn: db.Connection, user: Dict[str, Any], action: str, entity_type: str,
               entity_id: str, patient_id: Optional[str], detail: Optional[Dict[str, Any]] = None) -> None:
        self.care._append_audit(
            conn,
            actor_subject=user["subject"],
            actor_role=user["role"],
            actor_org_id=user["org_id"],
            action=action,
            entity_type=entity_type,
            entity_id=entity_id,
            patient_id=patient_id,
            detail=detail or {},
        )

    # ------------------------------------------------------------------------------------
    # Views and calculations
    # ------------------------------------------------------------------------------------

    def clinical_date(self, moment: datetime) -> date:
        return moment.astimezone(self.tz).date()

    @staticmethod
    def _names(conn: db.Connection, subjects: List[Optional[str]]) -> Dict[str, str]:
        wanted = sorted({s for s in subjects if s})
        if not wanted:
            return {}
        rows = conn.execute(
            f"SELECT subject, display_name FROM users WHERE subject IN ({', '.join('?' for _ in wanted)})", wanted
        ).fetchall()
        return {r["subject"]: r["display_name"] for r in rows}

    def _admission_view(self, conn: db.Connection, admission: Dict[str, Any]) -> Dict[str, Any]:
        patient = conn.execute(
            "SELECT patient_code, full_name, display_name, hospital_number FROM patients WHERE patient_id = ?",
            (admission["patient_id"],),
        ).fetchone()
        ward = conn.execute("SELECT name FROM wards WHERE ward_code = ?", (admission["ward_code"],)).fetchone()
        return {
            "admission_id": admission["admission_id"],
            "admission_code": admission["admission_code"],
            "patient_id": admission["patient_id"],
            "patient_code": patient["patient_code"] if patient else None,
            "patient_name": (patient["full_name"] or patient["display_name"]) if patient else None,
            "hospital_number": patient["hospital_number"] if patient else None,
            "ward_code": admission["ward_code"],
            "ward_name": ward["name"] if ward else None,
            "bed": admission["bed"],
            "status": admission["status"],
            "admitted_at_utc": admission["admitted_at_utc"],
            "consent_state": admission["consent_state"],
            "target_wound_location": admission["target_wound_location"],
            "baseline_wound_status": admission["baseline_wound_status"],
            "individual_care_plan_available": bool(admission["individual_care_plan_available"]),
            "family_participation_enabled": bool(admission["family_participation_enabled"]),
            "discharge_at_utc": admission["discharge_at_utc"],
            "discharge_reason": admission["discharge_reason"],
            "discharge_exception_reason": admission["discharge_exception_reason"],
            "version": admission["version"],
        }

    def _today_status(self, conn: db.Connection, admission: Dict[str, Any]) -> str:
        if admission["status"] not in ACTIVE_ADMISSION_STATUSES:
            return "NOT_APPLICABLE"
        today = self.clinical_date(self.clock())
        done = conn.execute(
            """SELECT 1 FROM nursing_assessments
               WHERE admission_id = ? AND assessment_date = ? AND counts_as_required_daily = 1""",
            (admission["admission_id"], today.isoformat()),
        ).fetchone()
        if done:
            return "COMPLETED"
        admitted = self.clinical_date(_parse_utc(admission["admitted_at_utc"]))
        return "OVERDUE" if admitted < today and admission["status"] == "PENDING_ASSESSMENT" else "DUE_TODAY"

    def _overdue_critical_care(self, conn: db.Connection, admission_id: str) -> bool:
        return conn.execute(
            """SELECT 1 FROM nursing_care_activities
               WHERE admission_id = ? AND critical = 1 AND status = 'PLANNED' AND due_at_utc < ?""",
            (admission_id, self.clock().isoformat()),
        ).fetchone() is not None

    @staticmethod
    def _activity_view(row: Dict[str, Any], names: Dict[str, str]) -> Dict[str, Any]:
        return {
            "activity_id": row["activity_id"],
            "assessment_id": row["assessment_id"],
            "activity_type": row["activity_type"],
            "critical": bool(row["critical"]),
            "status": row["status"],
            "due_at_utc": row["due_at_utc"],
            "completed_at_utc": row["completed_at_utc"],
            "unable_reason": row["unable_reason"],
            "performed_by": names.get(row["performed_by_subject"]) if row["performed_by_subject"] else None,
        }

    @staticmethod
    def _assessment_view(row: Dict[str, Any], names: Dict[str, str]) -> Dict[str, Any]:
        return {
            "assessment_id": row["assessment_id"],
            "admission_id": row["admission_id"],
            "assessment_type": row["assessment_type"],
            "assessment_date": row["assessment_date"],
            "submitted_at_utc": row["submitted_at_utc"],
            "submitted_by": names.get(row["submitted_by_subject"], row["submitted_by_subject"]),
            "quick_assessment": {
                "red_flag_present": bool(row["red_flag_present"]),
                "new_abnormality": bool(row["new_abnormality"]),
                **{field: row[field] for field in QUICK_ASSESSMENT_OPTIONS},
            },
            "braden": {
                **{field: row[field] for field in BRADEN_FIELDS},
                "total": row["braden_total"],
                "risk_band": row["braden_risk_band"],
                "version": row["braden_version"],
            },
            "priority": {
                "system": row["system_priority"],
                "nurse": row["nurse_priority"],
                "agreement": not row["priority_override"],
                "override": bool(row["priority_override"]),
                "override_direction": row["override_direction"],
                "override_reason": row["override_reason"],
                "reason_codes": json.loads(row["priority_reason_codes_json"]),
                "suggested_review_minutes": row["suggested_review_minutes"],
                "next_review_at_utc": row["next_review_at_utc"],
                "rule_version": row["rule_version"],
            },
        }

    def _calculate(self, conn: db.Connection, admission_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
        for field, options in QUICK_ASSESSMENT_OPTIONS.items():
            if payload.get(field) not in options:
                raise ValueError(f"{field} must be one of {', '.join(options)}.")
        for field in BRADEN_FIELDS:
            if not isinstance(payload.get(field), int) or isinstance(payload.get(field), bool):
                raise ValueError(f"Select a Braden score for {field}.")
        braden_total, braden_band = calculate_braden_score(*(payload[field] for field in BRADEN_FIELDS))
        system_priority, reasons = calculate_clinical_priority(
            red_flag_present=bool(payload.get("red_flag_present")),
            new_abnormality=bool(payload.get("new_abnormality")),
            skin_status=payload["skin_status"],
            wound_trend=payload["wound_trend"],
            pain_issue=payload["pain_issue"],
            moisture_issue=payload["moisture_issue"],
            mobility_issue=payload["mobility_issue"],
            overdue_critical_activity=self._overdue_critical_care(conn, admission_id),
        )
        return {
            "braden_total": braden_total,
            "braden_risk_band": braden_band,
            "braden_version": BRADEN_VERSION,
            "system_priority": system_priority,
            "priority_reason_codes": reasons,
            "suggested_review_minutes": SUGGESTED_REVIEW_MINUTES[system_priority],
            "rule_version": PRIORITY_RULE_VERSION,
        }

    @staticmethod
    def _check_type_due(admission: Dict[str, Any], assessment_type: str) -> None:
        if assessment_type not in ASSESSMENT_TYPES:
            raise ValueError(f"assessment_type must be one of {', '.join(ASSESSMENT_TYPES)}.")
        if assessment_type == "ADMISSION" and admission["status"] != "PENDING_ASSESSMENT":
            raise NursingStateError("ASSESSMENT_NOT_DUE", "The admission assessment has already been recorded.")
        if assessment_type != "ADMISSION" and admission["status"] != "ACTIVE":
            raise NursingStateError(
                "ADMISSION_NOT_ACTIVE",
                "Daily assessments and reassessments need an active admission; record the admission assessment first.",
            )

    def _detail(self, conn: db.Connection, admission: Dict[str, Any]) -> Dict[str, Any]:
        assessments = [dict(r) for r in conn.execute(
            "SELECT * FROM nursing_assessments WHERE admission_id = ? ORDER BY submitted_at_utc DESC",
            (admission["admission_id"],),
        ).fetchall()]
        latest = assessments[0] if assessments else None
        activities = [dict(r) for r in conn.execute(
            "SELECT * FROM nursing_care_activities WHERE assessment_id = ? ORDER BY due_at_utc, activity_type",
            (latest["assessment_id"] if latest else "",),
        ).fetchall()]
        names = self._names(conn, [a["submitted_by_subject"] for a in assessments]
                            + [a["performed_by_subject"] for a in activities])
        timeline: List[Dict[str, Any]] = [
            {
                "type": "ASSESSMENT",
                "occurred_at_utc": a["submitted_at_utc"],
                "assessment_id": a["assessment_id"],
                "assessment_type": a["assessment_type"],
                "priority": a["nurse_priority"],
                "braden_total": a["braden_total"],
                "by": names.get(a["submitted_by_subject"], a["submitted_by_subject"]),
            }
            for a in assessments
        ]
        timeline.append({"type": "ADMISSION", "occurred_at_utc": admission["admitted_at_utc"], "status": admission["status"]})
        if admission["discharge_at_utc"]:
            timeline.append({"type": "DISCHARGE", "occurred_at_utc": admission["discharge_at_utc"],
                             "reason": admission["discharge_reason"]})
        timeline.sort(key=lambda event: event["occurred_at_utc"], reverse=True)
        return {
            "admission": self._admission_view(conn, admission),
            "today": {
                "assessment_date": self.clinical_date(self.clock()).isoformat(),
                "status": self._today_status(conn, admission),
            },
            "overdue_critical_care": self._overdue_critical_care(conn, admission["admission_id"]),
            "latest_assessment": self._assessment_view(latest, names) if latest else None,
            "care_activities": [self._activity_view(a, names) for a in activities],
            "timeline": timeline,
        }

    def _context(self, conn: db.Connection, user: Dict[str, Any]) -> Dict[str, Any]:
        shift = self._active_shift(conn, user)
        return {
            "wards": self._actor_wards(conn, user),
            "active_shift": (
                {"shift_id": shift["shift_id"], "ward_code": shift["ward_code"], "shift": shift["shift"],
                 "started_at_utc": shift["started_at_utc"]}
                if shift else None
            ),
            "clinical_date": self.clinical_date(self.clock()).isoformat(),
            "can_authorise_discharge_exception": user["role"] == "SUPERVISOR",
        }

    # ------------------------------------------------------------------------------------
    # Shifts and ward board
    # ------------------------------------------------------------------------------------

    def context(self, *, actor_subject: Optional[str]) -> Dict[str, Any]:
        with self.care._lock, self.care._connect() as conn:
            return self._context(conn, self._nursing_actor(conn, actor_subject, "CONTEXT"))

    def start_shift(self, *, actor_subject: Optional[str], ward_code: str, shift: str) -> Dict[str, Any]:
        if shift not in SHIFTS:
            raise ValueError(f"shift must be one of {', '.join(SHIFTS)}.")
        with self.care._lock, self.care._connect() as conn:
            user = self._nursing_actor(conn, actor_subject, "SHIFT_START")
            self._require_ward(conn, user, ward_code, "SHIFT_START")
            now = self.clock().isoformat()
            conn.execute(
                "UPDATE shift_sessions SET state = 'ENDED', ended_at_utc = ? WHERE user_subject = ? AND state = 'ACTIVE'",
                (now, user["subject"]),
            )
            shift_id = f"SHF-{uuid4().hex[:12]}"
            conn.execute(
                """INSERT INTO shift_sessions(shift_id, user_subject, ward_code, shift, state, started_at_utc,
                                              last_activity_at_utc)
                   VALUES (?, ?, ?, ?, 'ACTIVE', ?, ?)""",
                (shift_id, user["subject"], ward_code, shift, now, now),
            )
            self._audit(conn, user, "NURSING_SHIFT_STARTED", "SHIFT", shift_id, None, {"ward_code": ward_code, "shift": shift})
            return self._context(conn, user)

    def end_shift(self, *, actor_subject: Optional[str], shift_id: str) -> Dict[str, Any]:
        with self.care._lock, self.care._connect() as conn:
            user = self._nursing_actor(conn, actor_subject, "SHIFT_END")
            row = conn.execute(
                "SELECT * FROM shift_sessions WHERE shift_id = ? AND user_subject = ?", (shift_id, user["subject"])
            ).fetchone()
            if not row:
                raise KeyError("Shift not found.")
            if row["state"] == "ACTIVE":
                conn.execute(
                    "UPDATE shift_sessions SET state = 'ENDED', ended_at_utc = ? WHERE shift_id = ?",
                    (self.clock().isoformat(), shift_id),
                )
                self._audit(conn, user, "NURSING_SHIFT_ENDED", "SHIFT", shift_id, None, {"ward_code": row["ward_code"]})
            return self._context(conn, user)

    def _scoped_admissions(self, conn: db.Connection, user: Dict[str, Any], where: str,
                           params: tuple, order: str) -> List[Dict[str, Any]]:
        wards = [w["code"] for w in self._actor_wards(conn, user)]
        if not wards:
            return []
        scope, scope_params = self.care._scope_clause(user)
        rows = conn.execute(
            f"""SELECT a.* FROM admissions a JOIN patients p ON p.patient_id = a.patient_id
                WHERE a.ward_code IN ({', '.join('?' for _ in wards)}) AND {scope} AND {where}
                ORDER BY {order}""",
            (*wards, *scope_params, *params),
        ).fetchall()
        return [dict(r) for r in rows]

    def ward_board(self, *, actor_subject: Optional[str], ward_code: str) -> Dict[str, Any]:
        with self.care._lock, self.care._connect() as conn:
            user = self._nursing_actor(conn, actor_subject, "WARD_BOARD")
            self._require_ward(conn, user, ward_code, "WARD_BOARD")
            rows = []
            for admission in self._scoped_admissions(
                conn, user, "a.ward_code = ? AND a.status IN ('PENDING_ASSESSMENT', 'ACTIVE')", (ward_code,), "a.bed"
            ):
                latest = conn.execute(
                    """SELECT nurse_priority, braden_total, next_review_at_utc FROM nursing_assessments
                       WHERE admission_id = ? ORDER BY submitted_at_utc DESC LIMIT 1""",
                    (admission["admission_id"],),
                ).fetchone()
                rows.append({
                    **self._admission_view(conn, admission),
                    "today_status": self._today_status(conn, admission),
                    "priority": latest["nurse_priority"] if latest else None,
                    "braden_total": latest["braden_total"] if latest else None,
                    "next_review_at_utc": latest["next_review_at_utc"] if latest else None,
                    "overdue_critical_care": self._overdue_critical_care(conn, admission["admission_id"]),
                })
            return {"ward_code": ward_code, "context": self._context(conn, user), "admissions": rows}

    def list_admissions(self, *, actor_subject: Optional[str], status: str = "active",
                        ward_code: Optional[str] = None) -> List[Dict[str, Any]]:
        filters = {
            "active": ("a.status IN ('PENDING_ASSESSMENT', 'ACTIVE')", "a.admitted_at_utc DESC"),
            "discharged": ("a.status = 'DISCHARGED'", "a.discharge_at_utc DESC"),
            "all": ("1 = 1", "a.admitted_at_utc DESC"),
        }
        if status not in filters:
            raise ValueError("status must be active, discharged or all.")
        where, order = filters[status]
        params: tuple = ()
        if ward_code:
            where += " AND a.ward_code = ?"
            params = (ward_code,)
        with self.care._lock, self.care._connect() as conn:
            user = self._nursing_actor(conn, actor_subject, "ADMISSION_LIST")
            return [self._admission_view(conn, a) for a in self._scoped_admissions(conn, user, where, params, order)]

    # ------------------------------------------------------------------------------------
    # Admissions
    # ------------------------------------------------------------------------------------

    def patient_summary(self, *, actor_subject: Optional[str], patient_id: str) -> Dict[str, Any]:
        with self.care._lock, self.care._connect() as conn:
            user = self._nursing_actor(conn, actor_subject, "PATIENT_SUMMARY")
            _, patient = self.care.authorize_patient_access(
                conn, user["subject"], patient_id, required_permission="NURSING_PATIENT_SUMMARY",
                require_clinical_role=True,
            )
            wards = {w["code"] for w in self._actor_wards(conn, user)}
            admissions = [
                dict(r) for r in conn.execute(
                    "SELECT * FROM admissions WHERE patient_id = ? ORDER BY admitted_at_utc DESC",
                    (patient["patient_id"],),
                ).fetchall()
            ]
            current = next((a for a in admissions if a["status"] in ACTIVE_ADMISSION_STATUSES), None)
            return {
                "patient_id": patient["patient_id"],
                "context": self._context(conn, user),
                # An active admission on a ward this nurse isn't assigned to is reported, not opened.
                "current": self._detail(conn, current) if current and current["ward_code"] in wards else None,
                "admitted_elsewhere": (
                    {"ward_code": current["ward_code"], "admission_code": current["admission_code"]}
                    if current and current["ward_code"] not in wards else None
                ),
                "admissions": [self._admission_view(conn, a) for a in admissions if a["ward_code"] in wards],
            }

    def admit_patient(
        self,
        *,
        actor_subject: Optional[str],
        patient_id: str,
        bed: str,
        ward_code: Optional[str] = None,
        consent_state: str = "NOT_REQUIRED",
        target_wound_location: str = "NOT_APPLICABLE",
        baseline_wound_status: str = "NO_WOUND",
        individual_care_plan_available: bool = False,
        family_participation_enabled: bool = False,
    ) -> Dict[str, Any]:
        bed = (bed or "").strip()
        consent_state = (consent_state or "").strip() or "NOT_REQUIRED"
        if not bed or len(bed) > 50:
            raise ValueError("Enter a bed (up to 50 characters).")
        if len(consent_state) > 30:
            raise ValueError("consent_state is limited to 30 characters.")
        if target_wound_location not in TARGET_WOUND_LOCATIONS:
            raise ValueError(f"target_wound_location must be one of {', '.join(TARGET_WOUND_LOCATIONS)}.")
        if baseline_wound_status not in BASELINE_WOUND_STATUSES:
            raise ValueError(f"baseline_wound_status must be one of {', '.join(BASELINE_WOUND_STATUSES)}.")
        if target_wound_location == "NOT_APPLICABLE" and baseline_wound_status != "NO_WOUND":
            raise ValueError("Choose a target wound location, or record the baseline as 'No wound'.")
        with self.care._lock, self.care._connect() as conn:
            user = self._nursing_actor(conn, actor_subject, "ADMIT")
            shift = self._active_shift(conn, user)
            ward_code = ward_code or (shift["ward_code"] if shift else "")
            if not ward_code:
                raise NursingStateError("SHIFT_REQUIRED", "Start a shift on a ward before admitting a patient.")
            _, patient = self.care.authorize_patient_access(
                conn, user["subject"], patient_id, required_permission="NURSING_ADMIT", require_clinical_role=True
            )
            self._require_ward(conn, user, ward_code, "ADMIT", patient["patient_id"])
            self._require_shift(conn, user, ward_code)
            existing = conn.execute(
                "SELECT admission_code, ward_code FROM admissions WHERE patient_id = ? AND status IN ('PENDING_ASSESSMENT', 'ACTIVE')",
                (patient["patient_id"],),
            ).fetchone()
            if existing:
                raise NursingStateError(
                    "ACTIVE_ADMISSION_EXISTS",
                    f"This patient is already admitted ({existing['admission_code']}, ward {existing['ward_code']}).",
                )
            now = self.clock().isoformat()
            admission_id = str(uuid4())
            admission_code = _code("ADM")
            conn.execute(
                """INSERT INTO admissions(admission_id, admission_code, patient_id, ward_code, bed, status,
                       admitted_at_utc, consent_state, target_wound_location, baseline_wound_status,
                       individual_care_plan_available, family_participation_enabled, created_by_subject,
                       version, created_at_utc)
                   VALUES (?, ?, ?, ?, ?, 'PENDING_ASSESSMENT', ?, ?, ?, ?, ?, ?, ?, 1, ?)""",
                (admission_id, admission_code, patient["patient_id"], ward_code, bed, now, consent_state,
                 target_wound_location, baseline_wound_status, int(bool(individual_care_plan_available)),
                 int(bool(family_participation_enabled)), user["subject"], now),
            )
            conn.execute(
                """INSERT INTO admission_locations(location_id, admission_id, ward_code, bed, started_at_utc,
                                                   created_by_subject)
                   VALUES (?, ?, ?, ?, ?, ?)""",
                (f"LOC-{uuid4().hex[:12]}", admission_id, ward_code, bed, now, user["subject"]),
            )
            self._audit(conn, user, "ADMISSION_CREATED", "ADMISSION", admission_id, patient["patient_id"],
                        {"admission_code": admission_code, "ward_code": ward_code, "bed": bed})
            admission = dict(conn.execute("SELECT * FROM admissions WHERE admission_id = ?", (admission_id,)).fetchone())
            return self._detail(conn, admission)

    def admission_detail(self, *, actor_subject: Optional[str], admission_id: str) -> Dict[str, Any]:
        with self.care._lock, self.care._connect() as conn:
            user = self._nursing_actor(conn, actor_subject, "ADMISSION_VIEW")
            return self._detail(conn, self._admission(conn, user, admission_id, "ADMISSION_VIEW"))

    def transfer(self, *, actor_subject: Optional[str], admission_id: str, ward_code: str, bed: str) -> Dict[str, Any]:
        bed = (bed or "").strip()
        if not bed or len(bed) > 50:
            raise ValueError("Enter a bed (up to 50 characters).")
        with self.care._lock, self.care._connect() as conn:
            user = self._nursing_actor(conn, actor_subject, "TRANSFER")
            admission = self._admission(conn, user, admission_id, "TRANSFER")
            if admission["status"] not in ACTIVE_ADMISSION_STATUSES:
                raise NursingStateError("ADMISSION_NOT_ACTIVE", "Only a current admission can be transferred.")
            self._require_shift(conn, user, admission["ward_code"])
            if not conn.execute("SELECT 1 FROM wards WHERE ward_code = ? AND active = 1", (ward_code,)).fetchone():
                raise KeyError(f"Ward {ward_code} not found.")
            self._require_ward(conn, user, ward_code, "TRANSFER", admission["patient_id"])
            now = self.clock().isoformat()
            conn.execute(
                "UPDATE admission_locations SET ended_at_utc = ? WHERE admission_id = ? AND ended_at_utc IS NULL",
                (now, admission["admission_id"]),
            )
            conn.execute(
                """INSERT INTO admission_locations(location_id, admission_id, ward_code, bed, started_at_utc,
                                                   created_by_subject)
                   VALUES (?, ?, ?, ?, ?, ?)""",
                (f"LOC-{uuid4().hex[:12]}", admission["admission_id"], ward_code, bed, now, user["subject"]),
            )
            conn.execute(
                "UPDATE admissions SET ward_code = ?, bed = ?, version = version + 1 WHERE admission_id = ?",
                (ward_code, bed, admission["admission_id"]),
            )
            self._audit(conn, user, "ADMISSION_TRANSFERRED", "ADMISSION", admission["admission_id"],
                        admission["patient_id"], {"from": f"{admission['ward_code']}/{admission['bed']}",
                                                  "to": f"{ward_code}/{bed}"})
            updated = dict(conn.execute("SELECT * FROM admissions WHERE admission_id = ?", (admission["admission_id"],)).fetchone())
            return self._detail(conn, updated)

    def discharge(self, *, actor_subject: Optional[str], admission_id: str, reason: str,
                  exception_reason: Optional[str] = None) -> Dict[str, Any]:
        reason = (reason or "").strip()
        exception_reason = (exception_reason or "").strip() or None
        if not 2 <= len(reason) <= 500:
            raise ValueError("Enter a discharge reason (2–500 characters).")
        if exception_reason and not 2 <= len(exception_reason) <= 500:
            raise ValueError("The exception reason must be 2–500 characters.")
        with self.care._lock, self.care._connect() as conn:
            user = self._nursing_actor(conn, actor_subject, "DISCHARGE")
            admission = self._admission(conn, user, admission_id, "DISCHARGE")
            self._require_shift(conn, user, admission["ward_code"])
            if admission["status"] not in ACTIVE_ADMISSION_STATUSES:
                raise NursingStateError("ADMISSION_NOT_ACTIVE", "This admission is not active.")
            recorded_exception = None
            if self._today_status(conn, admission) != "COMPLETED":
                if not exception_reason:
                    raise NursingStateError(
                        "TODAY_ASSESSMENT_REQUIRED",
                        "Today's required assessment must be completed before discharge, or a supervisor must record an exception.",
                    )
                if user["role"] != "SUPERVISOR":
                    raise self._deny(
                        conn, user, "SUPERVISOR_EXCEPTION_REQUIRED",
                        "Only a supervisor can discharge without today's required assessment.",
                        action="DISCHARGE_EXCEPTION", entity_type="ADMISSION",
                        entity_id=admission["admission_id"], patient_id=admission["patient_id"],
                    )
                recorded_exception = exception_reason
                self._audit(conn, user, "DISCHARGE_EXCEPTION_AUTHORISED", "ADMISSION", admission["admission_id"],
                            admission["patient_id"], {"exception_reason": exception_reason})
            now = self.clock().isoformat()
            conn.execute(
                """UPDATE admissions SET status = 'DISCHARGED', discharge_at_utc = ?, discharge_reason = ?,
                       discharge_exception_reason = ?, version = version + 1
                   WHERE admission_id = ?""",
                (now, reason, recorded_exception, admission["admission_id"]),
            )
            conn.execute(
                "UPDATE admission_locations SET ended_at_utc = ? WHERE admission_id = ? AND ended_at_utc IS NULL",
                (now, admission["admission_id"]),
            )
            self._audit(conn, user, "ADMISSION_DISCHARGED", "ADMISSION", admission["admission_id"],
                        admission["patient_id"], {"exception": bool(recorded_exception)})
            updated = dict(conn.execute("SELECT * FROM admissions WHERE admission_id = ?", (admission["admission_id"],)).fetchone())
            return self._detail(conn, updated)

    def admission_report(self, *, actor_subject: Optional[str], admission_id: str) -> Dict[str, Any]:
        with self.care._lock, self.care._connect() as conn:
            user = self._nursing_actor(conn, actor_subject, "REPORT")
            admission = self._admission(conn, user, admission_id, "REPORT")
            patient = dict(conn.execute("SELECT * FROM patients WHERE patient_id = ?", (admission["patient_id"],)).fetchone())
            assessments = [dict(r) for r in conn.execute(
                "SELECT * FROM nursing_assessments WHERE admission_id = ? ORDER BY submitted_at_utc",
                (admission["admission_id"],),
            ).fetchall()]
            activities = [dict(r) for r in conn.execute(
                "SELECT * FROM nursing_care_activities WHERE admission_id = ? ORDER BY due_at_utc, activity_type",
                (admission["admission_id"],),
            ).fetchall()]
            names = self._names(conn, [a["submitted_by_subject"] for a in assessments]
                                + [a["performed_by_subject"] for a in activities])
            by_assessment: Dict[str, List[Dict[str, Any]]] = {}
            for activity in activities:
                by_assessment.setdefault(activity["assessment_id"], []).append(self._activity_view(activity, names))
            self._audit(conn, user, "ADMISSION_REPORT_VIEWED", "ADMISSION", admission["admission_id"], admission["patient_id"])
            return {
                "generated_at_utc": self.clock().isoformat(),
                "patient": {
                    "patient_code": patient["patient_code"],
                    "patient_name": patient.get("full_name") or patient["display_name"],
                    "hospital_number": patient.get("hospital_number"),
                    "age_group": patient.get("age_group"),
                    "sex": patient.get("sex"),
                    "is_fictional_demo": bool(patient.get("is_fictional_demo")),
                },
                "admission": self._admission_view(conn, admission),
                "assessments": [
                    {**self._assessment_view(a, names), "care_activities": by_assessment.get(a["assessment_id"], [])}
                    for a in assessments
                ],
            }

    # ------------------------------------------------------------------------------------
    # Assessments and care checklist
    # ------------------------------------------------------------------------------------

    def preview_assessment(self, *, actor_subject: Optional[str], admission_id: str, assessment_type: str,
                           payload: Dict[str, Any]) -> Dict[str, Any]:
        """Server-side Braden and priority calculation; nothing is stored."""
        with self.care._lock, self.care._connect() as conn:
            user = self._nursing_actor(conn, actor_subject, "ASSESSMENT_PREVIEW")
            admission = self._admission(conn, user, admission_id, "ASSESSMENT_PREVIEW")
            self._require_shift(conn, user, admission["ward_code"])
            self._check_type_due(admission, assessment_type)
            result = self._calculate(conn, admission["admission_id"], payload)
            return {**result, "assessment_date": self.clinical_date(self.clock()).isoformat()}

    def submit_assessment(self, *, actor_subject: Optional[str], admission_id: str, assessment_type: str,
                          payload: Dict[str, Any]) -> Dict[str, Any]:
        with self.care._lock, self.care._connect() as conn:
            user = self._nursing_actor(conn, actor_subject, "ASSESSMENT_SUBMIT")
            admission = self._admission(conn, user, admission_id, "ASSESSMENT_SUBMIT")
            shift = self._require_shift(conn, user, admission["ward_code"])
            self._check_type_due(admission, assessment_type)
            result = self._calculate(conn, admission["admission_id"], payload)
            system_priority = result["system_priority"]
            nurse_priority = payload.get("nurse_priority") or system_priority
            if nurse_priority not in PRIORITY_RANK:
                raise ValueError("nurse_priority must be RED, YELLOW or GREEN.")
            is_override = nurse_priority != system_priority
            override_reason = payload.get("override_reason") or None
            if is_override and override_reason not in OVERRIDE_REASONS:
                raise ValueError("A valid override reason is required when the confirmed priority differs.")
            if not is_override and override_reason:
                raise ValueError("An override reason applies only when the confirmed priority differs.")
            now = self.clock()
            next_review = (
                _parse_utc(payload["next_review_at"]) if payload.get("next_review_at")
                else now + timedelta(minutes=result["suggested_review_minutes"])
            )
            if next_review <= now:
                raise ValueError("The next review must be in the future.")
            assessment_date = self.clinical_date(now).isoformat()
            required = assessment_type in REQUIRED_ASSESSMENT_TYPES
            if required and conn.execute(
                """SELECT 1 FROM nursing_assessments
                   WHERE admission_id = ? AND assessment_date = ? AND counts_as_required_daily = 1""",
                (admission["admission_id"], assessment_date),
            ).fetchone():
                raise NursingStateError(
                    "REQUIRED_ASSESSMENT_EXISTS",
                    "Today's required assessment is already recorded; record a reassessment instead.",
                )
            assessment_id = str(uuid4())
            row = {
                "assessment_id": assessment_id,
                "admission_id": admission["admission_id"],
                "patient_id": admission["patient_id"],
                "shift_id": shift["shift_id"],
                "assessment_type": assessment_type,
                "assessment_date": assessment_date,
                "counts_as_required_daily": int(required),
                "red_flag_present": int(bool(payload.get("red_flag_present"))),
                "new_abnormality": int(bool(payload.get("new_abnormality"))),
                **{field: payload[field] for field in QUICK_ASSESSMENT_OPTIONS},
                **{field: payload[field] for field in BRADEN_FIELDS},
                "braden_total": result["braden_total"],
                "braden_risk_band": result["braden_risk_band"],
                "braden_version": result["braden_version"],
                "system_priority": system_priority,
                "nurse_priority": nurse_priority,
                "priority_override": int(is_override),
                "override_direction": override_direction(system_priority, nurse_priority),
                "override_reason": override_reason,
                "priority_reason_codes_json": json.dumps(result["priority_reason_codes"]),
                "suggested_review_minutes": result["suggested_review_minutes"],
                "next_review_at_utc": next_review.isoformat(),
                "rule_version": result["rule_version"],
                "submitted_by_subject": user["subject"],
                "submitted_at_utc": now.isoformat(),
            }
            try:
                conn.execute(
                    f"INSERT INTO nursing_assessments({', '.join(row)}) VALUES ({', '.join('?' for _ in row)})",
                    tuple(row.values()),
                )
            except db.IntegrityError as exc:
                raise NursingStateError(
                    "REQUIRED_ASSESSMENT_EXISTS", "Today's required assessment is already recorded."
                ) from exc
            if assessment_type == "ADMISSION":
                conn.execute(
                    "UPDATE admissions SET status = 'ACTIVE', version = version + 1 WHERE admission_id = ?",
                    (admission["admission_id"],),
                )
            self._audit(conn, user, "NURSING_ASSESSMENT_SUBMITTED", "NURSING_ASSESSMENT", assessment_id,
                        admission["patient_id"], {
                            "assessment_type": assessment_type,
                            "braden_total": result["braden_total"],
                            "system_priority": system_priority,
                            "nurse_priority": nurse_priority,
                        })
            names = self._names(conn, [user["subject"]])
            return self._assessment_view(row, names)

    def _activity_scope(self, conn: db.Connection, user: Dict[str, Any], activity_id: str,
                        action: str) -> Dict[str, Any]:
        row = conn.execute("SELECT * FROM nursing_care_activities WHERE activity_id = ?", (activity_id,)).fetchone()
        if not row:
            raise KeyError("Care activity not found.")
        activity = dict(row)
        admission = self._admission(conn, user, activity["admission_id"], action)
        self._require_shift(conn, user, admission["ward_code"])
        if activity["status"] != "PLANNED":
            raise NursingStateError("ACTIVITY_CLOSED", "This care activity has already been recorded.")
        return {**activity, "patient_id": admission["patient_id"]}

    def set_care_checklist(self, *, actor_subject: Optional[str], assessment_id: str,
                           activities: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        with self.care._lock, self.care._connect() as conn:
            user = self._nursing_actor(conn, actor_subject, "CARE_CHECKLIST")
            assessment = conn.execute(
                "SELECT assessment_id, admission_id FROM nursing_assessments WHERE assessment_id = ?", (assessment_id,)
            ).fetchone()
            if not assessment:
                raise KeyError("Nursing assessment not found.")
            admission = self._admission(conn, user, assessment["admission_id"], "CARE_CHECKLIST")
            self._require_shift(conn, user, admission["ward_code"])
            if admission["status"] not in ACTIVE_ADMISSION_STATUSES:
                raise NursingStateError("ADMISSION_NOT_ACTIVE", "This admission is not active.")
            existing = {
                r["activity_type"]: dict(r) for r in conn.execute(
                    "SELECT * FROM nursing_care_activities WHERE assessment_id = ?", (assessment_id,)
                ).fetchall()
            }
            now = self.clock().isoformat()
            for item in activities:
                activity_type = item.get("activity_type")
                if activity_type not in CARE_ACTIVITY_TYPES:
                    raise ValueError(f"activity_type must be one of {', '.join(CARE_ACTIVITY_TYPES)}.")
                due_at = _parse_utc(str(item.get("due_at") or "")).isoformat()
                critical = int(bool(item.get("critical")))
                current = existing.get(activity_type)
                if current:
                    if current["status"] == "PLANNED":
                        conn.execute(
                            """UPDATE nursing_care_activities SET critical = ?, due_at_utc = ?, version = version + 1
                               WHERE activity_id = ?""",
                            (critical, due_at, current["activity_id"]),
                        )
                else:
                    conn.execute(
                        """INSERT INTO nursing_care_activities(activity_id, assessment_id, admission_id, activity_type,
                               critical, status, due_at_utc, created_at_utc)
                           VALUES (?, ?, ?, ?, ?, 'PLANNED', ?, ?)""",
                        (f"ACT-{uuid4().hex[:12]}", assessment_id, admission["admission_id"], activity_type,
                         critical, due_at, now),
                    )
            self._audit(conn, user, "CARE_CHECKLIST_UPDATED", "NURSING_ASSESSMENT", assessment_id,
                        admission["patient_id"], {"activities": [a.get("activity_type") for a in activities]})
            rows = [dict(r) for r in conn.execute(
                "SELECT * FROM nursing_care_activities WHERE assessment_id = ? ORDER BY due_at_utc, activity_type",
                (assessment_id,),
            ).fetchall()]
            names = self._names(conn, [r["performed_by_subject"] for r in rows])
            return [self._activity_view(r, names) for r in rows]

    def complete_care_activity(self, *, actor_subject: Optional[str], activity_id: str) -> Dict[str, Any]:
        with self.care._lock, self.care._connect() as conn:
            user = self._nursing_actor(conn, actor_subject, "CARE_ACTIVITY")
            activity = self._activity_scope(conn, user, activity_id, "CARE_ACTIVITY")
            conn.execute(
                """UPDATE nursing_care_activities SET status = 'COMPLETED', completed_at_utc = ?,
                       performed_by_subject = ?, version = version + 1
                   WHERE activity_id = ?""",
                (self.clock().isoformat(), user["subject"], activity_id),
            )
            self._audit(conn, user, "CARE_ACTIVITY_COMPLETED", "CARE_ACTIVITY", activity_id, activity["patient_id"],
                        {"activity_type": activity["activity_type"]})
            row = dict(conn.execute("SELECT * FROM nursing_care_activities WHERE activity_id = ?", (activity_id,)).fetchone())
            return self._activity_view(row, self._names(conn, [user["subject"]]))

    def mark_care_activity_unable(self, *, actor_subject: Optional[str], activity_id: str, reason: str) -> Dict[str, Any]:
        reason = (reason or "").strip()
        if not 2 <= len(reason) <= 100:
            raise ValueError("Enter a reason (2–100 characters).")
        with self.care._lock, self.care._connect() as conn:
            user = self._nursing_actor(conn, actor_subject, "CARE_ACTIVITY")
            activity = self._activity_scope(conn, user, activity_id, "CARE_ACTIVITY")
            conn.execute(
                """UPDATE nursing_care_activities SET status = 'UNABLE', unable_reason = ?,
                       performed_by_subject = ?, version = version + 1
                   WHERE activity_id = ?""",
                (reason, user["subject"], activity_id),
            )
            self._audit(conn, user, "CARE_ACTIVITY_UNABLE", "CARE_ACTIVITY", activity_id, activity["patient_id"],
                        {"activity_type": activity["activity_type"], "reason": reason})
            row = dict(conn.execute("SELECT * FROM nursing_care_activities WHERE activity_id = ?", (activity_id,)).fetchone())
            return self._activity_view(row, self._names(conn, [user["subject"]]))
