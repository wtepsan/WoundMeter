import { AlertCircle, AlertTriangle, CheckCircle2, Info, LoaderCircle } from "lucide-react";

import type { Tone } from "@/lib/care-format";

/** Status label. Always carries text so meaning never depends on colour alone. */
export function Badge({ tone = "neutral", children }: { tone?: Tone; children: React.ReactNode }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

const NOTICE_ICONS = {
  neutral: Info,
  info: Info,
  success: CheckCircle2,
  warning: AlertTriangle,
  danger: AlertCircle,
} as const;

export function Notice({
  tone = "info",
  title,
  children,
  action,
  role,
}: {
  tone?: Tone;
  title?: string;
  children?: React.ReactNode;
  action?: React.ReactNode;
  role?: "status" | "alert";
}) {
  const Icon = NOTICE_ICONS[tone];
  return (
    <div className={`notice notice-${tone}`} role={role ?? (tone === "danger" ? "alert" : "status")}>
      <Icon aria-hidden="true" className="notice-icon" />
      <div className="notice-body">
        {title && <strong>{title}</strong>}
        {children && <div>{children}</div>}
      </div>
      {action && <div className="notice-action">{action}</div>}
    </div>
  );
}

export function EmptyState({
  title,
  children,
  action,
}: {
  title: string;
  children?: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="empty-state">
      <strong>{title}</strong>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}

export function Loading({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="loading" role="status" aria-live="polite">
      <LoaderCircle className="spin" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

export function Metric({
  label,
  value,
  unit,
  hint,
}: {
  label: string;
  value: string;
  unit?: string;
  hint?: string;
}) {
  return (
    <div className="metric">
      <span className="metric-label">{label}</span>
      <span className="metric-value">
        {value}
        {unit && <span className="metric-unit">{unit}</span>}
      </span>
      {hint && <span className="metric-hint">{hint}</span>}
    </div>
  );
}
