"use client";

import { useActionState, useState } from "react";
import Button from "@/components/_ui/button";
import Field from "@/components/_ui/field";
import { Input } from "@/components/_ui/input";
import { requestResetAction, signInAction, type AuthState } from "@/app/login/actions";
import Logo from "@/public/assets/images/_common/logo.svg";

const INITIAL: AuthState = {};

export default function LoginForm({ hintEmail, notice, resets }: { hintEmail?: string; notice?: string; resets: boolean }) {
  const [mode, setMode] = useState<"sign-in" | "reset">("sign-in");
  const [state, action, pending] = useActionState(signInAction, INITIAL);
  const [reset, resetAction, resetting] = useActionState(requestResetAction, INITIAL);

  return (
    <div className="flex w-full max-w-[400px] flex-col items-center gap-6">
      <div className="flex flex-col items-center gap-3 text-center">
        <Logo aria-hidden className="size-11" />
        <div className="flex flex-col gap-1.5">
          <h1 className="text-[22px] leading-7">{mode === "sign-in" ? "Sign in" : "Reset password"}</h1>
        </div>
      </div>
      {mode === "sign-in" ? (
        <form action={action} className="border-border bg-card flex w-full flex-col gap-4 rounded-2xl border p-6">
          {notice && (
            <p role="status" className="caption-style text-success">
              {notice}
            </p>
          )}
          {state.error && (
            <p role="alert" className="rounded-lg border border-[var(--tag-red-border)] bg-[var(--tag-red-bg)] px-3 py-2 text-[13px] leading-5 text-[var(--tag-red-text)]">
              {state.error}
            </p>
          )}
          <Field label="Email" htmlFor="login-email" required>
            <Input id="login-email" name="email" type="email" autoComplete="email" required defaultValue={state.email ?? ""} placeholder="you@company.com" autoFocus />
          </Field>
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between gap-3">
              <label htmlFor="login-password" className="caption-style text-soft">
                Password
              </label>
              {resets && (
                <button type="button" onClick={() => setMode("reset")} className="caption-style text-subtle hover:text-foreground focus-visible:ring-ring/60 rounded outline-none focus-visible:ring-2">
                  Forgot password?
                </button>
              )}
            </div>
            <Input id="login-password" name="password" type="password" autoComplete="current-password" required minLength={8} />
          </div>
          <Button type="submit" variant="primary" size="md" disabled={pending} className="mt-1 w-full">
            {pending ? "Signing in…" : "Sign in"}
          </Button>
          {hintEmail && <p className="caption-style text-subtle">Local development account: {hintEmail}</p>}
        </form>
      ) : (
        <form action={resetAction} className="border-border bg-card flex w-full flex-col gap-4 rounded-2xl border p-6">
          {reset.sent ? (
            <p role="status" className="text-[14px] leading-5">
              Reset link sent to {reset.email}. Open it on this device.
            </p>
          ) : (
            <>
              {reset.error && (
                <p role="alert" className="rounded-lg border border-[var(--tag-red-border)] bg-[var(--tag-red-bg)] px-3 py-2 text-[13px] leading-5 text-[var(--tag-red-text)]">
                  {reset.error}
                </p>
              )}
              <Field label="Email" htmlFor="reset-email" required>
                <Input id="reset-email" name="email" type="email" autoComplete="email" required defaultValue={reset.email ?? state.email ?? ""} autoFocus />
              </Field>
              <Button type="submit" variant="primary" size="md" disabled={resetting} className="w-full">
                {resetting ? "Sending…" : "Send reset link"}
              </Button>
            </>
          )}
          <button type="button" onClick={() => setMode("sign-in")} className="caption-style text-subtle hover:text-foreground focus-visible:ring-ring/60 self-center rounded outline-none focus-visible:ring-2">
            Back to sign in
          </button>
        </form>
      )}
    </div>
  );
}
