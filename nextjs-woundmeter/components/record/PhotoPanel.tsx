"use client";

import { useEffect, useMemo, useState } from "react";
import { Check, PencilLine, Sparkles } from "lucide-react";

import { PhotoWorkspace, type PhotoView, type SizeLine } from "@/components/record/PhotoWorkspace";
import { Badge } from "@/components/ui/Feedback";
import { PrivateImage, pickDisplayImage } from "@/components/ui/PrivateImage";
import { axisChords, type Point } from "@/lib/boundary-mask";
import { imageProxyUrl } from "@/lib/care-api";
import {
  REGION_LABEL,
  calibrationStatus,
  formatCm,
  formatDateTime,
  inferenceSourceLabel,
  isZeroArea,
  measurementRegion,
  modelLabel,
  parseBoundary,
  qualityLabel,
  regionLabel,
  syntheticImageLabel,
  type Tone,
} from "@/lib/care-format";
import type { MeasurePreview, MeasurementLines, MeasurementRegion, MeasurementVersion, ObservationRecord } from "@/lib/care-types";

export type PreviewState =
  | { state: "idle" }
  | { state: "loading"; last?: MeasurePreview }
  | { state: "ready"; values: MeasurePreview }
  | { state: "invalid"; message: string }
  /** The preview service failed; the edit is kept and saving still validates it on the server. */
  | { state: "error"; message: string };

function labelled(lines: Pick<MeasurementLines, "length_line_px" | "width_line_px">, lengthCm: number, widthCm: number) {
  return {
    y: { line: lines.length_line_px, label: `Y ${formatCm(lengthCm)} cm` } as SizeLine,
    x: { line: lines.width_line_px, label: `X ${formatCm(widthCm)} cm` } as SizeLine,
  };
}

/**
 * Y (length) and X (width) lines for a saved measurement, labelled with its stored sizes. Older
 * measurements were saved without line positions; theirs are placed on the longest vertical and
 * horizontal runs of the saved outline, the same rule the server measures with.
 */
export function sizeLinesFor(m: MeasurementVersion | null | undefined) {
  if (!m?.geometry || calibrationStatus(m).state === "unavailable" || isZeroArea(m)) return null;
  const lines = m.geometry.measurement_lines ?? axisChords(parseBoundary(m));
  return lines ? labelled(lines, m.length_cm, m.width_cm) : null;
}

const CANDIDATE_LABEL: Record<string, string> = { sam_refined_whole_wound: "Whole wound", sam_concept: "Red tissue only" };
const KIND_REGION: Record<string, MeasurementRegion> = { sam_refined_whole_wound: "whole_wound", sam_concept: "red_tissue" };

function measurementState(working: MeasurementVersion | null, approved: boolean, pending: boolean, preview: PreviewState,
  choosing: boolean): { label: string; tone: Tone } {
  if (pending) {
    // A chosen AI outline is saved from its own mask, so a traced outline the preview refuses can still be saved.
    if (preview.state === "invalid") return choosing ? { label: "Measured when saved", tone: "neutral" } : { label: "Invalid boundary", tone: "danger" };
    if (preview.state === "error") return { label: "Preview unavailable", tone: "warning" };
    if (preview.state === "loading") return { label: "Recalculating…", tone: "neutral" };
    return { label: "Unsaved edit · not verified", tone: "warning" };
  }
  if (isZeroArea(working)) return approved ? { label: "No visible open wound · verified", tone: "success" }
    : { label: "No visible open wound · not verified", tone: "warning" };
  if (approved) return { label: "Clinician verified", tone: "success" };
  if (working?.measurement_stage === "HUMAN_CORRECTED") return { label: "Adjusted · awaiting verification", tone: "warning" };
  return { label: "AI proposal · not verified", tone: "warning" };
}

