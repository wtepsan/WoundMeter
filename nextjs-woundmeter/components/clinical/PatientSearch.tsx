"use client";

import { useId, useState } from "react";
import { BedDouble, ChevronRight, Search, UserPlus, Users } from "lucide-react";

import type { Navigate } from "@/components/app/AppShell";
import { useCareData } from "@/components/app/CareDataProvider";
import { Badge, EmptyState, Loading, Notice } from "@/components/ui/Feedback";
import { ChoiceGroup, PageHeader } from "@/components/ui/Layout";
import { can, type Account } from "@/lib/accounts";
import { CareApiError, searchPatients, type SearchType } from "@/lib/care-api";
import { formatDate, patientName } from "@/lib/care-format";
import type { PatientSearchResult, PatientSummary } from "@/lib/care-types";
import { digitsOnly, formatThaiCitizenId, isValidThaiCitizenId } from "@/lib/thai-id";

const SEARCH_TYPES: Array<{ value: SearchType; label: string }> = [
  { value: "REFERENCE", label: "Patient ID" },
  { value: "NAME", label: "Name" },
  { value: "HN", label: "Hospital number" },
  { value: "NATIONAL_ID", label: "Citizen ID" },
];

const PLACEHOLDERS: Record<SearchType, string> = {
  NATIONAL_ID: "13-digit Thai Citizen ID",
  HN: "e.g. HN-DEMO-0001",
  NAME: "At least 3 letters",
  REFERENCE: "e.g. P001",
};

/** Patients | Ward board, for ward nurses; both live under the Patients destination. */
export function PatientsTabs({ current, navigate }: { current: "patients" | "ward"; navigate: Navigate }) {
  return (
    <nav className="page-tabs" aria-label="Patient views">
      <button type="button" aria-current={current === "patients" ? "page" : undefined} onClick={() => navigate({ name: "patients" })}>
        <Users aria-hidden="true" /> Patients
      </button>
      <button type="button" aria-current={current === "ward" ? "page" : undefined} onClick={() => navigate({ name: "ward" })}>
        <BedDouble aria-hidden="true" /> Ward board
      </button>
    </nav>
  );
}

export function PatientRow({ patient, onOpen, note, meta }: { patient: PatientSummary; onOpen: () => void; note?: string; meta?: React.ReactNode }) {
  return (
    <li>
      <button type="button" className="row patient-row" onClick={onOpen} aria-label={`Open patient ${patient.display_name}`}>
        <span className="row-main">
          <span className="row-title"><span className="id-chip">{patient.patient_code}</span> {patientName(patient)}</span>
          <span className="row-sub">
            {patient.date_of_birth ? `Born ${formatDate(patient.date_of_birth)}` : patient.age_group ?? ""}
            {meta}
          </span>
        </span>
        <span className="row-meta">
          {patient.hospital_number ?? "No HN"}
          {patient.national_id_masked && <span className="cell-sub mono">ID {patient.national_id_masked}</span>}
        </span>
        <span className="row-meta">{patient.org_name ?? patient.org_id}</span>
        <span className="row-status">{patient.on_care_team && <Badge tone="info">Your care team</Badge>}</span>
        <ChevronRight aria-hidden="true" className="row-chevron" />
      </button>
      {note && <p className="fine-print dup-reason">{note}</p>}
    </li>
  );
}

