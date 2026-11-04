"use client";

import { useState } from "react";
import { Sparkles } from "lucide-react";

import type { AiContext } from "@/components/ai/AskAiPanel";
import { EditableDraft } from "@/components/ai/EditableDraft";
import { CareInstructions } from "@/components/care/CareInstructions";
import { ClampedText } from "@/components/ui/ClampedText";
import { Badge, Loading, Notice } from "@/components/ui/Feedback";
import { can, roleLabel, type Account, type Portal } from "@/lib/accounts";
import { CareApiError, draftWoundSummary, reviewReport } from "@/lib/care-api";
import {
  formatCm,
  formatDate,
  formatDateTime,
  humanize,
  modelLabel,
  progressSentences,
  regionLabel,
  woundSiteLabel,
  type Tone,
} from "@/lib/care-format";
import type { SummaryAction, SummaryIssue, SummaryNarrative, WoundCareSummary as Summary, WoundDetail } from "@/lib/care-types";

const ISSUE_TAG: Record<SummaryIssue["status"], { label: string; tone: Tone }> = {
  reported: { label: "Reported · not verified", tone: "warning" },
  pending: { label: "Pending", tone: "info" },
  documented: { label: "Care plan", tone: "neutral" },
  missing: { label: "Evidence gap", tone: "danger" },
};
const VERSION_STATUS: Record<string, string> = {
  AI_DRAFT: "AI draft", CLINICIAN_EDITED: "Edited draft", SIGNED: "Signed", REJECTED: "Rejected", SUPERSEDED: "Superseded",
};

function draftBadge(draft: SummaryNarrative): { label: string; tone: Tone } {
  if (draft.source === "ai_draft") return { label: "AI draft · not signed", tone: "warning" };
  if (draft.source === "record") return { label: "From the record · not signed", tone: "info" };
  return { label: "Edited draft · not signed", tone: "info" };
}

function Section({ title, children, wide = false }: { title: string; children: React.ReactNode; wide?: boolean }) {
  return (
    <section className={`summary-section${wide ? " is-wide" : ""}`} aria-label={title}>
      <h3 className="summary-section-title">{title}</h3>
      {children}
    </section>
  );
}

function ShowMore<T>({ items, first, render, label }: { items: T[]; first: number; render: (item: T, i: number) => React.ReactNode; label: string }) {
  const [all, setAll] = useState(false);
  const shown = all ? items : items.slice(0, first);
  return (
    <>
      <ul className="summary-list">{shown.map(render)}</ul>
      {items.length > first && (
        <button type="button" className="link-button clamped-toggle" aria-expanded={all} onClick={() => setAll((v) => !v)}>
          {all ? "Show less" : `Show ${items.length - first} more ${label}`}
        </button>
      )}
    </>
  );
}

function IssueItem({ issue }: { issue: SummaryIssue }) {
  const tag = ISSUE_TAG[issue.status];
  return (
    <li className="summary-item">
      <span className="summary-item-line">
        <Badge tone={issue.priority === "high" ? "danger" : tag.tone}>{issue.priority === "high" ? "Priority" : tag.label}</Badge>
        <span>{issue.label}{issue.date_utc ? <span className="summary-meta"> · {formatDate(issue.date_utc)}</span> : null}</span>
      </span>
      {issue.detail && <span className="summary-meta summary-quote">“{issue.detail}”</span>}
    </li>
  );
}

function ActionItem({ action, primary }: { action: SummaryAction; primary?: boolean }) {
  const when = action.due_utc ? `due ${formatDate(action.due_utc)}` : action.since_utc ? `since ${formatDate(action.since_utc)}` : null;
  return (
    <li className={`summary-item${primary ? " is-primary" : ""}`}>
      <span className="summary-item-line">
        <strong>{action.label}{action.count && action.count > 1 ? ` (${action.count})` : ""}</strong>
        {action.overdue && <Badge tone="danger">Overdue</Badge>}
      </span>
      <span className="summary-meta">{[action.responsible?.name, when, action.frequency].filter(Boolean).join(" · ")}</span>
    </li>
  );
}

