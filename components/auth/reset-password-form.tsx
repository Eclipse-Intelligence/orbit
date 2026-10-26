"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import Button from "@/components/_ui/button";
import Field from "@/components/_ui/field";
import { Input } from "@/components/_ui/input";
import { changePasswordAction } from "@/app/(crm)/actions";
import Logo from "@/public/assets/images/_common/logo.svg";

export default function ResetPasswordForm({ email }: { email: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setPending(true);
    const result = await changePasswordAction(String(form.get("password") ?? ""), String(form.get("confirm") ?? ""));
    setPending(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    router.replace("/mail");
  }

  return (
    <div className="flex w-full max-w-[400px] flex-col items-center gap-6">
      <div className="flex flex-col items-center gap-3 text-center">
        <Logo aria-hidden className="size-11" />
        <div className="flex flex-col gap-1.5">
          <h1 className="text-[22px] leading-7">New password</h1>
          <p className="text-subtle">For {email}</p>
        </div>
      </div>
      <form onSubmit={submit} className="border-border bg-card flex w-full flex-col gap-4 rounded-2xl border p-6">
        {error && (
          <p role="alert" className="rounded-lg border border-[var(--tag-red-border)] bg-[var(--tag-red-bg)] px-3 py-2 text-[13px] leading-5 text-[var(--tag-red-text)]">
            {error}
          </p>
        )}
        <Field label="New password" htmlFor="new-password" required>
          <Input id="new-password" name="password" type="password" autoComplete="new-password" minLength={8} required autoFocus />
        </Field>
        <Field label="Repeat it" htmlFor="confirm-password" required>
          <Input id="confirm-password" name="confirm" type="password" autoComplete="new-password" minLength={8} required />
        </Field>
        <Button type="submit" variant="primary" size="md" disabled={pending} className="w-full">
          {pending ? "Saving…" : "Save"}
        </Button>
      </form>
    </div>
  );
}
