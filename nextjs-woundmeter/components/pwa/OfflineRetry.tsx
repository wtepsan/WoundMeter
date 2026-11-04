"use client";

import { useEffect } from "react";
import { RotateCw } from "lucide-react";

import { checkConnection } from "@/lib/care-api";

const RECHECK_MS = 10_000;

/**
 * Try again on the offline page. A plain link, so it works even before scripts load; it opens
 * the app's start page, because the address bar may show /offline rather than the page asked for.
 */
export function OfflineRetry() {
  useEffect(() => {
    // Nothing on this page can be lost, so return to the app as soon as WoundMeter answers:
    // when the device reconnects, and every few seconds while the page is on screen (the
    // server, not the device, may have been the problem).
    let left = false;
    const retry = async () => {
      if (!left && (await checkConnection())) {
        left = true;
        window.location.assign("/");
      }
    };
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void retry();
    }, RECHECK_MS);
    window.addEventListener("online", retry);
    return () => {
      left = true;
      window.clearInterval(timer);
      window.removeEventListener("online", retry);
    };
  }, []);

  return (
    // eslint-disable-next-line @next/next/no-html-link-for-pages -- a full page load is the retry; client routing would stay on this page
    <a className="button primary" href="/">
      <RotateCw aria-hidden="true" /> Try again
    </a>
  );
}
