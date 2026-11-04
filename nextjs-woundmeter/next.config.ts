import { resolve } from "node:path";
import type { NextConfig } from "next";
import { demoModeOn, loadWebSettings } from "./lib/root-env";

// One settings file for both apps: the root .env. Settings already in the environment win.
loadWebSettings(resolve(__dirname, ".."));

const nextConfig: NextConfig = {
  output: "standalone",
  reactStrictMode: true,
  // The screens' demo helpers follow the server's switch, fixed when the app starts or is built.
  env: {
    NEXT_PUBLIC_WOUNDMETER_DEMO: String(demoModeOn(process.env.WOUNDMETER_DEMO_MODE)),
    // Names this build's service worker and its offline cache (see public/sw.js).
    NEXT_PUBLIC_WOUNDMETER_BUILD: process.env.WOUNDMETER_BUILD_ID ?? Date.now().toString(36),
  },
  eslint: {
    ignoreDuringBuilds: true,
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "no-referrer" },
        ],
      },
      {
        source: "/sw.js",
        headers: [
          { key: "Content-Type", value: "application/javascript; charset=utf-8" },
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
          { key: "Service-Worker-Allowed", value: "/" },
        ],
      },
    ];
  },
};

export default nextConfig;
