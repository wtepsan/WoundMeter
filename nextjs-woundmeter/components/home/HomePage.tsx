"use client";

import { useEffect, useMemo, useState } from "react";
import { Building2, ChevronRight, ClipboardList, Plus, ScrollText, Search, UserCog } from "lucide-react";

import type { Navigate } from "@/components/app/AppShell";
import { useCareData, useReviewQueue } from "@/components/app/CareDataProvider";
import { Badge, EmptyState, Loading, Notice } from "@/components/ui/Feedback";
import { PrivateImage, pickDisplayImage } from "@/components/ui/PrivateImage";
import { admin, type AuditEvent } from "@/lib/admin-api";
import { accountName, can, personName, type Account, type Portal } from "@/lib/accounts";
import { formatDate, formatDateTime, humanize, locationLabel, patientName, recordStatus } from "@/lib/care-format";
import type { ObservationRecord, PatientCompleteRecord, WoundDetail } from "@/lib/care-types";

type Item = { record: PatientCompleteRecord; wound: WoundDetail; obs: ObservationRecord };
type Activity = { at: string; text: string; item: Item };

function greeting(): string {
  const hour = new Date().getHours();
  return hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
}

function allItems(records: Record<string, PatientCompleteRecord>): Item[] {
  return Object.values(records).flatMap((record) =>
    record.wounds.flatMap((wound) => wound.observations.map((obs) => ({ record, wound, obs }))));
}

function lastActivity(record: PatientCompleteRecord): string {
  const times = record.wounds.flatMap((w) => w.observations.flatMap((o) => [o.capture_datetime_utc, o.final_approval_timestamp_utc ?? ""]));
  return times.filter(Boolean).sort().at(-1) ?? "";
}

function RecordRow({ item, navigate, sub }: { item: Item; navigate: Navigate; sub: string }) {
  const status = recordStatus(item.obs);
  return (
    <li>
      <button type="button" className="home-row" onClick={() => navigate({ name: "review", patientId: item.record.patient.patient_id, observationId: item.obs.observation_id })}>
        <PrivateImage image={pickDisplayImage(item.obs.images)} alt="" className="home-thumb" />
        <span className="home-row-main">
          <span className="home-row-title"><span className="id-chip">{item.record.patient.patient_code}</span> {patientName(item.record.patient)} · {humanize(item.wound.anatomical_site)}</span>
          <span className="home-row-sub">{sub}</span>
        </span>
        <Badge tone={status.tone}>{status.label}</Badge>
        <ChevronRight aria-hidden="true" className="row-chevron" />
      </button>
    </li>
  );
}

