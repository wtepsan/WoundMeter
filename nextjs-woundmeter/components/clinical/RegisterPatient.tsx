"use client";

import { useId, useState } from "react";

import type { Navigate } from "@/components/app/AppShell";
import { PatientRow } from "@/components/clinical/PatientSearch";
import { Breadcrumbs } from "@/components/ui/Breadcrumbs";
import { Notice } from "@/components/ui/Feedback";
import { PageHeader } from "@/components/ui/Layout";
import type { Account } from "@/lib/accounts";
import { CareApiError, checkDuplicates, registerPatient, type PatientRegistration } from "@/lib/care-api";
import type { DuplicateCheckResult } from "@/lib/care-types";
import { digitsOnly, formatThaiCitizenId, isValidThaiCitizenId } from "@/lib/thai-id";

const NO_ID_REASONS = ["Foreign national", "Newborn — ID not yet issued", "Identity not yet verified", "Other"];

export function RegisterPatient({ account, navigate }: { account: Account; navigate: Navigate }) {
  const [fullName, setFullName] = useState("");
  const [dob, setDob] = useState("");
  const [citizenId, setCitizenId] = useState("");
  const [noId, setNoId] = useState(false);
  const [noIdReason, setNoIdReason] = useState("");
  const [hn, setHn] = useState("");
  const [phone, setPhone] = useState("");
  const [dupes, setDupes] = useState<DuplicateCheckResult | null>(null);
  const [overrideReason, setOverrideReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ids = { name: useId(), dob: useId(), cid: useId(), reason: useId(), hn: useId(), phone: useId(), override: useId() };

  const idEntered = digitsOnly(citizenId).length > 0;
  const idValid = isValidThaiCitizenId(citizenId);
  const identityOk = noId ? Boolean(noIdReason) : idValid;
  const formOk = fullName.trim().length >= 2 && Boolean(dob) && identityOk;

  const registration = (): PatientRegistration => ({
    full_name: fullName.trim(),
    date_of_birth: dob,
    national_id: noId ? null : digitsOnly(citizenId),
    no_national_id_reason: noId ? noIdReason : null,
    hospital_number: hn.trim() || null,
    contact_phone: phone.trim() || null,
  });

  const create = async (confirm: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const patient = await registerPatient({
        ...registration(),
        confirm_not_duplicate: confirm,
        duplicate_override_reason: confirm ? overrideReason.trim() : null,
      });
      navigate({ name: "patient", patientId: patient.patient_id });
    } catch (err) {
      // A conflict with duplicate details lists the matches; any other conflict (for example a reference already
      // in use) is a plain message that never describes the other patient.
      if (err instanceof CareApiError && err.status === 409 && err.body.duplicates) {
        setDupes(err.body.duplicates as DuplicateCheckResult);
      } else {
        setError(err instanceof Error ? err.message : "Registration failed.");
      }
    } finally {
      setBusy(false);
    }
  };

  const checkThenCreate = async () => {
    setBusy(true);
    setError(null);
    try {
      const reg = registration();
      const result = await checkDuplicates({
        full_name: reg.full_name,
        date_of_birth: reg.date_of_birth,
        national_id: reg.national_id,
        hospital_number: reg.hospital_number,
      });
      const any = result.exact_matches.length || result.possible_matches.length || result.conflict_outside_scope;
      if (any) {
        setDupes(result);
        setBusy(false);
        return;
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't check for duplicates.");
      setBusy(false);
      return;
    }
    await create(false);
  };

  const blocked = Boolean(dupes && (dupes.exact_matches.length || dupes.conflict_outside_scope));

  return (
    <div className="page narrow-page">
      <Breadcrumbs navigate={navigate} items={[{ label: "Patients", view: { name: "patients" } }, { label: "New patient" }]} />
      <PageHeader
        title="New patient"
        subtitle={`Registered to ${account.org_name ?? account.org_id}. Duplicates are checked before the record is created.`}
      />
      <form
        className="panel"
        onSubmit={(e) => {
          e.preventDefault();
          void checkThenCreate();
        }}
      >
        <div className="field">
          <label htmlFor={ids.name}>Full name</label>
          <input id={ids.name} value={fullName} onChange={(e) => { setFullName(e.target.value); setDupes(null); }} autoComplete="off" required />
        </div>
        <div className="field narrow">
          <label htmlFor={ids.dob}>Date of birth</label>
          <input id={ids.dob} type="date" value={dob} max={new Date().toISOString().slice(0, 10)} onChange={(e) => { setDob(e.target.value); setDupes(null); }} required />
        </div>

        <fieldset className="choice-group">
          <legend>Thai Citizen ID</legend>
          {!noId && (
            <div className="field narrow">
              <label htmlFor={ids.cid} className="sr-only">Thai Citizen ID</label>
              <input
                id={ids.cid}
                value={formatThaiCitizenId(citizenId)}
                onChange={(e) => { setCitizenId(digitsOnly(e.target.value)); setDupes(null); }}
                inputMode="numeric"
                autoComplete="off"
                placeholder="13 digits"
                aria-invalid={(idEntered && digitsOnly(citizenId).length === 13 && !idValid) || undefined}
                aria-describedby={`${ids.cid}-hint`}
              />
              <span id={`${ids.cid}-hint`} className={`field-hint ${idEntered && digitsOnly(citizenId).length === 13 && !idValid ? "danger-text" : ""}`}>
                {digitsOnly(citizenId).length === 13
                  ? idValid
                    ? "Valid format. Stored encrypted; only the last 4 digits are ever shown."
                    : "The check digit doesn't match. Check the number."
                  : "Used to identify the patient, never to grant access."}
              </span>
            </div>
          )}
          <label className="checkbox-row">
            <input type="checkbox" checked={noId} onChange={(e) => { setNoId(e.target.checked); setDupes(null); }} />
            <span>Patient has no Thai Citizen ID</span>
          </label>
          {noId && (
            <div className="field narrow">
              <label htmlFor={ids.reason}>Reason</label>
              <select id={ids.reason} value={noIdReason} onChange={(e) => setNoIdReason(e.target.value)} required>
                <option value="">Select…</option>
                {NO_ID_REASONS.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </div>
          )}
        </fieldset>

        <div className="form-grid">
          <div className="field">
            <label htmlFor={ids.hn}>Hospital number (optional)</label>
            <input id={ids.hn} value={hn} onChange={(e) => { setHn(e.target.value); setDupes(null); }} autoComplete="off" />
          </div>
          <div className="field">
            <label htmlFor={ids.phone}>Contact phone (optional)</label>
            <input id={ids.phone} type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} autoComplete="off" />
          </div>
        </div>

        {error && <Notice tone="danger">{error}</Notice>}

        {dupes && (
          <section className="stack" aria-labelledby="dupes-title">
            <h2 id="dupes-title" className="section-title">
              {blocked ? "This patient is already registered" : "Check for an existing record"}
            </h2>
            {dupes.conflict_outside_scope && (
              <Notice tone="danger">
                A record with this Citizen ID or hospital number exists in another organisation. Records are never
                merged automatically — contact that organisation or your administrator.
              </Notice>
            )}
            {[...dupes.exact_matches, ...dupes.possible_matches].length > 0 && (
              <ul className="row-list" aria-label="Possible existing records">
                {[...dupes.exact_matches, ...dupes.possible_matches].map((m) => (
                  <PatientRow
                    key={m.patient.patient_id}
                    patient={m.patient}
                    note={`Matched on: ${m.reasons.join(", ")}`}
                    onOpen={() => navigate({ name: "patient", patientId: m.patient.patient_id })}
                  />
                ))}
              </ul>
            )}
            {!blocked && (
              <div className="inline-confirm">
                <strong>These are different people</strong>
                <p>Records are never merged automatically. Explain how you verified this patient is not the same person.</p>
                <div className="field">
                  <label htmlFor={ids.override}>How identity was verified</label>
                  <textarea id={ids.override} rows={2} value={overrideReason} onChange={(e) => setOverrideReason(e.target.value)} />
                </div>
                <button type="button" className="button secondary" disabled={busy || !overrideReason.trim()} onClick={() => void create(true)}>
                  Register as a new patient
                </button>
              </div>
            )}
          </section>
        )}

        {!dupes && (
          <div className="button-row">
            <button type="submit" className="button primary" disabled={busy || !formOk}>
              {busy ? "Checking…" : "Check and register"}
            </button>
          </div>
        )}
      </form>
    </div>
  );
}
