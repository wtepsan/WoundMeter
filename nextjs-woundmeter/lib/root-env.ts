// Start-up only, imported by next.config.ts: the web app takes its settings from the repository's
// single root .env, read exactly as fastapi-woundmeter/app/config.py reads it, so both apps agree.
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The settings the web app needs: the shared demo switch and upload limit, and where the API is.
export const WEB_SETTINGS = ["WOUNDMETER_DEMO_MODE", "MAX_UPLOAD_BYTES", "FASTAPI_URL"] as const;

function readEnvFile(file: string): Map<string, string> {
  const values = new Map<string, string>();
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return values;
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const eq = line.indexOf("=");
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim().replace(/^"+|"+$/g, "").replace(/^'+|'+$/g, "");
    if (key && !values.has(key)) values.set(key, value);
  }
  return values;
}

/** Fills each web setting missing from the environment; the repository-root .env only. */
export function loadWebSettings(repoRoot: string, env: NodeJS.ProcessEnv = process.env): void {
  const values = readEnvFile(join(repoRoot, ".env"));
  for (const key of WEB_SETTINGS) {
    if (env[key] !== undefined) continue;
    if (values.has(key)) env[key] = values.get(key);
  }
}

/** The server's reading of the switch (config.py `_bool_env`): off when unset, on only for 1/true/yes/on. */
export function demoModeOn(value: string | undefined): boolean {
  return value !== undefined && ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}
