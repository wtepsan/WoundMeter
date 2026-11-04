"use client";

import { useState } from "react";

import { useCareData } from "@/components/app/CareDataProvider";
import { CarePlanSection } from "@/components/care/CarePlanSection";
import { EmptyState, Loading, Notice } from "@/components/ui/Feedback";
import { PageHeader } from "@/components/ui/Layout";
import type { Portal } from "@/lib/accounts";
import { woundSiteLabel } from "@/lib/care-format";

export function CarePlanPage({ portal }: { portal: Portal }) {
  const { patients, records, recordErrors, refreshPatient } = useCareData();
  const [patientId, setPatientId] = useState<string | null>(null);
  const patient = patients?.find((p) => p.patient_id === patientId) ?? patients?.[0];
  const record = patient ? records[patient.patient_id] : undefined;

  return (
    <div className="page">
      <PageHeader title="Care plan" subtitle="Instructions approved by the care team, and the tasks to do at home." />
      {patients && patients.length > 1 && <div className="field">
        <label htmlFor="care-plan-patient">Patient</label>
        <select id="care-plan-patient" value={patient?.patient_id ?? ""} onChange={(event) => {
          setPatientId(event.target.value);
          void refreshPatient(event.target.value);
        }}>
          {patients.map((p) => <option key={p.patient_id} value={p.patient_id}>{p.display_name}</option>)}
        </select>
      </div>}
      {patients === null ? (
        <Loading />
      ) : !patient ? (
        <EmptyState title="No care plan to show" />
      ) : !record ? (
        recordErrors[patient.patient_id] ? <Notice tone="danger">{recordErrors[patient.patient_id].message}</Notice> : <Loading />
      ) : (
        record.wounds.map((w) => (
          <section key={w.wound_id} className="panel" aria-label={`${woundSiteLabel(w)} care plan`}>
            <h2 className="section-title">{woundSiteLabel(w)}</h2>
            <CarePlanSection
              record={record}
              wound={w}
              onChanged={() => refreshPatient(record.patient.patient_id)}
              mode={portal === "caregiver" ? "caregiver" : "patient"}
            />
          </section>
        ))
      )}
    </div>
  );
}
