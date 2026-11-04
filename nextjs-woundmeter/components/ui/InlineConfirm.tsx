"use client";

import { useId, useState } from "react";

/**
 * Inline confirmation for consequential actions (no modal). Optionally collects a reason.
 */
export function InlineConfirm({
  trigger,
  triggerClassName = "button secondary",
  title,
  description,
  confirmLabel,
  tone = "danger",
  reasonLabel,
  defaultReason = "",
  disabled,
  busy,
  onConfirm,
}: {
  trigger: React.ReactNode;
  triggerClassName?: string;
  title: string;
  description?: React.ReactNode;
  confirmLabel: string;
  tone?: "danger" | "primary";
  reasonLabel?: string;
  defaultReason?: string;
  disabled?: boolean;
  busy?: boolean;
  onConfirm: (reason: string) => Promise<void> | void;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState(defaultReason);
  const reasonId = useId();

  if (!open) {
    return (
      <button type="button" className={triggerClassName} disabled={disabled} onClick={() => setOpen(true)}>
        {trigger}
      </button>
    );
  }

  return (
    <div className="inline-confirm" role="group" aria-label={title}>
      <strong>{title}</strong>
      {description && <p>{description}</p>}
      {reasonLabel && (
        <div className="field">
          <label htmlFor={reasonId}>{reasonLabel}</label>
          <textarea id={reasonId} rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
        </div>
      )}
      <div className="button-row">
        <button
          type="button"
          className={`button ${tone === "danger" ? "danger" : "primary"}`}
          disabled={busy || (Boolean(reasonLabel) && !reason.trim())}
          onClick={async () => {
            await onConfirm(reason.trim());
            setOpen(false);
          }}
        >
          {busy ? "Working…" : confirmLabel}
        </button>
        <button type="button" className="button ghost" disabled={busy} onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </div>
  );
}
