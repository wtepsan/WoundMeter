"use client";

import { useId, useRef, useState } from "react";
import { Sparkles } from "lucide-react";

import { AskAiPanel, type AiContext } from "@/components/ai/AskAiPanel";

/**
 * A textarea with an optional Ask AI action. A suggestion the user chooses replaces the text in the
 * box only; the surrounding form keeps its own Save and sign-off. `onAiApplied` lets the form record
 * which audited suggestions it used.
 */
export function DraftTextEditor({
  id,
  label,
  value,
  onChange,
  ai,
  onAiApplied,
  rows = 4,
  required,
  invalid,
  disabled,
  hint,
  maxLength,
  labelHidden = false,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  /** null when this user cannot ask AI here (the server enforces it as well). */
  ai: AiContext | null;
  onAiApplied?: (revisionId: string) => void;
  rows?: number;
  required?: boolean;
  invalid?: boolean;
  disabled?: boolean;
  hint?: React.ReactNode;
  maxLength?: number;
  /** For a field whose heading is already visible next to it. */
  labelHidden?: boolean;
}) {
  const labelId = useId();
  const box = useRef<HTMLTextAreaElement>(null);
  const [asking, setAsking] = useState(false);
  return (
    <div className="field draft-editor">
      <div className="draft-editor-head">
        <label id={labelId} htmlFor={id} className={labelHidden ? "sr-only" : required ? "is-required" : undefined}>{label}</label>
        {ai && (
          <button type="button" className="button ghost small ask-ai-button" aria-describedby={labelId}
            disabled={disabled || !value.trim()} title={value.trim() ? undefined : "Write something first"} onClick={() => setAsking(true)}>
            <Sparkles aria-hidden="true" /> Ask AI
          </button>
        )}
      </div>
      <textarea ref={box} id={id} rows={rows} value={value} required={required} disabled={disabled} maxLength={maxLength}
        aria-invalid={invalid || undefined} onChange={(e) => onChange(e.target.value)} />
      {hint && <span className="field-hint">{hint}</span>}
      {ai && (
        <AskAiPanel open={asking} label={label} text={value} context={ai} onClose={() => setAsking(false)}
          onUse={(text, revisionId) => {
            onChange(text);
            onAiApplied?.(revisionId);
            setAsking(false);
            box.current?.focus();
          }} />
      )}
    </div>
  );
}
