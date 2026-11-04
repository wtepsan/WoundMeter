// Client for the inpatient nursing API. Same proxy and session cookie as lib/care-api.ts;
// FastAPI enforces role, ward, shift and patient access on every call.

import { apiGet, apiPost } from "@/lib/care-api";
import type {
  Admission,
  AdmissionDetail,
  AdmissionReport,
  AssessmentPayload,
  AssessmentPreview,
  AssessmentType,
  CareActivity,
  NursingAssessment,
  NursingContext,
  PatientNursingSummary,
  WardBoardRow,
} from "@/lib/nursing-types";

export interface AdmissionRequest {
  bed: string;
  ward_code?: string;
  target_wound_location: string;
  baseline_wound_status: string;
  individual_care_plan_available: boolean;
  family_participation_enabled: boolean;
}

export const nursing = {
  context: () => apiGet<NursingContext>("nursing/context"),
  startShift: (ward_code: string, shift: string) => apiPost<NursingContext>("nursing/shifts", { ward_code, shift }),
  endShift: (shiftId: string) => apiPost<NursingContext>(`nursing/shifts/${shiftId}/end`, {}),
  wardBoard: (wardCode: string) =>
    apiGet<{ ward_code: string; context: NursingContext; admissions: WardBoardRow[] }>(`nursing/wards/${wardCode}/board`),
  admissions: async (status: "active" | "discharged" | "all", ward_code?: string) =>
    (await apiGet<{ admissions: Admission[] }>("nursing/admissions", ward_code ? { status, ward_code } : { status })).admissions,
  patient: (patientId: string) => apiGet<PatientNursingSummary>(`nursing/patients/${patientId}`),
  admit: (patientId: string, body: AdmissionRequest) => apiPost<AdmissionDetail>(`nursing/patients/${patientId}/admissions`, body),
  admission: (admissionId: string) => apiGet<AdmissionDetail>(`nursing/admissions/${admissionId}`),
  report: (admissionId: string) => apiGet<AdmissionReport>(`nursing/admissions/${admissionId}/report`),
  transfer: (admissionId: string, ward_code: string, bed: string) =>
    apiPost<AdmissionDetail>(`nursing/admissions/${admissionId}/transfer`, { ward_code, bed }),
  discharge: (admissionId: string, reason: string, exception_reason?: string) =>
    apiPost<AdmissionDetail>(`nursing/admissions/${admissionId}/discharge`, { reason, exception_reason: exception_reason || null }),
  preview: (admissionId: string, assessment_type: AssessmentType, payload: AssessmentPayload) =>
    apiPost<AssessmentPreview>(`nursing/admissions/${admissionId}/assessments/preview`, { assessment_type, payload }),
  submit: (admissionId: string, assessment_type: AssessmentType, payload: AssessmentPayload) =>
    apiPost<NursingAssessment>(`nursing/admissions/${admissionId}/assessments`, { assessment_type, payload }),
  setCareChecklist: (assessmentId: string, activities: Array<Pick<CareActivity, "activity_type" | "critical"> & { due_at: string }>) =>
    apiPost<{ care_activities: CareActivity[] }>(`nursing/assessments/${assessmentId}/care-checklist`, { activities }),
  completeActivity: (activityId: string) => apiPost<CareActivity>(`nursing/care-activities/${activityId}/complete`, {}),
  activityUnable: (activityId: string, reason: string) =>
    apiPost<CareActivity>(`nursing/care-activities/${activityId}/unable`, { reason }),
};
