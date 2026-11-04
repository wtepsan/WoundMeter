"use client";

import { useEffect, useRef, useState } from "react";

/** Text limited to a few lines, with Show more / Show less when it is longer. */
export function ClampedText({ text, lines = 3, className = "" }: { text: string; lines?: number; className?: string }) {
  const ref = useRef<HTMLParagraphElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => setOverflowing(expanded || element.scrollHeight > element.clientHeight + 1);
    measure();
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null;
    observer?.observe(element);
    return () => observer?.disconnect();
  }, [text, lines, expanded]);

  return (
    <div className={`clamped ${className}`}>
      <p ref={ref} className="clamped-text" style={expanded ? undefined : { WebkitLineClamp: lines }} data-expanded={expanded || undefined}>
        {text}
      </p>
      {overflowing && (
        <button type="button" className="link-button clamped-toggle" aria-expanded={expanded} onClick={() => setExpanded((v) => !v)}>
          {expanded ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  );
}
