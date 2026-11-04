"use client";

import { useState } from "react";
import { Check, Flag } from "lucide-react";

import { CareInstructions } from "@/components/care/CareInstructions";
import { Badge, Notice } from "@/components/ui/Feedback";
import { personName } from "@/lib/accounts";
import { completeTask, issueCarePlan } from "@/lib/care-api";
import { formatDate, formatDateTime, humanize, woundSiteLabel } from "@/lib/care-format";
import type { CareTaskRecord, PatientCompleteRecord, WoundDetail } from "@/lib/care-types";

function TaskRow({
  task,
  canComplete,
  busy,
  onComplete,
}: {
  task: CareTaskRecord;
  canComplete: boolean;
  busy: boolean;
  onComplete: (status: "COMPLETED" | "CONCERN_REPORTED", notes: string) => Promise<void>;
}) {
  const [concernOpen, setConcernOpen] = useState(false);
  const [concern, setConcern] = useState("");
  const done = task.status === "COMPLETED";
  const flagged = task.status === "CONCERN_REPORTED";

  return (
    <li className="task-row">
      <div className="task-main">
        <span className="task-title">
          {task.title}
          <span className="cell-sub">
            {task.frequency} · due {formatDate(task.due_at_utc)}
          </span>
        </span>
        {done && <Badge tone="success">Done</Badge>}
        {flagged && <Badge tone="warning">Concern reported</Badge>}
      </div>
      <p className="task-text">{task.instructions}</p>
      {task.completed_at_utc && (
        <p className="muted-text">
          {done ? "Last done" : "Reported"} {formatDateTime(task.completed_at_utc)} by {personName(task.completed_by_subject)}
          {task.caregiver_notes && ` — “${task.caregiver_notes}”`}
        </p>
      )}
      {canComplete &&
        (concernOpen ? (
          <div className="inline-confirm">
            <label htmlFor={`concern-${task.task_id}`}>What did you notice?</label>
            <textarea id={`concern-${task.task_id}`} rows={2} value={concern} onChange={(e) => setConcern(e.target.value)} />
            <div className="button-row">
              <button
                type="button"
                className="button primary"
                disabled={busy || !concern.trim()}
                onClick={async () => {
                  await onComplete("CONCERN_REPORTED", concern.trim());
                  setConcernOpen(false);
                  setConcern("");
                }}
              >
                Send to care team
              </button>
              <button type="button" className="button ghost" onClick={() => setConcernOpen(false)}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="button-row">
            <button
              type="button"
              className="button secondary small"
              disabled={busy}
              onClick={() => void onComplete("COMPLETED", "Completed at home as instructed.")}
            >
              <Check aria-hidden="true" /> Mark done
            </button>
            <button type="button" className="button ghost small" disabled={busy} onClick={() => setConcernOpen(true)}>
              <Flag aria-hidden="true" /> Report a concern
            </button>
          </div>
        ))}
    </li>
  );
}

/** Approved care plan and tasks for one wound. Only clinicians can issue plans (server-enforced). */
export function CarePlanSection({
  record,
  wound,
  onChanged,
  mode,
  canIssue = false,
}: {
  record: PatientCompleteRecord;
  wound: WoundDetail;
  onChanged: () => Promise<unknown>;
  mode: "clinical" | "caregiver" | "patient";
  /** UI hint only; the server checks the care-plan permission. */
  canIssue?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
  const plan = wound.care_plans[0];
  const caregiver =
    record.access_grants.find((g) => g.status === "ACTIVE" && g.granted_role === "FAMILY_CAREGIVER")?.grantee_subject ??
    "";

  const run = async (action: () => Promise<unknown>, success: string) => {
    setBusy(true);
    setMessage(null);
    try {
      await action();
      setMessage({ tone: "success", text: success });
      await onChanged();
    } catch (err) {
      setMessage({ tone: "danger", text: err instanceof Error ? err.message : "Request failed." });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack">
      {message && <Notice tone={message.tone}>{message.text}</Notice>}
      {plan ? (
        <div className="care-plan">
          <div className="care-plan-head">
            <h3>{plan.title}</h3>
            <span className="muted-text">
              Version {plan.version_number} · {humanize(plan.status)} · review by {formatDate(plan.review_date)}
            </span>
          </div>
          <p className="muted-text">{plan.purpose}</p>
          <div className="instructions">
            <CareInstructions wound={wound} plan={plan} canManage={mode === "clinical" && canIssue} onChanged={onChanged} lines={20} />
          </div>
          <p className="muted-text">
            Set by {personName(plan.responsible_clinician_subject)} for {personName(plan.assigned_caregiver_subject)} ·{" "}
            {plan.task_frequency}
          </p>
          {mode !== "clinical" && (
            <p className="fine-print">Only the care team can change these instructions. Contact them if something isn&apos;t working.</p>
          )}
        </div>
      ) : (
        <p className="muted-text">No care plan has been issued for the {woundSiteLabel(wound).toLowerCase()} wound yet.</p>
      )}

      {wound.care_tasks.length > 0 && (
        <section className="subsection">
          <h3>Tasks</h3>
          <ul className="plain-list">
            {wound.care_tasks.map((t) => (
              <TaskRow
                key={t.task_id}
                task={t}
                canComplete={mode === "caregiver" && Boolean(wound.allowed_actions?.includes("COMPLETE_CARE_TASKS")) &&
                  wound.care_plans.some((p) => p.care_plan_id === t.care_plan_id && p.status === "ACTIVE" && p.assigned_caregiver_subject === record.viewer.subject)}
                busy={busy}
                onComplete={(status, notes) =>
                  run(
                    () => completeTask(t.task_id, status, notes),
                    status === "COMPLETED" ? `“${t.title}” marked as done.` : "Your concern was sent to the care team.",
                  )
                }
              />
            ))}
          </ul>
        </section>
      )}

      {mode === "clinical" && canIssue && !plan && !caregiver && <Notice tone="info">Grant a caregiver access before issuing a home care plan.</Notice>}
      {mode === "clinical" && canIssue && !plan && caregiver && (
        <div className="inline-form">
          <p className="muted-text">
            Issues the standard home plan (dressing, offloading and photo schedule) as version 1 to {personName(caregiver)}.
            You can then edit its instructions here or in the wound summary.
          </p>
          <button
            type="button"
            className="button secondary"
            disabled={busy}
            onClick={() =>
              run(() => issueCarePlan(record.patient.patient_id, wound.wound_id, caregiver), "Care plan issued.")
            }
          >
            Issue standard care plan
          </button>
        </div>
      )}
    </div>
  );
}
