"use client";

import { useState } from "react";
import { Sparkles } from "lucide-react";

import { DraftTextEditor } from "@/components/ai/DraftTextEditor";
import { Badge, Notice } from "@/components/ui/Feedback";
import { personName } from "@/lib/accounts";
import { CareApiError, generateAiObservations, reviewAiObservations } from "@/lib/care-api";
import { formatCm, formatDateTime, humanize, museSourceLabel, type Tone } from "@/lib/care-format";
import type { AiFinding, AiVisualObservation, CareMuseExplanation } from "@/lib/care-types";

const STATUS_TONE: Record<string, Tone> = { observed: "info", possibly_observed: "warning", not_observed: "neutral", not_assessable: "neutral" };
const REVIEW_LABEL: Record<AiVisualObservation["status"], { label: string; tone: Tone }> = {
  AI_DRAFT: { label: "AI draft · needs review", tone: "warning" },
  ACCEPTED: { label: "Accepted by clinician", tone: "success" },
  EDITED: { label: "Corrected by clinician", tone: "success" },
  REJECTED: { label: "Rejected by clinician", tone: "neutral" },
};

function FindingList({ findings }: { findings: AiFinding[] }) {
  return (
    <ul className="finding-list">
      {findings.map((finding, index) => (
        <li key={`${finding.category}-${index}`}>
          <span className="finding-head">
            <strong>{humanize(finding.category)}</strong>
            <Badge tone={STATUS_TONE[finding.assessment_status] ?? "neutral"}>{humanize(finding.assessment_status)}</Badge>
            {finding.uncertainty && <span className="fine-print">uncertainty {finding.uncertainty}</span>}
          </span>
          <span>{finding.observation}</span>
          {finding.evidence && <span className="fine-print">Seen: {finding.evidence}</span>}
        </li>
      ))}
    </ul>
  );
}

/**
 * Muse Spark assistance kept short: a one-line summary, warnings and the review actions. The full
 * output, uncertainty and provenance stay one click away and are never deleted. Nothing here
 * writes to the clinical record; a clinician copies or rewrites it.
 */
