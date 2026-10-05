"use client";

import type { Ref } from "react";
import Field from "@/components/_ui/field";
import { Input } from "@/components/_ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/_ui/select";
import { LIFECYCLE_LABELS, SIZE_OPTIONS } from "@/lib/companies";
import { LIFECYCLES, type Lifecycle, type Member } from "@/lib/crm/types";
import { cn } from "@/lib/utils";

export type CompanyFormValues = {
  name: string;
  domain: string;
  website: string;
  industry: string;
  sizeCategory: string;
  lifecycle: Lifecycle;
  ownerId: string;
  source: string;
  description: string;
};

type CompanyFieldsProps = {
  idPrefix: string;
  values: CompanyFormValues;
  members: Member[];
  onChange: (values: CompanyFormValues) => void;
  errors?: Partial<Record<keyof CompanyFormValues, string>>;
  nameRef?: Ref<HTMLInputElement>;
};

const textareaClass =
  "flex min-h-24 w-full rounded-lg border border-line-strong bg-secondary px-3 py-2 text-[14px] leading-5 text-foreground outline-none transition-[border-color] duration-150 ease-power3-out placeholder:text-subtle focus-visible:border-ring aria-invalid:border-danger";

export function emptyCompanyForm(ownerId = "unassigned"): CompanyFormValues {
  return {
    name: "",
    domain: "",
    website: "",
    industry: "",
    sizeCategory: "",
    lifecycle: "lead",
    ownerId,
    source: "",
    description: "",
  };
}

export default function CompanyFields({
  idPrefix,
  values,
  members,
  onChange,
  errors,
  nameRef,
}: CompanyFieldsProps) {
  function update<K extends keyof CompanyFormValues>(key: K, value: CompanyFormValues[K]) {
    onChange({ ...values, [key]: value });
  }

  const sizes =
    values.sizeCategory && !SIZE_OPTIONS.includes(values.sizeCategory)
      ? [values.sizeCategory, ...SIZE_OPTIONS]
      : SIZE_OPTIONS;
  const nameError = errors?.name;

  return (
    <>
      <input type="hidden" name="lifecycle" value={values.lifecycle} />
      <input type="hidden" name="ownerId" value={values.ownerId} />
      <input type="hidden" name="sizeCategory" value={values.sizeCategory} />

      <Field
        label="Company name"
        htmlFor={`${idPrefix}-name`}
        required
        error={nameError}
      >
        <Input
          ref={nameRef}
          id={`${idPrefix}-name`}
          name="name"
          value={values.name}
          onChange={(event) => update("name", event.target.value)}
          placeholder="Acme Inc."
          autoComplete="organization"
          required
          aria-invalid={nameError ? true : undefined}
          aria-describedby={nameError ? `${idPrefix}-name-error` : undefined}
          className="aria-invalid:border-danger"
        />
      </Field>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Domain"
          htmlFor={`${idPrefix}-domain`}
          hint="Used to match existing companies."
          error={errors?.domain}
        >
          <Input
            id={`${idPrefix}-domain`}
            name="domain"
            value={values.domain}
            onChange={(event) => update("domain", event.target.value)}
            placeholder="acme.com"
            autoComplete="off"
            aria-invalid={errors?.domain ? true : undefined}
            aria-describedby={
              errors?.domain ? `${idPrefix}-domain-error` : `${idPrefix}-domain-hint`
            }
            className="aria-invalid:border-danger"
          />
        </Field>
        <Field label="Website" htmlFor={`${idPrefix}-website`} error={errors?.website}>
          <Input
            id={`${idPrefix}-website`}
            name="website"
            value={values.website}
            onChange={(event) => update("website", event.target.value)}
            placeholder="https://acme.com"
            autoComplete="url"
            aria-invalid={errors?.website ? true : undefined}
            aria-describedby={errors?.website ? `${idPrefix}-website-error` : undefined}
            className="aria-invalid:border-danger"
          />
        </Field>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Industry" htmlFor={`${idPrefix}-industry`} error={errors?.industry}>
          <Input
            id={`${idPrefix}-industry`}
            name="industry"
            value={values.industry}
            onChange={(event) => update("industry", event.target.value)}
            placeholder="Software"
            aria-invalid={errors?.industry ? true : undefined}
            className="aria-invalid:border-danger"
          />
        </Field>
        <Field label="Size" htmlFor={`${idPrefix}-size`}>
          <Select
            value={values.sizeCategory || "none"}
            onValueChange={(value) => update("sizeCategory", value === "none" ? "" : value)}
          >
            <SelectTrigger id={`${idPrefix}-size`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">Not set</SelectItem>
              {sizes.map((size) => (
                <SelectItem key={size} value={size}>
                  {size}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Lifecycle" htmlFor={`${idPrefix}-lifecycle`}>
          <Select
            value={values.lifecycle}
            onValueChange={(value) => update("lifecycle", value as Lifecycle)}
          >
            <SelectTrigger id={`${idPrefix}-lifecycle`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {LIFECYCLES.map((lifecycle) => (
                <SelectItem key={lifecycle} value={lifecycle}>
                  {LIFECYCLE_LABELS[lifecycle]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field label="Owner" htmlFor={`${idPrefix}-owner`} error={errors?.ownerId}>
          <Select value={values.ownerId} onValueChange={(value) => update("ownerId", value)}>
            <SelectTrigger id={`${idPrefix}-owner`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="unassigned">Unassigned</SelectItem>
              {members.map((member) => (
                <SelectItem key={member.id} value={member.id}>
                  {member.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      </div>

      <Field label="Source" htmlFor={`${idPrefix}-source`} error={errors?.source}>
        <Input
          id={`${idPrefix}-source`}
          name="source"
          value={values.source}
          onChange={(event) => update("source", event.target.value)}
          placeholder="Referral, research, inbound"
        />
      </Field>

      <Field label="Description" htmlFor={`${idPrefix}-description`} error={errors?.description}>
        <textarea
          id={`${idPrefix}-description`}
          name="description"
          value={values.description}
          onChange={(event) => update("description", event.target.value)}
          placeholder="What this company does, and why it matters."
          className={cn(textareaClass, errors?.description && "border-danger")}
          aria-invalid={errors?.description ? true : undefined}
        />
      </Field>
    </>
  );
}
