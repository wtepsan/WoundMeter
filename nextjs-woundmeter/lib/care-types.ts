// Shapes returned by the FastAPI connected-care API (`/v2/care/*`).

export type ReviewState =
  | "AWAITING_CLINICAL_REVIEW"
  | "CLINICIAN_APPROVED"
  | "RETAKE_REQUESTED"
  | "REJECTED"
  | string;

export interface MeasurementGeometry {
  canonical_width_px: number;
  canonical_height_px: number;
  inner_bounds_px: [number, number, number, number];
  pixels_per_mm: number;
  calibration_id: string;
  mask_sha256: string;
  model_source: string;
  measurement_version: number;
  selected_component_id: number | null;
  selection_required: boolean;
  quality_gate: { status: string; review_reasons: string[]; checks?: Record<string, string> };
  candidates: {
    candidate_id: number;
    canonical_boundary_px: number[][];
    measurements: { area_cm2: number };
    /** Guided SAM: the refined whole-wound boundary, or the concept boundary offered as an alternative. */
    boundary_kind?: "sam_refined_whole_wound" | "sam_concept" | null;
  }[];
  sam_guidance?: SamGuidance | null;
  colour_status?: ColourStatus;
  /** Declared when a boundary is selected or edited; absent on older measurements. */
  measurement_region?: MeasurementRegion | null;
  /** Where each measured dimension lies on the rectified image; absent on older measurements. */
  measurement_lines?: MeasurementLines | null;
  /** "No visible open wound": 0 cm² with no boundary, keeping the photo's calibration. */
  zero_area?: boolean;
  zero_area_basis?: "ai_no_visible_wound" | "clinician_recorded_zero";
  /** AprilTag ruler detection behind the calibration. */
  ruler?: {
    detected_ids?: number[];
    template_id?: string | null;
    template_version?: string | null;
    pixels_per_mm?: number | null;
    validated?: boolean;
    ruler_length_cm?: number | null;
    calibration_source?: string | null;
  } | null;
  model_version?: string | null;
  measurement_algorithm_version?: string | null;
}

/** Two end points per line, in rectified (canonical) pixels. Y = length_cm, X = width_cm. */
export interface MeasurementLines {
  length_line_px: number[][];
  width_line_px: number[][];
  clinical_length_line_px?: number[][];
  clinical_width_line_px?: number[][];
}

/** What a boundary outlines. Whole-wound and red-tissue areas are different measurements. */
export type MeasurementRegion = "whole_wound" | "red_tissue";

/** Server measurement of an unsaved boundary edit (same algorithm as saving; nothing stored). */
export interface MeasurePreview {
  base_measurement_id: string;
  pixels_per_mm: number;
  area_cm2: number;
  length_cm: number;
  width_cm: number;
  clinical_length_cm: number;
  clinical_width_cm: number;
  perimeter_cm: number;
  lines: MeasurementLines;
  saved: false;
}

export interface SamGuidance {
  strategy: "guided" | "concept" | "spatial";
  concept_prompt?: string | null;
  concept_prompts_tried?: string[];
  seeds?: { source: string; box_px: number[]; point_px: number[]; seed_area_px: number }[];
  spatial_status?: "completed" | "failed";
  alternatives_offered?: boolean;
  ordered_by?: string;
  holes_filled_px?: number;
  specks_removed_px?: number;
}

export type ColourStatus =
  | "not_attempted"
  | "NOT_CONFIGURED"
  | "COLOUR_CALIBRATED"
  | "COLOUR_REVIEW_REQUIRED"
  | "UNVERIFIED_REFERENCE"
  | "COLOUR_CALIBRATION_FAILED";

export interface ColourPatch {
  name: string;
  found: boolean;
  observed_srgb?: number[] | null;
  reference_srgb?: number[] | null;
  corrected_srgb?: number[] | null;
  delta_e00_before?: number | null;
  delta_e00_after?: number | null;
  issue?: string | null;
}

