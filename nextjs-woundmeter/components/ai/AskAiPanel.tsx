"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Send, Sparkles, X } from "lucide-react";

import { Loading, Notice } from "@/components/ui/Feedback";
import { CareApiError, reviseDraft } from "@/lib/care-api";
import type { DraftRevision, DraftType } from "@/lib/care-types";
import { changeCounts, diffWords, type DiffPart } from "@/lib/text-diff";

/** Where a draft lives. The server checks the user may edit it and builds the record context itself. */
export type AiContext = { patientId: string; woundId: string; draftType: DraftType; targetId?: string; field?: string };

const PROMPTS: Record<DraftType, string[]> = {
  summary_progress: ["Make this summary shorter.", "Make the progress summary easier to understand.",
    "Summarise the changes since the last visit.", "Highlight the documented concerns.", "Translate this summary into Thai."],
  care_instructions: ["Explain this in simpler terms for a caregiver.",
    "Rewrite these care instructions without changing their clinical meaning.", "Turn this into a short numbered checklist.",
    "Translate into Thai."],
  clinical_note: ["Rewrite this in professional nursing language.", "Make this shorter.", "Correct grammar and spelling only.",
    "Translate into Thai."],
  visual_observations: ["Rewrite in professional nursing language.", "Make these shorter.", "Translate into Thai."],
  report_section: ["Make this shorter.", "Rewrite this in professional nursing language.", "Make it easier to understand.",
    "Translate into Thai."],
};

type Turn = { instruction: string; result?: DraftRevision; error?: string };

function Highlighted({ parts, show }: { parts: DiffPart[]; show: "removed" | "added" }) {
  return (
    <>
      {parts.filter((p) => p.kind === "same" || p.kind === show).map((p, i) =>
        p.kind === "same" ? <span key={i}>{p.text}</span>
          : show === "removed" ? <del key={i}>{p.text}</del> : <ins key={i}>{p.text}</ins>)}
    </>
  );
}

function flagItems(flags: DraftRevision["flags"]): string[] {
  return [
    flags.unsupported_numbers.length > 0 && `Numbers not in the current text or the record: ${flags.unsupported_numbers.join(", ")}`,
    flags.new_clinical_terms.length > 0 && `Treatment or care terms not in the current text: ${flags.new_clinical_terms.join(", ")}`,
    flags.scope_statements.length > 0 && `Wording outside documentation scope (staging, diagnosis, infection, healing): ${flags.scope_statements.join(", ")}`,
    flags.removed_uncertainty.length > 0 && `Uncertainty wording removed: ${flags.removed_uncertainty.join(", ")}`,
  ].filter(Boolean) as string[];
}

/** Wording checks are heuristics, so a flagged suggestion is usable only after the user confirms they checked it. */
function Flags({ items, checked, onChecked }: { items: string[]; checked: boolean; onChecked: (value: boolean) => void }) {
  if (!items.length) return null;
  return (
    <Notice tone="warning" title="Check before using">
      <ul className="bullet-list">{items.map((item) => <li key={item}>{item}</li>)}</ul>
      <label className="checkbox-row compact">
        <input type="checkbox" checked={checked} onChange={(e) => onChecked(e.target.checked)} />
        I have checked the flagged wording against the record
      </label>
    </Notice>
  );
}

/**
 * Ask AI: a compact side drawer (bottom sheet on phones) where staff ask Muse Spark to rework a draft in
 * Thai or English. Suggestions are compared with the current text and change nothing until the user
 * chooses Use suggestion; the host editor then still needs its own Save and sign-off.
 */
