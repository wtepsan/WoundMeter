"use client";

import { useCareData } from "@/components/app/CareDataProvider";
import { SharingPanel } from "@/components/care/SharingPanel";
import { EmptyState, Loading, Notice } from "@/components/ui/Feedback";
import { PageHeader } from "@/components/ui/Layout";

/** Patient portal: who can see your approved progress. */
export function SharingPage() {
  const { patients, records, recordErrors, refreshPatient } = useCareData();
  const patient = patients?.[0];
  const record = patient ? records[patient.patient_id] : undefined;
  return (
    <div className="page">
      <PageHeader title="Sharing" subtitle="Choose which family members can see your approved progress and help with your care." />
      {patients === null ? (
        <Loading />
      ) : !patient ? (
        <EmptyState title="No record found" />
      ) : record ? (
        <section className="panel">
          <SharingPanel record={record} onChanged={() => refreshPatient(patient.patient_id)} />
        </section>
      ) : recordErrors[patient.patient_id] ? (
        <Notice tone="danger">{recordErrors[patient.patient_id].message}</Notice>
      ) : (
        <Loading />
      )}
    </div>
  );
}
