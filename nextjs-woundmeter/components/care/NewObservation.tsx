"use client";

import { useEffect, useState } from "react";

import type { Navigate } from "@/components/app/AppShell";
import { useCareData } from "@/components/app/CareDataProvider";
import { SubmitUpdate } from "@/components/caregiver/SubmitUpdate";
import { NewMeasurementPanel } from "@/components/clinical/NewMeasurementPanel";
import { Breadcrumbs, type Crumb } from "@/components/ui/Breadcrumbs";
import { Loading, Notice } from "@/components/ui/Feedback";
import { ChoiceGroup, PageHeader } from "@/components/ui/Layout";
import { can, type Account, type Portal } from "@/lib/accounts";
import { formatCm, formatDate, patientName, woundSiteLabel } from "@/lib/care-format";

/**
 * New measure: a new photo of an existing wound, never a new wound. It opens from the wound, so the patient
 * and wound are fixed and the capture keeps them throughout: staff go on to the AI measurement and review,
 * caregivers to their factual observations and Submit for review. Wounds are registered with New wound
 * on the patient page; an address without a wound only asks which existing wound is meant. A requested
 * wound that is missing, inactive or not open to this user is reported as unavailable, never swapped for another.
 */
export function NewObservation({
  patientId,
  initialWoundId,
  account,
  portal,
  navigate,
}: {
  patientId: string;
  initialWoundId?: string;
  account: Account;
  portal: Portal;
  navigate: Navigate;
}) {
  const { records, refreshPatient } = useCareData();
  const record = records[patientId];
  const [choice, setChoice] = useState<string | null>(null);

  useEffect(() => {
    if (!record) void refreshPatient(patientId);
  }, [record, patientId, refreshPatient]);

  if (!record) return <Loading label="Loading patient…" />;
  const clinical = portal === "clinical";
  const wounds = record.wounds.filter((w) => w.status === "ACTIVE" && (clinical || w.allowed_actions?.includes("UPLOAD_HOME_PHOTO")));
  const wound = wounds.find((w) => w.wound_id === initialWoundId) ?? null;
  const requested = initialWoundId ? record.wounds.find((w) => w.wound_id === initialWoundId) ?? null : null;
  const patientCrumb: Crumb = {
    label: <><span className="id-chip">{record.patient.patient_code}</span> {patientName(record.patient)}</>,
    view: { name: "patient", patientId },
  };

  if (!wound) {
    const selected = choice ?? (wounds.length === 1 ? wounds[0].wound_id : null);
    return (
      <div className="page narrow-page">
        <Breadcrumbs navigate={navigate} items={[{ label: "Patients", view: { name: "patients" } }, patientCrumb, { label: "New measure" }]} />
        <PageHeader title="New measure" subtitle={`A new photo of one of ${patientName(record.patient)}'s wounds.`} />
        {initialWoundId && (
          <Notice tone="warning" title="This wound is unavailable">
            {!requested ? "The wound in this link was not found, or you do not have access to it."
              : requested.status !== "ACTIVE" ? `${woundSiteLabel(requested)} (${requested.wound_code}) is no longer active, so it cannot be photographed.`
                : `You do not have permission to photograph ${woundSiteLabel(requested)} (${requested.wound_code}).`}
            {" "}No other wound was chosen for you.
          </Notice>
        )}
        <section className="panel" aria-labelledby="which-wound">
          <h2 id="which-wound" className="section-title">{initialWoundId ? "Choose a wound to photograph" : "Which wound?"}</h2>
          {wounds.length > 0 ? (
            <ChoiceGroup
              legend="Active wounds"
              name="wound"
              value={selected}
              options={wounds.map((w) => {
                const last = w.approved_timeline[w.approved_timeline.length - 1];
                return {
                  value: w.wound_id,
                  label: `${woundSiteLabel(w)} (${w.wound_code})${last ? ` — ${formatCm(last.area_cm2)} cm², ${formatDate(last.capture_datetime_utc)}` : ""}`,
                };
              })}
              onChange={setChoice}
            />
          ) : (
            <p className="muted-text">There is no active wound you can photograph for this patient.
              {clinical && can(account, "REGISTER_WOUND") ? " Register a wound from the patient's Wounds section first." : ""}</p>
          )}
          <div className="button-row">
            <button type="button" className="button primary" disabled={!selected}
              onClick={() => selected && navigate({ name: "new-observation", patientId, woundId: selected })}>
              Continue
            </button>
            <button type="button" className="button ghost" onClick={() => navigate({ name: "patient", patientId })}>Back to wounds</button>
          </div>
        </section>
      </div>
    );
  }

  const woundView = { name: "patient", patientId, woundId: wound.wound_id } as const;
  const crumbs = (
    <Breadcrumbs navigate={navigate} items={[
      { label: "Patients", view: { name: "patients" } },
      patientCrumb,
      { label: <>{woundSiteLabel(wound)} <span className="wound-code">{wound.wound_code}</span></>, view: woundView },
      { label: "New measure" },
    ]} />
  );

  return clinical ? (
    <div className="page">
      {crumbs}
      <PageHeader title="New measure" subtitle={`${patientName(record.patient)} · ${woundSiteLabel(wound)} ${wound.wound_code}. A new photo of this wound, not a new wound.`} />
      <NewMeasurementPanel
        patientId={patientId}
        wound={wound}
        role={account.role}
        onCancel={() => navigate(woundView)}
        onSubmitted={async (obs) => {
          await refreshPatient(patientId);
          navigate(can(account, "ASSESS") ? { name: "review", patientId, observationId: obs.observation_id } : woundView);
        }}
      />
    </div>
  ) : (
    <SubmitUpdate patientId={patientId} woundId={wound.wound_id} navigate={navigate} crumbs={crumbs} />
  );
}
