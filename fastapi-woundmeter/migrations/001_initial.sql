-- Fresh WoundMeter schema. No imported records or demo accounts.
CREATE TABLE organizations (
                    org_id TEXT PRIMARY KEY,
                    code TEXT UNIQUE NOT NULL,
                    name TEXT NOT NULL,
                    org_type TEXT NOT NULL DEFAULT 'HOSPITAL',
                    active INTEGER NOT NULL DEFAULT 1,
                    created_at_utc TEXT NOT NULL
                );

CREATE TABLE users (
                    user_id TEXT PRIMARY KEY,
                    subject TEXT UNIQUE NOT NULL,
                    display_name TEXT NOT NULL,
                    email TEXT,
                    role TEXT NOT NULL,
                    org_id TEXT NOT NULL REFERENCES organizations(org_id),
                    wards_json TEXT NOT NULL DEFAULT '[]',
                    active INTEGER NOT NULL DEFAULT 1,
                    created_at_utc TEXT NOT NULL
                , username TEXT, password_hash TEXT, password_changed_at_utc TEXT, mfa_secret_ciphertext TEXT, mfa_enabled INTEGER NOT NULL DEFAULT 0, mfa_last_step INTEGER, permissions_json TEXT NOT NULL DEFAULT '[]', qualification_title TEXT, license_number TEXT, qualification_verified_at TEXT, qualification_verified_by TEXT, failed_login_count INTEGER NOT NULL DEFAULT 0, locked_until_utc TEXT, last_login_at_utc TEXT, is_demo_account INTEGER NOT NULL DEFAULT 0);

CREATE TABLE patients (
                    patient_id TEXT PRIMARY KEY,
                    patient_code TEXT UNIQUE NOT NULL,
                    display_name TEXT NOT NULL,
                    is_fictional_demo INTEGER NOT NULL DEFAULT 1,
                    age_group TEXT NOT NULL,
                    sex TEXT NOT NULL,
                    org_id TEXT NOT NULL REFERENCES organizations(org_id),
                    ward_code TEXT NOT NULL DEFAULT 'WARD01',
                    primary_clinician_subject TEXT NOT NULL REFERENCES users(subject),
                    patient_account_subject TEXT,
                    record_status TEXT NOT NULL DEFAULT 'ACTIVE',
                    created_by_subject TEXT NOT NULL REFERENCES users(subject),
                    created_at_utc TEXT NOT NULL,
                    updated_at_utc TEXT NOT NULL
                , full_name TEXT, name_normalized TEXT, date_of_birth TEXT, hospital_number TEXT, national_id_ciphertext TEXT, national_id_blind_index TEXT, national_id_last4 TEXT, no_national_id_reason TEXT, contact_phone_ciphertext TEXT);

CREATE TABLE patient_care_team_members (
                    membership_id TEXT PRIMARY KEY,
                    patient_id TEXT NOT NULL REFERENCES patients(patient_id),
                    user_subject TEXT NOT NULL REFERENCES users(subject),
                    org_id TEXT NOT NULL REFERENCES organizations(org_id),
                    team_role TEXT NOT NULL,
                    relationship_label TEXT NOT NULL,
                    assigned_by_subject TEXT NOT NULL REFERENCES users(subject),
                    active INTEGER NOT NULL DEFAULT 1,
                    created_at_utc TEXT NOT NULL,
                    UNIQUE(patient_id, user_subject)
                );

CREATE TABLE patient_access_grants (
                    grant_id TEXT PRIMARY KEY,
                    patient_id TEXT NOT NULL REFERENCES patients(patient_id),
                    wound_id TEXT,
                    grantee_subject TEXT NOT NULL REFERENCES users(subject),
                    grantee_email TEXT,
                    granted_role TEXT NOT NULL,
                    permissions_json TEXT NOT NULL,
                    invite_token TEXT UNIQUE NOT NULL,
                    status TEXT NOT NULL DEFAULT 'INVITED',
                    invited_by_subject TEXT NOT NULL REFERENCES users(subject),
                    accepted_at_utc TEXT,
                    expires_at_utc TEXT,
                    revoked_at_utc TEXT,
                    revoked_by_subject TEXT,
                    revocation_reason TEXT,
                    legal_basis_note TEXT NOT NULL,
                    created_at_utc TEXT NOT NULL
                );

