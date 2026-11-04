"use client";

import { useEffect, useId, useState } from "react";

import { Loading, Notice } from "@/components/ui/Feedback";
import { PageHeader } from "@/components/ui/Layout";
import { admin, type AdminUser, type AssignablePatient, type CareTeamMember, type Organisation } from "@/lib/admin-api";
import { MEDICAL_ROLES, roleLabel } from "@/lib/accounts";
import { humanize } from "@/lib/care-format";

export function OrganisationsPage() {
  const [orgs, setOrgs] = useState<Organisation[] | null>(null);
  const [patients, setPatients] = useState<AssignablePatient[]>([]);
  const [staff, setStaff] = useState<AdminUser[]>([]);
  const [patientId, setPatientId] = useState("");
  const [team, setTeam] = useState<CareTeamMember[] | null>(null);
  const [member, setMember] = useState("");
  const [label, setLabel] = useState("Care team member");
  const [message, setMessage] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
  const ids = { patient: useId(), member: useId(), label: useId() };

  useEffect(() => {
    Promise.all([admin.organisations(), admin.patients(), admin.users()])
      .then(([o, p, u]) => {
        setOrgs(o);
        setPatients(p);
        setStaff(u.filter((x) => MEDICAL_ROLES.has(x.role) && x.active));
      })
      .catch((err) => setMessage({ tone: "danger", text: err instanceof Error ? err.message : "Couldn't load." }));
  }, []);

  useEffect(() => {
    setTeam(null);
    if (patientId) void admin.careTeam(patientId).then(setTeam);
  }, [patientId]);

  const act = async (fn: () => Promise<CareTeamMember[]>, text: string) => {
    setMessage(null);
    try {
      setTeam(await fn());
      setMessage({ tone: "success", text });
    } catch (err) {
      setMessage({ tone: "danger", text: err instanceof Error ? err.message : "Change refused." });
    }
  };

  return (
    <div className="page">
      <PageHeader title="Organisations & assignments" subtitle="Care organisations, and which medical staff are on each patient's care team." />
      {message && <Notice tone={message.tone}>{message.text}</Notice>}
      {!orgs ? (
        <Loading />
      ) : (
        <>
          <section className="panel" aria-labelledby="orgs-title">
            <h2 id="orgs-title" className="section-title">
              Organisations
            </h2>
            <ul className="plain-list">
              {orgs.map((o) => (
                <li key={o.org_id} className="list-row">
                  <span>
                    <strong>{o.name}</strong>
                    <span className="cell-sub">{humanize(o.org_type)}</span>
                  </span>
                  <span className="muted-text">{o.member_count} active accounts</span>
                </li>
              ))}
            </ul>
            <p className="fine-print">Move a person between organisations from Users & roles.</p>
          </section>

          <section className="panel" aria-labelledby="team-title">
            <h2 id="team-title" className="section-title">
              Care-team assignments
            </h2>
            <p className="muted-text">
              Only the patient reference and hospital number are shown here — administrators don&apos;t see clinical records.
            </p>
            <div className="field narrow">
              <label htmlFor={ids.patient}>Patient</label>
              <select id={ids.patient} value={patientId} onChange={(e) => setPatientId(e.target.value)}>
                <option value="">Select…</option>
                {patients.map((p) => (
                  <option key={p.patient_id} value={p.patient_id}>
                    {p.patient_code} · {p.hospital_number ?? "no HN"} · {p.org_name}
                  </option>
                ))}
              </select>
            </div>
            {patientId && !team && <Loading />}
            {team && (
              <>
                <ul className="plain-list">
                  {team.map((m) => (
                    <li key={m.user_subject} className="list-row">
                      <span>
                        <strong>{m.display_name}</strong>
                        <span className="cell-sub">
                          {roleLabel(m.role)} · {m.relationship_label}
                        </span>
                      </span>
                      <button
                        type="button"
                        className="button ghost small danger-text"
                        onClick={() => act(() => admin.unassign(patientId, m.user_subject), `${m.display_name} removed from the care team.`)}
                      >
                        Remove
                      </button>
                    </li>
                  ))}
                </ul>
                <div className="inline-form">
                  <div className="field">
                    <label htmlFor={ids.member}>Add medical staff</label>
                    <select id={ids.member} value={member} onChange={(e) => setMember(e.target.value)}>
                      <option value="">Select…</option>
                      {staff
                        .filter((s) => !team.some((m) => m.user_subject === s.subject))
                        .map((s) => (
                          <option key={s.subject} value={s.subject}>
                            {s.display_name} · {roleLabel(s.role)} · {s.org_name}
                          </option>
                        ))}
                    </select>
                  </div>
                  <div className="field">
                    <label htmlFor={ids.label}>Relationship</label>
                    <input id={ids.label} value={label} onChange={(e) => setLabel(e.target.value)} />
                  </div>
                  <button
                    type="button"
                    className="button secondary"
                    disabled={!member}
                    onClick={() => act(() => admin.assign(patientId, member, label), "Care team updated.")}
                  >
                    Assign
                  </button>
                </div>
                <p className="fine-print">Family caregivers get access through the patient&apos;s sharing settings, not the care team.</p>
              </>
            )}
          </section>
        </>
      )}
    </div>
  );
}
