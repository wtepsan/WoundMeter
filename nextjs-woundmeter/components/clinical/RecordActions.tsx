"use client";

import { useId, useRef, useState } from "react";
import { MoreHorizontal, Trash2 } from "lucide-react";
import { can, type Account } from "@/lib/accounts";
import { deleteRecord, type RecordType } from "@/lib/record-lifecycle";
import { Notice } from "@/components/ui/Feedback";

export type MenuItem = { label: string; icon?: React.ElementType; onSelect: () => void };

/**
 * The record's overflow menu: optional contextual actions, then permission-controlled deletion.
 * A native modal provides keyboard focus containment and returns focus on close.
 */
export function RecordActions({ account, recordType, recordId, status, details, onDeleted, items = [] }: {
  account: Account; recordType: RecordType; recordId: string; status: string;
  details: string; onDeleted: () => Promise<unknown> | void; items?: MenuItem[];
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const menu = useRef<HTMLDetailsElement>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = useId();
  const label = recordType === "wound" ? "Delete Wound" : "Delete Record";
  const canDelete = can(account, "DELETE_RECORD") && can(account, "SIGN_OFF") && can(account, "ASSESS") && account.qualification_verified;
  if (!canDelete && !items.length) return null;
  return (
    <div className="record-actions">
      <details ref={menu} className="dropdown">
        <summary className="button ghost icon-only record-menu" aria-label={`Record actions: ${details}`}>
          <MoreHorizontal aria-hidden="true" />
        </summary>
        <div className="dropdown-panel align-end menu-panel">
          {items.map(({ label: itemLabel, icon: Icon, onSelect }) => (
            <button key={itemLabel} type="button" className="menu-item" onClick={() => {
              if (menu.current) menu.current.open = false;
              onSelect();
            }}>{Icon && <Icon aria-hidden="true" />} {itemLabel}</button>
          ))}
          {canDelete && <button type="button" className="menu-item danger-text" onClick={() => {
            if (menu.current) menu.current.open = false;
            setReason(""); setError(null); dialog.current?.showModal();
          }}><Trash2 aria-hidden="true" /> {label}</button>}
        </div>
      </details>
      {canDelete && <dialog ref={dialog} className="record-dialog" aria-labelledby={`${id}-title`}
        onCancel={(event) => { if (busy) event.preventDefault(); }}>
        <form className="stack" onSubmit={async (event) => {
          event.preventDefault();
          if (busy || !reason.trim()) return;
          setBusy(true); setError(null);
          try {
            await deleteRecord(recordType, recordId, reason.trim(), status);
            dialog.current?.close();
            await onDeleted();
          } catch (err) {
            setError(err instanceof Error ? err.message : "The record could not be deleted.");
          } finally { setBusy(false); }
        }}>
          <h2 id={`${id}-title`}>{label}?</h2>
          <p>{details}</p>
          <p className="fine-print">{recordId} · {status.replaceAll("_", " ")}</p>
          <p>{recordType === "wound"
            ? "This removes the wound and its linked history, reviews and reports from normal views. Observations, measurements, signed content and audit history are retained. Previously deleted records stay deleted if the wound is restored."
            : "This removes the record from normal history, reviews and reports. Signed content is voided and retained with its audit history. Related records are preserved."}</p>
          {error && <Notice tone="danger">{error}</Notice>}
          <div className="field">
            <label htmlFor={`${id}-reason`}>Deletion reason (required)</label>
            <textarea id={`${id}-reason`} value={reason} onChange={(e) => setReason(e.target.value)}
              required maxLength={1000} rows={3} disabled={busy} autoFocus />
          </div>
          <div className="button-row">
            <button type="submit" className="button danger" disabled={busy || !reason.trim()}>{busy ? "Deleting…" : "Confirm deletion"}</button>
            <button type="button" className="button ghost" disabled={busy} onClick={() => dialog.current?.close()}>Cancel</button>
          </div>
        </form>
      </dialog>}
    </div>
  );
}
