"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import Button from "@/components/_ui/button";
import { Input } from "@/components/_ui/input";
import { saveOtherEmailsAction } from "@/app/(crm)/settings/actions";
import type { MyEmails } from "@/lib/crm/profile";

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
  const dirty = drafts.join("\n") !== emails.otherEmails.join("\n");

  function add(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const email = value.trim().toLowerCase();
    if (!email) return;
    setMessage(null);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setError(`“${value.trim()}” isn't a valid email address.`);
      return;
    }
    setError(null);
    setValue("");
    if (email === emails.loginEmail.toLowerCase() || drafts.includes(email)) return;
    setDrafts((current) => [...current, email]);
  }

  async function save() {
    setPending(true);
    setError(null);
    setMessage(null);
    const result = await saveOtherEmailsAction(drafts);
    setPending(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    setMessage("Saved.");
    router.refresh();
  }

  return (
    <div className="flex max-w-[640px] flex-col gap-3">
      <h2>My email addresses</h2>
      <p className="caption-style text-subtle">
        Orbit treats these as you: they’re never filed as contacts or companies.
      </p>
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
              onClick={() => {
                setMessage(null);
                setDrafts((current) => current.filter((item) => item !== email));
              }}
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
          Add
        </Button>
      </form>
      {error && (
        <p role="alert" className="caption-style text-danger">
          {error}
        </p>
      )}
      <div className="flex items-center gap-3">
        <Button variant="secondary" size="sm" type="button" disabled={pending || !dirty} onClick={save}>
          {pending ? "Saving…" : "Save addresses"}
        </Button>
        <p role="status" className="caption-style text-subtle">
          {message}
        </p>
      </div>
    </div>
  );
}
