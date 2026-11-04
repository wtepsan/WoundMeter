"use client";

import { Children, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";

type Edges = { overflow: boolean; atStart: boolean; atEnd: boolean };

/**
 * One row of wound cards. When the cards are wider than the page the row scrolls sideways (trackpad,
 * touch, Shift + wheel, keyboard focus or the arrows), and scrolling only moves the row: a wound is
 * selected by clicking its card, never by scrolling. The selected card (`.is-selected`) is brought into
 * view when it changes, when the row first appears, after Back/Forward and after a reload.
 */
export function WoundCarousel({ label, selectedId, title, actions, empty, children }: {
  label: string; selectedId: string | null; title?: React.ReactNode; actions?: React.ReactNode;
  /** Shown in place of the row when there are no cards. */
  empty?: React.ReactNode; children: React.ReactNode;
}) {
  const track = useRef<HTMLDivElement>(null);
  const shown = useRef(false);
  const [edges, setEdges] = useState<Edges>({ overflow: false, atStart: true, atEnd: true });
  const count = Children.count(children);
  const hasCards = count > 0;

  const measure = useCallback(() => {
    const el = track.current;
    if (!el) return;
    const max = el.scrollWidth - el.clientWidth;
    const next = { overflow: max > 1, atStart: el.scrollLeft <= 1, atEnd: el.scrollLeft >= max - 1 };
    setEdges((prev) => (prev.overflow === next.overflow && prev.atStart === next.atStart && prev.atEnd === next.atEnd ? prev : next));
  }, []);

  // Positions are measured from the row's own padding, so a card lands just inside the edge, focus ring included.
  const scrollRow = useCallback((target: (el: HTMLDivElement, gutter: number) => number | null, behavior?: ScrollBehavior) => {
    const el = track.current;
    if (!el) return;
    const left = target(el, parseFloat(getComputedStyle(el).paddingLeft) || 0);
    if (left != null) el.scrollTo({ left, behavior });
  }, []);

  const reveal = useCallback((behavior?: ScrollBehavior) => scrollRow((el, gutter) => {
    const card = el.querySelector<HTMLElement>(":scope > .is-selected");
    if (!card) return null;
    const start = card.offsetLeft - gutter;
    const end = card.offsetLeft + card.offsetWidth + gutter - el.clientWidth;
    return start < el.scrollLeft ? start : end > el.scrollLeft ? end : null;
  }, behavior), [scrollRow]);

  // Next: the first card cut off on the right becomes the first card. Previous: the last card cut off
  // on the left becomes the last card. Either way whole cards line up with the edges.
  const page = (direction: 1 | -1) => scrollRow((el, gutter) => {
    const cards = Array.from(el.children) as HTMLElement[];
    if (direction > 0) {
      const next = cards.find((c) => c.offsetLeft + c.offsetWidth + gutter > el.scrollLeft + el.clientWidth + 1);
      return next ? next.offsetLeft - gutter : null;
    }
    const prev = cards.reverse().find((c) => c.offsetLeft - gutter < el.scrollLeft - 1);
    return prev ? prev.offsetLeft + prev.offsetWidth + gutter - el.clientWidth : null;
  });

  useLayoutEffect(() => {
    reveal(shown.current ? undefined : "instant");
    shown.current = true;
  }, [selectedId, reveal]);

  useEffect(measure, [count, measure]);

  useEffect(() => {
    const el = track.current;
    if (!el) return;
    let width = el.clientWidth;
    const resize = new ResizeObserver(() => {
      // A row that was hidden (inside a closed disclosure) shows its selected card when it opens.
      if (width === 0 && el.clientWidth > 0) reveal("instant");
      width = el.clientWidth;
      measure();
    });
    resize.observe(el);
    // The row clips anything that leaves it, so a card's ⋯ menu is placed against the window instead. It
    // follows its button while the row or the page scrolls, and closes once the button leaves the row.
    const place = (menu: HTMLDetailsElement) => {
      const summary = menu.querySelector(":scope > summary");
      const panel = menu.querySelector<HTMLElement>(".dropdown-panel");
      if (!summary || !panel) return;
      const box = summary.getBoundingClientRect();
      const row = el.getBoundingClientRect();
      const middle = (box.left + box.right) / 2;
      if (menu.open && (middle < row.left || middle > row.right)) menu.open = false;
      Object.assign(panel.style, { position: "fixed", top: `${box.bottom + 6}px`, right: `${document.documentElement.clientWidth - box.right}px`, left: "auto" });
    };
    const placeOpen = () => el.querySelectorAll<HTMLDetailsElement>("details[open]").forEach(place);
    const onClick = (event: MouseEvent) => {
      const menu = (event.target as Element).closest("summary")?.parentElement;
      if (menu instanceof HTMLDetailsElement) place(menu);
    };
    const onScroll = () => { measure(); placeOpen(); };
    el.addEventListener("click", onClick, true);
    el.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("scroll", placeOpen, { passive: true });
    window.addEventListener("resize", placeOpen);
    return () => {
      resize.disconnect();
      el.removeEventListener("click", onClick, true);
      el.removeEventListener("scroll", onScroll);
      window.removeEventListener("scroll", placeOpen);
      window.removeEventListener("resize", placeOpen);
    };
  }, [hasCards, measure, reveal]); // the row itself appears with the first card

  const arrows = hasCards && edges.overflow && (
    <div className="carousel-arrows">
      <button type="button" className="carousel-arrow" aria-label={`Scroll ${label.toLowerCase()} left`} disabled={edges.atStart} onClick={() => page(-1)}>
        <ChevronLeft aria-hidden="true" />
      </button>
      <button type="button" className="carousel-arrow" aria-label={`Scroll ${label.toLowerCase()} right`} disabled={edges.atEnd} onClick={() => page(1)}>
        <ChevronRight aria-hidden="true" />
      </button>
    </div>
  );

  return (
    <div className="wound-carousel">
      {(title || actions || arrows) && (
        <div className="section-head">
          {title}
          <div className="wound-carousel-tools">{arrows}{actions}</div>
        </div>
      )}
      {!hasCards ? empty : <div ref={track} className="wound-track" role="group" aria-label={label}>{children}</div>}
    </div>
  );
}
