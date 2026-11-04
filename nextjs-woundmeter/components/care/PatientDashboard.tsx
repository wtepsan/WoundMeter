"use client";

import { useEffect, useState } from "react";
import { CircleCheck, Eye, History, Plus, RotateCcw, TrendingDown, TrendingUp } from "lucide-react";

import type { Navigate } from "@/components/app/AppShell";
import { useCareData } from "@/components/app/CareDataProvider";
import { CarePlanSection } from "@/components/care/CarePlanSection";
import { SharingPanel } from "@/components/care/SharingPanel";
import { WoundCarousel } from "@/components/care/WoundCarousel";
import { WoundCareSummary } from "@/components/care/WoundCareSummary";
import { WoundHistory } from "@/components/care/WoundHistory";
import { RecordActions } from "@/components/clinical/RecordActions";
import { AssistantPanel } from "@/components/clinical/AssistantPanel";
import { DeletedRecords } from "@/components/clinical/DeletedRecords";
import { AuditHistory, TechnicalDetails } from "@/components/clinical/RecordSections";
import { ReportPanel } from "@/components/clinical/ReportPanel";
import { NursingPanel } from "@/components/nursing/NursingPanel";
import { Breadcrumbs } from "@/components/ui/Breadcrumbs";
import { Badge, Loading, Notice } from "@/components/ui/Feedback";
import { PrivateImage, pickDisplayImage } from "@/components/ui/PrivateImage";
import { Disclosure } from "@/components/ui/Layout";
import { can, isWardNurse, personName, type Account, type Portal } from "@/lib/accounts";
import { CareApiError, setWoundStatus } from "@/lib/care-api";
import { formatCm, formatDate, humanize, latestAreaChange, patientName, woundSiteLabel, woundTypeLabel } from "@/lib/care-format";
import type { PatientCompleteRecord, WoundDetail } from "@/lib/care-types";

type Tab = "wounds" | "care-plan" | "ai" | "nursing" | "sharing" | "audit";

function identityLine(record: PatientCompleteRecord): string {
  const p = record.patient;
  return [
    p.hospital_number ? (/^HN/i.test(p.hospital_number) ? p.hospital_number : `HN ${p.hospital_number}`) : null,
    p.national_id_masked ? `Citizen ID ${p.national_id_masked}` : p.no_national_id_reason ? `No Citizen ID (${p.no_national_id_reason})` : null,
    p.date_of_birth ? `Born ${formatDate(p.date_of_birth)}` : null,
    p.sex ? p.sex.charAt(0) + p.sex.slice(1).toLowerCase() : null,
    p.org_name,
  ].filter(Boolean).join(" · ");
}

/**
 * Latest photo, latest verified value, and the change from the previous measurement of the same recorded region.
 * The wound shown in the panel below is teal and labelled Viewing; the others are grey.
 */
