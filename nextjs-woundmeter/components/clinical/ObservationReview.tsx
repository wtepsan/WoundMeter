"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, Ban, Camera, CircleSlash, Lock, PencilLine, RotateCcw, X } from "lucide-react";

import type { Navigate } from "@/components/app/AppShell";
import { useCareData } from "@/components/app/CareDataProvider";
import { useUnsavedGuard } from "@/hooks/useUnsavedGuard";
import { NewMeasurementPanel } from "@/components/clinical/NewMeasurementPanel";
import { RecordActions, type MenuItem } from "@/components/clinical/RecordActions";
import { RecordHistory } from "@/components/care/RecordHistory";
import { AiAssistance } from "@/components/record/AiAssistance";
import { NoVisibleWound, takeOutlineRequest } from "@/components/record/NoVisibleWound";
import { PhotoPanel, type PreviewState } from "@/components/record/PhotoPanel";
import { RecordDetails } from "@/components/record/RecordDetails";
import { RecordForm } from "@/components/record/RecordForm";
import { Breadcrumbs } from "@/components/ui/Breadcrumbs";
import { Badge, Loading, Notice } from "@/components/ui/Feedback";
import { PrivateImage, pickDisplayImage } from "@/components/ui/PrivateImage";
import { can, personName, type Account } from "@/lib/accounts";
import { attestationErrorMessage } from "@/lib/approval-attestations";
import { samePolygon, type Point } from "@/lib/boundary-mask";
import { CareApiError, previewMeasurement, recordZeroArea, refineObservationMask, reviewObservation, saveRecordDraft } from "@/lib/care-api";
import {
  REGION_LABEL,
  calibrationStatus,
  formatDate,
  formatDateTime,
  humanize,
  isZeroArea,
  locationLabel,
  noVisibleWound,
  measurementRegion,
  parseBoundary,
  patientName,
  recordStatus,
  woundSiteLabel,
  workingMeasurement,
} from "@/lib/care-format";
import type { MeasurementRegion, ObservationRecord } from "@/lib/care-types";

const yesNo = (v: unknown) => (v ? "Yes" : "No");

/** Read-only signed (or published) record content. */
function SignedSummary({ obs, clinical }: { obs: ObservationRecord; clinical: boolean }) {
  const a = obs.latest_clinical_assessment;
  const report = obs.caregiver_report ? { ...obs.caregiver_report, ...obs.record_published } : null;
  return (
    <div className="record-form">
      {a && (
        <section className="record-section" aria-labelledby="signed-title">
          <h2 id="signed-title" className="section-title">Wound observations</h2>
          <dl className="fact-grid">
            {(["wound_bed_appearance", "exudate_amount", "surrounding_skin", "wound_trend"] as const).map((key) => (
              <div key={key}><dt>{humanize(key)}</dt><dd>{humanize(a[key] ?? "Not recorded")}</dd></div>
            ))}
          </dl>
        </section>
      )}
      {report && (
        <section className="record-section" aria-labelledby="reported-title">
          <h2 id="reported-title" className="section-title">Reported by {personName(report.submitted_by_subject ?? obs.uploading_user_subject)}</h2>
          <dl className="fact-grid">
            <div><dt>Pain</dt><dd>{report.pain_score_0_10 ?? "—"} / 10</dd></div>
            <div><dt>Drainage</dt><dd>{report.drainage_level ? humanize(String(report.drainage_level)) : yesNo(report.drainage_change)}</dd></div>
            <div><dt>Dressing</dt><dd>{report.dressing_condition ? humanize(String(report.dressing_condition)) : report.dressing_intact ? "Intact" : "—"}</dd></div>
            <div><dt>Redness</dt><dd>{report.redness_observed ? humanize(String(report.redness_observed)) : yesNo(report.redness_around_wound)}</dd></div>
          </dl>
          {report.non_diagnostic_notes && <p className="note-text">“{report.non_diagnostic_notes}”</p>}
        </section>
      )}
      {a ? (
        <section className="record-section" aria-labelledby="assessment-ro-title">
          <h2 id="assessment-ro-title" className="section-title">Clinical assessment</h2>
          <p className="note-block">{a.final_documentation_text}</p>
          {clinical && <p className="fine-print">{["accepted", "edited"].includes(obs.clinical_assessments_versions[0]?.ai_draft_disposition ?? "not_used") ? "AI-assisted note, reviewed and signed by the clinician." : "Clinician-entered note."}</p>}
          {a.clinical_interpretation && <><h3 className="field-label">Interpretation</h3><p>{a.clinical_interpretation}</p></>}
          {a.care_decisions && <><h3 className="field-label">Care decisions</h3><p>{a.care_decisions}</p></>}
          {clinical && a.diagnosis_text && <p className="muted-text">Diagnosis: {a.diagnosis_text}</p>}
          <p className="signed-line">Signed by <strong>{a.signed_by_name}</strong> · {formatDateTime(a.signed_at_utc)} · version {a.version_number}</p>
        </section>
      ) : (
        <p className="muted-text">This record has not been signed.</p>
      )}
    </div>
  );
}

