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

type Device = { installed: boolean; platform: InstallPlatform; secure: boolean };

/** Settings → Profile & security: install WoundMeter when the person chooses to. Never pops up. */
export function InstallAppPanel() {
  const install = useSyncExternalStore(subscribeInstall, installState, serverInstallState);
  const [device, setDevice] = useState<Device | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setDevice({ installed: runningInstalled(), platform: installPlatform(), secure: window.isSecureContext });
  }, []);

  if (!device) return null;

  let body: React.ReactNode;
  if (device.installed) {
    body = <p className="muted-text">You&apos;re using the installed WoundMeter app.</p>;
  } else if (install.installed) {
    body = <p className="muted-text">WoundMeter is installed. Open it from your home screen or app list.</p>;
  } else if (install.prompt) {
    body = (
      <div className="install-offer">
        <p className="muted-text">Open WoundMeter like an app, in its own window, from your home screen or app list.</p>
        <button
          type="button"
          className="button primary"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            await promptInstall().catch(() => undefined);
            setBusy(false);
          }}
        >
          <Download aria-hidden="true" /> Install WoundMeter
        </button>
      </div>
    );
  } else if (!device.secure) {
    body = <p className="muted-text">Installing needs a secure (https) address. Ask your administrator for the https link.</p>;
  } else if (device.platform === "ios") {
    body = (
      <p className="muted-text install-steps">
        In Safari, tap <Share aria-hidden="true" className="inline-icon" /> <strong>Share</strong>, then <strong>Add to Home Screen</strong>.
        The installed app keeps its own sign-in, so you sign in once more there.
      </p>
    );
  } else if (device.platform === "mac-safari") {
    body = <p className="muted-text">In Safari, choose <strong>File → Add to Dock</strong>.</p>;
  } else {
    body = (
      <p className="muted-text">
        If your browser offers it, choose <strong>Install app</strong> or <strong>Add to Home screen</strong> from its menu.
        Chrome and Edge do this on Android and computers; Safari on iPhone, iPad and Mac.
      </p>
    );
  }

  return (
    <section className="panel" aria-labelledby="install-title">
      <h2 id="install-title" className="section-title">
        Install WoundMeter
      </h2>
      {body}
      {!device.installed && (
        <p className="field-hint">The app still needs a connection: patient records and photos are never stored on the device for offline use.</p>
      )}
    </section>
  );
}