function WoundCard({ wound, selected, pending, portal, account, patientLabel, onSelect, onDeleted }: {
  wound: WoundDetail; selected: boolean; pending: number; portal: Portal; account: Account;
  patientLabel: string; onSelect: () => void; onDeleted: () => Promise<unknown>;
}) {
  const last = wound.approved_timeline.at(-1);
  const delta = latestAreaChange(wound)?.pct ?? null;
  const latestObs = wound.observations.at(-1);
  const updated = wound.observations.map((o) => o.final_approval_timestamp_utc ?? o.capture_datetime_utc).sort().at(-1);
  const actions = portal === "clinical" && can(account, "DELETE_RECORD") && can(account, "SIGN_OFF") && can(account, "ASSESS") && account.qualification_verified;
  return (
    <div className={`wound-card${selected ? " is-selected" : ""}`}>
      <button type="button" className="wound-card-button" aria-pressed={selected} onClick={onSelect}>
        {selected && <span className="wound-card-viewing"><Eye aria-hidden="true" /> Viewing</span>}
        <PrivateImage image={latestObs ? pickDisplayImage(latestObs.images) : null} alt="" className="wound-thumb" />
        <span className="wound-card-body">
          <span className="wound-card-title">{woundSiteLabel(wound)} <span className="wound-code">{wound.wound_code}</span></span>
          {portal === "clinical" && <span className="wound-card-sub">{woundTypeLabel(wound)}</span>}
          <span className="wound-card-value">
            {last ? <><strong>{formatCm(last.area_cm2)} cm²</strong> verified {formatDate(last.capture_datetime_utc)}</> : "No verified measurement"}
            {delta != null && Math.abs(delta) >= 0.05 && (
              <span className={`trend-chip ${delta < 0 ? "down" : "up"}`} title="Change from the previous verified area of the same recorded region; not a clinical judgement">
                {delta < 0 ? <TrendingDown aria-hidden="true" /> : <TrendingUp aria-hidden="true" />}{delta > 0 ? "+" : ""}{delta.toFixed(0)}%
              </span>
            )}
          </span>
          <span className="wound-card-foot">
            {pending > 0 ? <Badge tone="warning">{portal === "clinical" ? `${pending} to review` : "Update awaiting review"}</Badge>
              : wound.status !== "ACTIVE" ? <Badge tone="neutral">{wound.status.charAt(0) + wound.status.slice(1).toLowerCase()}</Badge>
                : wound.observations.length === 0 ? <Badge tone="neutral">No measures yet</Badge>
                  : <Badge tone="success">All reviewed</Badge>}
            {updated && <span className="fine-print">Updated {formatDate(updated)}</span>}
          </span>
        </span>
      </button>
      {actions && <RecordActions account={account} recordType="wound" recordId={wound.wound_id} status={wound.status}
        details={`${patientLabel} · ${woundSiteLabel(wound)} · ${wound.wound_code}`} onDeleted={onDeleted} />}
    </div>
  );
}

/**
 * The wound's own actions: New measure (a new photo of this wound, never a new wound) and View history.
 * New measure is offered only to staff with capture permission, or a caregiver whose grant covers this wound.
 */
