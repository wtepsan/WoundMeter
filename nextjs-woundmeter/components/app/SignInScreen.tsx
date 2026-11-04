"use client";

import Link from "next/link";
import { useEffect, useId, useState } from "react";
import { BookOpen, ChevronRight, FlaskConical, ShieldCheck } from "lucide-react";

import { BrandMark } from "@/components/app/BrandMark";
import { SamplePhotos } from "@/components/demo/SamplePhotos";
import { ConnectionStatus } from "@/components/pwa/ConnectionStatus";
import { Notice } from "@/components/ui/Feedback";
import { Disclosure } from "@/components/ui/Layout";
import type { MfaEnrollment } from "@/hooks/useAppSession";
import { DEMO_ACCOUNTS, DEMO_MODE, roleLabel } from "@/lib/accounts";
import { auth, CareApiError } from "@/lib/care-api";

type DemoOption = { username: string; display_name: string; role: string; summary: string };

function DemoAccounts({ accounts, busy, onUse }: { accounts: DemoOption[]; busy: boolean; onUse: (username: string) => void }) {
  return (
    <section className="demo-accounts" aria-labelledby="demo-accounts-title">
      <h2 id="demo-accounts-title" className="section-title">
        Demo accounts — one-click sign-in
      </h2>
      <p className="field-hint">
        Demo mode only. Choose a role to sign in without a password. The server still issues a normal session and enforces
        every role permission and patient-access rule. The live demo includes one fictional patient, Malee Sukjai (P-DEMO-HEAL),
        shared with every demo role, showing a wound healing over three visits.
      </p>
      <div className="demo-links">
        <Link href="/instruction" className="button secondary small"><BookOpen aria-hidden="true" /> Photo guide</Link>
        <Link href="/demo" className="button secondary small"><FlaskConical aria-hidden="true" /> Try the demo (no sign-in)</Link>
      </div>
      <ul className="account-list">
        {accounts.map((a) => {
          const name = DEMO_ACCOUNTS.find((d) => d.username === a.username)?.name ?? a.display_name;
          return (
            <li key={a.username}>
              <button
                type="button"
                className="account-option"
                disabled={busy}
                onClick={() => onUse(a.username)}
                aria-label={`Sign in as demo ${roleLabel(a.role)} ${name}`}
              >
                <span className="account-avatar" aria-hidden="true">
                  {name.charAt(0)}
                </span>
                <span className="account-text">
                  <span className="account-name">
                    {roleLabel(a.role)} <span className="account-role">· {name} (demo)</span>
                  </span>
                  <span className="account-summary">{a.summary}</span>
                  <span className="account-summary mono">{a.username}</span>
                </span>
                <ChevronRight aria-hidden="true" />
              </button>
            </li>
          );
        })}
      </ul>
      <h3 className="section-title">Sample photos to test</h3>
      <p className="field-hint">
        Ruler photos of one wound over time: A (open), B (small) and C (healed: &ldquo;No visible wound detected&rdquo;). Download one and
        upload it with New measure, or use it straight from the demo page.
      </p>
      <SamplePhotos />
    </section>
  );
}

function MfaStep({
  enrollment,
  busy,
  error,
  onVerify,
  onCancel,
}: {
  enrollment: MfaEnrollment;
  busy: boolean;
  error: string | null;
  onVerify: (code: string) => void;
  onCancel: () => void;
}) {
  const [code, setCode] = useState("");
  const id = useId();
  return (
    <form
      className="stack"
      onSubmit={(e) => {
        e.preventDefault();
        onVerify(code.trim());
      }}
    >
      <div className="mfa-head">
        <ShieldCheck aria-hidden="true" />
        <div>
          <h1>Verify it&apos;s you</h1>
          <p className="signin-lead">Enter the 6-digit code from your authenticator app.</p>
        </div>
      </div>
      {enrollment && (
        <Notice tone="info" title="Set up your authenticator">
          Add this key to an authenticator app (time-based, 6 digits), then enter the code it shows.
          <span className="mono enroll-key">{enrollment.secret}</span>
        </Notice>
      )}
      {error && <Notice tone="danger">{error}</Notice>}
      <div className="field">
        <label htmlFor={id}>Authentication code</label>
        <input
          id={id}
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9]{6}"
          required
          autoFocus
        />
      </div>
      <button type="submit" className="button primary" disabled={busy || code.length !== 6}>
        {busy ? "Verifying…" : "Verify and sign in"}
      </button>
      <div className="button-row">
        <button type="button" className="link-button" onClick={onCancel}>
          Use a different account
        </button>
      </div>
    </form>
  );
}

