import "./globals.css";
import type { Metadata, Viewport } from "next";
import { PwaRegistration } from "@/components/pwa/PwaRegistration";

export const viewport: Viewport = {
  themeColor: "#0F766E",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export const metadata: Metadata = {
  title: { default: "WoundMeter", template: "%s · WoundMeter" },
  description: "WoundMeter — AI-Powered Wound Measurement & Collaborative Care. Calibrated wound measurement with clinician review, from hospital to home.",
  applicationName: "WoundMeter",
  manifest: "/manifest.json",
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "WoundMeter",
  },
  formatDetection: {
    telephone: false,
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        {/* Next.js emits only mobile-web-app-capable; older iOS versions read the apple- name. */}
        <meta name="apple-mobile-web-app-capable" content="yes" />
      </head>
      <body>
        <PwaRegistration />
        {children}
      </body>
    </html>
  );
}