function CareNow({ summary, wound, account, portal, onChanged, onOpenCarePlan }: {
  summary: Summary; wound: WoundDetail; account: Account; portal: Portal; onChanged: () => Promise<unknown>; onOpenCarePlan?: () => void;
}) {
  const care = summary.care_now;
  const canManage = portal === "clinical" && can(account, "MANAGE_CARE_PLAN");
  if (!care.available) {
    return (
      <>
        <p className="muted-text">{care.message}</p>
        {canManage && onOpenCarePlan && <button type="button" className="link-button" onClick={onOpenCarePlan}>Open the care plan</button>}
      </>
    );
  }
  const plan = wound.care_plans.find((p) => p.care_plan_id === care.care_plan_id);
  return (
    <>
      {plan ? <CareInstructions wound={wound} plan={plan} canManage={canManage} onChanged={onChanged} /> : <ClampedText text={care.instructions} />}
      <p className="summary-meta">
        {[care.frequency, care.assigned_caregiver ? `Caregiver: ${care.assigned_caregiver.name}` : "No caregiver assigned",
          care.responsible_clinician ? `Approved by ${care.responsible_clinician.name}` : null, `Version ${care.version_number}`].filter(Boolean).join(" · ")}
      </p>
      {care.review_overdue && care.review_date && <p className="warning-text">Plan review was due {formatDate(care.review_date)}.</p>}
    </>
  );
}

