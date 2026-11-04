import { apiGet, apiPost } from "@/lib/care-api";

export type RecordType = "observation" | "report" | "wound";
export interface DeletedRecord {
  deletion_id: string;
  record_type: RecordType;
  record_id: string;
  patient_id: string;
  patient_code: string;
  wound_id: string;
  wound_code: string;
  previous_status: string;
  disposition: "DELETED" | "VOIDED";
  deleted_by_subject: string;
  deleted_at_utc: string;
  deletion_reason: string;
  restore_authorized_by?: string | null;
  restore_authorized_at_utc?: string | null;
}
export const deleteRecord = (type: RecordType, id: string, reason: string, expectedStatus: string) =>
  apiPost<DeletedRecord>(`care/records/${type}/${id}/delete`, { reason, expected_status: expectedStatus });
export const deletedRecords = (patientId?: string) =>
  apiGet<{ records: DeletedRecord[] }>(patientId ? `care/patients/${patientId}/deleted-records` : "admin/deleted-records")
    .then((r) => r.records);
export const authorizeRestoration = (id: string, reason: string) =>
  apiPost<DeletedRecord>(`care/deleted-records/${id}/authorize-restore`, { reason });
export const restoreRecord = (id: string, reason: string) =>
  apiPost<DeletedRecord>(`admin/deleted-records/${id}/restore`, { reason });
