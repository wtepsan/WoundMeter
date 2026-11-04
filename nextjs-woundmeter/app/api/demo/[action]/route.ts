// Demo mode only, no sign-in: forwards /demo's status check and one-photo measurement to FastAPI,
// which also refuses both when demo mode is off. Nothing is stored by either side.
import { NextRequest, NextResponse } from "next/server";

import { FASTAPI_URL, isSameOrigin } from "@/lib/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

function demoModeOn(): boolean {
  return ["1", "true", "yes", "on"].includes((process.env.WOUNDMETER_DEMO_MODE ?? "").trim().toLowerCase());
}

const DISABLED = { code: "NOT_AVAILABLE", message: "Demo measurement is disabled." };

async function forward(path: string, init: RequestInit, timeoutMs: number) {
  try {
    const res = await fetch(`${FASTAPI_URL}/v2/demo/${path}`, { ...init, cache: "no-store", signal: AbortSignal.timeout(timeoutMs) });
    return new NextResponse(await res.text(), {
      status: res.status,
      headers: { "content-type": res.headers.get("content-type") ?? "application/json", "cache-control": "no-store" },
    });
  } catch {
    return json({ code: "DEMO_SERVICE_UNAVAILABLE", message: "The measurement service didn't answer in time. Try again." }, 503);
  }
}

export async function GET(_request: NextRequest, { params }: { params: Promise<{ action: string }> }) {
  const { action } = await params;
  if (!demoModeOn()) return json(DISABLED, 404);
  if (action !== "status") return json({ code: "NOT_FOUND", message: "Unknown demo action." }, 404);
  return forward("status", {}, 10_000);
}

// Upstream time budget per action: the measurement can include Meta SAM 3.1 and a Muse Spark draft.
const POST_TIMEOUT_MS: Record<string, number> = { measure: 180_000, explain: 90_000, preview: 30_000, refine: 30_000, "ai-observations": 90_000, "ai-revise": 90_000 };

export async function POST(request: NextRequest, { params }: { params: Promise<{ action: string }> }) {
  const { action } = await params;
  if (!demoModeOn()) return json(DISABLED, 404);
  if (!(action in POST_TIMEOUT_MS)) return json({ code: "NOT_FOUND", message: "Unknown demo action." }, 404);
  if (!isSameOrigin(request)) return json({ code: "CSRF_REJECTED", message: "Cross-origin request refused." }, 403);
  const maxBytes = 4 * Math.ceil((Number(process.env.MAX_UPLOAD_BYTES) || 10 * 1024 * 1024) / 3) + 65536;
  const tooLarge = () => json({ code: "REQUEST_TOO_LARGE", message: "The photo is too large (10 MB maximum)." }, 413);
  if (Number(request.headers.get("content-length") ?? 0) > maxBytes) return tooLarge();
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader) {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maxBytes) { await reader.cancel(); return tooLarge(); }
      chunks.push(chunk.value);
    }
  }
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    JSON.parse(text);
  } catch {
    return json({ code: "INVALID_JSON", message: "Valid JSON request body required." }, 400);
  }
  // FastAPI validates every field; nothing here identifies a person or record.
  return forward(action, { method: "POST", headers: { "content-type": "application/json" }, body: text }, POST_TIMEOUT_MS[action]);
}