/** Staff: the progress-summary draft, its editing (manual or Ask AI), sign-off, rejection and version history. */
function ProgressNarrative({ summary, wound, account, onChanged }: {
  summary: Summary; wound: WoundDetail; account: Account; onChanged: () => Promise<unknown>;
}) {
  const draft = summary.narrative_draft ?? null;
  const approved = summary.progress.narrative;
  const versions = summary.narrative_versions ?? [];
  const canDraft = can(account, "ASSESS");
  const canSign = can(account, "SIGN_OFF") && account.qualification_verified;
  const [writing, setWriting] = useState(false);
  const [askReason, setAskReason] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attested, setAttested] = useState(false);
  const [confirmFlagged, setConfirmFlagged] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [rejectReason, setRejectReason] = useState("");
  // Signing or rejecting while the draft is open in the editor would act on the saved text and drop the edit.
  const [editingDraft, setEditingDraft] = useState(false);
  const ai = (targetId?: string): AiContext | null =>
    canDraft ? { patientId: wound.patient_id, woundId: wound.wound_id, draftType: "summary_progress", targetId } : null;
  const consistency = draft?.consistency;
  const flagged = Boolean(consistency && !consistency.ok);
  const startText = approved?.text ?? progressSentences(summary).join(" ");

  async function run(label: string, action: () => Promise<unknown>) {
    setBusy(label);
    setError(null);
    try {
      await action();
      setAttested(false);
      setConfirmFlagged(false);
      setRejecting(false);
      setRejectReason("");
      setAskReason(false);
      setReason("");
      await onChanged();
    } catch (err) {
      setError(err instanceof CareApiError ? err.message : "That didn't work. Try again.");
    } finally {
      setBusy(null);
    }
  }

  if (!canDraft) return null;
  const aiDraft = () => run("draft", () => draftWoundSummary(wound.patient_id, wound.wound_id, { mode: "ai", revision_reason: reason.trim() || undefined }));

  return (
    <div className="summary-narrative-staff">
      {error && <Notice tone="danger">{error}</Notice>}
      {busy === "draft" && <Loading label="Drafting with Muse Spark (about 10–20 s)…" />}
      {draft ? (
        <div className="summary-draft" aria-label="Progress summary draft" role="group">
          <p className="summary-item-line">
            <Badge tone={draftBadge(draft).tone}>{draftBadge(draft).label}</Badge>
            <span className="summary-meta">
              Version {draft.version_number} · {draft.created_by?.name} · {formatDateTime(draft.created_at_utc)}{draft.ai_assisted ? " · includes AI-suggested wording" : ""}
            </span>
          </p>
          {draft.revision_reason && <p className="summary-meta">Reason for revision: {draft.revision_reason}</p>}
          {flagged && (
            <Notice tone="warning" title="Check before signing">
              {Object.values(consistency!.unsupported_numbers).flat().length > 0 && <div>Numbers not found in the record: {Object.values(consistency!.unsupported_numbers).flat().join(", ")}.</div>}
              {(consistency!.uncited_sections ?? []).length > 0 && <div>The AI text cites no record entry.</div>}
            </Notice>
          )}
          <EditableDraft key={draft.report_id} label="Progress summary" text={draft.text} canEdit ai={ai(draft.report_id)} maxLength={2000}
            onEditingChange={setEditingDraft}
            onSave={async (text, { aiRevisionIds }) => {
              await reviewReport(draft.report_id!, { decision: "edit", sections: { progress: text },
                ai_revisions: aiRevisionIds.length ? { progress: aiRevisionIds } : undefined });
              await onChanged();
            }} />
          {editingDraft ? (
            <p className="fine-print">Save or cancel your edit before signing or rejecting.</p>
          ) : canSign ? (
            <div className="stack tight">
              <label className="checkbox-row">
                <input type="checkbox" checked={attested} onChange={(e) => setAttested(e.target.checked)} />
                I reviewed this summary against the record and take responsibility for its content.
              </label>
              {flagged && (
                <label className="checkbox-row">
                  <input type="checkbox" checked={confirmFlagged} onChange={(e) => setConfirmFlagged(e.target.checked)} />
                  I checked the flagged text and it is correct.
                </label>
              )}
            </div>
          ) : <p className="fine-print">Signing needs a qualified clinician with sign-off permission.</p>}
          {editingDraft ? null : rejecting ? (
            <div className="inline-form">
              <div className="field">
                <label htmlFor={`summary-reject-${wound.wound_id}`}>Reason to reject this draft</label>
                <input id={`summary-reject-${wound.wound_id}`} value={rejectReason} autoComplete="off" onChange={(e) => setRejectReason(e.target.value)} />
              </div>
              <div className="button-row compact">
                <button type="button" className="button danger small" disabled={busy !== null || !rejectReason.trim()}
                  onClick={() => void run("reject", () => reviewReport(draft.report_id!, { decision: "reject", reason: rejectReason }))}>Reject draft</button>
                <button type="button" className="button ghost small" onClick={() => setRejecting(false)}>Cancel</button>
              </div>
            </div>
          ) : (
            <div className="button-row compact">
              {canSign && (
                <button type="button" className="button primary small" disabled={busy !== null || !attested || (flagged && !confirmFlagged)}
                  onClick={() => void run("sign", () => reviewReport(draft.report_id!, { decision: "sign", attested: true, confirm_flagged_content: confirmFlagged }))}>
                  Sign summary
                </button>
              )}
              <button type="button" className="button ghost small" disabled={busy !== null} onClick={() => setRejecting(true)}>Reject draft</button>
            </div>
          )}
        </div>
      ) : writing ? (
        <EditableDraft label="Progress summary" text="" startText={startText} canEdit ai={ai()} editing onEditingChange={setWriting} maxLength={2000}
          reason={approved ? { label: "Reason for revision", hint: "The approved summary stays in place until this revision is signed." } : null}
          onSave={async (text, extra) => {
            await draftWoundSummary(wound.patient_id, wound.wound_id, { mode: "manual", text, revision_reason: extra.reason || undefined,
              ai_revision_ids: extra.aiRevisionIds });
            await onChanged();
          }} />
      ) : summary.latest_verified ? (
        askReason ? (
          <div className="inline-form">
            <div className="field">
              <label htmlFor={`summary-reason-${wound.wound_id}`} className="is-required">Reason for revision</label>
              <input id={`summary-reason-${wound.wound_id}`} value={reason} maxLength={500} autoComplete="off" onChange={(e) => setReason(e.target.value)} />
              <span className="field-hint">The approved summary stays in place until the new draft is signed.</span>
            </div>
            <div className="button-row compact">
              <button type="button" className="button secondary small" disabled={busy !== null || !reason.trim()} onClick={() => void aiDraft()}>
                <Sparkles aria-hidden="true" /> Draft with AI
              </button>
              <button type="button" className="button ghost small" onClick={() => setAskReason(false)}>Cancel</button>
            </div>
          </div>
        ) : (
          <div className="button-row compact">
            <button type="button" className="button secondary small" disabled={busy !== null} onClick={() => (approved ? setAskReason(true) : void aiDraft())}>
              <Sparkles aria-hidden="true" /> Draft with AI
            </button>
            <button type="button" className="button ghost small" disabled={busy !== null} onClick={() => setWriting(true)}>
              {approved ? "Revise summary" : "Write summary"}
            </button>
          </div>
        )
      ) : null}
      {versions.length > 0 && (
        <details className="ai-details summary-history">
          <summary>Summary history ({versions.length})</summary>
          <ol className="summary-list">
            {versions.map((v) => (
              <li key={v.report_id} className="summary-item">
                <span className="summary-meta">
                  Version {v.version_number} · {VERSION_STATUS[v.status ?? ""] ?? humanize(v.status)}
                  {v.source === "ai_draft" ? " · AI-generated" : v.source === "record" ? " · from the record" : v.ai_assisted ? " · edited with AI suggestions" : " · written by clinician"}
                  {" · "}{v.created_by?.name}, {formatDateTime(v.created_at_utc)}
                  {v.signed_at_utc ? ` · signed by ${v.signed_by_name} (${roleLabel(v.signed_by_role ?? "")}) ${formatDateTime(v.signed_at_utc)}` : ""}
                  {v.superseded_by ? " · superseded by a later signed version" : ""}
                  {v.revision_reason ? ` · reason: ${v.revision_reason}` : ""}
                  {v.rejection_reason ? ` · rejected: ${v.rejection_reason}` : ""}
                </span>
                <ClampedText text={v.text} lines={2} />
              </li>
            ))}
          </ol>
        </details>
      )}
    </div>
  );
}

