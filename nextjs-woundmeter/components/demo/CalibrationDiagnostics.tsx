"use client";

// /demo only: why a photo failed ruler calibration, drawn on the photo itself. The data comes from the
// pipeline's own detection steps (demo_measure.py `_diagnose`); nothing is stored.

export type Diagnostics = {
  code: string;
  message: string;
  stage: string | null;
  guidance: string[];
  required_ids: number[];
  width_px?: number;
  height_px?: number;
  markers: { id: number; role: "required" | "length" | "other"; corners_px: number[][]; size_px: number }[];
  crop_outline_px: number[][] | null;
  safety_margin_px?: number;
};

const CHECK_LABEL: Record<string, string> = {
  missing_marker: "Corner tags 0, 1 and 10 must all be found",
  duplicate_marker: "Each corner tag may appear only once",
  missing_length_marker: "The ruler-length tag between tags 0 and 10 must be found",
  ambiguous_length_marker: "Only one ruler-length tag may be between tags 0 and 10",
  unsupported_length_marker: "The ruler-length tag must be a supported ruler size",
  invalid_ruler_geometry: "The tags must match the printed ruler design (flat ruler, printed at 100% scale)",
  invalid_homography: "The ruler perspective must be resolvable",
  clipped_marker: "No tag may be cut off at the photo edge",
  canonical_crop_outside_image: "At least half of the measurement window must be in the photo",
  invalid_image_quality: "The photo must be sharp and evenly lit",
  insufficient_resolution: "The photo must have enough resolution",
};

const ROLE_COLOUR = { required: "#22c55e", length: "#3b82f6", other: "#9ca3af" };

export function CalibrationDiagnostics({ diagnostics: d, photo }: { diagnostics: Diagnostics; photo: string }) {
  const w = d.width_px ?? 0;
  const h = d.height_px ?? 0;
  const found = new Set(d.markers.map((m) => m.id));
  const missing = d.required_ids.filter((id) => !found.has(id));
  const length = d.markers.find((m) => m.role === "length");
  const corner = d.markers.filter((m) => m.role === "required");
  const smallest = corner.length ? Math.min(...corner.map((m) => m.size_px)) : null;
  const margin = d.safety_margin_px ?? 0;
  const outside = d.crop_outline_px?.some(([x, y]) => x < margin || y < margin || x > w - 1 - margin || y > h - 1 - margin) ?? null;
  const stroke = Math.max(2, w / 400);
  // Show the window even where it runs past the photo edge (that is often the reason it failed).
  const xs = [0, w, ...(d.crop_outline_px ?? []).map((p) => p[0])];
  const ys = [0, h, ...(d.crop_outline_px ?? []).map((p) => p[1])];
  const pad = Math.max(w, h) * 0.03;
  const view = [Math.min(...xs) - pad, Math.min(...ys) - pad, Math.max(...xs) - Math.min(...xs) + 2 * pad, Math.max(...ys) - Math.min(...ys) + 2 * pad];
  const offEdges = outside && d.crop_outline_px
    ? [d.crop_outline_px.some(([x]) => x < margin) && "left", d.crop_outline_px.some(([x]) => x > w - 1 - margin) && "right",
       d.crop_outline_px.some(([, y]) => y < margin) && "top", d.crop_outline_px.some(([, y]) => y > h - 1 - margin) && "bottom"].filter(Boolean)
    : [];
  return (
    <section className="panel diag-panel" aria-labelledby="diag-title">
      <h2 id="diag-title" className="section-title">Why this photo couldn&apos;t be calibrated</h2>
      <p className="muted-text">Demo diagnostics from the same detection steps the measurement uses.</p>
      <dl className="demo-facts">
        <div><dt>Failed check</dt><dd>{CHECK_LABEL[d.code] ?? d.code}</dd></div>
        <div><dt>Corner tags (0, 1, 10)</dt><dd>{missing.length ? `Missing: ${missing.join(", ")}` : "All found"}</dd></div>
        <div><dt>Ruler-length tag</dt><dd>{length ? `ID ${length.id} (${length.id} cm ruler)` : "Not found"}</dd></div>
        <div><dt>Smallest corner tag</dt><dd>{smallest != null ? `${Math.round(smallest)} px wide` : "—"}</dd></div>
        <div><dt>Measurement window</dt><dd>{outside == null ? "Not computed (ruler not calibrated)" : outside ? `Runs outside the photo (${offEdges.join(", ")} edge)` : "Inside the photo"}</dd></div>
      </dl>
      <p className="fine-print mono">{d.code}: {d.message}</p>
      {w > 0 && (
        <figure className="demo-figure">
          <svg viewBox={view.join(" ")} role="img" aria-label="Your photo with the detected ruler tags outlined" className="diag-svg">
            <rect x={view[0]} y={view[1]} width={view[2]} height={view[3]} fill="#374151" />
            <image href={photo} width={w} height={h} />
            <rect x={0} y={0} width={w} height={h} fill="none" stroke="#fff" strokeWidth={stroke} />
            {d.crop_outline_px && (
              <polygon points={d.crop_outline_px.map((p) => p.join(",")).join(" ")} fill="none" stroke="#f97316"
                strokeWidth={stroke * 1.5} strokeDasharray={`${stroke * 6} ${stroke * 4}`} />
            )}
            {d.markers.map((m, i) => (
              <g key={`${m.id}-${i}`}>
                <polygon points={m.corners_px.map((p) => p.join(",")).join(" ")} fill={`${ROLE_COLOUR[m.role]}33`} stroke={ROLE_COLOUR[m.role]} strokeWidth={stroke} />
                <text x={m.corners_px[0][0]} y={m.corners_px[0][1] - stroke * 3} fill={ROLE_COLOUR[m.role]} fontSize={Math.max(14, w / 45)} fontWeight="700"
                  stroke="#000" strokeWidth={stroke / 2} paintOrder="stroke">ID {m.id}</text>
              </g>
            ))}
          </svg>
          <figcaption className="field-hint">
            <span className="demo-key diag-key-required">Corner tag found</span> <span className="demo-key diag-key-length">Length tag</span>{" "}
            <span className="demo-key diag-key-other">Other tag</span> <span className="demo-key diag-key-window">Measurement window</span> · White line: photo edge
          </figcaption>
        </figure>
      )}
      {(d.guidance.length > 0 || (smallest != null && smallest < 40)) && (
        <>
          <h3 className="demo-subtitle">How to fix it</h3>
          <ul className="demo-list">
            {smallest != null && smallest < 40 && <li>The tags are small in this photo ({Math.round(smallest)} px). Move closer, or use a higher-resolution camera than a laptop webcam.</li>}
            {d.code === "canonical_crop_outside_image" && <li>Most of the square formed by the two ruler arms is outside the photo{offEdges.length ? ` (past the ${offEdges.join(" and ")} edge)` : ""}. Step back and hold the camera square-on. When photographing a screen, zoom the picture out so nothing is cut off.</li>}
            {d.code === "invalid_ruler_geometry" && <li>Check the ruler is flat (not bent around the body) and was printed at 100% scale, not “Fit to page”.</li>}
            {d.guidance.map((g) => <li key={g}>{g}</li>)}
          </ul>
        </>
      )}
    </section>
  );
}
