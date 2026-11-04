"use client";

import { ChevronRight } from "lucide-react";

import type { Navigate, View } from "@/components/app/AppShell";
import { viewToHash } from "@/lib/routes";

export type Crumb = { label: React.ReactNode; view?: View };

/**
 * Where this screen sits: Patients › patient › wound › record. Each step is a real link, so it can be
 * opened in a new tab; a plain click navigates inside the app (and asks first if edits are unsaved).
 */
export function Breadcrumbs({ items, navigate }: { items: Crumb[]; navigate: Navigate }) {
  return (
    <nav className="breadcrumbs" aria-label="Breadcrumb">
      <ol>
        {items.map((item, index) => {
          const last = index === items.length - 1;
          return (
            <li key={index}>
              {item.view && !last ? (
                <a href={viewToHash(item.view)} onClick={(e) => {
                  if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
                  e.preventDefault();
                  navigate(item.view!);
                }}>{item.label}</a>
              ) : <span aria-current={last ? "page" : undefined}>{item.label}</span>}
              {!last && <ChevronRight aria-hidden="true" className="breadcrumb-sep" />}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