CREATE TABLE wounds (
                    wound_id TEXT PRIMARY KEY,
                    patient_id TEXT NOT NULL REFERENCES patients(patient_id),
                    anatomical_site TEXT NOT NULL,
                    laterality TEXT NOT NULL DEFAULT 'MIDLINE',
                    wound_type TEXT NOT NULL DEFAULT 'PRESSURE_INJURY',
                    pressure_injury_stage TEXT NOT NULL DEFAULT 'STAGE_3',
                    status TEXT NOT NULL DEFAULT 'ACTIVE',
                    created_by_subject TEXT NOT NULL REFERENCES users(subject),
                    created_at_utc TEXT NOT NULL,
                    updated_at_utc TEXT NOT NULL
                , wound_code TEXT);

CREATE TABLE wound_observations (
                    observation_id TEXT PRIMARY KEY,
                    patient_id TEXT NOT NULL REFERENCES patients(patient_id),
                    wound_id TEXT NOT NULL REFERENCES wounds(wound_id),
                    session_request_id TEXT,
                    capture_datetime_utc TEXT NOT NULL,
                    uploading_user_subject TEXT NOT NULL REFERENCES users(subject),
                    uploading_user_role TEXT NOT NULL,
                    capture_location_category TEXT NOT NULL DEFAULT 'HOSPITAL',
                    image_quality_status TEXT NOT NULL DEFAULT 'valid',
                    quality_gate_status TEXT NOT NULL DEFAULT 'PASS',
                    ai_segmentation_provenance TEXT NOT NULL DEFAULT 'ai_predicted',
                    meta_execution_status TEXT NOT NULL DEFAULT 'sam_live_inference',
                    provisional_measurement_id TEXT,
                    human_corrected_measurement_id TEXT,
                    final_approved_measurement_id TEXT,
                    review_state TEXT NOT NULL DEFAULT 'SUBMITTED',
                    reviewing_clinician_subject TEXT,
                    final_approval_timestamp_utc TEXT,
                    review_notes TEXT,
                    ai_explanation_json TEXT,
                    created_at_utc TEXT NOT NULL
                , draft_measurement_id TEXT, draft_status TEXT, colour_calibration_json TEXT);

CREATE TABLE wound_images (
                    image_id TEXT PRIMARY KEY,
                    observation_id TEXT NOT NULL REFERENCES wound_observations(observation_id),
                    patient_id TEXT NOT NULL REFERENCES patients(patient_id),
                    wound_id TEXT NOT NULL REFERENCES wounds(wound_id),
                    image_role TEXT NOT NULL,
                    storage_key TEXT NOT NULL,
                    media_type TEXT NOT NULL DEFAULT 'image/jpeg',
                    width_px INTEGER,
                    height_px INTEGER,
                    sha256_hash TEXT NOT NULL,
                    created_at_utc TEXT NOT NULL
                , sequence_id BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE
);

CREATE TABLE wound_measurements (
                    measurement_id TEXT PRIMARY KEY,
                    observation_id TEXT NOT NULL REFERENCES wound_observations(observation_id),
                    patient_id TEXT NOT NULL REFERENCES patients(patient_id),
                    wound_id TEXT NOT NULL REFERENCES wounds(wound_id),
                    version_number INTEGER NOT NULL,
                    measurement_stage TEXT NOT NULL,
                    source_model TEXT NOT NULL,
                    was_human_corrected INTEGER NOT NULL DEFAULT 0,
                    area_cm2 DOUBLE PRECISION NOT NULL,
                    length_cm DOUBLE PRECISION NOT NULL,
                    width_cm DOUBLE PRECISION NOT NULL,
                    clinical_length_cm DOUBLE PRECISION,
                    clinical_width_cm DOUBLE PRECISION,
                    perimeter_cm DOUBLE PRECISION,
                    length_method TEXT NOT NULL DEFAULT 'maximum_vertical_chord',
                    width_method TEXT NOT NULL DEFAULT 'maximum_horizontal_chord',
                    pixels_per_mm DOUBLE PRECISION NOT NULL DEFAULT 10.0,
                    boundary_px_json TEXT NOT NULL DEFAULT '[]',
                    created_by_subject TEXT NOT NULL REFERENCES users(subject),
                    created_at_utc TEXT NOT NULL
                , source_measurement_id TEXT, geometry_json TEXT);

