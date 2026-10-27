"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import Button from "@/components/_ui/button";
import { Input } from "@/components/_ui/input";
import { SettingsCard } from "@/components/crm/settings-ui";
import { saveOtherEmailsAction } from "@/app/(crm)/settings/actions";
import type { MyEmails } from "@/lib/crm/profile";
import { reloadIfStaleDeploy } from "@/lib/stale-deploy";

export default function MyEmailsSettings({ emails }: { emails: MyEmails }) {
  const router = useRouter();
  const [drafts, setDrafts] = useState(emails.otherEmails);
  const [source, setSource] = useState(emails);
  if (source !== emails) {
    setSource(emails);
    setDrafts(emails.otherEmails);
  }
  const [value, setValue] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function save(next: string[], done: string) {
    const previous = drafts;
    setDrafts(next);
    setPending(true);
    setError(null);
    setMessage(null);
    try {
      const result = await saveOtherEmailsAction(next);
      if (result.error || !result.emails) {
        setDrafts(previous);
        setError(result.error ?? "Could not save your email addresses.");
        return false;
      }
      setDrafts(result.emails.otherEmails);
      setMessage(done);
      router.refresh();
      return true;
    } catch (problem) {
      setDrafts(previous);
      if (!reloadIfStaleDeploy(problem)) setError("Could not save your email addresses. Try again.");
      return false;
    } finally {
      setPending(false);
    }
  }

  async function add(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const email = value.trim().toLowerCase();
    if (!email) return;
    setMessage(null);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setError(`“${value.trim()}” isn't a valid email address.`);
      return;
    }
    setError(null);
    if (email === emails.loginEmail.toLowerCase() || drafts.includes(email)) {
      setValue("");
      return;
    }
    if (await save([...drafts, email], `Added ${email}.`)) setValue("");
  }

  return (
    <SettingsCard
      id="my-emails"
      title="My email addresses"
      description="Orbit treats these as you: they’re never filed as contacts or companies."
    >
      <ul className="flex flex-col">
        <li className="border-border flex items-center justify-between gap-3 border-b py-2">
          <span className="min-w-0 truncate text-[14px] leading-5">{emails.loginEmail}</span>
          <span className="caption-style text-subtle shrink-0">Sign-in address</span>
        </li>
        {drafts.map((email) => (
          <li key={email} className="border-border flex items-center justify-between gap-3 border-b py-2">
            <span className="min-w-0 truncate text-[14px] leading-5">{email}</span>
            <Button
              variant="ghost"
              size="sm"
              type="button"
              aria-label={`Remove ${email}`}
              disabled={pending}
              onClick={() => void save(drafts.filter((item) => item !== email), `Removed ${email}.`)}
            >
              Remove
            </Button>
          </li>
        ))}
      </ul>
      <form className="flex gap-2" noValidate onSubmit={add}>
        <label className="sr-only" htmlFor="other-email">
          Another email address
        </label>
        <Input
          id="other-email"
          type="email"
          value={value}
          placeholder="you@example.com"
          onChange={(event) => setValue(event.target.value)}
        />
        <Button variant="ghost" size="sm" type="submit" disabled={pending || !value.trim()}>
          {pending ? "Saving…" : "Add"}
        </Button>
      </form>
      {error && (
        <p role="alert" className="caption-style text-danger">
          {error}
        </p>
      )}
      <p role="status" className="caption-style text-subtle empty:hidden">
        {message}
      </p>
    </SettingsCard>
  );
}
