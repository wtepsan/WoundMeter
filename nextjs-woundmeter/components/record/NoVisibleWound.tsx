"use client";

import { useState } from "react";
import { CircleSlash, PencilLine, RotateCcw } from "lucide-react";

import { Notice } from "@/components/ui/Feedback";
import { CareApiError, recordZeroArea } from "@/lib/care-api";
import { NO_VISIBLE_WOUND_TEXT, NO_VISIBLE_WOUND_TITLE } from "@/lib/care-format";
import type { ObservationRecord } from "@/lib/care-types";

// "Draw outline" opens the record page in boundary editing. Views are URLs, so the request is handed over in
// memory (single-page navigation) and used once.
let outlineRequest: string | null = null;
export function requestOutlineDrawing(observationId: string) {
  outlineRequest = observationId;
}
export function takeOutlineRequest(observationId: string): boolean {
  if (outlineRequest !== observationId) return false;
  outlineRequest = null;
  return true;
}

/**
 * The AI found no wound on a calibrated photo. The person can record 0 cm² (a proposal a clinician must verify),
 * a clinician can draw the outline of a wound the AI missed, or the photo can be retaken. Nothing is approved here.
 */
export function NoVisibleWound({ obs, canRecord, canDraw, onDone, onRetake }: {
  obs: ObservationRecord;
  canRecord: boolean;
  canDraw: boolean;
  onDone: (updated: ObservationRecord, intent: "record_zero" | "draw_outline") => void | Promise<void>;
  onRetake?: () => void;
}) {
  const [busy, setBusy] = useState<null | "record_zero" | "draw_outline">(null);
  const [error, setError] = useState<string | null>(null);
  const act = async (intent: "record_zero" | "draw_outline") => {
    setBusy(intent);
    setError(null);
    try {
      await onDone(await recordZeroArea(obs.observation_id, { intent }), intent);
    } catch (err) {
      setError(err instanceof CareApiError || err instanceof Error ? err.message : "That didn’t work. Try again.");
    } finally {
      setBusy(null);
    }
  };
  return (
    <Notice tone="warning" title={NO_VISIBLE_WOUND_TITLE}>
      <p>{NO_VISIBLE_WOUND_TEXT}</p>
      {canDraw && <p className="fine-print">If a wound is visible in the photo, draw its outline instead.</p>}
      {error && <p className="danger-text" role="alert">{error}</p>}
      <div className="button-row">
        {canRecord && (
          <button type="button" className="button primary small" disabled={busy !== null} onClick={() => void act("record_zero")}>
            <CircleSlash aria-hidden="true" /> {busy === "record_zero" ? "Recording…" : "Record 0 cm²"}
          </button>
        )}
        {canDraw && (
          <button type="button" className="button secondary small" disabled={busy !== null} onClick={() => void act("draw_outline")}>
            <PencilLine aria-hidden="true" /> {busy === "draw_outline" ? "Opening…" : "Draw outline"}
          </button>
        )}
        {onRetake && (
          <button type="button" className="button ghost small" disabled={busy !== null} onClick={onRetake}>
            <RotateCcw aria-hidden="true" /> Retake photo
          </button>
        )}
      </div>
    </Notice>
  );
}