export function PatientSearch({ account, navigate, tabs }: { account: Account; navigate: Navigate; tabs?: React.ReactNode }) {
  const { patients, records, loading } = useCareData();
  const [type, setType] = useState<SearchType>("REFERENCE");
  const [query, setQuery] = useState("");
  const [dob, setDob] = useState("");
  const [result, setResult] = useState<PatientSearchResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  const queryId = useId();
  const dobId = useId();

  const idInvalid = type === "NATIONAL_ID" && digitsOnly(query).length === 13 && !isValidThaiCitizenId(query);
  const canSubmit =
    !searching &&
    (type === "NATIONAL_ID" ? isValidThaiCitizenId(query) : type === "NAME" ? query.trim().length >= 3 : query.trim().length > 0);

  const open = (p: PatientSummary) => navigate({ name: "patient", patientId: p.patient_id });

  return (
    <div className="page page-wide">
      {tabs}
      <PageHeader
        title="Patients"
        subtitle="Search by patient ID, name, hospital number or Citizen ID. Only your organisation and care teams are searchable."
        actions={
          can(account, "REGISTER_PATIENT") && (
            <button type="button" className="button primary" onClick={() => navigate({ name: "register" })}>
              <UserPlus aria-hidden="true" /> New patient
            </button>
          )
        }
      />

      <form
        className="panel search-panel"
        role="search"
        onSubmit={async (e) => {
          e.preventDefault();
          setSearching(true);
          setError(null);
          try {
            // Sent in a POST body: identifiers never appear in the URL or browser history.
            setResult(await searchPatients(type, type === "NATIONAL_ID" ? digitsOnly(query) : query.trim(), dob || undefined));
          } catch (err) {
            setResult(null);
            setError(err instanceof CareApiError ? err.message : "Search failed.");
          } finally {
            setSearching(false);
          }
        }}
      >
        <ChoiceGroup
          legend="Search by"
          name="search-type"
          value={type}
          options={SEARCH_TYPES}
          onChange={(t) => {
            setType(t);
            setQuery("");
            setResult(null);
          }}
        />
        <div className="search-fields">
          <div className="field grow">
            <label htmlFor={queryId}>{SEARCH_TYPES.find((t) => t.value === type)?.label}</label>
            <input
              id={queryId}
              value={type === "NATIONAL_ID" ? formatThaiCitizenId(query) : query}
              onChange={(e) => setQuery(type === "NATIONAL_ID" ? digitsOnly(e.target.value) : e.target.value)}
              placeholder={PLACEHOLDERS[type]}
              inputMode={type === "NATIONAL_ID" ? "numeric" : "text"}
              autoComplete="off"
              spellCheck={false}
              aria-invalid={idInvalid || undefined}
              aria-describedby={`${queryId}-hint`}
            />
            <span id={`${queryId}-hint`} className={`field-hint ${idInvalid ? "danger-text" : ""}`}>
              {idInvalid
                ? "This Citizen ID's check digit doesn't match. Check the number."
                : type === "NATIONAL_ID"
                  ? "Exact match only. The number is never shown in full or stored in search history."
                  : type === "NAME"
                    ? "Add the date of birth to narrow similar names."
                    : "Exact match."}
            </span>
          </div>
          <div className="field">
            <label htmlFor={dobId}>Date of birth (optional)</label>
            <input id={dobId} type="date" value={dob} onChange={(e) => setDob(e.target.value)} />
          </div>
          <button type="submit" className="button primary search-submit" disabled={!canSubmit}>
            <Search aria-hidden="true" /> {searching ? "Searching…" : "Search"}
          </button>
        </div>
      </form>

      {error && <Notice tone="danger">{error}</Notice>}

      {result && (
        <section aria-labelledby="results-title" className="stack">
          <h2 id="results-title" className="section-title">
            {result.results.length === 0 ? "No matching patients" : `${result.results.length} matching patient${result.results.length === 1 ? "" : "s"}`}
          </h2>
          {result.needs_verification && (
            <Notice tone="warning" title="Confirm the patient's identity">
              Several patients look alike. Add the date of birth, or check the hospital number before opening a record.
            </Notice>
          )}
          {result.truncated && <Notice tone="info">Showing the first 10 results. Refine the search.</Notice>}
          {result.results.length === 0 ? (
            <p className="muted-text">
              Only patients in your organisation or care team are searchable.
              {can(account, "REGISTER_PATIENT") && " If this is a new patient, register them."}
            </p>
          ) : (
            <ul className="row-list" aria-label="Search results">
              {result.results.map((p) => (
                <PatientRow key={p.patient_id} patient={p} onOpen={() => open(p)} />
              ))}
            </ul>
          )}
        </section>
      )}

      <section aria-labelledby="my-patients-title" className="stack">
        <h2 id="my-patients-title" className="section-title">
          My patients
        </h2>
        {patients === null ? (
          <Loading label={loading ? "Loading…" : ""} />
        ) : patients.length === 0 ? (
          <EmptyState title="You're not on any care team yet">Search above, or ask an administrator to assign you.</EmptyState>
        ) : (
          <ul className="row-list" aria-label="My patients">
            {patients.map((p) => {
              const record = records[p.patient_id];
              const active = record?.wounds.filter((w) => w.status === "ACTIVE").length;
              const waiting = record?.wounds.reduce((n, w) => n + w.observations.filter((o) => o.review_state === "AWAITING_CLINICAL_REVIEW").length, 0) ?? 0;
              return (
                <PatientRow key={p.patient_id} patient={{ ...p, on_care_team: true }} onOpen={() => open(p)}
                  meta={record ? <> · {active} active wound{active === 1 ? "" : "s"}{waiting ? ` · ${waiting} to review` : ""}</> : null} />
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
