"use client";

import { useId, useState } from "react";
import { LogOut } from "lucide-react";

import type { Navigate } from "@/components/app/AppShell";
import { InstallAppPanel } from "@/components/pwa/InstallAppPanel";
import { Badge, Notice } from "@/components/ui/Feedback";
import { PageHeader } from "@/components/ui/Layout";
import { roleLabel, type Account, type Portal } from "@/lib/accounts";
import { auth } from "@/lib/care-api";

function ChangePassword() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [message, setMessage] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const ids = { current: useId(), next: useId(), confirm: useId() };
  const mismatch = confirm.length > 0 && confirm !== next;
  return (
    <form
      className="stack"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setMessage(null);
        try {
          await auth.changePassword(current, next);
          setMessage({ tone: "success", text: "Password changed. Your other sessions were signed out." });
          setCurrent("");
          setNext("");
          setConfirm("");
        } catch (err) {
          setMessage({ tone: "danger", text: err instanceof Error ? err.message : "Couldn't change the password." });
        } finally {
          setBusy(false);
        }
      }}
    >
      <div className="form-grid">
        <div className="field">
          <label htmlFor={ids.current}>Current password</label>
          <input id={ids.current} type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" required />
        </div>
        <div className="field">
          <label htmlFor={ids.next}>New password</label>
          <input id={ids.next} type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" minLength={10} required />
          <span className="field-hint">At least 10 characters.</span>
        </div>
        <div className="field">
          <label htmlFor={ids.confirm}>Confirm new password</label>
          <input id={ids.confirm} type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" aria-invalid={mismatch || undefined} required />
          {mismatch && <span className="field-hint danger-text">Passwords don&apos;t match.</span>}
        </div>
      </div>
      {message && <Notice tone={message.tone}>{message.text}</Notice>}
      <div className="button-row">
        <button type="submit" className="button secondary" disabled={busy || next.length < 10 || mismatch || !current}>
          Change password
        </button>
      </div>
    </form>
  );
}

export function AccountPage({
  account,
  portal,
  navigate,
  onSignOut,
}: {
  account: Account;
  portal: Portal;
  navigate: Navigate;
  onSignOut: () => void;
}) {
  const medical = portal === "clinical";
  return (
    <div className="page">
      <PageHeader
        title="Account"
        subtitle={`${account.display_name} · ${roleLabel(account.role)} · ${account.org_name ?? account.org_id}`}
        actions={
          <button type="button" className="button secondary" onClick={onSignOut}>
            <LogOut aria-hidden="true" /> Sign out
          </button>
        }
      />

      <section className="panel" aria-labelledby="profile-title">
        <h2 id="profile-title" className="section-title">
          Profile
        </h2>
        <dl className="fact-list two-col">
          <div>
            <dt>Username</dt>
            <dd className="mono">{account.username}</dd>
          </div>
          <div>
            <dt>Organisation</dt>
            <dd>{account.org_name ?? account.org_id}</dd>
          </div>
          {medical && (
            <div>
              <dt>Professional qualification</dt>
              <dd>
                {account.qualification_title ?? "Not recorded"}{" "}
                <Badge tone={account.qualification_verified ? "success" : "warning"}>
                  {account.qualification_verified ? "Verified" : "Not verified"}
                </Badge>
              </dd>
            </div>
          )}
          <div>
            <dt>Multi-factor sign-in</dt>
            <dd>{account.mfa_verified ? "Used for this session" : account.mfa_enabled ? "Enabled" : "Not required for this account"}</dd>
          </div>
        </dl>
      </section>

      {medical && (
        <section className="panel" aria-labelledby="permissions-title">
          <h2 id="permissions-title" className="section-title">
            Clinical permissions
          </h2>
          <p className="muted-text">Set by your administrator after verifying your qualification.</p>
          <ul className="permission-list">
            {Object.keys(account.permission_policy?.permissions ?? {}).map((p) => {
              const granted = account.permissions.includes(p);
              return (
                <li key={p}>
                  <Badge tone={granted ? "success" : "neutral"}>{granted ? "Yes" : "No"}</Badge>
                  <span>
                    <strong>{account.permission_policy!.permissions[p].label}</strong>
                    <span className="cell-sub">{account.permission_policy!.permissions[p].detail}</span>
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <section className="panel" aria-labelledby="password-title">
        <h2 id="password-title" className="section-title">
          Password
        </h2>
        <ChangePassword />
      </section>

      <InstallAppPanel />
    </div>
  );
}
