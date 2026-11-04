"use client";

import { useEffect } from "react";
import "@/lib/pwa-install";

const WORKER_PATH = "/sw.js";
// Changes with every production build, so each build installs a fresh worker and offline cache.
const BUILD = process.env.NEXT_PUBLIC_WOUNDMETER_BUILD ?? "unversioned";

function isOurs(registration: ServiceWorkerRegistration) {
  const worker = registration.active ?? registration.waiting ?? registration.installing;
  return worker ? new URL(worker.scriptURL).pathname === WORKER_PATH : false;
}

export function PwaRegistration() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    if (process.env.NODE_ENV !== "production") {
      // A worker installed by a production preview can still control next dev.
      // Remove only this application's worker/caches; never reload an open form.
      void navigator.serviceWorker.getRegistrations().then(async (registrations) => {
        for (const registration of registrations) {
          if (isOurs(registration)) await registration.unregister();
        }
        const keys = await caches.keys();
        await Promise.all(keys.filter((key) => /^(woundmeter|woundwise)-/.test(key)).map((key) => caches.delete(key)));
      }).catch(() => undefined);
      return;
    }
    const register = () => {
      navigator.serviceWorker
        .register(`${WORKER_PATH}?build=${encodeURIComponent(BUILD)}`, { scope: "/", updateViaCache: "none" })
        .catch(() => undefined);
    };
    if (document.readyState === "complete") {
      register();
      return;
    }
    window.addEventListener("load", register, { once: true });
    return () => window.removeEventListener("load", register);
  }, []);

  return null;
}
