"use client";

import { useActionState } from "react";
import Button from "@/components/_ui/button";
import Field from "@/components/_ui/field";
import { Input } from "@/components/_ui/input";
import { joinAction, type JoinState } from "@/app/join/[token]/actions";

const INITIAL: JoinState = {};

export default function JoinForm({
  token,
  email,
  workspaceName,
  invitedBy,
}: {
  token: string;
  email: string;
  workspaceName: string;
  invitedBy: string | null;
}) {
  const [state, action, pending] = useActionState(joinAction, INITIAL);

  if (state.confirmEmail) {
    return (
      <div className="border-border bg-card flex w-full max-w-[420px] flex-col gap-3 rounded-2xl border p-6">
        <h1>Check your email</h1>
        <p className="text-muted-foreground">
          We&apos;ve sent a confirmation link to {state.confirmEmail}. Open it, then sign in with your email and the password you
          just chose.
        </p>
        <a href="/login" className="text-foreground underline underline-offset-2">
          Go to sign in
        </a>
      </div>
    );
  }

  return (
    <form action={action} className="border-border bg-card w-full max-w-[420px] rounded-2xl border p-6">
      <input type="hidden" name="token" value={token} />
      <div className="mb-6 flex flex-col gap-2">
        <h1>Join {workspaceName}</h1>
        <p className="text-muted-foreground">
          {invitedBy ? `${invitedBy} invited you to Orbit.` : "You've been invited to Orbit."} Set up your login to get started.
        </p>
      </div>
      <div className="flex flex-col gap-4">
        <Field label="Email" htmlFor="join-email">
          <Input id="join-email" type="email" value={email} readOnly disabled />
        </Field>
        <Field label="Your name" htmlFor="join-name" required error={state.error}>
          <Input
            id="join-name"
            name="name"
            autoComplete="name"
            required
            defaultValue={state.name ?? ""}
            aria-invalid={state.error ? true : undefined}
            aria-describedby={state.error ? "join-name-error" : undefined}
          />
        </Field>
        <Field label="Password" htmlFor="join-password" required>
          <Input id="join-password" name="password" type="password" autoComplete="new-password" required minLength={8} />
        </Field>
        <p className="caption-style text-subtle">At least 8 characters. If you already have an Orbit login, use that password.</p>
      </div>
      <div className="mt-6 flex flex-wrap gap-2">
        <Button type="submit" variant="primary" size="md" disabled={pending}>
          {pending ? "Setting up…" : "Join"}
        </Button>
      </div>
    </form>
  );
}