/** Colour reference strip result stored with the observation (clinical staff only). */
export interface ColourCalibration {
  status: ColourStatus;
  warnings: string[];
  profile_id?: string | null;
  profile_version?: string | null;
  reference_status?: string | null;
  method?: string | null;
  patches: ColourPatch[];
  patches_found: number;
  mean_delta_e00_before?: number | null;
  mean_delta_e00_after?: number | null;
  max_delta_e00_after?: number | null;
  loo_mean_delta_e00?: number | null;
  correction_applied: boolean;
  colour_interpretation_allowed: boolean;
  source_image_sha256?: string;
  corrected_image_sha256?: string | null;
}

export interface AiFinding {
  category: string;
  observation: string;
  evidence?: string;
  assessment_status: "observed" | "possibly_observed" | "not_observed" | "not_assessable" | string;
  uncertainty?: "low" | "moderate" | "high";
  requires_clinician_verification?: boolean;
}

/** One Muse Spark visual-observation version; an AI draft until a clinician reviews it. */
export interface AiVisualObservation {
  ai_observation_id: string;
  observation_id: string;
  version_number: number;
  status: "AI_DRAFT" | "ACCEPTED" | "EDITED" | "REJECTED";
  model_id: string;
  input: { image_role: string; colour_status: string; colour_interpretation_allowed: boolean };
  findings: {
    image_quality: { usable_for_visual_description: boolean; issues: string[] };
    findings: AiFinding[];
    requires_physical_assessment: string[];
    missing_information: string[];
  };
  guard_flags: { category?: string; reason: string }[];
  clinician_findings?: AiFinding[] | null;
  clinician_notes?: string | null;
  latency_ms?: number | null;
  created_by_subject: string;
  created_at_utc: string;
  reviewed_by_subject?: string | null;
  reviewed_at_utc?: string | null;
}

export interface ReportSection {
  title: string;
  text: string;
  source: "record" | "calculation" | "ai_draft" | "clinician_edited" | "deterministic_fallback" | "system" | string;
  source_refs: string[];
}

export interface ClinicalReport {
  report_id: string;
  kind?: "report" | "wound_summary";
  report_series_id: string;
  version_number: number;
  supersedes_report_id?: string | null;
  wound_id: string;
  status: "AI_DRAFT" | "CLINICIAN_EDITED" | "SIGNED" | "REJECTED" | "SUPERSEDED";
  generator: string;
  includes_nursing: boolean;
  latency_ms?: number | null;
  created_by_subject: string;
  created_at_utc: string;
  signed_by_name?: string | null;
  signed_by_role?: string | null;
  signed_at_utc?: string | null;
  content_sha256?: string | null;
  rejection_reason?: string | null;
  content_withheld: boolean;
  withheld_reason?: string;
  sections: Record<string, ReportSection> | null;
  consistency: { unsupported_numbers: Record<string, string[]>; uncited_sections?: string[]; ok: boolean } | null;
}

export interface AssistantAnswer {
  answer: string;
  recorded_facts: { statement: string; source_ref: string }[];
  calculations: { statement: string; source_ref: string }[];
  missing_information: string[];
  unsupported_numbers: string[];
  sources: { tool: string; refs: string[]; denied: boolean }[];
  created_report_ids: string[];
  format: "structured" | "text" | "incomplete";
  model: string;
  latency_ms: number;
  disclaimer: string;
}

export interface Transcription {
  transcript: string;
  audio_seconds: number;
  latency_ms: number;
  model: string;
  requires_confirmation: boolean;
}

export interface MeasurementVersion {
  geometry?: MeasurementGeometry | null;
  measurement_id: string;
  source_measurement_id?: string | null;
  version_number: number;
  measurement_stage: "PROVISIONAL_AI" | "HUMAN_CORRECTED" | "FINAL_CLINICIAN_APPROVED" | string;
  source_model: string;
  was_human_corrected: number;
  area_cm2: number;
  length_cm: number;
  width_cm: number;
  clinical_length_cm?: number | null;
  clinical_width_cm?: number | null;
  perimeter_cm?: number | null;
  length_method?: string | null;
  width_method?: string | null;
  pixels_per_mm?: number | null;
  boundary_px_json?: string | null;
  created_by_subject: string;
  created_at_utc: string;
}

