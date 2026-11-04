"use client";

import { useEffect, useState } from "react";

import type { Navigate } from "@/components/app/AppShell";
import { Badge, Loading, Metric, Notice } from "@/components/ui/Feedback";
import { PageHeader } from "@/components/ui/Layout";
import { BRADEN_RISK_LABELS, BRADEN_SUBSCALES, bradenRiskLabel, type BradenSubscaleKey } from "@/lib/braden";
import { formatDateTime, humanize } from "@/lib/care-format";
import { nursing } from "@/lib/nursing-api";
import {
  ASSESSMENT_TYPE_LABELS,
  OVERRIDE_REASONS,
  QUICK_ASSESSMENT_FIELDS,
  priorityBadge,
} from "@/lib/nursing-format";
import type {
  AdmissionDetail,
  AssessmentPayload,
  AssessmentPreview,
  AssessmentType,
  NursingAssessment as SubmittedAssessment,
  Priority,
} from "@/lib/nursing-types";

type QuickKey = (typeof QUICK_ASSESSMENT_FIELDS)[number]["key"];

/** Starter care checklist from the server-suggested review interval (as in the former nurse-form app). */
function starterChecklist(priority: Priority, minutes: number) {
  const due_at = new Date(Date.now() + minutes * 60_000).toISOString();
  return [
    { activity_type: "POSITIONING" as const, critical: false, due_at },
    { activity_type: "PRESSURE_REDUCTION" as const, critical: priority !== "GREEN", due_at },
    { activity_type: "WOUND_CARE" as const, critical: priority === "RED", due_at },
    { activity_type: "ESCALATION" as const, critical: priority === "RED", due_at },
  ];
}

