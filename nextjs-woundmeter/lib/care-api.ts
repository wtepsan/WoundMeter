// Client for the WoundMeter API. Identity travels in an httpOnly session cookie that page
// scripts cannot read; FastAPI resolves the caller from it and enforces every permission.

import type { Account } from "@/lib/accounts";
import type { AttestationKey } from "@/lib/approval-attestations";
import type {
  AiVisualObservation,
  AssistantAnswer,
  ClinicalReport,
  DraftRevision,
  DraftType,
  DuplicateCheckResult,
  MeasurementRegion,
  MeasurePreview,
  ObservationRecord,
  PatientCompleteRecord,
  PatientSearchResult,
  PatientSummary,
  ReviewQueueItem,
  Transcription,
  WoundSummary,
} from "@/lib/care-types";

// ---- Demo adapter -------------------------------------------------------------------------------
// The /demo page (demo mode only) shows the real record screen for one photo that is never saved.
// It registers this adapter; record actions on its "DEMO-" identifiers go to the stateless demo API
// instead of a stored record. Real identifiers never start with "DEMO-", so nothing else changes.

export interface DemoAdapter {
  submitObservation: (submission: ObservationSubmission) => Promise<ObservationRecord>;
  generateAiObservations: (observationId: string) => Promise<AiVisualObservation>;
  reviewAiObservations: (aiObservationId: string, body: Parameters<typeof reviewAiObservations>[1]) => Promise<AiVisualObservation>;
  reviseDraft: (body: Parameters<typeof reviseDraft>[2]) => Promise<DraftRevision>;
}
let demoAdapter: DemoAdapter | null = null;
export function setDemoAdapter(adapter: DemoAdapter | null) {
  demoAdapter = adapter;
}
const demoTarget = (id: string) => (demoAdapter && id.startsWith("DEMO-") ? demoAdapter : null);

export class CareApiError extends Error {
  code: string;
  status: number;
  body: Record<string, unknown>;

  constructor(code: string, message: string, status: number, body: Record<string, unknown> = {}) {
    super(message);
    this.code = code;
    this.status = status;
    this.body = body;
  }
}

async function parse<T>(res: Response): Promise<T> {
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const err = (body ?? {}) as { code?: string; message?: string };
    throw new CareApiError(
      err.code ?? `HTTP_${res.status}`,
      err.message ?? `Request failed (HTTP ${res.status}).`,
      res.status,
      (body ?? {}) as Record<string, unknown>,
    );
  }
  return body as T;
}

// ---- Connection --------------------------------------------------------------------------
// Whether the WoundMeter server answered the latest request. Only this flag is kept: responses
// are never stored for offline use, so a lost connection means "try again", never old data.

export const OFFLINE_MESSAGE = "You're offline, so nothing was sent. What you entered is still here; try again when you're connected.";
const UNREACHABLE_MESSAGE = "Couldn't reach WoundMeter. Check your connection, then try again.";
const UNCONFIRMED_MESSAGE = "The connection failed, so this wasn't confirmed. When you're back online, check the record before trying again.";

let reachable = true;
const connectionListeners = new Set<() => void>();

function setReachable(value: boolean) {
  if (reachable === value) return;
  reachable = value;
  connectionListeners.forEach((listener) => listener());
}

export const serverReachable = () => reachable;

export function subscribeConnection(listener: () => void) {
  connectionListeners.add(listener);
  return () => {
    connectionListeners.delete(listener);
  };
}

/** Asks the web server for its manifest, bypassing every cache (the service worker handles only GET). */
export async function checkConnection(): Promise<boolean> {
  try {
    await fetch("/manifest.json", { method: "HEAD", cache: "no-store" });
    setReachable(true);
  } catch {
    setReachable(false);
  }
  return reachable;
}

const deviceOffline = () => typeof navigator !== "undefined" && navigator.onLine === false;

/** Refuses before sending when the device is offline; a local server can still answer then. */
export async function assertOnline() {
  if (deviceOffline() && !(await checkConnection())) throw new CareApiError("OFFLINE", OFFLINE_MESSAGE, 0);
}

async function send(url: string, init: RequestInit): Promise<Response> {
  const changes = init.method === "POST";
  if (changes) await assertOnline();
  try {
    const res = await fetch(url, init);
    setReachable(true);
    return res;
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    setReachable(false);
    throw new CareApiError("NETWORK_ERROR", changes ? UNCONFIRMED_MESSAGE : UNREACHABLE_MESSAGE, 0);
  }
}

