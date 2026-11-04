"use client";

import { useEffect, useId, useRef } from "react";

/**
 * Asked before leaving a screen with unsaved changes inside the app (menu, breadcrumb, Back). Keep editing
 * is the default and Escape keeps editing; only Discard changes leaves. Closing or reloading the browser tab
 * uses the browser's own warning instead (hooks/useUnsavedGuard).
 */
export function LeaveDialog({ open, onKeep, onDiscard }: { open: boolean; onKeep: () => void; onDiscard: () => void }) {
  const id = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const keep = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) {
      element.showModal();
      keep.current?.focus();
    } else if (!open && element.open) {
      element.close();
    }
  }, [open]);
  return (
    <dialog ref={dialog} className="record-dialog" aria-labelledby={`${id}-title`} aria-describedby={`${id}-text`}
      onCancel={(event) => { event.preventDefault(); onKeep(); }}>
      <div className="stack">
        <h2 id={`${id}-title`}>Discard unsaved changes?</h2>
        <p id={`${id}-text`}>This screen has changes that are not saved yet. If you leave now, they are lost.</p>
        <div className="button-row">
          <button ref={keep} type="button" className="button primary" onClick={onKeep}>Keep editing</button>
          <button type="button" className="button secondary" onClick={onDiscard}>Discard changes</button>
        </div>
      </div>
    </dialog>
  );
}
