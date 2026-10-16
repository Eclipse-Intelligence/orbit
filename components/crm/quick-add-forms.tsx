"use client";

import {
  startTransition,
  useActionState,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import Link from "next/link";
import Button from "@/components/_ui/button";
import { DialogClose, DialogFooter, DialogHeader, DialogTitle } from "@/components/_ui/dialog";
import Field from "@/components/_ui/field";
import { Input } from "@/components/_ui/input";
import { recordSelectClass } from "@/components/crm/record-form";
import RecordPicker, { type PickedRecord } from "@/components/crm/record-picker";
import TaskPad from "@/components/crm/task-pad";
import { TagChip, TagOptions, TagPopover } from "@/components/crm/tags";
import { createCompanyAction, type CompanyActionState } from "@/app/(crm)/actions";
import type { QuickAddSetup } from "@/app/(crm)/quick-add";
import {
  saveContactAction,
  saveOpportunityAction,
  type ContactActionState,
  type RecordActionState,
} from "@/app/(crm)/records";
import { companyHref, contactHref } from "@/lib/crm/hrefs";
import type { QuickAddKind, QuickAddPrefill } from "@/lib/crm/quick-add";
import { TASKS_PATH } from "@/lib/crm/task-views";
import PlusIcon from "@/public/assets/images/_common/plus.svg";

export type QuickAddNotice = { message: string; href?: string; link?: string };

type FormProps = {
  prefill: QuickAddPrefill;
  setup: QuickAddSetup | null;
  viewerId: string;
  onDone: (notice: QuickAddNotice) => void;
};

const TITLES: Record<QuickAddKind, string> = {
  task: "Add task",
  contact: "Add contact",
  company: "Add company",
  opportunity: "Add opportunity",
};

function useSettled<T extends object>(state: T, done: (state: T) => boolean, run: (state: T) => void) {
  const handled = useRef<T | null>(null);
  useEffect(() => {
    if (handled.current === state || !done(state)) return;
    handled.current = state;
    run(state);
  });
}

function fieldError(state: { error?: string; field?: string }, fields: string[], field: string) {
  if (!state.error || !state.field || !fields.includes(state.field)) return undefined;
  return state.field === field ? state.error : undefined;
}

function FormError({
  state,
  fields,
  existing,
}: {
  state: { error?: string; field?: string; existingId?: string };
  fields: string[];
  existing?: (id: string) => string;
}) {
  if (!state.error || (state.field && fields.includes(state.field))) return null;
  return (
    <p role="alert" className="caption-style text-danger flex flex-wrap items-center gap-x-2 gap-y-1">
      <span>{state.error}</span>
      {state.existingId && existing && (
        <Link
          href={existing(state.existingId)}
          className="text-foreground underline underline-offset-2 hover:text-soft"
        >
          Open existing
        </Link>
      )}
    </p>
  );
}

function Shell({
  kind,
  action,
  pending,
  children,
}: {
  kind: QuickAddKind;
  action: (formData: FormData) => void;
  pending: boolean;
  children: ReactNode;
}) {
  return (
    <form
      className="flex flex-col"
      onSubmit={(event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        startTransition(() => action(data));
      }}
    >
      <DialogHeader className="py-4 pr-14">
        <DialogTitle>{TITLES[kind]}</DialogTitle>
      </DialogHeader>
      <div className="flex flex-col gap-4 px-6 py-5">{children}</div>
      <DialogFooter>
        <DialogClose asChild>
          <Button variant="subtle" size="sm">
            Cancel
          </Button>
        </DialogClose>
        <Button variant="primary" size="sm" type="submit" disabled={pending}>
          <PlusIcon aria-hidden className="size-3" />
          {pending ? "Adding…" : TITLES[kind]}
        </Button>
      </DialogFooter>
    </form>
  );
}

function LinkField({
  id,
  label,
  kind,
  name,
  value,
  onChange,
  empty,
  placeholder,
  required,
  error,
}: {
  id: string;
  label: string;
  kind: "contact" | "company";
  name: string;
  value: PickedRecord | null;
  onChange: (value: PickedRecord | null) => void;
  empty: string;
  placeholder: string;
  required?: boolean;
  error?: string;
}) {
  return (
    <Field label={label} htmlFor={id} required={required} error={error}>
      <input type="hidden" name={name} value={value?.id ?? empty} />
      <RecordPicker
        id={id}
        kind={kind}
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        invalid={Boolean(error)}
      />
    </Field>
  );
}

function TagsField({ id, suggestions }: { id: string; suggestions: QuickAddSetup["tags"] }) {
  const [tags, setTags] = useState<string[]>([]);
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-col gap-2">
      <span id={id} className="caption-style text-soft">
        Tags
      </span>
      <div role="group" aria-labelledby={id} className="flex flex-wrap items-center gap-1">
        {tags.map((tag) => (
          <span key={tag} className="contents">
            <input type="hidden" name="tags" value={tag} />
            <TagChip name={tag} onRemove={() => setTags((current) => current.filter((item) => item !== tag))} />
          </span>
        ))}
        <TagPopover
          open={open}
          onOpenChange={setOpen}
          trigger={
            <Button variant="ghost" size="none" aria-label="Add a tag" className="h-[22px] gap-1 px-2 text-[12px]">
              <PlusIcon aria-hidden className="size-3" />
              Tag
            </Button>
          }
        >
          <TagOptions
            suggestions={suggestions}
            exclude={tags}
            onPick={(tag) => {
              setOpen(false);
              setTags((current) => (current.includes(tag) ? current : [...current, tag]));
            }}
          />
        </TagPopover>
      </div>
    </div>
  );
}