export async function apiGet<T>(endpoint: string, params: Record<string, string> = {}): Promise<T> {
  const query = new URLSearchParams({ endpoint, ...params });
  const res = await send(`/api/wound-workflow?${query.toString()}`, { cache: "no-store" });
  return parse<T>(res);
}

export async function apiPost<T>(endpoint: string, payload: unknown): Promise<T> {
  const res = await send("/api/wound-workflow", {
    method: "POST",
    cache: "no-store",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ endpoint, payload }),
  });
  return parse<T>(res);
}

/** Map a backend signed image URL (`/v2/care/images/ID?...`) onto the same-origin proxy. */
export function imageProxyUrl(signedUrl: string): string {
  // Demo images travel inline (never stored), so there is nothing to proxy.
  if (signedUrl.startsWith("data:") || signedUrl.startsWith("blob:")) return signedUrl;
  const [path, query = ""] = signedUrl.split("?");
  const endpoint = path.replace(/^\/?v2\//, "");
  const params = new URLSearchParams(query);
  params.delete("actor_subject");
  params.set("endpoint", endpoint);
  return `/api/wound-workflow?${params.toString()}`;
}

// ---- Authentication --------------------------------------------------------------------

async function authCall<T>(action: string, payload?: unknown): Promise<T> {
  const res = await send(`/api/auth/${action}`, {
    method: payload === undefined ? "GET" : "POST",
    cache: "no-store",
    headers: payload === undefined ? undefined : { "content-type": "application/json" },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  return parse<T>(res);
}

export type LoginResult =
  | { status: "authenticated"; account: Account }
  | { status: "mfa_required"; mfa_enrollment: { secret: string; otpauth_uri: string } | null };

export const auth = {
  session: () => authCall<{ account: Account | null }>("session"),
  login: (username: string, password: string) => authCall<LoginResult>("login", { username, password }),
  verifyMfa: (code: string) => authCall<{ status: "authenticated"; account: Account }>("mfa", { code }),
  demoLogin: (username: string) => authCall<{ status: "authenticated"; account: Account }>("demo-login", { username }),
  logout: () => authCall<{ status: string }>("logout", {}),
  changePassword: (current_password: string, new_password: string) =>
    authCall<{ status: string }>("change-password", { current_password, new_password }),
  forgotPassword: (username: string) => authCall<{ message: string }>("forgot-password", { username }),
  demoAccounts: () =>
    authCall<{ demo_mode: boolean; accounts: Array<{ username: string; display_name: string; role: string; summary: string }> }>(
      "demo-accounts",
    ),
};

// ---- Patients ----------------------------------------------------------------------------

export async function listPatients() {
  const data = await apiGet<{ patients: PatientSummary[] }>("care/patients");
  return data.patients;
}

export function getPatientRecord(patientId: string) {
  return apiGet<PatientCompleteRecord>(`care/patients/${patientId}`);
}

export type SearchType = "NATIONAL_ID" | "HN" | "NAME" | "REFERENCE";

export function searchPatients(search_type: SearchType, query: string, date_of_birth?: string) {
  return apiPost<PatientSearchResult>("care/patients/search", {
    search_type,
    query,
    date_of_birth: date_of_birth || null,
  });
}

export interface PatientRegistration {
  full_name: string;
  date_of_birth: string;
  national_id?: string | null;
  no_national_id_reason?: string | null;
  hospital_number?: string | null;
  contact_phone?: string | null;
  confirm_not_duplicate?: boolean;
  duplicate_override_reason?: string | null;
}

export function checkDuplicates(reg: Pick<PatientRegistration, "full_name" | "date_of_birth" | "national_id" | "hospital_number">) {
  return apiPost<DuplicateCheckResult>("care/patients/duplicate-check", reg);
}

export function registerPatient(reg: PatientRegistration) {
  return apiPost<PatientSummary>("care/patients", reg);
}

export function registerWound(
  patientId: string,
  wound: { anatomical_site: string; laterality: string; wound_type: string; pressure_injury_stage: string },
) {
  return apiPost<WoundSummary>(`care/patients/${patientId}/wounds`, wound);
}

export async function reviewQueue() {
  const data = await apiGet<{ items: ReviewQueueItem[] }>("care/review-queue");
  return data.items;
}

// ---- Observations & review -------------------------------------------------------------------

export interface ObservationSubmission {
  corrects_observation_id?: string;
  correction_reason?: string;
  capture_location_category: "HOSPITAL" | "HOME" | "COMMUNITY";
  image_base64?: string;
  image_variant?: "hospital_baseline" | "home_followup_day4" | "incomplete_ruler" | "colour_strip_phantom";
  pain_score_0_10?: number | null;
  drainage_level?: "NONE" | "SMALL" | "MODERATE" | "LARGE" | "UNSURE";
  dressing_condition?: "INTACT" | "LOOSE" | "WET" | "OTHER" | "UNSURE";
  redness_observed?: "YES" | "NO" | "UNSURE";
  concern_reported?: boolean;
  non_diagnostic_notes?: string;
}

type PendingSubmission = { id: string; fingerprint: string };
export type SubmissionOutcome = {
  submission_id: string;
  status: "NOT_FOUND" | "PROCESSING" | "FAILED" | "SUCCEEDED";
  observation: ObservationRecord | null;
  error_code?: string | null;
};
const submissionKey = (patientId: string, woundId: string) => `ww_submission:${patientId}:${woundId}`;
export function pendingSubmission(patientId: string, woundId: string): PendingSubmission | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(submissionKey(patientId, woundId)) ?? "null") as PendingSubmission | null;
    return value && typeof value.id === "string" && typeof value.fingerprint === "string" ? value : null;
  } catch { return null; }
}
export function clearPendingSubmission(patientId: string, woundId: string) {
  try { sessionStorage.removeItem(submissionKey(patientId, woundId)); } catch { /* storage unavailable */ }
}
export function submissionStatus(patientId: string, woundId: string, id: string) {
  return apiGet<SubmissionOutcome>(`care/patients/${patientId}/wounds/${woundId}/submissions/${id}`);
}

