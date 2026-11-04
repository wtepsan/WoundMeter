"use client";

import { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";

import { Badge, Loading, Notice } from "@/components/ui/Feedback";
import { DeletedRecords } from "@/components/clinical/DeletedRecords";
import { Disclosure, PageHeader } from "@/components/ui/Layout";
import { admin, type AuditEvent, type SecuritySettings, type StorageDiagnostics } from "@/lib/admin-api";
import { personName, roleLabel } from "@/lib/accounts";
import { formatDateTime, humanize } from "@/lib/care-format";

function StorageStatus() {
  const [result, setResult] = useState<StorageDiagnostics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return <div className="stack">
    <p className="fine-print">Verify the running backend’s selected database and existing record counts. This check does not repair or reset data.</p>
    <button type="button" className="button secondary" disabled={busy} onClick={async () => {
      setBusy(true); setError(null);
      try { setResult(await admin.storage()); }
      catch (err) { setResult(null); setError(err instanceof Error ? err.message : "Storage check failed."); }
      finally { setBusy(false); }
    }}>{busy ? "Checking storage…" : "Check database connection"}</button>
    {error && <Notice tone="danger">{error}</Notice>}
    {result && <>
      <dl className="fact-list">
        <div><dt>Database</dt><dd className="mono">{result.database_path}</dd></div>
        <div><dt>Private images</dt><dd className="mono">{result.private_storage_path}</dd></div>
        <div><dt>Existing patients</dt><dd>{result.table_counts.patients ?? 0}</dd></div>
        <div><dt>Wounds</dt><dd>{result.table_counts.wounds ?? 0}</dd></div>
        <div><dt>Measurement versions</dt><dd>{result.table_counts.wound_measurements ?? 0}</dd></div>
        <div><dt>Referenced images</dt><dd>{result.image_references}</dd></div>
      </dl>
      {result.integrity_check.join() !== "ok" || result.foreign_key_violations > 0 || result.missing_images > 0 || result.unsafe_image_paths > 0
        ? <Notice tone="danger">Database or image-reference validation failed. Preserve the store and investigate before applying changes.</Notice>
        : <Notice tone="success">Database schema, foreign keys and image references verified.</Notice>}
      {result.image_hash_mismatches > 0 && <Notice tone="warning">{result.image_hash_mismatches} historical images differ from their recorded hashes. Files and signed records have been preserved; investigate before migration.</Notice>}
    </>}
  </div>;
}

export function AuditPage() {
  const [events, setEvents] = useState<AuditEvent[] | null>(null);
  const [settings, setSettings] = useState<SecuritySettings | null>(null);
  const [deniedOnly, setDeniedOnly] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setEvents(await admin.audit({ limit: 150, outcome: deniedOnly ? "DENIED" : undefined }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't load the access log.");
    }
  }, [deniedOnly]);

  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    admin.settings().then(setSettings).catch(() => undefined);
  }, []);

  return (
    <div className="page page-wide">
      <PageHeader
        title="Audit & settings"
        subtitle="Who accessed or changed what. Identifiers such as Citizen IDs are never written to the log."
        actions={
          <button type="button" className="button ghost icon-only" onClick={() => void load()} aria-label="Refresh access log">
            <RefreshCw aria-hidden="true" />
          </button>
        }
      />
      {error && <Notice tone="danger">{error}</Notice>}
      {settings && !settings.identifier_keys_configured && (
        <Notice tone="warning" title="Using demo encryption keys">
          Set PATIENT_DATA_KEY and PATIENT_INDEX_KEY on the server before storing real patient identifiers.
        </Notice>
      )}

      <Disclosure title="Database connection" summary="Selected storage, existing records and image integrity">
        <StorageStatus />
      </Disclosure>

      <Disclosure title="Deleted records" summary="View retained records and restore with governance checks">
        <DeletedRecords />
      </Disclosure>

      <section className="stack" aria-labelledby="log-title">
        <div className="panel-head">
          <h2 id="log-title" className="section-title">
            Access log
          </h2>
          <label className="checkbox-row compact">
            <input type="checkbox" checked={deniedOnly} onChange={(e) => setDeniedOnly(e.target.checked)} />
            <span>Refused attempts only</span>
          </label>
        </div>
        {!events ? (
          <Loading />
        ) : (
          <div className="table-wrap">
            <table className="data-table compact">
              <thead>
                <tr>
                  <th scope="col">Time</th>
                  <th scope="col">Who</th>
                  <th scope="col">What</th>
                  <th scope="col">Record</th>
                  <th scope="col">Outcome</th>
                </tr>
              </thead>
              <tbody>
                {events.map((e) => (
                  <tr key={e.event_id}>
                    <td data-label="Time">{formatDateTime(e.timestamp_utc)}</td>
                    <td data-label="Who">
                      {e.actor_subject === "anonymous" ? "Unknown user" : personName(e.actor_subject)}
                      <span className="cell-sub">{roleLabel(e.actor_role)}</span>
                    </td>
                    <td data-label="What">{humanize(e.action.split(":")[0])}</td>
                    <td data-label="Record" className="mono">
                      {e.entity_type}
                      {e.entity_id ? ` ${e.entity_id.slice(0, 12)}` : ""}
                    </td>
                    <td data-label="Outcome">
                      <Badge tone={e.outcome === "SUCCESS" ? "neutral" : "danger"}>{humanize(e.outcome)}</Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {settings && (
        <Disclosure title="Security settings" summary="Sessions, MFA, password and identifier protection">
          <dl className="fact-list two-col">
            <div>
              <dt>Idle sign-out</dt>
              <dd>{settings.session_idle_minutes} minutes</dd>
            </div>
            <div>
              <dt>Maximum session</dt>
              <dd>{settings.session_absolute_hours} hours</dd>
            </div>
            <div>
              <dt>Lockout</dt>
              <dd>After {settings.max_failed_logins} failed sign-ins, for 15 minutes</dd>
            </div>
            <div>
              <dt>Multi-factor sign-in</dt>
              <dd>{settings.mfa_policy}</dd>
            </div>
            <div>
              <dt>Passwords</dt>
              <dd>{settings.password_hashing}</dd>
            </div>
            <div>
              <dt>Identifiers</dt>
              <dd>{settings.identifier_protection}</dd>
            </div>
          </dl>
        </Disclosure>
      )}

    </div>
  );
}