CREATE TABLE clinical_assessments (
                    assessment_id TEXT PRIMARY KEY,
                    observation_id TEXT NOT NULL REFERENCES wound_observations(observation_id),
                    patient_id TEXT NOT NULL REFERENCES patients(patient_id),
                    wound_id TEXT NOT NULL REFERENCES wounds(wound_id),
                    version_number INTEGER NOT NULL DEFAULT 1,
                    supersedes_assessment_id TEXT,
                    wound_type TEXT NOT NULL,
                    pressure_injury_stage TEXT NOT NULL,
                    wound_bed_appearance TEXT NOT NULL,
                    exudate_amount TEXT NOT NULL,
                    surrounding_skin TEXT NOT NULL,
                    wound_trend TEXT NOT NULL,
                    braden_total INTEGER NOT NULL,
                    braden_risk_band TEXT NOT NULL,
                    system_priority TEXT NOT NULL,
                    nurse_priority TEXT NOT NULL,
                    clinical_interpretation TEXT NOT NULL,
                    care_decisions TEXT NOT NULL,
                    ai_draft_disposition TEXT NOT NULL DEFAULT 'accepted',
                    final_documentation_text TEXT NOT NULL,
                    signed_by_subject TEXT NOT NULL REFERENCES users(subject),
                    signed_by_name TEXT NOT NULL,
                    signed_by_role TEXT NOT NULL,
                    signed_at_utc TEXT NOT NULL,
                    amendment_reason TEXT,
                    is_immutable INTEGER NOT NULL DEFAULT 1
                , diagnosis_text TEXT, diagnosed_by_subject TEXT, reviewed_measurement_id TEXT, reviewed_measurement_version INTEGER, reviewer_attested_at_utc TEXT, attestations_json TEXT, sequence_id BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE
);

CREATE TABLE care_plans (
                    care_plan_id TEXT PRIMARY KEY,
                    patient_id TEXT NOT NULL REFERENCES patients(patient_id),
                    wound_id TEXT NOT NULL REFERENCES wounds(wound_id),
                    version_number INTEGER NOT NULL DEFAULT 1,
                    title TEXT NOT NULL,
                    purpose TEXT NOT NULL,
                    approved_instructions TEXT NOT NULL,
                    responsible_clinician_subject TEXT NOT NULL REFERENCES users(subject),
                    assigned_caregiver_subject TEXT,
                    task_frequency TEXT NOT NULL,
                    start_date TEXT NOT NULL,
                    review_date TEXT NOT NULL,
                    status TEXT NOT NULL DEFAULT 'ACTIVE',
                    approved_at_utc TEXT NOT NULL,
                    created_at_utc TEXT NOT NULL
                );

CREATE TABLE care_tasks (
                    task_id TEXT PRIMARY KEY,
                    care_plan_id TEXT NOT NULL REFERENCES care_plans(care_plan_id),
                    patient_id TEXT NOT NULL REFERENCES patients(patient_id),
                    wound_id TEXT NOT NULL REFERENCES wounds(wound_id),
                    title TEXT NOT NULL,
                    instructions TEXT NOT NULL,
                    frequency TEXT NOT NULL,
                    due_at_utc TEXT NOT NULL,
                    status TEXT NOT NULL DEFAULT 'PENDING',
                    completed_by_subject TEXT,
                    completed_at_utc TEXT,
                    caregiver_notes TEXT,
                    created_at_utc TEXT NOT NULL
                );

