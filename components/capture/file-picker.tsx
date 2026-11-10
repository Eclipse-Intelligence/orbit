"use client";

import { useEffect, useState, type KeyboardEvent } from "react";
import Button from "@/components/_ui/button";
import { Input } from "@/components/_ui/input";
import { Monogram } from "@/components/beautifui/record-marks";
import { searchContactsToFileAction } from "@/app/(crm)/search";
import type { Contact } from "@/lib/crm/types";

export function FilePicker({
  id,
  onPick,
  onCancel,
  onDone,
}: {
  id: string;
  onPick: (contact: Contact) => Promise<{ error?: string }>;
  onCancel: () => void;
  onDone: () => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<{
    query: string;
    contacts: Contact[];
    failed?: boolean;
  } | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const trimmed = query.trim();
  const searching = results?.query !== trimmed;
  const fieldId = `file-to-${id}`;

  useEffect(() => {
    let cancelled = false;
    const handle = window.setTimeout(() => {
      searchContactsToFileAction(trimmed).then(
        (rows) => {
          if (!cancelled) setResults({ query: trimmed, contacts: rows.contacts });
        },
        () => {
          if (!cancelled) setResults({ query: trimmed, contacts: [], failed: true });
        },
      );
    }, 200);
    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [trimmed]);

  async function file(contact: Contact) {
    if (pending) return;
    setPending(contact.id);
    setError(null);
    const result = await onPick(contact);
    setPending(null);
    if (result.error) {
      setError(result.error);
      return;
    }
    onDone();
  }

  function keepInPicker(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") event.preventDefault();
    if (event.key === "Escape") onCancel();
  }

  return (
    <div className="border-line-strong flex flex-col gap-2 rounded-lg border p-2">
      <label className="sr-only" htmlFor={fieldId}>
        Search contacts
      </label>
      <Input
        id={fieldId}
        value={query}
        autoFocus
        placeholder="Search contacts"
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={keepInPicker}
      />
      {error && (
        <p role="alert" className="caption-style text-danger px-1">
          {error}
        </p>
      )}
      {searching ? (
        <p className="caption-style text-subtle px-1 py-2">Searching…</p>
      ) : results?.failed ? (
        <p role="alert" className="caption-style text-danger px-1 py-2">
          Search failed. Try again.
        </p>
      ) : results && results.contacts.length === 0 ? (
        <p className="caption-style text-subtle px-1 py-2">{trimmed ? "No matches" : "No contacts"}</p>
      ) : (
        <ul className="flex max-h-64 flex-col overflow-auto">
          {results?.contacts.map((contact) => (
            <li key={contact.id}>
              <Button variant="item" size="md" className="items-center" disabled={pending !== null} onClick={() => file(contact)}>
                <Monogram name={contact.name} />
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="truncate text-[14px] leading-5">{contact.name}</span>
                  <span className="caption-style text-subtle truncate">
                    {[contact.email, contact.companyName ? `at ${contact.companyName}` : null].filter(Boolean).join(" · ") || "No email"}
                  </span>
                </span>
                {pending === contact.id && <span className="caption-style text-subtle shrink-0">Filing…</span>}
              </Button>
            </li>
          ))}
        </ul>
      )}
      <Button variant="ghost" size="sm" className="self-start" disabled={pending !== null} onClick={onCancel}>
        Cancel
      </Button>
    </div>
  );
}
