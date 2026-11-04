"use client";

import { useState } from "react";
import { Download, ImageUp } from "lucide-react";

/**
 * Three ruler photos of one wound healing over time, for trying WoundMeter without a printed ruler.
 * They are adapted, credited figures (CC BY 4.0), never patient data.
 */
export const SAMPLE_PHOTOS = [
  { src: "/samples/sample-a-open-wound.png", label: "A · Open wound", note: "Baseline: large open wound" },
  { src: "/samples/sample-b-small-wound.png", label: "B · Small wound", note: "Week 4: narrow open slit" },
  { src: "/samples/sample-c-healed.png", label: "C · Healed", note: "Week 8: closed scar (tests “No visible wound”)" },
] as const;

export function SampleCredit() {
  return (
    <p className="fine-print">
      Images adapted from Jia et al. (2026), Figure 3, with the WoundMeter ruler added. Licensed under{" "}
      <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noreferrer">CC BY 4.0</a>. Source:{" "}
      <a href="https://doi.org/10.3389/fmed.2026.1776438" target="_blank" rel="noreferrer">doi.org/10.3389/fmed.2026.1776438</a>.
    </p>
  );
}

/** Sample photos to download, or (with `onUse`) to measure straight away. */
export function SamplePhotos({ onUse, disabled = false }: { onUse?: (file: File) => void; disabled?: boolean }) {
  const [loading, setLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const use = async (src: string) => {
    if (!onUse) return;
    setLoading(src);
    setError(null);
    try {
      const res = await fetch(src);
      if (!res.ok) throw new Error();
      const blob = await res.blob();
      onUse(new File([blob], src.split("/").pop() ?? "sample.png", { type: blob.type || "image/png" }));
    } catch {
      setError("The sample photo could not be loaded. Download it and upload it instead.");
    } finally {
      setLoading(null);
    }
  };
  return (
    <div className="sample-photos">
      <ul className="sample-grid">
        {SAMPLE_PHOTOS.map((photo) => (
          <li key={photo.src} className="sample-card">
            {/* eslint-disable-next-line @next/next/no-img-element -- small static thumbnails, also offered as downloads */}
            <img src={photo.src} alt={`Sample ruler photo ${photo.label}`} className="sample-thumb" loading="lazy" />
            <span className="sample-label"><strong>{photo.label}</strong><span className="fine-print">{photo.note}</span></span>
            <span className="button-row">
              {onUse && (
                <button type="button" className="button secondary small" disabled={disabled || loading !== null} onClick={() => void use(photo.src)}>
                  <ImageUp aria-hidden="true" /> {loading === photo.src ? "Loading…" : "Use this photo"}
                </button>
              )}
              <a className="button ghost small" href={photo.src} download>
                <Download aria-hidden="true" /> Download
              </a>
            </span>
          </li>
        ))}
      </ul>
      {error && <p className="danger-text" role="alert">{error}</p>}
      <SampleCredit />
    </div>
  );
}
