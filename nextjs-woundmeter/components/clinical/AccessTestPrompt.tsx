"use client";

import { useState } from "react";
import { Lock } from "lucide-react";

import { Notice } from "@/components/ui/Feedback";
import { DEMO_SAMPLE_DATA } from "@/lib/accounts";
import { CareApiError, getPatientRecord } from "@/lib/care-api";

/**
 * Demo-only: ask the server for the fictional patient P001 directly, to show that
 * access is refused server-side (not merely hidden in the interface).
 */
export function AccessTestPrompt() {
  const [result, setResult] = useState<{ tone: "danger" | "success"; text: string; code?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  if (!DEMO_SAMPLE_DATA) return null;

  return (
    <div className="access-test">
      <button
        type="button"
        className="button secondary"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            await getPatientRecord("P001");
            setResult({ tone: "success", text: "The server returned P001 — this account has access." });
          } catch (err) {
            const e = err instanceof CareApiError ? err : null;
            setResult({ tone: "danger", text: e?.message ?? "Request failed.", code: e?.code });
          } finally {
            setBusy(false);
          }
        }}
      >
        <Lock aria-hidden="true" />
        Try opening demo patient P001
      </button>
      {result && (
        <Notice tone={result.tone} title={result.tone === "danger" ? "Access refused by the server" : "Access allowed"}>
          {result.text}
          {result.code && <span className="mono-note"> ({result.code})</span>}
        </Notice>
      )}
    </div>
  );
}
