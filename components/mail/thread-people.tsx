"use client";

import { useId, useState } from "react";
import Link from "next/link";
import Button from "@/components/_ui/button";
import ThreadFilingMenu from "@/components/mail/thread-filing";
import WorkspaceTile from "@/components/workspaces/workspace-tile";
import { addContactInlineAction } from "@/app/(crm)/records";
import { addPersonHereAction } from "@/app/(crm)/mail/actions";
import { companyHref, contactHref, dealHref } from "@/lib/crm/hrefs";
import type { ThreadFiling, ThreadPerson } from "@/lib/mail/view";
import { cn } from "@/lib/utils";
import ChevronDownIcon from "@/public/assets/images/_common/chevron-down.svg";
import PlusIcon from "@/public/assets/images/_common/plus.svg";

function fallbackName(person: ThreadPerson) {
  return person.name?.trim() || person.email.split("@")[0];
}

type Added = { contactId: string; companyId: string | null; companyName: string | null; title: string | null };

export default function ThreadPeople({ people, threadKey, filing: initialFiling }: { people: ThreadPerson[]; threadKey: string; filing: ThreadFiling | null }) {
  const [added, setAdded] = useState<Record<string, Added>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [filing, setFiling] = useState(initialFiling);
  const [message, setMessage] = useState<{ text: string; error: boolean; quiet?: boolean } | null>(null);
  const listId = useId();
  if (people.length === 0) return null;
  const active = filing?.active ?? null;

  async function add(person: ThreadPerson) {
    setBusy(person.email);
    setError(null);
    if (person.elsewhere?.length && active) {
      const result = await addPersonHereAction(threadKey, person.email);
      setBusy(null);
      if (result.error || !result.person) {
        setError(result.error ?? "Couldn't add them. Try again.");
        return;
      }
      setAdded((current) => ({ ...current, [person.email]: result.person! }));
      if (result.filing !== undefined) setFiling(result.filing);
      return;
    }
    const result = await addContactInlineAction({ name: fallbackName(person), email: person.email });
    setBusy(null);
    if (result.error || !result.contact) {
      setError(result.error ?? "Couldn't add them. Try again.");
      return;
    }
    setAdded((current) => ({
      ...current,
      [person.email]: { contactId: result.contact!.id, companyId: result.contact!.company?.id ?? null, companyName: result.contact!.company?.name ?? null, title: null },
    }));
  }

  return (
    <section aria-label="People on this conversation" className="flex flex-col gap-2 px-4">
      <div className="flex min-w-0 items-center justify-between gap-2">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={listId}
          onClick={() => setOpen((value) => !value)}
          className="text-subtle hover:text-foreground focus-visible:ring-ring/60 -ml-1.5 flex shrink-0 items-center gap-1.5 rounded-md px-1.5 py-1 text-[13px] leading-5 transition-colors duration-150 outline-none focus-visible:ring-2"
        >
          Contacts
          <span className="tabular-nums">{people.length}</span>
          <ChevronDownIcon aria-hidden className={cn("ease-power3-out size-3 transition-transform duration-200", open && "rotate-180")} />
        </button>
        {filing && (
          <span className="flex min-w-0 flex-1 justify-end">
            <ThreadFilingMenu threadKey={threadKey} filing={filing} onChange={setFiling} onMessage={setMessage} />
          </span>
        )}
      </div>
      {message?.error && (
        <p role="alert" className="caption-style text-danger">
          {message.text}
        </p>
      )}
      <p role="status" className={message && !message.error && !message.quiet ? "caption-style text-subtle" : "sr-only"}>
        {message && !message.error ? message.text : ""}
      </p>
      <ul id={listId} hidden={!open} className="flex flex-wrap gap-2">
        {people.map((person) => {
          const saved = added[person.email];
          const contactId = person.contactId ?? saved?.contactId ?? null;
          const companyId = person.contactId ? person.companyId : (saved?.companyId ?? null);
          const companyName = person.contactId ? person.companyName : (saved?.companyName ?? person.companyName);
          const title = person.contactId ? person.title : (saved?.title ?? person.title);
          const elsewhere = contactId ? [] : (person.elsewhere ?? []);
          const role = [title, companyName].filter(Boolean).join(" at ");
          const addHere = elsewhere.length > 0 && active;
          return (
            <li key={person.email} className="flex max-w-full min-w-0 items-center gap-2 rounded-xl bg-white/[0.035] py-1.5 pr-1.5 pl-3 text-[13px] leading-5">
              <span className="flex min-w-0 flex-col">
                {contactId ? (
                  <Link href={contactHref(contactId)} className="text-foreground truncate font-medium hover:underline hover:decoration-white/40 hover:underline-offset-2">
                    {fallbackName(person)}
                  </Link>
                ) : (
                  <span className="text-foreground truncate font-medium" title={person.email}>
                    {fallbackName(person)}
                  </span>
                )}
                <span className="text-subtle truncate text-[12px]">
                  {contactId ? (
                    <>
                      {companyId && companyName ? (
                        <>
                          {title ? `${title} at ` : ""}
                          <Link href={companyHref(companyId)} className="hover:text-foreground hover:underline">
                            {companyName}
                          </Link>
                        </>
                      ) : (
                        role || person.email
                      )}
                      {person.dealId && (
                        <>
                          {" · "}
                          <Link href={dealHref(person.dealId)} className="hover:text-foreground hover:underline">
                            {person.dealName}
                            {person.dealStage ? ` (${person.dealStage})` : ""}
                          </Link>
                        </>
                      )}
                    </>
                  ) : elsewhere.length ? (
                    role || person.email
                  ) : (
                    person.email
                  )}
                </span>
              </span>
              {elsewhere.map((place) => (
                <span
                  key={place.id}
                  className="text-soft flex h-[22px] shrink-0 items-center gap-1.5 rounded-full bg-white/[0.05] pr-2 pl-[3px] text-[12px] leading-none"
                >
                  <WorkspaceTile id={place.id} name={place.name} className="size-4 rounded-full text-[9px]" />
                  In {place.name}
                </span>
              ))}
              {!contactId && (
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={busy === person.email}
                  onClick={() => void add(person)}
                  aria-label={addHere ? `Add ${fallbackName(person)} to ${active.name}` : `Add ${fallbackName(person)} as a contact`}
                  title={addHere ? `Add to ${active.name}` : "Add contact"}
                  className="shrink-0 max-sm:size-8 max-sm:p-0"
                >
                  <PlusIcon aria-hidden className={cn("size-3.5 sm:hidden", busy === person.email && "animate-pulse")} />
                  <span className="max-sm:hidden">{busy === person.email ? "Adding…" : addHere ? `Add to ${active.name}` : "Add contact"}</span>
                </Button>
              )}
            </li>
          );
        })}
      </ul>
      {error && (
        <p role="alert" className="caption-style text-danger">
          {error}
        </p>
      )}
    </section>
  );
}
