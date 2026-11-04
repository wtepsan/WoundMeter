"use client";

import { useState } from "react";
import { Check } from "lucide-react";

import { SubmissionRecovery } from "@/components/care/SubmissionRecovery";
import { LiveCamera } from "@/components/demo/LiveCamera";
import { SamplePhotos } from "@/components/demo/SamplePhotos";
import { Notice } from "@/components/ui/Feedback";
import { NoVisibleWound } from "@/components/record/NoVisibleWound";
import { ImageUploader } from "@/components/wound-measure/ImageUploader";
import { useImagePreview } from "@/hooks/useImagePreview";
import { useUnsavedGuard } from "@/hooks/useUnsavedGuard";
import { DEMO_SAMPLE_DATA, can, type Account } from "@/lib/accounts";
import { CareApiError, fileToBase64, submitObservation, type ObservationSubmission } from "@/lib/care-api";
import { NO_VISIBLE_WOUND_TITLE, noVisibleWound, retakeReason, woundSiteLabel } from "@/lib/care-format";
import type { ObservationRecord, WoundDetail } from "@/lib/care-types";
import { validateImage } from "@/lib/image-validation";

const DEMO_NO_WOUND = "No open wound was identified in this photo. The wound may have healed, or no wound may be present. "
  + "This demo saves nothing, so 0 cm² is recorded only in the full app: sign in with a demo account and use New measure on the demo patient's wound.";