export function QuickTaskForm({ prefill, setup, onDone }: FormProps) {
  return (
    <div className="flex flex-col">
      <DialogHeader className="py-4 pr-14">
        <DialogTitle>{TITLES.task}</DialogTitle>
      </DialogHeader>
      <div className="px-6 pt-5 pb-6">
        <TaskPad
          clickup={setup?.clickup ?? null}
          initialContact={prefill.contact}
          initialCompany={prefill.company}
          autoFocus
          onAdded={(result) => onDone({ message: result.warning ?? "Task added", href: TASKS_PATH, link: "Open" })}
        />
      </div>
    </div>
  );
}

const CONTACT_FIELDS = ["firstName", "lastName", "email", "phone", "jobTitle", "companyId", "tags"];

export function QuickContactForm({ prefill, setup, onDone }: FormProps) {
  const [state, action, pending] = useActionState(saveContactAction, {} as ContactActionState);
  const [company, setCompany] = useState<PickedRecord | null>(prefill.company);
  const error = (field: string) => fieldError(state, CONTACT_FIELDS, field);

  useSettled(
    state,
    (current) => Boolean(current.ok && current.contact),
    (current) =>
      onDone({
        message: `${current.contact?.name ?? "Contact"} added`,
        href: current.contact ? contactHref(current.contact.id) : undefined,
        link: "Open",
      }),
  );

  return (
    <Shell kind="contact" action={action} pending={pending}>
      <FormError state={state} fields={CONTACT_FIELDS} existing={contactHref} />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="First name" htmlFor="quick-contact-first" error={error("firstName")}>
          <Input id="quick-contact-first" name="firstName" autoComplete="off" />
        </Field>
        <Field label="Last name" htmlFor="quick-contact-last" error={error("lastName")}>
          <Input id="quick-contact-last" name="lastName" autoComplete="off" />
        </Field>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Email" htmlFor="quick-contact-email" error={error("email")}>
          <Input id="quick-contact-email" name="email" type="email" autoComplete="off" />
        </Field>
        <Field label="Phone" htmlFor="quick-contact-phone" error={error("phone")}>
          <Input id="quick-contact-phone" name="phone" type="tel" autoComplete="off" />
        </Field>
      </div>
      <Field label="Job title" htmlFor="quick-contact-title" error={error("jobTitle")}>
        <Input id="quick-contact-title" name="jobTitle" autoComplete="off" />
      </Field>
      <LinkField
        id="quick-contact-company"
        label="Company"
        kind="company"
        name="companyId"
        empty="none"
        value={company}
        onChange={setCompany}
        placeholder="Choose a company"
        error={error("companyId")}
      />
      <TagsField id="quick-contact-tags" suggestions={setup?.tags ?? []} />
      {error("tags") && (
        <p role="alert" className="caption-style text-danger">
          {error("tags")}
        </p>
      )}
    </Shell>
  );
}

const COMPANY_FIELDS = ["name", "domain", "website", "tags"];

