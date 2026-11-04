// Server-only helpers for the browser session. The FastAPI session token lives in an
// httpOnly cookie, so page scripts can never read it; route handlers attach it upstream.
import type { NextRequest, NextResponse } from "next/server";

export const FASTAPI_URL = process.env.FASTAPI_URL ?? process.env.BACKEND_URL ?? "http://api:8000";
export const SESSION_COOKIE = "wm_session";
export const MFA_COOKIE = "wm_mfa";
const SESSION_MAX_AGE_S = 8 * 60 * 60;
const MFA_MAX_AGE_S = 5 * 60;

export function sessionToken(request: NextRequest): string | null {
  return request.cookies.get(SESSION_COOKIE)?.value ?? null;
}

function cookieOptions(request: NextRequest, maxAge: number) {
  return {
    httpOnly: true,
    sameSite: "strict" as const,
    secure: request.nextUrl.protocol === "https:",
    path: "/",
    maxAge,
  };
}

export function setSessionCookie(response: NextResponse, request: NextRequest, token: string) {
  response.cookies.set(SESSION_COOKIE, token, cookieOptions(request, SESSION_MAX_AGE_S));
}

export function setMfaCookie(response: NextResponse, request: NextRequest, challenge: string) {
  response.cookies.set(MFA_COOKIE, challenge, cookieOptions(request, MFA_MAX_AGE_S));
}

export function clearAuthCookies(response: NextResponse, request: NextRequest) {
  response.cookies.set(SESSION_COOKIE, "", cookieOptions(request, 0));
  response.cookies.set(MFA_COOKIE, "", cookieOptions(request, 0));
}

/**
 * CSRF defence for state-changing requests: SameSite=Strict cookies plus an Origin check.
 * Browsers always send Origin on cross-site POSTs, so a mismatch is rejected.
 */
export function isSameOrigin(request: NextRequest): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

export function upstreamHeaders(request: NextRequest, extra: Record<string, string> = {}): Record<string, string> {
  const token = sessionToken(request);
  return { ...extra, ...(token ? { "x-reviewer-token": token } : {}) };
}
