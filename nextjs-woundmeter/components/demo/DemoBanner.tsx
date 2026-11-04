import { DEMO_MODE } from "@/lib/accounts";

/** Shown on every screen of a demo build. */
export function DemoBanner() {
  if (!DEMO_MODE) return null;
  return (
    <div className="demo-banner" role="status">
      <strong>Demo mode — do not enter real patient data.</strong>
    </div>
  );
}