export interface ClinicalAssessmentVersion {
  assessment_id: string;
  version_number: number;
  supersedes_assessment_id?: string | null;
  reviewed_measurement_id?: string | null;
  reviewed_measurement_version?: number | null;
  reviewer_attested_at_utc?: string | null;
  wound_type: string;
  pressure_injury_stage: string;
  wound_bed_appearance: string;
  exudate_amount: string;
  surrounding_skin?: string;
  wound_trend: string;
  braden_total: number;
  braden_risk_band: string;
  clinical_interpretation: string;
  care_decisions: string;
  ai_draft_disposition: string;
  final_documentation_text: string;
  signed_by_name: string;
  signed_by_role: string;
  signed_at_utc: string;
  amendment_reason?: string | null;
  is_immutable: number;
  diagnosis_text?: string | null;
  diagnosed_by_subject?: string | null;
}

/** Latest clinician-published findings; internal assessment metadata stays staff-only. */
export type SharedClinicalAssessment = Pick<ClinicalAssessmentVersion,
  | "assessment_id" | "version_number" | "wound_type" | "pressure_injury_stage"
  | "wound_bed_appearance" | "exudate_amount" | "surrounding_skin" | "wound_trend"
  | "clinical_interpretation" | "care_decisions" | "final_documentation_text"
  | "signed_by_name" | "signed_by_role" | "signed_at_utc" | "diagnosis_text"
>;

export interface CaregiverReportRecord {
  report_id: string;
  submitted_by_subject?: string;
  pain_score_0_10?: number | null;
  odor_observed: number;
  dressing_intact: number;
  redness_around_wound: number;
  drainage_change: number;
  fever_or_chills: number;
  concern_flag: number;
  non_diagnostic_notes?: string | null;
  created_at_utc?: string;
  drainage_level?: string | null;
  dressing_condition?: string | null;
  redness_observed?: string | null;
  concern_reported?: number;
}

export interface CareMuseExplanation {
  status?: "ready" | "fallback_deterministic" | "unavailable" | string;
  model_id: string;
  disclaimer?: string;
  measurement_summary: string;
  segmentation_explanation: string;
  measurement_limitations: string;
  historical_comparison: string;
  documentation_draft: string;
  questions_for_reviewer: string[];
  latency_ms?: number | null;
  error_message?: string | null;
}

export interface SignedImageRef {
  image_id: string;
  image_role:
    | "ORIGINAL_UPLOAD"
    | "CANONICAL_RECTIFIED"
    | "AI_MASK_SAM"
    | "AI_MASK_YOLO"
    | "HUMAN_CORRECTED_MASK"
    | "COLOUR_CORRECTED"
    | string;
  media_type: string;
  width_px?: number | null;
  height_px?: number | null;
  sha256_hash?: string;
  signed_url: string;
  expires_at_epoch: number;
}

export type RecordFields = Record<string, string | number | boolean | null>;
export interface RecordChange {
  revision: number; action: string; actor: string; timestamp: string; reason: string;
  fields: RecordFields; changes: Record<string, { old: unknown; new: unknown }>;
  assessment_id?: string | null;
  /** The clinician applied Muse Spark wording suggestions before saving. */
  ai_assisted?: boolean;
}

