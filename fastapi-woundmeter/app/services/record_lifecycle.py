"""Recoverable record deletion. Signed payloads and their workflow states never change."""
from datetime import datetime, timezone
from uuid import uuid4
import json

from app.services.admin_service import AdminService
from app.services.connected_care_db import AccessDeniedError, ClinicalConflictError


class RecordLifecycleService:
    TARGETS = {"observation": ("wound_observations", "observation_id", "review_state"),
               "report": ("clinical_reports", "report_id", "status"),
               "wound": ("wounds", "wound_id", "status")}

    def __init__(self, care, nursing=None):
        self.care = care
        self.nursing = nursing

    @staticmethod
    def _reason(value):
        if not isinstance(value, str) or not value.strip() or len(value.strip()) > 1000:
            raise ValueError("A reason of 1–1000 characters is required.")
        return value.strip()

    def _target(self, conn, kind, record_id):
        if kind not in self.TARGETS:
            raise ValueError("Unsupported record type.")
        table, key, status = self.TARGETS[kind]
        row = conn.execute(f"SELECT * FROM {table} WHERE {key} = ?", (record_id,)).fetchone()
        if not row:
            raise KeyError("Record not found.")
        return dict(row), status

    def _clinical(self, conn, actor, target):
        user, _ = self.care.authorize_patient_access(
            conn, actor, target["patient_id"], wound_id=target["wound_id"], require_clinical_role=True,
            require_signoff_qualification=True, clinical_permission="ASSESS", include_deleted_wound=True)
        if "anatomical_site" in target:
            for report in conn.execute("SELECT * FROM clinical_reports WHERE wound_id = ? AND includes_nursing = 1", (target["wound_id"],)):
                self._clinical(conn, actor, dict(report))
        if target.get("includes_nursing"):
            # Use the nursing module's existing guards against the same transaction.
            nursing = self.nursing
            if nursing is None:
                raise AccessDeniedError("NURSING_ROLE_REQUIRED", "Nursing authorisation is required for this report.")
            nursing._nursing_actor(conn, actor, "RECORD_LIFECYCLE")
            evidence = json.loads(target["evidence_json"])
            for admission in evidence.get("inpatient_nursing", {}).get("admissions", []):
                nursing._require_ward(conn, user, admission["ward_code"], "RECORD_LIFECYCLE", target["patient_id"])
        return user

    def _audit(self, conn, user, action, deletion, **detail):
        self.care._append_audit(conn, actor_subject=user["subject"], actor_role=user["role"],
            actor_org_id=user["org_id"], action=action, entity_type="RECORD_DELETION",
            entity_id=deletion["deletion_id"], patient_id=deletion["patient_id"], wound_id=deletion["wound_id"],
            detail={"record_type": deletion["record_type"], "record_id": deletion["record_id"],
                    "previous_status": deletion["previous_status"], **detail})

    def delete(self, *, actor_subject, record_type, record_id, reason, expected_status):
        reason = self._reason(reason)
        with self.care._lock, self.care._connect() as conn:
            conn.execute("SELECT pg_advisory_xact_lock(4456001)")
            target, status_key = self._target(conn, record_type, record_id)
            user = self._clinical(conn, actor_subject, target)
            self.care.require_permission(conn, user, "DELETE_RECORD", patient_id=target["patient_id"], wound_id=target["wound_id"])
            existing = conn.execute("""SELECT * FROM record_deletions WHERE record_type = ? AND record_id = ?
                                       AND restored_at_utc IS NULL""", (record_type, record_id)).fetchone()
            if existing:
                return dict(existing)  # Lost-response retry: retain the original actor/reason.
            if target[status_key] != expected_status:
                raise ClinicalConflictError("The record status changed. Reload and confirm deletion again.")
            signed = bool(target.get("final_approved_measurement_id") or target.get("signed_at_utc"))
            if record_type == "observation":
                signed = signed or bool(conn.execute("SELECT 1 FROM clinical_assessments WHERE observation_id = ?",
                                                     (record_id,)).fetchone())
            if record_type == "wound":
                signed = any(conn.execute(query, (record_id,)).fetchone() for query in (
                    "SELECT 1 FROM clinical_assessments WHERE wound_id = ?",
                    "SELECT 1 FROM wound_observations WHERE wound_id = ? AND final_approved_measurement_id IS NOT NULL",
                    "SELECT 1 FROM clinical_reports WHERE wound_id = ? AND (status = 'SIGNED' OR signed_at_utc IS NOT NULL)"))
            signed = signed or target[status_key] in {"SIGNED", "CLINICIAN_APPROVED"}
            deletion = dict(deletion_id=f"DEL-{uuid4().hex}", record_type=record_type, record_id=record_id,
                patient_id=target["patient_id"], wound_id=target["wound_id"], previous_status=target[status_key],
                disposition="VOIDED" if signed else "DELETED", deleted_by_subject=actor_subject,
                deleted_at_utc=datetime.now(timezone.utc).isoformat(), deletion_reason=reason)
            keys = list(deletion)
            conn.execute(f"INSERT INTO record_deletions ({','.join(keys)}) VALUES ({','.join('?' for _ in keys)})",
                         tuple(deletion.values()))
            self._audit(conn, user, f"CLINICAL_RECORD_{deletion['disposition']}", deletion, reason=reason)
            return deletion

    def _deletion(self, conn, deletion_id):
        row = conn.execute("SELECT * FROM record_deletions WHERE deletion_id = ?", (deletion_id,)).fetchone()
        if not row:
            raise KeyError("Deleted record not found.")
        return dict(row)

    def _admin(self, conn, identity, deletion=None):
        AdminService.require_admin(identity)
        user = self.care.get_user_record(conn, identity.subject)
        if user["role"] != "ADMIN" or not user["active"]:
            raise AccessDeniedError("ADMIN_REQUIRED", "An active administrator is required.")
        if deletion:
            org = conn.execute("SELECT org_id FROM patients WHERE patient_id = ?", (deletion["patient_id"],)).fetchone()
            if not org or org["org_id"] != user["org_id"]:
                self.care._append_audit(conn, actor_subject=user["subject"], actor_role=user["role"],
                    actor_org_id=user["org_id"], action="DENIED_RECORD_RESTORE", entity_type="RECORD_DELETION",
                    entity_id=deletion["deletion_id"], outcome="DENIED")
                raise AccessDeniedError("ORGANISATION_ACCESS_DENIED", "This record belongs to another organisation.")
        return user

    def list_deleted(self, *, actor_subject=None, patient_id=None, admin=None):
        with self.care._lock, self.care._connect() as conn:
            if admin:
                user = self._admin(conn, admin)
                scope, args = "p.org_id = ?", (user["org_id"],)
            else:
                user, patient = self.care.authorize_patient_access(conn, actor_subject, patient_id,
                    require_clinical_role=True, require_signoff_qualification=True, clinical_permission="ASSESS")
                scope, args = "d.patient_id = ?", (patient["patient_id"],)
            rows = conn.execute(f"""SELECT d.*, p.patient_code, w.wound_code FROM record_deletions d
                JOIN patients p ON p.patient_id = d.patient_id JOIN wounds w ON w.wound_id = d.wound_id
                WHERE d.restored_at_utc IS NULL AND {scope} ORDER BY d.deleted_at_utc DESC""", args).fetchall()
            # Metadata only: administrators never receive signed clinical content or images.
            visible = []
            for row in rows:
                if not admin:
                    target, _ = self._target(conn, row["record_type"], row["record_id"])
                    try:
                        self._clinical(conn, actor_subject, target)
                    except AccessDeniedError:
                        continue
                visible.append(dict(row))
            self.care._append_audit(conn, actor_subject=user["subject"], actor_role=user["role"],
                actor_org_id=user["org_id"], action="DELETED_RECORDS_VIEWED", entity_type="RECORD_DELETION",
                patient_id=args[0] if not admin else None, detail={"count": len(visible)})
            return visible

    def authorize_restore(self, *, actor_subject, deletion_id, reason):
        reason = self._reason(reason)
        with self.care._lock, self.care._connect() as conn:
            conn.execute("SELECT pg_advisory_xact_lock(4456001)")
            deletion = self._deletion(conn, deletion_id)
            target, _ = self._target(conn, deletion["record_type"], deletion["record_id"])
            user = self._clinical(conn, actor_subject, target)
            self.care.require_permission(conn, user, "AUTHORIZE_RESTORE", patient_id=target["patient_id"], wound_id=target["wound_id"])
            if deletion["restored_at_utc"]:
                raise ClinicalConflictError("This deletion was already restored.")
            conn.execute("""UPDATE record_deletions SET restore_authorized_by = ?, restore_authorized_at_utc = ?,
                            restore_authorization_reason = ? WHERE deletion_id = ?""",
                         (actor_subject, datetime.now(timezone.utc).isoformat(), reason, deletion_id))
            self._audit(conn, user, "CLINICAL_RESTORATION_AUTHORIZED", deletion, reason=reason)
            return self._deletion(conn, deletion_id)

    def restore(self, *, admin, deletion_id, reason):
        reason = self._reason(reason)
        with self.care._lock, self.care._connect() as conn:
            conn.execute("SELECT pg_advisory_xact_lock(4456001)")
            deletion = self._deletion(conn, deletion_id)
            user = self._admin(conn, admin, deletion)
            if deletion["restored_at_utc"]:
                return deletion
            target, _ = self._target(conn, deletion["record_type"], deletion["record_id"])
            if deletion["disposition"] == "VOIDED":
                if not deletion["restore_authorized_by"]:
                    raise ClinicalConflictError("A qualified sign-off clinician must authorise restoration of this signed record first.")
                # Recheck current qualification, permissions and patient/ward scope, including revoked access.
                authorizer = self._clinical(conn, deletion["restore_authorized_by"], target)
                self.care.require_permission(conn, authorizer, "AUTHORIZE_RESTORE", patient_id=target["patient_id"], wound_id=target["wound_id"])
            conn.execute("""UPDATE record_deletions SET restored_by_subject = ?, restored_at_utc = ?,
                            restoration_reason = ? WHERE deletion_id = ?""",
                         (user["subject"], datetime.now(timezone.utc).isoformat(), reason, deletion_id))
            if deletion["record_type"] in {"report", "observation"}:
                self.care.require_active_record(conn, deletion["record_type"], deletion["record_id"])
            self._audit(conn, user, "CLINICAL_RECORD_RESTORED", deletion, reason=reason,
                        clinical_authorizer=deletion["restore_authorized_by"])
            return self._deletion(conn, deletion_id)
