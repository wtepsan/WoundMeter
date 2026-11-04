// Installing WoundMeter as an app. Chrome, Edge and Samsung Internet offer installation once,
// early, through a beforeinstallprompt event. It is kept here so Settings can offer Install
// when the person asks, instead of the browser interrupting them; Safari has no such event.

export type InstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

export type InstallState = { prompt: InstallPromptEvent | null; installed: boolean };

let state: InstallState = { prompt: null, installed: false };
const listeners = new Set<() => void>();
const SERVER_STATE: InstallState = { prompt: null, installed: false };

function update(next: Partial<InstallState>) {
  state = { ...state, ...next };
  listeners.forEach((listener) => listener());
}

// Listen as soon as this module loads (from the root layout), before the event can be missed.
if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    update({ prompt: event as InstallPromptEvent });
  });
  window.addEventListener("appinstalled", () => update({ prompt: null, installed: true }));
}

export function subscribeInstall(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export const installState = () => state;
export const serverInstallState = () => SERVER_STATE;

/** Shows the browser's own install dialog. The event can be used only once. */
export async function promptInstall(): Promise<"accepted" | "dismissed" | "unavailable"> {
  const { prompt } = state;
  if (!prompt) return "unavailable";
  update({ prompt: null });
  await prompt.prompt();
  const { outcome } = await prompt.userChoice;
  if (outcome === "accepted") update({ installed: true });
  return outcome;
}

/** True inside the installed app (home-screen or desktop app window), not a browser tab. */
export function runningInstalled(): boolean {
  const iosHomeScreen = Boolean((navigator as Navigator & { standalone?: boolean }).standalone);
  return iosHomeScreen || ["standalone", "fullscreen", "minimal-ui", "window-controls-overlay"]
    .some((mode) => window.matchMedia(`(display-mode: ${mode})`).matches);
}

export type InstallPlatform = "ios" | "mac-safari" | "other";

/** Where installation follows Safari's own menus rather than an install prompt. */
export function installPlatform(): InstallPlatform {
  const ua = navigator.userAgent;
  // iPadOS reports itself as a Mac; touch support tells them apart.
  if (/iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return "ios";
  if (/Macintosh/.test(ua) && /Version\/[\d.]+.*Safari\//.test(ua) && !/Chrome|Chromium|Edg|Firefox|OPR/.test(ua)) return "mac-safari";
  return "other";
}
