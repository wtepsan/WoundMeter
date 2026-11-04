"use client";

import { useState } from "react";
import { ChevronRight, Columns2 } from "lucide-react";

import type { Navigate } from "@/components/app/AppShell";
import { useCareData } from "@/components/app/CareDataProvider";
import { RecordActions } from "@/components/clinical/RecordActions";
import { AreaTrendChart } from "@/components/ui/AreaTrendChart";
import { Badge } from "@/components/ui/Feedback";
import { PrivateImage, pickDisplayImage } from "@/components/ui/PrivateImage";
import { personName, type Account, type Portal } from "@/lib/accounts";
import {
  comparableTimeline,
  defaultChartRegion,
  describeAreaChange,
  formatCm,
  formatDate,
  formatDateTime,
  humanize,
  latestApprovedObservation,
  locationLabel,
  approvedRegion,
  recordStatus,
  REGION_LABEL,
  regionLabel,
  regionSeries,
  retakeReason,
  syntheticImageLabel,
  unrecordedTimeline,
  woundSiteLabel,
} from "@/lib/care-format";
import type { MeasurementRegion, ObservationRecord, WoundDetail } from "@/lib/care-types";

function reportLine(obs: ObservationRecord): string | null {
  const r = obs.caregiver_report ? { ...obs.caregiver_report, ...obs.record_published } : null;
  if (!r) return null;
  return [
    r.pain_score_0_10 != null ? `Pain ${r.pain_score_0_10}/10` : null,
    r.drainage_level ? `Drainage ${humanize(String(r.drainage_level)).toLowerCase()}` : null,
    r.redness_observed ? `Redness ${humanize(String(r.redness_observed)).toLowerCase()}` : null,
  ].filter(Boolean).join(" · ") || null;
}

/**
 * One wound's measures, newest first. Only approved measurements of the same recorded region are charted;
 * AI proposals, other regions and measurements whose region was never recorded stay off the trend (the
 * last are listed, never compared). A record's own edit history is inside the record.
 * The latest figures, trend and progress text live in the wound care summary above; they are shown
 * here only when the API predates the summary.
 */
