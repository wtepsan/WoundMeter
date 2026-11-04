"""
Administration: accounts, roles, organisation membership, qualifications, clinical permissions,
care-team assignment and access logs.

Administrators manage access; they do not receive clinical permissions or clinical record access.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from app.services.permission_policy import expand_permissions
from app.services.auth_service import AuthService, SessionIdentity, hash_password, validate_new_password
from app.services.demo_accounts import DEMO_ORG_ID
from app.services.connected_care_db import (
    ALL_VALID_ROLES,
    CLINICAL_PERMISSIONS,
    MEDICAL_ROLES,
    AccessDeniedError,
    ConnectedCareService,
)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


class AdminService:
    def __init__(self, care: ConnectedCareService):
        self.care = care

    # ---- guards & helpers -------------------------------------------------------------
    @staticmethod
    def require_admin(identity: Optional[SessionIdentity]) -> SessionIdentity:
        if identity is None:
            raise AccessDeniedError("AUTHENTICATION_REQUIRED", "Sign in to continue.")
        if identity.role != "ADMIN":
            raise AccessDeniedError("ADMIN_REQUIRED", "Only administrators can manage users and assignments.")
        if not identity.mfa_verified:
            raise AccessDeniedError("MFA_REQUIRED", "Administrator actions require multi-factor sign-in.")
        return identity

    def _audit(self, conn, admin: SessionIdentity, action: str, entity_type: str, entity_id: Optional[str], detail=None, patient_id=None):
        self.care._append_audit(
            conn,
            actor_subject=admin.subject,
            actor_role=admin.role,
            actor_org_id=admin.org_id,
            action=action,
            entity_type=entity_type,
            entity_id=entity_id,
            patient_id=patient_id,
            detail=detail or {},
        )

    def _user(self, conn, subject: str) -> Dict[str, Any]:
        row = conn.execute("SELECT * FROM users WHERE subject = ?", (subject,)).fetchone()
        if not row:
            raise KeyError(f"User '{subject}' not found.")
        return dict(row)

    @staticmethod
    def _guard_demo_scope(admin: SessionIdentity, user: Dict[str, Any]) -> None:
        """A demo administrator (one-click, no MFA) may manage only demo accounts, never real ones."""
        if admin.is_demo_account and not user.get("is_demo_account"):
            raise AccessDeniedError("DEMO_SCOPE", "The demo administrator can only manage demo accounts.")

    @staticmethod
    def _guard_demo_org(admin: SessionIdentity, org_id: str) -> None:
        if admin.is_demo_account and org_id != DEMO_ORG_ID:
            raise AccessDeniedError("DEMO_SCOPE", "The demo administrator can only use the demo organisation.")

    def _public_user(self, conn, user: Dict[str, Any]) -> Dict[str, Any]:
        org = conn.execute("SELECT name FROM organizations WHERE org_id = ?", (user["org_id"],)).fetchone()
        return {
            "subject": user["subject"],
            "username": user.get("username") or user["subject"],
            "display_name": user["display_name"],
            "email": user.get("email"),
            "role": user["role"],
            "org_id": user["org_id"],
            "org_name": org["name"] if org else None,
            "active": bool(user["active"]),
            "wards": json.loads(user.get("wards_json") or "[]"),
            "granted_permissions": json.loads(user.get("permissions_json") or "[]"),
            "effective_permissions": ConnectedCareService.effective_permissions(user),
            "qualification_title": user.get("qualification_title"),
            "license_number": user.get("license_number"),
            "qualification_verified_at": user.get("qualification_verified_at"),
            "qualification_verified_by": user.get("qualification_verified_by"),
            "mfa_enabled": bool(user.get("mfa_enabled")),
            "requires_mfa": AuthService(self.care).requires_mfa(user),
            "locked": bool(user.get("locked_until_utc") and user["locked_until_utc"] > _now()),
            "last_login_at_utc": user.get("last_login_at_utc"),
            "is_demo_account": bool(user.get("is_demo_account")),
        }

    # ---- users ------------------------------------------------------------------------------
    def list_users(self, admin: SessionIdentity) -> List[Dict[str, Any]]:
        with self.care._lock, self.care._connect() as conn:
            demo_only = "WHERE is_demo_account = 1 " if admin.is_demo_account else ""
            rows = conn.execute(f"SELECT * FROM users {demo_only}ORDER BY role, display_name").fetchall()
            return [self._public_user(conn, dict(r)) for r in rows]

    def create_user(
        self,
        admin: SessionIdentity,
        *,
        username: str,
        display_name: str,
        role: str,
        org_id: str,
        temporary_password: str,
        email: Optional[str] = None,
    ) -> Dict[str, Any]:
        username = (username or "").strip().lower()
        if not username or " " in username:
            raise ValueError("Choose a username without spaces.")
        if role not in ALL_VALID_ROLES:
            raise ValueError("Choose a valid role.")
        if not (display_name or "").strip():
            raise ValueError("Enter the person's name.")
        validate_new_password(temporary_password)
        self._guard_demo_org(admin, org_id)
        with self.care._lock, self.care._connect() as conn:
            if conn.execute("SELECT 1 FROM users WHERE subject = ? OR username = ?", (username, username)).fetchone():
                raise ValueError("That username is already taken.")
            if not conn.execute("SELECT 1 FROM organizations WHERE org_id = ?", (org_id,)).fetchone():
                raise ValueError("Choose a valid organisation.")
            conn.execute(
                """
                INSERT INTO users(user_id, subject, display_name, email, role, org_id, wards_json, active,
                                  created_at_utc, username, password_hash, password_changed_at_utc, permissions_json,
                                  is_demo_account)
                VALUES (?, ?, ?, ?, ?, ?, '[]', 1, ?, ?, ?, ?, '[]', ?)
                """,
                (
                    f"USR-{username}",
                    username,
                    display_name.strip(),
                    email,
                    role,
                    org_id,
                    _now(),
                    username,
                    hash_password(temporary_password, self.care.settings.password_hash_iterations),
                    _now(),
                    # Accounts made by the demo administrator are demo accounts: disabled with demo mode.
                    1 if admin.is_demo_account else 0,
                ),
            )
            self._audit(conn, admin, "USER_CREATED", "USER", username, {"role": role, "org_id": org_id})
            return self._public_user(conn, self._user(conn, username))

    def update_user(
        self,
        admin: SessionIdentity,
        subject: str,
        *,
        role: Optional[str] = None,
        org_id: Optional[str] = None,
        active: Optional[bool] = None,
        wards: Optional[List[str]] = None,
    ) -> Dict[str, Any]:
        with self.care._lock, self.care._connect() as conn:
            user = self._user(conn, subject)
            self._guard_demo_scope(admin, user)
            if subject == admin.subject and (role not in (None, "ADMIN") or active is False):
                raise ValueError("You can't remove your own administrator access.")
            changes: Dict[str, Any] = {}
            if role is not None and role != user["role"]:
                if role not in ALL_VALID_ROLES:
                    raise ValueError("Choose a valid role.")
                changes["role"] = role
                if role not in MEDICAL_ROLES:
                    # Clinical permissions never carry over to non-clinical roles.
                    changes["permissions_json"] = "[]"
            if org_id is not None and org_id != user["org_id"]:
                self._guard_demo_org(admin, org_id)
                if not conn.execute("SELECT 1 FROM organizations WHERE org_id = ?", (org_id,)).fetchone():
                    raise ValueError("Choose a valid organisation.")
                changes["org_id"] = org_id
            if active is not None and bool(active) != bool(user["active"]):
                changes["active"] = 1 if active else 0
            if wards is not None:
                # Inpatient ward membership (nursing module): only wards of the user's organisation.
                target_org = changes.get("org_id", user["org_id"])
                valid = {w["ward_code"] for w in self._wards(conn, target_org)}
                unknown = sorted(set(wards) - valid)
                if unknown:
                    raise ValueError(f"Not a ward of this organisation: {', '.join(unknown)}.")
                wards_json = json.dumps(sorted(set(wards)))
                if wards_json != json.dumps(sorted(set(json.loads(user.get("wards_json") or "[]")))):
                    changes["wards_json"] = wards_json
            if changes:
                conn.execute(
                    f"UPDATE users SET {', '.join(f'{k} = ?' for k in changes)} WHERE subject = ?",
                    (*changes.values(), subject),
                )
                if "role" in changes or "org_id" in changes or changes.get("active") == 0:
                    AuthService(self.care).revoke_all_sessions(conn, subject)
                self._audit(
                    conn,
                    admin,
                    "USER_UPDATED",
                    "USER",
                    subject,
                    {k: v for k, v in changes.items() if k != "permissions_json"},
                )
            return self._public_user(conn, self._user(conn, subject))

    def set_qualification(
        self, admin: SessionIdentity, subject: str, *, title: str, license_number: str, verified: bool
    ) -> Dict[str, Any]:
        with self.care._lock, self.care._connect() as conn:
            user = self._user(conn, subject)
            self._guard_demo_scope(admin, user)
            if user["role"] not in MEDICAL_ROLES:
                raise ValueError("Professional qualifications apply to medical staff accounts only.")
            if verified and (not (title or "").strip() or not (license_number or "").strip()):
                raise ValueError("Record the qualification and licence number before verifying.")
            conn.execute(
                """
                UPDATE users SET qualification_title = ?, license_number = ?,
                    qualification_verified_at = ?, qualification_verified_by = ?
                WHERE subject = ?
                """,
                (
                    (title or "").strip() or None,
                    (license_number or "").strip() or None,
                    _now() if verified else None,
                    admin.subject if verified else None,
                    subject,
                ),
            )
            AuthService(self.care).revoke_all_sessions(conn, subject)
            self._audit(conn, admin, "QUALIFICATION_UPDATED", "USER", subject, {"verified": verified})
            return self._public_user(conn, self._user(conn, subject))

    def set_permissions(self, admin: SessionIdentity, subject: str, permissions: List[str]) -> Dict[str, Any]:
        permissions = expand_permissions(permissions)
        with self.care._lock, self.care._connect() as conn:
            user = self._user(conn, subject)
            self._guard_demo_scope(admin, user)
            if permissions and user["role"] not in MEDICAL_ROLES:
                raise AccessDeniedError(
                    "CLINICAL_ROLE_REQUIRED", "Clinical permissions can only be given to medical staff accounts."
                )
            if permissions and not user.get("qualification_verified_at"):
                raise AccessDeniedError(
                    "QUALIFICATION_NOT_VERIFIED", "Verify the person's professional qualification first."
                )
            before = json.loads(user.get("permissions_json") or "[]")
            ordered = [p for p in CLINICAL_PERMISSIONS if p in permissions]
            conn.execute("UPDATE users SET permissions_json = ? WHERE subject = ?", (json.dumps(ordered), subject))
            if set(before) != set(ordered):
                AuthService(self.care).revoke_all_sessions(conn, subject)
            self._audit(conn, admin, "CLINICAL_PERMISSIONS_UPDATED", "USER", subject, {"before": before, "after": ordered})
            return self._public_user(conn, self._user(conn, subject))

    def reset_password(self, admin: SessionIdentity, subject: str, temporary_password: str) -> Dict[str, Any]:
        validate_new_password(temporary_password)
        with self.care._lock, self.care._connect() as conn:
            self._guard_demo_scope(admin, self._user(conn, subject))
            conn.execute(
                """
                UPDATE users SET password_hash = ?, password_changed_at_utc = ?, failed_login_count = 0,
                    locked_until_utc = NULL WHERE subject = ?
                """,
                (hash_password(temporary_password, self.care.settings.password_hash_iterations), _now(), subject),
            )
            AuthService(self.care).revoke_all_sessions(conn, subject)
            self._audit(conn, admin, "PASSWORD_RESET_BY_ADMIN", "USER", subject)
            return self._public_user(conn, self._user(conn, subject))

    # ---- organisations & care teams ----------------------------------------------------------
    def list_organisations(self, admin: Optional[SessionIdentity] = None) -> List[Dict[str, Any]]:
        demo_only = admin is not None and admin.is_demo_account
        with self.care._connect() as conn:
            rows = conn.execute(
                f"""
                SELECT o.*, (SELECT COUNT(*) FROM users u WHERE u.org_id = o.org_id AND u.active = 1) AS member_count
                FROM organizations o {"WHERE o.org_id = ?" if demo_only else ""} ORDER BY o.name
                """,
                (DEMO_ORG_ID,) if demo_only else (),
            ).fetchall()
            return [{**dict(r), "wards": self._wards(conn, r["org_id"])} for r in rows]

    @staticmethod
    def _wards(conn, org_id: str) -> List[Dict[str, Any]]:
        # The wards table belongs to the nursing module and may be absent in isolated tests.
        if not conn.execute("SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'wards'").fetchone():
            return []
        rows = conn.execute(
            "SELECT ward_code, name FROM wards WHERE org_id = ? AND active = 1 ORDER BY ward_code", (org_id,)
        ).fetchall()
        return [dict(r) for r in rows]

    def list_patients_for_assignment(self, admin: SessionIdentity) -> List[Dict[str, Any]]:
        """Minimum needed to assign care teams: reference, hospital number and organisation."""
        with self.care._lock, self.care._connect() as conn:
            rows = conn.execute(
                """
                SELECT p.patient_id, p.patient_code, p.hospital_number, p.org_id, o.name AS org_name,
                       (SELECT COUNT(*) FROM patient_care_team_members m WHERE m.patient_id = p.patient_id AND m.active = 1) AS team_size
                FROM patients p JOIN organizations o ON o.org_id = p.org_id
                WHERE p.record_status = 'ACTIVE' AND (? = 0 OR p.org_id = ?)
                ORDER BY p.created_at_utc DESC
                """,
                (1 if admin.is_demo_account else 0, DEMO_ORG_ID),
            ).fetchall()
            self._audit(conn, admin, "ADMIN_PATIENT_DIRECTORY_VIEWED", "PATIENT", None, {"count": len(rows)})
            return [dict(r) for r in rows]

    def care_team(self, patient_id: str) -> List[Dict[str, Any]]:
        with self.care._connect() as conn:
            rows = conn.execute(
                """
                SELECT m.*, u.display_name, u.role FROM patient_care_team_members m
                JOIN users u ON u.subject = m.user_subject
                WHERE m.patient_id = ? AND m.active = 1 ORDER BY u.display_name
                """,
                (patient_id,),
            ).fetchall()
            return [dict(r) for r in rows]

    def assign_care_team_member(
        self, admin: SessionIdentity, patient_id: str, user_subject: str, relationship_label: str
    ) -> List[Dict[str, Any]]:
        with self.care._lock, self.care._connect() as conn:
            patient = conn.execute("SELECT org_id FROM patients WHERE patient_id = ?", (patient_id,)).fetchone()
            if not patient:
                raise KeyError("Patient not found.")
            member = self._user(conn, user_subject)
            self._guard_demo_org(admin, patient["org_id"])
            self._guard_demo_scope(admin, member)
            if member["role"] not in MEDICAL_ROLES:
                raise ValueError("Only medical staff join a care team. Family caregivers get access through sharing.")
            conn.execute(
                """
                INSERT INTO patient_care_team_members(
                    membership_id, patient_id, user_subject, org_id, team_role, relationship_label,
                    assigned_by_subject, active, created_at_utc
                ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?) ON CONFLICT (membership_id) DO UPDATE SET org_id=EXCLUDED.org_id, team_role=EXCLUDED.team_role, relationship_label=EXCLUDED.relationship_label, assigned_by_subject=EXCLUDED.assigned_by_subject, active=EXCLUDED.active, created_at_utc=EXCLUDED.created_at_utc
                """,
                (
                    f"CTM-{patient_id}-{user_subject}",
                    patient_id,
                    user_subject,
                    member["org_id"],
                    member["role"],
                    (relationship_label or "").strip() or "Care team member",
                    admin.subject,
                    _now(),
                ),
            )
            self._audit(conn, admin, "CARE_TEAM_MEMBER_ASSIGNED", "PATIENT", patient_id, {"member": user_subject}, patient_id)
        return self.care_team(patient_id)

    def remove_care_team_member(self, admin: SessionIdentity, patient_id: str, user_subject: str) -> List[Dict[str, Any]]:
        with self.care._lock, self.care._connect() as conn:
            if admin.is_demo_account:
                patient = conn.execute("SELECT org_id FROM patients WHERE patient_id = ?", (patient_id,)).fetchone()
                if not patient:
                    raise KeyError("Patient not found.")
                self._guard_demo_org(admin, patient["org_id"])
            conn.execute(
                "UPDATE patient_care_team_members SET active = 0 WHERE patient_id = ? AND user_subject = ?",
                (patient_id, user_subject),
            )
            self._audit(conn, admin, "CARE_TEAM_MEMBER_REMOVED", "PATIENT", patient_id, {"member": user_subject}, patient_id)
        return self.care_team(patient_id)

    # ---- audit & settings ----------------------------------------------------------------------
    def audit_log(
        self, admin: SessionIdentity, *, limit: int = 100, actor: Optional[str] = None, outcome: Optional[str] = None
    ) -> List[Dict[str, Any]]:
        clauses, args = [], []
        if admin.is_demo_account:
            clauses.append("actor_org_id = ?")
            args.append(DEMO_ORG_ID)
        if actor:
            clauses.append("actor_subject = ?")
            args.append(actor)
        if outcome:
            clauses.append("outcome = ?")
            args.append(outcome)
        where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        with self.care._lock, self.care._connect() as conn:
            rows = conn.execute(
                f"SELECT * FROM audit_events {where} ORDER BY sequence_id DESC LIMIT ?", (*args, max(1, min(limit, 500)))
            ).fetchall()
            events = []
            for row in rows:
                event = dict(row)
                # Administrative monitoring exposes event metadata, never clinical
                # payloads (notes, measurements, diagnoses or correction evidence).
                if event["entity_type"] not in {"AUTH", "USER", "ORGANIZATION"}:
                    event["detail_json"] = json.dumps({"clinical_detail_redacted": True})
                events.append(event)
            return events

    def security_summary(self) -> Dict[str, Any]:
        s = self.care.settings
        return {
            "demo_mode": s.demo_mode,
            "identifier_keys_configured": self.care.protector.using_configured_keys,
            "session_idle_minutes": s.session_idle_ttl_seconds // 60,
            "session_absolute_hours": s.session_absolute_ttl_seconds // 3600,
            "max_failed_logins": s.max_failed_logins,
            "mfa_policy": "Required for administrators and for clinicians who can sign off, diagnose or prescribe.",
            "password_hashing": f"PBKDF2-SHA256, {s.password_hash_iterations:,} iterations",
            "identifier_protection": "Citizen IDs: AES-256-GCM at rest, HMAC-SHA256 blind index for exact match.",
        }
