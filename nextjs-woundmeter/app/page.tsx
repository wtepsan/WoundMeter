"use client";

import { AppShell } from "@/components/app/AppShell";
import { SignInScreen } from "@/components/app/SignInScreen";
import { Loading } from "@/components/ui/Feedback";
import { useAppSession } from "@/hooks/useAppSession";

export default function Page() {
  const { state, busy, error, signIn, demoSignIn, verifyMfa, signOut } = useAppSession();

  if (state.status === "loading") return <Loading label="Starting WoundMeter…" />;

  return state.status === "signed_in" ? (
    <AppShell account={state.account} onSignOut={(notice) => void signOut(notice)} />
  ) : (
    <SignInScreen
      stage={state.status === "mfa" ? "mfa" : "credentials"}
      enrollment={state.status === "mfa" ? state.enrollment : null}
      busy={busy}
      error={error}
      notice={state.status === "signed_out" ? state.notice : undefined}
      onSignIn={(u, p) => void signIn(u, p)}
      onDemoSignIn={(u) => void demoSignIn(u)}
      onVerifyMfa={(code) => void verifyMfa(code)}
      onCancelMfa={() => void signOut()}
    />
  );
}
