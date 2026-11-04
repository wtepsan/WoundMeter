"use client";

import { useCallback, useEffect, useState } from "react";
import { deletedRecords, authorizeRestoration, restoreRecord, type DeletedRecord } from "@/lib/record-lifecycle";
import { formatDateTime, humanize } from "@/lib/care-format";
import { Badge, Notice } from "@/components/ui/Feedback";
import { InlineConfirm } from "@/components/ui/InlineConfirm";

/** Metadata only. A signed record needs a clinical authorisation before an admin can restore it. */
export function DeletedRecords({ patientId, canAuthorize = false }: { patientId?: string; canAuthorize?: boolean }) {
  const [records, setRecords] = useState<DeletedRecord[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try { setRecords(await deletedRecords(patientId)); setError(null); }
    catch (err) { setError(err instanceof Error ? err.message : "Deleted records could not be loaded."); }
  }, [patientId]);
  useEffect(() => { void load(); }, [load]);
  return <div className="stack">
    <p className="fine-print">Records are retained, never permanently erased here. Restoring a signed record requires a qualified clinician’s authorisation, followed by an administrator’s restoration. Reasons and both actions are audited.</p>
    <button type="button" className="link-button" disabled={busy} onClick={() => void load()}>Refresh deleted records</button>
    {error && <Notice tone="danger">{error}</Notice>}
    {!records.length && !error && <p className="muted-text">No deleted records.</p>}
    {records.map((r) => <article key={r.deletion_id} className="panel stack" aria-label={`Deleted ${r.record_id}`}>
      <div><Badge tone="warning">{humanize(r.disposition)}</Badge> <strong>{r.patient_code} · {r.wound_code} · {humanize(r.record_type)}</strong></div>
      <p className="fine-print">{r.record_id} · previously {humanize(r.previous_status)}</p>
      <p>Deleted by {r.deleted_by_subject} on {formatDateTime(r.deleted_at_utc)}: {r.deletion_reason}</p>
      {r.restore_authorized_by && <p className="fine-print">Restoration authorised by {r.restore_authorized_by} on {formatDateTime(r.restore_authorized_at_utc)}.</p>}
      {(!patientId || (canAuthorize && r.disposition === "VOIDED")) && <InlineConfirm
        trigger={patientId ? "Authorise restoration" : "Restore Record"}
        title={patientId ? "Authorise restoration of this record?" : "Restore this record?"}
        description={`${r.patient_code} · ${r.wound_code} · ${r.record_id}. Original content and status are preserved.`}
        confirmLabel={patientId ? "Confirm authorisation" : "Confirm restoration"}
        reasonLabel={patientId ? "Clinical authorisation reason (required)" : "Restoration reason (required)"}
        tone="primary" busy={busy}
        disabled={!patientId && r.disposition === "VOIDED" && !r.restore_authorized_by}
        onConfirm={async (reason) => {
          setBusy(true);
          try {
            if (patientId) await authorizeRestoration(r.deletion_id, reason);
            else await restoreRecord(r.deletion_id, reason);
            await load();
          } catch (err) { setError(err instanceof Error ? err.message : "Restoration failed."); }
          finally { setBusy(false); }
        }} />}
      {!patientId && r.disposition === "VOIDED" && !r.restore_authorized_by && <p className="fine-print">Awaiting clinical authorisation from the patient record’s Deleted records section.</p>}
    </article>)}
  </div>;
}