/** Keeps the record form visible but out of reach (no focus, clicks or typing) until the photo step is finished. */
function LockedArea({ locked, children }: { locked: boolean; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { ref.current?.toggleAttribute("inert", locked); }, [locked]);
  return <div ref={ref} className={locked ? "form-locked" : undefined}>{children}</div>;
}

export function ObservationReview({ patientId, observationId, account, navigate }: {
  patientId: string; observationId: string; account: Account; navigate: Navigate;
}) {
  const { records, recordErrors, refreshPatient, refreshQueue } = useCareData();
  const [editing, setEditing] = useState(false);
  const [formEpoch, setFormEpoch] = useState(0);
  const [conflict, setConflict] = useState(false);
  const [panel, setPanel] = useState<null | "photo" | "request_retake" | "reject" | "zero">(null);
  const [panelReason, setPanelReason] = useState("");
  const [photoCapture, setPhotoCapture] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [signed, setSigned] = useState(false);
  const [pending, setPending] = useState<Point[] | null>(null);
  const [load, setLoad] = useState<{ key: string; points: Point[] } | null>(null);
  const [region, setRegion] = useState<MeasurementRegion | null>(null);
  const [preview, setPreview] = useState<PreviewState>({ state: "idle" });
  const [boundaryEpoch, setBoundaryEpoch] = useState(0);
  const [boundaryEditing, setBoundaryEditing] = useState(false);
  // The AI outline last loaded into the editor, so choosing it unchanged is saved as that choice.
  const [chosen, setChosen] = useState<{ id: number; points: Point[]; region: MeasurementRegion | null } | null>(null);
  useEffect(() => { void refreshPatient(patientId); }, [patientId, refreshPatient]);
  useEffect(() => setBoundaryEditing(false), [observationId]);

  const record = records[patientId];
  const wound = record?.wounds.find((w) => w.observations.some((o) => o.observation_id === observationId));
  const obs = wound?.observations.find((o) => o.observation_id === observationId);
  const clinical = account.role !== "FAMILY_CAREGIVER" && account.role !== "PATIENT";
  const pendingReview = obs?.review_state === "AWAITING_CLINICAL_REVIEW";
  const authorised = !obs || !wound ? false : clinical ? can(account, "ASSESS")
    : account.role === "FAMILY_CAREGIVER" && obs.uploading_user_subject === account.subject && Boolean(wound.allowed_actions?.includes("UPLOAD_HOME_PHOTO"));
  const editable = authorised && (pendingReview || editing);
  const working = !obs ? null : editable ? obs.record_working_measurement ?? workingMeasurement(obs) : obs.approved_measurement ?? workingMeasurement(obs);
  const workingId = working?.measurement_id;
  const zeroArea = isZeroArea(working);
  // "Draw outline" from the capture page opens this record with boundary editing started (once).
  useEffect(() => {
    if (editable && takeOutlineRequest(observationId)) setBoundaryEditing(true);
  }, [editable, observationId]);

  const onPending = useCallback((points: Point[] | null) => setPending(points), []);
  // A boundary edited but not yet saved with Done editing would be lost by leaving.
  useUnsavedGuard(boundaryEditing && editable && pending !== null && !busy);

  // A new edit starts as the region already measured; the clinician can change it explicitly.
  useEffect(() => {
    if (pending && region === null) setRegion(measurementRegion(working));
  }, [pending, region, working]);

  // Live figures for an unsaved edit, from the server's own measurement code (nothing is stored).
  useEffect(() => {
    if (!pending) {
      setPreview({ state: "idle" });
      return;
    }
    if (pending.length < 3) {
      setPreview({ state: "invalid", message: "There is no boundary to measure." });
      return;
    }
    setPreview((p) => ({ state: "loading", last: p.state === "ready" ? p.values : p.state === "loading" ? p.last : undefined }));
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      try {
        const values = await previewMeasurement(observationId, { edited_boundary_px: pending, expected_measurement_id: workingId });
        if (!cancelled) setPreview({ state: "ready", values });
      } catch (err) {
        if (cancelled) return;
        if (err instanceof CareApiError && err.status === 409) setConflict(true);
        setPreview(err instanceof CareApiError && err.status === 422 ? { state: "invalid", message: err.message }
          : { state: "error", message: `Live measurement is unavailable (${err instanceof Error ? err.message : "network error"}). Your edit is kept; saving measures it on the server.` });
      }
    }, 350);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [pending, observationId, workingId]);

  if (!record || !wound || !obs) {
    return (
      <div className="page">
        <button type="button" className="link-button back-link" onClick={() => navigate({ name: "patient", patientId })}><ArrowLeft aria-hidden="true" /> Patient</button>
        {recordErrors[patientId] ? <Notice tone="danger">{recordErrors[patientId].message}</Notice> : <Loading label="Loading record…" />}
      </div>
    );
  }

  const status = recordStatus(obs);
  const amends = obs.record_base_assessment_id ? { amends_assessment_id: obs.record_base_assessment_id } : {};
  const run = async (action: () => Promise<ObservationRecord>, approval = false): Promise<unknown> => {
    setBusy(true);
    setError(null);
    try {
      await action();
      await Promise.all([refreshPatient(patientId), refreshQueue()]);
      if (approval) {
        setEditing(false);
        setSigned(true);
        window.scrollTo({ top: 0, behavior: "smooth" });
      }
      return null;
    } catch (err) {
      setError(err instanceof CareApiError && err.code === "ATTESTATION_REQUIRED" ? attestationErrorMessage(err.body.missing_attestations)
        : err instanceof Error ? err.message : "The record could not be saved.");
      if (err instanceof CareApiError && err.status === 409) {
        setConflict(true);
        await refreshPatient(patientId);
      }
      return err;
    } finally {
      setBusy(false);
    }
  };

  const saveBoundary = async () => {
    if (!pending) return;
    if (!region) throw new Error("Choose what this outline shows (whole wound or red tissue only), then press Done editing.");
    if (preview.state === "invalid") throw new Error(`The edited boundary cannot be saved: ${preview.message}`);
    setBusy(true);
    try {
      await refineObservationMask(observationId, {
        edited_boundary_px: pending, expected_measurement_id: workingId, measurement_region: region,
        correction_notes: `Boundary edited in the record workspace (${REGION_LABEL[region].toLowerCase()}).`, ...amends,
      });
      await refreshPatient(patientId);
      setPending(null);
      setBoundaryEpoch((value) => value + 1);
    } catch (err) {
      if (err instanceof CareApiError && err.status === 409) setConflict(true);
      throw err;
    } finally {
      setBusy(false);
    }
  };

  // Boundary editing is a mode: Done saves (when changed) and closes it; Cancel discards the edit.
  const editingBoundary = boundaryEditing && editable;
  const selectionRequired = Boolean(working?.geometry?.selection_required);
  // An AI outline chosen and left unchanged is saved as the selection of that candidate (its own
  // mask, the existing API for it), not as a hand edit. When it matches the saved outline, nothing
  // changes on screen, so this counts only while a choice is still required.
  const candidateChoice = editingBoundary && chosen && (pending ? samePolygon(pending, chosen.points)
    : selectionRequired && samePolygon(parseBoundary(working).map(([x, y]) => [Math.round(x), Math.round(y)]), chosen.points)) ? chosen : null;
  const closeBoundaryEdit = () => {
    setBoundaryEditing(false);
    setPending(null);
    setRegion(null);
    setChosen(null);
  };
  const finishBoundaryEdit = async () => {
    if (candidateChoice) {
      // An outline that knows its region keeps it; the server refuses a contradicting label.
      const choiceRegion = candidateChoice.region ?? region;
      if (!choiceRegion) throw new Error("Choose what this outline shows (whole wound or red tissue only), then press Done editing.");
      setBusy(true);
      try {
        await refineObservationMask(observationId, {
          selected_candidate_id: candidateChoice.id, expected_measurement_id: workingId, measurement_region: choiceRegion,
          correction_notes: `AI outline chosen in the record workspace (${REGION_LABEL[choiceRegion].toLowerCase()}).`, ...amends,
        });
        await refreshPatient(patientId);
        setPending(null);
        setBoundaryEpoch((value) => value + 1);
      } catch (err) {
        if (err instanceof CareApiError && err.status === 409) setConflict(true);
        throw err;
      } finally {
        setBusy(false);
      }
    } else if (pending) {
      await saveBoundary();
    } else if (selectionRequired) {
      throw new Error("Pick one of the AI outlines below, or draw the boundary, then press Done editing.");
    }
    closeBoundaryEdit();
  };
  // The photo comes first: the form opens once the boundary is chosen and no edit is open. Without
  // stored calibration no outline can be chosen, so the form is not locked waiting for one.
  const photoTodo = !clinical || !editable || !working ? null
    : editingBoundary ? { label: "Finish editing the boundary", title: "Finish the photo first",
      detail: "The form is locked while you edit the boundary. Press Done editing to save it, or Cancel editing to keep the saved outline." }
      : selectionRequired && calibrationStatus(working).state !== "unavailable" ? { label: "Choose the wound boundary", title: "Choose the wound boundary first",
        detail: "The AI offered more than one outline. Pick one in the photo panel (or draw your own) and press Done editing. The form opens after that." }
        : null;

  const cancelRevision = () => {
    setEditing(false);
    closeBoundaryEdit();
    setBoundaryEpoch((value) => value + 1);
  };
  const menu: MenuItem[] = [
    ...(clinical && pendingReview && can(account, "ASSESS") ? [
      { label: "Request new photo", icon: RotateCcw, onSelect: () => { setPanel("request_retake"); setPanelReason("Please recapture with all four ruler markers visible and the ruler flat beside the wound."); } },
      { label: "Reject record", icon: Ban, onSelect: () => { setPanel("reject"); setPanelReason(""); } },
    ] : []),
    ...((editable || (authorised && obs.review_state === "RETAKE_REQUESTED")) && (can(account, "CAPTURE") || !clinical)
      ? [{ label: "Correct the photo", icon: Camera, onSelect: () => { setPanel("photo"); setPanelReason(""); setPhotoCapture(false); } }] : []),
    // Healed scar or new skin outlined by the AI: record no visible open wound (0 cm²) instead, as a new version.
    ...(clinical && editable && working && !zeroArea && can(account, "ASSESS") && calibrationStatus(working).state !== "unavailable"
      ? [{ label: "No visible open wound (0 cm²)", icon: CircleSlash, onSelect: () => { setPanel("zero"); setPanelReason(""); } }] : []),
    ...(editing ? [{ label: "Cancel revision", icon: X, onSelect: cancelRevision }] : []),
  ];
  const canRevise = authorised && !pendingReview && obs.review_state === "CLINICIAN_APPROVED" && !editing;
  const signedBy = obs.latest_clinical_assessment ? `${obs.latest_clinical_assessment.signed_by_name} · ${formatDate(obs.latest_clinical_assessment.signed_at_utc)}` : null;

  return (
    <div className="page page-record">
      <header className="record-header">
        <Breadcrumbs navigate={navigate} items={[
          ...(account.role === "PATIENT" ? [{ label: "My record", view: { name: "home" } as const }] : [
            { label: "Patients", view: { name: "patients" } as const },
            { label: <><span className="id-chip">{record.patient.patient_code}</span> {patientName(record.patient)}</>, view: { name: "patient", patientId } as const },
          ]),
          { label: <>{woundSiteLabel(wound)} <span className="wound-code">{wound.wound_code}</span></>, view: { name: "patient", patientId, woundId: wound.wound_id } },
          { label: `Measure · ${formatDateTime(obs.capture_datetime_utc)}` },
        ]} />
        <div className="record-title-row">
          <div className="record-title">
            <h1>{woundSiteLabel(wound)} <span className="wound-code">{wound.wound_code}</span></h1>
            <p className="record-meta">
              <strong>{record.patient.patient_code}</strong> {patientName(record.patient)} · {formatDateTime(obs.capture_datetime_utc)} ·{" "}
              {locationLabel(obs.capture_location_category)} capture · by {personName(obs.uploading_user_subject)}
            </p>
          </div>
          <div className="record-header-actions">
            <Badge tone={status.tone}>{status.label}</Badge>
            {canRevise && (
              <button type="button" className="button primary" onClick={() => { setEditing(true); setSigned(false); }}>
                <PencilLine aria-hidden="true" /> Revise record
              </button>
            )}
            <RecordActions account={account} recordType="observation" recordId={obs.observation_id} status={obs.review_state}
              details={`${record.patient.display_name} · ${woundSiteLabel(wound)}`} items={menu}
              onDeleted={async () => { await refreshPatient(patientId); navigate({ name: "patient", patientId }); }} />
          </div>
        </div>
        {obs.latest_clinical_assessment && (
          <p className="record-signed">
            {editing ? "Revising signed" : "Signed"} version {obs.latest_clinical_assessment.version_number} · {signedBy}
            {obs.clinical_assessments_versions.length > 1 && clinical && ` · ${obs.clinical_assessments_versions.length} signed versions in History`}
          </p>
        )}
      </header>

      <div className="record-notices">
        {obs.image_integrity_verified === false && <Notice tone="danger" title="Image integrity requires investigation">Stored evidence is preserved, but its integrity could not be verified. New signatures remain blocked.</Notice>}
        {obs.correction_of && <Notice tone="info">Photo correction: a new capture, not a routine follow-up. The original evidence is retained. <button type="button" className="link-button" onClick={() => navigate({ name: "review", patientId, observationId: obs.correction_of! })}>Open original record</button></Notice>}
        {obs.record_has_draft && !pendingReview && !editing && <Notice tone="info">An unsigned revision is saved for review. The signed version stays authoritative until a clinician approves it.</Notice>}
        {obs.review_state === "RETAKE_REQUESTED" && obs.review_notes && <Notice tone="warning" title="Reviewer's request">{obs.review_notes}</Notice>}
        {noVisibleWound(obs) && (
          <NoVisibleWound obs={obs} canRecord={clinical ? can(account, "ASSESS") : authorised} canDraw={clinical && can(account, "ASSESS")}
            onDone={async (_updated, intent) => {
              await Promise.all([refreshPatient(patientId), refreshQueue()]);
              if (intent === "draw_outline") setBoundaryEditing(true);
            }} />
        )}
        {obs.review_state === "REJECTED" && <Notice tone="danger" title="Reason for rejection">{obs.review_notes}</Notice>}
        {signed && <Notice tone="success" title="Approved and signed">The signed version is in History. Further changes start a new revision.</Notice>}
        {editing && <Notice tone="info" title="Revising a signed record">The signed version stays unchanged. Your changes become a new version only after review and approval.</Notice>}
        {conflict && <Notice tone="warning" action={<button type="button" className="button secondary small" onClick={async () => { await refreshPatient(patientId); setFormEpoch((v) => v + 1); setBoundaryEpoch((v) => v + 1); closeBoundaryEdit(); setConflict(false); setError(null); }}>Reload saved version</button>}>A newer saved version exists. Reloading discards your unsaved edits.</Notice>}
        {!clinical && pendingReview && <Notice tone="info">Your update is with the care team for review. You can correct your observations below. For urgent concerns, contact the care team directly.</Notice>}
        {error && <Notice tone="danger" title="That didn’t work">{error}</Notice>}
      </div>

      {(panel === "request_retake" || panel === "reject") && (
        <section className="panel inline-panel" aria-labelledby="decision-title">
          <h2 id="decision-title" className="section-title">{panel === "reject" ? "Reject this record?" : "Request a new photo?"}</h2>
          <div className="field">
            <label htmlFor="decision-reason">Reason (shared with the submitter)</label>
            <textarea id="decision-reason" rows={2} value={panelReason} onChange={(e) => setPanelReason(e.target.value)} />
          </div>
          <div className="button-row">
            <button type="button" className={`button ${panel === "reject" ? "danger" : "primary"}`} disabled={busy || !panelReason.trim()}
              onClick={() => void run(() => reviewObservation(observationId, { decision: panel, review_notes: panelReason.trim(), clinical_interpretation: panelReason.trim(), final_documentation_text: panelReason.trim() }))
                .then((failure) => { if (!failure) setPanel(null); })}>
              {panel === "reject" ? "Reject record" : "Request new photo"}
            </button>
            <button type="button" className="button ghost" onClick={() => setPanel(null)}>Cancel</button>
          </div>
        </section>
      )}
      {panel === "zero" && (
        <section className="panel inline-panel" aria-labelledby="zero-title">
          <h2 id="zero-title" className="section-title">Record no visible open wound (0 cm²)?</h2>
          <p className="muted-text">
            Use this when the photo shows no open wound, for example healed skin or a scar the AI outlined. It adds a new 0 cm² version
            without a boundary; the AI outline and earlier versions are kept. The record still needs your verification and signature.
          </p>
          <div className="button-row">
            <button type="button" className="button primary" disabled={busy}
              onClick={() => void run(() => recordZeroArea(observationId, { intent: "record_zero", expected_measurement_id: workingId, ...amends }))
                .then((failure) => { if (!failure) { setPanel(null); closeBoundaryEdit(); setBoundaryEpoch((v) => v + 1); } })}>
              <CircleSlash aria-hidden="true" /> Record 0 cm²
            </button>
            <button type="button" className="button ghost" onClick={() => setPanel(null)}>Cancel</button>
          </div>
        </section>
      )}
      {panel === "photo" && (
        <section className="panel inline-panel" aria-labelledby="photo-correction-title">
          <h2 id="photo-correction-title" className="section-title">Correct the photo</h2>
          <p className="muted-text">Captures new, linked evidence with its own time, hashes and review. The original photo is never replaced. For a routine follow-up, use New measure on the wound instead.</p>
          <div className="field">
            <label htmlFor="photo-correction-reason">Photo correction reason</label>
            <input id="photo-correction-reason" maxLength={512} value={panelReason} onChange={(e) => setPanelReason(e.target.value)} />
          </div>
          {!photoCapture ? (
            <div className="button-row">
              <button type="button" className="button primary" disabled={!panelReason.trim()} onClick={() => setPhotoCapture(true)}>Capture corrected photo</button>
              <button type="button" className="button ghost" onClick={() => setPanel(null)}>Cancel</button>
            </div>
          ) : (
            <NewMeasurementPanel patientId={patientId} wound={wound} role={account.role} correctionOf={{ observationId, reason: panelReason }}
              onCancel={() => setPhotoCapture(false)}
              onSubmitted={async (created) => { await refreshPatient(patientId); setPanel(null); navigate({ name: "review", patientId, observationId: created.observation_id }); }} />
          )}
        </section>
      )}

      <div className="record-workspace">
        <div className="record-col record-col-photo">
          {clinical ? (
            <PhotoPanel
              obs={obs}
              working={working}
              approvedView={!editable && obs.review_state === "CLINICIAN_APPROVED"}
              editable={editable}
              editMode={editingBoundary}
              onStartEdit={() => setBoundaryEditing(true)}
              onCancelEdit={closeBoundaryEdit}
              onFinishEdit={finishBoundaryEdit}
              busy={busy}
              resetKey={`${workingId ?? "none"}:${boundaryEpoch}`}
              pending={pending}
              onPending={onPending}
              load={load}
              onLoad={(points, kind, candidateId) => {
                setBoundaryEditing(true);
                setChosen({ id: candidateId, points, region: kind });
                setLoad({ key: crypto.randomUUID(), points });
                setRegion(kind);
              }}
              choosing={Boolean(candidateChoice)}
              fixedRegion={candidateChoice?.region ?? null}
              preview={preview}
              region={region}
              onRegion={setRegion}
              verifiedBy={signedBy}
            />
          ) : (
            <section className="record-photo-panel" aria-label="Submitted photo">
              <PrivateImage image={pickDisplayImage(obs.images)} alt="Submitted wound photograph" className="record-photo" />
              <p className="fine-print">Measurements appear after a clinician reviews and approves them.</p>
            </section>
          )}
        </div>
        <div className="record-col record-col-form">
          {photoTodo && (
            <div className="form-lock" role="status">
              <Lock aria-hidden="true" />
              <div className="form-lock-text"><strong>{photoTodo.title}</strong><span>{photoTodo.detail}</span></div>
              <button type="button" className="button secondary small"
                onClick={() => document.getElementById("record-photo")?.scrollIntoView({ behavior: "smooth", block: "start" })}>Go to photo</button>
            </div>
          )}
          {editable && (working || !clinical) ? (
            <LockedArea locked={Boolean(photoTodo)}>
              <RecordForm
                key={`${observationId}:${obs.record_base_assessment_id ?? "unsigned"}:${formEpoch}`}
                obs={obs}
                wound={wound}
                working={working}
                account={account}
                busy={busy}
                photoTodo={photoTodo?.label ?? null}
                onSubmit={(payload) => run(() => reviewObservation(observationId, payload), true)}
                onSave={async (fields, revision, reason, submit, aiRevisionIds) => {
                  setBusy(true);
                  try {
                    const updated = await saveRecordDraft(observationId, { fields, expected_revision: revision, base_assessment_id: obs.record_base_assessment_id, amendment_reason: reason, submit, ai_revision_ids: aiRevisionIds });
                    await Promise.all([refreshPatient(patientId), refreshQueue()]);
                    return updated;
                  } catch (err) {
                    if (err instanceof CareApiError && err.status === 409) setConflict(true);
                    throw err;
                  } finally {
                    setBusy(false);
                  }
                }}
                onChanged={() => refreshPatient(patientId)}
              />
            </LockedArea>
          ) : (
            <>
              <SignedSummary obs={obs} clinical={clinical} />
              {clinical && (obs.ai_visual_observations?.length ?? 0) > 0 && (
                <AiAssistance observationId={obs.observation_id} patientId={obs.patient_id} woundId={obs.wound_id}
                  versions={obs.ai_visual_observations ?? []} explanation={null}
                  draftStatus={obs.draft_status} draftMismatch={null} workingArea={working?.area_cm2 ?? null} canReview={false} editable={false}
                  disposition="not_used" onUseDraft={() => undefined} onRejectDraft={() => undefined} onChanged={() => refreshPatient(patientId)} />
              )}
            </>
          )}
          <div className="record-secondary">
            <RecordDetails obs={obs} working={working} clinical={clinical} />
            <RecordHistory obs={obs} clinical={clinical} onOpenRecord={(id) => navigate({ name: "review", patientId, observationId: id })} />
          </div>
        </div>
      </div>
    </div>
  );
}
