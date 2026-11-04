"use client";

import { ColourCalibrationCard } from "@/components/clinical/ColourCalibrationCard";
import { Disclosure } from "@/components/ui/Layout";
import { personName } from "@/lib/accounts";
import { formatCm, formatDateTime, measurementRegion, measurementStageLabel, modelLabel, regionLabel } from "@/lib/care-format";
import type { MeasurementVersion, ObservationRecord } from "@/lib/care-types";

/** Group D: technical completeness without crowding the record. Collapsed by default. */
export function RecordDetails({ obs, working, clinical }: { obs: ObservationRecord; working: MeasurementVersion | null; clinical: boolean }) {
  if (!clinical) return null;
  const g = working?.geometry;
  const explanation = obs.draft_status === "current" ? obs.ai_explanation : null;
  return (
    <Disclosure title="Record details" summary="Measurement versions, models, calibration, colour" id="record-details">
      <div className="stack">
        <div className="table-wrap">
          <table className="data-table compact">
            <thead>
              <tr>
                <th scope="col">Version</th>
                <th scope="col">Region</th>
                <th scope="col">Area cm²</th>
                <th scope="col">L × W cm</th>
                <th scope="col">Max span × perpendicular cm</th>
                <th scope="col">Source</th>
                <th scope="col">Created</th>
              </tr>
            </thead>
            <tbody>
              {obs.measurements_versions.map((m) => (
                <tr key={m.measurement_id}>
                  <td data-label="Version">v{m.version_number} {measurementStageLabel(m.measurement_stage)}</td>
                  <td data-label="Region">{regionLabel(measurementRegion(m))}</td>
                  <td data-label="Area cm²">{formatCm(m.area_cm2, 4)}</td>
                  <td data-label="L × W cm">{formatCm(m.length_cm)} × {formatCm(m.width_cm)}</td>
                  <td data-label="Max span × perpendicular cm">{formatCm(m.clinical_length_cm)} × {formatCm(m.clinical_width_cm)}</td>
                  <td data-label="Source" className="mono">{m.source_model}</td>
                  <td data-label="Created">{personName(m.created_by_subject)} · {formatDateTime(m.created_at_utc)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <dl className="fact-list two-col">
          <div><dt>Segmentation model</dt><dd>{modelLabel(working?.source_model)}{g?.model_version ? ` · ${g.model_version}` : ""}</dd></div>
          <div><dt>Measurement algorithm</dt><dd className="mono">{g?.measurement_algorithm_version ?? "—"}</dd></div>
          <div><dt>Length / width method</dt><dd className="mono">{working?.length_method ?? "—"} / {working?.width_method ?? "—"}</dd></div>
          <div><dt>Scale</dt><dd className="mono">{working?.pixels_per_mm ?? "—"} px/mm</dd></div>
          <div><dt>Calibration</dt><dd className="mono">{g?.calibration_id ?? "—"}</dd></div>
          <div><dt>Mask fingerprint</dt><dd className="mono">{g?.mask_sha256 ? `${g.mask_sha256.slice(0, 16)}…` : "—"}</dd></div>
          <div><dt>Quality gate</dt><dd className="mono">{obs.quality_gate_status} · {obs.image_quality_status}</dd></div>
          <div><dt>Meta execution</dt><dd className="mono">{obs.meta_execution_status}</dd></div>
          <div><dt>Boundary provenance</dt><dd className="mono">{obs.ai_segmentation_provenance}</dd></div>
          <div><dt>Record</dt><dd className="mono">{obs.observation_id} · revision {obs.record_revision ?? 0}</dd></div>
        </dl>
        {g?.sam_guidance && (
          <p className="fine-print">SAM guidance: {g.sam_guidance.strategy}{g.sam_guidance.concept_prompt ? ` · concept “${g.sam_guidance.concept_prompt}”` : ""}
            {g.sam_guidance.holes_filled_px ? ` · ${g.sam_guidance.holes_filled_px} px of holes filled` : ""}.</p>
        )}
        {g?.quality_gate.review_reasons?.length ? <ul className="bullet-list fine-print">{g.quality_gate.review_reasons.map((r) => <li key={r}>{r}</li>)}</ul> : null}
        {explanation?.measurement_limitations && <p className="fine-print"><strong>Limitations noted by the AI summary:</strong> {explanation.measurement_limitations}</p>}
        <ColourCalibrationCard colour={obs.colour_calibration} />
      </div>
    </Disclosure>
  );
}