export async function submitObservation(patientId: string, woundId: string, submission: ObservationSubmission) {
  const demo = demoTarget(patientId);
  if (demo) return demo.submitObservation(submission);
  // Offline: refuse before an upload identity is recorded, since nothing will have been sent.
  await assertOnline();
  // The backend default SAM strategy locates the wound, then refines its whole boundary (box + point).
  const payload = { segmentation_mode: "compare", ...submission };
  const bytes = new TextEncoder().encode(JSON.stringify(Object.fromEntries(Object.entries(payload).sort(([a], [b]) => a.localeCompare(b)))));
  const fingerprint = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (b) => b.toString(16).padStart(2, "0")).join("");
  let pending = pendingSubmission(patientId, woundId);
  if (pending) {
    const outcome = await submissionStatus(patientId, woundId, pending.id);
    if (outcome.status === "SUCCEEDED" && outcome.observation) {
      clearPendingSubmission(patientId, woundId);
      return outcome.observation;
    }
    if (outcome.status === "PROCESSING") {
      throw new CareApiError("SUBMISSION_PROCESSING", "Your earlier submission is still processing. Check its status before sending again.", 409);
    }
    if (pending.fingerprint !== fingerprint) {
      if (outcome.status !== "FAILED") {
        throw new CareApiError("SUBMISSION_UNRESOLVED", "The earlier request has no confirmed outcome. Restore the same photo and report before retrying, or check its status again.", 409);
      }
      pending = null;
    }
  }
  pending ??= { id: crypto.randomUUID(), fingerprint };
  // Only an opaque request ID and digest survive reload; never store the photo/report.
  try {
    sessionStorage.setItem(submissionKey(patientId, woundId), JSON.stringify(pending));
  } catch { /* storage unavailable: the in-page lookup below still guards this attempt */ }
  try {
    const observation = await apiPost<ObservationRecord>(`care/patients/${patientId}/wounds/${woundId}/observations`, {
      ...payload, submission_id: pending.id,
    });
    clearPendingSubmission(patientId, woundId);
    return observation;
  } catch (err) {
    // A lost response is ambiguous. Look up the original identity; never auto-resubmit.
    const outcome = await submissionStatus(patientId, woundId, pending.id).catch(() => null);
    if (outcome?.status === "SUCCEEDED" && outcome.observation) {
      clearPendingSubmission(patientId, woundId);
      return outcome.observation;
    }
    if (err instanceof CareApiError && [400, 413, 415, 422].includes(err.status)
        && outcome && ["NOT_FOUND", "FAILED"].includes(outcome.status)) {
      clearPendingSubmission(patientId, woundId);
    }
    throw err;
  }
}

