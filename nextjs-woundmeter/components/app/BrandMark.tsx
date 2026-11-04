export const BRAND_NAME = "WoundMeter";
export const BRAND_TAGLINE = "AI-Powered Wound Measurement & Collaborative Care";

/** The WoundMeter mark: a wound outline beside an L-shaped calibration ruler (same drawing as app/icon.svg). */
export function BrandLogo({ className = "brand-logo" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 64 64" aria-hidden="true" focusable="false">
      <rect className="brand-logo-bg" width="64" height="64" rx="15" />
      <path d="M16 14v34h34" fill="none" stroke="#fff" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" />
      <path
        d="M16 23h5M16 31h5M16 39h5M25 48v-5M33 48v-5M41 48v-5"
        stroke="#fff"
        strokeWidth="3"
        strokeLinecap="round"
        opacity=".8"
      />
      <path
        className="brand-logo-wound"
        d="M27.6 31.2c-1.6-5.4 1.8-11.6 7.9-12.6 3.9-.6 5.8 1.5 8.6 1 3.9-.7 6.8 3.2 5 7.2-1.3 2.9-.9 5.6-3.9 7.9-4.6 3.5-11.4 3.1-15-.4-1.2-1.1-2.1-2-2.6-3.1z"
      />
    </svg>
  );
}

export function BrandMark({ compact = false, tagline = false }: { compact?: boolean; tagline?: boolean }) {
  return (
    <span className={`brand-mark ${compact ? "compact" : ""}`}>
      <BrandLogo />
      <span className="brand-text">
        <span className="brand-name">
          Wound<span className="brand-name-accent">Meter</span>
        </span>
        {tagline && <span className="brand-tagline">{BRAND_TAGLINE}</span>}
      </span>
    </span>
  );
}
