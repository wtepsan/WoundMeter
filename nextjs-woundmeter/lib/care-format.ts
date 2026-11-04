// Plain-language labels for backend enums. Presentation only — never used for decisions.

import type {
  ApprovedTimelinePoint,
  MeasurementRegion,
  MeasurementVersion,
  ObservationRecord,
  WoundCareSummary,
  WoundDetail,
} from "@/lib/care-types";

export type Tone = "neutral" | "info" | "success" | "warning" | "danger";

export function humanize(value: string | null | undefined): string {
  if (!value) return "—";
  const text = value.replaceAll("_", " ").toLowerCase().trim();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** "Patient P001 (Somjai Rakdee — Fictional Demo)" → "Somjai Rakdee". */
export function patientName(patient: { display_name: string; patient_code: string }): string {
  const match = /^Patient\s+\S+\s+\((.+?)(?:\s+—\s+Fictional Demo)?\)$/.exec(patient.display_name);
  return match ? match[1] : patient.display_name || patient.patient_code;
}

export function wardLabel(code: string): string {
  const match = /^WARD(\d+)$/i.exec(code);
  return match ? `Ward ${match[1]}` : humanize(code);
}

export function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

export function woundSiteLabel(wound: Pick<WoundDetail, "anatomical_site">): string {
  return humanize(wound.anatomical_site);
}

export function woundTypeLabel(wound: Pick<WoundDetail, "wound_type" | "pressure_injury_stage">): string {
  const type = humanize(wound.wound_type);
  const stage = wound.pressure_injury_stage;
  if (!stage || stage === "NOT_APPLICABLE") return type;
  return `${type} · ${humanize(stage)}`;
}

const dateFmt = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric" });
const dateTimeFmt = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : dateFmt.format(d);
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : dateTimeFmt.format(d);
}

export function formatCm(value: number | null | undefined, digits = 2): string {
  return value == null ? "—" : value.toFixed(digits);
}

export function reviewStateLabel(state: string): { label: string; tone: Tone } {
  switch (state) {
    case "AWAITING_CLINICAL_REVIEW":
      return { label: "Awaiting review", tone: "warning" };
    case "CLINICIAN_APPROVED":
      return { label: "Approved", tone: "success" };
    case "RETAKE_REQUESTED":
      return { label: "New photo requested", tone: "warning" };
    case "REJECTED":
      return { label: "Rejected", tone: "danger" };
    default:
      return { label: humanize(state), tone: "neutral" };
  }
}

export function locationLabel(location: string): string {
  if (location === "HOSPITAL") return "Hospital";
  if (location === "HOME") return "Home";
  if (location === "COMMUNITY") return "Community";
  return humanize(location);
}

/**
 * How the AI boundary was produced. Must never present a fallback as live inference. "At capture": a stored
 * record opened later shows the call made when the photo was measured, not a fresh request now.
 */
export function inferenceSourceLabel(metaExecutionStatus: string): { label: string; tone: Tone } {
  switch (metaExecutionStatus) {
    case "sam_live_inference":
    case "live_api_connected":
    case "LIVE_META_API":
      return { label: "Live Meta API at capture", tone: "success" };
    case "cached_demo_result":
      return { label: "Cached demonstration result", tone: "info" };
    case "yolo_local_fallback":
      return { label: "Local fallback (no usable Meta result)", tone: "warning" };
    case "local_yolo_only":
      return { label: "Local model only (Meta not used)", tone: "neutral" };
    case "api_unavailable":
      return { label: "AI service unavailable", tone: "danger" };
    case "sam_no_valid_mask":
      return { label: "Meta SAM returned no usable mask", tone: "danger" };
    case "quality_gate_halted":
      return { label: "Not run — photo failed checks", tone: "danger" };
    default:
      return { label: humanize(metaExecutionStatus), tone: "neutral" };
  }
}

export function modelLabel(sourceModel: string | null | undefined): string {
  if (!sourceModel) return "—";
  const corrected = sourceModel.includes("+human_corrected");
  const base = sourceModel.replace("+human_corrected", "");
  const name = base.includes("sam") ? "Meta SAM 3.1" : base.includes("yolo") ? "YOLOv8 (local)" : base;
  return corrected ? `${name}, adjusted by clinician` : name;
}

export function museSourceLabel(status: string | undefined): { label: string; tone: Tone } {
  if (status === "ready") return { label: "Meta Muse Spark 1.3 · Live Meta API when drafted", tone: "success" };
  if (status === "fallback_deterministic")
    return { label: "Local template (Meta Muse unavailable)", tone: "warning" };
  return { label: "AI draft unavailable", tone: "neutral" };
}