export function QuickCompanyForm({ setup, viewerId, onDone }: FormProps) {
  const [state, action, pending] = useActionState(createCompanyAction, {} as CompanyActionState);
  const error = (field: string) => fieldError(state, COMPANY_FIELDS, field);

  useSettled(
    state,
    (current) => Boolean(current.company),
    (current) =>
      onDone({
        message: `${current.company?.name ?? "Company"} added`,
        href: current.company ? companyHref(current.company.id) : undefined,
        link: "Open",
      }),
  );

  return (
    <Shell kind="company" action={action} pending={pending}>
      <FormError state={state} fields={COMPANY_FIELDS} existing={companyHref} />
      <input type="hidden" name="ownerId" value={viewerId} />
      <Field label="Name" htmlFor="quick-company-name" required error={error("name")}>
        <Input id="quick-company-name" name="name" required autoComplete="off" />
      </Field>
      <Field
        label="Domain or website"
        htmlFor="quick-company-domain"
        error={error("domain") ?? error("website")}
      >
        <Input
          id="quick-company-domain"
          name="domain"
          placeholder="acme.com"
          autoComplete="off"
          inputMode="url"
        />
      </Field>
      <TagsField id="quick-company-tags" suggestions={setup?.tags ?? []} />
      {error("tags") && (
        <p role="alert" className="caption-style text-danger">
          {error("tags")}
        </p>
      )}
    </Shell>
  );
}

const OPPORTUNITY_FIELDS = ["name", "companyId", "stageId", "value", "currency", "primaryContactId"];

export function QuickOpportunityForm({ prefill, setup, onDone }: FormProps) {
  const [state, action, pending] = useActionState(saveOpportunityAction, {} as RecordActionState);
  const [company, setCompany] = useState<PickedRecord | null>(prefill.company);
  const [contact, setContact] = useState<PickedRecord | null>(prefill.contact);
  const [stageId, setStageId] = useState<string | null>(null);
  const name = useRef("");
  const error = (field: string) => fieldError(state, OPPORTUNITY_FIELDS, field);
  const stages = setup?.stages ?? [];
  const defaultStage = stages.find((stage) => !stage.isWon && !stage.isLost) ?? stages[0];

  useSettled(
    state,
    (current) => Boolean(current.ok),
    () =>
      onDone({
        message: "Opportunity added",
        href: `/opportunities?q=${encodeURIComponent(name.current)}`,
        link: "Open",
      }),
  );

  return (
    <Shell kind="opportunity" action={action} pending={pending}>
      <FormError state={state} fields={OPPORTUNITY_FIELDS} />
      <Field label="Name" htmlFor="quick-opportunity-name" required error={error("name")}>
        <Input
          id="quick-opportunity-name"
          name="name"
          required
          autoComplete="off"
          onChange={(event) => {
            name.current = event.target.value.trim();
          }}
        />
      </Field>
      <LinkField
        id="quick-opportunity-company"
        label="Company"
        kind="company"
        name="companyId"
        empty=""
        required
        value={company}
        onChange={setCompany}
        placeholder="Choose a company"
        error={error("companyId")}
      />
      <Field label="Stage" htmlFor="quick-opportunity-stage" error={error("stageId")}>
        <select
          id="quick-opportunity-stage"
          name="stageId"
          value={stageId ?? defaultStage?.id ?? "none"}
          onChange={(event) => setStageId(event.target.value)}
          className={recordSelectClass}
        >
          {stages.length === 0 && <option value="none">Default stage</option>}
          {stages.map((stage) => (
            <option key={stage.id} value={stage.id}>
              {stage.name}
            </option>
          ))}
        </select>
      </Field>
      <div className="grid grid-cols-[minmax(0,1fr)_6em] gap-4">
        <Field label="Value" htmlFor="quick-opportunity-value" error={error("value")}>
          <Input id="quick-opportunity-value" name="value" inputMode="decimal" autoComplete="off" />
        </Field>
        <Field label="Currency" htmlFor="quick-opportunity-currency" error={error("currency")}>
          <Input
            id="quick-opportunity-currency"
            name="currency"
            defaultValue="GBP"
            maxLength={3}
            autoComplete="off"
            className="uppercase"
          />
        </Field>
      </div>
      <LinkField
        id="quick-opportunity-contact"
        label="Primary contact"
        kind="contact"
        name="primaryContactId"
        empty="none"
        value={contact}
        onChange={(next) => {
          setContact(next);
          if (next?.company && !company) setCompany(next.company);
        }}
        placeholder="Choose a contact"
        error={error("primaryContactId")}
      />
    </Shell>
  );
}
