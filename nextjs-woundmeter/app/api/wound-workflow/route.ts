import { NextRequest, NextResponse } from "next/server";

import { FASTAPI_URL, isSameOrigin, sessionToken, upstreamHeaders } from "@/lib/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ID = "[a-zA-Z0-9_.-]+";

// Patient search and duplicate checks are POST-only so identifiers never appear in URLs or logs.
const ALLOWED_GET_PATTERN = new RegExp(
  `^(?:meta/status|health|care/personas|care/patients|care/review-queue|care/patients/${ID}|care/patients/${ID}/reports|care/images/${ID}` +
    `|care/patients/${ID}/deleted-records|care/patients/${ID}/wounds/${ID}/submissions/${ID}|admin/(?:storage|permission-policy|users|organisations|patients|settings|audit|deleted-records|patients/${ID}/care-team)` +
    `|nursing/(?:context|admissions|wards/${ID}/board|patients/${ID}|admissions/${ID}|admissions/${ID}/report))$`,
);

const ALLOWED_POST_PATTERN = new RegExp(
  `^(?:care/(?:patients|patients/search|patients/duplicate-check` +
    `|patients/${ID}/(?:wounds|grants)|grants/${ID}/revoke|patients/${ID}/wounds/${ID}/(?:observations|care-plans|summary-drafts|ai-revise)` +
    `|observations/${ID}/(?:refine-mask|measure-preview|review|record-draft|ai-observations)|assessments/${ID}/amend|tasks/${ID}/complete` +
    // Meta AI assistance (clinical staff only; FastAPI enforces roles, permissions and patient scope).
    `|ai-observations/${ID}/review|patients/${ID}/wounds/${ID}/reports|reports/${ID}/review|patients/${ID}/assistant` +
    `|voice/transcribe)` +
    `|care/(?:records/(?:observation|report|wound)/${ID}/delete|deleted-records/${ID}/authorize-restore)` +
    `|admin/(?:users|users/${ID}|users/${ID}/(?:qualification|permissions|reset-password)` +
    `|patients/${ID}/care-team|patients/${ID}/care-team/${ID}/remove|deleted-records/${ID}/restore)` +
    `|nursing/(?:shifts|shifts/${ID}/end|patients/${ID}/admissions|admissions/${ID}/(?:transfer|discharge|assessments|assessments/preview)` +
    `|assessments/${ID}/care-checklist|care-activities/${ID}/(?:complete|unable)))$`,
);

function noStoreJson(body: unknown, status: number) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export async function GET(request: NextRequest) {
  if (!sessionToken(request)) {
    return noStoreJson({ code: "AUTHENTICATION_REQUIRED", message: "Sign in to continue." }, 401);
  }
  const { searchParams } = new URL(request.url);
  const endpoint = searchParams.get("endpoint") ?? "";
  if (!ALLOWED_GET_PATTERN.test(endpoint)) {
    return noStoreJson({ code: "INVALID_ENDPOINT", message: "Unsupported workflow query endpoint." }, 400);
  }
  const upstreamParams = new URLSearchParams();
  searchParams.forEach((val, key) => {
    if (key !== "endpoint") upstreamParams.set(key, val);
  });
  const queryString = upstreamParams.toString();
  const targetUrl = `${FASTAPI_URL}/v2/${endpoint}${queryString ? `?${queryString}` : ""}`;

  try {
    const upstream = await fetch(targetUrl, {
      method: "GET",
      headers: upstreamHeaders(request),
      cache: "no-store",
      signal: AbortSignal.timeout(30_000),
    });
    // Pass bytes through unchanged: private wound images are binary and must not be text-decoded.
    const body = await upstream.arrayBuffer();
    return new NextResponse(body, {
      status: upstream.status,
      headers: {
        "content-type": upstream.headers.get("content-type") ?? "application/json",
        "cache-control": upstream.headers.get("cache-control") ?? "no-store",
      },
    });
  } catch {
    return noStoreJson(
      { code: "WORKFLOW_SERVICE_UNAVAILABLE", message: "The FastAPI measurement backend is unreachable." },
      503,
    );
  }
}

export async function POST(request: NextRequest) {
  if (!isSameOrigin(request)) {
    return noStoreJson({ code: "CSRF_REJECTED", message: "Cross-origin request refused." }, 403);
  }
  if (!sessionToken(request)) {
    return noStoreJson({ code: "AUTHENTICATION_REQUIRED", message: "Sign in to continue." }, 401);
  }
  const maxBytes = 4 * Math.ceil((Number(process.env.MAX_UPLOAD_BYTES) || 10 * 1024 * 1024) / 3) + 65536;
  const tooLarge = () => noStoreJson({ code: "REQUEST_TOO_LARGE", message: "The upload request is too large." }, 413);
  if (Number(request.headers.get("content-length") ?? 0) > maxBytes) return tooLarge();
  let body: { endpoint?: string; payload?: unknown };
  try {
    const reader = request.body?.getReader();
    const decoder = new TextDecoder();
    let size = 0;
    let text = "";
    if (reader) {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > maxBytes) { await reader.cancel(); return tooLarge(); }
        text += decoder.decode(chunk.value, { stream: true });
      }
    }
    body = JSON.parse(text + decoder.decode()) as { endpoint?: string; payload?: unknown };
  } catch {
    return noStoreJson({ code: "INVALID_JSON", message: "Valid JSON request body required." }, 400);
  }

  const endpoint = body.endpoint ?? "";
  if (!ALLOWED_POST_PATTERN.test(endpoint)) {
    return noStoreJson({ code: "INVALID_ENDPOINT", message: "Unsupported workflow action endpoint." }, 400);
  }

  try {
    const upstream = await fetch(`${FASTAPI_URL}/v2/${endpoint}`, {
      method: "POST",
      // Identity comes only from the httpOnly session cookie, never from the request body.
      headers: upstreamHeaders(request, { "content-type": "application/json" }),
      body: JSON.stringify(body.payload ?? {}),
      cache: "no-store",
      signal: AbortSignal.timeout(60_000),
    });
    const text = await upstream.text();
    return new NextResponse(text, {
      status: upstream.status,
      headers: {
        "content-type": upstream.headers.get("content-type") ?? "application/json",
        "cache-control": "no-store",
      },
    });
  } catch {
    return noStoreJson(
      { code: "WORKFLOW_ACTION_FAILED", message: "The connection ended before the outcome was confirmed. Check submission status before retrying an upload." },
      503,
    );
  }
}