export function refineObservationMask(
  observationId: string,
  body: {
    amends_assessment_id?: string; edited_boundary_px?: number[][]; selected_candidate_id?: number;
    expected_measurement_id?: string; correction_notes: string; measurement_region?: MeasurementRegion;
  },
) {
  return apiPost<ObservationRecord>(`care/observations/${observationId}/refine-mask`, body);
}

/**
 * No visible open wound: proposes 0 cm² for clinician verification (never an approval). On a photo where the
 * AI found no wound, `draw_outline` instead opens it for review so a clinician can draw the boundary.
 */
export function recordZeroArea(
  observationId: string,
  body: { intent?: "record_zero" | "draw_outline"; expected_measurement_id?: string; amends_assessment_id?: string } = {},
) {
  return apiPost<ObservationRecord>(`care/observations/${observationId}/record-zero-area`, body);
}

/** Clinician confirmation that a wound has healed (after a verified 0 cm²), or reopening it. */
export function setWoundStatus(patientId: string, woundId: string, status: "HEALED" | "ACTIVE", reason: string) {
  return apiPost<Record<string, unknown>>(`care/patients/${patientId}/wounds/${woundId}/status`, { status, reason });
}

/** Measures an unsaved boundary with the same server algorithm as saving it; stores nothing. */
export function previewMeasurement(observationId: string, body: { edited_boundary_px: number[][]; expected_measurement_id?: string }) {
  return apiPost<MeasurePreview>(`care/observations/${observationId}/measure-preview`, body);
}

export interface ReviewDecisionPayload {
  amends_assessment_id?: string;
  amendment_reason?: string;
  expected_record_revision?: number;
  factual_fields?: import("@/lib/care-types").RecordFields;
  decision: "approve" | "request_retake" | "reject";
  approval_request_id?: string;
  expected_measurement_id?: string;
  expected_measurement_version?: number;
  reviewer_attested?: boolean;
  /** The four explicit sign-off confirmations; the server refuses approval unless each is true. */
  attestations?: Record<AttestationKey, boolean>;
  wound_type?: string;
  pressure_injury_stage?: string;
  diagnosis?: string;
  wound_bed_appearance?: string;
  exudate_amount?: string;
  surrounding_skin?: string;
  wound_trend?: string;
  sensory_perception?: number;
  moisture?: number;
  activity?: number;
  mobility?: number;
  nutrition?: number;
  friction_and_shear?: number;
  clinical_interpretation?: string;
  care_decisions?: string;
  ai_draft_disposition?: "not_used" | "accepted" | "edited" | "rejected";
  final_documentation_text?: string;
  review_notes?: string;
  /** Ask AI suggestions applied to the text fields (provenance; validated by the server). */
  ai_revision_ids?: string[];
}

export function reviewObservation(observationId: string, payload: ReviewDecisionPayload) {
  return apiPost<ObservationRecord>(`care/observations/${observationId}/review`, payload);
}

export function amendAssessment(assessmentId: string, body: { amendment_reason: string; updated_note: string }) {
  return apiPost<{ assessment_id: string; version_number: number }>(`care/assessments/${assessmentId}/amend`, {
    amendment_reason: body.amendment_reason,
    updated_clinical_interpretation: body.updated_note,
    updated_final_documentation_text: body.updated_note,
  });
}

// ---- Meta AI assistance (clinical staff; every output is a draft until a clinician reviews it) ----------

export function generateAiObservations(observationId: string) {
  const demo = demoTarget(observationId);
  if (demo) return demo.generateAiObservations(observationId);
  return apiPost<AiVisualObservation>(`care/observations/${observationId}/ai-observations`, {});
}

export function reviewAiObservations(
  aiObservationId: string,
  body: {
    decision: "accept" | "reject" | "edit"; notes?: string; clinician_findings?: { category: string; observation: string }[];
    ai_revision_ids?: string[];
  },
) {
  const demo = demoTarget(aiObservationId);
  if (demo) return demo.reviewAiObservations(aiObservationId, body);
  return apiPost<AiVisualObservation>(`care/ai-observations/${aiObservationId}/review`, body);
}

export async function listReports(patientId: string) {
  const data = await apiGet<{ reports: ClinicalReport[] }>(`care/patients/${patientId}/reports`);
  return data.reports;
}

