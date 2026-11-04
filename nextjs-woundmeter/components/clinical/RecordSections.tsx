"use client";


import { personName, roleLabel } from "@/lib/accounts";
import { formatDateTime, humanize, inferenceSourceLabel, modelLabel } from "@/lib/care-format";
import type { PatientCompleteRecord, WoundDetail } from "@/lib/care-types";

export function AuditHistory({ record }: { record: PatientCompleteRecord }) {
  return (
    <div className="stack">
      {record.notifications.length > 0 && (
        <section className="subsection">
          <h3>Your notifications</h3>
          <ul className="plain-list compact">
            {record.notifications.slice(0, 8).map((n) => (
              <li key={n.notification_id}>
                <strong>{n.safe_preview_title}</strong>
                <span className="cell-sub">
                  {formatDateTime(n.created_at_utc)} · {n.safe_preview_body}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
      <section className="subsection">
        <h3>Audit trail</h3>
        <p className="muted-text">Every view and change to this record is logged and cannot be edited.</p>
        <div className="table-wrap">
          <table className="data-table compact">
            <thead>
              <tr>
                <th scope="col">Time</th>
                <th scope="col">Who</th>
                <th scope="col">What</th>
              </tr>
            </thead>
            <tbody>
              {record.audit_history.map((a) => (
                <tr key={a.event_id}>
                  <td data-label="Time">{formatDateTime(a.timestamp_utc)}</td>
                  <td data-label="Who">
                    {personName(a.actor_subject)}
                    <span className="cell-sub">{roleLabel(a.actor_role)}</span>
                  </td>
                  <td data-label="What">
                    {humanize(a.action.split(":")[0])}
                    {a.outcome && a.outcome !== "SUCCESS" && <span className="cell-sub">{humanize(a.outcome)}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

export function TechnicalDetails({ record, wound }: { record: PatientCompleteRecord; wound: WoundDetail }) {
  return (
    <div className="stack">
      <dl className="fact-list two-col">
        <div>
          <dt>Patient ID</dt>
          <dd className="mono">{record.patient.patient_id}</dd>
        </div>
        <div>
          <dt>Wound ID</dt>
          <dd className="mono">{wound.wound_id}</dd>
        </div>
        <div>
          <dt>Organisation</dt>
          <dd className="mono">{record.patient.org_id}</dd>
        </div>
        <div>
          <dt>Laterality</dt>
          <dd>{humanize(wound.laterality)}</dd>
        </div>
      </dl>
      <div className="table-wrap">
        <table className="data-table compact">
          <thead>
            <tr>
              <th scope="col">Observation</th>
              <th scope="col">AI boundary</th>
              <th scope="col">Inference</th>
              <th scope="col">Quality gate</th>
              <th scope="col">Provenance</th>
            </tr>
          </thead>
          <tbody>
            {wound.observations.map((o) => (
              <tr key={o.observation_id}>
                <td className="mono" data-label="Observation">
                  {o.observation_id}
                </td>
                <td data-label="AI boundary">{modelLabel(o.measurements_versions[0]?.source_model)}</td>
                <td data-label="Inference">{inferenceSourceLabel(o.meta_execution_status).label}</td>
                <td data-label="Quality gate" className="mono">
                  {o.quality_gate_status} · {o.image_quality_status}
                </td>
                <td data-label="Provenance" className="mono">
                  {o.ai_segmentation_provenance}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <details className="fine-details">
        <summary>Raw record (JSON)</summary>
        <pre className="raw-json">
          {JSON.stringify(
            {
              ...wound,
              observations: wound.observations.map((o) => ({
                ...o,
                images: o.images.map((i) => i.image_role),
                measurements_versions: o.measurements_versions.map(({ boundary_px_json: _boundary, ...m }) => m),
              })),
            },
            null,
            2,
          )}
        </pre>
      </details>
    </div>
  );
}