/** Group A: the photo workspace, AI suggestions and the measurement it produces. */
export function PhotoPanel({
  obs,
  working,
  approvedView,
  editable,
  editMode,
  onStartEdit,
  onCancelEdit,
  onFinishEdit,
  choosing = false,
  fixedRegion = null,
  busy,
  resetKey,
  pending,
  onPending,
  load,
  onLoad,
  preview,
  region,
  onRegion,
  verifiedBy,
}: {
  obs: ObservationRecord;
  working: MeasurementVersion | null;
  /** Showing the signed (verified) measurement, read-only. */
  approvedView: boolean;
  editable: boolean;
  /** Boundary editing is open; the record form waits until it is finished or cancelled. */
  editMode: boolean;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  /** Saves the edited boundary (if changed) and closes editing; rejects with the reason it could not. */
  onFinishEdit: () => Promise<void>;
  /** An AI outline was chosen and is unchanged: Done saves that choice. */
  choosing?: boolean;
  /** The region the chosen AI outline measures, when it is known; it cannot be relabelled. */
  fixedRegion?: MeasurementRegion | null;
  busy: boolean;
  resetKey: string;
  pending: Point[] | null;
  onPending: (points: Point[] | null) => void;
  load: { key: string; points: Point[] } | null;
  onLoad: (points: Point[], region: MeasurementRegion | null, candidateId: number) => void;
  preview: PreviewState;
  region: MeasurementRegion | null;
  onRegion: (region: MeasurementRegion) => void;
  verifiedBy?: string | null;
}) {
  const geometry = working?.geometry ?? null;
  const rectified = obs.images.find((i) => i.image_role === "CANONICAL_RECTIFIED");
  const colour = obs.images.find((i) => i.image_role === "COLOUR_CORRECTED");
  const original = obs.images.find((i) => i.image_role === "ORIGINAL_UPLOAD");
  const first = obs.measurements_versions[0] ?? null;
  const calibration = calibrationStatus(working);
  const quality = qualityLabel(obs.quality_gate_status);
  const inference = inferenceSourceLabel(obs.meta_execution_status);
  const savedRegion = measurementRegion(working);
  const candidates = geometry?.candidates ?? [];
  const selectedCandidate = candidates.find((c) => c.candidate_id === geometry?.selected_component_id) ?? (candidates.length === 1 ? candidates[0] : null);
  const aiBoundary = selectedCandidate?.canonical_boundary_px ?? parseBoundary(first);

  const views = useMemo<PhotoView[]>(() => {
    if (!geometry) return [];
    const size = { width: geometry.canonical_width_px, height: geometry.canonical_height_px };
    const list: PhotoView[] = [];
    if (rectified) list.push({ key: "rectified", label: "Rectified", src: imageProxyUrl(rectified.signed_url), canonical: true, ...size });
    // Colour correction keeps the rectified pixel grid, so the boundary still fits.
    if (colour) list.push({ key: "colour", label: "Colour-corrected", src: imageProxyUrl(colour.signed_url), canonical: true, ...size });
    if (original?.width_px && original.height_px) {
      list.push({ key: "original", label: "Original", src: imageProxyUrl(original.signed_url), canonical: false, width: original.width_px, height: original.height_px });
    }
    return list;
  }, [geometry, rectified, colour, original]);

  const provenance = working?.was_human_corrected || working?.measurement_stage === "HUMAN_CORRECTED" ? "human_corrected"
    : approvedView ? "human_accepted" : "ai_predicted";
  const state = measurementState(working, approvedView, Boolean(pending), preview, choosing);
  const shown = pending
    ? preview.state === "ready" ? preview.values : preview.state === "loading" ? preview.last ?? null : null
    : working;
  const physical = calibration.state !== "unavailable";
  // While an edit is being measured, lines appear only with the server's new figures.
  const sizeLines = useMemo(() => !physical ? null
    : pending ? (preview.state === "ready" ? labelled(preview.values.lines, preview.values.length_cm, preview.values.width_cm) : null)
      : sizeLinesFor(working), [physical, pending, preview, working]);
  const showSuggestions = editable && physical && candidates.length > 0 && (candidates.length > 1 || geometry?.selection_required);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [finishError, setFinishError] = useState<string | null>(null);
  useEffect(() => {
    setConfirmDiscard(false);
    setFinishError(null);
  }, [editMode]);

  const finish = async () => {
    setFinishError(null);
    try {
      await onFinishEdit();
    } catch (err) {
      setFinishError(err instanceof Error ? err.message : "The boundary could not be saved.");
    }
  };

  const editHeader = (
    <div className="edit-head">
      <div className="edit-head-row">
        <strong className="edit-title"><PencilLine aria-hidden="true" /> Editing boundary</strong>
        {choosing ? <Badge tone="warning">AI outline chosen · not saved</Badge> : pending ? <Badge tone="warning">Unsaved changes</Badge>
          : <span className="fine-print">No changes yet</span>}
        <span className="toolbar-spacer" />
        {confirmDiscard ? (
          <span className="confirm-inline" role="group" aria-label="Discard your boundary changes?">
            <button type="button" className="button danger small" disabled={busy} onClick={onCancelEdit}>Discard changes</button>
            <button type="button" className="button ghost small" disabled={busy} onClick={() => setConfirmDiscard(false)}>Keep editing</button>
          </span>
        ) : (
          <button type="button" className="button ghost small" disabled={busy} onClick={() => (pending ? setConfirmDiscard(true) : onCancelEdit())}>Cancel editing</button>
        )}
        <button type="button" className="button primary small" disabled={busy || (Boolean(pending) && preview.state === "invalid" && !choosing)} onClick={() => void finish()}>
          <Check aria-hidden="true" /> {busy ? "Saving…" : "Done editing"}
        </button>
      </div>
      {(pending || choosing) && (
        <div className="edit-region">
          <span>This outline shows</span>
          {choosing && fixedRegion ? (
            <><strong>{REGION_LABEL[fixedRegion]}</strong><span className="fine-print">Set by the AI outline you chose.</span></>
          ) : (
            <span className="segmented small" role="radiogroup" aria-label="What this boundary outlines">
              {(Object.keys(REGION_LABEL) as MeasurementRegion[]).map((r) => (
                <button key={r} type="button" role="radio" aria-checked={region === r} onClick={() => onRegion(r)}>{REGION_LABEL[r]}</button>
              ))}
            </span>
          )}
          {!region && <span className="warning-text">Choose one before Done. Whole-wound and red-tissue areas are never compared.</span>}
        </div>
      )}
      {finishError && <p className="danger-text" role="alert">{finishError}</p>}
      <p className="fine-print">Done editing saves the outline as a new measurement version, measured on the server. Cancel keeps the saved outline.</p>
    </div>
  );

  return (
    <section className="record-photo-panel" aria-labelledby="photo-panel-title" id="record-photo">
      <div className="panel-heading">
        <h2 id="photo-panel-title" className="section-title">Photo &amp; measurement</h2>
        <span className="chip-row">
          <Badge tone={inference.tone}>{inference.label}</Badge>
          {syntheticImageLabel(obs) && <Badge tone="neutral">{syntheticImageLabel(obs)}</Badge>}
        </span>
      </div>

      {views.length && geometry ? (
        <PhotoWorkspace
          views={views}
          bounds={geometry.inner_bounds_px}
          boundary={parseBoundary(working)}
          aiBoundary={aiBoundary}
          provenance={provenance}
          pixelsPerMm={geometry.pixels_per_mm}
          editable={editable && physical}
          editMode={editMode}
          onStartEdit={onStartEdit}
          editHeader={editHeader}
          editHint={geometry.selection_required ? "The AI offered more than one outline (below). Pick one, or edit to draw your own." : undefined}
          busy={busy}
          resetKey={resetKey}
          onEdit={onPending}
          load={load}
          sizeLines={sizeLines}
          legend={
            <span className="legend-row">
              <span><i className={`swatch ${provenance}`} /> {provenance === "ai_predicted" ? "AI-proposed boundary" : provenance === "human_corrected" ? "Adjusted boundary" : "Verified boundary"}</span>
              {pending && <span><i className="swatch editing" /> Your unsaved edit</span>}
              <span><i className="swatch ai-dashed" /> AI suggestion (dashed, when different)</span>
              {sizeLines && <span><i className="swatch y-line" /> Y length · <i className="swatch x-line" /> X width</span>}
            </span>
          }
        >
          {showSuggestions && (
            <div className="ai-suggestions" role="group" aria-label="AI boundary suggestions">
              <p className="ai-suggestions-title">
                <Sparkles aria-hidden="true" /> AI suggestions · {modelLabel(first?.source_model)}
                <span className="fine-print">Computed when the photo was captured; choosing one never calls the model again.</span>
              </p>
              {geometry.selection_required && (
                <p className="warning-text">
                  {geometry.sam_guidance?.alternatives_offered
                    ? "SAM offered a whole-wound outline and a red-tissue-only outline, which can leave out slough. Pick the one that matches what you measure (or draw your own with Edit boundary), then press Done editing."
                    : "These are separate regions. Pick the wound to measure (or draw its boundary with Edit boundary), then press Done editing."}
                </p>
              )}
              <div className="suggestion-list">
                {candidates.map((candidate) => {
                  const kind = candidate.boundary_kind ?? null;
                  const label = kind ? CANDIDATE_LABEL[kind] ?? `Region ${candidate.candidate_id + 1}` : `Region ${candidate.candidate_id + 1}`;
                  const inUse = !geometry.selection_required && geometry.selected_component_id === candidate.candidate_id && !pending;
                  return (
                    <button key={candidate.candidate_id} type="button" className="suggestion" aria-pressed={inUse} disabled={busy}
                      onClick={() => onLoad(candidate.canonical_boundary_px.map(([x, y]) => [Math.round(x), Math.round(y)]), kind ? KIND_REGION[kind] ?? null : null, candidate.candidate_id)}>
                      <svg width="48" height="48" viewBox={`0 0 ${geometry.canonical_width_px} ${geometry.canonical_height_px}`} aria-hidden="true">
                        {rectified && <image href={imageProxyUrl(rectified.signed_url)} width="100%" height="100%" />}
                        <polygon points={candidate.canonical_boundary_px.map((p) => p.join(",")).join(" ")} fill="#14b8a655" stroke="#0f766e" strokeWidth="6" />
                      </svg>
                      <span><strong>{label}</strong><small>{formatCm(candidate.measurements.area_cm2)} cm² · {inUse ? "in use" : "use this outline"}</small></span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </PhotoWorkspace>
      ) : (
        <div className="stack">
          <PrivateImage image={rectified ?? pickDisplayImage(obs.images)} alt="Stored wound photograph" className="record-photo" />
          {editable && <p className="warning-text">Stored calibrated geometry is unavailable, so the boundary cannot be edited. A new photo is needed; dimensions are never guessed.</p>}
        </div>
      )}

      <div className="measure-panel" aria-live="polite" aria-labelledby="measure-title">
        <div className="measure-head">
          <h3 id="measure-title">Measurement</h3>
          <Badge tone={state.tone}>{state.label}</Badge>
        </div>
        <dl className="measure-grid">
          {([["Area", "area_cm2", "cm²"], ["Length (Y)", "length_cm", "cm"], ["Width (X)", "width_cm", "cm"], ["Perimeter", "perimeter_cm", "cm"]] as const).map(([label, key, unit]) => (
            <div key={key} className={pending && preview.state === "loading" ? "is-stale" : undefined}>
              <dt>{label}</dt>
              <dd>{physical && shown ? <>{formatCm(shown[key] as number | null | undefined)}<span className="unit">{unit}</span></> : "—"}</dd>
            </div>
          ))}
        </dl>
        {isZeroArea(working) && !pending && (
          <p className="fine-print">
            0 cm²: no visible open wound, so there is no boundary.{editable && physical ? " If a wound is visible, use Edit boundary to draw its outline." : ""}
          </p>
        )}
        {pending && preview.state === "invalid" && (choosing
          ? <p className="fine-print">Live figures aren&apos;t available for this AI outline. Done editing saves it from the AI&apos;s own mask and measures it on the server.</p>
          : <p className="danger-text" role="alert">{preview.message} Undo the last change or adjust the outline.</p>)}
        {pending && preview.state === "error" && <p className="warning-text" role="status">{preview.message}</p>}
        {!physical && <p className="danger-text">{calibration.detail}</p>}
        <ul className="measure-facts">
          <li>
            <span>Region</span>
            <strong>{pending ? (region ? REGION_LABEL[region] : "Not chosen") : regionLabel(savedRegion)}</strong>
          </li>
          <li>
            <span>Calibration</span>
            <details className="calibration-chip">
              <summary><Badge tone={calibration.tone}>{calibration.label}</Badge></summary>
              <div className="calibration-detail">
                <p>{calibration.detail}</p>
                {geometry?.ruler && (
                  <dl className="fact-list">
                    <div><dt>AprilTags found</dt><dd className="mono">{geometry.ruler.detected_ids?.join(", ") || "—"}</dd></div>
                    <div><dt>Ruler template</dt><dd className="mono">{geometry.ruler.template_id ?? "—"} {geometry.ruler.template_version ?? ""}</dd></div>
                    <div><dt>Scale</dt><dd className="mono">{geometry.pixels_per_mm} px/mm</dd></div>
                    <div><dt>Validated</dt><dd>{geometry.ruler.validated ? "Yes" : "No"}</dd></div>
                  </dl>
                )}
                <p className="fine-print">Calibration is fixed when the photo is captured. If it is wrong, use Correct the photo to capture new evidence.</p>
              </div>
            </details>
          </li>
          <li><span>Photo quality</span><Badge tone={quality.tone}>{quality.label}</Badge></li>
          {approvedView && verifiedBy && <li><span>Verified</span><strong>{verifiedBy}</strong></li>}
        </ul>
        {obs.quality_gate_status === "REVIEW_REQUIRED" && !pending && (
          <p className="fine-print">Automatic checks flagged this photo: {(geometry?.quality_gate.review_reasons ?? []).join(" ") || "look closely at the ruler and boundary."}</p>
        )}
        <p className="fine-print">2D surface measurement from the ruler calibration. Depth, undermining and skin curvature are not measured.
          {pending && preview.state === "ready" && (choosing
            ? " Figures are calculated by the server from this outline; saving uses the AI's own mask, so the stored figures can differ slightly. Nothing is stored until you press Done editing."
            : " Figures are calculated by the server exactly as saving would; nothing is stored until you press Done editing.")}
          {working && !pending && ` Version ${working.version_number} · ${formatDateTime(working.created_at_utc)}.`}</p>
      </div>
    </section>
  );
}
