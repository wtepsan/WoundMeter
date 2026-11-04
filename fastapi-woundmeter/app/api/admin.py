from __future__ import annotations

from typing import List, Optional

from fastapi import APIRouter, Header, Query
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from app.api import connected_care
from app.services.admin_service import AdminService
from app.services.permission_policy import catalogue
from app.services.database_storage import DatabaseStorageError
from app.services.auth_service import AuthError, AuthService
from app.services.connected_care_db import AccessDeniedError, ClinicalConflictError

router = APIRouter(prefix="/v2/admin", tags=["admin"])


def _json(body, status_code: int = 200) -> JSONResponse:
    return JSONResponse(status_code=status_code, content=body, headers={"Cache-Control": "no-store"})


def _run(token: Optional[str], action):
    care = connected_care.care_service
    try:
        admin = AdminService.require_admin(AuthService(care).resolve(token))
        return _json(action(AdminService(care), admin))
    except DatabaseStorageError:
        return _json({"code": "DATABASE_UNAVAILABLE", "message": "Database storage inspection failed; check backend logs and RESULTS_DIR."}, 503)
    except AccessDeniedError as exc:
        status = 401 if exc.code == "AUTHENTICATION_REQUIRED" else 403
        return _json({"code": exc.code, "message": exc.message}, status)
    except AuthError as exc:
        return _json({"code": exc.code, "message": exc.message}, exc.status_code)
    except KeyError as exc:
        return _json({"code": "NOT_FOUND", "message": str(exc).strip("'\"")}, 404)
    except ClinicalConflictError as exc:
        return _json({"code": "CLINICAL_CONFLICT", "message": str(exc)}, 409)
    except ValueError as exc:
        return _json({"code": "VALIDATION_ERROR", "message": str(exc)}, 422)


class CreateUserRequest(BaseModel):
    username: str
    display_name: str
    role: str
    org_id: str
    temporary_password: str
    email: Optional[str] = None


class UpdateUserRequest(BaseModel):
    role: Optional[str] = None
    org_id: Optional[str] = None
    active: Optional[bool] = None
    wards: Optional[List[str]] = None


class QualificationRequest(BaseModel):
    title: str = ""
    license_number: str = ""
    verified: bool = False


class PermissionsRequest(BaseModel):
    permissions: List[str]


class PasswordResetRequest(BaseModel):
    temporary_password: str


class RestoreRecordRequest(BaseModel):
    reason: str


@router.get("/deleted-records")
async def deleted_records(x_reviewer_token: Optional[str] = Header(default=None)):
    return _run(x_reviewer_token, lambda svc, admin: {
        "records": connected_care.record_lifecycle_service().list_deleted(admin=admin)})


@router.post("/deleted-records/{deletion_id}/restore")
async def restore_record(deletion_id: str, body: RestoreRecordRequest,
                         x_reviewer_token: Optional[str] = Header(default=None)):
    return _run(x_reviewer_token, lambda svc, admin: connected_care.record_lifecycle_service().restore(
        admin=admin, deletion_id=deletion_id, reason=body.reason))


class CareTeamRequest(BaseModel):
    user_subject: str
    relationship_label: str = "Care team member"


@router.get("/users")
async def list_users(x_reviewer_token: Optional[str] = Header(default=None)):
    return _run(x_reviewer_token, lambda svc, admin: {"users": svc.list_users(admin)})


@router.post("/users")
async def create_user(body: CreateUserRequest, x_reviewer_token: Optional[str] = Header(default=None)):
    return _run(x_reviewer_token, lambda svc, admin: svc.create_user(admin, **body.model_dump()))


@router.post("/users/{subject}")
async def update_user(subject: str, body: UpdateUserRequest, x_reviewer_token: Optional[str] = Header(default=None)):
    return _run(x_reviewer_token, lambda svc, admin: svc.update_user(admin, subject, **body.model_dump()))


@router.post("/users/{subject}/qualification")
async def set_qualification(subject: str, body: QualificationRequest, x_reviewer_token: Optional[str] = Header(default=None)):
    return _run(x_reviewer_token, lambda svc, admin: svc.set_qualification(admin, subject, **body.model_dump()))


@router.post("/users/{subject}/permissions")
async def set_permissions(subject: str, body: PermissionsRequest, x_reviewer_token: Optional[str] = Header(default=None)):
    return _run(x_reviewer_token, lambda svc, admin: svc.set_permissions(admin, subject, body.permissions))


@router.post("/users/{subject}/reset-password")
async def reset_password(subject: str, body: PasswordResetRequest, x_reviewer_token: Optional[str] = Header(default=None)):
    return _run(x_reviewer_token, lambda svc, admin: svc.reset_password(admin, subject, body.temporary_password))


@router.get("/organisations")
async def list_organisations(x_reviewer_token: Optional[str] = Header(default=None)):
    return _run(x_reviewer_token, lambda svc, admin: {"organisations": svc.list_organisations(admin)})


@router.get("/patients")
async def list_patients(x_reviewer_token: Optional[str] = Header(default=None)):
    return _run(x_reviewer_token, lambda svc, admin: {"patients": svc.list_patients_for_assignment(admin)})


@router.get("/patients/{patient_id}/care-team")
async def get_care_team(patient_id: str, x_reviewer_token: Optional[str] = Header(default=None)):
    return _run(x_reviewer_token, lambda svc, admin: {"members": svc.care_team(patient_id)})


@router.post("/patients/{patient_id}/care-team")
async def assign_care_team(patient_id: str, body: CareTeamRequest, x_reviewer_token: Optional[str] = Header(default=None)):
    return _run(
        x_reviewer_token,
        lambda svc, admin: {
            "members": svc.assign_care_team_member(admin, patient_id, body.user_subject, body.relationship_label)
        },
    )


@router.post("/patients/{patient_id}/care-team/{user_subject}/remove")
async def remove_care_team(patient_id: str, user_subject: str, x_reviewer_token: Optional[str] = Header(default=None)):
    return _run(
        x_reviewer_token, lambda svc, admin: {"members": svc.remove_care_team_member(admin, patient_id, user_subject)}
    )


@router.get("/audit")
async def audit_log(
    limit: int = Query(default=100),
    actor: Optional[str] = Query(default=None),
    outcome: Optional[str] = Query(default=None),
    x_reviewer_token: Optional[str] = Header(default=None),
):
    return _run(
        x_reviewer_token,
        lambda svc, admin: {"events": svc.audit_log(admin, limit=limit, actor=actor, outcome=outcome)},
    )


@router.get("/settings")
async def security_settings(x_reviewer_token: Optional[str] = Header(default=None)):
    return _run(x_reviewer_token, lambda svc, admin: svc.security_summary())


@router.get("/permission-policy")
async def permission_policy(x_reviewer_token: Optional[str] = Header(default=None)):
    return _run(x_reviewer_token, lambda svc, admin: catalogue())


@router.get("/storage")
async def storage_diagnostics(x_reviewer_token: Optional[str] = Header(default=None)):
    from app.services.database_storage import inspect_storage
    return _run(x_reviewer_token, lambda svc, admin: inspect_storage(svc.care.root))
