"use client";

import { useActionState } from "react";
import Button from "@/components/_ui/button";
import Field from "@/components/_ui/field";
import { Input } from "@/components/_ui/input";
import { signInAction, type AuthState } from "@/app/login/actions";

const INITIAL: AuthState = {};

export default function LoginForm({ hintEmail }: { hintEmail?: string }) {
  const [state, action, pending] = useActionState(signInAction, INITIAL);

  return (
    <form action={action} className="border-border bg-card w-full max-w-[420px] rounded-2xl border p-6">
      <div className="mb-6 flex flex-col gap-2">
        <h1>Sign in</h1>
        <p className="text-muted-foreground">
          Use your workspace account to open the company list.
        </p>
      </div>
      <div className="flex flex-col gap-4">
        <Field label="Name" htmlFor="login-name" hint="Used when you create an account.">
          <Input id="login-name" name="name" autoComplete="name" placeholder="Ada Lovelace" />
        </Field>
        <Field label="Email" htmlFor="login-email" required error={state.error}>
          <Input
            id="login-email"
            name="email"
            type="email"
            autoComplete="email"
            required
            placeholder="you@company.com"
            aria-invalid={state.error ? true : undefined}
            aria-describedby={state.error ? "login-email-error" : undefined}
          />
        </Field>
        <Field label="Password" htmlFor="login-password" required>
          <Input
            id="login-password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            minLength={8}
          />
        </Field>
      </div>
      {hintEmail && (
        <p className="caption-style text-subtle mt-4">
          Local development account: {hintEmail}
        </p>
      )}
      <div className="mt-6 flex flex-wrap gap-2">
        <Button type="submit" name="mode" value="signin" variant="primary" size="md" disabled={pending}>
          {pending ? "Working…" : "Sign in"}
        </Button>
        <Button type="submit" name="mode" value="signup" variant="secondary" size="md" disabled={pending}>
          Create account
        </Button>
      </div>
    </form>
  );
}
