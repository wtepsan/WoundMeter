"use client";

import { Badge } from "@/components/ui/Feedback";
import { Disclosure } from "@/components/ui/Layout";
import { humanize, type Tone } from "@/lib/care-format";
import type { ColourCalibration, ColourStatus } from "@/lib/care-types";

const STATUS: Record<ColourStatus, { label: string; tone: Tone; help: string }> = {
  COLOUR_CALIBRATED: { label: "Colour calibrated", tone: "success", help: "Corrected against verified patch colours." },
  UNVERIFIED_REFERENCE: {
    label: "Experimental colour correction",
    tone: "warning",
    help: "Corrected against the ruler artwork's design colours, which have not been measured on the printed ruler.",
  },
  COLOUR_REVIEW_REQUIRED: { label: "Colour needs review", tone: "warning", help: "Residual colour error is above the threshold." },
  COLOUR_CALIBRATION_FAILED: { label: "Colour not calibrated", tone: "neutral", help: "Colour strip missing, covered or unreadable." },
  NOT_CONFIGURED: { label: "Colour not calibrated", tone: "neutral", help: "No colour-strip layout for this ruler." },
  not_attempted: { label: "Colour not checked", tone: "neutral", help: "" },
};

/** Colour reference strip result. Spatial calibration (the measurement) does not depend on it. */
export function ColourCalibrationCard({ colour }: { colour: ColourCalibration | null | undefined }) {
  if (!colour) {
    return (
      <section>
        <h3>Colour</h3>
        <p className="muted-text">Not recorded for this photo (taken before colour calibration was added).</p>
      </section>
    );
  }
  const status = STATUS[colour.status] ?? STATUS.not_attempted;
  return (
    <section aria-label="Colour calibration">
      <h3>Colour</h3>
      <p>
        <Badge tone={status.tone}>{status.label}</Badge>
      </p>
      <p className="fine-print">{status.help} The measurement uses the AprilTags only and is not affected.</p>
      {colour.correction_applied && (
        <dl className="fact-list">
          <div>
            <dt>Patches used</dt>
            <dd>{colour.patches_found} of {colour.patches.length}</dd>
          </div>
          <div>
            <dt>Colour error ΔE00</dt>
            <dd>
              {colour.mean_delta_e00_before?.toFixed(1)} → {colour.mean_delta_e00_after?.toFixed(1)}
              {colour.reference_status !== "VERIFIED" && " (vs design colours)"}
            </dd>
          </div>
        </dl>
      )}
      {!colour.colour_interpretation_allowed && (
        <p className="fine-print">AI colour-based descriptions are switched off for this photo.</p>
      )}
      <Disclosure title="Colour patches" summary={`${humanize(colour.method ?? "not applied")}`}>
        <table className="data-table">
          <thead>
            <tr>
              <th scope="col">Patch</th>
              <th scope="col">ΔE00 before</th>
              <th scope="col">After</th>
              <th scope="col">Note</th>
            </tr>
          </thead>
          <tbody>
            {colour.patches.map((patch) => (
              <tr key={patch.name}>
                <td>
                  <span
                    className="legend-swatch"
                    aria-hidden="true"
                    style={{ background: patch.observed_srgb ? `rgb(${patch.observed_srgb.join(",")})` : "transparent" }}
                  />{" "}
                  {humanize(patch.name)}
                </td>
                <td>{patch.delta_e00_before?.toFixed(1) ?? "—"}</td>
                <td>{patch.delta_e00_after?.toFixed(1) ?? "—"}</td>
                <td>{patch.issue ? humanize(patch.issue) : patch.found ? "" : "Not found"}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {colour.warnings.map((warning) => (
          <p className="fine-print" key={warning}>{warning}</p>
        ))}
        {colour.profile_version && <p className="fine-print">Profile {colour.profile_version}.</p>}
      </Disclosure>
    </section>
  );
}
