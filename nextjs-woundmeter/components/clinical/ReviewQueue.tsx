"use client";

import { useEffect } from "react";
import { RefreshCw } from "lucide-react";

import type { Navigate } from "@/components/app/AppShell";
import { useCareData, useReviewQueue } from "@/components/app/CareDataProvider";
import { Badge, EmptyState, Loading } from "@/components/ui/Feedback";
import { Disclosure, PageHeader } from "@/components/ui/Layout";
import { personName, type Account } from "@/lib/accounts";
import { RecordActions } from "@/components/clinical/RecordActions";
import { formatDateTime, humanize, locationLabel, patientName, reviewStateLabel } from "@/lib/care-format";
import type { ReviewQueueItem } from "@/lib/care-types";

function QueueTable({ items, navigate, actionable, account }: { items: ReviewQueueItem[]; navigate: Navigate; actionable: boolean; account: Account }) {
  const { refreshPatient, refreshQueue } = useCareData();
  return (
    <div className="table-wrap">
      <table className="data-table queue-table">
        <thead>
          <tr>
            <th scope="col">Patient</th>
            <th scope="col">Wound</th>
            <th scope="col">Submitted</th>
            <th scope="col">Responsible</th>
            <th scope="col">Status</th>
            <th scope="col"><span className="sr-only">Action</span></th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => {
            const status = reviewStateLabel(item.status);
            const site = humanize(item.anatomical_site);
            return (
              <tr key={item.review_request_id}>
                <td data-label="Patient">
                  <strong><span className="id-chip">{item.patient.patient_code}</span> {patientName(item.patient)}</strong>
                  {item.patient.hospital_number && <span className="cell-sub">{item.patient.hospital_number}</span>}
                </td>
                <td data-label="Wound">
                  {site}
                  <span className="cell-sub">{item.wound_code}</span>
                </td>
                <td data-label="Submitted">{formatDateTime(item.created_at_utc)}</td>
                <td data-label="Submitted by">
                  {personName(item.submitted_by_subject)}
                  <span className="cell-sub">{locationLabel(item.submitted_from_location)}</span>
                </td>
                <td data-label="Status">
                  <span className="badge-stack">
                    <Badge tone={status.tone}>{status.label}</Badge>
                    {actionable && item.priority_level === "RED" && <Badge tone="danger">Concern reported</Badge>}
                  </span>
                </td>
                  <td className="cell-action">
                    {actionable && <button
                      type="button"
                      className="button primary small"
                      onClick={() => navigate({ name: "review", patientId: item.patient_id, observationId: item.observation_id })}
                      aria-label={`Review ${site} observation for ${item.patient.display_name}`}
                    >
                      Open record
                    </button>}
                    <RecordActions account={account} recordType="observation" recordId={item.observation_id}
                      status={item.status} details={`${item.patient.display_name} · ${site} · ${formatDateTime(item.created_at_utc)}`}
                      onDeleted={() => Promise.all([refreshPatient(item.patient_id), refreshQueue()])} />
                  </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function ReviewQueue({ navigate, account }: { navigate: Navigate; account: Account }) {
  const { queue, refreshQueue } = useCareData();
  const { pending, closed } = useReviewQueue();

  useEffect(() => {
    void refreshQueue();
  }, [refreshQueue]);

  return (
    <div className="page">
      <PageHeader
        title="Reviews"
        subtitle="Records waiting for clinical verification in your organisation and care teams. Nothing is signed until a clinician approves it."
        actions={
          <button type="button" className="button ghost icon-only" onClick={() => void refreshQueue()} aria-label="Refresh pending reviews">
            <RefreshCw aria-hidden="true" />
          </button>
        }
      />
      {queue === null ? (
        <Loading label="Loading pending reviews…" />
      ) : pending.length === 0 ? (
        <EmptyState title="Nothing to review">New photos from the hospital or home will appear here.</EmptyState>
      ) : (
        <QueueTable items={pending} account={account} navigate={navigate} actionable />
      )}
      {closed.length > 0 && (
        <Disclosure title="Recently closed" summary={`${closed.length} reviewed`}>
          <QueueTable items={closed.slice(0, 20)} account={account} navigate={navigate} actionable={false} />
        </Disclosure>
      )}
    </div>
  );
}