export function AskAiPanel({ open, label, text, context, onUse, onClose }: {
  open: boolean;
  label: string;
  text: string;
  context: AiContext;
  onUse: (text: string, revisionId: string) => void;
  onClose: () => void;
}) {
  const id = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const base = useRef(text);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [instruction, setInstruction] = useState("");
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [highlight, setHighlight] = useState(true);
  const [flagsChecked, setFlagsChecked] = useState(false);

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) {
      base.current = text;
      setTurns([]);
      setInstruction("");
      setEditing(null);
      element.showModal();
      input.current?.focus();
    } else if (!open && element.open) {
      element.close();
    }
    // `text` is read only when the drawer opens: it is the comparison baseline for this conversation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const latest = [...turns].reverse().find((t) => t.result)?.result ?? null;
  const working = latest?.suggestion ?? base.current;
  const parts = latest ? diffWords(base.current, latest.suggestion) : null;
  const counts = parts ? changeCounts(parts) : null;
  const flagged = latest ? flagItems(latest.flags) : [];
  const usable = flagged.length === 0 || flagsChecked;

  async function send(value: string) {
    const ask = value.trim();
    if (!ask || busy) return;
    setBusy(true);
    setEditing(null);
    setFlagsChecked(false);
    setInstruction("");
    const history = turns.filter((t) => t.result).map((t) => t.instruction);
    setTurns((prev) => [...prev, { instruction: ask }]);
    try {
      const result = await reviseDraft(context.patientId, context.woundId, {
        draft_type: context.draftType, text: working, base_text: base.current, instruction: ask,
        target_id: context.targetId, field: context.field, history,
      });
      setTurns((prev) => prev.map((t, i) => (i === prev.length - 1 ? { ...t, result } : t)));
    } catch (err) {
      const message = err instanceof CareApiError ? err.message : "Muse Spark did not respond.";
      setTurns((prev) => prev.map((t, i) => (i === prev.length - 1 ? { ...t, error: message } : t)));
    } finally {
      setBusy(false);
    }
  }

  const discard = () => {
    setEditing(null);
    setTurns((prev) => prev.map((t) => (t.result === latest ? { ...t, result: undefined, error: "Suggestion discarded." } : t)));
  };

  return (
    <dialog ref={dialog} className="ai-drawer" aria-labelledby={`${id}-title`} onClose={onClose} onCancel={onClose}>
      <div className="ai-drawer-inner">
        <header className="ai-drawer-head">
          <h2 id={`${id}-title`}><Sparkles aria-hidden="true" className="inline-icon" /> Ask AI · {label}</h2>
          <button type="button" className="icon-button" aria-label="Close Ask AI" onClick={onClose}><X aria-hidden="true" /></button>
        </header>
        <p className="fine-print">
          Muse Spark suggests wording from this text and the verified record. Nothing changes until you choose <strong>Use suggestion</strong>,
          and saving still follows the normal review and sign-off. It is instructed not to add treatments, diagnoses or findings, and
          WoundMeter flags some risky changes, but it can still make mistakes: check every suggestion against the record.
        </p>

        <ol className="ai-drawer-turns" aria-label="Requests" aria-live="polite">
          {turns.map((turn, index) => (
            <li key={index}>
              <p className="ai-chat-user"><strong>{turn.instruction}</strong></p>
              {turn.error && <p className="muted-text">{turn.error}</p>}
              {turn.result && turn.result !== latest && <p className="fine-print">Earlier suggestion: {turn.result.change_summary || "revised text"}</p>}
            </li>
          ))}
        </ol>
        {busy && <Loading label="Muse Spark is revising (about 5–15 s)…" />}

        {latest && (
          <section className="ai-compare" aria-label="Compare current text and AI suggestion">
            <div className="ai-compare-head">
              <span>{latest.change_summary || "Suggested revision"}</span>
              {counts && <span className="fine-print">{counts.removed} word{counts.removed === 1 ? "" : "s"} removed · {counts.added} added</span>}
              {parts && (
                <label className="checkbox-row compact">
                  <input type="checkbox" checked={highlight} onChange={(e) => setHighlight(e.target.checked)} /> Highlight changes
                </label>
              )}
            </div>
            <Flags items={flagged} checked={flagsChecked} onChecked={setFlagsChecked} />
            <div className="ai-compare-panes">
              <div>
                <p className="field-label">Current text</p>
                <p className="ai-compare-text" data-testid="ai-current">{parts && highlight ? <Highlighted parts={parts} show="removed" /> : base.current}</p>
              </div>
              <div>
                <p className="field-label">AI suggestion</p>
                {editing !== null ? (
                  <textarea aria-label="Edit the suggestion" rows={6} value={editing} onChange={(e) => setEditing(e.target.value)} />
                ) : (
                  <p className="ai-compare-text" data-testid="ai-suggestion">{parts && highlight ? <Highlighted parts={parts} show="added" /> : latest.suggestion}</p>
                )}
              </div>
            </div>
            <div className="button-row compact">
              {editing !== null ? (
                <button type="button" className="button primary small" disabled={!editing.trim() || !usable} onClick={() => onUse(editing.trim(), latest.revision_id)}>
                  Use edited text
                </button>
              ) : (
                <button type="button" className="button primary small" disabled={!usable} onClick={() => onUse(latest.suggestion, latest.revision_id)}>Use suggestion</button>
              )}
              {editing === null && <button type="button" className="button secondary small" onClick={() => setEditing(latest.suggestion)}>Edit before using</button>}
              <button type="button" className="button ghost small" onClick={discard}>Discard</button>
            </div>
            <p className="fine-print">Live response from Meta {latest.model} · {(latest.latency_ms / 1000).toFixed(1)} s · AI suggestion, not reviewed by a clinician</p>
          </section>
        )}

        <div className="ai-drawer-ask">
          {turns.length === 0 && (
            <div className="button-row compact" aria-label="Example requests">
              {PROMPTS[context.draftType].map((prompt) => (
                <button key={prompt} type="button" className="demo-chip" disabled={busy} onClick={() => void send(prompt)}>{prompt}</button>
              ))}
            </div>
          )}
          <div className="field">
            <label htmlFor={`${id}-input`}>{latest ? "Refine the suggestion" : "What should change?"} <span className="fine-print">Thai or English</span></label>
            <textarea id={`${id}-input`} ref={input} rows={2} value={instruction} placeholder="e.g. Make this shorter · ทำให้สั้นลง"
              onChange={(e) => setInstruction(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void send(instruction);
                }
              }} />
          </div>
          <div className="button-row compact">
            <button type="button" className="button primary small" disabled={busy || !instruction.trim()} onClick={() => void send(instruction)}>
              <Send aria-hidden="true" className="inline-icon" /> Ask
            </button>
            <button type="button" className="button ghost small" onClick={onClose}>Close</button>
          </div>
        </div>
      </div>
    </dialog>
  );
}
