"use client";

import { useState } from "react";

import { formatDate } from "@/lib/care-format";

export type TrendPoint = { date: string; area: number };

const W = 560;
const H = 180;
const PAD = { top: 24, right: 56, bottom: 30, left: 40 };

function niceMax(value: number): number {
  if (value <= 0) return 1;
  const exp = 10 ** Math.floor(Math.log10(value));
  const steps = [1, 2, 2.5, 5, 10];
  const scaled = value / exp;
  return (steps.find((s) => s >= scaled) ?? 10) * exp;
}

/** Single-series line of clinician-approved areas, one point per approved visit. */
export function AreaTrendChart({ points, title = "Approved wound area (cm²)" }: { points: TrendPoint[]; title?: string }) {
  const [active, setActive] = useState<number | null>(null);
  if (points.length === 0) return null;

  const yMax = niceMax(Math.max(...points.map((p) => p.area)) * 1.1);
  const ticks = [0, yMax / 2, yMax];
  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;
  const x = (i: number) => PAD.left + (points.length === 1 ? innerW / 2 : (i / (points.length - 1)) * innerW);
  const y = (v: number) => PAD.top + innerH - (v / yMax) * innerH;
  const line = points.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p.area).toFixed(1)}`).join(" ");
  const area = `${line} L${x(points.length - 1).toFixed(1)},${y(0)} L${x(0).toFixed(1)},${y(0)} Z`;
  const last = points.length - 1;

  return (
    <figure className="trend-chart">
      <figcaption className="trend-title">{title}</figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${title}: ${points.map((p) => `${formatDate(p.date)} ${p.area.toFixed(2)}`).join(", ")}`}>
        {ticks.map((t) => (
          <g key={t}>
            <line className="trend-grid" x1={PAD.left} x2={W - PAD.right} y1={y(t)} y2={y(t)} />
            <text className="trend-axis" x={PAD.left - 8} y={y(t)} textAnchor="end" dominantBaseline="middle">
              {Number.isInteger(t) ? t : t.toFixed(1)}
            </text>
          </g>
        ))}
        {points.length > 1 && <path className="trend-area" d={area} />}
        {points.length > 1 && <path className="trend-line" d={line} />}
        {points.map((p, i) => (
          <g
            key={`${p.date}-${i}`}
            className="trend-point"
            tabIndex={0}
            aria-label={`${formatDate(p.date)}: ${p.area.toFixed(2)} cm²`}
            onMouseEnter={() => setActive(i)}
            onMouseLeave={() => setActive(null)}
            onFocus={() => setActive(i)}
            onBlur={() => setActive(null)}
          >
            <circle className="trend-hit" cx={x(i)} cy={y(p.area)} r={14} />
            <circle className="trend-dot" cx={x(i)} cy={y(p.area)} r={active === i ? 6 : 4.5} />
            {(points.length <= 6 || i === 0 || i === last) && (
              <text className="trend-axis" x={x(i)} y={H - 8} textAnchor="middle">
                {formatDate(p.date).replace(/ \d{4}$/, "")}
              </text>
            )}
          </g>
        ))}
        {active === null && (
          <text className="trend-label" x={x(last) + 10} y={y(points[last].area)} dominantBaseline="middle">
            {points[last].area.toFixed(2)}
          </text>
        )}
        {active !== null && (
          <g className="trend-tooltip" pointerEvents="none">
            <rect
              x={Math.min(Math.max(x(active) - 62, 2), W - 126)}
              y={Math.max(y(points[active].area) - 46, 0)}
              width={124}
              height={36}
              rx={6}
            />
            <text
              x={Math.min(Math.max(x(active), 64), W - 64)}
              y={Math.max(y(points[active].area) - 33, 13)}
              textAnchor="middle"
            >
              {formatDate(points[active].date)}
            </text>
            <text
              className="trend-tooltip-value"
              x={Math.min(Math.max(x(active), 64), W - 64)}
              y={Math.max(y(points[active].area) - 17, 29)}
              textAnchor="middle"
            >
              {points[active].area.toFixed(2)} cm²
            </text>
          </g>
        )}
      </svg>
      <table className="sr-only">
        <caption>{title}</caption>
        <thead>
          <tr>
            <th scope="col">Date</th>
            <th scope="col">Area (cm²)</th>
          </tr>
        </thead>
        <tbody>
          {points.map((p, i) => (
            <tr key={`${p.date}-${i}`}>
              <td>{formatDate(p.date)}</td>
              <td>{p.area.toFixed(2)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}
