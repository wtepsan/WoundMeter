"use client";
import { useState } from "react";
import { Disclosure } from "@/components/ui/Layout";
import { sizeLinesFor } from "@/components/record/PhotoPanel";
import { PhotoWorkspace } from "@/components/record/PhotoWorkspace";
import { imageProxyUrl } from "@/lib/care-api";
import { formatCm, formatDateTime, humanize, parseBoundary } from "@/lib/care-format";
import { personName } from "@/lib/accounts";
import type { ObservationRecord, MeasurementVersion } from "@/lib/care-types";

const display = (value: unknown) => value == null || value === "" ? "Not recorded" : typeof value === "object" ? JSON.stringify(value) : String(value);
function Changes({ changes }: { changes: Record<string, { old: unknown; new: unknown }> }) {
  return <div className="table-wrap"><table className="data-table compact"><thead><tr><th>Changed field</th><th>Old value</th><th>New value</th></tr></thead><tbody>
    {Object.entries(changes).map(([key, change]) => <tr key={key}><th>{humanize(key)}</th><td>{display(change.old)}</td><td>{display(change.new)}</td></tr>)}
  </tbody></table></div>;
}

/** One chronological journal. Private versions remain restricted by the API's role projection. */
export function RecordHistory({ obs, clinical, onOpenRecord }: { obs: ObservationRecord; clinical: boolean; onOpenRecord: (id: string) => void }) {
  const [selected, setSelected] = useState<MeasurementVersion | null>(null);
  const edits = (obs.record_history ?? []).filter((event) => event.action === "RECORD_DRAFT_SAVED" || event.action === "RECORD_SUBMITTED");
  const versions = [...obs.clinical_assessments_versions].reverse();
  const signedEntries = clinical ? versions.map((version, index) => {
    const previous = versions[index - 1];
    const approval = (obs.record_history ?? []).find((entry) => entry.assessment_id === version.assessment_id);
    const factualChanges = Object.fromEntries(Object.entries(approval?.changes ?? {}).filter(([key]) => ["pain_score_0_10","drainage_level","dressing_condition","redness_observed","concern_reported","non_diagnostic_notes"].includes(key)));
    const fields = ["wound_type", "pressure_injury_stage", "wound_bed_appearance", "exudate_amount", "surrounding_skin", "wound_trend", "braden_total", "diagnosis_text", "clinical_interpretation", "care_decisions", "final_documentation_text", "ai_draft_disposition"] as const;
    return { key: version.assessment_id, timestamp: version.signed_at_utc, content: <details className="record-version">
      <summary>Signed version {version.version_number} · {version.signed_by_name} · {formatDateTime(version.signed_at_utc)}</summary>
      {version.amendment_reason && <p>Reason: {version.amendment_reason}</p>}
      <p className="fine-print">Immutable signed version · measurement {version.reviewed_measurement_id ?? "legacy binding"}</p>
      <div className="table-wrap"><table className="data-table compact"><thead><tr><th>Field</th>{previous && <th>Previous value</th>}<th>This version</th></tr></thead><tbody>
        {fields.map((key) => <tr key={key}><th>{humanize(key)}</th>{previous && <td>{display(previous[key])}</td>}<td>{display(version[key])}</td></tr>)}
      </tbody></table></div>
      {Object.keys(factualChanges).length > 0 && <><h3 className="section-title">Reviewed factual changes</h3><Changes changes={factualChanges} /></>}
    </details> };
  }) : [];
  const savedEntries = edits.map((event) => ({ key: `draft:${event.revision}`, timestamp: event.timestamp, content: <details className="record-version">
    <summary>Draft revision {event.revision} · {personName(event.actor)} · {formatDateTime(event.timestamp)}{event.ai_assisted ? " · includes AI-suggested wording" : ""}</summary>
    <p>{event.action === "RECORD_SUBMITTED" ? "Submitted for review; not signed." : "Saved draft; not authoritative."}</p>
    {event.reason && <p>Reason: {event.reason}</p>}
    <Changes changes={event.changes} />
  </details> }));
  const photos = (obs.photo_corrections ?? []).map((link) => ({ key: `photo:${link.observation_id}`, timestamp: link.timestamp, content: <details className="record-version">
    <summary>Linked photo correction · {formatDateTime(link.timestamp)}</summary><p>{link.reason}</p>
    <p>A separately captured photograph with its own evidence and approval state. The original file remains unchanged.</p>
    <button type="button" className="link-button" onClick={() => onOpenRecord(link.observation_id)}>Open correction</button>
  </details> }));
  const timeline = [...signedEntries, ...savedEntries, ...photos].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp) || a.timestamp.localeCompare(b.timestamp));
  const image = obs.images.find((i) => i.image_role === "CANONICAL_RECTIFIED");
  return <Disclosure id="record-history" title="History" summary={`${clinical ? `${versions.length} signed versions` : obs.latest_clinical_assessment ? `Published version ${obs.latest_clinical_assessment.version_number}` : "Unsigned"} · ${edits.length} saved edits`}>
    <div className="stack record-history">
      <p>Created by {personName(obs.uploading_user_subject)} · {formatDateTime(obs.capture_datetime_utc)}</p>
      {!clinical && obs.latest_clinical_assessment && <p>Published by {obs.latest_clinical_assessment.signed_by_name} · {formatDateTime(obs.latest_clinical_assessment.signed_at_utc)}</p>}
      <ol className="plain-list" aria-label="Record changes, oldest first">{timeline.map((event) => <li key={event.key}>{event.content}</li>)}</ol>
      {clinical && <details><summary>Measurement and boundary versions</summary>
        <ul className="record-measurements">{obs.measurements_versions.map((measurement) => <li key={measurement.measurement_id}>
          Version {measurement.version_number} · {humanize(measurement.measurement_stage)} · {formatCm(measurement.area_cm2)} cm² · {personName(measurement.created_by_subject)} · {formatDateTime(measurement.created_at_utc)}
          {measurement.geometry && <button type="button" className="link-button" onClick={() => setSelected(measurement)}>Inspect boundary version {measurement.version_number}</button>}
        </li>)}</ul>
        {image && selected?.geometry && <div aria-label="Historical boundary"><p>Read-only boundary · version {selected.version_number}</p>
          <PhotoWorkspace key={selected.measurement_id} resetKey={selected.measurement_id} editable={false} bounds={selected.geometry.inner_bounds_px}
            views={[{ key: "rectified", label: "Rectified", src: imageProxyUrl(image.signed_url), canonical: true,
              width: selected.geometry.canonical_width_px, height: selected.geometry.canonical_height_px }]}
            boundary={parseBoundary(selected)} sizeLines={sizeLinesFor(selected)}
            provenance={selected.was_human_corrected ? "human_corrected" : selected.measurement_stage === "FINAL_CLINICIAN_APPROVED" ? "human_accepted" : "ai_predicted"} /></div>}
      </details>}
    </div>
  </Disclosure>;
}
