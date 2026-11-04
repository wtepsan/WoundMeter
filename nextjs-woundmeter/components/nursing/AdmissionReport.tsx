"use client";

import { useEffect, useState } from "react";
import { Printer } from "lucide-react";

import type { Navigate } from "@/components/app/AppShell";
import { Badge, Loading, Notice } from "@/components/ui/Feedback";
import { PageHeader } from "@/components/ui/Layout";
import { BRADEN_RISK_BANDS, BRADEN_RISK_LABELS, BRADEN_SUBSCALES, bradenRiskLabel } from "@/lib/braden";
import { formatDate, formatDateTime, humanize } from "@/lib/care-format";
import { nursing } from "@/lib/nursing-api";
import {
  ASSESSMENT_TYPE_LABELS,
  BASELINE_WOUND_STATUSES,
  CARE_ACTIVITY_LABELS,
  OVERRIDE_REASONS,
  TARGET_WOUND_LOCATIONS,
  admissionStatusBadge,
  optionLabel,
  priorityBadge,
} from "@/lib/nursing-format";
import type { AdmissionReport as Report } from "@/lib/nursing-types";

const yesNo = (value: boolean) => (value ? "Yes" : "No");

/** Full recorded nursing detail for one admission, laid out for printing (ported from the nurse-form report). */
export function AdmissionReport({ patientId, admissionId, navigate }: { patientId: string; admissionId: string; navigate: Navigate }) {
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    nursing.report(admissionId).then(setReport).catch((err: Error) => setError(err.message));
  }, [admissionId]);

  const back = { label: "Patient record", onClick: () => navigate({ name: "patient", patientId }) };
  if (!report) {
    return (
      <div className="page">
        <PageHeader title="Admission report" back={back} />
        {error ? <Notice tone="danger">{error}</Notice> : <Loading label="Loading report…" />}
      </div>
    );
  }

  const { patient, admission, assessments } = report;
  const latest = assessments[assessments.length - 1];
  const status = admissionStatusBadge(admission.status);

  return (
    <div className="page report-page">
      <PageHeader
        title="Admission report"
        subtitle={`${patient.patient_name} · ${patient.hospital_number ?? patient.patient_code} · ${admission.admission_code}`}
        back={back}
        actions={
          <button type="button" className="button secondary no-print" onClick={() => window.print()}>
            <Printer aria-hidden="true" /> Print
          </button>
        }
      />
      <Notice tone="info">
        Clinical record: handle through approved clinical channels only. WoundMeter supports the nursing workflow and does not
        replace professional judgement.{patient.is_fictional_demo && " This is a fictional demo patient."}
      </Notice>

      <section className="panel stack" aria-labelledby="report-summary">
        <div className="panel-head">
          <h2 id="report-summary" className="section-title">
            Admission summary
          </h2>
          <Badge tone={status.tone}>{status.label}</Badge>
        </div>
        <dl className="fact-list two-col">
          <div>
            <dt>Patient</dt>
            <dd>
            {patient.patient_name} · reference {patient.patient_code}
            {patient.hospital_number && ` · ${patient.hospital_number}`}
          </dd>
          </div>
          <div>
            <dt>Age group · sex</dt>
            <dd>
            {humanize(patient.age_group)} · {humanize(patient.sex)}
          </dd>
          </div>
          <div>
            <dt>Ward / bed</dt>
            <dd>
            {admission.ward_code} ({admission.ward_name}) / {admission.bed}
          </dd>
          </div>
          <div>
            <dt>Admitted</dt>
            <dd>{formatDateTime(admission.admitted_at_utc)}</dd>
          </div>
          <div>
            <dt>Discharged</dt>
            <dd>{admission.discharge_at_utc ? formatDateTime(admission.discharge_at_utc) : "—"}</dd>
          </div>
          <div>
            <dt>Target wound</dt>
            <dd>{optionLabel(TARGET_WOUND_LOCATIONS, admission.target_wound_location)}</dd>
          </div>
          <div>
            <dt>Baseline wound status</dt>
            <dd>{optionLabel(BASELINE_WOUND_STATUSES, admission.baseline_wound_status)}</dd>
          </div>
          <div>
            <dt>Individual care plan</dt>
            <dd>{yesNo(admission.individual_care_plan_available)}</dd>
          </div>
          <div>
            <dt>Family participation</dt>
            <dd>{yesNo(admission.family_participation_enabled)}</dd>
          </div>
          {admission.discharge_reason && (
            <>
              <div>
                <dt>Discharge reason</dt>
                <dd>{admission.discharge_reason}</dd>
              </div>
            </>
          )}
          {admission.discharge_exception_reason && (
            <>
              <div>
                <dt>Discharge assessment exception</dt>
                <dd>{admission.discharge_exception_reason}</dd>
              </div>
            </>
          )}
        </dl>
      </section>

      <section className="panel stack" aria-labelledby="report-braden">
        <h2 id="report-braden" className="section-title">
          Braden Scale · แบบประเมินความเสี่ยงต่อการเกิดแผลกดทับ
        </h2>
        <p className="muted-text">
          Latest: {latest ? `${latest.braden.total} (${BRADEN_RISK_LABELS[latest.braden.risk_band]} · ${bradenRiskLabel(latest.braden.total)}) on ${formatDate(latest.assessment_date)} by ${latest.submitted_by}` : "no assessment recorded"}
        </p>
        <h3 className="form-section-title">Daily scores · แบบบันทึกคะแนนรายวัน</h3>
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">Date</th>
                {BRADEN_SUBSCALES.map((s) => (
                  <th scope="col" key={s.key}>
                    {s.label}
                  </th>
                ))}
                <th scope="col">Total</th>
                <th scope="col">Risk</th>
                <th scope="col">Assessed by</th>
              </tr>
            </thead>
            <tbody>
              {assessments.length === 0 ? (
                <tr>
                  <td colSpan={BRADEN_SUBSCALES.length + 4}>No assessment recorded.</td>
                </tr>
              ) : (
                assessments.map((a) => (
                  <tr key={a.assessment_id}>
                    <td data-label="Date">
                      {formatDate(a.assessment_date)}
                      <span className="cell-sub">{ASSESSMENT_TYPE_LABELS[a.assessment_type]}</span>
                    </td>
                    {BRADEN_SUBSCALES.map((s) => (
                      <td data-label={s.label} key={s.key}>
                        {a.braden[s.key]}
                      </td>
                    ))}
                    <td data-label="Total">
                      <strong>{a.braden.total}</strong>
                    </td>
                    <td data-label="Risk">{BRADEN_RISK_LABELS[a.braden.risk_band] ?? a.braden.risk_band}</td>
                    <td data-label="Assessed by">{a.submitted_by}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        <details className="clean-details">
          <summary>Scoring criteria · เกณฑ์การประเมินและการแปลผล</summary>
          <div className="stack">
            {BRADEN_SUBSCALES.map((subscale) => (
              <div key={subscale.key}>
                <h3 className="form-section-title">
                  {subscale.label} · {subscale.labelTh}
                </h3>
                <table className="data-table">
                  <tbody>
                    {subscale.options.map((option) => (
                      <tr key={option.score}>
                        <td>
                          <strong>{option.score}</strong> {option.label}
                        </td>
                        <td>{option.criterionTh}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
            <p className="muted-text">Total = sum of the six subscales (6–23) · คะแนนรวม 6–23 คะแนน</p>
            <table className="data-table">
              <tbody>
                {BRADEN_RISK_BANDS.map((band) => (
                  <tr key={band.range}>
                    <td>
                      <strong>{band.range}</strong>
                    </td>
                    <td>{band.label}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      </section>

      <section className="stack" aria-labelledby="report-history">
        <h2 id="report-history" className="section-title">
          Recorded assessments
        </h2>
        {assessments.map((a) => {
          const nurse = priorityBadge(a.priority.nurse);
          return (
            <article className="panel stack" key={a.assessment_id}>
              <div className="panel-head">
                <h3 className="form-section-title">
                  {ASSESSMENT_TYPE_LABELS[a.assessment_type]} · {formatDateTime(a.submitted_at_utc)} · {a.submitted_by}
                </h3>
                <Badge tone={nurse.tone}>{nurse.label}</Badge>
              </div>
              <dl className="fact-list two-col">
                <div>
                  <dt>Red flag · new abnormality</dt>
                  <dd>
                  {yesNo(a.quick_assessment.red_flag_present)} · {yesNo(a.quick_assessment.new_abnormality)}
                </dd>
                </div>
                <div>
                  <dt>Skin · wound trend</dt>
                  <dd>
                  {humanize(a.quick_assessment.skin_status)} · {humanize(a.quick_assessment.wound_trend)}
                </dd>
                </div>
                <div>
                  <dt>Pain · moisture · mobility</dt>
                  <dd>
                  {humanize(a.quick_assessment.pain_issue)} · {humanize(a.quick_assessment.moisture_issue)} ·{" "}
                  {humanize(a.quick_assessment.mobility_issue)}
                </dd>
                </div>
                <div>
                  <dt>Braden</dt>
                  <dd>
                  {a.braden.total} ({BRADEN_RISK_LABELS[a.braden.risk_band]}) · {a.braden.version}
                </dd>
                </div>
                <div>
                  <dt>Priority</dt>
                  <dd>
                  System {priorityBadge(a.priority.system).label}, confirmed {nurse.label}
                  {a.priority.override &&
                    ` · override ${humanize(a.priority.override_direction)}: ${optionLabel(OVERRIDE_REASONS, a.priority.override_reason)}`}
                </dd>
                </div>
                <div>
                  <dt>Reasons</dt>
                  <dd>{a.priority.reason_codes.map(humanize).join(", ")}</dd>
                </div>
                <div>
                  <dt>Review</dt>
                  <dd>
                  Suggested {a.priority.suggested_review_minutes} min · next {formatDateTime(a.priority.next_review_at_utc)} ·{" "}
                  {a.priority.rule_version}
                </dd>
                </div>
              </dl>
              {a.care_activities.length > 0 && (
                <div className="table-wrap">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th scope="col">Care activity</th>
                        <th scope="col">Critical</th>
                        <th scope="col">Status</th>
                        <th scope="col">Due</th>
                        <th scope="col">Done / not done</th>
                      </tr>
                    </thead>
                    <tbody>
                      {a.care_activities.map((c) => (
                        <tr key={c.activity_id}>
                          <td data-label="Care activity">{CARE_ACTIVITY_LABELS[c.activity_type]}</td>
                          <td data-label="Critical">{yesNo(c.critical)}</td>
                          <td data-label="Status">{humanize(c.status)}</td>
                          <td data-label="Due">{formatDateTime(c.due_at_utc)}</td>
                          <td data-label="Done / not done">
                            {c.status === "COMPLETED" && `${formatDateTime(c.completed_at_utc)} · ${c.performed_by}`}
                            {c.status === "UNABLE" && `${c.unable_reason} · ${c.performed_by}`}
                            {c.status === "PLANNED" && "—"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </article>
          );
        })}
      </section>
      <p className="fine-print">Generated {formatDateTime(report.generated_at_utc)}.</p>
    </div>
  );
}