CREATE TABLE caregiver_reports (
                    report_id TEXT PRIMARY KEY,
                    observation_id TEXT NOT NULL REFERENCES wound_observations(observation_id),
                    patient_id TEXT NOT NULL REFERENCES patients(patient_id),
                    wound_id TEXT NOT NULL REFERENCES wounds(wound_id),
                    submitted_by_subject TEXT NOT NULL REFERENCES users(subject),
                    pain_score_0_10 INTEGER,
                    odor_observed INTEGER NOT NULL DEFAULT 0,
                    dressing_intact INTEGER NOT NULL DEFAULT 1,
                    redness_around_wound INTEGER NOT NULL DEFAULT 0,
                    drainage_change INTEGER NOT NULL DEFAULT 0,
                    fever_or_chills INTEGER NOT NULL DEFAULT 0,
                    concern_flag INTEGER NOT NULL DEFAULT 0,
                    non_diagnostic_notes TEXT NOT NULL DEFAULT '',
                    created_at_utc TEXT NOT NULL
                , drainage_level TEXT, dressing_condition TEXT, redness_observed TEXT, concern_reported INTEGER NOT NULL DEFAULT 0);

CREATE TABLE review_requests (
                    review_request_id TEXT PRIMARY KEY,
                    observation_id TEXT UNIQUE NOT NULL REFERENCES wound_observations(observation_id),
                    patient_id TEXT NOT NULL REFERENCES patients(patient_id),
                    wound_id TEXT NOT NULL REFERENCES wounds(wound_id),
                    submitted_by_subject TEXT NOT NULL REFERENCES users(subject),
                    submitted_from_location TEXT NOT NULL,
                    assigned_org_id TEXT NOT NULL REFERENCES organizations(org_id),
                    status TEXT NOT NULL DEFAULT 'AWAITING_CLINICAL_REVIEW',
                    priority_level TEXT NOT NULL DEFAULT 'YELLOW',
                    concern_summary TEXT,
                    reviewed_by_subject TEXT,
                    reviewed_at_utc TEXT,
                    resolution_notes TEXT,
                    created_at_utc TEXT NOT NULL
                );

CREATE TABLE notifications (
                    notification_id TEXT PRIMARY KEY,
                    recipient_subject TEXT NOT NULL REFERENCES users(subject),
                    recipient_role TEXT NOT NULL,
                    patient_id TEXT NOT NULL REFERENCES patients(patient_id),
                    wound_id TEXT,
                    observation_id TEXT,
                    notification_type TEXT NOT NULL,
                    safe_preview_title TEXT NOT NULL,
                    safe_preview_body TEXT NOT NULL,
                    clinical_owner_subject TEXT NOT NULL,
                    response_sla_notice TEXT NOT NULL,
                    is_read INTEGER NOT NULL DEFAULT 0,
                    created_at_utc TEXT NOT NULL
                );

CREATE TABLE audit_events (
                    event_id TEXT PRIMARY KEY,
                    timestamp_utc TEXT NOT NULL,
                    actor_subject TEXT NOT NULL,
                    actor_role TEXT NOT NULL,
                    actor_org_id TEXT NOT NULL,
                    patient_id TEXT,
                    wound_id TEXT,
                    action TEXT NOT NULL,
                    entity_type TEXT NOT NULL,
                    entity_id TEXT,
                    outcome TEXT NOT NULL DEFAULT 'SUCCESS',
                    detail_json TEXT NOT NULL DEFAULT '{}',
                    prev_hash TEXT NOT NULL,
                    entry_hash TEXT NOT NULL
                , sequence_id BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE
);

CREATE TABLE auth_sessions (
                    session_hash TEXT PRIMARY KEY,
                    user_subject TEXT NOT NULL REFERENCES users(subject),
                    state TEXT NOT NULL,
                    mfa_verified INTEGER NOT NULL DEFAULT 0,
                    mfa_attempts INTEGER NOT NULL DEFAULT 0,
                    created_at_utc TEXT NOT NULL,
                    expires_at_utc TEXT NOT NULL,
                    last_seen_at_utc TEXT NOT NULL,
                    revoked_at_utc TEXT
                );