export interface ObservationRecord {
  correction_of?: string | null;
  photo_corrections?: Array<{ observation_id: string; reason: string; timestamp: string }>;
  record_has_draft?: boolean;
  image_integrity_verified?: boolean;
  record_amendment_reason?: string;
  record_revision?: number;
  record_draft?: RecordFields;
  record_published?: RecordFields;
  record_history?: RecordChange[];
  record_base_assessment_id?: string | null;
  record_working_measurement?: MeasurementVersion | null;
  draft_status?: "current" | "stale" | "none" | null;
  capture_quality_reason?: "ruler_incomplete" | "no_wound_detected" | "wound_outside_photo" | "image_quality";
  observation_id: string;
  patient_id: string;
  wound_id: string;
  session_request_id?: string | null;
  capture_datetime_utc: string;
  uploading_user_subject: string;
  uploading_user_role: string;
  capture_location_category: "HOSPITAL" | "HOME" | "COMMUNITY" | string;
  image_quality_status: string;
  quality_gate_status: string;
  ai_segmentation_provenance: string;
  meta_execution_status: string;
  review_state: ReviewState;
  reviewing_clinician_subject?: string | null;
  final_approval_timestamp_utc?: string | null;
  review_notes?: string | null;
  measurements_versions: MeasurementVersion[];
  approved_measurement?: MeasurementVersion | null;
  provisional_or_working_measurement?: MeasurementVersion | null;
  clinical_assessments_versions: ClinicalAssessmentVersion[];
  latest_clinical_assessment?: ClinicalAssessmentVersion | SharedClinicalAssessment | null;
  caregiver_report?: CaregiverReportRecord | null;
  ai_explanation?: CareMuseExplanation | null;
  images: SignedImageRef[];
  /** Clinical staff only; absent (not inferred) for observations recorded before colour calibration existed. */
  colour_calibration?: ColourCalibration | null;
  ai_visual_observations?: AiVisualObservation[];
  provisional_hidden_for_non_clinician: boolean;
  /** Set when the upload is byte-identical to a generated demo phantom. */
  synthetic_demo_image?: "synthetic_phantom" | "simulated_followup" | "simulated_deterioration" | null;
}

export interface ApprovedTimelinePoint {
  observation_id: string;
  capture_datetime_utc: string;
  capture_location_category: string;
  uploading_user_subject: string;
  reviewing_clinician_subject: string;
  area_cm2: number;
  length_cm: number;
  width_cm: number;
  clinical_length_cm?: number | null;
  clinical_width_cm?: number | null;
  perimeter_cm?: number | null;
  source_model: string;
  was_human_corrected: boolean;
  delta_from_previous_cm2: number;
  /** Null when the previous verified area was 0 cm² (a percentage from zero is undefined). */
  delta_from_previous_pct: number | null;
  /** Clinician-verified "no visible open wound". */
  zero_area?: boolean;
  /** An open wound verified after a verified 0 cm². */
  reopened?: boolean;
  /** What the approved boundary outlines; null when it was never recorded. */
  measurement_region?: MeasurementRegion | null;
}

export interface CarePlanRecord {
  care_plan_id: string;
  version_number: number;
  title: string;
  purpose: string;
  approved_instructions: string;
  responsible_clinician_subject: string;
  assigned_caregiver_subject: string;
  task_frequency: string;
  start_date: string;
  review_date: string;
  status: string;
}

export interface CareTaskRecord {
  task_id: string;
  care_plan_id: string;
  title: string;
  instructions: string;
  frequency: string;
  due_at_utc: string;
  status: string;
  completed_by_subject?: string | null;
  completed_at_utc?: string | null;
  caregiver_notes?: string | null;
}

export interface UnreviewedObservation {
  observation_id: string;
  capture_datetime_utc: string;
  capture_location_category: string;
  uploading_user_subject: string;
  review_state: ReviewState;
  quality_status: string;
  provisional_area_cm2?: number | null;
}

export interface WoundSummary {
  wound_id: string;
  wound_code: string;
  patient_id: string;
  anatomical_site: string;
  laterality: string;
  wound_type: string;
  pressure_injury_stage: string;
  status: string;
}

