"use client";

import { useEffect, useId, useState } from "react";

import type { Navigate } from "@/components/app/AppShell";
import { useCareData } from "@/components/app/CareDataProvider";
import { Breadcrumbs } from "@/components/ui/Breadcrumbs";
import { Loading, Notice } from "@/components/ui/Feedback";
import { PageHeader } from "@/components/ui/Layout";
import { useUnsavedGuard } from "@/hooks/useUnsavedGuard";
import { can, type Account } from "@/lib/accounts";
import { registerWound } from "@/lib/care-api";
import { formatDate, humanize, patientName, woundSiteLabel } from "@/lib/care-format";

const SITES = [
  "SACRUM", "COCCYX", "LEFT_HEEL", "RIGHT_HEEL", "LEFT_ISCHIUM", "RIGHT_ISCHIUM", "LEFT_TROCHANTER", "RIGHT_TROCHANTER",
  "LEFT_FOOT", "RIGHT_FOOT", "LEFT_LOWER_LEG", "RIGHT_LOWER_LEG", "ABDOMEN", "OTHER",
];
const TYPES = ["PRESSURE_INJURY", "VENOUS_ULCER", "DIABETIC_FOOT_ULCER", "SURGICAL_WOUND", "TRAUMATIC_WOUND"];
const STAGES = ["NOT_APPLICABLE", "STAGE_1", "STAGE_2", "STAGE_3", "STAGE_4", "UNSTAGEABLE"];

const laterality = (site: string) => (site.startsWith("LEFT") ? "LEFT" : site.startsWith("RIGHT") ? "RIGHT" : "MIDLINE");

/**
 * New wound, created under the open patient (never a new patient, and no photo needed). A possible
 * duplicate (an active wound at the same site) is pointed out, never merged: the user either opens that
 * wound or confirms this is a separate one. Photos are added afterwards with New measure on the wound.
 */
export function NewWound({ patientId, account, navigate }: { patientId: string; account: Account; navigate: Navigate }) {
  const { records, refreshPatient } = useCareData();
  const record = records[patientId];
  const [site, setSite] = useState("");
  const [type, setType] = useState("PRESSURE_INJURY");
  const [stage, setStage] = useState("");
  const [separate, setSeparate] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState(false);
  const ids = { site: useId(), type: useId(), stage: useId() };
  const canStage = can(account, "STAGE");
  // Not while registering: a successful registration moves to the new wound without asking.
  useUnsavedGuard(Boolean(site) && !created && !busy);

  useEffect(() => {
    if (!record) void refreshPatient(patientId);
  }, [record, patientId, refreshPatient]);

  if (!record) return <Loading label="Loading patient…" />;
  const toPatient = { name: "patient", patientId } as const;
  const similar = record.wounds.filter((w) => w.status === "ACTIVE" && site && w.anatomical_site === site);

  async function register() {
    setBusy(true);
    setError(null);
    try {
      const wound = await registerWound(patientId, {
        anatomical_site: site,
        laterality: laterality(site),
        wound_type: canStage ? type : "UNCLASSIFIED",
        pressure_injury_stage: canStage ? stage : "NOT_ASSESSED",
      });
      setCreated(true);
      await refreshPatient(patientId);
      navigate({ name: "patient", patientId, woundId: wound.wound_id });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't register the wound.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page narrow-page">
      <Breadcrumbs navigate={navigate} items={[
        { label: "Patients", view: { name: "patients" } },
        { label: <><span className="id-chip">{record.patient.patient_code}</span> {patientName(record.patient)}</>, view: toPatient },
        { label: "New wound" },
      ]} />
      <PageHeader title="New wound" subtitle={`For ${patientName(record.patient)} (${record.patient.patient_code}). No photo is needed now: add one with New measure on the wound.`} />
      <section className="panel stack" aria-label="Wound details">
        <div className="form-grid">
          <div className="field">
            <label htmlFor={ids.site} className="is-required">Location</label>
            <select id={ids.site} value={site} onChange={(e) => { setSite(e.target.value); setSeparate(false); }}>
              <option value="">Select…</option>
              {SITES.map((s) => <option key={s} value={s}>{humanize(s)}</option>)}
            </select>
          </div>
          {canStage && (
            <>
              <div className="field">
                <label htmlFor={ids.type}>Wound type</label>
                <select id={ids.type} value={type} onChange={(e) => setType(e.target.value)}>
                  {TYPES.map((t) => <option key={t} value={t}>{humanize(t)}</option>)}
                </select>
              </div>
              <div className="field">
                <label htmlFor={ids.stage} className="is-required">Stage</label>
                <select id={ids.stage} value={stage} onChange={(e) => setStage(e.target.value)}>
                  <option value="">Select…</option>
                  {STAGES.map((s) => <option key={s} value={s}>{humanize(s)}</option>)}
                </select>
              </div>
            </>
          )}
        </div>
        {!canStage && <p className="fine-print">Wound type and stage will be set by a clinician with staging permission.</p>}
        {similar.length > 0 && (
          <Notice tone="warning" title="Possible duplicate">
            <p>
              This patient already has an active wound at the {woundSiteLabel(similar[0]).toLowerCase()}:{" "}
              {similar.map((w, i) => (
                <span key={w.wound_id}>{i > 0 && ", "}
                  <button type="button" className="link-button" onClick={() => navigate({ name: "patient", patientId, woundId: w.wound_id })}>
                    {w.wound_code}
                  </button> (registered {formatDate(w.created_at_utc)})
                </span>
              ))}. If it is the same wound, open it and use New measure instead. Nothing is merged automatically.
            </p>
            <label className="checkbox-row compact">
              <input type="checkbox" checked={separate} onChange={(e) => setSeparate(e.target.checked)} />
              This is a separate wound
            </label>
          </Notice>
        )}
        {error && <Notice tone="danger">{error}</Notice>}
        <div className="button-row">
          <button type="button" className="button primary" disabled={busy || !site || (canStage && !stage) || (similar.length > 0 && !separate)}
            onClick={() => void register()}>
            {busy ? "Registering…" : "Register wound"}
          </button>
          <button type="button" className="button ghost" disabled={busy} onClick={() => navigate(toPatient)}>Cancel</button>
        </div>
      </section>
    </div>
  );
}
