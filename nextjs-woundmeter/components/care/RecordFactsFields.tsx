"use client";

import { ChoiceGroup } from "@/components/ui/Layout";

export type RecordFacts = {
  pain_score_0_10: number | null;
  drainage_level: string | null;
  dressing_condition: string | null;
  redness_observed: string | null;
  concern_reported: boolean;
  non_diagnostic_notes: string;
};

/** `introduced`: the host already explains the questions under its own heading, so the legend is for screen readers only. */
export function RecordFactsFields({ value, onChange, disabled = false, introduced = false }: {
  value: RecordFacts; onChange: (value: RecordFacts) => void; disabled?: boolean; introduced?: boolean;
}) {
  const set = <K extends keyof RecordFacts>(key: K, next: RecordFacts[K]) => onChange({ ...value, [key]: next });
  const options = (values: string[]) => values.map((v) => ({ value: v, label: v.charAt(0) + v.slice(1).toLowerCase() }));
  return <fieldset className="clean-fieldset" disabled={disabled}>
    <legend className={introduced ? "sr-only" : "section-title"}>Factual observations</legend>
    {!introduced && <p className="fine-print">Describe what you notice. Clinical conclusions are recorded separately.</p>}
    <ChoiceGroup legend="Pain right now" name="pain" value={value.pain_score_0_10} options={Array.from({ length: 11 }, (_, i) => ({ value: i, label: String(i) }))} onChange={(v) => set("pain_score_0_10", v)} />
    <ChoiceGroup legend="Visible drainage (fluid)" name="drainage" value={value.drainage_level} options={options(["NONE", "SMALL", "MODERATE", "LARGE", "UNSURE"])} onChange={(v) => set("drainage_level", v)} />
    <ChoiceGroup legend="Dressing condition" name="dressing" value={value.dressing_condition} options={options(["INTACT", "LOOSE", "WET", "OTHER", "UNSURE"])} onChange={(v) => set("dressing_condition", v)} />
    <ChoiceGroup legend="Redness around the wound" name="redness" value={value.redness_observed} options={options(["YES", "NO", "UNSURE"])} onChange={(v) => set("redness_observed", v)} />
    <div className="field"><label htmlFor="record-factual-notes">Other observations (optional)</label>
      <textarea id="record-factual-notes" value={value.non_diagnostic_notes} rows={2} onChange={(e) => set("non_diagnostic_notes", e.target.value)} />
    </div>
    <label className="checkbox-row"><input type="checkbox" checked={value.concern_reported} onChange={(e) => set("concern_reported", e.target.checked)} />Report a concern — I would like the care team to look at this sooner.</label>
  </fieldset>;
}
