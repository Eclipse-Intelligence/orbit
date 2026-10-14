"use client";

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
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
import { CallLink, RecordList, RecordRow } from "@/components/crm/record-form";
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
            <Button variant="primary" size="sm" onClick={() => setCreating(true)}>
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
        {contacts.map((contact) => (
          <RecordRow
            key={contact.id}
            mark={<Monogram name={contact.name} />}
            title={contact.name}
            meta={
              [contact.jobTitle, contact.email, contact.phone]
                .filter(Boolean)
                .join(" · ") || "No title"
            }
            href={contactHref(contact.id)}
            action={
              <>
                <CallLink phone={contact.phone} />
                {contact.companyName && contact.companyId ? (
                  <EntityChip
                    name={contact.companyName}
                    href={companyHref(contact.companyId)}
                  />
                ) : null}
              </>
            }
          />
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