export function SignInScreen({
  stage,
  enrollment,
  busy,
  error,
  notice,
  onSignIn,
  onDemoSignIn,
  onVerifyMfa,
  onCancelMfa,
}: {
  stage: "credentials" | "mfa";
  enrollment: MfaEnrollment;
  busy: boolean;
  error: string | null;
  notice?: string;
  onSignIn: (username: string, password: string) => void;
  onDemoSignIn: (username: string) => void;
  onVerifyMfa: (code: string) => void;
  onCancelMfa: () => void;
}) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [forgot, setForgot] = useState(false);
  const [forgotMessage, setForgotMessage] = useState<string | null>(null);
  const [demoAccounts, setDemoAccounts] = useState<DemoOption[]>([]);
  const userId = useId();
  const passId = useId();

  useEffect(() => {
    if (!DEMO_MODE) return;
    // Shown only if the server confirms demo mode is on.
    auth
      .demoAccounts()
      .then((d) => setDemoAccounts(d.demo_mode ? d.accounts : []))
      .catch(() => setDemoAccounts([]));
  }, []);

  return (
    <main className="signin" id="main">
      <div className="signin-layout">
        <div className="signin-card">
          <BrandMark tagline />
          <ConnectionStatus />
          {stage === "mfa" ? (
            <MfaStep enrollment={enrollment} busy={busy} error={error} onVerify={onVerifyMfa} onCancel={onCancelMfa} />
          ) : forgot ? (
            <form
              className="stack"
              onSubmit={async (e) => {
                e.preventDefault();
                const recorded = "Your request was recorded. Contact your administrator.";
                try {
                  setForgotMessage((await auth.forgotPassword(username)).message ?? recorded);
                } catch (err) {
                  // A request that never reached the server must not read as recorded.
                  setForgotMessage(err instanceof CareApiError && err.status === 0 ? err.message : recorded);
                }
              }}
            >
              <h1>Reset your password</h1>
              <p className="signin-lead">
                Passwords are reset by your administrator. Enter your username and we&apos;ll let them know.
              </p>
              <div className="field">
                <label htmlFor={userId}>Username or email</label>
                <input id={userId} value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" required />
              </div>
              {forgotMessage && <Notice tone="info">{forgotMessage}</Notice>}
              <button type="submit" className="button primary">
                Request reset
              </button>
              <button type="button" className="link-button" onClick={() => setForgot(false)}>
                Back to sign in
              </button>
            </form>
          ) : (
            <form
              className="stack"
              onSubmit={(e) => {
                e.preventDefault();
                onSignIn(username.trim(), password);
              }}
            >
              <h1>Sign in</h1>
              {notice && <Notice tone="info">{notice}</Notice>}
              {error && (
                <Notice tone="danger" title="Couldn't sign in">
                  {error}
                </Notice>
              )}
              <div className="field">
                <label htmlFor={userId}>Username or email</label>
                <input
                  id={userId}
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  autoComplete="username"
                  autoCapitalize="none"
                  spellCheck={false}
                  required
                />
              </div>
              <div className="field">
                <label htmlFor={passId}>Password</label>
                <input
                  id={passId}
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="current-password"
                  required
                />
              </div>
              <button type="submit" className="button primary" disabled={busy || !username || !password}>
                {busy ? "Signing in…" : "Sign in"}
              </button>
              <button type="button" className="link-button" onClick={() => setForgot(true)}>
                Forgot password?
              </button>
            </form>
          )}
        </div>

        {DEMO_MODE && demoAccounts.length > 0 && stage === "credentials" && !forgot && (
          <div className="signin-card">
            <DemoAccounts accounts={demoAccounts} busy={busy} onUse={onDemoSignIn} />
          </div>
        )}
      </div>
      <p className="footer-note">
        WoundMeter research prototype — not for independent clinical decisions.
      </p>
    </main>
  );
}
