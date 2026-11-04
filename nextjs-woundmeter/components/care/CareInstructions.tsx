"use client";

import { EditableDraft } from "@/components/ai/EditableDraft";
import { reviseCarePlan } from "@/lib/care-api";
import type { CarePlanRecord, WoundDetail } from "@/lib/care-types";

/**
 * The approved instructions of the active care plan. Staff with care-plan authority edit them in
 * place (by hand or with Ask AI); saving issues the next plan version with a reason and keeps the
 * previous one. Everyone else reads them.
 */
export function CareInstructions({ wound, plan, canManage, onChanged, lines = 3 }: {
  wound: WoundDetail; plan: CarePlanRecord; canManage: boolean; onChanged: () => Promise<unknown>; lines?: number;
}) {
  const next = plan.version_number + 1;
  return (
    <EditableDraft key={plan.care_plan_id} label="Care instructions" text={plan.approved_instructions} lines={lines}
      canEdit={canManage && plan.status === "ACTIVE"}
      ai={canManage ? { patientId: wound.patient_id, woundId: wound.wound_id, draftType: "care_instructions", targetId: plan.care_plan_id } : null}
      reason={{ label: "Reason for the change", hint: `Issued as version ${next}; version ${plan.version_number} is kept in the history.` }}
      saveLabel={`Issue as version ${next}`}
      onSave={async (text, { reason, aiRevisionIds }) => {
        await reviseCarePlan(wound.patient_id, wound.wound_id, {
          title: plan.title, purpose: plan.purpose, approved_instructions: text, task_frequency: plan.task_frequency,
          assigned_caregiver_subject: plan.assigned_caregiver_subject ?? "",
        }, reason, aiRevisionIds, plan.care_plan_id);
        await onChanged();
      }} />
  );
}
