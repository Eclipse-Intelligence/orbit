"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import Button from "@/components/_ui/button";
import { Input } from "@/components/_ui/input";
import { CallLink, RecordSelect } from "@/components/crm/record-form";
import { saveContactAction, type ContactActionState } from "@/app/(crm)/records";
import type { Company, Contact, Member } from "@/lib/crm/types";
import { cn } from "@/lib/utils";

export default function ContactEditor({
  editing,
  companies,
  members,
  onSaved,
  onCancel,
  formClassName,
  footerClassName,
}: {
  editing: Contact | null;
  companies: Pick<Company, "id" | "name">[];
  members: Member[];
  onSaved: (contact: Contact | undefined) => void;
  onCancel: () => void;
  formClassName?: string;
  footerClassName?: string;
}) {
  const [state, action, pending] = useActionState(
    saveContactAction,
    {} as ContactActionState,
  );
  const [phone, setPhone] = useState(editing?.phone ?? "");
  const handled = useRef<ContactActionState | null>(null);
  useEffect(() => {
    if (!state.ok || handled.current === state) return;
    handled.current = state;
    onSaved(state.contact);
  }, [state, onSaved]);

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
    <div className="flex flex-col">
      <form
        id={formId}
        action={action}
        className={cn("flex flex-col gap-4 p-5", formClassName)}
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
      <div
        className={cn(
          "border-line-strong flex items-center justify-end gap-2 border-t px-5 py-4",
          footerClassName,
        )}
      >
        <Button variant="subtle" size="sm" type="button" onClick={onCancel} data-shortcut="cancel-edit">
          Cancel
        </Button>
        <Button
          variant="primary"
          size="sm"
          type="submit"
          form={formId}
          disabled={pending}
          data-shortcut="save"
          title="Save (⌘S)"
        >
          {pending ? "Saving…" : editing ? "Save" : "Create contact"}
        </Button>
      </div>
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
