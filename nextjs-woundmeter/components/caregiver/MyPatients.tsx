"use client";

import type { Navigate } from "@/components/app/AppShell";
import { useCareData } from "@/components/app/CareDataProvider";
import { PatientRow } from "@/components/clinical/PatientSearch";
import { AccessTestPrompt } from "@/components/clinical/AccessTestPrompt";
import { EmptyState, Loading, Notice } from "@/components/ui/Feedback";
import { PageHeader } from "@/components/ui/Layout";

/** Caregivers see only the patients explicitly shared with them; there is no search. */
export function MyPatients({ navigate }: { navigate: Navigate }) {
  const { patients, listError } = useCareData();
  return (
    <div className="page">
      <PageHeader title="My patients" subtitle="People whose wound care has been shared with you." />
      {listError && <Notice tone="danger">{listError.message}</Notice>}
      {patients === null ? (
        <Loading />
      ) : patients.length === 0 ? (
        <EmptyState title="No one has shared a record with you yet">
          When a patient or their care team gives you access, they will appear here.
          <AccessTestPrompt />
        </EmptyState>
      ) : (
        <ul className="row-list" aria-label="My patients">
          {patients.map((p) => (
            <PatientRow key={p.patient_id} patient={p} onOpen={() => navigate({ name: "patient", patientId: p.patient_id })} />
          ))}
        </ul>
      )}
    </div>
  );
}
