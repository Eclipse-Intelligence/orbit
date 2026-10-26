"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import Button from "@/components/_ui/button";
import { Input } from "@/components/_ui/input";
import { CallLink, RecordSelect } from "@/components/crm/record-form";
import { saveContactAction, type ContactActionState } from "@/app/(crm)/records";
import { addSuggestedCompanyAction, suggestCompanyAction } from "@/app/(crm)/enrichment";
import type { CompanySuggestion } from "@/lib/enrichment/companies";
import type { Company, Contact, Member } from "@/lib/crm/types";
import { cn } from "@/lib/utils";
import CompanyLogo from "@/components/companies/company-logo";
import { textareaClass } from "@/components/_ui/field-styles";

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
  const [companyId, setCompanyId] = useState(editing?.companyId ?? "none");
  const [added, setAdded] = useState<Pick<Company, "id" | "name">[]>([]);
  const [suggestion, setSuggestion] = useState<CompanySuggestion>({ kind: "none" });
  const [adding, setAdding] = useState(false);
  const [suggestError, setSuggestError] = useState<string | null>(null);
  const asked = useRef<string | null>(null);

  async function suggest(email: string) {
    const value = email.trim().toLowerCase();
    if (companyId !== "none" || !value.includes("@") || asked.current === value) return;
    asked.current = value;
    const result = await suggestCompanyAction(value).catch(() => ({ kind: "none" }) as CompanySuggestion);
    if (asked.current === value) setSuggestion(result);
  }

  async function addSuggested() {
    if (suggestion.kind !== "new") return;
    setAdding(true);
    setSuggestError(null);
    const result = await addSuggestedCompanyAction(suggestion.name, suggestion.domain);
    setAdding(false);
    if ("error" in result) {
      setSuggestError(result.error);
      return;
    }
    setAdded((current) => [result, ...current]);
    setCompanyId(result.id);
    setSuggestion({ kind: "none" });
  }
  const handled = useRef<ContactActionState | null>(null);
  useEffect(() => {
    if (!state.ok || handled.current === state) return;
    handled.current = state;
    onSaved(state.contact);
  }, [state, onSaved]);

  const formId = `contact-form-${editing?.id ?? "new"}`;
  const companyOptions = [
    ...added,
    ...(editing?.companyId && !companies.some((company) => company.id === editing.companyId)
      ? [{ id: editing.companyId, name: editing.companyName ?? "Current company" }]
      : []),
    ...companies,
  ];

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
        <div className="flex flex-col gap-2">
          <Field
            id="contact-email"
            name="email"
            label="Email"
            defaultValue={editing?.email ?? ""}
            onBlur={(value) => void suggest(value)}
          />
          {companyId === "none" && suggestion.kind === "existing" && (
            <p className="caption-style text-subtle flex flex-wrap items-center gap-x-2">
              Works at {suggestion.company.name}?
              <Button variant="link" size="none" className="caption-style" onClick={() => setCompanyId(suggestion.company.id)}>
                Link to {suggestion.company.name}
              </Button>
            </p>
          )}
          {companyId === "none" && suggestion.kind === "new" && (
            <div className="flex items-center gap-2.5 rounded-lg bg-white/[0.03] p-2.5">
              <CompanyLogo
                company={{ name: suggestion.name, domain: suggestion.domain, logoUrl: suggestion.logoUrl }}
                clientId={null}
                className="size-7"
              />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="text-foreground truncate text-[13px] leading-5">{suggestion.name}</span>
                <span className="caption-style text-subtle truncate">{suggestion.domain} isn&apos;t in Orbit yet</span>
              </span>
              <Button variant="secondary" size="sm" disabled={adding} onClick={addSuggested}>
                {adding ? "Adding…" : "Add company"}
              </Button>
            </div>
          )}
          {suggestError && <p className="caption-style text-danger">{suggestError}</p>}
        </div>
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
          value={companyId}
          onChange={setCompanyId}
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
            className={cn(textareaClass, "min-h-24")}
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
  onBlur,
}: {
  id: string;
  name: string;
  label: string;
  defaultValue: string;
  onBlur?: (value: string) => void;
}) {
  return (
    <label className="flex flex-col gap-2" htmlFor={id}>
      <span className="caption-style text-subtle">{label}</span>
      <Input id={id} name={name} defaultValue={defaultValue} onBlur={onBlur ? (event) => onBlur(event.target.value) : undefined} />
    </label>
  );
}