CREATE TABLE ai_visual_observations (
                    ai_observation_id TEXT PRIMARY KEY,
                    observation_id TEXT NOT NULL REFERENCES wound_observations(observation_id),
                    patient_id TEXT NOT NULL REFERENCES patients(patient_id),
                    wound_id TEXT NOT NULL REFERENCES wounds(wound_id),
                    version_number INTEGER NOT NULL,
                    status TEXT NOT NULL CHECK(status IN ('AI_DRAFT', 'ACCEPTED', 'EDITED', 'REJECTED')),
                    model_id TEXT NOT NULL,
                    input_json TEXT NOT NULL,
                    findings_json TEXT NOT NULL,
                    guard_flags_json TEXT NOT NULL DEFAULT '[]',
                    clinician_findings_json TEXT,
                    clinician_notes TEXT,
                    latency_ms DOUBLE PRECISION,
                    created_by_subject TEXT NOT NULL REFERENCES users(subject),
                    created_at_utc TEXT NOT NULL,
                    reviewed_by_subject TEXT,
                    reviewed_at_utc TEXT
                );

CREATE TABLE clinical_reports (
                    report_id TEXT PRIMARY KEY,
                    report_series_id TEXT NOT NULL,
                    version_number INTEGER NOT NULL,
                    supersedes_report_id TEXT,
                    patient_id TEXT NOT NULL REFERENCES patients(patient_id),
                    wound_id TEXT NOT NULL REFERENCES wounds(wound_id),
                    anchor_observation_id TEXT,
                    status TEXT NOT NULL CHECK(status IN ('AI_DRAFT', 'CLINICIAN_EDITED', 'SIGNED', 'REJECTED', 'SUPERSEDED')),
                    generator TEXT NOT NULL,
                    evidence_json TEXT NOT NULL,
                    sections_json TEXT NOT NULL,
                    consistency_json TEXT NOT NULL,
                    includes_nursing INTEGER NOT NULL DEFAULT 0,
                    latency_ms DOUBLE PRECISION,
                    created_by_subject TEXT NOT NULL REFERENCES users(subject),
                    created_at_utc TEXT NOT NULL,
                    signed_by_subject TEXT,
                    signed_by_name TEXT,
                    signed_by_role TEXT,
                    signed_at_utc TEXT,
                    content_sha256 TEXT,
                    rejection_reason TEXT
                );

CREATE TABLE clinical_approval_receipts (
                    observation_id TEXT PRIMARY KEY REFERENCES wound_observations(observation_id) ON DELETE CASCADE,
                    request_id TEXT UNIQUE NOT NULL,
                    actor_subject TEXT NOT NULL REFERENCES users(subject),
                    payload_hash TEXT NOT NULL,
                    final_measurement_id TEXT NOT NULL REFERENCES wound_measurements(measurement_id),
                    assessment_id TEXT NOT NULL REFERENCES clinical_assessments(assessment_id)
                );

CREATE TABLE observation_submissions (
                    actor_subject TEXT NOT NULL REFERENCES users(subject),
                    submission_id TEXT NOT NULL,
                    patient_id TEXT NOT NULL REFERENCES patients(patient_id),
                    wound_id TEXT NOT NULL REFERENCES wounds(wound_id),
                    payload_hash TEXT NOT NULL,
                    status TEXT NOT NULL CHECK(status IN ('PROCESSING', 'SUCCEEDED', 'FAILED')),
                    observation_id TEXT UNIQUE REFERENCES wound_observations(observation_id),
                    started_at_utc TEXT NOT NULL,
                    finished_at_utc TEXT,
                    error_code TEXT, attempt_id TEXT,
                    PRIMARY KEY(actor_subject, submission_id)
                );

CREATE TABLE record_deletions (
                    deletion_id TEXT PRIMARY KEY,
                    record_type TEXT NOT NULL CHECK(record_type IN ('observation', 'report', 'wound')),
                    record_id TEXT NOT NULL,
                    patient_id TEXT NOT NULL REFERENCES patients(patient_id),
                    wound_id TEXT NOT NULL REFERENCES wounds(wound_id),
                    previous_status TEXT NOT NULL,
                    disposition TEXT NOT NULL CHECK(disposition IN ('DELETED', 'VOIDED')),
                    deleted_by_subject TEXT NOT NULL REFERENCES users(subject),
                    deleted_at_utc TEXT NOT NULL,
                    deletion_reason TEXT NOT NULL,
                    restore_authorized_by TEXT REFERENCES users(subject),
                    restore_authorized_at_utc TEXT,
                    restore_authorization_reason TEXT,
                    restored_by_subject TEXT REFERENCES users(subject),
                    restored_at_utc TEXT,
                    restoration_reason TEXT
                );

