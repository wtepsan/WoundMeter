// The four confirmations a clinician gives before sign-off. Each is bound to the exact thing it
// confirms, so a change to that thing (a new photo, boundary, measurement version or edited
// assessment) clears it. Nothing here is ever set because a review step was completed; the server
// re-checks every confirmation and refuses the approval if one is missing.

export const APPROVAL_ATTESTATIONS = [
  { key: "photo_reviewed", label: "I have reviewed the photograph and confirmed its suitability.", item: "photograph" },
  { key: "boundary_verified", label: "I have verified or corrected the wound boundary.", item: "wound boundary" },
  { key: "measurements_reviewed", label: "I have reviewed the measurements and calibration status.", item: "measurements and calibration status" },
  { key: "assessment_reviewed", label: "I have reviewed the clinical assessment and findings.", item: "clinical assessment and findings" },
] as const;

export type AttestationKey = (typeof APPROVAL_ATTESTATIONS)[number]["key"];
/** What each confirmation covers, as a comparable fingerprint. */
export type AttestationSubjects = Record<AttestationKey, string>;
/** The subject fingerprint each confirmation was given for. */
export type Confirmations = Partial<Record<AttestationKey, string>>;
export type AttestationState = "confirmed" | "changed" | "unchecked";

export const ATTESTATION_REQUIRED_MESSAGE =
  "Clinical approval requires four confirmations. Please review the unchecked items before signing.";

export function attestationSubjects(input: {
  observationId: string;
  photoSha256: string | null | undefined;
  measurementId: string;
  measurementVersion: number;
  colourStatus: string | null | undefined;
  colourCorrectionApplied: boolean | null | undefined;
  assessment: Record<string, unknown>;
}): AttestationSubjects {
  const measurement = `${input.measurementId}:v${input.measurementVersion}`;
  return {
    photo_reviewed: `${input.observationId}:${input.photoSha256 ?? "no-photo-hash"}`,
    boundary_verified: measurement,
    measurements_reviewed: `${measurement}:colour=${input.colourStatus ?? "none"}:${input.colourCorrectionApplied ? "corrected" : "uncorrected"}`,
    // The assessment is judged against the figures on screen, so a new measurement clears it too.
    assessment_reviewed: `${measurement}:${JSON.stringify(input.assessment)}`,
  };
}

export function attestationStates(confirmed: Confirmations, subjects: AttestationSubjects): Record<AttestationKey, AttestationState> {
  return Object.fromEntries(
    APPROVAL_ATTESTATIONS.map(({ key }) => [
      key,
      confirmed[key] === undefined ? "unchecked" : confirmed[key] === subjects[key] ? "confirmed" : "changed",
    ]),
  ) as Record<AttestationKey, AttestationState>;
}

export function missingAttestations(confirmed: Confirmations, subjects: AttestationSubjects): AttestationKey[] {
  const states = attestationStates(confirmed, subjects);
  return APPROVAL_ATTESTATIONS.map(({ key }) => key).filter((key) => states[key] !== "confirmed");
}

/** The request fields: each confirmation is true only if it was given for what is on screen now. */
export function attestationPayload(confirmed: Confirmations, subjects: AttestationSubjects) {
  const states = attestationStates(confirmed, subjects);
  const attestations = Object.fromEntries(
    APPROVAL_ATTESTATIONS.map(({ key }) => [key, states[key] === "confirmed"]),
  ) as Record<AttestationKey, boolean>;
  return { attestations, reviewer_attested: Object.values(attestations).every((value) => value === true) };
}

/** Plain-language refusal naming the confirmations the server reported as missing. */
export function attestationErrorMessage(missing: unknown): string {
  const keys = Array.isArray(missing) ? missing : [];
  const items = APPROVAL_ATTESTATIONS.filter(({ key }) => keys.includes(key)).map(({ item }) => item);
  return items.length ? `${ATTESTATION_REQUIRED_MESSAGE} Not confirmed: ${items.join("; ")}.` : ATTESTATION_REQUIRED_MESSAGE;
}