export interface WoundDetail {
  allowed_actions?: string[];
  wound_id: string;
  wound_code: string;
  patient_id: string;
  anatomical_site: string;
  laterality: string;
  wound_type: string;
  pressure_injury_stage: string;
  /** ACTIVE, or HEALED after explicit clinician confirmation (reopened to ACTIVE if it recurs). */
  status: string;
  healed_at_utc?: string | null;
  healed_by_subject?: string | null;
  reopened_at_utc?: string | null;
  created_at_utc?: string;
  observations: ObservationRecord[];
  approved_timeline: ApprovedTimelinePoint[];
  unreviewed_observations: UnreviewedObservation[];
  care_plans: CarePlanRecord[];
  care_tasks: CareTaskRecord[];
  healing_epistemic_notice: string;
  /** Server-built from this viewer's own projection of the record (wound_summary.py). */
  care_summary?: WoundCareSummary;
}

// ---- Wound care summary (care now, progress, issues, next action) ---------------------------------

export interface SummaryPerson { subject?: string; name: string; role?: string }

export interface SummaryPoint {
  observation_id: string;
  ref: string;
  date_utc: string;
  area_cm2: number;
  region: MeasurementRegion | null;
  length_cm?: number;
  width_cm?: number;
  perimeter_cm?: number | null;
  source_model?: string | null;
  boundary_edited_by_clinician?: boolean;
  verified_by?: SummaryPerson | null;
}

/** One progress-summary version (staff); caregivers and patients receive only the approved text. */
export interface SummaryNarrative {
  report_id?: string;
  version_number: number;
  status?: ClinicalReport["status"];
  generator?: string;
  created_by?: SummaryPerson;
  created_at_utc?: string;
  text: string;
  source?: string;
  source_refs?: string[];
  ai_assisted?: boolean;
  signed_by_name?: string | null;
  signed_by_role?: string | null;
  signed_at_utc?: string | null;
  content_sha256?: string | null;
  supersedes_report_id?: string | null;
  superseded_by?: string;
  rejection_reason?: string | null;
  revision_reason?: string | null;
  based_on_observation_id?: string | null;
  consistency?: ClinicalReport["consistency"];
  /** Written for the latest verified visit (false: an earlier summary). */
  current?: boolean;
}

export interface SummaryIssue {
  kind: string;
  /** reported = not verified by a clinician; pending = awaiting action; documented = from the plan; missing = evidence gap. */
  status: "reported" | "pending" | "documented" | "missing";
  label: string;
  detail?: string | null;
  date_utc?: string | null;
  priority?: "high" | null;
  observation_id?: string;
  task_id?: string;
}

export interface SummaryAction {
  kind: string;
  label: string;
  responsible?: SummaryPerson | null;
  due_utc?: string | null;
  since_utc?: string;
  overdue?: boolean;
  frequency?: string;
  count?: number;
  observation_id?: string;
}

export interface WoundCareSummary {
  as_of_utc: string;
  latest_verified: SummaryPoint | null;
  trend: { value: string; observation_id: string; assessed_at_utc?: string | null; assessed_by_name?: string | null; assessed_by_role?: string | null } | null;
  latest_assessment_at_utc: string | null;
  review_state: { code: string; label: string; tone: "neutral" | "info" | "success" | "warning" | "danger"; count: number };
  care_now:
    | { available: false; message: string }
    | {
        available: true; care_plan_id: string; version_number: number; title: string; purpose: string; instructions: string;
        frequency: string; responsible_clinician: SummaryPerson | null; assigned_caregiver: SummaryPerson | null;
        approved_at_utc?: string | null; start_date?: string | null; review_date?: string | null; review_overdue: boolean; pending_tasks: number;
      };
  progress: {
    latest: SummaryPoint | null;
    previous_same_region: SummaryPoint | null;
    change: { cm2: number; pct: number | null; days: number | null } | null;
    compared: boolean;
    not_compared_reason: "different_region" | "region_not_recorded" | "first_measurement" | null;
    facts_text: string;
    narrative: SummaryNarrative | null;
  };
  issues: SummaryIssue[];
  next_actions: SummaryAction[];
  measurement_details: {
    approved_visit_count: number; region: MeasurementRegion | null; excluded_other_region: number; unrecorded_region: number;
    image_integrity_verified: boolean | null; notice?: string;
  };
  narrative_draft?: SummaryNarrative | null;
  narrative_versions?: SummaryNarrative[];
}