/** Caregiver: each wound they may photograph, with its own New measure (patient and wound already known). */
function WoundsToUpdate({ records, navigate }: { records: Record<string, PatientCompleteRecord>; navigate: Navigate }) {
  const wounds = Object.values(records).flatMap((record) => record.wounds
    .filter((w) => w.status === "ACTIVE" && w.allowed_actions?.includes("UPLOAD_HOME_PHOTO"))
    .map((wound) => ({ record, wound })));
  if (wounds.length === 0) return null;
  return (
    <section className="home-card span-2" aria-labelledby="home-wounds-title">
      <div className="home-card-head"><h2 id="home-wounds-title" className="section-title">Wounds you can photograph</h2></div>
      <ul className="home-list" aria-label="Wounds you can photograph">
        {wounds.map(({ record, wound }) => {
          const last = wound.approved_timeline.at(-1);
          const pending = wound.observations.some((o) => o.review_state === "AWAITING_CLINICAL_REVIEW");
          return (
            <li key={wound.wound_id} className="home-wound-row">
              <button type="button" className="home-row" onClick={() => navigate({ name: "patient", patientId: record.patient.patient_id, woundId: wound.wound_id })}>
                <span className="home-row-main">
                  <span className="home-row-title"><span className="id-chip">{record.patient.patient_code}</span> {patientName(record.patient)} · {humanize(wound.anatomical_site)} <span className="wound-code">{wound.wound_code}</span></span>
                  <span className="home-row-sub">{last ? `Last verified ${formatDate(last.capture_datetime_utc)}` : "No verified measurement yet"}{pending ? " · update awaiting review" : ""}</span>
                </span>
              </button>
              <button type="button" className="button primary small" onClick={() => navigate({ name: "new-observation", patientId: record.patient.patient_id, woundId: wound.wound_id })}
                aria-label={`New measure: ${patientName(record.patient)}, ${humanize(wound.anatomical_site)} ${wound.wound_code}`}>
                <Plus aria-hidden="true" /> New measure
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function AdminHome({ account, navigate }: { account: Account; navigate: Navigate }) {
  const [events, setEvents] = useState<AuditEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    admin.audit({ limit: 6 }).then(setEvents).catch((err) => setError(err instanceof Error ? err.message : "Couldn't load recent events."));
  }, []);
  const links = [
    { view: { name: "users" } as const, label: "Users & roles", text: "Accounts, roles, qualifications and permissions", icon: UserCog },
    { view: { name: "organisations" } as const, label: "Organisations & access", text: "Care teams and patient assignments", icon: Building2 },
    { view: { name: "audit" } as const, label: "Security & audit", text: "Access log, storage and deleted records", icon: ScrollText },
  ];
  return (
    <div className="page page-wide">
      <header className="home-header">
        <div>
          <h1>{greeting()}, {accountName(account)}</h1>
          <p className="muted-text">Administration only. Clinical records and sign-off are not part of this account.</p>
        </div>
      </header>
      <div className="home-links">
        {links.map(({ view, label, text, icon: Icon }) => (
          <button key={label} type="button" className="home-link" onClick={() => navigate(view)}>
            <Icon aria-hidden="true" /><span><strong>{label}</strong><small>{text}</small></span><ChevronRight aria-hidden="true" className="row-chevron" />
          </button>
        ))}
      </div>
      <section className="home-card" aria-labelledby="admin-activity-title">
        <div className="home-card-head"><h2 id="admin-activity-title" className="section-title">Recent activity</h2>
          <button type="button" className="link-button" onClick={() => navigate({ name: "audit" })}>Open audit log</button></div>
        {error ? <Notice tone="danger">{error}</Notice> : events === null ? <Loading /> : events.length === 0 ? <p className="muted-text">No events yet.</p> : (
          <ul className="activity-list">
            {events.map((e) => (
              <li key={e.event_id}><span>{humanize(e.action)} · {personName(e.actor_subject)}</span>
                <span className="fine-print">{formatDateTime(e.timestamp_utc)}{e.outcome !== "SUCCESS" && e.outcome !== "ALLOWED" ? ` · ${humanize(e.outcome)}` : ""}</span></li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

/** Home: a dashboard of what needs attention. Records are created in context: patients, then wounds, then measures. */
export function HomePage({ account, portal, navigate }: { account: Account; portal: Portal; navigate: Navigate }) {
  const { patients, records, queue, listError } = useCareData();
  const { pending } = useReviewQueue();
  const clinical = portal === "clinical";
  const items = useMemo(() => allItems(records), [records]);

  const inProgress = useMemo(() => items.filter(({ obs }) =>
    obs.record_has_draft || (obs.review_state === "AWAITING_CLINICAL_REVIEW" && obs.uploading_user_subject === account.subject)
    || obs.review_state === "RETAKE_REQUESTED" && obs.uploading_user_subject === account.subject)
    .sort((a, b) => b.obs.capture_datetime_utc.localeCompare(a.obs.capture_datetime_utc)).slice(0, 5), [items, account.subject]);

  const activity = useMemo<Activity[]>(() => items.flatMap((item) => {
    const site = humanize(item.wound.anatomical_site).toLowerCase();
    // Each event names the measure's own date, so approvals of several measures do not read alike.
    const measure = `${site} measure of ${formatDate(item.obs.capture_datetime_utc)}`;
    const events: Activity[] = [{ at: item.obs.capture_datetime_utc, text: `${personName(item.obs.uploading_user_subject)} added a ${locationLabel(item.obs.capture_location_category).toLowerCase()} photo of the ${site}`, item }];
    if (item.obs.final_approval_timestamp_utc) events.push({ at: item.obs.final_approval_timestamp_utc, text: `${personName(item.obs.reviewing_clinician_subject)} approved the ${measure}`, item });
    (item.obs.record_history ?? []).filter((h) => h.action === "RECORD_DRAFT_SAVED" || h.action === "RECORD_SUBMITTED")
      .forEach((h) => events.push({ at: h.timestamp, text: `${personName(h.actor)} ${h.action === "RECORD_SUBMITTED" ? "submitted" : "saved"} changes to the ${measure}`, item }));
    return events;
  }).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 6), [items]);

  const recentPatients = useMemo(() => [...(patients ?? [])]
    .map((p) => ({ p, record: records[p.patient_id] }))
    .sort((a, b) => (b.record ? lastActivity(b.record) : "").localeCompare(a.record ? lastActivity(a.record) : ""))
    .slice(0, 5), [patients, records]);

  const tasks = useMemo(() => Object.values(records).flatMap((record) => record.wounds.flatMap((w) =>
    w.care_tasks.filter((t) => t.status === "PENDING").map((t) => ({ t, w, record })))).slice(0, 4), [records]);

  if (portal === "admin") return <AdminHome account={account} navigate={navigate} />;

  return (
    <div className="page page-wide">
      <header className="home-header">
        <div>
          <h1>{greeting()}, {accountName(account)}</h1>
          <p className="muted-text">{new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long" }).format(new Date())}</p>
        </div>
        {clinical && (
          <button type="button" className="button secondary" onClick={() => navigate({ name: "patients" })}>
            <Search aria-hidden="true" /> Find patient
          </button>
        )}
      </header>
      {listError && <Notice tone="danger">{listError.message}</Notice>}

      <div className="home-grid">
        {!clinical && <WoundsToUpdate records={records} navigate={navigate} />}
        {clinical && can(account, "ASSESS") && (
          <section className="home-card span-2" aria-labelledby="home-reviews-title">
            <div className="home-card-head">
              <h2 id="home-reviews-title" className="section-title">Pending reviews {pending.length > 0 && <span className="count">{pending.length}</span>}</h2>
              {pending.length > 0 && <button type="button" className="link-button" onClick={() => navigate({ name: "queue" })}>All reviews</button>}
            </div>
            {queue === null ? <Loading /> : pending.length === 0 ? <p className="muted-text">Nothing is waiting for review.</p> : (
              <ul className="home-list" aria-label="Pending reviews">
                {pending.slice(0, 5).map((q) => {
                  const record = records[q.patient_id];
                  const wound = record?.wounds.find((w) => w.wound_id === q.wound_id);
                  const obs = wound?.observations.find((o) => o.observation_id === q.observation_id);
                  return (
                    <li key={q.review_request_id}>
                      <button type="button" className="home-row" onClick={() => navigate({ name: "review", patientId: q.patient_id, observationId: q.observation_id })}>
                        <PrivateImage image={obs ? pickDisplayImage(obs.images) : null} alt="" className="home-thumb" />
                        <span className="home-row-main">
                          <span className="home-row-title"><span className="id-chip">{q.patient.patient_code}</span> {patientName(q.patient)} · {humanize(q.anatomical_site)}</span>
                          <span className="home-row-sub">{personName(q.submitted_by_subject)} · {locationLabel(q.submitted_from_location)} · {formatDateTime(q.created_at_utc)}</span>
                        </span>
                        {q.priority_level === "RED" && <Badge tone="danger">Concern reported</Badge>}
                        <ChevronRight aria-hidden="true" className="row-chevron" />
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        )}

        <section className="home-card" aria-labelledby="home-progress-title">
          <div className="home-card-head"><h2 id="home-progress-title" className="section-title">{clinical ? "In progress" : "My updates"}</h2></div>
          {patients === null ? <Loading /> : inProgress.length === 0 ? (
            <p className="muted-text">{clinical ? "No unsigned revisions or open submissions of yours." : "Nothing waiting. Updates you send appear here until they are reviewed."}</p>
          ) : (
            <ul className="home-list" aria-label={clinical ? "In progress" : "My updates"}>
              {inProgress.map((item) => (
                <RecordRow key={item.obs.observation_id} item={item} navigate={navigate}
                  sub={item.obs.record_has_draft ? "Unsigned revision saved" : `${formatDateTime(item.obs.capture_datetime_utc)} · ${locationLabel(item.obs.capture_location_category)}`} />
              ))}
            </ul>
          )}
        </section>

        <section className="home-card" aria-labelledby="home-patients-title">
          <div className="home-card-head">
            <h2 id="home-patients-title" className="section-title">{clinical ? "Recent patients" : "My patients"}</h2>
            <button type="button" className="link-button" onClick={() => navigate({ name: "patients" })}>{clinical ? "Find a patient" : "All"}</button>
          </div>
          {patients === null ? <Loading /> : recentPatients.length === 0 ? (
            <EmptyState title={clinical ? "No assigned patients yet" : "No one has shared a record with you yet"}>
              {clinical ? "Search for a patient, or ask an administrator to add you to a care team." : "When a patient or their care team gives you access, they appear here."}
            </EmptyState>
          ) : (
            <ul className="home-list" aria-label={clinical ? "Recent patients" : "My patients"}>
              {recentPatients.map(({ p, record }) => {
                const waiting = record?.wounds.reduce((n, w) => n + w.observations.filter((o) => o.review_state === "AWAITING_CLINICAL_REVIEW").length, 0) ?? 0;
                const active = record?.wounds.filter((w) => w.status === "ACTIVE").length ?? 0;
                const last = record ? lastActivity(record) : "";
                return (
                  <li key={p.patient_id}>
                    <button type="button" className="home-row" onClick={() => navigate({ name: "patient", patientId: p.patient_id })} aria-label={`Open patient ${p.display_name}`}>
                      <span className="home-row-main">
                        <span className="home-row-title"><span className="id-chip">{p.patient_code}</span> {patientName(p)}</span>
                        <span className="home-row-sub">{active} active wound{active === 1 ? "" : "s"}{last ? ` · last activity ${formatDate(last)}` : ""}</span>
                      </span>
                      {clinical && waiting > 0 && <Badge tone="warning">{waiting} to review</Badge>}
                      <ChevronRight aria-hidden="true" className="row-chevron" />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {!clinical && (
          <section className="home-card" aria-labelledby="home-tasks-title">
            <div className="home-card-head">
              <h2 id="home-tasks-title" className="section-title">Care tasks</h2>
              <button type="button" className="link-button" onClick={() => navigate({ name: "careplan" })}>Care plan</button>
            </div>
            {tasks.length === 0 ? <p className="muted-text">No open tasks.</p> : (
              <ul className="activity-list">
                {tasks.map(({ t, w, record }) => (
                  <li key={t.task_id}>
                    <span><ClipboardList aria-hidden="true" className="inline-icon" /> {t.title} · {humanize(w.anatomical_site)} ({record.patient.patient_code})</span>
                    <span className="fine-print">Due {formatDateTime(t.due_at_utc)}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}

        <section className={`home-card${clinical ? " span-2" : ""}`} aria-labelledby="home-activity-title">
          <div className="home-card-head"><h2 id="home-activity-title" className="section-title">Recent activity</h2></div>
          {activity.length === 0 ? <p className="muted-text">No recent activity.</p> : (
            <ul className="activity-list">
              {activity.map((a) => (
                <li key={`${a.item.obs.observation_id}:${a.at}:${a.text}`}>
                  <button type="button" className="link-button" onClick={() => navigate(clinical || a.item.obs.uploading_user_subject === account.subject
                    ? { name: "review", patientId: a.item.record.patient.patient_id, observationId: a.item.obs.observation_id }
                    : { name: "patient", patientId: a.item.record.patient.patient_id })}>
                    <span className="id-chip">{a.item.record.patient.patient_code}</span> {a.text}
                  </button>
                  <span className="fine-print">{formatDateTime(a.at)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