export function qualityLabel(status: string): { label: string; tone: Tone } {
  if (status === "PASS") return { label: "Passed", tone: "success" };
  if (status === "REVIEW_REQUIRED") return { label: "Passed with warnings", tone: "warning" };
  if (status === "RETAKE_REQUIRED") return { label: "Failed — new photo needed", tone: "danger" };
  return { label: humanize(status), tone: "neutral" };
}

export function measurementStageLabel(stage: string): string {
  if (stage === "PROVISIONAL_AI") return "AI proposal";
  if (stage === "HUMAN_CORRECTED") return "Adjusted by clinician";
  if (stage === "FINAL_CLINICIAN_APPROVED") return "Clinician approved";
  return humanize(stage);
}

/**
 * Plain-language reason a photo could not be measured, with what to do next.
 * `technical` appends the backend's own message (for clinicians).
 */
export function retakeReason(
  obs: Pick<ObservationRecord, "image_quality_status" | "review_notes" | "capture_quality_reason">,
  { technical = false }: { technical?: boolean } = {},
): string {
  const code = (obs.capture_quality_reason ?? obs.image_quality_status ?? "").toLowerCase();
  let reason = "The photo could not be measured. Please take it again.";
  if (code.includes("wound_outside_photo")) {
    reason = "The wound reaches the edge of the photo, so part of it could be missing. Step back so the wound and the skin around it are fully in the photo.";
  } else if (/ruler|tag|marker|homography|geometry|crop|calibrat/.test(code)) {
    reason = "Part of the calibration ruler was hidden or outside the photo. Keep all four corner markers of the ruler in view.";
  } else if (code.includes("no_wound")) {
    reason = "No wound could be found in the photo. Keep the wound in the middle of the frame, next to the ruler.";
  } else if (/blur|exposure|glare|image/.test(code)) {
    reason = "The photo was too blurry, dark or bright. Use even light and hold the phone steady.";
  }
  return technical && obs.review_notes ? `${reason} (${obs.review_notes})` : reason;
}

/** Latest measurement version a clinician is working on (AI proposal or their adjustment). */
export function workingMeasurement(obs: ObservationRecord): MeasurementVersion | null {
  const versions = obs.measurements_versions.filter((m) => m.measurement_stage !== "FINAL_CLINICIAN_APPROVED");
  return versions.length ? versions[versions.length - 1] : null;
}

export function parseBoundary(m: MeasurementVersion | null | undefined): number[][] {
  if (!m?.boundary_px_json) return [];
  try {
    const parsed = JSON.parse(m.boundary_px_json) as unknown;
    return Array.isArray(parsed) ? (parsed as number[][]) : [];
  } catch {
    return [];
  }
}

/** Numerical change between the two most recent approved measurements. Never labels it "healing". */
export function describeAreaChange(timeline: ApprovedTimelinePoint[]): string | null {
  if (timeline.length < 2) return null;
  const last = timeline[timeline.length - 1];
  const prev = timeline[timeline.length - 2];
  if (prev.area_cm2 <= 0) return null;
  const pct = ((last.area_cm2 - prev.area_cm2) / prev.area_cm2) * 100;
  if (Math.abs(pct) < 0.05) return "Measured area unchanged since the previous approved measurement.";
  const direction = pct < 0 ? "decreased" : "increased";
  return `Measured area ${direction} by ${Math.abs(pct).toFixed(1)}% since the previous approved measurement (${prev.area_cm2.toFixed(2)} → ${last.area_cm2.toFixed(2)} cm²).`;
}

/** Generated demo phantoms must never read as a real wound or as healing. */
export function syntheticImageLabel(obs: ObservationRecord): string | null {
  if (obs.synthetic_demo_image === "synthetic_phantom") return "Synthetic phantom";
  if (obs.synthetic_demo_image === "simulated_followup") return "Simulated follow-up";
  if (obs.synthetic_demo_image === "simulated_deterioration") return "Simulated deterioration";
  return null;
}

export function latestApprovedObservation(wound: WoundDetail): ObservationRecord | null {
  const last = wound.approved_timeline[wound.approved_timeline.length - 1];
  if (!last) return null;
  return wound.observations.find((o) => o.observation_id === last.observation_id) ?? null;
}

