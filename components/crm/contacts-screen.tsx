"use client";

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import Button from "@/components/_ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/_ui/dialog";
import { Input } from "@/components/_ui/input";
import { EntityChip, Monogram } from "@/components/beautifui/record-marks";
import ContactEditor from "@/components/crm/contact-editor";
import { RememberList } from "@/components/crm/list-memory";
import Pager from "@/components/crm/pager";
import RecordTransfer from "@/components/crm/record-transfer";
import SectionHeader from "@/components/crm/section-header";
import { CallLink, RecordList } from "@/components/crm/record-form";
import type { Viewer } from "@/components/crm/viewer";
import { companyHref, contactHref } from "@/lib/crm/hrefs";
import type { Company, Contact, Member } from "@/lib/crm/types";

export default function ContactsScreen({
  viewer,
  contacts,
  total,
  page,
  query,
  companies,
  members,
}: {
  viewer: Viewer;
  contacts: Contact[];
  total: number;
  page: number;
  query: string;
  companies: Company[];
  members: Member[];
}) {
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  const created = useCallback(
    (contact: Contact | undefined) => {
      if (!contact) {
        setCreating(false);
        router.refresh();
        return;
      }
      router.push(contactHref(contact.id));
    },
    [router],
  );

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col">
      <RememberList list="contacts" />
      <SectionHeader
        title="Contacts"
        viewer={viewer}
        action={
          <div className="flex items-center gap-1">
            <RecordTransfer resource="contacts" />
            <Button
              variant="primary"
              size="sm"
              onClick={() => setCreating(true)}
            >
              Add contact
            </Button>
          </div>
        }
      />
      <form action="/contacts" className="flex items-center gap-2 px-4 py-4">
        <label className="sr-only" htmlFor="contact-search">
          Search contacts
        </label>
        <Input
          id="contact-search"
          name="q"
          defaultValue={query}
          placeholder="Search name, email, or company"
          className="w-[240px]"
        />
      </form>
      <p className="caption-style text-subtle px-4 pb-2">
        {total} {total === 1 ? "person" : "people"}
      </p>
      <RecordList
        count={contacts.length}
        empty={
          page > 1
            ? "No contacts on this page."
            : "No contacts yet. Add the person you need to speak with."
        }
      >
        <li
          aria-hidden
          className="caption-style text-subtle border-border hidden border-b px-2.5 py-2 md:grid md:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1.3fr)_minmax(0,1fr)] md:gap-4"
        >
          <span>Name</span>
          <span>Company</span>
          <span>Email</span>
          <span>Phone</span>
        </li>
        {contacts.map((contact) => (
          <ContactRow key={contact.id} contact={contact} />
        ))}
      </RecordList>
      <Pager
        page={page}
        count={contacts.length}
        total={total}
        noun={["person", "people"]}
      />
      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogContent className="max-w-[560px]">
          <DialogHeader>
            <DialogTitle>New contact</DialogTitle>
            <DialogDescription>
              Add a person. Their record opens once they are saved.
            </DialogDescription>
          </DialogHeader>
          {creating && (
            <ContactEditor
              editing={null}
              companies={companies}
              members={members}
              onSaved={created}
              onCancel={() => setCreating(false)}
              formClassName="px-6"
              footerClassName="px-6"
            />
          )}
        </DialogContent>
      </Dialog>
    </section>
  );
}

function ContactRow({ contact }: { contact: Contact }) {
  const company =
    contact.companyName && contact.companyId ? (
      <span className="relative z-10 min-w-0">
        <EntityChip
          name={contact.companyName}
          href={companyHref(contact.companyId)}
        />
      </span>
    ) : null;
  return (
    <li className="border-border relative flex min-h-12 items-center gap-3 border-b px-2.5 py-2 transition-colors duration-150 hover:bg-white/3 md:grid md:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1.3fr)_minmax(0,1fr)] md:gap-4">
      <span className="flex min-w-0 flex-1 items-center gap-2.5">
        <Monogram name={contact.name} />
        <span className="flex min-w-0 flex-col gap-0.5">
          <Link
            href={contactHref(contact.id)}
            className="truncate text-[14px] leading-5 after:absolute after:inset-0"
          >
            {contact.name}
          </Link>
          <span className="caption-style text-subtle truncate">
            {contact.jobTitle || "No title"}
          </span>
        </span>
      </span>
      <span className="hidden min-w-0 md:block">
        {company ?? <span className="caption-style text-subtle">—</span>}
      </span>
      <span className="hidden min-w-0 md:block">
        {contact.email ? (
          <a
            href={`mailto:${contact.email}`}
            className="relative z-10 block truncate text-[14px] leading-5 hover:underline"
          >
            {contact.email}
          </a>
        ) : (
          <span className="caption-style text-subtle">—</span>
        )}
      </span>
      <span className="hidden min-w-0 items-center gap-1 md:flex">
        {contact.phone ? (
          <>
            <span className="truncate text-[14px] leading-5">
              {contact.phone}
            </span>
            <span className="relative z-10">
              <CallLink phone={contact.phone} />
            </span>
          </>
        ) : (
          <span className="caption-style text-subtle">—</span>
        )}
      </span>
      <span className="flex shrink-0 items-center gap-1 md:hidden">
        <span className="relative z-10">
          <CallLink phone={contact.phone} />
        </span>
        {company}
      </span>
    </li>
  );
}