export function draftReport(patientId: string, woundId: string, includeNursing: boolean) {
  return apiPost<ClinicalReport>(`care/patients/${patientId}/wounds/${woundId}/reports`, { include_nursing: includeNursing });
}

export function reviewReport(
  reportId: string,
  body: {
    decision: "edit" | "reject" | "sign"; sections?: Record<string, string>; reason?: string; attested?: boolean;
    confirm_flagged_content?: boolean; ai_revisions?: Record<string, string[]>;
  },
) {
  return apiPost<ClinicalReport>(`care/reports/${reportId}/review`, body);
}

/** Progress-summary draft for one wound: Muse Spark ("ai") or the clinician's own text ("manual"). */
export function draftWoundSummary(
  patientId: string,
  woundId: string,
  body: { mode: "ai" | "manual"; text?: string; revision_reason?: string; ai_revision_ids?: string[] },
) {
  return apiPost<ClinicalReport>(`care/patients/${patientId}/wounds/${woundId}/summary-drafts`, body);
}

/** Ask AI: a suggested revision of an editable draft. Stateless; nothing in the record changes. */
export function reviseDraft(
  patientId: string,
  woundId: string,
  body: { draft_type: DraftType; text: string; instruction: string; base_text?: string; target_id?: string; field?: string; history?: string[] },
) {
  const demo = demoTarget(patientId);
  if (demo) return demo.reviseDraft(body);
  return apiPost<DraftRevision>(`care/patients/${patientId}/wounds/${woundId}/ai-revise`, body);
}

export function askAssistant(patientId: string, messages: { role: "user" | "assistant"; content: string }[]) {
  return apiPost<AssistantAnswer>(`care/patients/${patientId}/assistant`, { messages });
}

export function transcribeAudio(audioBase64: string, language: "auto" | "th" | "en") {
  return apiPost<Transcription>("care/voice/transcribe", { audio_base64: audioBase64, language });
}

// ---- Care plans & tasks ------------------------------------------------------------------------

export function issueCarePlan(patientId: string, woundId: string, caregiverSubject: string) {
  return apiPost<{ care_plan_id: string; version_number: number }>(
    `care/patients/${patientId}/wounds/${woundId}/care-plans`,
    { assigned_caregiver_subject: caregiverSubject },
  );
}

/** New version of the active plan with edited instructions; its tasks are carried over. */
export function reviseCarePlan(
  patientId: string,
  woundId: string,
  plan: { title: string; purpose: string; approved_instructions: string; task_frequency: string; assigned_caregiver_subject: string },
  revisionReason: string,
  aiRevisionIds: string[],
  expectedCarePlanId: string,
) {
  return apiPost<{ care_plan_id: string; version_number: number }>(`care/patients/${patientId}/wounds/${woundId}/care-plans`, {
    ...plan,
    revision_reason: revisionReason,
    carry_over_tasks: true,
    ai_revision_ids: aiRevisionIds,
    // Refused (409) if someone issued another version since this one was loaded.
    expected_care_plan_id: expectedCarePlanId,
  });
}

export function completeTask(taskId: string, status: "COMPLETED" | "CONCERN_REPORTED", caregiverNotes: string) {
  return apiPost<{ task_id: string; status: string }>(`care/tasks/${taskId}/complete`, {
    status,
    caregiver_notes: caregiverNotes,
  });
}

// ---- Sharing -----------------------------------------------------------------------------------

export function grantCaregiverAccess(patientId: string, granteeSubject: string) {
  return apiPost<{ grant_id: string }>(`care/patients/${patientId}/grants`, {
    grantee_subject: granteeSubject,
    auto_accept: true,
  });
}

export function revokeGrant(grantId: string, reason: string) {
  return apiPost<{ grant_id: string }>(`care/grants/${grantId}/revoke`, { reason });
}

// ---- Helpers ----------------------------------------------------------------------------------

export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(new Error("Could not read the photo."));
    reader.readAsDataURL(file);
  });
}

export function saveRecordDraft(observationId: string, body: {
  fields: import("@/lib/care-types").RecordFields; expected_revision: number;
  base_assessment_id?: string | null; amendment_reason?: string; submit?: boolean; ai_revision_ids?: string[];
}) {
  return apiPost<ObservationRecord>(`care/observations/${observationId}/record-draft`, body);
}
