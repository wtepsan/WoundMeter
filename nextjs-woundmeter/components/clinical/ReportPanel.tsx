"use client";

import { useCallback, useEffect, useState } from "react";
import { FileText } from "lucide-react";

import { DraftTextEditor } from "@/components/ai/DraftTextEditor";
import { Badge, Loading, Notice } from "@/components/ui/Feedback";
import { RecordActions } from "@/components/clinical/RecordActions";
import { useCareData } from "@/components/app/CareDataProvider";
import { can, isWardNurse, personName, roleLabel, type Account } from "@/lib/accounts";
import { CareApiError, draftReport, listReports, reviewReport } from "@/lib/care-api";
import { formatDateTime, type Tone } from "@/lib/care-format";
import type { ClinicalReport, WoundDetail } from "@/lib/care-types";

const ORDER = ["reference", "visit", "measurements", "appearance", "classification", "longitudinal", "risk", "care",
  "uncertain", "summary", "_generator_note", "status"];
const SOURCE: Record<string, { label: string; tone: Tone }> = {
  record: { label: "From the record", tone: "neutral" },
  calculation: { label: "Server calculation", tone: "info" },
  ai_draft: { label: "AI draft", tone: "warning" },
  clinician_edited: { label: "Edited by clinician", tone: "success" },
  deterministic_fallback: { label: "Not drafted", tone: "neutral" },
  system: { label: "System", tone: "neutral" },
};
const STATUS: Record<ClinicalReport["status"], { label: string; tone: Tone }> = {
  AI_DRAFT: { label: "AI draft · not reviewed", tone: "warning" },
  CLINICIAN_EDITED: { label: "Edited · not signed", tone: "info" },
  SIGNED: { label: "Signed", tone: "success" },
  REJECTED: { label: "Rejected", tone: "neutral" },
  SUPERSEDED: { label: "Superseded", tone: "neutral" },
};