/**
 * One wound's care summary: what care is planned now, how the wound is progressing, documented
 * concerns and the next action. Built on the server from this viewer's own view of the record;
 * verified facts, reported concerns and AI drafts are labelled apart.
 */
export function WoundCareSummary({ wound, account, portal, onChanged, onOpenCarePlan, actions, subtitle, eyebrow }: {
  wound: WoundDetail; account: Account; portal: Portal; onChanged: () => Promise<unknown>; onOpenCarePlan?: () => void;
  /** The wound's own actions (New measure, View history), shown in its header. */
  actions?: React.ReactNode;
  /** Type, status and patient, under the wound's name. */
  subtitle?: string;
  /** A short label above the wound's name (Currently viewing). */
  eyebrow?: React.ReactNode;
}) {
  const summary = wound.care_summary;
  if (!summary) return null;
  const clinical = portal === "clinical";
  const latest = summary.latest_verified;
  const narrative = summary.progress.narrative;
  const [primary, ...more] = summary.next_actions;
  const details = summary.measurement_details;
  const headingId = `care-summary-${wound.wound_id}`;

  return (
    <article className="care-summary" aria-labelledby={headingId}>
      <header className="care-summary-head">
        <div>
          {eyebrow}
          <h2 id={headingId} className="care-summary-title">{woundSiteLabel(wound)} <span className="wound-code">{wound.wound_code}</span></h2>
          {subtitle && <p className="care-summary-sub">{subtitle}</p>}
        </div>
        <div className="care-summary-head-end">
          <Badge tone={summary.review_state.tone}>{summary.review_state.label}</Badge>
          {actions}
        </div>
      </header>

      <h3 className="care-summary-kicker">Wound care summary</h3>

      <dl className="care-summary-facts">
        <div>
          <dt>Latest verified area</dt>
          <dd>{latest ? <><strong>{formatCm(latest.area_cm2)} cm²</strong> <span className="summary-meta">{latest.region ? regionLabel(latest.region) : "Region not recorded"}</span></> : "None yet"}</dd>
          {latest && <dd className="summary-meta">{formatDate(latest.date_utc)}</dd>}
        </div>
        <div>
          <dt>Clinician-assessed trend</dt>
          <dd>{summary.trend ? <strong>{humanize(summary.trend.value)}</strong> : "Not recorded"}</dd>
          {summary.trend?.assessed_by_name && <dd className="summary-meta">{summary.trend.assessed_by_name}</dd>}
        </div>
        <div>
          <dt>Latest approved assessment</dt>
          <dd>{summary.latest_assessment_at_utc ? formatDate(summary.latest_assessment_at_utc) : "None yet"}</dd>
        </div>
      </dl>

      <div className="care-summary-grid">
        <Section title="Care now">
          <CareNow summary={summary} wound={wound} account={account} portal={portal} onChanged={onChanged} onOpenCarePlan={onOpenCarePlan} />
        </Section>

        <Section title="Progress">
          <p className="summary-label"><Badge tone="success">Verified</Badge> <span className="summary-meta">Approved measurements and signed assessments</span></p>
          <p className="summary-facts-text">{progressSentences(summary).join(" ")}</p>
          {narrative && (
            <div className="summary-approved">
              <p className="summary-label">
                <Badge tone={narrative.current ? "success" : "neutral"}>{narrative.current ? "Approved summary" : "Earlier approved summary"}</Badge>
                <span className="summary-meta">
                  {narrative.signed_by_name} ({roleLabel(narrative.signed_by_role ?? "")}) · {formatDate(narrative.signed_at_utc)}
                  {!narrative.current ? " · written before the latest verified visit" : ""}
                </span>
              </p>
              <ClampedText text={narrative.text} lines={3} />
            </div>
          )}
          {clinical && <ProgressNarrative summary={summary} wound={wound} account={account} onChanged={onChanged} />}
        </Section>

        <Section title="Issues">
          {summary.issues.length ? (
            <ShowMore items={summary.issues} first={3} label="issues" render={(issue, i) => <IssueItem key={`${issue.kind}-${i}`} issue={issue} />} />
          ) : <p className="muted-text">No documented concerns.</p>}
        </Section>

        <Section title="Next action">
          {primary ? (
            <ShowMore items={[primary, ...more]} first={1} label="actions" render={(action, i) => <ActionItem key={`${action.kind}-${i}`} action={action} primary={i === 0} />} />
          ) : <p className="muted-text">Not scheduled.</p>}
        </Section>
      </div>

      <details className="ai-details care-summary-details">
        <summary>Measurement details</summary>
        {latest ? (
          <dl className="fact-grid">
            <div><dt>Region</dt><dd>{regionLabel(latest.region)}</dd></div>
            <div><dt>Length × width</dt><dd>{formatCm(latest.length_cm)} × {formatCm(latest.width_cm)} cm</dd></div>
            <div><dt>Perimeter</dt><dd>{latest.perimeter_cm != null ? `${formatCm(latest.perimeter_cm)} cm` : "—"}</dd></div>
            <div><dt>Boundary</dt><dd>{modelLabel(latest.source_model)}{latest.boundary_edited_by_clinician ? " · edited by clinician" : ""}</dd></div>
            <div><dt>Verified by</dt><dd>{latest.verified_by?.name ?? "—"}</dd></div>
            <div><dt>Approved measures</dt><dd>{details.approved_visit_count}{summary.progress.previous_same_region ? ` · compared with ${formatDate(summary.progress.previous_same_region.date_utc)}` : ""}</dd></div>
            {details.excluded_other_region > 0 && <div><dt>Other region</dt><dd>{details.excluded_other_region} not compared</dd></div>}
            {details.unrecorded_region > 0 && <div><dt>Region not recorded</dt><dd>{details.unrecorded_region} earlier, not compared</dd></div>}
            {details.image_integrity_verified === false && <div><dt>Image integrity</dt><dd className="danger-text">Check failed</dd></div>}
          </dl>
        ) : <p className="muted-text">Nothing to describe until a measurement is verified.</p>}
        {details.notice && <p className="fine-print">{details.notice}</p>}
      </details>
    </article>
  );
}