CREATE TABLE wards (
                    ward_code TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    org_id TEXT NOT NULL REFERENCES organizations(org_id),
                    active INTEGER NOT NULL DEFAULT 1,
                    created_at_utc TEXT NOT NULL
                );

CREATE TABLE shift_sessions (
                    shift_id TEXT PRIMARY KEY,
                    user_subject TEXT NOT NULL REFERENCES users(subject),
                    ward_code TEXT NOT NULL REFERENCES wards(ward_code),
                    shift TEXT NOT NULL CHECK(shift IN ('DAY', 'EVENING', 'NIGHT')),
                    state TEXT NOT NULL CHECK(state IN ('ACTIVE', 'ENDED')),
                    started_at_utc TEXT NOT NULL,
                    ended_at_utc TEXT,
                    last_activity_at_utc TEXT NOT NULL
                );

CREATE TABLE admissions (
                    admission_id TEXT PRIMARY KEY,
                    admission_code TEXT UNIQUE NOT NULL,
                    patient_id TEXT NOT NULL REFERENCES patients(patient_id),
                    ward_code TEXT NOT NULL REFERENCES wards(ward_code),
                    bed TEXT NOT NULL,
                    status TEXT NOT NULL
                        CHECK(status IN ('PENDING_ASSESSMENT', 'ACTIVE', 'DISCHARGED', 'CANCELLED')),
                    admitted_at_utc TEXT NOT NULL,
                    consent_state TEXT NOT NULL DEFAULT 'NOT_REQUIRED',
                    target_wound_location TEXT NOT NULL,
                    baseline_wound_status TEXT NOT NULL,
                    individual_care_plan_available INTEGER NOT NULL DEFAULT 0,
                    family_participation_enabled INTEGER NOT NULL DEFAULT 0,
                    discharge_at_utc TEXT,
                    discharge_reason TEXT,
                    discharge_exception_reason TEXT,
                    created_by_subject TEXT NOT NULL REFERENCES users(subject),
                    version INTEGER NOT NULL DEFAULT 1,
                    created_at_utc TEXT NOT NULL
                );

CREATE TABLE admission_locations (
                    location_id TEXT PRIMARY KEY,
                    admission_id TEXT NOT NULL REFERENCES admissions(admission_id),
                    ward_code TEXT NOT NULL REFERENCES wards(ward_code),
                    bed TEXT NOT NULL,
                    started_at_utc TEXT NOT NULL,
                    ended_at_utc TEXT,
                    created_by_subject TEXT NOT NULL REFERENCES users(subject)
                );

CREATE TABLE nursing_assessments (
                    assessment_id TEXT PRIMARY KEY,
                    admission_id TEXT NOT NULL REFERENCES admissions(admission_id),
                    patient_id TEXT NOT NULL REFERENCES patients(patient_id),
                    shift_id TEXT NOT NULL REFERENCES shift_sessions(shift_id),
                    assessment_type TEXT NOT NULL CHECK(assessment_type IN ('ADMISSION', 'DAILY', 'REASSESSMENT')),
                    assessment_date TEXT NOT NULL,
                    counts_as_required_daily INTEGER NOT NULL,
                    red_flag_present INTEGER NOT NULL,
                    new_abnormality INTEGER NOT NULL,
                    skin_status TEXT NOT NULL,
                    wound_trend TEXT NOT NULL,
                    pain_issue TEXT NOT NULL,
                    moisture_issue TEXT NOT NULL,
                    mobility_issue TEXT NOT NULL,
                    sensory_perception INTEGER NOT NULL CHECK(sensory_perception BETWEEN 1 AND 4),
                    moisture INTEGER NOT NULL CHECK(moisture BETWEEN 1 AND 4),
                    activity INTEGER NOT NULL CHECK(activity BETWEEN 1 AND 4),
                    mobility INTEGER NOT NULL CHECK(mobility BETWEEN 1 AND 4),
                    nutrition INTEGER NOT NULL CHECK(nutrition BETWEEN 1 AND 4),
                    friction_and_shear INTEGER NOT NULL CHECK(friction_and_shear BETWEEN 1 AND 3),
                    braden_total INTEGER NOT NULL,
                    braden_risk_band TEXT NOT NULL,
                    braden_version TEXT NOT NULL,
                    system_priority TEXT NOT NULL,
                    nurse_priority TEXT NOT NULL,
                    priority_override INTEGER NOT NULL,
                    override_direction TEXT NOT NULL,
                    override_reason TEXT,
                    priority_reason_codes_json TEXT NOT NULL,
                    suggested_review_minutes INTEGER NOT NULL,
                    next_review_at_utc TEXT NOT NULL,
                    rule_version TEXT NOT NULL,
                    submitted_by_subject TEXT NOT NULL REFERENCES users(subject),
                    submitted_at_utc TEXT NOT NULL
                );

