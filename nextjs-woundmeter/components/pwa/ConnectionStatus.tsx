"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { WifiOff } from "lucide-react";

import { checkConnection, serverReachable, subscribeConnection } from "@/lib/care-api";

/**
 * Shown while WoundMeter's server can't be reached. Nothing is measured, saved or signed then;
 * screens keep what is already loaded and typed, and every action reports that it wasn't sent.
 */
export function ConnectionStatus() {
  const reachable = useSyncExternalStore(subscribeConnection, serverReachable, () => true);
  const [checking, setChecking] = useState(false);
  const banner = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const check = () => void checkConnection();
    const onVisible = () => {
      if (document.visibilityState === "visible" && !serverReachable()) check();
    };
    window.addEventListener("online", check);
    window.addEventListener("offline", check);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("online", check);
      window.removeEventListener("offline", check);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  // In the sticky header the banner adds height; sticky content below moves down by as much.
  useEffect(() => {
    const element = banner.current;
    if (!element?.closest(".topbar")) return;
    const root = document.documentElement;
    const update = () => root.style.setProperty("--connection-banner-h", `${element.offsetHeight}px`);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => {
      observer.disconnect();
      root.style.removeProperty("--connection-banner-h");
    };
  }, [reachable]);

  // Read during render: the banner never exists on the server or during hydration.
  const deviceOffline = !reachable && !navigator.onLine;

  return (
    <div className="connection-region" role="status" aria-live="polite">
      {!reachable && (
        <div className="connection-banner" ref={banner}>
          <WifiOff aria-hidden="true" />
          <p>
            <strong>{deviceOffline ? "You're offline." : "Can't reach WoundMeter."}</strong> Nothing can be measured, saved or
            signed until the connection returns. What you entered stays on this screen.
          </p>
          <button
            type="button"
            className="button secondary small"
            disabled={checking}
            onClick={async () => {
              setChecking(true);
              await checkConnection();
              setChecking(false);
            }}
          >
            {checking ? "Checking…" : "Try again"}
          </button>
        </div>
      )}
    </div>
  );
}