export function WoundHistory({ wound, patientId, account, portal, navigate }: {
  wound: WoundDetail; patientId: string; account: Account; portal: Portal; navigate: Navigate;
}) {
  const [compare, setCompare] = useState<string[]>([]);
  const [comparing, setComparing] = useState(false);
  const [chartChoice, setChartChoice] = useState<MeasurementRegion | null>(null);
  const { records, refreshPatient, refreshQueue } = useCareData();
  const clinical = portal === "clinical";
  // One region per chart; when both were measured, a switch shows the other one (never mixed).
  const series = regionSeries(wound);
  const chartRegion = chartChoice && series.some((s) => s.region === chartChoice) ? chartChoice : defaultChartRegion(wound);
  const { points, region, excluded, unrecorded } = comparableTimeline(wound, chartRegion);
  const change = describeAreaChange(points);
  const latestPoint = wound.approved_timeline.at(-1);
  const unrecordedOnly = points.length === 0 && unrecordedTimeline(wound).length > 0;
  const latestAssessment = latestApprovedObservation(wound)?.latest_clinical_assessment;
  const summarised = Boolean(wound.care_summary);

  // Caregivers see approved entries and their own submissions; patients see approved entries only.
  const entries = [...wound.observations].reverse().filter((o) =>
    clinical || o.review_state === "CLINICIAN_APPROVED" || (portal === "caregiver" && o.uploading_user_subject === account.subject));
  const approved = entries.filter((o) => o.review_state === "CLINICIAN_APPROVED");
  const compared = approved.filter((o) => compare.includes(o.observation_id));
  const simulatedChange = approved.some((o) => o.synthetic_demo_image === "simulated_followup");
  const simulatedDeterioration = approved.some((o) => o.synthetic_demo_image === "simulated_deterioration");

  return (
    <div className="wound-history">
      {latestPoint ? (
        <div className="history-summary">
          {!summarised && <div className="history-figures">
            <div>
              <p className="metric-label">Latest verified area</p>
              <p className="metric-value">{formatCm(latestPoint.area_cm2)}<span className="metric-unit">cm²</span></p>
              <p className="metric-hint">{formatDate(latestPoint.capture_datetime_utc)} · {regionLabel(approvedRegion(wound, latestPoint.observation_id))}</p>
            </div>
            {clinical && latestAssessment && (
              <div>
                <p className="metric-label">Clinician-assessed trend</p>
                <p className="trend-value">{humanize(latestAssessment.wound_trend)}</p>
                <p className="metric-hint">{formatDate(latestAssessment.signed_at_utc)}</p>
              </div>
            )}
          </div>}
          {change && !summarised && <p className="change-text">{change}</p>}
          {series.length > 1 && (
            <div className="segmented small chart-region" role="group" aria-label="Region on the chart">
              {series.map((s) => (
                <button key={s.region} type="button" aria-pressed={s.region === region} onClick={() => setChartChoice(s.region)}>
                  {REGION_LABEL[s.region]} ({s.count})
                </button>
              ))}
            </div>
          )}
          {unrecordedOnly ? (
            <p className="fine-print region-note">
              No trend chart: the boundary region (whole wound or red tissue only) was not recorded for these measurements, so they are
              listed below with their own areas but not compared. A region is recorded with Meta SAM outlines, or when a clinician edits the boundary and chooses its region.
            </p>
          ) : points.length === 1 ? (
            <p className="fine-print">The trend chart appears once two verified measurements outline the same recorded region.</p>
          ) : null}
          {points.length > 1 && <AreaTrendChart points={points.map((p) => ({ date: p.capture_datetime_utc, area: p.area_cm2 }))} title={region ? `Verified area, ${regionLabel(region).toLowerCase()} (cm²)` : "Verified wound area (cm²)"} />}
          {!unrecordedOnly && unrecorded > 0 && <p className="fine-print">{unrecorded} approved measurement{unrecorded === 1 ? " has" : "s have"} no recorded region, so {unrecorded === 1 ? "it is" : "they are"} listed below but not charted.</p>}
          {excluded > 0 && <p className="fine-print">{excluded} approved measurement{excluded === 1 ? " outlines" : "s outline"} a different region and {excluded === 1 ? "is" : "are"} not on this chart.</p>}
          {simulatedChange && <p className="fine-print">Includes a simulated follow-up on a synthetic phantom. This change in area is not clinical healing.</p>}
          {simulatedDeterioration && <p className="fine-print">Includes simulated deterioration on a synthetic phantom. This change in area is not a real wound getting worse.</p>}
          <p className="fine-print">{wound.healing_epistemic_notice}</p>
        </div>
      ) : summarised ? null : (
        <p className="muted-text">No clinician-approved measurement for the {woundSiteLabel(wound).toLowerCase()} yet.</p>
      )}

      <div className="history-toolbar">
        <h3 className="section-title" id={`visits-${wound.wound_id}`} tabIndex={-1}>Measures <span className="count">{entries.length}</span></h3>
        {approved.length >= 2 && (
          <button type="button" className="button ghost small" aria-pressed={comparing} onClick={() => { setComparing((v) => !v); setCompare([]); }}>
            <Columns2 aria-hidden="true" /> {comparing ? "Done comparing" : "Compare photos"}
          </button>
        )}
      </div>
      {comparing && <p className="field-hint">Select two approved measures to compare.</p>}
      {comparing && compared.length === 2 && (
        <div className="compare-pair" aria-label="Photo comparison">
          {compared.map((o) => (
            <figure key={o.observation_id}>
              <PrivateImage image={pickDisplayImage(o.images)} alt={`Approved photo from ${formatDate(o.capture_datetime_utc)}`} className="compare-photo" />
              <figcaption>{formatDate(o.capture_datetime_utc)} · <strong>{formatCm(o.approved_measurement?.area_cm2)} cm²</strong> · {regionLabel(approvedRegion(wound, o.observation_id))}</figcaption>
            </figure>
          ))}
        </div>
      )}

      {entries.length === 0 ? (
        <p className="muted-text">No measures recorded yet. Use New measure to add a photo of this wound.</p>
      ) : (
        <ol className="visit-list" aria-label={`${woundSiteLabel(wound)} measures, newest first`}>
          {entries.map((obs) => {
            const status = recordStatus(obs);
            const own = obs.uploading_user_subject === account.subject;
            const m = obs.approved_measurement;
            const isApproved = obs.review_state === "CLINICIAN_APPROVED";
            const synthetic = syntheticImageLabel(obs);
            const openable = clinical || (own && portal === "caregiver");
            const revised = obs.clinical_assessments_versions.length > 1;
            const corrected = Boolean(m?.was_human_corrected);
            const report = clinical ? reportLine(obs) : null;
            const concern = obs.caregiver_report?.concern_flag || obs.caregiver_report?.concern_reported;
            const point = wound.approved_timeline.find((p) => p.observation_id === obs.observation_id);
            const zeroPoint = Boolean(point?.zero_area);
            const body = (
              <>
                <PrivateImage image={pickDisplayImage(obs.images)} alt={`Wound photo from ${formatDate(obs.capture_datetime_utc)}`} className="visit-thumb" />
                <span className="visit-main">
                  <span className="visit-title">
                    {formatDateTime(obs.capture_datetime_utc)}
                    {isApproved && m && <strong> · {formatCm(m.area_cm2)} cm²</strong>}
                    {isApproved && m && zeroPoint && <span className="visit-dims"> No visible open wound</span>}
                    {isApproved && m && !zeroPoint && <span className="visit-dims"> {formatCm(m.length_cm)} × {formatCm(m.width_cm)} cm · {regionLabel(approvedRegion(wound, obs.observation_id)).replace("Wound boundary · ", "")}</span>}
                  </span>
                  <span className="visit-sub">
                    {locationLabel(obs.capture_location_category)} · {own ? "you" : personName(obs.uploading_user_subject)}
                    {isApproved ? ` · verified by ${personName(obs.reviewing_clinician_subject)}` : ""}
                    {!isApproved && obs.review_state === "AWAITING_CLINICAL_REVIEW" ? (clinical ? " · AI proposal, not on the chart" : " · measurements appear after review") : ""}
                  </span>
                  {obs.review_state === "RETAKE_REQUESTED" && <span className="visit-sub">{retakeReason(obs, { technical: clinical })}</span>}
                  {report && <span className="visit-sub">{report}</span>}
                </span>
                <span className="visit-badges">
                  {!clinical && own && !isApproved && <Badge tone="info">Your submission</Badge>}
                  {concern ? <Badge tone="danger">Concern</Badge> : null}
                  {obs.correction_of && <Badge tone="info">Photo correction</Badge>}
                  {corrected && !zeroPoint && <Badge tone="neutral">Boundary corrected</Badge>}
                  {point?.reopened && <Badge tone="warning">Reopened</Badge>}
                  {revised && <Badge tone="neutral">Record amended</Badge>}
                  {synthetic && <Badge tone="neutral">{synthetic}</Badge>}
                  <Badge tone={status.tone}>{status.label}</Badge>
                </span>
              </>
            );
            return (
              <li key={obs.observation_id} className={`visit${isApproved ? "" : " is-pending"}`}>
                {comparing && isApproved && (
                  <input type="checkbox" className="visit-compare" aria-label={`Compare measure from ${formatDate(obs.capture_datetime_utc)}`}
                    checked={compare.includes(obs.observation_id)} disabled={!compare.includes(obs.observation_id) && compare.length >= 2}
                    onChange={(e) => setCompare((prev) => e.target.checked ? [...prev, obs.observation_id] : prev.filter((id) => id !== obs.observation_id))} />
                )}
                {openable ? (
                  <button type="button" className="visit-row" aria-label={`Open record from ${formatDateTime(obs.capture_datetime_utc)}`}
                    onClick={() => navigate({ name: "review", patientId, observationId: obs.observation_id })}>
                    {body}<ChevronRight aria-hidden="true" className="row-chevron" />
                  </button>
                ) : <div className="visit-row">{body}</div>}
                {clinical && (
                  <RecordActions account={account} recordType="observation" recordId={obs.observation_id} status={obs.review_state}
                    details={`${records[patientId]?.patient.display_name ?? patientId} · ${woundSiteLabel(wound)} · ${formatDateTime(obs.capture_datetime_utc)}`}
                    onDeleted={async () => { setCompare([]); await Promise.all([refreshPatient(patientId), refreshQueue()]); }} />
                )}
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
