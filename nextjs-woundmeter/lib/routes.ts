// Address of each screen, so the browser's Back/Forward, reloads and shared links keep the patient
// and wound context. The hash is never sent to the server; it carries internal record IDs only (no
// names or identifiers), and every record is still authorised by the API when it is opened.
// Loaded by unit tests through a plain TypeScript transpile: type-only imports from "@/" only.

import type { View } from "@/components/app/AppShell";

const SETTINGS = ["account", "sharing", "users", "organisations", "audit"] as const;
const SIMPLE: Record<string, View["name"]> = { reviews: "queue", ward: "ward", demo: "demo", submit: "submit", "care-plan": "careplan", studio: "studio", evidence: "evidence" };
const ID = /^[A-Za-z0-9_.-]{1,80}$/;

const seg = (value: string) => encodeURIComponent(value);

export function viewToHash(view: View): string {
  switch (view.name) {
    case "home": return "#/";
    case "patients": return "#/patients";
    case "register": return "#/patients/new";
    case "patient":
      return view.woundId ? `#/patients/${seg(view.patientId)}/wounds/${seg(view.woundId)}` : `#/patients/${seg(view.patientId)}`;
    case "new-wound": return `#/patients/${seg(view.patientId)}/wounds/new`;
    case "new-observation":
      return view.woundId ? `#/patients/${seg(view.patientId)}/wounds/${seg(view.woundId)}/measures/new` : `#/patients/${seg(view.patientId)}/measures/new`;
    case "review": return `#/patients/${seg(view.patientId)}/records/${seg(view.observationId)}`;
    case "nursing-assessment":
      return `#/patients/${seg(view.patientId)}/admissions/${seg(view.admissionId)}/assessments/${seg(view.assessmentType)}`;
    case "admission-report": return `#/patients/${seg(view.patientId)}/admissions/${seg(view.admissionId)}/report`;
    case "account": case "sharing": case "users": case "organisations": case "audit": return `#/settings/${view.name}`;
    case "queue": return "#/reviews";
    case "careplan": return "#/care-plan";
    default: return `#/${view.name}`;
  }
}

/** The screen a hash points at, or null when it is not a WoundMeter address (the caller shows Home). */
export function hashToView(hash: string): View | null {
  let parts: string[];
  try {
    parts = hash.replace(/^#\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
  } catch {
    return null;
  }
  if (parts.length === 0) return { name: "home" };
  const [first, ...rest] = parts;
  if (first === "settings") {
    const section = SETTINGS.find((s) => s === rest[0]);
    return section && rest.length === 1 ? { name: section } : null;
  }
  if (first !== "patients") return rest.length === 0 && SIMPLE[first] ? ({ name: SIMPLE[first] } as View) : null;
  if (rest.length === 0) return { name: "patients" };
  if (rest.length === 1 && rest[0] === "new") return { name: "register" };
  const [patientId, kind, id, sub, subId, extra] = rest;
  if (!ID.test(patientId) || patientId === "new") return null;
  if (!kind) return { name: "patient", patientId };
  if (kind === "measures" && id === "new" && !sub) return { name: "new-observation", patientId };
  if (kind === "records" && id && ID.test(id) && !sub) return { name: "review", patientId, observationId: id };
  if (kind === "wounds" && id === "new" && !sub) return { name: "new-wound", patientId };
  if (kind === "wounds" && id && ID.test(id)) {
    if (!sub) return { name: "patient", patientId, woundId: id };
    if (sub === "measures" && subId === "new" && !extra) return { name: "new-observation", patientId, woundId: id };
    return null;
  }
  if (kind === "admissions" && id && ID.test(id)) {
    if (sub === "report" && !subId) return { name: "admission-report", patientId, admissionId: id };
    if (sub === "assessments" && subId && ID.test(subId) && !extra) return { name: "nursing-assessment", patientId, admissionId: id, assessmentType: subId };
  }
  return null;
}