function WoundActions({ wound, canMeasure, onMeasure, canConfirmHealing, onChanged }: {
  wound: WoundDetail; canMeasure: boolean; onMeasure: () => void;
  /** A qualified clinician may mark the wound healed (after a verified 0 cm²) or reopen it. */
  canConfirmHealing: boolean; onChanged: () => Promise<unknown>;
}) {
  const latest = wound.approved_timeline.at(-1);
  const healable = canConfirmHealing && wound.status === "ACTIVE" && Boolean(latest?.zero_area);
  const reopenable = canConfirmHealing && wound.status === "HEALED";
  const [confirming, setConfirming] = useState<null | "HEALED" | "ACTIVE">(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const open = (status: "HEALED" | "ACTIVE") => {
    setConfirming(status);
    setError(null);
    setReason(status === "HEALED" && latest ? `Wound closed: clinician-verified 0 cm² (no visible open wound) on ${formatDate(latest.capture_datetime_utc)}.` : "");
  };
  const confirm = async () => {
    if (!confirming) return;
    setBusy(true);
    setError(null);
    try {
      await setWoundStatus(wound.patient_id, wound.wound_id, confirming, reason.trim());
      await onChanged();
      setConfirming(null);
    } catch (err) {
      setError(err instanceof CareApiError || err instanceof Error ? err.message : "That didn’t work.");
    } finally {
      setBusy(false);
    }
  };
  const viewHistory = () => {
    const heading = document.getElementById(`visits-${wound.wound_id}`);
    heading?.scrollIntoView({ behavior: "smooth", block: "start" });
    heading?.focus({ preventScroll: true });
  };
  return (
    <div className="wound-actions">
      {canMeasure && (
        <button type="button" className="button primary" onClick={onMeasure}>
          <Plus aria-hidden="true" /> New measure
        </button>
      )}
      <button type="button" className="button secondary" onClick={viewHistory}>
        <History aria-hidden="true" /> View history
      </button>
      {healable && !confirming && (
        <button type="button" className="button secondary" onClick={() => open("HEALED")}>
          <CircleCheck aria-hidden="true" /> Mark wound healed
        </button>
      )}
      {reopenable && !confirming && (
        <button type="button" className="button secondary" onClick={() => open("ACTIVE")}>
          <RotateCcw aria-hidden="true" /> Reopen wound
        </button>
      )}
      {confirming && (
        <div className="panel inline-panel" role="group" aria-labelledby={`status-${wound.wound_id}`}>
          <h3 id={`status-${wound.wound_id}`} className="section-title">{confirming === "HEALED" ? "Mark this wound healed?" : "Reopen this wound?"}</h3>
          <p className="muted-text">
            {confirming === "HEALED"
              ? "Your confirmation that the wound has closed, based on the latest verified 0 cm². The record and its history stay; new photos can still be taken, and a verified open wound later reopens it."
              : "Returns the wound to active care. Its history, including the healed confirmation, is kept."}
          </p>
          <div className="field">
            <label htmlFor={`status-reason-${wound.wound_id}`}>Reason</label>
            <input id={`status-reason-${wound.wound_id}`} maxLength={512} value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>
          {error && <p className="danger-text" role="alert">{error}</p>}
          <div className="button-row">
            <button type="button" className="button primary" disabled={busy || !reason.trim()} onClick={() => void confirm()}>
              {busy ? "Saving…" : confirming === "HEALED" ? "Confirm healed" : "Reopen wound"}
            </button>
            <button type="button" className="button ghost" disabled={busy} onClick={() => setConfirming(null)}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Patient → wound → measures, in one workspace. The patient page creates wounds (New wound, beside the
 * Wounds heading); the selected wound creates measures (New measure, in its header). The selected wound is
 * part of the address (…/wounds/{id}), so Back and shared links return to it. Secondary areas sit in tabs.
 */
export function PatientDashboard({ patientId, initialWoundId, account, portal, navigate }: {
  patientId: string; initialWoundId?: string; account: Account; portal: Portal; navigate: Navigate;
}) {
  const { records, recordErrors, refreshPatient, refreshQueue } = useCareData();
  const record = records[patientId];
  const error = recordErrors[patientId];
  const woundId = initialWoundId ?? null;
  const [tab, setTab] = useState<Tab>("wounds");
  const crumbs = (label: React.ReactNode) => portal === "patient" ? null
    : <Breadcrumbs navigate={navigate} items={[{ label: "Patients", view: { name: "patients" } }, { label }]} />;

  useEffect(() => {
    void refreshPatient(patientId);
  }, [patientId, refreshPatient]);

  if (!record) {
    return (
      <div className="page">
        {crumbs("Patient record")}
        {error ? <Notice tone="danger" title="You can't open this record">{error.message}</Notice> : <Loading label="Loading patient record…" />}
      </div>
    );
  }

  const clinical = portal === "clinical";
  const active = record.wounds.filter((w) => w.status === "ACTIVE");
  const closed = record.wounds.filter((w) => w.status !== "ACTIVE");
  // A wound named in the address is shown only if it is in this record; it is never swapped for another.
  const requestedMissing = Boolean(woundId) && !record.wounds.some((w) => w.wound_id === woundId);
  const wound = requestedMissing ? null : record.wounds.find((w) => w.wound_id === woundId) ?? active[0] ?? record.wounds[0] ?? null;
  const observationKey = record.wounds.map((w) => `${w.wound_id}:${w.observations.map((o) => o.observation_id).join(":")}`).join("|");
  const pendingFor = (w: WoundDetail) => w.observations.filter((o) =>
    o.review_state === "AWAITING_CLINICAL_REVIEW" && (clinical || o.uploading_user_subject === account.subject)).length;
  // A healed wound can still be photographed (a follow-up check); a verified open wound reopens it.
  const canMeasure = (w: WoundDetail) => (w.status === "ACTIVE" || w.status === "HEALED")
    && (clinical ? can(account, "CAPTURE") : portal === "caregiver" && Boolean(w.allowed_actions?.includes("UPLOAD_HOME_PHOTO")));
  const canAddWound = clinical && can(account, "REGISTER_WOUND");
  const selectWound = (id: string) => navigate({ name: "patient", patientId, woundId: id });
  const refresh = () => refreshPatient(patientId);
  // Deleting another wound from its card keeps the wound being viewed; only deleting that one moves the view.
  const onWoundDeleted = async (deletedId: string) => {
    if (deletedId === wound?.wound_id) navigate({ name: "patient", patientId });
    await Promise.all([refreshPatient(patientId), refreshQueue()]);
  };
  const woundCard = (w: WoundDetail) => (
    <WoundCard key={w.wound_id} wound={w} selected={w.wound_id === wound?.wound_id} pending={pendingFor(w)} portal={portal}
      account={account} patientLabel={record.patient.display_name} onSelect={() => selectWound(w.wound_id)} onDeleted={() => onWoundDeleted(w.wound_id)} />
  );
  const woundActions = wound && (
    <WoundActions wound={wound} canMeasure={canMeasure(wound)}
      canConfirmHealing={clinical && can(account, "ASSESS") && can(account, "SIGN_OFF") && Boolean(account.qualification_verified)}
      onChanged={() => Promise.all([refreshPatient(patientId), refreshQueue()])}
      onMeasure={() => navigate({ name: "new-observation", patientId, woundId: wound.wound_id })} />
  );
  const viewing = <p className="eyebrow viewing-label"><Eye aria-hidden="true" /> Currently viewing</p>;
  const careTeam = record.care_team.map((m) => personName(m.user_subject)).join(", ");
  const tabs: Array<{ key: Tab; label: string; show: boolean }> = [
    { key: "wounds", label: "Wounds", show: true },
    { key: "care-plan", label: "Care plan", show: Boolean(wound) },
    { key: "ai", label: "AI reports", show: clinical },
    { key: "nursing", label: "Inpatient nursing", show: clinical && isWardNurse(account) },
    { key: "sharing", label: clinical ? "Care team & sharing" : "Sharing", show: clinical || portal === "patient" },
    { key: "audit", label: "Audit & details", show: clinical },
  ];
  const shown = tabs.filter((t) => t.show);
  const current = shown.some((t) => t.key === tab) ? tab : "wounds";

  return (
    <div className="page page-wide">
      <header className="patient-header">
        {crumbs(<><span className="id-chip">{record.patient.patient_code}</span> {patientName(record.patient)}</>)}
        <div className="patient-header-row">
          <div className="patient-identity">
            <h1><span className="id-chip large">{record.patient.patient_code}</span> {patientName(record.patient)}</h1>
            {/* Caregivers see how the record is shared in the badge below, not repeated here. */}
            {(clinical || portal === "patient") && <p className="muted-text">{identityLine(record)}</p>}
            <p className="patient-meta">
              <Badge tone="info">{record.access.label}{record.access.expires_at_utc ? ` until ${formatDate(record.access.expires_at_utc)}` : ""}</Badge>
              {careTeam && clinical && <span className="fine-print">Care team: {careTeam}</span>}
            </p>
          </div>
        </div>
      </header>

      {shown.length > 1 && (
        <nav className="page-tabs" aria-label="Patient record sections">
          {shown.map((t) => (
            <button key={t.key} type="button" aria-current={t.key === current ? "page" : undefined} onClick={() => setTab(t.key)}>{t.label}</button>
          ))}
        </nav>
      )}

      {current === "wounds" && (
        <>
          {requestedMissing && (
            <Notice tone="warning" title="This wound is unavailable">
              The wound in this link was not found in {patientName(record.patient)}&apos;s record, or you do not have access to it.
              No other wound was opened in its place: choose one below.
            </Notice>
          )}
          <section aria-labelledby="wounds-title" className="stack">
            <WoundCarousel label="Active wounds" selectedId={wound?.wound_id ?? null}
              title={<h2 id="wounds-title" className="section-title">Wounds{active.length > 0 && <span className="count">{active.length}</span>}</h2>}
              actions={canAddWound && (
                <button type="button" className="button secondary" onClick={() => navigate({ name: "new-wound", patientId })}>
                  <Plus aria-hidden="true" /> New wound
                </button>
              )}
              empty={<p className="muted-text">{record.wounds.length ? "No active wounds." : "No wounds recorded yet."}{canAddWound && " Use New wound to register one."}</p>}>
              {active.map(woundCard)}
            </WoundCarousel>
            {closed.length > 0 && (
              // Open whenever the wound being viewed is one of these, so its card is on screen after a link or reload.
              <Disclosure title="Healed & archived wounds" summary={`${closed.length}`} defaultOpen={wound != null && wound.status !== "ACTIVE"}>
                <WoundCarousel label="Completed and archived wounds" selectedId={wound?.wound_id ?? null}>
                  {closed.map(woundCard)}
                </WoundCarousel>
              </Disclosure>
            )}
          </section>
          {wound && (
            <section className="panel wound-panel" aria-label={`${woundSiteLabel(wound)} ${wound.wound_code}`}>
              {wound.care_summary ? (
                <WoundCareSummary key={wound.wound_id} wound={wound} account={account} portal={portal} onChanged={refresh}
                  onOpenCarePlan={() => setTab("care-plan")} actions={woundActions} eyebrow={viewing}
                  subtitle={[clinical ? woundTypeLabel(wound) : null, wound.status === "ACTIVE" ? "Active" : humanize(wound.status),
                    `${record.patient.patient_code} ${patientName(record.patient)}`].filter(Boolean).join(" · ")} />
              ) : (
                <div className="section-head">
                  <div>
                    {viewing}
                    <h2 className="section-title">{woundSiteLabel(wound)} <span className="wound-code">{wound.wound_code}</span></h2>
                  </div>
                  {woundActions}
                </div>
              )}
              {/* Keyed by wound, so comparison picks and chart choices never carry over to another wound. */}
              <WoundHistory key={`history:${wound.wound_id}`} wound={wound} patientId={patientId} account={account} portal={portal} navigate={navigate} />
            </section>
          )}
        </>
      )}

      {current === "care-plan" && wound && (
        <section className="panel" aria-label="Care plan">
          <h2 className="section-title">Care plan · {woundSiteLabel(wound)} <span className="wound-code">{wound.wound_code}</span></h2>
          {/* Back/Forward can change the wound while this tab is open: a half-written concern stays with its own wound. */}
          <CarePlanSection key={wound.wound_id} record={record} wound={wound} onChanged={refresh}
            mode={clinical ? "clinical" : portal === "caregiver" ? "caregiver" : "patient"} canIssue={can(account, "MANAGE_CARE_PLAN")} />
        </section>
      )}

      {current === "ai" && (
        <div className="stack">
          <Notice tone="info">Muse Spark drafts; you review and sign. AI text never enters the record on its own.</Notice>
          <Disclosure title="Ask the record (AI assistant)" summary="Thai or English, typed or spoken">
            <AssistantPanel key={observationKey} patientId={patientId} />
          </Disclosure>
          {wound && (
            <Disclosure title={`AI reports · ${woundSiteLabel(wound)} ${wound.wound_code}`} summary="Draft, review and sign" defaultOpen>
              <ReportPanel key={`${wound.wound_id}:${observationKey}`} patientId={patientId} wound={wound} account={account} />
            </Disclosure>
          )}
        </div>
      )}

      {current === "nursing" && <section className="panel" aria-label="Inpatient nursing"><NursingPanel patientId={patientId} navigate={navigate} /></section>}

      {current === "sharing" && <section className="panel" aria-label="Care team and sharing"><SharingPanel record={record} onChanged={refresh} /></section>}

      {current === "audit" && (
        <div className="disclosure-group">
          <Disclosure title="Audit history" summary={`${record.audit_history.length} recent events`} defaultOpen>
            <AuditHistory record={record} />
          </Disclosure>
          {can(account, "SIGN_OFF") && can(account, "ASSESS") && (
            <Disclosure title="Deleted records" summary="Retained records and restoration">
              <DeletedRecords canAuthorize={can(account, "AUTHORIZE_RESTORE")} key={record.audit_history[0]?.event_id} patientId={patientId} />
            </Disclosure>
          )}
          {wound && <Disclosure title="Technical details"><TechnicalDetails record={record} wound={wound} /></Disclosure>}
        </div>
      )}
    </div>
  );
}