export function AiAssistance({
  observationId,
  patientId,
  woundId,
  versions,
  explanation,
  draftStatus,
  draftMismatch,
  workingArea,
  canReview,
  editable,
  observationsOpen = true,
  disposition,
  onUseDraft,
  onRejectDraft,
  onChanged,
}: {
  observationId: string;
  patientId: string;
  woundId: string;
  versions: AiVisualObservation[];
  explanation: CareMuseExplanation | null;
  draftStatus: string | null | undefined;
  draftMismatch: number | null;
  workingArea: number | null;
  canReview: boolean;
  editable: boolean;
  /** Visual observations can be generated and reviewed only while the record is pending. */
  observationsOpen?: boolean;
  disposition: "not_used" | "accepted" | "edited" | "rejected";
  onUseDraft: (text: string) => void;
  onRejectDraft: () => void;
  onChanged: () => Promise<unknown>;
}) {
  const latest = versions[0] ?? null;
  const [busy, setBusy] = useState<"generate" | "review" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<"idle" | "edit" | "reject">("idle");
  const [draft, setDraft] = useState("");
  const [notes, setNotes] = useState("");
  const [aiIds, setAiIds] = useState<string[]>([]);
  const muse = museSourceLabel(explanation?.status);

  async function run(kind: "generate" | "review", action: () => Promise<unknown>) {
    setBusy(kind);
    setError(null);
    try {
      await action();
      await onChanged();
      setMode("idle");
      setNotes("");
      setAiIds([]);
    } catch (err) {
      setError(err instanceof CareApiError ? err.message : "The AI service did not respond. You can continue without it.");
    } finally {
      setBusy(null);
    }
  }

  const findings = latest ? (latest.status === "EDITED" && latest.clinician_findings ? latest.clinician_findings : latest.findings.findings) : [];
  const assessable = findings.filter((f) => f.assessment_status !== "not_assessable");
  const issues = latest?.findings.image_quality.issues ?? [];
  const unusable = latest && !latest.findings.image_quality.usable_for_visual_description;
  const editedFindings = () => draft.split("\n").map((line) => line.trim()).filter(Boolean).map((line) => {
    const [category, ...rest] = line.split(":");
    return rest.length ? { category: category.trim(), observation: rest.join(":").trim() } : { category: "other", observation: line };
  });

  return (
    <section className="record-section ai-assistance" aria-labelledby="ai-title" id="grp-ai">
      <div className="section-head">
        <h2 id="ai-title" className="section-title"><Sparkles aria-hidden="true" className="inline-icon" /> AI assistance</h2>
        <Badge tone="neutral">Optional</Badge>
      </div>
      <p className="ai-intro">
        Muse Spark describes what it can see in the photo and can draft your note. Nothing enters the record until you accept it or copy it into your note.
      </p>
      <details className="ai-details ai-scope">
        <summary>What the AI won&apos;t do</summary>
        <p className="fine-print">
          It does not stage the wound, make a diagnosis, or judge infection, depth or tissue viability. Those need your bedside
          assessment. If its visual observations mention any of these, WoundMeter removes the statement before you see it.
        </p>
      </details>
      {error && <Notice tone="warning" title="AI unavailable">{error}</Notice>}

      <div className="ai-item">
        <div className="ai-item-head">
          <strong>Visual observations</strong>
          {latest ? <Badge tone={REVIEW_LABEL[latest.status].tone}>{REVIEW_LABEL[latest.status].label}</Badge> : <span className="fine-print">Not generated</span>}
        </div>
        {busy === "generate" && <p className="muted-text" role="status">Muse Spark is looking at the photo (about 15–25 s)…</p>}
        {latest ? (
          <>
            <p className="ai-summary">
              {unusable ? "The AI judged this photo not clinically assessable for a visual description."
                : assessable.length ? assessable.slice(0, 3).map((f) => `${humanize(f.category)}: ${f.observation}`).join(" · ")
                  : "No visible findings were described."}
              {assessable.length > 3 && ` · +${assessable.length - 3} more`}
            </p>
            {(issues.length > 0 || !latest.input.colour_interpretation_allowed) && (
              <p className="warning-text">
                {issues.length > 0 && `Image limits: ${issues.join("; ")}. `}
                {!latest.input.colour_interpretation_allowed && "Colour descriptions are off because colour is not calibrated."}
              </p>
            )}
            {latest.findings.requires_physical_assessment.length > 0 && (
              <p className="fine-print">Needs bedside assessment: {latest.findings.requires_physical_assessment.join("; ")}.</p>
            )}
            {latest.status === "AI_DRAFT" && canReview && editable && observationsOpen && mode === "idle" && (
              <div className="button-row compact">
                <button type="button" className="button secondary small" disabled={busy !== null}
                  onClick={() => void run("review", () => reviewAiObservations(latest.ai_observation_id, { decision: "accept" }))}>Accept</button>
                <button type="button" className="button secondary small" disabled={busy !== null} onClick={() => {
                  setDraft(assessable.map((f) => `${f.category}: ${f.observation}`).join("\n"));
                  setAiIds([]);
                  setMode("edit");
                }}>Correct</button>
                <button type="button" className="button ghost small" disabled={busy !== null} onClick={() => setMode("reject")}>Reject</button>
              </div>
            )}
            {mode === "edit" && (
              <div className="stack tight">
                <DraftTextEditor id="ai-obs-edit" label="Your observations, one per line (category: text)" rows={4} value={draft} onChange={setDraft}
                  ai={{ patientId, woundId, draftType: "visual_observations", targetId: observationId }}
                  onAiApplied={(id) => setAiIds((ids) => [...ids, id])} />
                <div className="field">
                  <label htmlFor="ai-obs-edit-notes">Note (optional)</label>
                  <input id="ai-obs-edit-notes" value={notes} onChange={(e) => setNotes(e.target.value)} autoComplete="off" />
                </div>
                <div className="button-row compact">
                  <button type="button" className="button primary small" disabled={busy !== null || !editedFindings().length}
                    onClick={() => void run("review", () => reviewAiObservations(latest.ai_observation_id, { decision: "edit", notes, clinician_findings: editedFindings(), ai_revision_ids: aiIds }))}>
                    Save correction
                  </button>
                  <button type="button" className="button ghost small" onClick={() => setMode("idle")}>Cancel</button>
                </div>
              </div>
            )}
            {mode === "reject" && (
              <div className="stack tight">
                <div className="field">
                  <label htmlFor="ai-obs-reject">Reason for rejecting</label>
                  <input id="ai-obs-reject" value={notes} onChange={(e) => setNotes(e.target.value)} autoComplete="off" />
                </div>
                <div className="button-row compact">
                  <button type="button" className="button danger small" disabled={busy !== null || !notes.trim()}
                    onClick={() => void run("review", () => reviewAiObservations(latest.ai_observation_id, { decision: "reject", notes }))}>Reject observations</button>
                  <button type="button" className="button ghost small" onClick={() => setMode("idle")}>Cancel</button>
                </div>
              </div>
            )}
            <details className="ai-details">
              <summary>Show details</summary>
              <div className="stack tight">
                <FindingList findings={latest.findings.findings} />
                {latest.status === "EDITED" && latest.clinician_findings && (
                  <><p className="fine-print">Clinician correction (the AI output above is kept for traceability):</p><FindingList findings={latest.clinician_findings} /></>
                )}
                {latest.findings.missing_information.length > 0 && <p className="fine-print">Missing information: {latest.findings.missing_information.join("; ")}.</p>}
                {latest.guard_flags.length > 0 && <p className="fine-print">{latest.guard_flags.length} statement(s) outside the permitted scope were removed by WoundMeter.</p>}
                <p className="fine-print">
                  {latest.model_id} · version {latest.version_number} · {formatDateTime(latest.created_at_utc)}
                  {latest.latency_ms ? ` · ${(latest.latency_ms / 1000).toFixed(1)} s` : ""}
                  {latest.reviewed_by_subject && ` · reviewed by ${personName(latest.reviewed_by_subject)}${latest.clinician_notes ? `: “${latest.clinician_notes}”` : ""}`}
                </p>
              </div>
            </details>
          </>
        ) : null}
        {canReview && editable && observationsOpen && (
          <button type="button" className="link-button" disabled={busy !== null}
            onClick={() => void run("generate", () => generateAiObservations(observationId))}>
            {latest ? "Ask Muse Spark again" : "Generate AI observations"}
          </button>
        )}
      </div>

      {canReview && (
        <div className="ai-item">
          <div className="ai-item-head">
            <strong>Draft note</strong>
            <Badge tone={muse.tone}>{muse.label}</Badge>
          </div>
          {explanation ? (
            <>
              {draftMismatch != null && (
                <p className="warning-text">The draft quotes {draftMismatch.toFixed(2)} cm², but the measurement on screen is {formatCm(workingArea)} cm². Correct the figures if you use it.</p>
              )}
              <p className="ai-summary">{explanation.measurement_summary}</p>
              {editable && (
                <div className="button-row compact">
                  <button type="button" className="button secondary small" onClick={() => onUseDraft(explanation.documentation_draft)}>Use draft in my note</button>
                  <button type="button" className="button ghost small" aria-pressed={disposition === "rejected"} onClick={onRejectDraft}>Don&apos;t use</button>
                </div>
              )}
              <details className="ai-details">
                <summary>Show details</summary>
                <div className="stack tight">
                  <blockquote className="draft-quote">{explanation.documentation_draft}</blockquote>
                  {explanation.historical_comparison && <p>{explanation.historical_comparison}</p>}
                  {explanation.questions_for_reviewer.length > 0 && (
                    <><p className="fine-print">Points the AI suggests checking:</p><ul className="bullet-list">{explanation.questions_for_reviewer.map((q) => <li key={q}>{q}</li>)}</ul></>
                  )}
                  <p className="fine-print">{explanation.segmentation_explanation}</p>
                  {explanation.measurement_limitations && <p className="fine-print">Limitations: {explanation.measurement_limitations}</p>}
                  <p className="fine-print">{explanation.model_id}{explanation.latency_ms ? ` · ${(explanation.latency_ms / 1000).toFixed(1)} s` : ""}</p>
                </div>
              </details>
            </>
          ) : (
            <p className="muted-text">{draftStatus === "stale" ? "The earlier draft no longer matches the measurement, so it is hidden. Write your own note." : "No AI draft for this photo. Write your note below."}</p>
          )}
        </div>
      )}
    </section>
  );
}