CREATE TABLE nursing_care_activities (
                    activity_id TEXT PRIMARY KEY,
                    assessment_id TEXT NOT NULL REFERENCES nursing_assessments(assessment_id),
                    admission_id TEXT NOT NULL REFERENCES admissions(admission_id),
                    activity_type TEXT NOT NULL
                        CHECK(activity_type IN ('POSITIONING', 'PRESSURE_REDUCTION', 'WOUND_CARE', 'ESCALATION')),
                    critical INTEGER NOT NULL DEFAULT 0,
                    status TEXT NOT NULL DEFAULT 'PLANNED' CHECK(status IN ('PLANNED', 'COMPLETED', 'UNABLE')),
                    due_at_utc TEXT NOT NULL,
                    completed_at_utc TEXT,
                    unable_reason TEXT,
                    performed_by_subject TEXT REFERENCES users(subject),
                    version INTEGER NOT NULL DEFAULT 1,
                    created_at_utc TEXT NOT NULL,
                    UNIQUE(assessment_id, activity_type)
                );

CREATE INDEX ix_grants_patient_grantee
                    ON patient_access_grants(patient_id, grantee_subject, status);

CREATE INDEX ix_wounds_patient ON wounds(patient_id);

CREATE INDEX ix_obs_wound_date
                    ON wound_observations(wound_id, capture_datetime_utc);

CREATE INDEX ix_meas_obs_version
                    ON wound_measurements(observation_id, version_number);

CREATE INDEX ix_review_req_status
                    ON review_requests(assigned_org_id, status);

CREATE INDEX ix_notif_recipient
                    ON notifications(recipient_subject, is_read);

CREATE INDEX ix_auth_sessions_user ON auth_sessions(user_subject);

CREATE INDEX ix_ai_obs_observation ON ai_visual_observations(observation_id, version_number);

CREATE INDEX ix_reports_wound ON clinical_reports(patient_id, wound_id, created_at_utc);

CREATE UNIQUE INDEX ux_record_active_deletion
                    ON record_deletions(record_type, record_id) WHERE restored_at_utc IS NULL;

CREATE UNIQUE INDEX ux_users_username ON users(username);

CREATE UNIQUE INDEX ux_patients_national_id_index
                    ON patients(national_id_blind_index) WHERE national_id_blind_index IS NOT NULL;

CREATE UNIQUE INDEX ux_patients_org_hn
                    ON patients(org_id, hospital_number) WHERE hospital_number IS NOT NULL;

CREATE INDEX ix_patients_name ON patients(name_normalized);

CREATE UNIQUE INDEX ux_wounds_patient_code ON wounds(patient_id, wound_code);

CREATE UNIQUE INDEX ux_shift_sessions_active
                    ON shift_sessions(user_subject) WHERE state = 'ACTIVE';

CREATE UNIQUE INDEX ux_admissions_patient_active
                    ON admissions(patient_id) WHERE status IN ('PENDING_ASSESSMENT', 'ACTIVE');

CREATE INDEX ix_admissions_ward_status ON admissions(ward_code, status);

CREATE UNIQUE INDEX ux_nursing_required_day
                    ON nursing_assessments(admission_id, assessment_date) WHERE counts_as_required_daily = 1;
