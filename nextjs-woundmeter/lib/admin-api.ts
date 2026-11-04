import type { PermissionPolicy } from "@/lib/accounts";
import { apiGet, apiPost } from "@/lib/care-api";

export interface AdminUser {
  subject: string;
  username: string;
  display_name: string;
  email?: string | null;
  role: string;
  org_id: string;
  org_name?: string | null;
  active: boolean;
  wards: string[];
  granted_permissions: string[];
  effective_permissions: string[];
  qualification_title?: string | null;
  license_number?: string | null;
  qualification_verified_at?: string | null;
  qualification_verified_by?: string | null;
  mfa_enabled: boolean;
  requires_mfa: boolean;
  locked: boolean;
  last_login_at_utc?: string | null;
  is_demo_account: boolean;
}

export interface Organisation {
  org_id: string;
  code: string;
  name: string;
  org_type: string;
  member_count: number;
  wards: Array<{ ward_code: string; name: string }>;
}

export interface AssignablePatient {
  patient_id: string;
  patient_code: string;
  hospital_number?: string | null;
  org_id: string;
  org_name: string;
  team_size: number;
}

export interface CareTeamMember {
  user_subject: string;
  display_name: string;
  role: string;
  relationship_label: string;
  org_id: string;
}

export interface AuditEvent {
  event_id: string;
  timestamp_utc: string;
  actor_subject: string;
  actor_role: string;
  action: string;
  entity_type: string;
  entity_id?: string | null;
  patient_id?: string | null;
  outcome: string;
  detail_json: string;
}

export interface SecuritySettings {
  demo_mode: boolean;
  identifier_keys_configured: boolean;
  session_idle_minutes: number;
  session_absolute_hours: number;
  max_failed_logins: number;
  mfa_policy: string;
  password_hashing: string;
  identifier_protection: string;
}

export interface StorageDiagnostics {
  database_path: string;
  private_storage_path: string;
  table_counts: Record<string, number>;
  integrity_check: string[];
  foreign_key_violations: number;
  image_references: number;
  missing_images: number;
  unsafe_image_paths: number;
  image_hash_mismatches: number;
}

export const admin = {
  storage: () => apiGet<StorageDiagnostics>("admin/storage"),
  permissionPolicy: () => apiGet<PermissionPolicy>("admin/permission-policy"),
  users: () => apiGet<{ users: AdminUser[] }>("admin/users").then((d) => d.users),
  createUser: (u: { username: string; display_name: string; role: string; org_id: string; temporary_password: string }) =>
    apiPost<AdminUser>("admin/users", u),
  updateUser: (subject: string, changes: { role?: string; org_id?: string; active?: boolean; wards?: string[] }) =>
    apiPost<AdminUser>(`admin/users/${subject}`, changes),
  setQualification: (subject: string, q: { title: string; license_number: string; verified: boolean }) =>
    apiPost<AdminUser>(`admin/users/${subject}/qualification`, q),
  setPermissions: (subject: string, permissions: string[]) =>
    apiPost<AdminUser>(`admin/users/${subject}/permissions`, { permissions }),
  resetPassword: (subject: string, temporary_password: string) =>
    apiPost<AdminUser>(`admin/users/${subject}/reset-password`, { temporary_password }),
  organisations: () => apiGet<{ organisations: Organisation[] }>("admin/organisations").then((d) => d.organisations),
  patients: () => apiGet<{ patients: AssignablePatient[] }>("admin/patients").then((d) => d.patients),
  careTeam: (patientId: string) =>
    apiGet<{ members: CareTeamMember[] }>(`admin/patients/${patientId}/care-team`).then((d) => d.members),
  assign: (patientId: string, user_subject: string, relationship_label: string) =>
    apiPost<{ members: CareTeamMember[] }>(`admin/patients/${patientId}/care-team`, { user_subject, relationship_label }).then(
      (d) => d.members,
    ),
  unassign: (patientId: string, userSubject: string) =>
    apiPost<{ members: CareTeamMember[] }>(`admin/patients/${patientId}/care-team/${userSubject}/remove`, {}).then(
      (d) => d.members,
    ),
  audit: (params: { limit?: number; actor?: string; outcome?: string }) => {
    const query: Record<string, string> = { limit: String(params.limit ?? 100) };
    if (params.actor) query.actor = params.actor;
    if (params.outcome) query.outcome = params.outcome;
    return apiGet<{ events: AuditEvent[] }>("admin/audit", query).then((d) => d.events);
  },
  settings: () => apiGet<SecuritySettings>("admin/settings"),
};
