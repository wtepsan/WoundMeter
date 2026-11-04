"use client";

import { useRef, useState } from "react";
import { CheckCircle2, RotateCcw, TriangleAlert } from "lucide-react";

import type { Navigate } from "@/components/app/AppShell";
import { useCareData } from "@/components/app/CareDataProvider";
import { RecordFactsFields } from "@/components/care/RecordFactsFields";
import { SubmissionRecovery } from "@/components/care/SubmissionRecovery";
import { EmptyState, Loading, Notice } from "@/components/ui/Feedback";
import { ChoiceGroup, PageHeader } from "@/components/ui/Layout";
import { ImageUploader } from "@/components/wound-measure/ImageUploader";
import { useImagePreview } from "@/hooks/useImagePreview";
import { useUnsavedGuard } from "@/hooks/useUnsavedGuard";
import { DEMO_SAMPLE_DATA } from "@/lib/accounts";
import { fileToBase64, submitObservation, type ObservationSubmission } from "@/lib/care-api";
import { NoVisibleWound } from "@/components/record/NoVisibleWound";
import { formatDateTime, noVisibleWound, retakeReason, reviewStateLabel, woundSiteLabel } from "@/lib/care-format";
import type { ObservationRecord } from "@/lib/care-types";
import { validateImage } from "@/lib/image-validation";

type DemoVariant = "home_followup_day4" | "incomplete_ruler";
type CheckResult = { ok: boolean; message: string; details: string[] };

async function checkPhoto(file: File): Promise<CheckResult> {
  try {
    await validateImage(file);
    const bitmap = await createImageBitmap(file);
    const details = [
      `Format: ${file.type.replace("image/", "").toUpperCase()}`,
      `Resolution: ${bitmap.width} × ${bitmap.height} px`,
      `Size: ${(file.size / (1024 * 1024)).toFixed(1)} MB`,
    ];
    bitmap.close();
    return { ok: true, message: "The photo can be sent.", details };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : "This photo can't be used.", details: [] };
  }
}

/**
 * The caregiver's New measure: a photo of the chosen wound plus factual observations, then Submit for
 * review. Opened from the wound (patient and wound fixed); no boundary tools or clinical fields.
 */
