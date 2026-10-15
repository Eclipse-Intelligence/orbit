"use client";

import { useEffect, useState, type KeyboardEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import Button from "@/components/_ui/button";
import { Input } from "@/components/_ui/input";
import {
  createCompanyContactAction,
  linkCompanyContactAction,
  unlinkCompanyContactAction,
} from "@/app/(crm)/records";
import { searchContactsToLinkAction } from "@/app/(crm)/search";
import DetailSection from "@/components/companies/detail/detail-section";
import { Monogram } from "@/components/beautifui/record-marks";
import { CallLink } from "@/components/crm/record-form";
import { contactHref } from "@/lib/crm/hrefs";
import type { Contact } from "@/lib/crm/types";
import PlusIcon from "@/public/assets/images/_common/plus.svg";

type Draft = {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  jobTitle: string;
};

const DRAFT_FIELDS: { key: keyof Draft; label: string; type?: string }[] = [
  { key: "firstName", label: "First name" },
  { key: "lastName", label: "Last name" },
  { key: "email", label: "Email", type: "email" },
  { key: "phone", label: "Phone", type: "tel" },
  { key: "jobTitle", label: "Job title" },
];

function draftFromQuery(query: string): Draft {
  const empty = { firstName: "", lastName: "", email: "", phone: "", jobTitle: "" };
  const text = query.trim();
  if (!text) return empty;
  if (text.includes("@")) return { ...empty, email: text };
  const [first, ...rest] = text.split(/\s+/);
  return { ...empty, firstName: first, lastName: rest.join(" ") };
}

export default function CompanyContacts({
  companyId,
  contacts,
}: {
  companyId: string;
  contacts: Contact[];
}) {
  const router = useRouter();
  const [adding, setAdding] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function remove(contactId: string) {
    setRemoving(contactId);
    const result = await unlinkCompanyContactAction(companyId, contactId);
    setRemoving(null);
    if (result.error) {
      setError(result.error);
      return;
    }
    setConfirming(null);
    setError(null);
    router.refresh();
  }

  return (
    <DetailSection
      title="People"
      action={
        <Button
          variant="ghost"
          size="sm"
          aria-expanded={adding}
          data-shortcut="add-person"
          title="Add or link a person (A)"
          onClick={() => setAdding((current) => !current)}
        >
          {adding ? "Close" : "Add contact"}
        </Button>
      }
    >
      {adding && (
        <ContactPicker
          companyId={companyId}
          onDone={() => {
            setAdding(false);
            router.refresh();
          }}
        />
      )}
      {error && (
        <p role="alert" className="caption-style text-danger">
          {error}
        </p>
      )}
      {contacts.length === 0 ? (
        <p className="caption-style text-subtle">No contacts on this company.</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {contacts.map((contact) => (
            <li key={contact.id} className="flex flex-col gap-1">
              <div className="flex items-start justify-between gap-3">
                <div className="flex min-w-0 flex-col gap-1">
                  <Link
                    href={contactHref(contact.id)}
                    className="hover:text-soft truncate text-[14px] leading-5 underline-offset-2 hover:underline"
                  >
                    {contact.name}
                  </Link>
                  <span className="caption-style text-subtle">
                    {[contact.jobTitle, contact.email]
                      .filter(Boolean)
                      .join(" · ") || "No email"}
                  </span>
                  {contact.phone && (
                    <span className="caption-style text-subtle flex items-center gap-1">
                      {contact.phone}
                      <CallLink phone={contact.phone} className="-my-1" />
                    </span>
                  )}
                </div>
                {confirming === contact.id ? (
                  <div className="flex shrink-0 items-center gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-danger hover:text-danger"
                      disabled={removing !== null}
                      onClick={() => remove(contact.id)}
                    >
                      {removing === contact.id ? "Removing…" : "Remove"}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={removing !== null}
                      onClick={() => setConfirming(null)}
                    >
                      Keep
                    </Button>
                  </div>
                ) : (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="shrink-0"
                    aria-label={`Remove ${contact.name} from this company`}
                    onClick={() => {
                      setError(null);
                      setConfirming(contact.id);
                    }}
                  >
                    Remove
                  </Button>
                )}
              </div>
              {confirming === contact.id && (
                <p className="caption-style text-soft">
                  Remove {contact.name} from this company? The contact is kept.
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </DetailSection>
  );
}

function ContactPicker({
  companyId,
  onDone,
}: {
  companyId: string;
  onDone: () => void;
}) {
  const [mode, setMode] = useState<"search" | "create">("search");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<{
    query: string;
    contacts: Contact[];
    failed?: boolean;
  } | null>(null);
  const [draft, setDraft] = useState<Draft>(() => draftFromQuery(""));
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<{ message: string; field?: string } | null>(
    null,
  );
  const trimmed = query.trim();
  const searching = results?.query !== trimmed;

  useEffect(() => {
    if (mode !== "search") return;
    let cancelled = false;
    const handle = window.setTimeout(() => {
      searchContactsToLinkAction(companyId, trimmed).then(
        (rows) => {
          if (!cancelled) setResults({ query: trimmed, contacts: rows.contacts });
        },
        () => {
          if (!cancelled)
            setResults({ query: trimmed, contacts: [], failed: true });
        },
      );
    }, 200);
    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [companyId, trimmed, mode]);

  async function link(contact: Contact) {
    if (pending) return;
    setPending(contact.id);
    const result = await linkCompanyContactAction(companyId, contact.id);
    setPending(null);
    if (result.error) {
      setError({ message: result.error });
      return;
    }
    onDone();
  }

  async function create() {
    if (pending) return;
    setPending("create");
    const result = await createCompanyContactAction(companyId, draft);
    setPending(null);
    if (result.error) {
      setError({ message: result.error, field: result.field });
      return;
    }
    onDone();
  }

  function startCreate() {
    setDraft(draftFromQuery(trimmed));
    setError(null);
    setMode("create");
  }

  function keepInPicker(event: KeyboardEvent<HTMLInputElement>, submit?: () => void) {
    if (event.key !== "Enter") return;
    event.preventDefault();
    submit?.();
  }

  const fieldId = (key: string) => `new-contact-${key}-${companyId}`;

  if (mode === "create") {
    return (
      <div className="border-line-strong flex flex-col gap-3 rounded-lg border p-3">
        <p className="caption-style text-soft">New contact at this company</p>
        <div className="grid gap-3 sm:grid-cols-2">
          {DRAFT_FIELDS.map((field) => (
            <div
              key={field.key}
              className={
                field.key === "firstName" || field.key === "lastName"
                  ? "flex flex-col gap-2"
                  : "flex flex-col gap-2 sm:col-span-2"
              }
            >
              <label className="caption-style text-subtle" htmlFor={fieldId(field.key)}>
                {field.label}
              </label>
              <Input
                id={fieldId(field.key)}
                type={field.type ?? "text"}
                value={draft[field.key]}
                aria-invalid={error?.field === field.key || undefined}
                autoFocus={field.key === "firstName"}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    [field.key]: event.target.value,
                  }))
                }
                onKeyDown={(event) => keepInPicker(event, create)}
              />
            </div>
          ))}
        </div>
        {error && (
          <p role="alert" className="caption-style text-danger">
            {error.message}
          </p>
        )}
        <div className="flex items-center gap-2">
          <Button
            variant="primary"
            size="sm"
            disabled={pending !== null}
            onClick={create}
          >
            {pending === "create" ? "Creating…" : "Create contact"}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={pending !== null}
            onClick={() => {
              setError(null);
              setMode("search");
            }}
          >
            Back to search
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="border-line-strong flex flex-col gap-2 rounded-lg border p-2">
      <label className="sr-only" htmlFor={fieldId("search")}>
        Search contacts
      </label>
      <Input
        id={fieldId("search")}
        value={query}
        autoFocus
        placeholder="Search people by name or email"
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => keepInPicker(event)}
      />
      {error && (
        <p role="alert" className="caption-style text-danger px-1">
          {error.message}
        </p>
      )}
      {searching ? (
        <p className="caption-style text-subtle px-1 py-2">Searching…</p>
      ) : results?.failed ? (
        <p role="alert" className="caption-style text-danger px-1 py-2">
          Search is unavailable right now. Try again in a moment.
        </p>
      ) : results && results.contacts.length === 0 ? (
        <p className="caption-style text-subtle px-1 py-2">
          {trimmed ? `No other contacts match “${trimmed}”.` : "No other contacts yet."}
        </p>
      ) : (
        <ul className="flex max-h-64 flex-col overflow-auto">
          {results?.contacts.map((contact) => (
            <li key={contact.id}>
              <Button
                variant="item"
                size="md"
                className="items-center"
                disabled={pending !== null}
                onClick={() => link(contact)}
              >
                <Monogram name={contact.name} />
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="truncate text-[14px] leading-5">
                    {contact.name}
                  </span>
                  <span className="caption-style text-subtle truncate">
                    {[
                      contact.email,
                      contact.companyName ? `at ${contact.companyName}` : null,
                    ]
                      .filter(Boolean)
                      .join(" · ") || "No email"}
                  </span>
                </span>
                {pending === contact.id && (
                  <span className="caption-style text-subtle shrink-0">Adding…</span>
                )}
              </Button>
            </li>
          ))}
        </ul>
      )}
      <Button
        variant="item"
        size="md"
        className="items-center"
        disabled={pending !== null}
        onClick={startCreate}
      >
        <span className="bg-muted flex size-5 shrink-0 items-center justify-center rounded-md">
          <PlusIcon aria-hidden className="text-soft size-3" />
        </span>
        <span className="truncate">
          {trimmed ? `New contact “${trimmed}”` : "New contact"}
        </span>
      </Button>
    </div>
  );
}
