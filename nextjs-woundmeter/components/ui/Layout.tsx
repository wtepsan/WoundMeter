import { ArrowLeft, Check, ChevronDown } from "lucide-react";

export function PageHeader({
  title,
  subtitle,
  back,
  actions,
  meta,
}: {
  title: string;
  subtitle?: React.ReactNode;
  back?: { label: string; onClick: () => void };
  actions?: React.ReactNode;
  meta?: React.ReactNode;
}) {
  return (
    <header className="page-header">
      {back && (
        <button type="button" className="link-button back-link" onClick={back.onClick}>
          <ArrowLeft aria-hidden="true" />
          {back.label}
        </button>
      )}
      <div className="page-header-row">
        <div className="page-header-text">
          <h1>{title}</h1>
          {subtitle && <p>{subtitle}</p>}
          {meta && <div className="page-header-meta">{meta}</div>}
        </div>
        {actions && <div className="page-header-actions">{actions}</div>}
      </div>
    </header>
  );
}

/** Collapsed-by-default secondary information (progressive disclosure). */
export function Disclosure({
  title,
  summary,
  children,
  defaultOpen = false,
  id,
}: {
  title: string;
  summary?: React.ReactNode;
  children: React.ReactNode;
  defaultOpen?: boolean;
  id?: string;
}) {
  return (
    <details className="disclosure" open={defaultOpen} id={id}>
      <summary>
        <span className="disclosure-title">{title}</span>
        {summary && <span className="disclosure-summary">{summary}</span>}
        <ChevronDown aria-hidden="true" className="disclosure-chevron" />
      </summary>
      <div className="disclosure-body">{children}</div>
    </details>
  );
}

export function Stepper({
  steps,
  current,
  onSelect,
  label = "Progress",
}: {
  steps: string[];
  current: number;
  /** Only completed steps are selectable, so users can go back but not skip ahead. */
  onSelect?: (index: number) => void;
  label?: string;
}) {
  return (
    <nav aria-label={label}>
      <ol className="stepper">
        {steps.map((step, index) => {
          const state = index < current ? "done" : index === current ? "current" : "upcoming";
          const content = (
            <>
              <span className="stepper-index" aria-hidden="true">
                {state === "done" ? <Check /> : index + 1}
              </span>
              <span className="stepper-label">{step}</span>
              {state === "done" && <span className="sr-only">(completed)</span>}
            </>
          );
          return (
            <li key={step} className={`stepper-item ${state}`} aria-current={state === "current" ? "step" : undefined}>
              {state === "done" && onSelect ? (
                <button type="button" className="stepper-button" onClick={() => onSelect(index)}>
                  {content}
                </button>
              ) : (
                <span className="stepper-button">{content}</span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

/** Labelled radio group rendered as segmented buttons (large touch targets). */
export function ChoiceGroup<T extends string | number>({
  legend,
  options,
  value,
  onChange,
  name,
  hint,
}: {
  legend: string;
  options: Array<{ value: T; label: string }>;
  value: T | null;
  onChange: (value: T) => void;
  name: string;
  hint?: string;
}) {
  return (
    <fieldset className="choice-group">
      <legend>{legend}</legend>
      {hint && <p className="field-hint">{hint}</p>}
      <div className="choice-options">
        {options.map((opt) => (
          <label key={String(opt.value)} className={`choice ${value === opt.value ? "selected" : ""}`}>
            <input
              type="radio"
              name={name}
              value={String(opt.value)}
              checked={value === opt.value}
              onChange={() => onChange(opt.value)}
            />
            <span>{opt.label}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