/** Draft types the shared AI editor supports (server: REVISION_TYPE_RULES). */
export type DraftType = "summary_progress" | "care_instructions" | "clinical_note" | "visual_observations" | "report_section";

/** Ask AI result: a suggestion only. Nothing in the record has changed. */
export interface DraftRevision {
  revision_id: string;
  draft_type: DraftType;
  suggestion: string;
  change_summary: string;
  flags: { unsupported_numbers: string[]; new_clinical_terms: string[]; scope_statements: string[]; removed_uncertainty: string[] };
  model: string;
  latency_ms: number;
  notice: string;
}

export interface AccessGrantRecord {
  grant_id: string;
  grantee_subject: string;
  granted_role: string;
  permissions_json: string;
  status: string;
  invited_by_subject: string;
  accepted_at_utc?: string | null;
  expires_at_utc?: string | null;
  revoked_at_utc?: string | null;
  revocation_reason?: string | null;
  legal_basis_note: string;
}

export interface ReviewInboxItem {
  review_request_id: string;
  observation_id: string;
  wound_id: string;
  submitted_by_subject: string;
  submitted_from_location: string;
  status: ReviewState;
  priority_level: "RED" | "YELLOW" | "GREEN" | string;
  concern_summary: string;
  created_at_utc: string;
  reviewed_by_subject?: string | null;
  reviewed_at_utc?: string | null;
}

/** Identity fields are minimised by the server for each viewer; optional ones may be absent. */
export interface PatientSummary {
  patient_id: string;
  patient_code: string;
  display_name: string;
  full_name?: string | null;
  org_id: string;
  org_name?: string | null;
  date_of_birth?: string | null;
  hospital_number?: string | null;
  national_id_masked?: string | null;
  has_national_id?: boolean;
  no_national_id_reason?: string | null;
  age_group?: string;
  sex?: string;
  ward_code?: string;
  primary_clinician_subject?: string;
  patient_account_subject?: string | null;
  is_fictional_demo?: number;
  on_care_team?: boolean;
}

export interface PatientSearchResult {
  results: PatientSummary[];
  truncated: boolean;
  needs_verification: boolean;
}

export interface DuplicateMatch {
  patient: PatientSummary;
  reasons: string[];
}

export interface DuplicateCheckResult {
  exact_matches: DuplicateMatch[];
  possible_matches: DuplicateMatch[];
  conflict_outside_scope: boolean;
}

export interface ReviewQueueItem {
  review_request_id: string;
  observation_id: string;
  patient_id: string;
  wound_id: string;
  wound_code: string;
  anatomical_site: string;
  submitted_by_subject: string;
  submitted_from_location: string;
  status: string;
  priority_level: string;
  concern_summary: string;
  created_at_utc: string;
  patient: PatientSummary;
}

export interface AccessRelation {
  relation: "CARE_TEAM" | "SAME_ORGANISATION" | "OWN_RECORD" | "SHARED_ACCESS";
  label: string;
  expires_at_utc?: string | null;
}

export interface PatientCompleteRecord {
  fictional_data_disclaimer: string;
  viewer: {
    subject: string;
    display_name: string;
    role: string;
    org_id: string;
    is_clinical: boolean;
  };
  patient: PatientSummary;
  access: AccessRelation;
  care_team: Array<{
    user_subject: string;
    org_id: string;
    team_role: string;
    relationship_label: string;
  }>;
  access_grants: AccessGrantRecord[];
  wounds: WoundDetail[];
  review_inbox: ReviewInboxItem[];
  notifications: Array<{
    notification_id: string;
    notification_type: string;
    safe_preview_title: string;
    safe_preview_body: string;
    created_at_utc: string;
  }>;
  audit_history: Array<{
    event_id: string;
    timestamp_utc: string;
    actor_subject: string;
    actor_role: string;
    action: string;
    entity_type: string;
    entity_id: string;
    outcome?: string;
  }>;
}

export interface DemoStepLog {
  step: number;
  title: string;
  actor: string;
  outcome: string;
}
