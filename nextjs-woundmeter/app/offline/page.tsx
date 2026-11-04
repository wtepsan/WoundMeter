import { BrandMark } from "@/components/app/BrandMark";
import { OfflineRetry } from "@/components/pwa/OfflineRetry";

export const metadata = { title: "Offline" };

// Kept by the service worker and shown when a page can't be loaded. It must stay static and
// contain nothing about any patient or account.
export default function Offline() {
  return (
    <main className="signin" id="main">
      <div className="signin-card">
        <BrandMark tagline />
        <h1>WoundMeter can&apos;t be reached</h1>
        <p className="muted-text">
          You may be offline, or the server may be unavailable. WoundMeter needs a connection: the ruler check, wound
          outline and measurement run on the server, and patient records and photos are never stored on this device.
        </p>
        <p className="muted-text">Anything you saved earlier is safe on the server. Reconnect, then try again.</p>
        <OfflineRetry />
      </div>
    </main>
  );
}
