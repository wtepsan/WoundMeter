"use client";

import { useId, useState } from "react";
import { UserPlus, UserX } from "lucide-react";

import { Badge, Notice } from "@/components/ui/Feedback";
import { InlineConfirm } from "@/components/ui/InlineConfirm";
import { personName, roleLabel } from "@/lib/accounts";
import { grantCaregiverAccess, revokeGrant } from "@/lib/care-api";
import { formatDate, humanize, parsePermissions, permissionLabel } from "@/lib/care-format";
import type { PatientCompleteRecord } from "@/lib/care-types";

/**
 * Care team membership and caregiver access grants. The server decides who may
 * grant or revoke; the controls are offered to clinicians and the patient.
 */
export function SharingPanel({
  record,
  onChanged,
}: {
  record: PatientCompleteRecord;
  onChanged: () => Promise<unknown>;
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
  const [grantee, setGrantee] = useState("");
  const granteeId = useId();
  const canManage = record.viewer.is_clinical || record.access.relation === "OWN_RECORD";

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

      <section className="subsection" aria-labelledby={`${granteeId}-team`}>
        <h3 id={`${granteeId}-team`}>Care team</h3>
        <ul className="plain-list">
          {record.care_team.map((m) => (
            <li key={m.user_subject} className="list-row">
              <span>
                <strong>{personName(m.user_subject)}</strong>
                <span className="cell-sub">{m.relationship_label}</span>
              </span>
              <span className="muted-text">{roleLabel(m.team_role)}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="subsection" aria-labelledby={`${granteeId}-access`}>
        <h3 id={`${granteeId}-access`}>Family & caregiver access</h3>
        {record.access_grants.length === 0 ? (
          <p className="muted-text">No one outside the care team can see this record.</p>
        ) : (
          <ul className="plain-list">
            {record.access_grants.map((g) => {
              const active = g.status === "ACTIVE";
              return (
                <li key={g.grant_id} className="grant-row">
                  <div className="grant-main">
                    <span>
                      <strong>{personName(g.grantee_subject)}</strong>
                      <span className="cell-sub">{roleLabel(g.granted_role)}</span>
                    </span>
                    <Badge tone={active ? "success" : "neutral"}>{active ? "Active" : humanize(g.status)}</Badge>
                  </div>
                  <p className="muted-text">
                    Can: {parsePermissions(g.permissions_json).map(permissionLabel).join(", ") || "—"}
                    {active && g.expires_at_utc && ` · until ${formatDate(g.expires_at_utc)}`}
                    {!active && g.revoked_at_utc && ` · revoked ${formatDate(g.revoked_at_utc)}`}
                  </p>
                  {active && canManage && (
                    <InlineConfirm
                      trigger={
                        <>
                          <UserX aria-hidden="true" /> Revoke access
                        </>
                      }
                      triggerClassName="button ghost small danger-text"
                      title={`Revoke ${personName(g.grantee_subject)}'s access?`}
                      description="They will immediately lose access to this record and its photos, including links already shared."
                      confirmLabel="Revoke access"
                      reasonLabel="Reason (recorded in the audit log)"
                      defaultReason="Access no longer required."
                      busy={busy}
                      onConfirm={(reason) =>
                        run(() => revokeGrant(g.grant_id, reason), `Access for ${personName(g.grantee_subject)} was revoked.`)
                      }
                    />
                  )}
                </li>
              );
            })}
          </ul>
        )}

        {canManage && (
          <div className="inline-form">
            <div className="field">
              <label htmlFor={granteeId}>Give a family caregiver access</label>
              <input
                id={granteeId}
                value={grantee}
                onChange={(e) => setGrantee(e.target.value)}
                placeholder="Caregiver account ID"
                autoComplete="off"
              />
              <span className="field-hint">
                They will see approved progress and the care plan, and can submit photos for review.
              </span>
            </div>
            <button
              type="button"
              className="button secondary"
              disabled={busy || !grantee.trim()}
              onClick={() =>
                run(() => grantCaregiverAccess(record.patient.patient_id, grantee.trim()), `Access given to ${personName(grantee.trim())}.`)
              }
            >
              <UserPlus aria-hidden="true" /> Give access
            </button>
          </div>
        )}
        <details className="fine-details">
          <summary>Legal basis for sharing</summary>
          <p className="fine-print">
            {record.access_grants[0]?.legal_basis_note ??
              "Sharing is recorded as the patient's or representative's authorisation for home monitoring."}
          </p>
        </details>
      </section>
    </div>
  );
}