/** AI-drafted wound report: clinician reviews, edits and signs. Signed versions never change. */
export function ReportPanel({ patientId, wound, account }: { patientId: string; wound: WoundDetail; account: Account }) {
  const { records, refreshPatient } = useCareData();
  const [reports, setReports] = useState<ClinicalReport[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [includeNursing, setIncludeNursing] = useState(false);
  const [editing, setEditing] = useState<Record<string, string> | null>(null);
  const [attested, setAttested] = useState(false);
  const [confirmFlagged, setConfirmFlagged] = useState(false);
  const [reason, setReason] = useState("");
  // Section key -> Ask AI suggestions applied in the open edit (saved with it for provenance).
  const [aiRevisions, setAiRevisions] = useState<Record<string, string[]>>({});

  const load = useCallback(async () => {
    try {
      setReports(await listReports(patientId));
    } catch (err) {
      setError(err instanceof CareApiError ? err.message : "Reports could not be loaded.");
    }
  }, [patientId]);
  useEffect(() => { void load(); }, [load]);

  async function run(label: string, action: () => Promise<unknown>) {
    setBusy(label);
    setError(null);
    try {
      await action();
      setEditing(null);
      setAiRevisions({});
      setAttested(false);
      setConfirmFlagged(false);
      setReason("");
      await load();
    } catch (err) {
      setError(err instanceof CareApiError ? err.message : "That didn't work. Try again.");
    } finally {
      setBusy(null);
    }
  }

  if (!reports) return <Loading label="Loading reports…" />;
  const mine = reports.filter((r) => r.wound_id === wound.wound_id);
  const current = mine.find((r) => r.status !== "SUPERSEDED") ?? null;
  const open = current && (current.status === "AI_DRAFT" || current.status === "CLINICIAN_EDITED");
  const flagged = current?.consistency && !current.consistency.ok;

  return (
    <div className="stack">
      <p className="fine-print">
        Measurements and changes come from the record and are calculated by the server. Muse Spark drafts only the
        narrative, citing record entries (V = visit, A = signed assessment, CR = caregiver report). A qualified clinician
        reviews, edits and signs; nothing is final until signed.
      </p>
      {error && <Notice tone="danger" title="Report">{error}</Notice>}
      {can(account, "ASSESS") && (
        <div className="button-row">
          {isWardNurse(account) && (
            <label className="checkbox-row">
              <input type="checkbox" checked={includeNursing} onChange={(e) => setIncludeNursing(e.target.checked)} />
              Include inpatient nursing (Braden) data — only ward nurses will be able to read the report
            </label>
          )}
          <button type="button" className="button secondary" disabled={busy !== null}
            onClick={() => void run("draft", () => draftReport(patientId, wound.wound_id, includeNursing))}>
            <FileText aria-hidden="true" className="inline-icon" /> Generate AI draft report
          </button>
        </div>
      )}
      {busy === "draft" && <Loading label="Drafting with Muse Spark (about 20–30 s)…" />}
      {!current && <p className="muted-text">No report for this wound yet.</p>}
      {current && current.content_withheld && (
        <Notice tone="info" title="Report withheld">{current.withheld_reason}</Notice>
      )}
      {current && current.sections && (
        <article className="ai-report" aria-label="Wound report">
          <RecordActions account={account} recordType="report" recordId={current.report_id}
            status={current.status} details={`${records[patientId]?.patient.display_name ?? patientId} · ${wound.wound_code} · report v${current.version_number} · ${formatDateTime(current.created_at_utc)}`}
            onDeleted={async () => { await load(); await refreshPatient(patientId); }} />
          <p>
            <Badge tone={STATUS[current.status].tone}>{STATUS[current.status].label}</Badge>{" "}
            <span className="fine-print">
              Version {current.version_number} · {current.generator} · drafted {formatDateTime(current.created_at_utc)} by{" "}
              {personName(current.created_by_subject)}
              {current.includes_nursing ? " · includes inpatient nursing data" : ""}
            </span>
          </p>
          {current.status === "SIGNED" && (
            <p className="fine-print">
              Signed by {current.signed_by_name} ({roleLabel(current.signed_by_role ?? "")}) on {formatDateTime(current.signed_at_utc)} ·
              content SHA-256 {current.content_sha256?.slice(0, 12)}…
            </p>
          )}
          {flagged && open && (
            <Notice tone="warning" title="Check flagged AI text before signing">
              {Object.entries(current.consistency!.unsupported_numbers).map(([key, values]) => (
                <div key={key}>{current.sections![key]?.title}: numbers not found in the record ({values.join(", ")}).</div>
              ))}
              {(current.consistency!.uncited_sections ?? []).map((key) => (
                <div key={key}>{current.sections![key]?.title}: AI text cites no record entry.</div>
              ))}
            </Notice>
          )}
          {ORDER.filter((key) => current.sections![key]).map((key) => {
            const section = current.sections![key];
            const source = SOURCE[section.source] ?? SOURCE.record;
            return (
              <section key={key}>
                <h4>
                  {section.title} <Badge tone={source.tone}>{source.label}</Badge>
                </h4>
                {editing && key !== "status" && key !== "_generator_note" ? (
                  <DraftTextEditor id={`report-${current.report_id}-${key}`} label={section.title} labelHidden
                    rows={Math.min(8, Math.max(2, section.text.split("\n").length + 1))} value={editing[key] ?? section.text}
                    onChange={(value) => setEditing({ ...editing, [key]: value })}
                    ai={key === "reference" ? null : { patientId, woundId: wound.wound_id, draftType: "report_section", targetId: current.report_id, field: key }}
                    onAiApplied={(id) => setAiRevisions((prev) => ({ ...prev, [key]: [...(prev[key] ?? []), id] }))} />
                ) : (
                  <p className="ai-section-text">{section.text}</p>
                )}
                {section.source_refs.length > 0 && <p className="fine-print">Sources: {section.source_refs.join(", ")}</p>}
              </section>
            );
          })}
          {open && can(account, "ASSESS") && (
            <div className="stack">
              {editing ? (
                <div className="button-row">
                  <button type="button" className="button" disabled={busy !== null}
                    onClick={() => {
                      const changed = Object.fromEntries(Object.entries(editing).filter(([k, v]) => v !== current.sections![k]?.text));
                      const used = Object.fromEntries(Object.entries(aiRevisions).filter(([k]) => k in changed));
                      void run("edit", () => reviewReport(current.report_id, { decision: "edit", sections: changed,
                        ai_revisions: Object.keys(used).length ? used : undefined }));
                    }}>
                    Save edits as a new version
                  </button>
                  <button type="button" className="button ghost" onClick={() => { setEditing(null); setAiRevisions({}); }}>Cancel</button>
                </div>
              ) : (
                <div className="button-row">
                  <button type="button" className="button secondary" disabled={busy !== null} onClick={() => setEditing({})}>
                    Edit report
                  </button>
                </div>
              )}
              {!editing && can(account, "SIGN_OFF") && (
                <>
                  <label className="checkbox-row">
                    <input type="checkbox" checked={attested} onChange={(e) => setAttested(e.target.checked)} />
                    I reviewed the whole report against the record and take responsibility for its content.
                  </label>
                  {flagged && (
                    <label className="checkbox-row">
                      <input type="checkbox" checked={confirmFlagged} onChange={(e) => setConfirmFlagged(e.target.checked)} />
                      I checked the flagged AI text and it is correct.
                    </label>
                  )}
                  <div className="button-row">
                    <button type="button" className="button" disabled={busy !== null || !attested || Boolean(flagged && !confirmFlagged)}
                      onClick={() => void run("sign", () => reviewReport(current.report_id,
                        { decision: "sign", attested, confirm_flagged_content: confirmFlagged }))}>
                      Sign report
                    </button>
                  </div>
                </>
              )}
              {!editing && !can(account, "SIGN_OFF") && (
                <p className="fine-print">Signing needs a qualified clinician with sign-off permission.</p>
              )}
              {!editing && (
                <div className="inline-form">
                  <div className="field">
                    <label htmlFor="report-reject">Reason to reject this draft</label>
                    <input id="report-reject" value={reason} onChange={(e) => setReason(e.target.value)} autoComplete="off" />
                  </div>
                  <button type="button" className="button ghost" disabled={busy !== null || !reason.trim()}
                    onClick={() => void run("reject", () => reviewReport(current.report_id, { decision: "reject", reason }))}>
                    Reject draft
                  </button>
                </div>
              )}
            </div>
          )}
        </article>
      )}
      {mine.length > 1 && (
        <p className="fine-print">
          Earlier versions: {mine.filter((r) => r !== current).map((r) => `v${r.version_number} ${STATUS[r.status].label.toLowerCase()}`).join(" · ")}
        </p>
      )}
    </div>
  );
}
