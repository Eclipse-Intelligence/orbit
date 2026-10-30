"use client";

import { useId, useState } from "react";
import Link from "next/link";
import Button from "@/components/_ui/button";
import { addContactInlineAction } from "@/app/(crm)/records";
import { companyHref, contactHref, dealHref } from "@/lib/crm/hrefs";
import type { ThreadPerson } from "@/lib/mail/view";
import { cn } from "@/lib/utils";
import ChevronDownIcon from "@/public/assets/images/_common/chevron-down.svg";
import PlusIcon from "@/public/assets/images/_common/plus.svg";

function fallbackName(person: ThreadPerson) {
  return person.name?.trim() || person.email.split("@")[0];
}

export default function ThreadPeople({ people }: { people: ThreadPerson[] }) {
  const [added, setAdded] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const listId = useId();
  if (people.length === 0) return null;

  async function add(person: ThreadPerson) {
    setBusy(person.email);
    setError(null);
    const result = await addContactInlineAction({ name: fallbackName(person), email: person.email });
    setBusy(null);
    if (result.error || !result.contact) {
      setError(result.error ?? "Couldn't add them. Try again.");
      return;
    }
    setAdded((current) => ({ ...current, [person.email]: result.contact!.id }));
  }

  return (
    <section aria-label="People on this conversation" className="flex flex-col items-start gap-2 px-4">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen((value) => !value)}
        className="text-subtle hover:text-foreground focus-visible:ring-ring/60 -ml-1.5 flex items-center gap-1.5 rounded-md px-1.5 py-1 text-[13px] leading-5 transition-colors duration-150 outline-none focus-visible:ring-2"
      >
        Contacts
        <span className="tabular-nums">{people.length}</span>
        <ChevronDownIcon aria-hidden className={cn("ease-power3-out size-3 transition-transform duration-200", open && "rotate-180")} />
      </button>
      <ul id={listId} hidden={!open} className="flex flex-wrap gap-2">
        {people.map((person) => {
          const contactId = person.contactId ?? added[person.email] ?? null;
          const role = [person.title, person.companyName].filter(Boolean).join(" at ");
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
                      {person.companyId && person.companyName ? (
                        <>
                          {person.title ? `${person.title} at ` : ""}
                          <Link href={companyHref(person.companyId)} className="hover:text-foreground hover:underline">
                            {person.companyName}
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
                  ) : (
                    person.email
                  )}
                </span>
              </span>
              {!contactId && (
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={busy === person.email}
                  onClick={() => void add(person)}
                  aria-label={`Add ${fallbackName(person)} as a contact`}
                  title="Add contact"
                  className="shrink-0 max-sm:size-8 max-sm:p-0"
                >
                  <PlusIcon aria-hidden className={cn("size-3.5 sm:hidden", busy === person.email && "animate-pulse")} />
                  <span className="max-sm:hidden">{busy === person.email ? "Adding…" : "Add contact"}</span>
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
