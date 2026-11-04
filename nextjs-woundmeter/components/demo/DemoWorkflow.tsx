"use client";

// /demo: the real clinician capture and record screens for one photo, with no sign-in, no patient,
// no wound location and nothing saved. It mirrors components/clinical/ObservationReview.tsx (same
// components, same boundary-editing rules); the record lives only in this page's memory and every
// record action goes to the stateless demo API (fastapi-woundmeter/app/api/demo_measure.py).

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Lock, RotateCcw } from "lucide-react";

import { RecordHistory } from "@/components/care/RecordHistory";
import { CalibrationDiagnostics, type Diagnostics } from "@/components/demo/CalibrationDiagnostics";
import { NewMeasurementPanel } from "@/components/clinical/NewMeasurementPanel";
import { PhotoPanel, type PreviewState } from "@/components/record/PhotoPanel";
import { RecordDetails } from "@/components/record/RecordDetails";
import { RecordForm } from "@/components/record/RecordForm";
import { Badge, Notice } from "@/components/ui/Feedback";
import type { Account } from "@/lib/accounts";
import { samePolygon, type Point } from "@/lib/boundary-mask";
import { CareApiError, setDemoAdapter, type DemoAdapter } from "@/lib/care-api";
import {
  calibrationStatus,
  formatDateTime,
  measurementRegion,
  parseBoundary,
  recordStatus,
  workingMeasurement,
} from "@/lib/care-format";
import type {
  AiVisualObservation,
  CareMuseExplanation,
  MeasurePreview,
  MeasurementRegion,
  MeasurementVersion,
  ObservationRecord,
  WoundDetail,
} from "@/lib/care-types";

type Meta = { enabled: boolean; segmentation_model: string; reasoning_model: string; observations_enabled: boolean };

// A fictional clinician with every clinical permission, so the whole workflow is visible. It is a
// screen setting only: the demo API has no accounts and stores nothing.
const DEMO_ACCOUNT: Account = {
  subject: "demo.viewer", username: "demo", display_name: "Demo clinician", role: "CLINICIAN", org_id: "ORG-DEMO",
  org_name: "WoundMeter demo", wards: [], qualification_verified: true, qualification_title: "Demo", mfa_verified: true,
  mfa_enabled: true, is_demo_account: true, can_confirm_clinical: true,
  permissions: ["REGISTER_PATIENT", "REGISTER_WOUND", "CAPTURE", "ASSESS", "STAGE", "DIAGNOSE", "PRESCRIBE", "MANAGE_CARE_PLAN", "SIGN_OFF"],
};

const DEMO_WOUND: WoundDetail = {
  wound_id: "DEMO-WOUND", wound_code: "DEMO", patient_id: "DEMO-PATIENT", anatomical_site: "DEMO_WOUND",
  laterality: "NOT_APPLICABLE", wound_type: "PRESSURE_INJURY", pressure_injury_stage: "NOT_APPLICABLE", status: "ACTIVE",
  observations: [], approved_timeline: [], unreviewed_observations: [], care_plans: [], care_tasks: [], healing_epistemic_notice: "",
  allowed_actions: [],
};

