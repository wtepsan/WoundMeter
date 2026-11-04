from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Header
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from app.api import connected_care
from app.services.auth_service import AuthError, AuthService
from app.services.demo_accounts import DEMO_LOGIN_ACCOUNTS

router = APIRouter(prefix="/v2/auth", tags=["auth"])


def _json(body, status_code: int = 200) -> JSONResponse:
    return JSONResponse(status_code=status_code, content=body, headers={"Cache-Control": "no-store"})


def _auth() -> AuthService:
    # Resolved at call time so tests can swap the care service.
    return AuthService(connected_care.care_service)


def _auth_error(exc: AuthError) -> JSONResponse:
    return _json({"code": exc.code, "message": exc.message}, exc.status_code)


class LoginRequest(BaseModel):
    username: str
    password: str


class MfaRequest(BaseModel):
    challenge: str
    code: str


class ChangePasswordRequest(BaseModel):
    current_password: str
    new_password: str


class ForgotPasswordRequest(BaseModel):
    username: str


@router.post("/login")
async def login(body: LoginRequest):
    try:
        return _json(_auth().login(body.username, body.password))
    except AuthError as exc:
        return _auth_error(exc)


@router.post("/mfa")
async def verify_mfa(body: MfaRequest):
    try:
        return _json(_auth().verify_mfa(body.challenge, body.code))
    except AuthError as exc:
        return _auth_error(exc)


@router.get("/me")
async def me(x_reviewer_token: Optional[str] = Header(default=None)):
    identity = _auth().resolve(x_reviewer_token)
    if identity is None:
        return _json({"code": "AUTHENTICATION_REQUIRED", "message": "Sign in to continue."}, 401)
    return _json({"account": identity.public()})


@router.post("/logout")
async def logout(x_reviewer_token: Optional[str] = Header(default=None)):
    _auth().logout(x_reviewer_token)
    return _json({"status": "signed_out"})


@router.post("/change-password")
async def change_password(body: ChangePasswordRequest, x_reviewer_token: Optional[str] = Header(default=None)):
    auth = _auth()
    identity = auth.resolve(x_reviewer_token)
    if identity is None:
        return _json({"code": "AUTHENTICATION_REQUIRED", "message": "Sign in to continue."}, 401)
    try:
        auth.change_password(identity, body.current_password, body.new_password, x_reviewer_token or "")
        return _json({"status": "password_changed"})
    except AuthError as exc:
        return _auth_error(exc)


@router.post("/forgot-password")
async def forgot_password(body: ForgotPasswordRequest):
    _auth().request_password_reset(body.username)
    # Same answer whether or not the account exists.
    return _json(
        {
            "status": "recorded",
            "message": "If this account exists, an administrator has been asked to reset the password. "
            "Contact your administrator to receive a new temporary password.",
        }
    )


class DemoLoginRequest(BaseModel):
    username: str


def _demo_disabled() -> JSONResponse:
    return _json({"code": "NOT_AVAILABLE", "demo_mode": False, "message": "Demo sign-in is disabled."}, 404)


@router.get("/demo/accounts")
async def demo_accounts():
    """Demo mode only: the designated demo accounts available for one-click sign-in."""
    care = connected_care.care_service
    if not care.settings.demo_mode:
        return _demo_disabled()
    with care._connect() as conn:
        rows = conn.execute(
            "SELECT subject, display_name, role FROM users WHERE is_demo_account = 1 AND active = 1"
        ).fetchall()
    present = {r["subject"]: dict(r) for r in rows}
    accounts = [
        {
            "username": sub,
            "display_name": present[sub]["display_name"],
            "role": present[sub]["role"],
            "summary": spec["summary"],
        }
        for sub, spec in DEMO_LOGIN_ACCOUNTS.items()
        if sub in present
    ]
    return _json({"demo_mode": True, "accounts": accounts})


@router.post("/demo/login")
async def demo_login(body: DemoLoginRequest):
    if not connected_care.care_service.settings.demo_mode:
        return _demo_disabled()
    try:
        return _json(_auth().demo_login(body.username))
    except AuthError as exc:
        return _auth_error(exc)
