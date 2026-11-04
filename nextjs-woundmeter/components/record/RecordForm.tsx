"use client";

import { useRef, useState } from "react";
import { Check, CheckCircle2, Send } from "lucide-react";

import type { AiContext } from "@/components/ai/AskAiPanel";
import { DraftTextEditor } from "@/components/ai/DraftTextEditor";
import { AiAssistance } from "@/components/record/AiAssistance";
import { RecordFactsFields, type RecordFacts } from "@/components/care/RecordFactsFields";
import { Notice } from "@/components/ui/Feedback";
import { useUnsavedGuard } from "@/hooks/useUnsavedGuard";
import { can, roleLabel, type Account } from "@/lib/accounts";
import {
  APPROVAL_ATTESTATIONS,
  ZERO_AREA_ATTESTATION_LABEL,
  attestationPayload,
  attestationStates,
  attestationSubjects,
  missingAttestations,
  type AttestationKey,
  type Confirmations,
} from "@/lib/approval-attestations";
import { BRADEN_SUBSCALES, type BradenSubscaleKey } from "@/lib/braden";
import { CareApiError, type ReviewDecisionPayload } from "@/lib/care-api";
import { formatCm, humanize, isZeroArea, measurementStageLabel } from "@/lib/care-format";
import type { MeasurementVersion, ObservationRecord, RecordFields, WoundDetail } from "@/lib/care-types";

const OPTIONS = {
  woundType: ["PRESSURE_INJURY", "VENOUS_ULCER", "DIABETIC_FOOT_ULCER", "SURGICAL_WOUND", "TRAUMATIC_WOUND"],
  stage: ["NOT_APPLICABLE", "STAGE_1", "STAGE_2", "STAGE_3", "STAGE_4", "UNSTAGEABLE"],
  // CLOSED is only for a 0 cm² (no visible open wound) record, and is required for one.
  woundBed: ["GRANULATING", "EPITHELIALIZING", "SLOUGH_PRESENT", "NECROTIC_ESCHAR", "CLOSED"],
  exudate: ["NONE", "SCANT", "MODERATE", "HEAVY"],
  skin: ["INTACT", "ERYTHEMA", "MACERATED"],
  trend: ["IMPROVING", "STABLE", "WORSENING"],
};
const BRADEN_KEYS: BradenSubscaleKey[] = ["sensory_perception", "moisture", "activity", "mobility", "nutrition", "friction_and_shear"];
type Disposition = "not_used" | "accepted" | "edited" | "rejected";
type Item = { label: string; target: string; done: boolean };
type Step = { key: string; title: string; anchor: string; items: Item[] };

function SelectField({ id, label, value, options, onChange, required, invalid }: {
  id: string; label: string; value: string; options: string[]; onChange: (v: string) => void; required?: boolean; invalid?: boolean;
}) {
  return (
    <div className="field">
      <label htmlFor={id} className={required ? "is-required" : undefined}>{label}</label>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)} required={required} aria-invalid={invalid || undefined}>
        {!value && <option value="">Select…</option>}
        {options.map((o) => <option key={o} value={o}>{humanize(o)}</option>)}
      </select>
    </div>
  );
}

