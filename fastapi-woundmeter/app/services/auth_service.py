"""
Authentication: password login, TOTP multi-factor authentication for privileged accounts,
and server-side sessions that can be revoked (logout, password reset, deactivation).

Only a SHA-256 hash of each session token is stored, so a database copy cannot be used to
impersonate a signed-in user.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import secrets
import struct
import time
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import TYPE_CHECKING, Any, Dict, List, Optional
from urllib.parse import quote
from app.services.permission_policy import catalogue
from app.services.demo_accounts import is_designated_demo_account

if TYPE_CHECKING:
    from app.services.connected_care_db import ConnectedCareService

MIN_PASSWORD_LENGTH = 10
MFA_CHALLENGE_TTL_SECONDS = 300
MAX_MFA_ATTEMPTS = 5
LOCKOUT_MINUTES = 15
TOTP_STEP_SECONDS = 30


class AuthError(Exception):
    def __init__(self, code: str, message: str, status_code: int = 401):
        super().__init__(message)
        self.code = code
        self.message = message
        self.status_code = status_code


# ---- Passwords -----------------------------------------------------------------------

def hash_password(password: str, iterations: int) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, iterations)
    return f"pbkdf2_sha256${iterations}${base64.b64encode(salt).decode()}${base64.b64encode(digest).decode()}"


def verify_password(password: str, stored: Optional[str]) -> bool:
    if not stored:
        return False
    try:
        scheme, iterations, salt_b64, digest_b64 = stored.split("$")
        if scheme != "pbkdf2_sha256":
            return False
        digest = hashlib.pbkdf2_hmac(
            "sha256", password.encode("utf-8"), base64.b64decode(salt_b64), int(iterations)
        )
        return hmac.compare_digest(digest, base64.b64decode(digest_b64))
    except (ValueError, TypeError):
        return False


def validate_new_password(password: str) -> None:
    if len(password or "") < MIN_PASSWORD_LENGTH:
        raise AuthError(
            "WEAK_PASSWORD", f"Use a password of at least {MIN_PASSWORD_LENGTH} characters.", status_code=422
        )


# ---- TOTP (RFC 6238) ------------------------------------------------------------------

def new_totp_secret() -> str:
    return base64.b32encode(secrets.token_bytes(20)).decode("ascii").rstrip("=")


def totp_code(secret: str, step: int) -> str:
    key = base64.b32decode(secret + "=" * (-len(secret) % 8))
    digest = hmac.new(key, struct.pack(">Q", step), hashlib.sha1).digest()
    offset = digest[-1] & 0x0F
    value = struct.unpack(">I", digest[offset : offset + 4])[0] & 0x7FFFFFFF
    return f"{value % 1_000_000:06d}"


def current_totp_step(now: Optional[float] = None) -> int:
    return int((now if now is not None else time.time()) // TOTP_STEP_SECONDS)


def _hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _now() -> datetime:
    return datetime.now(timezone.utc)


@dataclass
class SessionIdentity:
    subject: str
    display_name: str
    role: str
    org_id: str
    wards: List[str]
    permissions: List[str]
    qualification_verified: bool
    mfa_verified: bool
    is_demo_account: bool
    extra: Dict[str, Any] = field(default_factory=dict)

    def has_permission(self, permission: str) -> bool:
        return permission in self.permissions

    def public(self) -> Dict[str, Any]:
        return {
            "subject": self.subject,
            "display_name": self.display_name,
            "role": self.role,
            "org_id": self.org_id,
            "wards": self.wards,
            "permissions": self.permissions,
            "permission_policy": catalogue(),
            "qualification_verified": self.qualification_verified,
            "mfa_verified": self.mfa_verified,
            "is_demo_account": self.is_demo_account,
            "can_confirm_clinical": "SIGN_OFF" in self.permissions,
            **self.extra,
        }


class AuthService:
    def __init__(self, care: "ConnectedCareService"):
        self.care = care
        self.settings = care.settings

    # ---- helpers ------------------------------------------------------------------
    def requires_mfa(self, user: Dict[str, Any]) -> bool:
        perms = set(json.loads(user.get("permissions_json") or "[]"))
        return user["role"] == "ADMIN" or bool(perms & {"SIGN_OFF", "DIAGNOSE", "PRESCRIBE"})

    def _identity(self, user: Dict[str, Any], mfa_verified: bool) -> SessionIdentity:
        org = self.care.organisation_name(user["org_id"])
        return SessionIdentity(
            subject=user["subject"],
            display_name=user["display_name"],
            role=user["role"],
            org_id=user["org_id"],
            wards=json.loads(user.get("wards_json") or "[]"),
            permissions=self.care.effective_permissions(user),
            qualification_verified=bool(user.get("qualification_verified_at")),
            mfa_verified=mfa_verified,
            is_demo_account=bool(user.get("is_demo_account")),
            extra={
                "username": user.get("username") or user["subject"],
                "org_name": org,
                "qualification_title": user.get("qualification_title"),
                "mfa_enabled": bool(user.get("mfa_enabled")),
            },
        )

    def _find_user(self, conn, username: str) -> Optional[Dict[str, Any]]:
        key = (username or "").strip().lower()
        row = conn.execute(
            "SELECT * FROM users WHERE lower(username) = ? OR lower(subject) = ? OR lower(email) = ?",
            (key, key, key),
        ).fetchone()
        return dict(row) if row else None

    def _audit(self, conn, user: Optional[Dict[str, Any]], action: str, outcome: str = "SUCCESS", detail=None):
        self.care._append_audit(
            conn,
            actor_subject=user["subject"] if user else "anonymous",
            actor_role=user["role"] if user else "UNAUTHENTICATED",
            actor_org_id=user["org_id"] if user else "NONE",
            action=action,
            entity_type="AUTH",
            entity_id=user["subject"] if user else None,
            outcome=outcome,
            detail=detail or {},
        )

    def _create_session(self, conn, subject: str, state: str, mfa_verified: bool) -> str:
        token = secrets.token_urlsafe(32)
        now = _now()
        ttl = MFA_CHALLENGE_TTL_SECONDS if state == "PENDING_MFA" else self.settings.session_absolute_ttl_seconds
        conn.execute(
            """
            INSERT INTO auth_sessions(session_hash, user_subject, state, mfa_verified, mfa_attempts,
                                      created_at_utc, expires_at_utc, last_seen_at_utc)
            VALUES (?, ?, ?, ?, 0, ?, ?, ?)
            """,
            (
                _hash_token(token),
                subject,
                state,
                1 if mfa_verified else 0,
                now.isoformat(),
                (now + timedelta(seconds=ttl)).isoformat(),
                now.isoformat(),
            ),
        )
        return token

    # ---- login flow --------------------------------------------------------------------
    def login(self, username: str, password: str) -> Dict[str, Any]:
        generic = AuthError("INVALID_CREDENTIALS", "Incorrect username or password, or the account is locked.")
        with self.care._lock, self.care._connect() as conn:
            user = self._find_user(conn, username)
            # Fictional demo accounts (public demo password) only work while demo mode is on.
            if user and user.get("is_demo_account") and not self.settings.demo_mode:
                user = None
            if not user or not user["active"]:
                # Spend comparable time so response timing doesn't reveal which usernames exist.
                verify_password(password, hash_password("timing-equaliser", 1000))
                self._audit(conn, None, "LOGIN_FAILED", "DENIED", {"reason": "unknown_or_inactive"})
                raise generic
            locked_until = user.get("locked_until_utc")
            if locked_until and locked_until > _now().isoformat():
                self._audit(conn, user, "LOGIN_BLOCKED_LOCKED", "DENIED")
                raise generic
            if not verify_password(password, user.get("password_hash")):
                failures = int(user.get("failed_login_count") or 0) + 1
                lock = (
                    (_now() + timedelta(minutes=LOCKOUT_MINUTES)).isoformat()
                    if failures >= self.settings.max_failed_logins
                    else None
                )
                conn.execute(
                    "UPDATE users SET failed_login_count = ?, locked_until_utc = ? WHERE subject = ?",
                    (0 if lock else failures, lock, user["subject"]),
                )
                self._audit(conn, user, "LOGIN_FAILED", "DENIED", {"locked": bool(lock)})
                raise generic

            conn.execute(
                "UPDATE users SET failed_login_count = 0, locked_until_utc = NULL WHERE subject = ?",
                (user["subject"],),
            )
            if self.requires_mfa(user):
                challenge = self._create_session(conn, user["subject"], "PENDING_MFA", False)
                enrollment = None
                if not user.get("mfa_enabled"):
                    secret = new_totp_secret()
                    conn.execute(
                        "UPDATE users SET mfa_secret_ciphertext = ? WHERE subject = ?",
                        (self.care.protector.encrypt(secret), user["subject"]),
                    )
                    issuer = "WoundMeter"
                    enrollment = {
                        "secret": secret,
                        "otpauth_uri": f"otpauth://totp/{issuer}:{quote(user['subject'])}?secret={secret}&issuer={issuer}",
                    }
                self._audit(conn, user, "LOGIN_PASSWORD_OK_MFA_PENDING")
                return {"status": "mfa_required", "challenge": challenge, "mfa_enrollment": enrollment}

            token = self._create_session(conn, user["subject"], "ACTIVE", False)
            conn.execute("UPDATE users SET last_login_at_utc = ? WHERE subject = ?", (_now().isoformat(), user["subject"]))
            self._audit(conn, user, "LOGIN_SUCCESS")
            return {"status": "authenticated", "token": token, "account": self._identity(user, False).public()}

    def _pending_challenge(self, conn, challenge: str) -> Dict[str, Any]:
        row = conn.execute(
            "SELECT * FROM auth_sessions WHERE session_hash = ? AND state = 'PENDING_MFA'", (_hash_token(challenge),)
        ).fetchone()
        if not row or row["revoked_at_utc"] or row["expires_at_utc"] < _now().isoformat():
            raise AuthError("MFA_CHALLENGE_EXPIRED", "The sign-in attempt expired. Please sign in again.")
        return dict(row)

    def verify_mfa(self, challenge: str, code: str) -> Dict[str, Any]:
        with self.care._lock, self.care._connect() as conn:
            pending = self._pending_challenge(conn, challenge)
            user = dict(conn.execute("SELECT * FROM users WHERE subject = ?", (pending["user_subject"],)).fetchone())
            secret = self.care.protector.decrypt(user.get("mfa_secret_ciphertext"))
            step_now = current_totp_step()
            matched_step = None
            for step in (step_now - 1, step_now, step_now + 1):
                if secret and hmac.compare_digest(totp_code(secret, step), (code or "").strip()):
                    matched_step = step
            last_step = user.get("mfa_last_step")
            # Replay protection: a code can't be reused.
            replayed = last_step is not None and matched_step is not None and matched_step <= int(last_step)
            if matched_step is None or replayed:
                attempts = int(pending["mfa_attempts"]) + 1
                revoked = _now().isoformat() if attempts >= MAX_MFA_ATTEMPTS else None
                conn.execute(
                    "UPDATE auth_sessions SET mfa_attempts = ?, revoked_at_utc = ? WHERE session_hash = ?",
                    (attempts, revoked, pending["session_hash"]),
                )
                self._audit(conn, user, "MFA_FAILED", "DENIED", {"attempts": attempts})
                raise AuthError("INVALID_MFA_CODE", "That code didn't match. Check your authenticator app and try again.")

            conn.execute(
                "UPDATE auth_sessions SET revoked_at_utc = ? WHERE session_hash = ?",
                (_now().isoformat(), pending["session_hash"]),
            )
            conn.execute(
                "UPDATE users SET mfa_enabled = 1, mfa_last_step = ?, last_login_at_utc = ? WHERE subject = ?",
                (matched_step, _now().isoformat(), user["subject"]),
            )
            token = self._create_session(conn, user["subject"], "ACTIVE", True)
            self._audit(conn, user, "LOGIN_SUCCESS", detail={"mfa": True})
            return {"status": "authenticated", "token": token, "account": self._identity(user, True).public()}

    def demo_login(self, username: str) -> Dict[str, Any]:
        """Demo mode only: one-click sign-in for a designated demo account, without password or MFA.

        Issues the same server-side session as a normal sign-in; permissions and patient access are
        then checked exactly as for any other account.
        """
        if not self.settings.demo_mode:
            raise AuthError("NOT_AVAILABLE", "Demo sign-in is disabled.", status_code=404)
        refused = AuthError("DEMO_ACCOUNT_UNAVAILABLE", "This is not an available demo account.", status_code=403)
        key = (username or "").strip().lower()
        with self.care._lock, self.care._connect() as conn:
            if not is_designated_demo_account(key):
                self._audit(conn, None, "DEMO_LOGIN_REFUSED", "DENIED", {"reason": "not_designated"})
                raise refused
            row = conn.execute("SELECT * FROM users WHERE subject = ?", (key,)).fetchone()
            user = dict(row) if row else None
            if not user or not user.get("is_demo_account") or not user["active"]:
                self._audit(conn, user, "DEMO_LOGIN_REFUSED", "DENIED", {"reason": "not_demo_or_inactive"})
                raise refused
            # MFA is waived for this designated demo account only; the session is marked verified.
            token = self._create_session(conn, user["subject"], "ACTIVE", True)
            conn.execute("UPDATE users SET last_login_at_utc = ? WHERE subject = ?", (_now().isoformat(), user["subject"]))
            self._audit(conn, user, "LOGIN_SUCCESS", detail={"demo_one_click": True})
            return {"status": "authenticated", "token": token, "account": self._identity(user, True).public()}

    # ---- sessions --------------------------------------------------------------------------
    def resolve(self, token: Optional[str]) -> Optional[SessionIdentity]:
        if not token:
            return None
        with self.care._lock, self.care._connect() as conn:
            row = conn.execute(
                "SELECT * FROM auth_sessions WHERE session_hash = ? AND state = 'ACTIVE'", (_hash_token(token),)
            ).fetchone()
            if not row or row["revoked_at_utc"]:
                return None
            now = _now()
            idle_cutoff = (now - timedelta(seconds=self.settings.session_idle_ttl_seconds)).isoformat()
            if row["expires_at_utc"] < now.isoformat() or row["last_seen_at_utc"] < idle_cutoff:
                return None
            user_row = conn.execute("SELECT * FROM users WHERE subject = ?", (row["user_subject"],)).fetchone()
            if not user_row or not user_row["active"]:
                return None
            if user_row["is_demo_account"] and not self.settings.demo_mode:
                # Demo accounts stop working as soon as demo mode is switched off.
                self.revoke_all_sessions(conn, row["user_subject"])
                return None
            if self.requires_mfa(dict(user_row)) and not row["mfa_verified"]:
                # Recheck at request time as well as revoking sessions on admin
                # edits: an older password-only session cannot acquire sign-off.
                self.revoke_all_sessions(conn, row["user_subject"])
                return None
            conn.execute(
                "UPDATE auth_sessions SET last_seen_at_utc = ? WHERE session_hash = ?",
                (now.isoformat(), row["session_hash"]),
            )
            return self._identity(dict(user_row), bool(row["mfa_verified"]))

    def logout(self, token: Optional[str]) -> None:
        if not token:
            return
        with self.care._lock, self.care._connect() as conn:
            row = conn.execute("SELECT user_subject FROM auth_sessions WHERE session_hash = ?", (_hash_token(token),)).fetchone()
            conn.execute(
                "UPDATE auth_sessions SET revoked_at_utc = ? WHERE session_hash = ? AND revoked_at_utc IS NULL",
                (_now().isoformat(), _hash_token(token)),
            )
            if row:
                user = conn.execute("SELECT * FROM users WHERE subject = ?", (row["user_subject"],)).fetchone()
                if user:
                    self._audit(conn, dict(user), "LOGOUT")

    def revoke_all_sessions(self, conn, subject: str) -> None:
        conn.execute(
            "UPDATE auth_sessions SET revoked_at_utc = ? WHERE user_subject = ? AND revoked_at_utc IS NULL",
            (_now().isoformat(), subject),
        )

    def change_password(self, identity: SessionIdentity, current: str, new: str, token: str) -> None:
        validate_new_password(new)
        with self.care._lock, self.care._connect() as conn:
            user = dict(conn.execute("SELECT * FROM users WHERE subject = ?", (identity.subject,)).fetchone())
            if not verify_password(current, user.get("password_hash")):
                self._audit(conn, user, "PASSWORD_CHANGE_FAILED", "DENIED")
                raise AuthError("INVALID_CREDENTIALS", "Your current password is incorrect.", status_code=403)
            conn.execute(
                "UPDATE users SET password_hash = ?, password_changed_at_utc = ? WHERE subject = ?",
                (hash_password(new, self.settings.password_hash_iterations), _now().isoformat(), identity.subject),
            )
            # Sign out every other session for this account.
            conn.execute(
                "UPDATE auth_sessions SET revoked_at_utc = ? WHERE user_subject = ? AND session_hash != ? AND revoked_at_utc IS NULL",
                (_now().isoformat(), identity.subject, _hash_token(token)),
            )
            self._audit(conn, user, "PASSWORD_CHANGED")

    def request_password_reset(self, username: str) -> None:
        """Records the request for an administrator; never reveals whether the account exists."""
        with self.care._lock, self.care._connect() as conn:
            user = self._find_user(conn, username)
            self._audit(conn, user, "PASSWORD_RESET_REQUESTED", detail={"handled_by": "administrator"})
