"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { clearPendingSubmission, pendingSubmission, submissionStatus } from "@/lib/care-api";
import type { SubmissionOutcome } from "@/lib/care-api";
import type { ObservationRecord } from "@/lib/care-types";
import { Notice } from "@/components/ui/Feedback";

/** One status lookup on load/return, then explicit checks; no automatic upload loop. */
export function SubmissionRecovery({ patientId, woundId, busy, onRecovered }: {
  patientId: string; woundId: string; busy: boolean; onRecovered: (observation: ObservationRecord) => void;
}) {
  const callback = useRef(onRecovered);
  callback.current = onRecovered;
  const [message, setMessage] = useState<string | null>(null);
  const [status, setStatus] = useState<SubmissionOutcome["status"] | null>(null);
  const [checking, setChecking] = useState(false);
  const check = useCallback(async () => {
    const pending = pendingSubmission(patientId, woundId);
    if (!pending) { setMessage(null); setStatus(null); return; }
    setChecking(true);
    try {
      const result = await submissionStatus(patientId, woundId, pending.id);
      setStatus(result.status);
      if (result.status === "SUCCEEDED" && result.observation) {
        clearPendingSubmission(patientId, woundId);
        setMessage(null);
        callback.current(result.observation);
      } else {
        setMessage(result.status === "PROCESSING"
          ? "Your earlier submission is still processing. Check again before sending another photo."
          : result.status === "FAILED"
            ? result.error_code === "SUBMISSION_INTERRUPTED"
              ? "The earlier submission was interrupted before it was saved. You can retry with the same photo and report."
              : "The earlier submission was not saved. You can retry with the same photo and report."
            : "The server has no record of the earlier submission. You can retry the same photo and report.");
      }
    } catch {
      setStatus(null);
      setMessage("The outcome is still unknown. Reconnect and check again before sending another photo.");
    } finally { setChecking(false); }
  }, [patientId, woundId]);
  useEffect(() => { if (!busy) void check(); }, [busy, check]);
  if (!message) return null;
  // Only offered once the server confirms nothing is saved or running for this request.
  const canDiscard = status === "NOT_FOUND" || status === "FAILED";
  return <Notice tone="warning" title="Check your previous submission">
    <p>{message}</p>
    {status === "NOT_FOUND" && (
      <p>If you start a new update instead and the earlier upload still arrives, it will appear as a separate update.</p>
    )}
    <div className="button-row">
      <button type="button" className="button secondary" disabled={busy || checking} onClick={() => void check()}>
        {checking ? "Checking…" : "Check submission status"}
      </button>
      {canDiscard && (
        <button type="button" className="button secondary" disabled={busy || checking}
          onClick={() => { clearPendingSubmission(patientId, woundId); setMessage(null); setStatus(null); }}>
          Start a new update instead
        </button>
      )}
    </div>
  </Notice>;
}
