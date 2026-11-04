"use client";

import { useCallback, useEffect, useState } from "react";

import type { Navigate } from "@/components/app/AppShell";
import { Badge, Loading, Notice } from "@/components/ui/Feedback";
import { formatDateTime } from "@/lib/care-format";
import { BRADEN_RISK_LABELS } from "@/lib/braden";
import { CareApiError } from "@/lib/care-api";
import { nursing } from "@/lib/nursing-api";
import {
  ASSESSMENT_TYPE_LABELS,
  BASELINE_WOUND_STATUSES,
  CARE_ACTIVITY_LABELS,
  TARGET_WOUND_LOCATIONS,
  admissionStatusBadge,
  optionLabel,
  priorityBadge,
  todayStatusBadge,
} from "@/lib/nursing-format";
import type { AdmissionDetail, CareActivity, NursingContext, PatientNursingSummary } from "@/lib/nursing-types";

function errorText(err: unknown, fallback: string): string {
  return err instanceof CareApiError || err instanceof Error ? err.message : fallback;
}

function AdmitForm({ patientId, context, onAdmitted }: { patientId: string; context: NursingContext; onAdmitted: () => void }) {
  const [bed, setBed] = useState("");
  const [location, setLocation] = useState("NOT_APPLICABLE");
  const [baseline, setBaseline] = useState("NO_WOUND");
  const [carePlan, setCarePlan] = useState(false);
  const [family, setFamily] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const shift = context.active_shift;
  const noWound = location === "NOT_APPLICABLE";

  const admit = async () => {
    setBusy(true);
    setError(null);
    try {
      await nursing.admit(patientId, {
        bed: bed.trim(),
        target_wound_location: location,
        baseline_wound_status: noWound ? "NO_WOUND" : baseline,
        individual_care_plan_available: carePlan,
        family_participation_enabled: family,
      });
      onAdmitted();
    } catch (err) {
      setError(errorText(err, "The patient could not be admitted."));
    } finally {
      setBusy(false);
    }
  };

  if (!shift) {
    return <Notice tone="info">Not admitted. Start a shift in Ward to admit this patient.</Notice>;
  }
  return (
    <div className="stack">
      <p className="muted-text">
        Not admitted. Admit to <strong>{shift.ward_code}</strong> (your shift ward). The admission starts awaiting its admission assessment.
      </p>
      {error && <Notice tone="danger">{error}</Notice>}
      <div className="form-grid">
        <div className="field">
          <label htmlFor="admit-bed">Bed</label>
          <input id="admit-bed" value={bed} maxLength={50} onChange={(e) => setBed(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="admit-location">Target wound</label>
          <select id="admit-location" value={location} onChange={(e) => setLocation(e.target.value)}>
            {TARGET_WOUND_LOCATIONS.map(([code, label]) => (
              <option key={code} value={code}>
                {label}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="admit-baseline">Baseline wound status</label>
          <select id="admit-baseline" value={noWound ? "NO_WOUND" : baseline} disabled={noWound} onChange={(e) => setBaseline(e.target.value)}>
            {BASELINE_WOUND_STATUSES.map(([code, label]) => (
              <option key={code} value={code}>
                {label}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="checkbox-list">
        <label className="checkbox-row">
          <input type="checkbox" checked={carePlan} onChange={(e) => setCarePlan(e.target.checked)} /> Individual care plan available
        </label>
        <label className="checkbox-row">
          <input type="checkbox" checked={family} onChange={(e) => setFamily(e.target.checked)} /> Family participation enabled
        </label>
      </div>
      <div className="button-row">
        <button type="button" className="button primary" disabled={busy || !bed.trim()} onClick={() => void admit()}>
          Admit to {shift.ward_code}
        </button>
      </div>
    </div>
  );
}

function CareChecklist({ activities, onChanged }: { activities: CareActivity[]; onChanged: () => void }) {
  const [unableFor, setUnableFor] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const act = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      setUnableFor(null);
      setReason("");
      onChanged();
    } catch (err) {
      setError(errorText(err, "The activity could not be recorded."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack">
      {error && <Notice tone="danger">{error}</Notice>}
      <ul className="row-list" aria-label="Care checklist">
        {activities.map((a) => (
          <li key={a.activity_id} className="list-row">
            <span className="row-main">
              <span className="row-title">
                {CARE_ACTIVITY_LABELS[a.activity_type] ?? a.activity_type} {a.critical && <Badge tone="danger">Critical</Badge>}
              </span>
              <span className="row-sub">
                {a.status === "PLANNED" && `Due ${formatDateTime(a.due_at_utc)}`}
                {a.status === "COMPLETED" && `Done ${formatDateTime(a.completed_at_utc)} by ${a.performed_by ?? "—"}`}
                {a.status === "UNABLE" && `Not done: ${a.unable_reason} (${a.performed_by ?? "—"})`}
              </span>
            </span>
            {a.status === "PLANNED" && (
              <span className="button-row">
                <button type="button" className="button primary small" disabled={busy} onClick={() => void act(() => nursing.completeActivity(a.activity_id))}>
                  Done
                </button>
                <button type="button" className="button secondary small" disabled={busy} onClick={() => setUnableFor(a.activity_id)}>
                  Unable
                </button>
              </span>
            )}
            {unableFor === a.activity_id && (
              <span className="inline-form">
                <label className="sr-only" htmlFor={`unable-${a.activity_id}`}>
                  Reason not done
                </label>
                <input id={`unable-${a.activity_id}`} placeholder="Reason" value={reason} maxLength={100} onChange={(e) => setReason(e.target.value)} />
                <button
                  type="button"
                  className="button secondary small"
                  disabled={busy || reason.trim().length < 2}
                  onClick={() => void act(() => nursing.activityUnable(a.activity_id, reason.trim()))}
                >
                  Record
                </button>
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function CurrentAdmission({
  detail,
  context,
  patientId,
  navigate,
  onChanged,
}: {
  detail: AdmissionDetail;
  context: NursingContext;
  patientId: string;
  navigate: Navigate;
  onChanged: () => void;
}) {
  const { admission, today, latest_assessment: latest } = detail;
  const [mode, setMode] = useState<"none" | "transfer" | "discharge">("none");
  const [ward, setWard] = useState(context.wards.find((w) => w.code !== admission.ward_code)?.code ?? "");
  const [bed, setBed] = useState("");
  const [reason, setReason] = useState("");
  const [exceptionReason, setExceptionReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const onShiftHere = context.active_shift?.ward_code === admission.ward_code;
  const status = admissionStatusBadge(admission.status);
  const todayBadge = todayStatusBadge(today.status);
  const dueType = admission.status === "PENDING_ASSESSMENT" ? "ADMISSION" : "DAILY";
  const needsException = today.status !== "COMPLETED";

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      setMode("none");
      onChanged();
    } catch (err) {
      setError(errorText(err, "The change could not be saved."));
    } finally {
      setBusy(false);
    }
  };

  const assess = (assessmentType: string) =>
    navigate({ name: "nursing-assessment", patientId, admissionId: admission.admission_id, assessmentType });

  return (
    <div className="stack">
      <div className="badge-stack">
        <Badge tone={status.tone}>{status.label}</Badge>
        <Badge tone={todayBadge.tone}>{todayBadge.label}</Badge>
        {detail.overdue_critical_care && <Badge tone="danger">Critical care overdue</Badge>}
      </div>
      <dl className="fact-list">
        <div>
          <dt>Admission</dt>
          <dd>
          {admission.admission_code} · {admission.ward_code} bed {admission.bed}
        </dd>
        </div>
        <div>
          <dt>Admitted</dt>
          <dd>{formatDateTime(admission.admitted_at_utc)}</dd>
        </div>
        <div>
          <dt>Target wound</dt>
          <dd>
          {optionLabel(TARGET_WOUND_LOCATIONS, admission.target_wound_location)} ·{" "}
          {optionLabel(BASELINE_WOUND_STATUSES, admission.baseline_wound_status)}
        </dd>
        </div>
        {latest && (
          <>
            <div>
              <dt>Latest assessment</dt>
              <dd>
              {ASSESSMENT_TYPE_LABELS[latest.assessment_type]} · {formatDateTime(latest.submitted_at_utc)} by {latest.submitted_by}
            </dd>
            </div>
            <div>
              <dt>Braden</dt>
              <dd>
              {latest.braden.total} ({BRADEN_RISK_LABELS[latest.braden.risk_band] ?? latest.braden.risk_band})
            </dd>
            </div>
            <div>
              <dt>Priority</dt>
              <dd>
              <Badge tone={priorityBadge(latest.priority.nurse).tone}>{priorityBadge(latest.priority.nurse).label}</Badge>{" "}
              next review {formatDateTime(latest.priority.next_review_at_utc)}
            </dd>
            </div>
          </>
        )}
      </dl>
      {!onShiftHere && (
        <Notice tone="info">
          To record care for this admission, start a shift on {admission.ward_code} in Ward.
        </Notice>
      )}
      {error && <Notice tone="danger">{error}</Notice>}
      <div className="button-row">
        {today.status !== "COMPLETED" && (
          <button type="button" className="button primary" disabled={!onShiftHere} onClick={() => assess(dueType)}>
            Record {ASSESSMENT_TYPE_LABELS[dueType].toLowerCase()}
          </button>
        )}
        {admission.status === "ACTIVE" && (
          <button type="button" className="button secondary" disabled={!onShiftHere} onClick={() => assess("REASSESSMENT")}>
            Reassessment
          </button>
        )}
        <button
          type="button"
          className="button secondary"
          onClick={() => navigate({ name: "admission-report", patientId, admissionId: admission.admission_id })}
        >
          Admission report
        </button>
        <button type="button" className="button ghost" disabled={!onShiftHere} onClick={() => setMode(mode === "transfer" ? "none" : "transfer")}>
          Transfer
        </button>
        <button type="button" className="button ghost" disabled={!onShiftHere} onClick={() => setMode(mode === "discharge" ? "none" : "discharge")}>
          Discharge
        </button>
      </div>

      {mode === "transfer" && (
        <div className="panel stack">
          <div className="form-grid">
            <div className="field">
              <label htmlFor="transfer-ward">New ward</label>
              <select id="transfer-ward" value={ward} onChange={(e) => setWard(e.target.value)}>
                {context.wards.map((w) => (
                  <option key={w.code} value={w.code}>
                    {w.code} — {w.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="transfer-bed">New bed</label>
              <input id="transfer-bed" value={bed} maxLength={50} onChange={(e) => setBed(e.target.value)} />
            </div>
          </div>
          <div className="button-row">
            <button
              type="button"
              className="button primary"
              disabled={busy || !ward || !bed.trim()}
              onClick={() => void run(() => nursing.transfer(admission.admission_id, ward, bed.trim()))}
            >
              Confirm transfer
            </button>
          </div>
        </div>
      )}

      {mode === "discharge" && (
        <div className="panel stack">
          {needsException && (
            <Notice tone="warning" title="Today's required assessment is not done">
              {context.can_authorise_discharge_exception
                ? "As a supervisor you may discharge with a recorded exception reason."
                : "Record today's assessment first, or ask a supervisor to discharge with an exception."}
            </Notice>
          )}
          <div className="field">
            <label htmlFor="discharge-reason">Discharge reason</label>
            <textarea id="discharge-reason" rows={2} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>
          {needsException && context.can_authorise_discharge_exception && (
            <div className="field">
              <label htmlFor="discharge-exception">Supervisor exception reason</label>
              <textarea
                id="discharge-exception"
                rows={2}
                maxLength={500}
                value={exceptionReason}
                onChange={(e) => setExceptionReason(e.target.value)}
              />
            </div>
          )}
          <div className="button-row">
            <button
              type="button"
              className="button danger"
              disabled={
                busy ||
                reason.trim().length < 2 ||
                (needsException && (!context.can_authorise_discharge_exception || exceptionReason.trim().length < 2))
              }
              onClick={() => void run(() => nursing.discharge(admission.admission_id, reason.trim(), exceptionReason.trim()))}
            >
              Confirm discharge
            </button>
          </div>
        </div>
      )}

      {detail.care_activities.length > 0 && (
        <section className="stack" aria-labelledby="checklist-title">
          <h3 id="checklist-title" className="form-section-title">
            Care checklist (latest assessment)
          </h3>
          <CareChecklist activities={detail.care_activities} onChanged={onChanged} />
        </section>
      )}

      <section className="stack" aria-labelledby="nursing-timeline-title">
        <h3 id="nursing-timeline-title" className="form-section-title">
          Admission timeline
        </h3>
        <ul className="row-list" aria-label="Admission timeline">
          {detail.timeline.map((event, index) => (
            <li key={`${event.type}-${event.occurred_at_utc}-${index}`} className="list-row">
              <span className="row-main">
                <span className="row-title">
                  {event.type === "ASSESSMENT" && event.assessment_type
                    ? ASSESSMENT_TYPE_LABELS[event.assessment_type]
                    : event.type === "ADMISSION"
                      ? "Admitted"
                      : "Discharged"}
                </span>
                <span className="row-sub">
                  {formatDateTime(event.occurred_at_utc)}
                  {event.by && ` · ${event.by}`}
                  {event.braden_total !== undefined && ` · Braden ${event.braden_total}`}
                  {event.reason && ` · ${event.reason}`}
                </span>
              </span>
              {event.priority && <Badge tone={priorityBadge(event.priority).tone}>{priorityBadge(event.priority).label}</Badge>}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

/** Inpatient nursing for one patient, inside the patient record (ward nurses and supervisors only). */
export function NursingPanel({ patientId, navigate }: { patientId: string; navigate: Navigate }) {
  const [summary, setSummary] = useState<PatientNursingSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    nursing
      .patient(patientId)
      .then((value) => {
        setSummary(value);
        setError(null);
      })
      .catch((err: Error) => setError(err.message));
  }, [patientId]);

  useEffect(load, [load]);

  if (error) return <Notice tone="danger">{error}</Notice>;
  if (!summary) return <Loading label="Loading inpatient nursing…" />;

  const past = summary.admissions.filter((a) => a.admission_id !== summary.current?.admission.admission_id);
  return (
    <div className="stack">
      {summary.admitted_elsewhere ? (
        <Notice tone="info">
          Admitted on {summary.admitted_elsewhere.ward_code} ({summary.admitted_elsewhere.admission_code}), which is not one of your wards.
        </Notice>
      ) : summary.current ? (
        <CurrentAdmission detail={summary.current} context={summary.context} patientId={patientId} navigate={navigate} onChanged={load} />
      ) : (
        <AdmitForm patientId={patientId} context={summary.context} onAdmitted={load} />
      )}
      {past.length > 0 && (
        <section className="stack" aria-labelledby="past-admissions-title">
          <h3 id="past-admissions-title" className="form-section-title">
            Previous admissions
          </h3>
          <ul className="row-list" aria-label="Previous admissions">
            {past.map((a) => (
              <li key={a.admission_id} className="list-row">
                <span className="row-main">
                  <span className="row-title">
                    {a.admission_code} · {a.ward_code} bed {a.bed}
                  </span>
                  <span className="row-sub">
                    {formatDateTime(a.admitted_at_utc)} – {formatDateTime(a.discharge_at_utc)}
                    {a.discharge_reason && ` · ${a.discharge_reason}`}
                  </span>
                </span>
                <button
                  type="button"
                  className="button secondary small"
                  onClick={() => navigate({ name: "admission-report", patientId, admissionId: a.admission_id })}
                >
                  Report
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
