"use client";

import { useActionState, useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Button from "@/components/_ui/button";
import { Input } from "@/components/_ui/input";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/_ui/sheet";
import { EntityChip, Monogram } from "@/components/beautifui/record-marks";
import ContactActivities from "@/components/crm/contact-activities";
import Pager from "@/components/crm/pager";
import RecordTransfer from "@/components/crm/record-transfer";
import SectionHeader from "@/components/crm/section-header";
import {
  CallLink,
  RecordList,
  RecordRow,
  RecordSelect,
} from "@/components/crm/record-form";
import type { Viewer } from "@/components/crm/viewer";
import { saveContactAction, type ContactActionState } from "@/app/(crm)/records";
import type { Activity, CallInsight, Company, Contact, Member } from "@/lib/crm/types";

export default function ContactsScreen({
  viewer,
  contacts,
  linkedContact,
  total,
  page,
  query,
  companies,
  members,
  mailboxConnected,
  activitiesByContact,
  insights,
}: {
  viewer: Viewer;
  contacts: Contact[];
  linkedContact: Contact | null;
  total: number;
  page: number;
  query: string;
  companies: Company[];
  members: Member[];
  mailboxConnected: boolean;
  activitiesByContact: Record<string, Activity[]>;
  insights: Record<string, CallInsight>;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(Boolean(linkedContact));
  const [selected, setSelected] = useState<Contact | null>(linkedContact);
  const [mode, setMode] = useState<"view" | "edit">("view");
  const [session, setSession] = useState(0);
  const [linkedId, setLinkedId] = useState(linkedContact?.id ?? null);
  if ((linkedContact?.id ?? null) !== linkedId) {
    setLinkedId(linkedContact?.id ?? null);
    if (linkedContact) {
      setSelected(linkedContact);
      setMode("view");
      setSession((current) => current + 1);
      setOpen(true);
    }
  }
  const current = selected
    ? (contacts.find((contact) => contact.id === selected.id) ??
      (linkedContact?.id === selected.id ? linkedContact : null) ??
      selected)
    : null;
  const close = useCallback(() => {
    setOpen(false);
    const params = new URLSearchParams(window.location.search);
    if (!params.has("contact")) return;
    params.delete("contact");
    const next = params.toString();
    router.replace(next ? `/contacts?${next}` : "/contacts", { scroll: false });
  }, [router]);

  function show(contact: Contact | null) {
    setSelected(contact);
    setMode(contact ? "view" : "edit");
    setSession((current) => current + 1);
    setOpen(true);
  }

  const saved = useCallback(
    (contact: Contact | undefined) => {
      if (!contact) {
        close();
        return;
      }
      setSelected(contact);
      setMode("view");
    },
    [close],
  );

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col">
      <SectionHeader
        title="Contacts"
        viewer={viewer}
        action={
          <div className="flex items-center gap-1">
            <RecordTransfer resource="contacts" />
            <Button variant="primary" size="sm" onClick={() => show(null)}>
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
            onClick={() => show(contact)}
            action={
              <>
                <CallLink phone={contact.phone} />
                {contact.companyName && contact.companyId ? (
                  <EntityChip
                    name={contact.companyName}
                    href={`/?record=${contact.companyId}`}
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
      <Sheet
        open={open}
        onOpenChange={(next) => (next ? setOpen(true) : close())}
      >
        <SheetContent side="right" className="sm:w-[480px] sm:max-w-[480px]">
          <SheetHeader>
            <SheetTitle>
              {!current ? "New contact" : mode === "edit" ? "Edit contact" : "Contact"}
            </SheetTitle>
            <SheetDescription className="sr-only">
              Contact details
            </SheetDescription>
          </SheetHeader>
          {current && mode === "view" ? (
            <ContactPreview
              key={`${current.id}-${session}`}
              contact={current}
              members={members}
              mailboxConnected={mailboxConnected}
              activities={activitiesByContact[current.id] ?? []}
              insights={insights}
              onEdit={() => setMode("edit")}
              onClose={close}
            />
          ) : (
            <ContactEditor
              key={`${current?.id ?? "new"}-${session}-edit`}
              editing={current}
              companies={companies}
              members={members}
              onSaved={saved}
              onCancel={current ? () => setMode("view") : close}
            />
          )}
        </SheetContent>
      </Sheet>
    </section>
  );
}

function ContactPreview({
  contact,
  members,
  mailboxConnected,
  activities,
  insights,
  onEdit,
  onClose,
}: {
  contact: Contact;
  members: Member[];
  mailboxConnected: boolean;
  activities: Activity[];
  insights: Record<string, CallInsight>;
  onEdit: () => void;
  onClose: () => void;
}) {
  const owner = members.find((member) => member.id === contact.ownerId);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-auto p-5">
        <div className="flex items-start gap-3">
          <Monogram name={contact.name} className="size-10 rounded-full text-[14px]" />
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <p className="text-[16px] leading-6 font-medium">{contact.name}</p>
            {(contact.jobTitle || contact.companyName) && (
              <div className="caption-style text-subtle flex flex-wrap items-center gap-1.5">
                {contact.jobTitle && <span>{contact.jobTitle}</span>}
                {contact.jobTitle && contact.companyName && <span>at</span>}
                {contact.companyName && contact.companyId && (
                  <EntityChip
                    name={contact.companyName}
                    href={`/?record=${contact.companyId}`}
                  />
                )}
              </div>
            )}
          </div>
        </div>
        <dl className="grid grid-cols-[6em_1fr] gap-x-3 gap-y-2 text-[14px] leading-5">
          <Detail label="Phone">
            {contact.phone ? (
              <span className="flex items-center gap-1">
                <span>{contact.phone}</span>
                <CallLink phone={contact.phone} />
              </span>
            ) : null}
          </Detail>
          <Detail label="Email">
            {contact.email ? (
              <a href={`mailto:${contact.email}`} className="hover:underline">
                {contact.email}
              </a>
            ) : null}
          </Detail>
          <Detail label="LinkedIn">
            {contact.linkedinUrl ? (
              <a
                href={contact.linkedinUrl}
                target="_blank"
                rel="noreferrer"
                className="block truncate hover:underline"
              >
                {contact.linkedinUrl.replace(/^https?:\/\/(www\.)?/, "")}
              </a>
            ) : null}
          </Detail>
          <Detail label="Owner">{owner?.name ?? null}</Detail>
          <Detail label="Source">{contact.source}</Detail>
        </dl>
        {contact.notes && (
          <div className="flex flex-col gap-1">
            <span className="caption-style text-subtle">Notes</span>
            <p className="text-[14px] leading-5 whitespace-pre-wrap">{contact.notes}</p>
          </div>
        )}
        <ContactActivities
          contactId={contact.id}
          email={contact.email}
          mailboxConnected={mailboxConnected}
          profileNote={contact.notes}
          activities={activities}
          insights={insights}
        />
      </div>
      <SheetFooter>
        <Button variant="subtle" size="sm" type="button" onClick={onClose}>
          Close
        </Button>
        <Button variant="primary" size="sm" type="button" onClick={onEdit}>
          Edit
        </Button>
      </SheetFooter>
    </div>
  );
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="caption-style text-subtle leading-5">{label}</dt>
      <dd className="min-w-0">{children ?? <span className="text-subtle">—</span>}</dd>
    </>
  );
}

function ContactEditor({
  editing,
  companies,
  members,
  onSaved,
  onCancel,
}: {
  editing: Contact | null;
  companies: Company[];
  members: Member[];
  onSaved: (contact: Contact | undefined) => void;
  onCancel: () => void;
}) {
  const [state, action, pending] = useActionState(
    saveContactAction,
    {} as ContactActionState,
  );
  const [phone, setPhone] = useState(editing?.phone ?? "");
  useEffect(() => {
    if (state.ok) onSaved(editing ? state.contact : undefined);
  }, [state, onSaved, editing]);

  const formId = `contact-form-${editing?.id ?? "new"}`;
  const companyOptions =
    editing?.companyId &&
    !companies.some((company) => company.id === editing.companyId)
      ? [
          {
            id: editing.companyId,
            name: editing.companyName ?? "Current company",
          },
          ...companies,
        ]
      : companies;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-5">
        <form id={formId} action={action} className="flex flex-col gap-4">
          <input type="hidden" name="id" value={editing?.id ?? ""} />
          {state.error && !state.ok && (
            <p role="alert" className="caption-style text-danger">
              {state.error}
            </p>
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              id="contact-first"
              name="firstName"
              label="First name"
              defaultValue={editing?.firstName ?? ""}
            />
            <Field
              id="contact-last"
              name="lastName"
              label="Last name"
              defaultValue={editing?.lastName ?? ""}
            />
          </div>
          <Field
            id="contact-email"
            name="email"
            label="Email"
            defaultValue={editing?.email ?? ""}
          />
          <Field
            id="contact-title"
            name="jobTitle"
            label="Title"
            defaultValue={editing?.jobTitle ?? ""}
          />
          <div className="flex flex-col gap-2">
            <label className="caption-style text-subtle" htmlFor="contact-phone">
              Phone
            </label>
            <div className="flex items-center gap-2">
              <Input
                id="contact-phone"
                name="phone"
                value={phone}
                onChange={(event) => setPhone(event.target.value)}
              />
              <CallLink phone={phone} className="size-9" />
            </div>
          </div>
          <Field
            id="contact-linkedin"
            name="linkedinUrl"
            label="LinkedIn"
            defaultValue={editing?.linkedinUrl ?? ""}
          />
          <RecordSelect
            id="contact-company"
            name="companyId"
            label="Company"
            defaultValue={editing?.companyId ?? "none"}
          >
            <option value="none">No company</option>
            {companyOptions.map((company) => (
              <option key={company.id} value={company.id}>
                {company.name}
              </option>
            ))}
          </RecordSelect>
          <RecordSelect
            id="contact-owner"
            name="ownerId"
            label="Owner"
            defaultValue={editing?.ownerId ?? "unassigned"}
          >
            <option value="unassigned">Unassigned</option>
            {members.map((member) => (
              <option key={member.id} value={member.id}>
                {member.name}
              </option>
            ))}
          </RecordSelect>
          <Field
            id="contact-source"
            name="source"
            label="Source"
            defaultValue={editing?.source ?? ""}
          />
          <label className="flex flex-col gap-2" htmlFor="contact-notes">
            <span className="caption-style text-subtle">Notes</span>
            <textarea
              id="contact-notes"
              name="notes"
              defaultValue={editing?.notes ?? ""}
              className="border-line-strong bg-secondary min-h-24 w-full rounded-lg border px-3 py-2 text-[14px] leading-5 outline-none"
            />
          </label>
        </form>
      </div>
      <SheetFooter>
        <Button variant="subtle" size="sm" type="button" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          variant="primary"
          size="sm"
          type="submit"
          form={formId}
          disabled={pending}
        >
          {pending ? "Saving…" : "Save"}
        </Button>
      </SheetFooter>
    </div>
  );
}

function Field({
  id,
  name,
  label,
  defaultValue,
}: {
  id: string;
  name: string;
  label: string;
  defaultValue: string;
}) {
  return (
    <label className="flex flex-col gap-2" htmlFor={id}>
      <span className="caption-style text-subtle">{label}</span>
      <Input id={id} name={name} defaultValue={defaultValue} />
    </label>
  );
}