export function parsePermissions(json: string): string[] {
  try {
    const parsed = JSON.parse(json) as unknown;
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

const PERMISSION_LABELS: Record<string, string> = {
  VIEW_APPROVED_PROGRESS: "View approved progress",
  UPLOAD_HOME_PHOTO: "Submit photos",
  SUBMIT_CAREGIVER_REPORT: "Report symptoms",
  COMPLETE_CARE_TASKS: "Complete care tasks",
};

export function permissionLabel(permission: string): string {
  return PERMISSION_LABELS[permission] ?? humanize(permission);
}

const KIND_REGION: Record<string, MeasurementRegion> = { sam_refined_whole_wound: "whole_wound", sam_concept: "red_tissue" };
export const REGION_LABEL: Record<MeasurementRegion, string> = { whole_wound: "Whole wound", red_tissue: "Red tissue only" };

/**
 * What a measurement's boundary outlines: declared on save, else the chosen SAM candidate's kind.
 * `null` when it was never recorded (older edits, local-model boundaries); never guessed.
 */
export function measurementRegion(m: MeasurementVersion | null | undefined): MeasurementRegion | null {
  const g = m?.geometry;
  if (!g) return null;
  if (g.measurement_region) return g.measurement_region;
  const chosen = g.selected_component_id != null ? g.candidates.find((c) => c.candidate_id === g.selected_component_id)
    : !m.was_human_corrected && !g.selection_required && g.candidates.length === 1 ? g.candidates[0] : null;
  return (chosen?.boundary_kind && KIND_REGION[chosen.boundary_kind]) || null;
}

/**
 * Region of an approved visit. The server sends it on the timeline for every viewer; measurement geometry
 * reaches clinical staff only, so it is the fallback for an API that predates the timeline field.
 */
export function approvedRegion(wound: WoundDetail, observationId: string): MeasurementRegion | null {
  const point = wound.approved_timeline.find((p) => p.observation_id === observationId);
  if (point && point.measurement_region !== undefined) return point.measurement_region ?? null;
  return measurementRegion(wound.observations.find((o) => o.observation_id === observationId)?.approved_measurement);
}

/**
 * Two measurements are compared only when both outline the same recorded region. Whole wound and red
 * tissue only differ, and an unrecorded region could be either, so it is never presumed to match (not
 * even another unrecorded one). Mirrors comparable_regions() in fastapi-woundmeter/app/services/wound_summary.py.
 */
export function regionsComparable(a: MeasurementRegion | null, b: MeasurementRegion | null): boolean {
  return a !== null && a === b;
}

export function regionLabel(region: MeasurementRegion | null): string {
  return region ? REGION_LABEL[region] : "Wound boundary · region not recorded";
}

export type CalibrationStatus = { state: "calibrated" | "check" | "unavailable"; label: string; tone: Tone; detail: string };

/** Spatial (AprilTag ruler) calibration behind a measurement. Physical units are only valid when calibrated or checked. */
export function calibrationStatus(m: MeasurementVersion | null | undefined): CalibrationStatus {
  const g = m?.geometry;
  if (!g || !g.pixels_per_mm || !g.calibration_id) {
    return { state: "unavailable", label: "Calibration unavailable", tone: "danger",
      detail: "No stored ruler calibration. Dimensions cannot be measured or guessed; a new photo is needed." };
  }
  const checks = (g.quality_gate?.checks ?? {}) as Record<string, string>;
  if (checks.ruler_detection && checks.ruler_detection !== "PASS" || checks.calibration_geometry === "REVIEW_REQUIRED") {
    return { state: "check", label: "Check calibration", tone: "warning",
      detail: "The ruler was found, but its geometry is in the warning band. Check that the ruler lies flat and in focus." };
  }
  return { state: "calibrated", label: "Calibrated", tone: "success", detail: `AprilTag ruler · ${g.pixels_per_mm} px/mm on the rectified image.` };
}

export type RecordStatus = { label: string; tone: Tone };

/**
 * One status for the record header. Every capture enters review when it is saved, so an unsigned
 * record is "Pending review"; saved draft edits are shown separately, never as a status.
 */
export function recordStatus(obs: ObservationRecord): RecordStatus {
  if (obs.review_state === "CLINICIAN_APPROVED") {
    if (obs.record_has_draft) return { label: "Revision pending review", tone: "warning" };
    return obs.clinical_assessments_versions.length > 1 ? { label: "Approved · revised", tone: "success" } : { label: "Approved", tone: "success" };
  }
  if (obs.review_state === "AWAITING_CLINICAL_REVIEW") return { label: "Pending review", tone: "warning" };
  return reviewStateLabel(obs.review_state);
}

/**
 * Approved points that can be charted as one series: one recorded region (whole wound or red tissue only),
 * the latest recorded one unless `preferred` is given. Measurements of the other region and measurements
 * whose region was never recorded are left out and counted, so the chart can say so; the unrecorded ones
 * are listed separately by unrecordedTimeline().
 */
export function comparableTimeline(wound: WoundDetail, preferred?: MeasurementRegion | null): { points: ApprovedTimelinePoint[]; region: MeasurementRegion | null; excluded: number; unrecorded: number } {
  const timeline = wound.approved_timeline;
  const regions = timeline.map((p) => approvedRegion(wound, p.observation_id));
  const region = preferred ?? [...regions].reverse().find((r): r is MeasurementRegion => r !== null) ?? null;
  const keep = regions.map((r) => regionsComparable(r, region));
  return {
    points: timeline.filter((_, i) => keep[i]),
    region,
    excluded: regions.filter((r) => r !== null && r !== region).length,
    unrecorded: regions.filter((r) => r === null).length,
  };
}

/** Approved points whose boundary region was never recorded: shown on their own, never compared. */
export function unrecordedTimeline(wound: WoundDetail): ApprovedTimelinePoint[] {
  return wound.approved_timeline.filter((p) => approvedRegion(wound, p.observation_id) === null);
}

/**
 * The change shown beside a wound's latest verified area: the server's summary when present, otherwise
 * the same rule here (latest approved measurement against the previous one of the same recorded region).
 */
export function latestAreaChange(wound: WoundDetail): { cm2: number; pct: number | null } | null {
  if (wound.care_summary) {
    const change = wound.care_summary.progress.change;
    return change ? { cm2: change.cm2, pct: change.pct } : null;
  }
  const timeline = wound.approved_timeline;
  const regions = timeline.map((p) => approvedRegion(wound, p.observation_id));
  const last = timeline.length - 1;
  for (let i = last - 1; i >= 0; i -= 1) {
    if (regionsComparable(regions[i], regions[last])) {
      const cm2 = timeline[last].area_cm2 - timeline[i].area_cm2;
      return { cm2, pct: timeline[i].area_cm2 > 0 ? (100 * cm2) / timeline[i].area_cm2 : null };
    }
  }
  return null;
}

/** Each recorded region with the number of approved points its chart would hold (latest region first). */
export function regionSeries(wound: WoundDetail): Array<{ region: MeasurementRegion; count: number }> {
  const recorded = wound.approved_timeline.map((p) => approvedRegion(wound, p.observation_id)).filter((r): r is MeasurementRegion => r !== null);
  return [...new Set(recorded.reverse())].map((region) => ({ region, count: comparableTimeline(wound, region).points.length }));
}

/**
 * Region the trend chart opens with: the latest one, unless it has fewer than two points and another
 * region has a trend (for example the latest visit outlined red tissue only after three whole-wound
 * visits). Regions are never mixed; the other one stays one click away.
 */
export function defaultChartRegion(wound: WoundDetail): MeasurementRegion | null {
  const series = regionSeries(wound);
  if (!series.length || series[0].count >= 2) return series[0]?.region ?? null;
  const best = series.reduce((a, b) => (b.count > a.count ? b : a));
  return best.count >= 2 ? best.region : series[0].region;
}

/**
 * The two progress sentences of a wound care summary, from verified facts only: the latest approved
 * area compared with the previous approved area of the same recorded region (never an unrecorded one),
 * then the clinician's trend.
 */
export function progressSentences(summary: Pick<WoundCareSummary, "progress" | "trend">): string[] {
  const { latest, previous_same_region: previous, change, not_compared_reason: reason } = summary.progress;
  if (!latest) return ["No clinician-verified measurement yet."];
  const region = latest.region ? REGION_LABEL[latest.region].toLowerCase() : "region not recorded";
  let first = `Latest verified area ${formatCm(latest.area_cm2)} cm² (${region}), ${formatDate(latest.date_utc)}`;
  if (previous && change) {
    first += Math.abs(change.cm2) < 0.005
      ? `: unchanged from ${formatDate(previous.date_utc)} (${formatCm(previous.area_cm2)} cm²).`
      : `: ${formatCm(Math.abs(change.cm2))} cm²${change.pct != null ? ` (${Math.abs(change.pct).toFixed(1)}%)` : ""} ${change.cm2 < 0 ? "less" : "more"} than on ${formatDate(previous.date_utc)} (${formatCm(previous.area_cm2)} cm²).`;
  } else if (reason === "region_not_recorded") {
    first += ". Its boundary region was not recorded, so it is not compared with other measurements.";
  } else if (reason === "different_region") {
    first += ". No earlier verified measurement has the same recorded region, so there is no comparison.";
  } else {
    first += ". First verified measurement, so there is nothing to compare yet.";
  }
  const trend = summary.trend;
  const who = trend ? [trend.assessed_by_name, trend.assessed_at_utc ? formatDate(trend.assessed_at_utc) : null].filter(Boolean).join(", ") : "";
  const second = trend
    ? `Clinician-assessed trend: ${humanize(trend.value).toLowerCase()}${who ? ` (${who})` : ""}.`
    : "No clinician assessment of the trend is recorded.";
  return [first, second];
}
