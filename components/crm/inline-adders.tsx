"use client";

import { useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import Button from "@/components/_ui/button";
import RecordCombobox from "@/components/crm/record-combobox";
import type { PickedRecord } from "@/components/crm/record-picker";
import { addCompanyInlineAction, addContactInlineAction } from "@/app/(crm)/records";
import { companyHref, contactHref } from "@/lib/crm/hrefs";
import { cn } from "@/lib/utils";
import PlusIcon from "@/public/assets/images/_common/plus.svg";

const FIELD_CLASS =
  "border-line-strong bg-secondary text-foreground placeholder:text-subtle focus-visible:border-ring flex h-9 w-full min-w-0 rounded-lg border px-3 text-[14px] leading-none outline-none";

type Added = { name: string; href: string };

function Feedback({ error, added }: { error: string | null; added: Added | null }) {
  if (error) {
    return (
      <p role="alert" className="caption-style text-danger">
        {error}
      </p>
    );
  }
  return (
    <p role="status" className="caption-style text-subtle min-h-4">
      {added && (
        <>
          {added.name} added.{" "}
          <Link href={added.href} className="text-foreground underline underline-offset-2">
            Open
          </Link>
        </>
      )}
    </p>
  );
}

function Row({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("flex flex-col gap-1.5 px-2.5 py-2.5", className)}>
      <div className="flex flex-col gap-2 md:flex-row md:items-start">
        <span aria-hidden className="text-subtle hidden h-9 w-5 shrink-0 items-center justify-center md:flex">
          <PlusIcon className="size-3.5" />
        </span>
        {children}
      </div>
    </div>
  );
}

export function CompanyAdder({ className }: { className?: string }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [domain, setDomain] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState<Added | null>(null);
  const nameInput = useRef<HTMLInputElement>(null);

  async function submit() {
    if (pending) return;
    if (!name.trim()) {
      setError("Type the company's name.");
      nameInput.current?.focus();
      return;
    }
    setPending(true);
    setError(null);
    const result = await addCompanyInlineAction({ name, domain });
    setPending(false);
    if (!result.company) {
      setError(result.error ?? "That did not work. Try again.");
      return;
    }
    setAdded({ name: result.company.name, href: companyHref(result.company.id) });
    setName("");
    setDomain("");
    router.refresh();
    nameInput.current?.focus();
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      event.preventDefault();
      void submit();
    }
    if (event.key === "Escape") {
      setName("");
      setDomain("");
      setError(null);
      event.currentTarget.blur();
    }
  }

  return (
    <Row className={className}>
      <input
        ref={nameInput}
        id="inline-add-company"
        aria-label="New company name"
        placeholder="Add a company…"
        autoComplete="off"
        value={name}
        onChange={(event) => {
          setName(event.target.value);
          setError(null);
        }}
        onKeyDown={onKeyDown}
        className={cn(FIELD_CLASS, "md:w-[18em] md:flex-none")}
      />
      {name.trim() && (
        <>
          <input
            aria-label="Website or domain"
            placeholder="Website (optional)"
            autoComplete="off"
            value={domain}
            onChange={(event) => setDomain(event.target.value)}
            onKeyDown={onKeyDown}
            className={cn(FIELD_CLASS, "md:w-[14em] md:flex-none")}
          />
          <Button variant="primary" size="sm" className="self-start md:mt-[3px]" disabled={pending} onClick={() => void submit()}>
            {pending ? "Adding…" : "Add"}
          </Button>
        </>
      )}
      <Feedback error={error} added={added} />
    </Row>
  );
}

export function ContactAdder({ className }: { className?: string }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [company, setCompany] = useState<PickedRecord | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState<Added | null>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const started = Boolean(name.trim() || email.trim() || company);

  async function submit() {
    if (pending) return;
    if (!name.trim() && !email.trim()) {
      setError("Type a name or an email.");
      nameInput.current?.focus();
      return;
    }
    setPending(true);
    setError(null);
    const result = await addContactInlineAction({ name, email, companyId: company?.id ?? null });
    setPending(false);
    if (!result.contact) {
      setError(result.error ?? "That did not work. Try again.");
      return;
    }
    setAdded({ name: result.contact.name, href: contactHref(result.contact.id) });
    setName("");
    setEmail("");
    router.refresh();
    nameInput.current?.focus();
  }

  function clear() {
    setName("");
    setEmail("");
    setCompany(null);
    setError(null);
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      event.preventDefault();
      void submit();
    }
    if (event.key === "Escape") {
      clear();
      event.currentTarget.blur();
    }
  }

  return (
    <Row className={className}>
      <input
        ref={nameInput}
        id="inline-add-contact"
        aria-label="New person's name"
        placeholder="Add a person…"
        autoComplete="off"
        value={name}
        onChange={(event) => {
          setName(event.target.value);
          setError(null);
        }}
        onKeyDown={onKeyDown}
        className={cn(FIELD_CLASS, "md:w-[16em] md:flex-none")}
      />
      {started && (
        <>
          <input
            type="email"
            aria-label="Email"
            placeholder="Email (optional)"
            autoComplete="off"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            onKeyDown={onKeyDown}
            className={cn(FIELD_CLASS, "md:w-[16em] md:flex-none")}
          />
          <RecordCombobox
            id="inline-add-contact-company"
            kind="company"
            label="Company"
            placeholder="Company (optional)"
            value={company}
            onChange={setCompany}
            allowCreate
            onSubmit={() => void submit()}
            onCancel={clear}
            className="md:w-[16em] md:flex-none"
          />
          <Button variant="primary" size="sm" className="self-start md:mt-[3px]" disabled={pending} onClick={() => void submit()}>
            {pending ? "Adding…" : "Add"}
          </Button>
        </>
      )}
      <Feedback error={error} added={added} />
    </Row>
  );
}