export function SubmitUpdate({
  patientId: fixedPatientId,
  woundId: fixedWoundId,
  navigate,
  crumbs,
}: {
  patientId?: string;
  woundId?: string;
  navigate: Navigate;
  /** Where the capture sits: Patients › patient › wound › New measure. */
  crumbs?: React.ReactNode;
}) {
  const { patients, records, refreshPatient } = useCareData();
  const [patientId, setPatientId] = useState<string | null>(fixedPatientId ?? null);
  const [woundId, setWoundId] = useState<string | null>(fixedWoundId ?? null);
  const [file, setFile] = useState<File | null>(null);
  const [demoVariant, setDemoVariant] = useState<DemoVariant | null>(null);
  const [check, setCheck] = useState<CheckResult | null>(null);
  const checkAttempt = useRef(0);
  const [pain, setPain] = useState<number | null>(null);
  const [drainage, setDrainage] = useState<ObservationSubmission["drainage_level"] | null>(null);
  const [dressing, setDressing] = useState<ObservationSubmission["dressing_condition"] | null>(null);
  const [redness, setRedness] = useState<ObservationSubmission["redness_observed"] | null>(null);
  const [concern, setConcern] = useState(false);
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ObservationRecord | null>(null);
  const previewUrl = useImagePreview(file);
  // A photo or answers not yet sent: leaving asks first. Not while sending, and not once sent.
  useUnsavedGuard(!result && !submitting && Boolean(file || demoVariant || pain !== null || drainage || dressing || redness || concern || notes.trim()));

  if (patients === null) return <Loading />;
  const pid = patientId ?? patients[0]?.patient_id ?? null;
  const record = pid ? records[pid] : undefined;
  if (!pid) {
    return (
      <div className="page">
        <PageHeader title="New measure" />
        <EmptyState title="No patient shared with you">You can send updates once a patient or their care team gives you access.</EmptyState>
      </div>
    );
  }
  if (!record) return <Loading />;

  const wounds = record.wounds.filter((w) => (w.status === "ACTIVE" || w.status === "HEALED") && w.allowed_actions?.includes("UPLOAD_HOME_PHOTO"));
  const wound = wounds.find((w) => w.wound_id === woundId) ?? (wounds.length === 1 ? wounds[0] : null);
  const name = record.patient.display_name;

  const choosePhoto = async (next: File | null) => {
    const attempt = ++checkAttempt.current;
    setDemoVariant(null);
    setFile(next);
    setCheck(null);
    if (!next) return;
    const result = await checkPhoto(next);
    // A slower check of an earlier photo must not mark a later one as ready.
    if (attempt === checkAttempt.current) setCheck(result);
  };

  const chooseDemo = (variant: DemoVariant) => {
    checkAttempt.current += 1;
    setFile(null);
    setDemoVariant(variant);
    setCheck({ ok: true, message: "Demo photo selected. It is generated on the server and checked when you send it.", details: [] });
  };

  const resetPhoto = () => {
    checkAttempt.current += 1;
    setFile(null);
    setDemoVariant(null);
    setCheck(null);
    setResult(null);
    setError(null);
  };

  const submit = async () => {
    if (!wound) return;
    setSubmitting(true);
    setError(null);
    try {
      const obs = await submitObservation(pid, wound.wound_id, {
        capture_location_category: "HOME",
        ...(file ? { image_base64: await fileToBase64(file) } : { image_variant: demoVariant ?? "home_followup_day4" }),
        pain_score_0_10: pain,
        drainage_level: drainage ?? undefined,
        dressing_condition: dressing ?? undefined,
        redness_observed: redness ?? undefined,
        concern_reported: concern,
        non_diagnostic_notes: notes.trim(),
      });
      setResult(obs);
      void refreshPatient(pid).then(() => { if (obs.review_state !== "RETAKE_REQUESTED") navigate({ name: "review", patientId: pid, observationId: obs.observation_id }); });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Your update could not be sent.");
    } finally {
      setSubmitting(false);
    }
  };

  if (result && noVisibleWound(result)) {
    return (
      <div className="page narrow-page">
        {crumbs}
        <NoVisibleWound obs={result} canRecord canDraw={false} onRetake={resetPhoto}
          onDone={async (updated) => {
            setResult(updated);
            await refreshPatient(pid);
            navigate({ name: "review", patientId: pid, observationId: updated.observation_id });
          }} />
        <p className="fine-print">Recording 0 cm² sends it to your care team, who confirm it before it appears in the wound history.
          Your answers have been kept if you retake the photo.</p>
        <div className="button-row">
          <button type="button" className="button secondary" onClick={() => navigate({ name: "patient", patientId: pid, woundId: wound?.wound_id })}>
            Back to {name}
          </button>
        </div>
      </div>
    );
  }

  if (result) {
    const accepted = result.review_state !== "RETAKE_REQUESTED";
    return (
      <div className="page narrow-page">
        <div className="completion" role="status">
          {accepted ? (
            <CheckCircle2 aria-hidden="true" className="completion-icon" />
          ) : (
            <TriangleAlert aria-hidden="true" className="completion-icon warning" />
          )}
          <h1>{accepted ? "Update sent" : "Please take a new photo"}</h1>
          <p>{accepted ? "Your update has been submitted for clinical review." : retakeReason(result)}</p>
          <dl className="fact-list receipt">
            <div>
              <dt>Wound</dt>
              <dd>{wound ? woundSiteLabel(wound) : "—"}</dd>
            </div>
            <div>
              <dt>Submitted</dt>
              <dd>{formatDateTime(result.capture_datetime_utc)}</dd>
            </div>
            <div>
              <dt>Status</dt>
              <dd>{accepted ? "Awaiting clinical review" : reviewStateLabel(result.review_state).label}</dd>
            </div>
          </dl>
          {accepted && (
            <p className="fine-print">
              Updates are not monitored around the clock. If you are worried about something urgent, contact the care team
              directly or call emergency services (1669 in Thailand).
            </p>
          )}
          <div className="button-row center">
            {!accepted && (
              <button type="button" className="button primary" onClick={resetPhoto}>
                <RotateCcw aria-hidden="true" /> Retake photo
              </button>
            )}
            <button
              type="button"
              className={`button ${accepted ? "primary" : "secondary"}`}
              onClick={() => navigate({ name: "patient", patientId: pid, woundId: wound?.wound_id })}
            >
              Back to {name}
            </button>
          </div>
          {!accepted && <p className="fine-print">Your answers have been kept for the next photo.</p>}
        </div>
      </div>
    );
  }

  const reportComplete = pain !== null && drainage && dressing && redness;

  return (
    <div className="page narrow-page">
      {crumbs}
      <PageHeader
        title="New measure"
        subtitle={wound ? `${name} · ${woundSiteLabel(wound)} (${wound.wound_code}). A new photo of this wound and a few questions.` : `A photo and a few questions about ${name}'s wound.`}
      />
      {wound && <SubmissionRecovery patientId={pid} woundId={wound.wound_id} busy={submitting}
        onRecovered={(obs) => { setResult(obs); void refreshPatient(pid).then(() => { if (obs.review_state !== "RETAKE_REQUESTED") navigate({ name: "review", patientId: pid, observationId: obs.observation_id }); }); }} />}

      {!result && (
        <section className="panel" aria-labelledby="photo-title">
          {!fixedPatientId && patients.length > 1 && (
            <ChoiceGroup
              legend="Which patient?"
              name="patient"
              value={pid}
              options={patients.map((p) => ({ value: p.patient_id, label: p.display_name }))}
              onChange={(v) => {
                setPatientId(v);
                setWoundId(null);
                void refreshPatient(v);
              }}
            />
          )}
          {!fixedWoundId && wounds.length > 1 && (
            <ChoiceGroup
              legend="Which wound?"
              name="wound"
              value={wound?.wound_id ?? null}
              options={wounds.map((w) => ({ value: w.wound_id, label: `${woundSiteLabel(w)} (${w.wound_code})` }))}
              onChange={setWoundId}
            />
          )}
          <h2 id="photo-title" className="section-title">
            Take or upload a photo{wound ? ` of the ${woundSiteLabel(wound).toLowerCase()}` : ""}
          </h2>
          <ul className="check-list">
            <li>Lay the calibration ruler flat, right next to the wound.</li>
            <li>Keep the whole ruler — all four corner markers — in the photo.</li>
            <li>Use even light and avoid glare. Don&apos;t crop the photo.</li>
          </ul>
          <ImageUploader file={file} previewUrl={previewUrl} disabled={submitting || !wound} onSelect={(f) => void choosePhoto(f)} title={null} hint="" />
          {!wound && <p className="field-hint">Choose a wound first.</p>}
          <p className="field-hint">
            <a href="/instruction" target="_blank" rel="noreferrer">
              See the full photo guide
            </a>
          </p>
          {DEMO_SAMPLE_DATA && wound && (
            <div className="demo-box" role="group" aria-labelledby="demo-photos-title">
              <p id="demo-photos-title"><strong>Demo only:</strong> use a synthetic test photo instead.</p>
              <div className="demo-buttons">
                <button type="button" className="button secondary small" aria-pressed={demoVariant === "home_followup_day4"} onClick={() => chooseDemo("home_followup_day4")}>
                  Simulated follow-up photo
                </button>
                <button type="button" className="button secondary small" aria-pressed={demoVariant === "incomplete_ruler"} onClick={() => chooseDemo("incomplete_ruler")}>
                  Photo with a hidden ruler marker
                </button>
              </div>
            </div>
          )}
        </section>
      )}

      {check && <Notice tone={check.ok ? "info" : "danger"} title={check.ok ? "Photo ready" : "Choose another photo"}>
        {check.message} The ruler and image are checked again when you send the update.
      </Notice>}

      {!result && (
        <section className="panel" aria-labelledby="report-title">
          <h2 id="report-title" className="section-title">
            What do you see today?
          </h2>
          <p className="muted-text">Describe what you notice. You don&apos;t need to judge what it means — the care team will.</p>
          <RecordFactsFields value={{ pain_score_0_10: pain, drainage_level: drainage ?? null, dressing_condition: dressing ?? null,
            redness_observed: redness ?? null, concern_reported: concern, non_diagnostic_notes: notes }} disabled={submitting} introduced
            onChange={(value) => { setPain(value.pain_score_0_10); setDrainage(value.drainage_level as typeof drainage); setDressing(value.dressing_condition as typeof dressing); setRedness(value.redness_observed as typeof redness); setConcern(value.concern_reported); setNotes(value.non_diagnostic_notes); }} />
          <Notice tone="warning" title="Not an emergency service">
            Updates are not continuously monitored. If you think it&apos;s urgent, contact the care team directly or call
            emergency services (1669 in Thailand).
          </Notice>
          {error && (
            <Notice tone="danger" title="Not sent">
              {error}
            </Notice>
          )}
          {submitting && (
            <Notice tone="info" title="Sending your update…">
              Checking the ruler and photo. If the connection ends, check the saved submission status before retrying.
            </Notice>
          )}
          <div className="button-row">
            <button type="button" className="button primary" disabled={!reportComplete || !check?.ok || !(file || demoVariant) || submitting} onClick={() => void submit()}>
              {submitting ? "Sending…" : "Submit for review"}
            </button>

          </div>
          {!reportComplete && <p className="field-hint">Answer the four questions above to submit. &quot;Unsure&quot; is fine.</p>}
        </section>
      )}
    </div>
  );
}
