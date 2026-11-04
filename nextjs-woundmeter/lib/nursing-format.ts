// Display labels and coded options for the inpatient nursing module. The option values are the
// codes the API validates (fastapi-woundmeter/app/services/nursing_service.py).

import type { Tone } from "@/lib/care-format";
import type { Priority, TodayStatus } from "@/lib/nursing-types";

export const SHIFT_OPTIONS = [
  { value: "DAY", label: "Day" },
  { value: "EVENING", label: "Evening" },
  { value: "NIGHT", label: "Night" },
] as const;

export const QUICK_ASSESSMENT_FIELDS = [
  {
    key: "skin_status",
    label: "Skin status",
    options: [["STABLE", "Stable"], ["REDNESS", "Redness"], ["WORSENING", "Worsening"], ["NOT_ASSESSED", "Not assessed"]],
  },
  {
    key: "wound_trend",
    label: "Wound trend",
    options: [["STABLE", "Stable"], ["IMPROVING", "Improving"], ["WORSENING", "Worsening"], ["NEW_WOUND", "New wound"], ["NOT_ASSESSED", "Not assessed"]],
  },
  {
    key: "pain_issue",
    label: "Pain",
    options: [["NO", "No"], ["YES_CONTROLLED", "Yes, controlled"], ["YES_UNCONTROLLED", "Yes, uncontrolled"], ["NOT_ASSESSED", "Not assessed"]],
  },
  {
    key: "moisture_issue",
    label: "Moisture problem",
    options: [["NO", "No"], ["YES_MANAGED", "Yes, managed"], ["YES_UNMANAGED", "Yes, unmanaged"], ["NOT_ASSESSED", "Not assessed"]],
  },
  {
    key: "mobility_issue",
    label: "Mobility",
    options: [["INDEPENDENT", "Independent"], ["LIMITED", "Limited"], ["DEPENDENT", "Dependent"], ["NOT_ASSESSED", "Not assessed"]],
  },
] as const;

export const TARGET_WOUND_LOCATIONS = [
  ["NOT_APPLICABLE", "No target wound"],
  ["SACRUM", "Sacrum"],
  ["COCCYX", "Coccyx"],
  ["HEEL", "Heel"],
  ["TROCHANTER", "Trochanter"],
  ["OTHER", "Other"],
] as const;

export const BASELINE_WOUND_STATUSES = [
  ["NO_WOUND", "No wound"],
  ["STAGE_1", "Stage 1"],
  ["STAGE_2", "Stage 2"],
  ["STAGE_3", "Stage 3"],
  ["STAGE_4", "Stage 4"],
  ["UNSTAGEABLE", "Unstageable"],
  ["DEEP_TISSUE_INJURY", "Deep tissue injury"],
  ["NOT_ASSESSED", "Not assessed"],
] as const;

export const OVERRIDE_REASONS = [
  ["CLINICAL_JUDGMENT", "Clinical judgement"],
  ["PATIENT_CONDITION", "Patient condition"],
  ["WORKFLOW_CONTEXT", "Workflow context"],
  ["DATA_ERROR", "Data error"],
  ["OTHER", "Other"],
] as const;

export const CARE_ACTIVITY_LABELS: Record<string, string> = {
  POSITIONING: "Repositioning",
  PRESSURE_REDUCTION: "Pressure reduction",
  WOUND_CARE: "Wound care",
  ESCALATION: "Escalation",
};

export const ASSESSMENT_TYPE_LABELS: Record<string, string> = {
  ADMISSION: "Admission assessment",
  DAILY: "Daily assessment",
  REASSESSMENT: "Reassessment",
};

const PRIORITY_TONES: Record<Priority, Tone> = { RED: "danger", YELLOW: "warning", GREEN: "success" };

export function priorityBadge(priority: Priority | null | undefined): { label: string; tone: Tone } {
  if (!priority) return { label: "Not assessed", tone: "neutral" };
  return { label: `${priority.charAt(0)}${priority.slice(1).toLowerCase()}`, tone: PRIORITY_TONES[priority] };
}

export function todayStatusBadge(status: TodayStatus): { label: string; tone: Tone } {
  switch (status) {
    case "COMPLETED":
      return { label: "Today's assessment done", tone: "success" };
    case "OVERDUE":
      return { label: "Admission assessment overdue", tone: "danger" };
    case "DUE_TODAY":
      return { label: "Assessment due today", tone: "warning" };
    default:
      return { label: "Not admitted", tone: "neutral" };
  }
}

export function admissionStatusBadge(status: string): { label: string; tone: Tone } {
  switch (status) {
    case "PENDING_ASSESSMENT":
      return { label: "Awaiting admission assessment", tone: "warning" };
    case "ACTIVE":
      return { label: "Admitted", tone: "info" };
    case "DISCHARGED":
      return { label: "Discharged", tone: "neutral" };
    default:
      return { label: status, tone: "neutral" };
  }
}

export function optionLabel(options: ReadonlyArray<readonly [string, string]>, value: string | null | undefined): string {
  return options.find(([code]) => code === value)?.[1] ?? (value ?? "—");
}