function factSummary(facts: RecordFacts): string {
  const parts = [
    facts.pain_score_0_10 != null ? `Pain ${facts.pain_score_0_10}/10` : null,
    facts.drainage_level ? `Drainage ${humanize(facts.drainage_level).toLowerCase()}` : null,
    facts.dressing_condition ? `Dressing ${humanize(facts.dressing_condition).toLowerCase()}` : null,
    facts.redness_observed ? `Redness ${humanize(facts.redness_observed).toLowerCase()}` : null,
    facts.concern_reported ? "Concern reported" : null,
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : "Nothing reported";
}

/**
 * Groups B–C of the record: observations, AI assistance, assessment and sign-off, with one
 * save bar. Boundary edits are saved in the photo panel (Done editing); this form waits for
 * the photo step and lists, in order, what is still needed before signing.
 */
export function RecordForm({
  obs,
  wound,
  working,
  account,
  busy,
  photoTodo,
  onSubmit,
  onSave,
  onChanged,
  demo = false,
}: {
  /** /demo only: the same form for an unsaved photo — no draft saving; signing only checks completeness. */
  demo?: boolean;
  obs: ObservationRecord;
  wound: WoundDetail;
  working: MeasurementVersion | null;
  account: Account;
  busy: boolean;
  /** What the photo step still needs (choose or finish editing the boundary), or null when it is done. */
  photoTodo: string | null;
  /** Resolves to the refusal, if any, so refused confirmations can be cleared. */
  onSubmit: (payload: ReviewDecisionPayload) => Promise<unknown>;
  onSave: (fields: RecordFields, revision: number, reason: string, submit: boolean, aiRevisionIds: string[]) => Promise<ObservationRecord>;
  onChanged: () => Promise<unknown>;
}) {
  // Classification is the existing wound identity. Findings and decisions are entered for this
  // observation; a previous assessment is never inherited.
  const saved = obs.record_draft ?? {};
  const initial = (key: string, fallback = "") => typeof saved[key] === "string" ? String(saved[key]) : fallback;
  const clinical = account.role !== "FAMILY_CAREGIVER";
  const [revision, setRevision] = useState(obs.record_revision ?? 0);
  const [reason, setReason] = useState(obs.record_amendment_reason ?? "");
  const [savedMessage, setSavedMessage] = useState("");
  const [saveError, setSaveError] = useState("");
  const [showMissing, setShowMissing] = useState(false);
  const [facts, setFacts] = useState<RecordFacts>({
    pain_score_0_10: typeof saved.pain_score_0_10 === "number" ? saved.pain_score_0_10 : null,
    drainage_level: initial("drainage_level") || null, dressing_condition: initial("dressing_condition") || null,
    redness_observed: initial("redness_observed") || null, concern_reported: Boolean(saved.concern_reported),
    non_diagnostic_notes: initial("non_diagnostic_notes"),
  });
  const [woundType, setWoundType] = useState(initial("wound_type", wound.wound_type));
  const [stage, setStage] = useState(initial("pressure_injury_stage", wound.pressure_injury_stage));
  const [woundBed, setWoundBed] = useState(initial("wound_bed_appearance"));
  const [exudate, setExudate] = useState(initial("exudate_amount"));
  const [skin, setSkin] = useState(initial("surrounding_skin"));
  const [trend, setTrend] = useState(initial("wound_trend")); // Always an explicit clinical judgement — never pre-filled.
  const [diagnosis, setDiagnosis] = useState(initial("diagnosis"));
  const [braden, setBraden] = useState<Record<BradenSubscaleKey, number>>(
    Object.fromEntries(BRADEN_KEYS.map((key) => [key, typeof saved[key] === "number" ? saved[key] : 0])) as Record<BradenSubscaleKey, number>,
  );
  const [interpretation, setInterpretation] = useState(initial("clinical_interpretation"));
  const [careDecisions, setCareDecisions] = useState(initial("care_decisions"));
  const [note, setNote] = useState(initial("final_documentation_text"));
  const [disposition, setDisposition] = useState<Disposition>(
    ["accepted", "edited", "rejected"].includes(String(saved.ai_draft_disposition)) ? saved.ai_draft_disposition as Disposition : "not_used");
  // Each confirmation records what it was given for; it lapses when that changes.
  const [confirmations, setConfirmations] = useState<Confirmations>({});
  // Ask AI suggestions applied to the text fields since the last save (recorded with the saved draft).
  const [aiRevisionIds, setAiRevisionIds] = useState<string[]>([]);
  const askAi = (field: string): AiContext | null => can(account, "ASSESS")
    ? { patientId: obs.patient_id, woundId: obs.wound_id, draftType: "clinical_note", targetId: obs.observation_id, field } : null;
  const applied = (revisionId: string) => setAiRevisionIds((ids) => [...ids, revisionId]);

  // UI hints only — the server re-checks every permission.
  const canSign = can(account, "SIGN_OFF");
  const canStage = can(account, "STAGE");
  const canDiagnose = can(account, "DIAGNOSE");
  const amending = Boolean(obs.record_base_assessment_id);

  const fields: RecordFields = { ...facts, ...(clinical ? {
    ...(canStage ? { wound_type: woundType, pressure_injury_stage: stage } : {}),
    ...(canDiagnose ? { diagnosis } : {}),
    wound_bed_appearance: woundBed, exudate_amount: exudate, surrounding_skin: skin,
    wound_trend: trend, ...braden, clinical_interpretation: interpretation,
    care_decisions: careDecisions, ai_draft_disposition: disposition, final_documentation_text: note,
  } : {}) };
  const fingerprint = JSON.stringify({ fields, reason });
  const savedFingerprint = useRef(fingerprint);
  const dirty = fingerprint !== savedFingerprint.current;
  // Unsaved record entries: leaving the screen (menu, breadcrumb, Back, closing the page) asks first.
  useUnsavedGuard(dirty && !busy);

  const zeroArea = isZeroArea(working);
  const subjects = attestationSubjects({
    observationId: obs.observation_id,
    photoSha256: obs.images.find((image) => image.image_role === "ORIGINAL_UPLOAD")?.sha256_hash,
    measurementId: working?.measurement_id ?? "",
    measurementVersion: working?.version_number ?? 0,
    colourStatus: obs.colour_calibration?.status,
    colourCorrectionApplied: obs.colour_calibration?.correction_applied,
    assessment: { woundType, stage, woundBed, exudate, skin, trend, diagnosis, braden, interpretation, careDecisions, note, disposition, facts, reason, base: obs.record_base_assessment_id },
  });
  const attestationState = attestationStates(confirmations, subjects);
  const unconfirmed = missingAttestations(confirmations, subjects);
  const setConfirmation = (key: AttestationKey, checked: boolean) =>
    setConfirmations((current) => {
      const next = { ...current };
      if (checked) next[key] = subjects[key];
      else delete next[key];
      return next;
    });

  const explanation = obs.draft_status === "current" ? obs.ai_explanation ?? null : null;
  // A note taken from an AI draft that has since gone out of date can't be signed as AI-assisted.
  const staleDraftNote = !explanation && (disposition === "accepted" || disposition === "edited");
  const draft = explanation?.documentation_draft ?? "";
  // The stored draft can quote a different model's figures, or pre-date a boundary adjustment.
  const draftAreaMatch = /area\s+([\d.]+)\s*cm/i.exec(`${explanation?.measurement_summary ?? ""} ${draft}`);
  const draftArea = draftAreaMatch ? Number(draftAreaMatch[1]) : null;
  const draftMismatch = draftArea != null && Math.abs(draftArea - (working?.area_cm2 ?? 0)) >= 0.01 ? draftArea : null;
  const originalClassification = obs.latest_clinical_assessment ?? wound;
  const needsStagingAuthority = !canStage && (woundType !== originalClassification.wound_type || stage !== originalClassification.pressure_injury_stage);
  const needsDiagnosisAuthority = !canDiagnose && diagnosis.trim() !== (obs.latest_clinical_assessment?.diagnosis_text ?? "");
  const canApproveHere = clinical && canSign && !needsStagingAuthority && !needsDiagnosisAuthority;
  const bradenTotal = Object.values(braden).reduce((a, b) => a + b, 0);
  const firstMissingBraden = BRADEN_KEYS.find((key) => braden[key] === 0);
  const filledBraden = BRADEN_KEYS.filter((key) => braden[key] !== 0).length;

  // Everything sign-off needs, in the order of the workflow: photo first, then the form.
  const steps: Step[] = [
    { key: "photo", title: "Photo & measurement", anchor: "record-photo", items: [
      ...(obs.image_integrity_verified === false ? [{ label: "Image integrity check failed (signing is blocked)", target: "record-photo", done: false }] : []),
      { label: photoTodo ?? "Boundary chosen", target: "record-photo", done: !photoTodo },
    ] },
    { key: "observations", title: "Wound observations", anchor: "grp-observations", items: [
      zeroArea
        ? { label: "Wound bed: Closed (0 cm² recorded)", target: "f-bed", done: woundBed === "CLOSED" }
        : { label: woundBed === "CLOSED" ? "Wound bed: Closed needs a 0 cm² record" : "Wound bed", target: "f-bed", done: Boolean(woundBed) && woundBed !== "CLOSED" },
      { label: "Exudate", target: "f-exudate", done: Boolean(exudate) },
      { label: "Surrounding skin", target: "f-skin", done: Boolean(skin) },
      { label: "Trend", target: "f-trend", done: Boolean(trend) },
    ] },
    { key: "assessment", title: "Clinical assessment", anchor: "grp-assessment", items: [
      { label: staleDraftNote ? "Your own note (the AI draft is out of date)" : "Clinical note", target: "f-note", done: Boolean(note.trim()) && !staleDraftNote },
      { label: `Braden scores (${filledBraden} of 6)`, target: firstMissingBraden ? `braden-${firstMissingBraden}` : "grp-assessment", done: !firstMissingBraden },
      { label: "Clinical interpretation", target: "f-interp", done: Boolean(interpretation.trim()) },
      { label: "Care decisions", target: "f-care", done: Boolean(careDecisions.trim()) },
    ] },
    { key: "review", title: "Review & sign", anchor: "grp-review", items: [
      ...(amending ? [{ label: "Revision reason", target: "f-reason", done: Boolean(reason.trim()) }] : []),
      { label: `Confirmations (${4 - unconfirmed.length} of 4 ticked)`, target: unconfirmed.length ? `attest-${unconfirmed[0]}` : "grp-review", done: !unconfirmed.length },
    ] },
  ];
  const missing = steps.flatMap((step) => step.items.filter((item) => !item.done));
  const currentStep = steps.find((step) => step.items.some((item) => !item.done))?.key;

  const goTo = (target: string) => {
    const element = document.getElementById(target);
    if (!element) return;
    element.scrollIntoView({ behavior: "smooth", block: "center" });
    (element.matches("input, select, textarea, button, [tabindex]") ? element : element.querySelector<HTMLElement>("input, select, textarea, button, [tabindex]"))?.focus({ preventScroll: true });
  };

  const lastRequest = useRef<{ fingerprint: string; id: string } | null>(null);
  const sign = async () => {
    if (!working) return;
    if (missing.length) {
      setShowMissing(true);
      goTo(missing[0].target);
      return;
    }
    const payload: ReviewDecisionPayload = {
      decision: "approve",
      // Send the displayed classification/diagnosis; the API enforces change authority.
      wound_type: woundType, pressure_injury_stage: stage, diagnosis: diagnosis.trim(),
      wound_bed_appearance: woundBed, exudate_amount: exudate, surrounding_skin: skin, wound_trend: trend, ...braden,
      clinical_interpretation: interpretation.trim(), care_decisions: careDecisions.trim(),
      ai_draft_disposition: disposition, final_documentation_text: note.trim(),
      review_notes: "Approved after photo, boundary, measurement and assessment review.",
      expected_record_revision: revision, factual_fields: { ...facts },
      ...(amending ? { amends_assessment_id: obs.record_base_assessment_id!, amendment_reason: reason.trim() } : {}),
      expected_measurement_id: working.measurement_id,
      expected_measurement_version: working.version_number, ...attestationPayload(confirmations, subjects),
      ...(aiRevisionIds.length ? { ai_revision_ids: aiRevisionIds } : {}),
    };
    const requestFingerprint = JSON.stringify(payload);
    if (lastRequest.current?.fingerprint !== requestFingerprint) lastRequest.current = { fingerprint: requestFingerprint, id: crypto.randomUUID() };
    const refusal = await onSubmit({ ...payload, approval_request_id: lastRequest.current.id });
    if (refusal instanceof CareApiError && refusal.code === "ATTESTATION_REQUIRED") {
      // Clear only what the server says is missing; everything entered stays.
      const refused = Array.isArray(refusal.body.missing_attestations) ? refusal.body.missing_attestations : [];
      setConfirmations((current) => Object.fromEntries(Object.entries(current).filter(([key]) => !refused.includes(key))) as Confirmations);
      const first = APPROVAL_ATTESTATIONS.find(({ key }) => refused.includes(key));
      if (first) goTo(`attest-${first.key}`);
    }
  };

  const save = async (submit = false) => {
    setSaveError("");
    setSavedMessage("");
    if (amending && !reason.trim()) {
      setSaveError("Enter the reason for this revision before saving.");
      goTo("f-reason");
      return;
    }
    try {
      if (dirty || submit) {
        const result = await onSave(fields, revision, reason, submit, aiRevisionIds);
        setRevision(result.record_revision ?? revision);
        setAiRevisionIds([]);
      }
      savedFingerprint.current = fingerprint;
      setSavedMessage(submit ? "Submitted for clinical review. Nothing has been signed." : `Draft saved at ${new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}. Signed versions are unchanged.`);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Could not save the draft.");
    }
  };

  const updateNote = (value: string) => {
    setNote(value);
    if (disposition === "accepted" && value !== draft) setDisposition("edited");
    else if (disposition === "edited" && value === draft) setDisposition("accepted");
  };

  const reasonField = amending && (
    <div className="field revision-reason">
      <label htmlFor="f-reason" className="is-required">Revision reason</label>
      <input id="f-reason" required maxLength={512} value={reason} onChange={(e) => setReason(e.target.value)} aria-invalid={showMissing && !reason.trim() || undefined} />
      <span className="field-hint">The signed version stays unchanged until this revision is approved.</span>
    </div>
  );

  const saveBar = (primary: React.ReactNode) => (
    <div className="save-bar" role="group" aria-label="Save and review">
      <div className="save-status" aria-live="polite">
        {demo ? <span className="muted-text">Demo · not saved to any record</span>
          : saveError ? <span className="danger-text">{saveError}</span>
          : savedMessage && !dirty ? <span>{savedMessage}</span>
            : dirty ? <span className="warning-text">Unsaved changes</span>
              : <span className="muted-text">No unsaved changes</span>}
        {canApproveHere && missing.length > 0 && (
          <>
            {showMissing && <span className="danger-text" role="alert">Not signed yet. {missing.length} item{missing.length === 1 ? "" : "s"} still to complete.</span>}
            <button type="button" className="link-button next-item" onClick={() => { setShowMissing(true); goTo(missing[0].target); }}>
              Next: {missing[0].label} <span className="fine-print">({missing.length} left)</span>
            </button>
          </>
        )}
      </div>
      <div className="save-actions">
        {!demo && <button type="button" className="button secondary" disabled={busy || !dirty} onClick={() => void save()}>Save draft</button>}
        {primary}
      </div>
    </div>
  );

  if (!clinical) {
    return (
      <div className="record-form">
        {reasonField}
        <section className="record-section" aria-labelledby="obs-title" id="grp-observations">
          <h2 id="obs-title" className="section-title">Your observations</h2>
          <RecordFactsFields value={facts} onChange={setFacts} disabled={busy} />
        </section>
        {saveBar(<button type="button" className="button primary" disabled={busy} onClick={() => void save(true)}><Send aria-hidden="true" /> Submit for review</button>)}
      </div>
    );
  }

  if (!working) return <Notice tone="warning">A calibrated measurement is required before this record can be assessed.</Notice>;
  const invalid = (value: string) => showMissing && !value.trim();

  return (
    <div className="record-form">
      {canApproveHere && (
        <nav className={`sign-steps${showMissing && missing.length ? " is-alert" : ""}`} aria-label="Steps to sign">
          <div className="sign-steps-head">
            <strong>Steps to sign</strong>
            {missing.length ? <span className="fine-print">{missing.length} item{missing.length === 1 ? "" : "s"} left</span>
              : <span className="success-text">Ready to sign</span>}
          </div>
          <ol>
            {steps.map((step, index) => {
              const left = step.items.filter((item) => !item.done);
              const state = !left.length ? "done" : step.key === currentStep ? "current" : "todo";
              return (
                <li key={step.key} className={`sign-step is-${state}`} aria-current={state === "current" ? "step" : undefined}>
                  <span className="step-marker" aria-hidden="true">{state === "done" ? <Check /> : index + 1}</span>
                  <div className="step-body">
                    <button type="button" className="step-title" aria-label={`${step.title}, ${left.length ? `${left.length} left` : "done"}`} onClick={() => goTo(step.anchor)}>
                      {step.title}
                    </button>
                    {left.length ? (
                      <span className="step-items">
                        {left.map((item, i) => <button key={`${step.key}-${i}`} type="button" className="link-button" onClick={() => goTo(item.target)}>{item.label}</button>)}
                      </span>
                    ) : <span className="step-done">Done</span>}
                  </div>
                </li>
              );
            })}
          </ol>
        </nav>
      )}
      {reasonField}

      <section className="record-section" aria-labelledby="obs-title" id="grp-observations">
        <h2 id="obs-title" className="section-title">Wound observations</h2>
        <div className="form-grid two">
          <SelectField id="f-bed" label="Wound bed" value={woundBed} options={OPTIONS.woundBed} onChange={setWoundBed} required invalid={invalid(woundBed)} />
          <SelectField id="f-exudate" label="Exudate" value={exudate} options={OPTIONS.exudate} onChange={setExudate} required invalid={invalid(exudate)} />
          <SelectField id="f-skin" label="Surrounding skin" value={skin} options={OPTIONS.skin} onChange={setSkin} required invalid={invalid(skin)} />
          <SelectField id="f-trend" label="Your assessment of the trend" value={trend} options={OPTIONS.trend} onChange={setTrend} required invalid={invalid(trend)} />
        </div>
        <details className="inline-disclosure">
          <summary>Reported observations <span className="fine-print">{factSummary(facts)}</span></summary>
          <RecordFactsFields value={facts} onChange={setFacts} disabled={busy} />
        </details>
      </section>

      <AiAssistance
        observationId={obs.observation_id}
        patientId={obs.patient_id}
        woundId={obs.wound_id}
        versions={obs.ai_visual_observations ?? []}
        explanation={explanation}
        draftStatus={obs.draft_status}
        draftMismatch={draftMismatch}
        workingArea={working.area_cm2}
        canReview={can(account, "ASSESS")}
        editable
        observationsOpen={obs.review_state === "AWAITING_CLINICAL_REVIEW"}
        disposition={disposition}
        onUseDraft={(text) => { setNote(text); setDisposition("accepted"); goTo("f-note"); }}
        onRejectDraft={() => { if (note === draft) setNote(""); setDisposition("rejected"); }}
        onChanged={onChanged}
      />

      <section className="record-section" aria-labelledby="assessment-title" id="grp-assessment">
        <h2 id="assessment-title" className="section-title">Clinical assessment</h2>
        <div className="form-grid two">
          {canStage ? <>
            <SelectField id="f-type" label="Wound type" value={woundType} options={OPTIONS.woundType} onChange={setWoundType} />
            <SelectField id="f-stage" label="Stage" value={stage} options={OPTIONS.stage} onChange={setStage} />
          </> : <p className="fine-print span-2">Classification: {humanize(woundType)} · {humanize(stage)} (changed only with staging permission)</p>}
        </div>
        {canDiagnose ? (
          <div className="field">
            <label htmlFor="f-dx">Diagnosis (optional)</label>
            <input id="f-dx" value={diagnosis} onChange={(e) => setDiagnosis(e.target.value)} autoComplete="off" />
            <span className="field-hint">Recorded under your name. The AI never suggests a diagnosis.</span>
          </div>
        ) : diagnosis ? <p className="fine-print">Recorded diagnosis: {diagnosis}</p> : null}
        <DraftTextEditor id="f-note" label="Clinical note" required rows={4} value={note} onChange={updateNote}
          invalid={invalid(note) || staleDraftNote} ai={askAi("final_documentation_text")} onAiApplied={applied}
          hint={<>
            {{ not_used: "Your own note", accepted: "Using the AI draft unchanged", edited: "Using an edited AI draft", rejected: "AI draft not used" }[disposition]}
            {aiRevisionIds.length > 0 && " · includes AI-suggested wording (recorded when you save or sign)"} · signed with your name.
            {staleDraftNote && (
              <span className="warning-text"> The measurement changed after you used the AI draft. <button type="button" className="link-button" onClick={() => { setNote(""); setDisposition("rejected"); }}>Clear the note and write my own</button></span>
            )}
          </>} />
        <fieldset className="clean-fieldset braden">
          <legend>Braden scale <span className="fine-print">{bradenTotal}/23 · select each score; none are preselected</span></legend>
          <div className="form-grid three">
            {BRADEN_SUBSCALES.map((b) => (
              <div className="field" key={b.key}>
                <label htmlFor={`braden-${b.key}`}>{b.label}</label>
                <select id={`braden-${b.key}`} value={braden[b.key]} aria-invalid={showMissing && braden[b.key] === 0 || undefined}
                  onChange={(e) => setBraden((prev) => ({ ...prev, [b.key]: Number(e.target.value) }))}>
                  <option value={0} disabled>Select…</option>
                  {b.options.map((option) => <option key={option.score} value={option.score}>{option.score} — {option.label}</option>)}
                </select>
              </div>
            ))}
          </div>
        </fieldset>
        <div className="form-grid two">
          <DraftTextEditor id="f-interp" label="Clinical interpretation" required rows={2} value={interpretation} onChange={setInterpretation}
            invalid={invalid(interpretation)} ai={askAi("clinical_interpretation")} onAiApplied={applied} />
          <DraftTextEditor id="f-care" label="Care decisions" required rows={2} value={careDecisions} onChange={setCareDecisions}
            invalid={invalid(careDecisions)} ai={askAi("care_decisions")} onAiApplied={applied} />
        </div>
      </section>

      {canApproveHere ? (
        <section className="record-section review-panel" aria-labelledby="review-title" id="grp-review">
          <h2 id="review-title" className="section-title">Review &amp; sign</h2>
          <p className="approval-summary">
            {zeroArea ? <>You are approving <strong>no visible open wound (0 cm², no boundary)</strong></>
              : <>You are approving <strong>{formatCm(working.area_cm2)} cm² · {formatCm(working.length_cm)} × {formatCm(working.width_cm)} cm · perimeter {formatCm(working.perimeter_cm)} cm</strong></>}
            <span className="fine-print"> ({measurementStageLabel(working.measurement_stage)}, version {working.version_number})</span>
          </p>
          <fieldset className="clean-fieldset attestations" aria-describedby="attestations-hint">
            <legend className="sr-only">Confirmations</legend>
            <p id="attestations-hint" className="fine-print">Tick each item yourself. A confirmation clears if what it covers changes. {4 - unconfirmed.length} of 4 confirmed.</p>
            {APPROVAL_ATTESTATIONS.map(({ key, label }) => (
              <label className={`checkbox-row${showMissing && attestationState[key] !== "confirmed" ? " is-missing" : ""}`} key={key}>
                <input id={`attest-${key}`} type="checkbox" checked={attestationState[key] === "confirmed"} onChange={(e) => setConfirmation(key, e.target.checked)} />
                <span>{zeroArea && key === "boundary_verified" ? ZERO_AREA_ATTESTATION_LABEL : label}{attestationState[key] === "changed" && <strong className="warning-text"> Changed since you confirmed it. Review it again.</strong>}</span>
              </label>
            ))}
          </fieldset>
          <p className="fine-print">Signing as {account.display_name} ({roleLabel(account.role)}).</p>
        </section>
      ) : (
        <Notice tone="info" title={canSign ? "Submit this correction for review" : "Sign-off needs a qualified clinician"}>
          {canSign ? "Changing the classification or diagnosis needs staging or diagnosis authority; submit it to a clinician who holds it."
            : `Your account (${roleLabel(account.role)}) can assess and adjust boundaries, but does not hold sign-off permission.`}
        </Notice>
      )}

      {saveBar(canApproveHere ? (
        <button type="button" className="button primary" disabled={busy} onClick={() => void sign()} aria-describedby="attestations-hint">
          <CheckCircle2 aria-hidden="true" /> {busy ? "Signing…" : amending ? "Approve revision & sign" : "Approve & sign"}{demo && " (demo)"}
        </button>
      ) : (
        <button type="button" className="button primary" disabled={busy} onClick={() => void save(true)}><Send aria-hidden="true" /> Submit for review</button>
      ))}
    </div>
  );
}
