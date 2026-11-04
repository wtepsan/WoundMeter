// Response shapes of the inpatient nursing API (/v2/nursing, fastapi-woundmeter/app/services/nursing_service.py).

export type Priority = "RED" | "YELLOW" | "GREEN";
export type AssessmentType = "ADMISSION" | "DAILY" | "REASSESSMENT";
export type TodayStatus = "COMPLETED" | "DUE_TODAY" | "OVERDUE" | "NOT_APPLICABLE";

export interface Ward {
  code: string;
  name: string;
}

export interface NursingContext {
  wards: Ward[];
  active_shift: { shift_id: string; ward_code: string; shift: string; started_at_utc: string } | null;
  clinical_date: string;
  can_authorise_discharge_exception: boolean;
}

export interface Admission {
  admission_id: string;
  admission_code: string;
  patient_id: string;
  patient_code: string | null;
  patient_name: string | null;
  hospital_number: string | null;
  ward_code: string;
  ward_name: string | null;
  bed: string;
  status: "PENDING_ASSESSMENT" | "ACTIVE" | "DISCHARGED" | "CANCELLED";
  admitted_at_utc: string;
  consent_state: string;
  target_wound_location: string;
  baseline_wound_status: string;
  individual_care_plan_available: boolean;
  family_participation_enabled: boolean;
  discharge_at_utc: string | null;
  discharge_reason: string | null;
  discharge_exception_reason: string | null;
  version: number;
}

export interface WardBoardRow extends Admission {
  today_status: TodayStatus;
  priority: Priority | null;
  braden_total: number | null;
  next_review_at_utc: string | null;
  overdue_critical_care: boolean;
}

export interface CareActivity {
  activity_id: string;
  assessment_id: string;
  activity_type: "POSITIONING" | "PRESSURE_REDUCTION" | "WOUND_CARE" | "ESCALATION";
  critical: boolean;
  status: "PLANNED" | "COMPLETED" | "UNABLE";
  due_at_utc: string;
  completed_at_utc: string | null;
  unable_reason: string | null;
  performed_by: string | null;
}

export interface QuickAssessment {
  red_flag_present: boolean;
  new_abnormality: boolean;
  skin_status: string;
  wound_trend: string;
  pain_issue: string;
  moisture_issue: string;
  mobility_issue: string;
}

export interface BradenScores {
  sensory_perception: number;
  moisture: number;
  activity: number;
  mobility: number;
  nutrition: number;
  friction_and_shear: number;
}

export interface NursingAssessment {
  assessment_id: string;
  admission_id: string;
  assessment_type: AssessmentType;
  assessment_date: string;
  submitted_at_utc: string;
  submitted_by: string;
  quick_assessment: QuickAssessment;
  braden: BradenScores & { total: number; risk_band: string; version: string };
  priority: {
    system: Priority;
    nurse: Priority;
    agreement: boolean;
    override: boolean;
    override_direction: string;
    override_reason: string | null;
    reason_codes: string[];
    suggested_review_minutes: number;
    next_review_at_utc: string;
    rule_version: string;
  };
}

export interface TimelineEvent {
  type: "ASSESSMENT" | "ADMISSION" | "DISCHARGE";
  occurred_at_utc: string;
  assessment_type?: AssessmentType;
  priority?: Priority;
  braden_total?: number;
  by?: string;
  status?: string;
  reason?: string | null;
}

export interface AdmissionDetail {
  admission: Admission;
  today: { assessment_date: string; status: TodayStatus };
  overdue_critical_care: boolean;
  latest_assessment: NursingAssessment | null;
  care_activities: CareActivity[];
  timeline: TimelineEvent[];
}

export interface PatientNursingSummary {
  patient_id: string;
  context: NursingContext;
  current: AdmissionDetail | null;
  admitted_elsewhere: { ward_code: string; admission_code: string } | null;
  admissions: Admission[];
}

export interface AssessmentPayload extends QuickAssessment, BradenScores {
  nurse_priority?: Priority;
  override_reason?: string;
  next_review_at?: string;
}

export interface AssessmentPreview {
  braden_total: number;
  braden_risk_band: string;
  braden_version: string;
  system_priority: Priority;
  priority_reason_codes: string[];
  suggested_review_minutes: number;
  rule_version: string;
  assessment_date: string;
}

export interface AdmissionReport {
  generated_at_utc: string;
  patient: {
    patient_code: string;
    patient_name: string;
    hospital_number: string | null;
    age_group: string | null;
    sex: string | null;
    is_fictional_demo: boolean;
  };
  admission: Admission;
  assessments: Array<NursingAssessment & { care_activities: CareActivity[] }>;
}
