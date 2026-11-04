import { NextRequest, NextResponse } from "next/server";

import {
  FASTAPI_URL,
  MFA_COOKIE,
  clearAuthCookies,
  isSameOrigin,
  sessionToken,
  setMfaCookie,
  setSessionCookie,
  upstreamHeaders,
} from "@/lib/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Upstream = { status: number; body: Record<string, unknown> };

// Runtime switch from the container environment (Compose passes WOUNDMETER_DEMO_MODE from the root
// .env). FastAPI enforces demo mode independently; this only stops the proxy forwarding demo calls.
function demoModeOn(): boolean {
  return ["1", "true", "yes", "on"].includes((process.env.WOUNDMETER_DEMO_MODE ?? "").trim().toLowerCase());
}

const DEMO_DISABLED = { code: "NOT_AVAILABLE", demo_mode: false, message: "Demo sign-in is disabled." };

async function callFastApi(path: string, init: RequestInit): Promise<Upstream> {
  try {
    const res = await fetch(`${FASTAPI_URL}/v2/auth/${path}`, {
      ...init,
      cache: "no-store",
      signal: AbortSignal.timeout(20_000),
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { status: res.status, body };
  } catch {
    return { status: 503, body: { code: "AUTH_SERVICE_UNAVAILABLE", message: "The sign-in service is unreachable." } };
  }
}

function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ action: string }> }) {
  const { action } = await params;
  if (action === "session") {
    // Being signed out is a normal state here, so answer 200 with no account.
    if (!sessionToken(request)) return json({ account: null });
    const up = await callFastApi("me", { headers: upstreamHeaders(request) });
    if (up.status === 401) {
      const res = json({ account: null });
      clearAuthCookies(res, request);
      return res;
    }
    return json(up.body, up.status);
  }
  if (action === "demo-accounts") {
    if (!demoModeOn()) return json(DEMO_DISABLED, 404);
    const up = await callFastApi("demo/accounts", {});
    return json(up.body, up.status);
  }
  return json({ code: "NOT_FOUND", message: "Unknown auth action." }, 404);
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ action: string }> }) {
  const { action } = await params;
  if (!isSameOrigin(request)) return json({ code: "CSRF_REJECTED", message: "Cross-origin request refused." }, 403);
  const payload = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const jsonInit = (body: unknown, withSession = false): RequestInit => ({
    method: "POST",
    headers: withSession
      ? upstreamHeaders(request, { "content-type": "application/json" })
      : { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  switch (action) {
    case "login": {
      const up = await callFastApi("login", jsonInit({ username: payload.username, password: payload.password }));
      if (up.status !== 200) return json(up.body, up.status);
      if (up.body.status === "mfa_required") {
        // The pending challenge stays server-side in an httpOnly cookie.
        const res = json({ status: "mfa_required", mfa_enrollment: up.body.mfa_enrollment ?? null });
        setMfaCookie(res, request, String(up.body.challenge));
        return res;
      }
      const res = json({ status: "authenticated", account: up.body.account });
      setSessionCookie(res, request, String(up.body.token));
      return res;
    }
    case "mfa": {
      const challenge = request.cookies.get(MFA_COOKIE)?.value;
      if (!challenge) return json({ code: "MFA_CHALLENGE_EXPIRED", message: "Sign in again." }, 401);
      const up = await callFastApi("mfa", jsonInit({ challenge, code: payload.code }));
      if (up.status !== 200) return json(up.body, up.status);
      const res = json({ status: "authenticated", account: up.body.account });
      setSessionCookie(res, request, String(up.body.token));
      res.cookies.set(MFA_COOKIE, "", { httpOnly: true, sameSite: "strict", path: "/", maxAge: 0 });
      return res;
    }
    case "demo-login": {
      if (!demoModeOn()) return json(DEMO_DISABLED, 404);
      const up = await callFastApi("demo/login", jsonInit({ username: payload.username }));
      if (up.status !== 200) return json(up.body, up.status);
      const res = json({ status: "authenticated", account: up.body.account });
      setSessionCookie(res, request, String(up.body.token));
      res.cookies.set(MFA_COOKIE, "", { httpOnly: true, sameSite: "strict", path: "/", maxAge: 0 });
      return res;
    }
    case "logout": {
      await callFastApi("logout", jsonInit({}, true));
      const res = json({ status: "signed_out" });
      clearAuthCookies(res, request);
      return res;
    }
    case "change-password": {
      const up = await callFastApi(
        "change-password",
        jsonInit({ current_password: payload.current_password, new_password: payload.new_password }, true),
      );
      return json(up.body, up.status);
    }
    case "forgot-password": {
      const up = await callFastApi("forgot-password", jsonInit({ username: payload.username }));
      return json(up.body, up.status);
    }
    default:
      return json({ code: "NOT_FOUND", message: "Unknown auth action." }, 404);
  }
}
