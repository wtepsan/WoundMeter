"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { Download, Share } from "lucide-react";

import {
  installPlatform,
  installState,
  promptInstall,
  runningInstalled,
  serverInstallState,
  subscribeInstall,
  type InstallPlatform,
} from "@/lib/pwa-install";

/**
 * A small "Install app" button at the bottom of every page. Uses the browser's own install prompt where it
 * exists (Chrome, Edge), shows the steps on Safari, and hides itself once WoundMeter is installed.
 */
export function InstallAppButton() {
  const install = useSyncExternalStore(subscribeInstall, installState, serverInstallState);
  const [device, setDevice] = useState<{ installed: boolean; platform: InstallPlatform; secure: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [showSteps, setShowSteps] = useState(false);
  useEffect(() => {
    setDevice({ installed: runningInstalled(), platform: installPlatform(), secure: window.isSecureContext });
  }, []);

  if (!device || device.installed || install.installed || !device.secure) return null;
  const safari = device.platform === "ios" || device.platform === "mac-safari";
  if (!install.prompt && !safari) return null;

  return (
    <div className="install-footer">
      <button
        type="button"
        className="button ghost small"
        disabled={busy}
        aria-expanded={install.prompt ? undefined : showSteps}
        onClick={async () => {
          if (!install.prompt) return setShowSteps((v) => !v);
          setBusy(true);
          await promptInstall().catch(() => undefined);
          setBusy(false);
        }}
      >
        <Download aria-hidden="true" /> Install WoundMeter app
      </button>
      {showSteps && !install.prompt && (
        <p className="fine-print">
          {device.platform === "ios"
            ? <>In Safari, tap <Share aria-hidden="true" className="inline-icon" /> <strong>Share</strong>, then <strong>Add to Home Screen</strong>.</>
            : <>In Safari, choose <strong>File → Add to Dock</strong>.</>}
        </p>
      )}
    </div>
  );
}
