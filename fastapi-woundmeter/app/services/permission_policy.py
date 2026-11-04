"""Authoritative permission catalogue. Clients consume it; only the server grants access.

Bundles expand to existing atomic grants in users.permissions_json. Sensitive grants
never appear in a general bundle or arise from a role/qualification alone.
"""
MEDICAL_ROLES = {"CLINICIAN", "NURSE", "SUPERVISOR", "HOME_CARE_PROFESSIONAL"}
MODULES = {
    "administration": "Administration",
    "patients": "Patient Management",
    "capture": "Wound Capture & AI",
    "review": "Clinical Review",
    "coordination": "Care Coordination",
    "history": "History & Reports",
    "governance": "Record Governance",
}
PERMISSIONS = {
    "REGISTER_PATIENT": {"label": "Register patients", "detail": "Create patient records", "module": "patients"},
    "REGISTER_WOUND": {"label": "Register wounds", "detail": "Add wounds to authorised patients", "module": "patients"},
    "CAPTURE": {"label": "Capture & AI", "detail": "Submit photos and factual input for clinical review", "module": "capture"},
    "ASSESS": {"label": "Assess wounds", "detail": "Correct boundaries and verify proposed measurements", "module": "review"},
    "STAGE": {"label": "Classify & stage", "detail": "Set wound type and pressure-injury stage", "module": "review"},
    "DIAGNOSE": {"label": "Diagnose", "detail": "Record a clinical diagnosis; explicit grant required", "module": "review"},
    "PRESCRIBE": {"label": "Prescribe", "detail": "Order treatment; explicit grant required", "module": "coordination"},
    "MANAGE_CARE_PLAN": {"label": "Care plans", "detail": "Issue approved plans and assign care tasks", "module": "coordination"},
    "SIGN_OFF": {"label": "Clinical sign-off", "detail": "Approve records with all four attestations; explicit grant required", "module": "review"},
    "DELETE_RECORD": {"label": "Delete / void records", "detail": "Audited soft deletion; also requires assessment and sign-off", "module": "governance"},
    "AUTHORIZE_RESTORE": {"label": "Authorise restoration", "detail": "Authorise signed-record restoration; also requires assessment and sign-off", "module": "governance"},
}
DEPENDENCIES = {
    "ASSESS": ["CAPTURE"],
    "STAGE": ["ASSESS"],
    "DIAGNOSE": ["ASSESS"],
    "SIGN_OFF": ["ASSESS"],
}
BUNDLES = {
    "PATIENT_MANAGEMENT": {"label": "Patient management", "permissions": ["REGISTER_PATIENT", "REGISTER_WOUND"]},
    "WOUND_CAPTURE": {"label": "Wound capture & AI", "permissions": ["CAPTURE"]},
    "CLINICAL_REVIEW": {"label": "Clinical review", "permissions": ["ASSESS", "STAGE"]},
    "CARE_COORDINATION": {"label": "Care coordination", "permissions": ["MANAGE_CARE_PLAN"]},
}
CAREGIVER_ACTIONS = {"VIEW_APPROVED_PROGRESS", "UPLOAD_HOME_PHOTO", "SUBMIT_CAREGIVER_REPORT", "COMPLETE_CARE_TASKS"}
PATIENT_ACTIONS = {"VIEW_APPROVED_PROGRESS"}


def expand_permissions(grants):
    """Resolve bundles/dependencies in stable order, rejecting unknown admin input."""
    resolved = set()
    def include(name):
        if name in BUNDLES:
            for child in BUNDLES[name]["permissions"]:
                include(child)
        elif name in PERMISSIONS:
            if name in resolved:
                return
            resolved.add(name)
            for child in DEPENDENCIES.get(name, []):
                include(child)
        else:
            raise ValueError(f"Unknown permission: {name}")
    for grant in grants:
        include(grant)
    return [p for p in PERMISSIONS if p in resolved]


def effective_permissions(user):
    import json
    if user.get("role") not in MEDICAL_ROLES or not user.get("qualification_verified_at"):
        return []
    # Ignore unknown historical values; writes validate strictly.
    grants = json.loads(user.get("permissions_json") or "[]")
    return expand_permissions([p for p in grants if p in PERMISSIONS or p in BUNDLES])


def catalogue():
    return {"modules": MODULES, "permissions": PERMISSIONS, "bundles": BUNDLES, "dependencies": DEPENDENCIES}