/** Clinician capture: upload a calibrated photo; the AI proposal then goes to review. */
export function NewMeasurementPanel({
  patientId,
  wound,
  role,
  account,
  onSubmitted,
  onCancel,
  correctionOf,
  liveCamera = false,
  samplePhotos = false,
}: {
  /** Add the in-browser camera (works on laptops too); used by /demo. */
  liveCamera?: boolean;
  /** Offer the bundled sample ruler photos (demo mode). */
  samplePhotos?: boolean;
  correctionOf?: { observationId: string; reason: string };
  patientId: string;
  wound: WoundDetail;
  role: string;
  /** Who is measuring: decides whether "Draw outline" is offered when no wound is found. */
  account?: Account;
  /** Opens the record; `drawOutline` asks it to start boundary editing. */
  onSubmitted: (obs: ObservationRecord, options?: { drawOutline?: boolean }) => void;
  onCancel: () => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notSent, setNotSent] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  // A calibrated photo on which the AI found no wound: record 0 cm², draw the outline, or retake.
  const [noWound, setNoWound] = useState<ObservationRecord | null>(null);
  const canDraw = Boolean(account && account.role !== "FAMILY_CAREGIVER" && account.role !== "PATIENT" && can(account, "ASSESS"));
  const retake = () => { setNoWound(null); setError(null); setFile(null); };
  const previewUrl = useImagePreview(file);
  // A chosen photo that has not been measured yet would be lost by leaving. Once it is measured, the host
  // refreshes the record and then opens it, so the guard must stay off after busy ends.
  useUnsavedGuard(Boolean(file) && !busy && !submitted);
  const location = role === "FAMILY_CAREGIVER" ? "HOME" : role === "HOME_CARE_PROFESSIONAL" ? "COMMUNITY" : "HOSPITAL";

  const submit = async (source: { file: File } | { variant: NonNullable<ObservationSubmission["image_variant"]> }) => {
    setBusy(true);
    setError(null);
    setNotSent(false);
    setNoWound(null);
    try {
      const body: ObservationSubmission = {
        capture_location_category: location,
        ...(correctionOf ? { corrects_observation_id: correctionOf.observationId, correction_reason: correctionOf.reason } : {}),
        // Clinician captures carry no caregiver symptom report.
        pain_score_0_10: null,
        non_diagnostic_notes: "",
      };
      if ("file" in source) {
        await validateImage(source.file);
        body.image_base64 = await fileToBase64(source.file);
      } else {
        body.image_variant = source.variant;
      }
      const obs = await submitObservation(patientId, wound.wound_id, body);
      if (noVisibleWound(obs)) {
        setNoWound(obs);
        return;
      }
      if (obs.observation_id.startsWith("DEMO-") && obs.image_quality_status === "no_wound_detected") {
        // The stateless demo saves nothing, so 0 cm² can be recorded only in the full app.
        setError(DEMO_NO_WOUND);
        return;
      }
      if (obs.review_state === "RETAKE_REQUESTED") {
        setError(retakeReason(obs, { technical: true }));
        return;
      }
      setSubmitted(true);
      onSubmitted(obs);
    } catch (err) {
      // A connection failure says nothing about the photo itself.
      setNotSent(err instanceof CareApiError && err.status === 0);
      setError(err instanceof Error ? err.message : "Upload failed.");
    } finally {
      setBusy(false);
    }
  };

  const blocked = Boolean(correctionOf && !correctionOf.reason.trim());

  return (
    <section className="panel capture-panel" aria-labelledby="new-measurement-title">
      <h2 id="new-measurement-title" className="section-title">
        {correctionOf ? "New photo correction" : "Photo"} · {woundSiteLabel(wound)}
      </h2>
      <p className="muted-text">
        WoundMeter finds the ruler, outlines the wound with Meta SAM and opens the record for your review. Nothing is
        approved until an authorised clinician signs it.
      </p>

      {error && (
        <Notice tone={error === DEMO_NO_WOUND ? "warning" : "danger"}
          title={notSent ? "Not measured yet" : error === DEMO_NO_WOUND ? NO_VISIBLE_WOUND_TITLE : "This photo can't be measured"}>
          {error}
        </Notice>
      )}
      {noWound && (
        <NoVisibleWound obs={noWound} canRecord canDraw={canDraw} onRetake={retake}
          onDone={(updated, intent) => { setSubmitted(true); setNoWound(null); onSubmitted(updated, { drawOutline: intent === "draw_outline" }); }} />
      )}

      <SubmissionRecovery patientId={patientId} woundId={wound.wound_id} busy={busy}
        onRecovered={(obs) => {
          if (noVisibleWound(obs)) return setNoWound(obs);
          if (obs.review_state === "RETAKE_REQUESTED") return setError(retakeReason(obs, { technical: true }));
          setSubmitted(true);
          onSubmitted(obs);
        }} />

      <ol className="capture-steps">
        <li className={`capture-step${file ? " is-done" : " is-current"}`}>
          <h3 className="capture-step-title"><span className="step-marker" aria-hidden="true">{file ? <Check /> : 1}</span> Take or choose the photo</h3>
          <ul className="check-list compact">
            <li>Lay the ruler flat, right next to the wound.</li>
            <li>Keep all four corner markers in the photo.</li>
            <li>Use even light, avoid glare, and don&apos;t crop.</li>
          </ul>
          <ImageUploader file={file} previewUrl={previewUrl} disabled={busy} onSelect={(next) => { setFile(next); setError(null); }} title={null}
            showCameraButton={!liveCamera} />
          {liveCamera && <LiveCamera disabled={busy} onCapture={(next) => { setFile(next); setError(null); }} />}
          {samplePhotos && (
            <div className="demo-box" role="group" aria-labelledby="sample-photos-title">
              <p id="sample-photos-title"><strong>No ruler at hand?</strong> Use a sample photo. It already includes the WoundMeter ruler; C shows a healed wound.</p>
              <SamplePhotos disabled={busy} onUse={(next) => { setFile(next); setError(null); setNoWound(null); }} />
            </div>
          )}
        </li>
        <li className={`capture-step${file ? " is-current" : ""}`}>
          <h3 className="capture-step-title"><span className="step-marker" aria-hidden="true">2</span> Measure</h3>
          <p className="field-hint">
            {file ? "Usually takes under a minute. Keep this page open; the record opens when it is done." : "Choose a photo in step 1 first."}
          </p>
          {busy && (
            <Notice tone="info" title="Measuring…">
              Detecting the ruler and outlining the wound. If the connection times out, check the saved submission status before retrying.
            </Notice>
          )}
          <div className="button-row">
            <button type="button" className="button primary" disabled={busy || !file || blocked} onClick={() => file && void submit({ file })}>
              {busy ? "Measuring…" : "Measure this photo"}
            </button>
            <button type="button" className="button ghost" disabled={busy} onClick={onCancel}>
              Cancel
            </button>
          </div>
        </li>
      </ol>

      {DEMO_SAMPLE_DATA && (
        <div className="demo-box" role="group" aria-labelledby="demo-photos-title">
          <p id="demo-photos-title"><strong>Demo only:</strong> measure a synthetic test photo instead. It is generated on the server and measured straight away.</p>
          <div className="demo-buttons">
            <button type="button" className="button secondary small" disabled={busy || blocked} onClick={() => void submit({ variant: "hospital_baseline" })}>
              Phantom baseline photo
            </button>
            <button type="button" className="button secondary small" disabled={busy || blocked} onClick={() => void submit({ variant: "colour_strip_phantom" })}>
              Colour-strip phantom (warm light, slough)
            </button>
            <button type="button" className="button secondary small" disabled={busy || blocked} onClick={() => void submit({ variant: "incomplete_ruler" })}>
              Photo with a hidden ruler marker (safety check)
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
