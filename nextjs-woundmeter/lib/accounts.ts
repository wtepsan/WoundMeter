// Role → portal mapping and display labels. This only decides which navigation to show;
// FastAPI enforces every permission.

// Fixed at build time by next.config.ts from WOUNDMETER_DEMO_MODE (Compose build arg / root .env).
// Off unless explicitly "true". It only shows or hides demo screens; FastAPI enforces demo mode itself.
export const DEMO_MODE = process.env.NEXT_PUBLIC_WOUNDMETER_DEMO === "true";
// Synthetic demo photos and the fictional P001 patient are not installed in this deployment.
export const DEMO_SAMPLE_DATA = false;

export type Portal = "admin" | "clinical" | "caregiver" | "patient" | "research";

export type PermissionPolicy = {
  modules: Record<string, string>;
  permissions: Record<string, { label: string; detail: string; module: string }>;
  bundles: Record<string, { label: string; permissions: string[] }>;
  dependencies: Record<string, string[]>;
};

export type Account = {
  subject: string;
  username: string;
  display_name: string;
  role: string;
  org_id: string;
  org_name?: string | null;
  wards: string[];
  permissions: string[];
  permission_policy?: PermissionPolicy;
  qualification_verified: boolean;
  qualification_title?: string | null;
  mfa_verified: boolean;
  mfa_enabled?: boolean;
  is_demo_account: boolean;
  can_confirm_clinical: boolean;
};

export const MEDICAL_ROLES = new Set(["CLINICIAN", "NURSE", "SUPERVISOR", "HOME_CARE_PROFESSIONAL"]);

/** Inpatient nursing (ward board, admissions, nursing assessments) is for qualified ward nurses and supervisors. */
export function isWardNurse(account: Pick<Account, "role" | "permissions">): boolean {
  return (account.role === "NURSE" || account.role === "SUPERVISOR") && can(account, "ASSESS");
}

export function portalForRole(role: string): Portal {
  if (role === "ADMIN") return "admin";
  if (MEDICAL_ROLES.has(role)) return "clinical";
  if (role === "FAMILY_CAREGIVER") return "caregiver";
  if (role === "PATIENT") return "patient";
  return "research";
}

export function can(account: Pick<Account, "permissions">, permission: string): boolean {
  return account.permissions.includes(permission);
}

const ROLE_LABELS: Record<string, string> = {
  NURSE: "Nurse",
  CLINICIAN: "Physician",
  SUPERVISOR: "Nurse supervisor",
  HOME_CARE_PROFESSIONAL: "Community nurse",
  ADMIN: "Administrator",
  FAMILY_CAREGIVER: "Home caregiver",
  PATIENT: "Patient",
  RESEARCHER: "Researcher",
};

export function roleLabel(role: string): string {
  return ROLE_LABELS[role] ?? role;
}

export const ROLE_OPTIONS = Object.keys(ROLE_LABELS);

export interface DemoAccount {
  username: string;
  name: string;
  role: string;
  summary: string;
}

/** Designated one-click demo accounts (fastapi-woundmeter/app/services/demo_accounts.py). */
export const DEMO_ACCOUNTS: DemoAccount[] = [
  { username: "admin.demo", name: "Administrator", role: "ADMIN", summary: "Manages demo accounts, roles and care teams. No clinical access." },
  { username: "clinician.somchai", name: "Dr. Somchai", role: "CLINICIAN", summary: "Physician. Registers patients, reviews, signs off, diagnoses and prescribes." },
  { username: "nurse.ward01", name: "Nurse Mali", role: "NURSE", summary: "Ward nurse. Registers patients, captures, assesses and signs off; inpatient nursing." },
  { username: "caregiver.suda", name: "Suda", role: "FAMILY_CAREGIVER", summary: "Home caregiver. Sees only patients a clinician has shared with this account." },
];

const DEMO_NAMES = new Map(DEMO_ACCOUNTS.map((a) => [a.username, a.name] as const));

const PEOPLE: Record<string, string> = {
  "nurse.ward01": "Nurse Mali",
  "nurse.ward02": "Nurse Anong",
  "supervisor.ward01": "Supervisor Arun",
  "clinician.somchai": "Dr. Somchai",
  "homecare.nida": "RN Nida",
  "admin.demo": "Administrator",
  "caregiver.suda": "Suda (caregiver)",
  "patient.p001": "Patient P001",
  "researcher.demo": "Researcher",
  "caregiver.unassigned": "Unassigned caregiver",
  "clinician.other_org": "External clinician",
};

/** Short name for the signed-in account's header; falls back to the server's display name. */
export function accountName(account: Pick<Account, "subject" | "display_name">): string {
  return DEMO_NAMES.get(account.subject) ?? account.display_name;
}

export function personName(subject: string | null | undefined): string {
  if (!subject) return "—";
  return PEOPLE[subject] ?? subject;
}
