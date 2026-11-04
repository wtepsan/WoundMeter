"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { Account } from "@/lib/accounts";
import { auth, CareApiError, serverReachable, subscribeConnection } from "@/lib/care-api";

export type MfaEnrollment = { secret: string; otpauth_uri: string } | null;

export type SessionState =
  | { status: "loading" }
  | { status: "signed_out"; notice?: string }
  | { status: "mfa"; enrollment: MfaEnrollment }
  | { status: "signed_in"; account: Account };

const SIGN_OUT_PENDING =
  "Signed out on this screen. WoundMeter couldn't be reached to end your session, so it will end as soon as the connection returns. Keep this page open until then.";

/** Session state backed by the server; the session token itself stays in an httpOnly cookie. */
export function useAppSession() {
  const [state, setState] = useState<SessionState>({ status: "loading" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Only the server can clear the httpOnly session cookie. A sign-out made offline is finished
  // when the connection returns, so the next person here isn't signed in as the previous one.
  const logoutPending = useRef(false);

  useEffect(() => {
    auth
      .session()
      .then(({ account }) => setState(account ? { status: "signed_in", account } : { status: "signed_out" }))
      .catch(() => setState({ status: "signed_out" }));
  }, []);

  const finishLogout = useCallback(async () => {
    if (!logoutPending.current) return;
    await auth.logout();
    logoutPending.current = false;
    setState((s) => (s.status === "signed_out" && s.notice === SIGN_OUT_PENDING ? { status: "signed_out", notice: "Your session has ended." } : s));
  }, []);

  useEffect(
    () => subscribeConnection(() => {
      if (serverReachable()) void finishLogout().catch(() => undefined);
    }),
    [finishLogout],
  );

  const run = useCallback(async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }, []);

  const signIn = useCallback(
    (username: string, password: string) =>
      run(async () => {
        await finishLogout();
        const result = await auth.login(username, password);
        if (result.status === "mfa_required") setState({ status: "mfa", enrollment: result.mfa_enrollment });
        else setState({ status: "signed_in", account: result.account });
      }),
    [run, finishLogout],
  );

  const demoSignIn = useCallback(
    (username: string) =>
      run(async () => {
        await finishLogout();
        const result = await auth.demoLogin(username);
        setState({ status: "signed_in", account: result.account });
      }),
    [run, finishLogout],
  );

  const verifyMfa = useCallback(
    (code: string) =>
      run(async () => {
        try {
          const result = await auth.verifyMfa(code);
          setState({ status: "signed_in", account: result.account });
        } catch (err) {
          if (err instanceof CareApiError && err.code === "MFA_CHALLENGE_EXPIRED") {
            setState({ status: "signed_out", notice: err.message });
            return;
          }
          throw err;
        }
      }),
    [run],
  );

  const signOut = useCallback(
    async (notice?: string) => {
      let message = notice;
      await auth.logout().catch((err) => {
        if (err instanceof CareApiError && err.status === 0) {
          logoutPending.current = true;
          message = SIGN_OUT_PENDING;
        }
      });
      setError(null);
      setState({ status: "signed_out", notice: message });
    },
    [],
  );

  return { state, busy, error, signIn, demoSignIn, verifyMfa, signOut, clearError: () => setError(null) };
}
