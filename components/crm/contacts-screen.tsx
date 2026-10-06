"use client";

import { useActionState, useState } from "react";
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
import RecordTransfer from "@/components/crm/record-transfer";
import SectionHeader from "@/components/crm/section-header";
import {
  RecordList,
  RecordRow,
  RecordSelect,
} from "@/components/crm/record-form";
import type { Viewer } from "@/components/crm/viewer";
import { saveContactAction, type RecordActionState } from "@/app/(crm)/records";
import type { Activity, Company, Contact, Member } from "@/lib/crm/types";

export default function ContactsScreen({
  viewer,
  contacts,
  total,
  query,
  companies,
  members,
  mailboxConnected,
  activitiesByContact,
}: {
  viewer: Viewer;
  contacts: Contact[];
  total: number;
  query: string;
  companies: Company[];
  members: Member[];
  mailboxConnected: boolean;
  activitiesByContact: Record<string, Activity[]>;
}) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Contact | null>(null);
  const [state, action, pending] = useActionState(
    saveContactAction,
    {} as RecordActionState,
  );
  const [closedFor, setClosedFor] = useState<RecordActionState | null>(null);
  if (state.ok && closedFor !== state) {
    setClosedFor(state);
    setOpen(false);
  }

  function edit(contact: Contact) {
    setEditing(contact);
    setOpen(true);
  }

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col">
      <SectionHeader
        title="Contacts"
        viewer={viewer}
        action={
          <div className="flex items-center gap-1">
            <RecordTransfer resource="contacts" />
            <Button
              variant="primary"
              size="sm"
              onClick={() => {
                setEditing(null);
                setOpen(true);
              }}
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
        empty="No contacts yet. Add the person you need to speak with."
      >
        {contacts.map((contact) => (
          <RecordRow
            key={contact.id}
            mark={<Monogram name={contact.name} />}
            title={contact.name}
            meta={
              [contact.jobTitle, contact.email].filter(Boolean).join(" · ") ||
              "No title"
            }
            onClick={() => edit(contact)}
            action={
              contact.companyName && contact.companyId ? (
                <EntityChip
                  name={contact.companyName}
                  href={`/?record=${contact.companyId}`}
                />
              ) : null
            }
          />
        ))}
      </RecordList>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="right" className="sm:w-[480px] sm:max-w-[480px]">
          <SheetHeader>
            <SheetTitle>{editing ? "Edit contact" : "New contact"}</SheetTitle>
            <SheetDescription className="sr-only">
              Contact details
            </SheetDescription>
          </SheetHeader>
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-5">
              <form
            key={`fields-${editing?.id ?? "new"}`}
            id={`contact-form-${editing?.id ?? "new"}`}
                action={action}
                className="flex flex-col gap-4"
              >
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
                <Field
                  id="contact-phone"
                  name="phone"
                  label="Phone"
                  defaultValue={editing?.phone ?? ""}
                />
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
                  {companies.map((company) => (
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
              {editing && (
                <ContactActivities
                  key={`activities-${editing.id}`}
                  contactId={editing.id}
                  email={editing.email}
                  mailboxConnected={mailboxConnected}
                  profileNote={editing.notes}
                  activities={activitiesByContact[editing.id] ?? []}
                />
              )}
            </div>
            <SheetFooter>
              <Button
                variant="subtle"
                size="sm"
                type="button"
                onClick={() => setOpen(false)}
              >
                Cancel
              </Button>
              <Button
                variant="primary"
                size="sm"
                type="submit"
                form={`contact-form-${editing?.id ?? "new"}`}
                disabled={pending}
              >
                {pending ? "Saving…" : "Save"}
              </Button>
            </SheetFooter>
          </div>
        </SheetContent>
      </Sheet>
    </section>
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