export function NursingAssessment({
  patientId,
  admissionId,
  assessmentType,
  navigate,
}: {
  patientId: string;
  admissionId: string;
  assessmentType: AssessmentType;
  navigate: Navigate;
}) {
  const [detail, setDetail] = useState<AdmissionDetail | null>(null);
  const [redFlag, setRedFlag] = useState(false);
  const [newAbnormality, setNewAbnormality] = useState(false);
  const [quick, setQuick] = useState<Record<QuickKey, string>>({
    skin_status: "",
    wound_trend: "",
    pain_issue: "",
    moisture_issue: "",
    mobility_issue: "",
  });
  const [braden, setBraden] = useState<Record<BradenSubscaleKey, number>>({
    sensory_perception: 0,
    moisture: 0,
    activity: 0,
    mobility: 0,
    nutrition: 0,
    friction_and_shear: 0,
  });
  const [preview, setPreview] = useState<AssessmentPreview | null>(null);
  const [nursePriority, setNursePriority] = useState<Priority | "">("");
  const [overrideReason, setOverrideReason] = useState("");
  const [submitted, setSubmitted] = useState<SubmittedAssessment | null>(null);
  const [checklistSaved, setChecklistSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    nursing.admission(admissionId).then(setDetail).catch((err: Error) => setError(err.message));
  }, [admissionId]);

  const back = { label: "Patient record", onClick: () => navigate({ name: "patient", patientId }) };
  const complete = Object.values(quick).every(Boolean) && Object.values(braden).every((v) => v > 0);
  const bradenTotal = Object.values(braden).reduce((a, b) => a + b, 0);
  const isOverride = Boolean(preview && nursePriority && nursePriority !== preview.system_priority);

  const payload = (): AssessmentPayload => ({
    red_flag_present: redFlag,
    new_abnormality: newAbnormality,
    ...quick,
    ...braden,
    ...(nursePriority ? { nurse_priority: nursePriority } : {}),
    ...(isOverride ? { override_reason: overrideReason } : {}),
  });

  const change = (update: () => void) => {
    update();
    setPreview(null);
    setNursePriority("");
    setOverrideReason("");
  };

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(err instanceof Error ? err.message : "The request failed.");
    } finally {
      setBusy(false);
    }
  };

  const calculate = () =>
    run(async () => {
      const result = await nursing.preview(admissionId, assessmentType, payload());
      setPreview(result);
      setNursePriority(result.system_priority);
    });

  const submit = () =>
    run(async () => {
      setSubmitted(await nursing.submit(admissionId, assessmentType, payload()));
    });

  const saveChecklist = () =>
    run(async () => {
      if (!submitted) return;
      await nursing.setCareChecklist(
        submitted.assessment_id,
        starterChecklist(submitted.priority.nurse, submitted.priority.suggested_review_minutes),
      );
      setChecklistSaved(true);
    });

  const title = ASSESSMENT_TYPE_LABELS[assessmentType];
  if (!detail) {
    return (
      <div className="page">
        <PageHeader title={title} back={back} />
        {error ? <Notice tone="danger">{error}</Notice> : <Loading label="Loading admission…" />}
      </div>
    );
  }
  const subtitle = `${detail.admission.patient_name ?? ""} · ${detail.admission.admission_code} · ${detail.admission.ward_code} bed ${detail.admission.bed}`;

  if (submitted) {
    const priority = priorityBadge(submitted.priority.nurse);
    return (
      <div className="page narrow-page">
        <PageHeader title="Assessment recorded" subtitle={subtitle} back={back} />
        <Notice tone="success" title={`${title} saved`}>
          Recorded by {submitted.submitted_by} at {formatDateTime(submitted.submitted_at_utc)}.
        </Notice>
        <div className="metric-grid">
          <Metric label="Braden" value={String(submitted.braden.total)} hint={BRADEN_RISK_LABELS[submitted.braden.risk_band]} />
          <Metric label="Confirmed priority" value={priority.label} hint={submitted.priority.override ? `Override (${humanize(submitted.priority.override_direction)})` : "Agrees with system"} />
          <Metric label="Next review" value={formatDateTime(submitted.priority.next_review_at_utc)} />
        </div>
        <section className="panel stack" aria-labelledby="starter-checklist-title">
          <h2 id="starter-checklist-title" className="section-title">
            Care checklist
          </h2>
          <p className="fine-print">
            Starter plan: repositioning, pressure reduction, wound care and escalation, due at the suggested review time. Critical items
            follow the confirmed priority.
          </p>
          {error && <Notice tone="danger">{error}</Notice>}
          {checklistSaved ? (
            <Notice tone="success">Care checklist saved. Record each activity from the patient record.</Notice>
          ) : (
            <div className="button-row">
              <button type="button" className="button primary" disabled={busy} onClick={() => void saveChecklist()}>
                Save care checklist
              </button>
            </div>
          )}
        </section>
        <div className="button-row">
          <button type="button" className="button secondary" onClick={() => navigate({ name: "patient", patientId })}>
            Back to patient
          </button>
          <button type="button" className="button secondary" onClick={() => navigate({ name: "admission-report", patientId, admissionId })}>
            Admission report
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="page narrow-page">
      <PageHeader title={title} subtitle={subtitle} back={back} />
      <p className="fine-print">
        Choose every answer; nothing is preselected. The server calculates the Braden total and the suggested priority, which you
        confirm or override with a reason.
      </p>
      {error && <Notice tone="danger">{error}</Notice>}

      <section className="panel stack" aria-labelledby="quick-title">
        <h2 id="quick-title" className="section-title">
          Quick assessment
        </h2>
        <div className="checkbox-list">
          <label className="checkbox-row">
            <input type="checkbox" checked={redFlag} onChange={(e) => change(() => setRedFlag(e.target.checked))} /> Red flag present
          </label>
          <label className="checkbox-row">
            <input type="checkbox" checked={newAbnormality} onChange={(e) => change(() => setNewAbnormality(e.target.checked))} /> New
            abnormality
          </label>
        </div>
        <div className="form-grid">
          {QUICK_ASSESSMENT_FIELDS.map((field) => (
            <div className="field" key={field.key}>
              <label htmlFor={`quick-${field.key}`}>{field.label}</label>
              <select
                id={`quick-${field.key}`}
                value={quick[field.key]}
                onChange={(e) => change(() => setQuick((prev) => ({ ...prev, [field.key]: e.target.value })))}
              >
                <option value="" disabled>
                  Select…
                </option>
                {field.options.map(([code, label]) => (
                  <option key={code} value={code}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
          ))}
        </div>
      </section>

      <section className="panel stack" aria-labelledby="braden-title">
        <div className="panel-head">
          <h2 id="braden-title" className="section-title">
            Braden Scale
          </h2>
          <span className="muted-text">
            {Object.values(braden).every((v) => v > 0) ? `Total ${bradenTotal} · ${bradenRiskLabel(bradenTotal)}` : "Select all six scores"}
          </span>
        </div>
        <div className="form-grid">
          {BRADEN_SUBSCALES.map((subscale) => {
            const selected = subscale.options.find((o) => o.score === braden[subscale.key]);
            return (
              <div className="field" key={subscale.key}>
                <label htmlFor={`nursing-braden-${subscale.key}`}>
                  {subscale.label} · {subscale.labelTh}
                </label>
                <select
                  id={`nursing-braden-${subscale.key}`}
                  value={braden[subscale.key]}
                  onChange={(e) => change(() => setBraden((prev) => ({ ...prev, [subscale.key]: Number(e.target.value) })))}
                >
                  <option value={0} disabled>
                    Select score…
                  </option>
                  {subscale.options.map((option) => (
                    <option key={option.score} value={option.score}>
                      {option.score} — {option.label} · {option.shortTh}
                    </option>
                  ))}
                </select>
                {selected && <span className="field-hint">{selected.criterionTh}</span>}
              </div>
            );
          })}
        </div>
        <div className="button-row">
          <button type="button" className="button primary" disabled={busy || !complete} onClick={() => void calculate()}>
            Calculate priority
          </button>
        </div>
      </section>

      {preview && (
        <section className="panel stack" aria-labelledby="priority-title" aria-live="polite">
          <div className="panel-head">
            <h2 id="priority-title" className="section-title">
              Priority
            </h2>
            <Badge tone={priorityBadge(preview.system_priority).tone}>System: {priorityBadge(preview.system_priority).label}</Badge>
          </div>
          <div className="metric-grid">
            <Metric label="Braden" value={String(preview.braden_total)} hint={BRADEN_RISK_LABELS[preview.braden_risk_band]} />
            <Metric label="Suggested review" value={String(preview.suggested_review_minutes)} unit="min" />
          </div>
          <p className="muted-text">Triggered by: {preview.priority_reason_codes.map(humanize).join(", ")}</p>
          <div className="form-grid">
            <div className="field">
              <label htmlFor="nurse-priority">Your confirmed priority</label>
              <select id="nurse-priority" value={nursePriority} onChange={(e) => setNursePriority(e.target.value as Priority)}>
                {(["RED", "YELLOW", "GREEN"] as const).map((p) => (
                  <option key={p} value={p}>
                    {priorityBadge(p).label}
                  </option>
                ))}
              </select>
            </div>
            {isOverride && (
              <div className="field">
                <label htmlFor="override-reason">Override reason</label>
                <select id="override-reason" value={overrideReason} onChange={(e) => setOverrideReason(e.target.value)}>
                  <option value="" disabled>
                    Select reason…
                  </option>
                  {OVERRIDE_REASONS.map(([code, label]) => (
                    <option key={code} value={code}>
                      {label}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>
          <div className="button-row">
            <button type="button" className="button primary" disabled={busy || (isOverride && !overrideReason)} onClick={() => void submit()}>
              Submit assessment
            </button>
          </div>
        </section>
      )}
    </div>
  );
}
