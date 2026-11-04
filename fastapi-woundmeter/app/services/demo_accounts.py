"""Demo-mode accounts for one-click sign-in (WOUNDMETER_DEMO_MODE=true only).

Creates a separate demo organisation and ward plus four designated accounts. It never creates
patients, wounds, images or any clinical record, and never changes an existing row: running it
again (every API start in demo mode) only adds what is missing.

Demo accounts have no usable password. They sign in only through the one-click demo endpoint,
which works only while demo mode is on and only for the accounts listed here.
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any, Dict, List

from app.services.permission_policy import PERMISSIONS, expand_permissions

DEMO_ORG_ID = "ORG-DEMO"
DEMO_ORG_CODE = "DEMO"
DEMO_ORG_NAME = "WoundMeter Demo Hospital"
DEMO_WARD_CODE = "DEMO01"
DEMO_WARD_NAME = "Demo Ward 01"
DEMO_VERIFIER = "system:demo-initialisation"

_NURSE_GRANTS = [
    "REGISTER_PATIENT", "REGISTER_WOUND", "CAPTURE", "ASSESS", "STAGE",
    "MANAGE_CARE_PLAN", "SIGN_OFF", "DELETE_RECORD", "AUTHORIZE_RESTORE",
]

# Ordered as shown on the sign-in screen. Only these subjects may use one-click demo sign-in.
DEMO_LOGIN_ACCOUNTS: Dict[str, Dict[str, Any]] = {
    "admin.demo": {
        "display_name": "Administrator (Demo)",
        "role": "ADMIN",
        "summary": "Manages demo accounts, roles and care teams. No clinical access.",
        "wards": [],
        "qualification": None,
        "permissions": [],
    },
    "clinician.somchai": {
        "display_name": "Dr. Somchai (Demo Wound Clinician)",
        "role": "CLINICIAN",
        "summary": "Physician. Registers patients, reviews, signs off, diagnoses and prescribes.",
        "wards": [DEMO_WARD_CODE],
        "qualification": ("Physician — Wound Care (demo)", "MD-DEMO-1001"),
        "permissions": list(PERMISSIONS),
    },
    "nurse.ward01": {
        "display_name": "Nurse Mali (Demo Ward Nurse)",
        "role": "NURSE",
        "summary": "Ward nurse. Registers patients, captures, assesses and signs off; inpatient nursing.",
        "wards": [DEMO_WARD_CODE],
        "qualification": ("Registered Nurse (demo)", "RN-DEMO-0101"),
        "permissions": _NURSE_GRANTS,
    },
    "caregiver.suda": {
        "display_name": "Suda (Demo Family Caregiver)",
        "role": "FAMILY_CAREGIVER",
        "summary": "Home caregiver. Sees only patients a clinician has shared with this account.",
        "wards": [],
        "qualification": None,
        "permissions": [],
    },
}


def is_designated_demo_account(subject: str) -> bool:
    return subject in DEMO_LOGIN_ACCOUNTS


def ensure_demo_configuration(conn) -> List[str]:
    """Insert the demo organisation, ward and accounts if missing. Returns the subjects created."""
    now = datetime.now(timezone.utc).isoformat()
    conn.execute(
        "INSERT INTO organizations(org_id, code, name, org_type, active, created_at_utc) "
        "VALUES (?, ?, ?, 'HOSPITAL', 1, ?) ON CONFLICT DO NOTHING",
        (DEMO_ORG_ID, DEMO_ORG_CODE, DEMO_ORG_NAME, now),
    )
    conn.execute(
        "INSERT INTO wards(ward_code, name, org_id, active, created_at_utc) VALUES (?, ?, ?, 1, ?) ON CONFLICT DO NOTHING",
        (DEMO_WARD_CODE, DEMO_WARD_NAME, DEMO_ORG_ID, now),
    )
    if not conn.execute("SELECT 1 FROM organizations WHERE org_id = ?", (DEMO_ORG_ID,)).fetchone():
        raise RuntimeError(f"Demo organisation code {DEMO_ORG_CODE!r} is already used by another organisation.")
    created: List[str] = []
    for subject, spec in DEMO_LOGIN_ACCOUNTS.items():
        taken = conn.execute(
            "SELECT 1 FROM users WHERE lower(subject) = ? OR lower(username) = ?", (subject, subject)
        ).fetchone()
        if taken:
            # Existing accounts are never overwritten. A non-demo account with this name stays
            # unusable for demo sign-in, which requires is_demo_account = 1.
            continue
        qualification = spec["qualification"]
        conn.execute(
            """
            INSERT INTO users(user_id, subject, username, display_name, role, org_id, wards_json, active,
                              created_at_utc, password_hash, password_changed_at_utc, mfa_enabled,
                              permissions_json, qualification_title, license_number,
                              qualification_verified_at, qualification_verified_by, is_demo_account)
            VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, NULL, NULL, 0, ?, ?, ?, ?, ?, 1)
            ON CONFLICT DO NOTHING
            """,
            (
                f"USR-{subject}", subject, subject, spec["display_name"], spec["role"], DEMO_ORG_ID,
                json.dumps(spec["wards"]), now,
                json.dumps(expand_permissions(spec["permissions"])),
                qualification[0] if qualification else None,
                qualification[1] if qualification else None,
                now if qualification else None,
                DEMO_VERIFIER if qualification else None,
            ),
        )
        created.append(subject)
    return created
