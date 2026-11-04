"use client";

import { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";

import type { Navigate } from "@/components/app/AppShell";
import { Badge, EmptyState, Loading, Metric, Notice } from "@/components/ui/Feedback";
import { Disclosure, PageHeader } from "@/components/ui/Layout";
import { formatDateTime } from "@/lib/care-format";
import { nursing } from "@/lib/nursing-api";
import { SHIFT_OPTIONS, priorityBadge, todayStatusBadge } from "@/lib/nursing-format";
import type { Admission, NursingContext, WardBoardRow } from "@/lib/nursing-types";

function ShiftBar({ context, onChange }: { context: NursingContext; onChange: (next: NursingContext) => void }) {
  const active = context.active_shift;
  const [wardCode, setWardCode] = useState(active?.ward_code ?? context.wards[0]?.code ?? "");
  const [shift, setShift] = useState(active?.shift ?? "DAY");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (action: () => Promise<NursingContext>) => {
    setBusy(true);
    setError(null);
    try {
      onChange(await action());
    } catch (err) {
      setError(err instanceof Error ? err.message : "The shift could not be changed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel stack" aria-labelledby="shift-title">
      <div className="panel-head">
        <h2 id="shift-title" className="section-title">
          Your shift
        </h2>
        {active ? (
          <Badge tone="success">
            On shift · {active.ward_code} · {active.shift.toLowerCase()} since {formatDateTime(active.started_at_utc)}
          </Badge>
        ) : (
          <Badge tone="warning">Not on shift</Badge>
        )}
      </div>
      <p className="fine-print">
        Admissions, assessments, checklists and discharges are recorded against your active shift and ward.
      </p>
      {error && <Notice tone="danger">{error}</Notice>}
      <div className="inline-form">
        <div className="field">
          <label htmlFor="shift-ward">Ward</label>
          <select id="shift-ward" value={wardCode} onChange={(e) => setWardCode(e.target.value)}>
            {context.wards.map((w) => (
              <option key={w.code} value={w.code}>
                {w.code} — {w.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="shift-name">Shift</label>
          <select id="shift-name" value={shift} onChange={(e) => setShift(e.target.value)}>
            {SHIFT_OPTIONS.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </div>
        <div className="button-row">
          <button
            type="button"
            className="button primary"
            disabled={busy || !wardCode || (active?.ward_code === wardCode && active.shift === shift)}
            onClick={() => void run(() => nursing.startShift(wardCode, shift))}
          >
            {active ? "Switch shift" : "Start shift"}
          </button>
          {active && (
            <button type="button" className="button secondary" disabled={busy} onClick={() => void run(() => nursing.endShift(active.shift_id))}>
              End shift
            </button>
          )}
        </div>
      </div>
    </section>
  );
}

function BoardTable({ rows, navigate }: { rows: WardBoardRow[]; navigate: Navigate }) {
  return (
    <div className="table-wrap">
      <table className="data-table">
        <thead>
          <tr>
            <th scope="col">Bed</th>
            <th scope="col">Patient</th>
            <th scope="col">Today</th>
            <th scope="col">Priority</th>
            <th scope="col">Next review</th>
            <th scope="col">
              <span className="sr-only">Action</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const today = todayStatusBadge(row.today_status);
            const priority = priorityBadge(row.priority);
            return (
              <tr key={row.admission_id}>
                <td data-label="Bed">
                  <strong>{row.bed}</strong>
                </td>
                <td data-label="Patient">
                  <strong>{row.patient_name}</strong>
                  <span className="cell-sub">{row.hospital_number ?? row.patient_code} · {row.admission_code}</span>
                </td>
                <td data-label="Today">
                  <span className="badge-stack">
                    <Badge tone={today.tone}>{today.label}</Badge>
                    {row.overdue_critical_care && <Badge tone="danger">Critical care overdue</Badge>}
                  </span>
                </td>
                <td data-label="Priority">
                  <Badge tone={priority.tone}>{priority.label}</Badge>
                  {row.braden_total !== null && <span className="cell-sub">Braden {row.braden_total}</span>}
                </td>
                <td data-label="Next review">{row.next_review_at_utc ? formatDateTime(row.next_review_at_utc) : "—"}</td>
                <td className="cell-action">
                  <button
                    type="button"
                    className="button primary small"
                    onClick={() => navigate({ name: "patient", patientId: row.patient_id })}
                    aria-label={`Open ${row.patient_name}, bed ${row.bed}`}
                  >
                    Open
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Ward view for nurses and supervisors: shift context, the ward board and recent discharges. */
export function WardBoard({ navigate }: { navigate: Navigate }) {
  const [context, setContext] = useState<NursingContext | null>(null);
  const [wardCode, setWardCode] = useState("");
  const [rows, setRows] = useState<WardBoardRow[] | null>(null);
  const [discharged, setDischarged] = useState<Admission[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (ward: string) => {
    if (!ward) return;
    setError(null);
    try {
      const [board, recent] = await Promise.all([nursing.wardBoard(ward), nursing.admissions("discharged", ward)]);
      setRows(board.admissions);
      setDischarged(recent.slice(0, 20));
    } catch (err) {
      setError(err instanceof Error ? err.message : "The ward board could not be loaded.");
    }
  }, []);

  useEffect(() => {
    nursing
      .context()
      .then((ctx) => {
        setContext(ctx);
        const initial = ctx.active_shift?.ward_code ?? ctx.wards[0]?.code ?? "";
        setWardCode(initial);
        void load(initial);
      })
      .catch((err: Error) => setError(err.message));
  }, [load]);

  const onShiftChange = (next: NursingContext) => {
    setContext(next);
    if (next.active_shift && next.active_shift.ward_code !== wardCode) {
      setWardCode(next.active_shift.ward_code);
      void load(next.active_shift.ward_code);
    }
  };

  if (!context) {
    return (
      <div className="page">
        <PageHeader title="Ward" />
        {error ? <Notice tone="danger">{error}</Notice> : <Loading label="Loading ward…" />}
      </div>
    );
  }

  if (context.wards.length === 0) {
    return (
      <div className="page">
        <PageHeader title="Ward" />
        <EmptyState title="No ward assigned">Ask an administrator to add your wards under Users &amp; roles.</EmptyState>
      </div>
    );
  }

  const dueToday = rows?.filter((r) => r.today_status !== "COMPLETED").length ?? 0;
  const overdueCare = rows?.filter((r) => r.overdue_critical_care).length ?? 0;

  return (
    <div className="page">
      <PageHeader
        title="Ward"
        subtitle="Inpatients on your wards, today's required nursing assessments and priorities. Admit a patient from their record."
        actions={
          <>
            <button type="button" className="button secondary" onClick={() => navigate({ name: "patients" })}>
              Find a patient to admit
            </button>
            <button type="button" className="button ghost icon-only" onClick={() => void load(wardCode)} aria-label="Refresh ward board">
              <RefreshCw aria-hidden="true" />
            </button>
          </>
        }
      />
      <ShiftBar context={context} onChange={onShiftChange} />

      <section className="stack" aria-labelledby="board-title">
        <div className="panel-head">
          <h2 id="board-title" className="section-title">
            Ward board
          </h2>
          <div className="field">
            <label htmlFor="board-ward" className="sr-only">
              Ward shown
            </label>
            <select
              id="board-ward"
              value={wardCode}
              onChange={(e) => {
                setWardCode(e.target.value);
                void load(e.target.value);
              }}
            >
              {context.wards.map((w) => (
                <option key={w.code} value={w.code}>
                  {w.code} — {w.name}
                </option>
              ))}
            </select>
          </div>
        </div>
        {context.active_shift && context.active_shift.ward_code !== wardCode && (
          <Notice tone="info">You are viewing {wardCode}; clinical actions use your shift ward, {context.active_shift.ward_code}.</Notice>
        )}
        {error && <Notice tone="danger">{error}</Notice>}
        {rows === null ? (
          <Loading label="Loading ward board…" />
        ) : (
          <>
            <div className="metric-grid">
              <Metric label="Inpatients" value={String(rows.length)} />
              <Metric label="Assessment not done today" value={String(dueToday)} />
              <Metric label="Critical care overdue" value={String(overdueCare)} />
            </div>
            {rows.length === 0 ? (
              <EmptyState title="No inpatients on this ward">Admitted patients appear here.</EmptyState>
            ) : (
              <BoardTable rows={rows} navigate={navigate} />
            )}
          </>
        )}
      </section>

      {discharged.length > 0 && (
        <Disclosure title="Recently discharged" summary={`${discharged.length} on ${wardCode}`}>
          <ul className="row-list" aria-label="Recently discharged">
            {discharged.map((a) => (
              <li key={a.admission_id} className="list-row">
                <span className="row-main">
                  <span className="row-title">
                    {a.patient_name} · {a.admission_code}
                  </span>
                  <span className="row-sub">
                    Bed {a.bed} · admitted {formatDateTime(a.admitted_at_utc)} · discharged {formatDateTime(a.discharge_at_utc)}
                  </span>
                </span>
                <button
                  type="button"
                  className="button secondary small"
                  onClick={() => navigate({ name: "admission-report", patientId: a.patient_id, admissionId: a.admission_id })}
                >
                  Report
                </button>
              </li>
            ))}
          </ul>
        </Disclosure>
      )}
    </div>
  );
}