async function demoCall<T>(action: string, body: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api/demo/${action}`, {
      method: "POST", cache: "no-store", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
  } catch {
    throw new CareApiError("NETWORK", "Couldn't reach WoundMeter. Check your connection and try again.", 0);
  }
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new CareApiError(String(data.code ?? `HTTP_${res.status}`), String(data.message ?? `Request failed (HTTP ${res.status}).`), res.status, data);
  return data as T;
}

/** The base64 part of an inline (data:) image URL. */
const inlineBase64 = (url: string | undefined) => (url?.startsWith("data:") ? url.slice(url.indexOf(",") + 1) : undefined);

/** Keeps the record form visible but out of reach until the photo step is finished (as in ObservationReview). */
function LockedArea({ locked, children }: { locked: boolean; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { ref.current?.toggleAttribute("inert", locked); }, [locked]);
  return <div ref={ref} className={locked ? "form-locked" : undefined}>{children}</div>;
}

export function DemoWorkflow() {
  const [keptPhoto, setKeptPhoto] = useState<string | null>(null);
  const [obs, setObs] = useState<ObservationRecord | null>(null);
  const obsRef = useRef<ObservationRecord | null>(null);
  obsRef.current = obs;
  const [captureKey, setCaptureKey] = useState(0);
  const [drafting, setDrafting] = useState(false);
  const [diagnosis, setDiagnosis] = useState<{ diagnostics: Diagnostics; photo: string } | null>(null);

  const update = useCallback((change: (o: ObservationRecord) => ObservationRecord) => {
    setObs((current) => (current ? change(current) : current));
  }, []);

  // Record actions on DEMO- identifiers come here instead of the stored-record API.
  useEffect(() => {
    const adapter: DemoAdapter = {
      submitObservation: async (submission) => {
        setDiagnosis(null);
        const result = await demoCall<{ record: ObservationRecord; meta: Meta; explain_context?: Record<string, unknown> | null; diagnostics?: Diagnostics; kept_photo?: string | null }>(
          "measure", { image_base64: submission.image_base64 ?? "" });
        setKeptPhoto(result.kept_photo ?? null);
        if (result.diagnostics) setDiagnosis({ diagnostics: result.diagnostics, photo: submission.image_base64 ?? "" });
        const record = result.record;
        if (result.explain_context) {
          // The draft note is written after the record opens (as in the clinical app, it is not part of
          // capture). It applies only to the AI measurement it describes: an edited boundary makes it stale.
          setDrafting(true);
          demoCall<CareMuseExplanation>("explain", { context: result.explain_context })
            .then((explanation) => update((current) => current.observation_id === record.observation_id
              && (current.record_working_measurement?.measurement_id ?? "DEMO-MEAS-1") === "DEMO-MEAS-1"
              ? { ...current, ai_explanation: explanation, draft_status: "current" } : current))
            .catch(() => undefined)
            .finally(() => setDrafting(false));
        }
        // The original photo is shown from the browser's own copy; the server never keeps it.
        record.images = record.images.map((i) => (i.image_role === "ORIGINAL_UPLOAD" ? { ...i, signed_url: submission.image_base64 ?? "" } : i));
        return record;
      },
      generateAiObservations: async () => {
        const o = obsRef.current;
        const working = o && (o.record_working_measurement ?? workingMeasurement(o));
        if (!o || !working) throw new CareApiError("NO_MEASUREMENT", "This photo has no measured boundary to describe.", 409);
        const version = await demoCall<AiVisualObservation>("ai-observations", {
          observation_id: o.observation_id, version_number: (o.ai_visual_observations?.length ?? 0) + 1,
          measurement: working, colour_calibration: o.colour_calibration ?? null,
          canonical_image_base64: inlineBase64(o.images.find((i) => i.image_role === "CANONICAL_RECTIFIED")?.signed_url) ?? "",
          corrected_image_base64: inlineBase64(o.images.find((i) => i.image_role === "COLOUR_CORRECTED")?.signed_url) ?? null,
        });
        update((current) => ({ ...current, ai_visual_observations: [version, ...(current.ai_visual_observations ?? [])] }));
        return version;
      },
      reviewAiObservations: async (aiObservationId, body) => {
        const o = obsRef.current;
        const version = o?.ai_visual_observations?.find((v) => v.ai_observation_id === aiObservationId);
        if (!version) throw new CareApiError("NOT_FOUND", "These AI observations are no longer available.", 404);
        if (version.status !== "AI_DRAFT") throw new CareApiError("ALREADY_REVIEWED", "These AI observations were already reviewed.", 409);
        if (body.decision === "edit" && !body.clinician_findings?.some((f) => f.observation.trim())) {
          throw new CareApiError("VALIDATION_ERROR", "Enter at least one corrected observation.", 422);
        }
        if (body.decision === "reject" && !body.notes?.trim()) throw new CareApiError("VALIDATION_ERROR", "Give a reason for rejecting.", 422);
        const reviewed: AiVisualObservation = {
          ...version,
          status: ({ accept: "ACCEPTED", reject: "REJECTED", edit: "EDITED" } as const)[body.decision],
          clinician_findings: body.decision === "edit"
            ? body.clinician_findings!.filter((f) => f.observation.trim()).map((f) => ({ ...f, assessment_status: "observed" })) : null,
          clinician_notes: body.notes ?? null, reviewed_by_subject: DEMO_ACCOUNT.subject, reviewed_at_utc: new Date().toISOString(),
        };
        update((current) => ({ ...current, ai_visual_observations: (current.ai_visual_observations ?? []).map((v) => (v.ai_observation_id === aiObservationId ? reviewed : v)) }));
        return reviewed;
      },
      reviseDraft: async (body) => {
        const o = obsRef.current;
        return demoCall("ai-revise", { ...body, measurement: o ? o.record_working_measurement ?? workingMeasurement(o) : null });
      },
    };
    setDemoAdapter(adapter);
    return () => setDemoAdapter(null);
  }, [update]);

  const startOver = () => {
    setObs(null);
    setKeptPhoto(null);
    setDiagnosis(null);
    setCaptureKey((k) => k + 1);
    window.scrollTo({ top: 0 });
  };

  return (
    <div className="page page-record demo-workflow">
      {keptPhoto && <p className="fine-print">Demo photo kept in demo-data/images/{keptPhoto}</p>}
      {obs && drafting && obs.draft_status !== "stale" && (
        <Notice tone="info">Muse Spark is writing the draft note (about 15 s). You can review the photo and boundary meanwhile.</Notice>
      )}
      {obs ? (
        <DemoRecord key={obs.observation_id} obs={obs} onChange={setObs} onStartOver={startOver} />
      ) : (
        <NewMeasurementPanel key={captureKey} liveCamera samplePhotos patientId="DEMO-PATIENT" wound={DEMO_WOUND} role={DEMO_ACCOUNT.role}
          onSubmitted={(record) => { setObs(record); window.scrollTo({ top: 0 }); }}
          onCancel={startOver} />
      )}
      {!obs && diagnosis && <CalibrationDiagnostics diagnostics={diagnosis.diagnostics} photo={diagnosis.photo} />}
    </div>
  );
}

/** The record screen (ObservationReview) for the in-memory demo record. */
function DemoRecord({ obs, onChange, onStartOver }: {
  obs: ObservationRecord;
  onChange: (o: ObservationRecord) => void;
  onStartOver: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [signed, setSigned] = useState(false);
  const [pending, setPending] = useState<Point[] | null>(null);
  const [load, setLoad] = useState<{ key: string; points: Point[] } | null>(null);
  const [region, setRegion] = useState<MeasurementRegion | null>(null);
  const [preview, setPreview] = useState<PreviewState>({ state: "idle" });
  const [boundaryEpoch, setBoundaryEpoch] = useState(0);
  const [boundaryEditing, setBoundaryEditing] = useState(false);
  const [chosen, setChosen] = useState<{ id: number; points: Point[]; region: MeasurementRegion | null } | null>(null);

  const editable = obs.review_state === "AWAITING_CLINICAL_REVIEW";
  const working = obs.record_working_measurement ?? workingMeasurement(obs);
  const workingId = working?.measurement_id;
  // The live preview needs only the calibration, not the candidate masks.
  const previewGeometry = useMemo(() => (working?.geometry ? { ...working.geometry, candidates: [] } : null), [working]);
  const onPending = useCallback((points: Point[] | null) => setPending(points), []);

  useEffect(() => {
    if (pending && region === null) setRegion(measurementRegion(working));
  }, [pending, region, working]);

  // Live figures for an unsaved edit, from the server's own measurement code (nothing is stored).
  useEffect(() => {
    if (!pending) return setPreview({ state: "idle" });
    if (pending.length < 3) return setPreview({ state: "invalid", message: "There is no boundary to measure." });
    setPreview((p) => ({ state: "loading", last: p.state === "ready" ? p.values : p.state === "loading" ? p.last : undefined }));
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      try {
        const values = await demoCall<MeasurePreview>("preview", { geometry: previewGeometry, base_measurement_id: workingId, edited_boundary_px: pending });
        if (!cancelled) setPreview({ state: "ready", values });
      } catch (err) {
        if (cancelled) return;
        setPreview(err instanceof CareApiError && err.status === 422 ? { state: "invalid", message: err.message }
          : { state: "error", message: `Live measurement is unavailable (${err instanceof Error ? err.message : "network error"}). Your edit is kept; Done editing measures it on the server.` });
      }
    }, 350);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [pending, previewGeometry, workingId]);

  /** Done editing: the server measures the new version as the real refine would; it is kept here only. */
  const refine = async (body: { edited_boundary_px?: Point[]; selected_candidate_id?: number; measurement_region: MeasurementRegion }) => {
    if (!working?.geometry) return;
    setBusy(true);
    try {
      const result = await demoCall<{ measurement: MeasurementVersion; quality_gate_status: string }>("refine", {
        geometry: working.geometry, base_measurement_id: working.measurement_id, next_version: obs.measurements_versions.length + 1,
        image_quality_status: obs.image_quality_status, ...body,
      });
      onChange({
        ...obs, measurements_versions: [...obs.measurements_versions, result.measurement], record_working_measurement: result.measurement,
        provisional_or_working_measurement: result.measurement, quality_gate_status: result.quality_gate_status,
        ai_segmentation_provenance: "human_corrected", ai_explanation: null, draft_status: "stale",
      });
      setPending(null);
      setBoundaryEpoch((v) => v + 1);
    } finally {
      setBusy(false);
    }
  };

  const editingBoundary = boundaryEditing && editable;
  const selectionRequired = Boolean(working?.geometry?.selection_required);
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
      const choiceRegion = candidateChoice.region ?? region;
      if (!choiceRegion) throw new Error("Choose what this outline shows (whole wound or red tissue only), then press Done editing.");
      await refine({ selected_candidate_id: candidateChoice.id, measurement_region: choiceRegion });
    } else if (pending) {
      if (!region) throw new Error("Choose what this outline shows (whole wound or red tissue only), then press Done editing.");
      if (preview.state === "invalid") throw new Error(`The edited boundary cannot be saved: ${preview.message}`);
      await refine({ edited_boundary_px: pending, measurement_region: region });
    } else if (selectionRequired) {
      throw new Error("Pick one of the AI outlines below, or draw the boundary, then press Done editing.");
    }
    closeBoundaryEdit();
  };
  const photoTodo = !editable || !working ? null
    : editingBoundary ? { label: "Finish editing the boundary", title: "Finish the photo first",
      detail: "The form is locked while you edit the boundary. Press Done editing to apply it, or Cancel editing to keep the current outline." }
      : selectionRequired && calibrationStatus(working).state !== "unavailable" ? { label: "Choose the wound boundary", title: "Choose the wound boundary first",
        detail: "The AI offered more than one outline. Pick one in the photo panel (or draw your own) and press Done editing. The form opens after that." }
        : null;
  const status = recordStatus(obs);

  return (
    <>
      <header className="record-header">
        <div className="record-title-row">
          <div className="record-title">
            <h1>Demo wound <span className="wound-code">DEMO</span></h1>
            <p className="record-meta">No patient · no wound location · {formatDateTime(obs.capture_datetime_utc)} · not saved</p>
          </div>
          <div className="record-header-actions">
            <Badge tone={status.tone}>{status.label}</Badge>
            <button type="button" className="button secondary" onClick={onStartOver}><RotateCcw aria-hidden="true" /> Measure another photo</button>
          </div>
        </div>
      </header>

      <div className="record-notices">
        {signed && (
          <Notice tone="success" title="Every step is complete (demo)">
            In the clinical app this would now be approved and signed under your name. In the demo nothing was signed, submitted or saved.
          </Notice>
        )}
      </div>

      <div className="record-workspace">
        <div className="record-col record-col-photo">
          <PhotoPanel
            obs={obs}
            working={working}
            approvedView={false}
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
          />
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
          {editable && working ? (
            <LockedArea locked={Boolean(photoTodo)}>
              <RecordForm
                demo
                obs={obs}
                wound={DEMO_WOUND}
                working={working}
                account={DEMO_ACCOUNT}
                busy={busy}
                photoTodo={photoTodo?.label ?? null}
                onSubmit={async () => {
                  setSigned(true);
                  window.scrollTo({ top: 0, behavior: "smooth" });
                  return null;
                }}
                onSave={async () => obs}
                onChanged={async () => undefined}
              />
            </LockedArea>
          ) : (
            <Notice tone="warning">No measurement could be produced for this photo. Measure another photo.</Notice>
          )}
          <div className="record-secondary">
            <RecordDetails obs={obs} working={working} clinical />
            <RecordHistory obs={obs} clinical onOpenRecord={() => undefined} />
          </div>
        </div>
      </div>
    </>
  );
}
