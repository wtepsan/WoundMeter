"use client";

import type { Navigate } from "@/components/app/AppShell";
import { Notice } from "@/components/ui/Feedback";
import { PageHeader } from "@/components/ui/Layout";
import { DEMO_ACCOUNTS, roleLabel, type Account } from "@/lib/accounts";

const GETTING_STARTED: Array<{ who: string; text: string }> = [
  { who: "Nurse or physician", text: "Patients → register a made-up patient, then add a wound." },
  { who: "Nurse or physician", text: "Open the wound → New measure → upload a photo with the ruler, then review and sign off." },
  { who: "Nurse or physician", text: "Care team & sharing → share the patient with Suda (caregiver.suda)." },
  { who: "Caregiver", text: "In a private window, sign in as Suda to see shared progress and send home updates." },
  { who: "Administrator", text: "Users → manage demo accounts, qualifications, permissions and care teams." },
];

export function DemoTools({ account }: { account: Account; navigate: Navigate }) {
  return (
    <div className="page">
      <PageHeader
        title="Demo mode"
        subtitle={`Signed in as a demo ${roleLabel(account.role).toLowerCase()}. The database starts empty; everything you create is stored. Permissions and patient access are enforced by the server as for real accounts.`}
      />
      <Notice tone="warning" title="Do not enter real patient data">
        Use only made-up names, dates and identifiers. Demo accounts sign in without a password.
      </Notice>

      <section className="panel" aria-labelledby="try-title">
        <h2 id="try-title" className="section-title">
          Try a measurement without saving
        </h2>
        <p className="muted-text">
          No sign-in needed: upload a test photo with the ruler and follow the whole pipeline, from calibration and AI segmentation to measurement and explanation. Nothing is saved.
        </p>
        <a className="button primary" href="/demo">Open /demo</a>
      </section>

      <section className="panel" aria-labelledby="journey-title">
        <h2 id="journey-title" className="section-title">
          Getting started
        </h2>
        <ol className="journey">
          {GETTING_STARTED.map((s, i) => (
            <li key={s.text}>
              <span className="journey-index" aria-hidden="true">
                {i + 1}
              </span>
              <span>
                <strong>{s.who}:</strong> {s.text}
              </span>
            </li>
          ))}
        </ol>
        <Notice tone="info">
          Your session is kept in a secure cookie shared by all tabs of this browser. To use two roles side by side, use a
          private window (or a second browser) for the second account.
        </Notice>
      </section>

      <section className="panel" aria-labelledby="accounts-title">
        <h2 id="accounts-title" className="section-title">
          Demo accounts
        </h2>
        <p className="muted-text">Sign out, then choose one of these on the sign-in screen.</p>
        <ul className="plain-list">
          {DEMO_ACCOUNTS.map((a) => (
            <li key={a.username} className="list-row">
              <span>
                <strong>{a.name}</strong>
                <span className="cell-sub">
                  {roleLabel(a.role)} · {a.summary}
                </span>
              </span>
              <span className="mono">{a.username}</span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
