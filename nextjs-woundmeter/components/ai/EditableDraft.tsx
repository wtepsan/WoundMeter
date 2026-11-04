"use client";

import { useEffect, useId, useState } from "react";
import { Pencil, Sparkles } from "lucide-react";

import { AskAiPanel, type AiContext } from "@/components/ai/AskAiPanel";
import { DraftTextEditor } from "@/components/ai/DraftTextEditor";
import { ClampedText } from "@/components/ui/ClampedText";
import { Notice } from "@/components/ui/Feedback";
import { useUnsavedGuard } from "@/hooks/useUnsavedGuard";

/**
 * One editable piece of documentation: read view (a few lines, Show more), then Edit or Ask AI in
 * place. Saving calls the owner's own save (a draft version, a care-plan version…); nothing is
 * saved on Ask AI or on each keystroke.
 */
export function EditableDraft({
  label,
  text,
  canEdit,
  ai,
  onSave,
  saveLabel = "Save draft",
  editLabel = "Edit",
  startText,
  reason,
  lines = 3,
  editing: editingProp,
  onEditingChange,
  maxLength = 6000,
}: {
  label: string;
  /** The saved text shown in the read view. */
  text: string;
  canEdit: boolean;
  ai: AiContext | null;
  onSave: (text: string, extra: { reason: string; aiRevisionIds: string[] }) => Promise<void>;
  saveLabel?: string;
  editLabel?: string;
  /** Text the editor starts from, when it differs from the saved text (a new draft). */
  startText?: string;
  /** A required reason, e.g. when revising approved content. */
  reason?: { label: string; hint?: string } | null;
  lines?: number;
  editing?: boolean;
  onEditingChange?: (editing: boolean) => void;
  maxLength?: number;
}) {
  const id = useId();
  const [ownEditing, setOwnEditing] = useState(false);
  const editing = editingProp ?? ownEditing;
  const initial = startText ?? text;
  const [value, setValue] = useState(initial);
  const [why, setWhy] = useState("");
  const [aiIds, setAiIds] = useState<string[]>([]);
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const dirty = editing && (value !== initial || why.trim() !== "");
  useUnsavedGuard(dirty);

  const setEditing = (next: boolean) => {
    setOwnEditing(next);
    onEditingChange?.(next);
  };
  const open = (start = initial, ids: string[] = []) => {
    setValue(start);
    setWhy("");
    setAiIds(ids);
    setError(null);
    setConfirmDiscard(false);
    setEditing(true);
  };
  // An externally opened editor (e.g. "Write summary") starts from the current start text.
  useEffect(() => {
    if (editingProp) open();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingProp]);
  // A saved edit unmounts with a new version (keyed by it); report the editor closed.
  useEffect(() => () => onEditingChange?.(false), []); // eslint-disable-line react-hooks/exhaustive-deps

  const close = () => {
    setConfirmDiscard(false);
    setEditing(false);
  };

  async function save() {
    if (!value.trim()) {
      setError(`${label} cannot be empty.`);
      return;
    }
    if (startText === undefined && value.trim() === text.trim()) {
      setError("Nothing has changed.");
      return;
    }
    if (reason && !why.trim()) {
      setError(`Enter the ${reason.label.toLowerCase()} before saving.`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onSave(value.trim(), { reason: why.trim(), aiRevisionIds: aiIds });
      close();
    } catch (err) {
      // The typed text stays in the editor.
      setError(err instanceof Error ? err.message : "Could not save. Your text is still here.");
    } finally {
      setBusy(false);
    }
  }

  if (!editing) {
    return (
      <div className="editable-draft">
        {text ? <ClampedText text={text} lines={lines} /> : null}
        {canEdit && (
          <div className="button-row compact draft-actions">
            <button type="button" className="button ghost small" onClick={() => open()}>
              <Pencil aria-hidden="true" /> {editLabel}
            </button>
            {ai && (text || initial) && (
              <button type="button" className="button ghost small ask-ai-button" onClick={() => setAsking(true)}>
                <Sparkles aria-hidden="true" /> Ask AI
              </button>
            )}
          </div>
        )}
        {ai && canEdit && (
          <AskAiPanel open={asking} label={label} text={text || initial} context={ai} onClose={() => setAsking(false)}
            onUse={(suggestion, revisionId) => {
              setAsking(false);
              open(suggestion, [revisionId]);
            }} />
        )}
      </div>
    );
  }

  return (
    <div className="editable-draft is-editing" role="group" aria-label={`Edit ${label.toLowerCase()}`}>
      <DraftTextEditor id={`${id}-text`} label={label} value={value} onChange={setValue} ai={ai} rows={Math.min(10, Math.max(3, value.split("\n").length + 1, Math.ceil(value.length / 60) + 1))}
        maxLength={maxLength} onAiApplied={(revisionId) => setAiIds((ids) => [...ids, revisionId])}
        hint={aiIds.length ? "Includes AI-suggested wording. Check it before saving." : undefined} />
      {reason && (
        <div className="field">
          <label htmlFor={`${id}-reason`} className="is-required">{reason.label}</label>
          <input id={`${id}-reason`} value={why} maxLength={500} autoComplete="off" onChange={(e) => setWhy(e.target.value)} />
          {reason.hint && <span className="field-hint">{reason.hint}</span>}
        </div>
      )}
      {error && <Notice tone="danger">{error}</Notice>}
      {confirmDiscard ? (
        <div className="inline-confirm" role="alert">
          <span>Discard your unsaved changes?</span>
          <div className="button-row compact">
            <button type="button" className="button danger small" onClick={close}>Discard changes</button>
            <button type="button" className="button ghost small" onClick={() => setConfirmDiscard(false)}>Keep editing</button>
          </div>
        </div>
      ) : (
        <div className="button-row compact">
          <button type="button" className="button primary small" disabled={busy} onClick={() => void save()}>{busy ? "Saving…" : saveLabel}</button>
          <button type="button" className="button ghost small" disabled={busy} onClick={() => (dirty ? setConfirmDiscard(true) : close())}>Cancel</button>
        </div>
      )}
    </div>
  );
}
