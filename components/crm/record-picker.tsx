"use client";

import { useEffect, useState } from "react";
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/_ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/_ui/popover";
import { Monogram } from "@/components/beautifui/record-marks";
import { searchCompaniesAction } from "@/app/(crm)/actions";
import { searchCompanyContactsAction, searchContactsToFileAction } from "@/app/(crm)/search";
import type { QuickAddRef } from "@/lib/crm/quick-add";
import { cn } from "@/lib/utils";
import ChevronDownIcon from "@/public/assets/images/_common/chevron-down.svg";
import XIcon from "@/public/assets/images/companies/detail/x.svg";

export type PickedRecord = QuickAddRef & { company?: QuickAddRef | null };

export type RecordOption = PickedRecord & { detail: string };

type Results = { query: string; options: RecordOption[]; failed?: boolean };

export async function searchRecords(kind: "contact" | "company", query: string, companyId: string | null | undefined): Promise<RecordOption[]> {
  if (kind === "company") {
    const companies = await searchCompaniesAction(query);
    return companies.map((company) => ({
      id: company.id,
      name: company.name,
      detail: company.domain ?? "",
    }));
  }
  const { contacts } = companyId ? await searchCompanyContactsAction(companyId, query) : await searchContactsToFileAction(query);
  return contacts
    .filter((contact) => companyId === undefined || contact.companyId)
    .map((contact) => ({
      id: contact.id,
      name: contact.name,
      detail: [contact.email, contact.companyName && !companyId ? `at ${contact.companyName}` : null]
        .filter(Boolean)
        .join(" · "),
      company:
        contact.companyId && contact.companyName
          ? { id: contact.companyId, name: contact.companyName }
          : null,
    }));
}

export function RecordChip({
  name,
  onRemove,
  removeLabel,
}: {
  name: string;
  onRemove: () => void;
  removeLabel: string;
}) {
  return (
    <span className="bg-secondary text-foreground inline-flex h-7 max-w-full min-w-0 items-center gap-1.5 self-start rounded-full pr-1 pl-1 text-[13px] leading-5">
      <Monogram name={name} className="size-5 rounded-full" />
      <span className="min-w-0 truncate">{name}</span>
      <button
        type="button"
        aria-label={removeLabel}
        onClick={onRemove}
        className="text-subtle hover:text-foreground focus-visible:ring-ring/60 flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-full outline-none hover:bg-white/6 focus-visible:ring-2"
      >
        <XIcon aria-hidden className="size-3" />
      </button>
    </span>
  );
}

export default function RecordPicker({
  id,
  kind,
  value,
  onChange,
  placeholder,
  invalid,
  companyId,
  excludeId,
}: {
  id: string;
  kind: "contact" | "company";
  value: PickedRecord | null;
  onChange: (value: PickedRecord | null) => void;
  placeholder: string;
  invalid?: boolean;
  companyId?: string | null;
  excludeId?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Results | null>(null);
  const trimmed = query.trim();
  const found = results?.query === trimmed ? results : null;
  const current = found && excludeId ? { ...found, options: found.options.filter((option) => option.id !== excludeId) } : found;
  const noun = kind === "contact" ? "contacts" : "companies";

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const handle = window.setTimeout(() => {
      searchRecords(kind, trimmed, companyId).then(
        (options) => {
          if (!cancelled) setResults({ query: trimmed, options });
        },
        () => {
          if (!cancelled) setResults({ query: trimmed, options: [], failed: true });
        },
      );
    }, 200);
    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [companyId, kind, open, trimmed]);

  if (value) {
    return (
      <RecordChip
        name={value.name}
        removeLabel={`Remove ${value.name}`}
        onRemove={() => onChange(null)}
      />
    );
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery("");
      }}
    >
      <PopoverTrigger asChild>
        <button
          id={id}
          type="button"
          aria-describedby={invalid ? `${id}-error` : undefined}
          className={cn(
            "border-line-strong bg-secondary text-subtle focus-visible:border-ring flex h-9 w-full min-w-0 cursor-pointer items-center justify-between gap-2 rounded-lg border px-3 text-left text-[14px] leading-none outline-none",
            invalid && "border-danger",
          )}
        >
          <span className="truncate">{placeholder}</span>
          <ChevronDownIcon aria-hidden className="size-3.5 shrink-0" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={6}
        className="w-(--radix-popover-trigger-width) min-w-[240px]"
      >
        <Command shouldFilter={false}>
          <CommandInput
            value={query}
            onValueChange={setQuery}
            placeholder={`Search ${noun}`}
            aria-label={`Search ${noun}`}
          />
          <CommandList>
            {current && (
              <CommandEmpty className="py-6">
                {current.failed
                  ? "Search is unavailable right now."
                  : trimmed
                    ? `No ${noun} match “${trimmed}”${companyId ? " at this company" : ""}.`
                    : companyId
                      ? "No contacts at this company yet."
                      : `No ${noun} yet.`}
              </CommandEmpty>
            )}
            {!current && (
              <p className="caption-style text-subtle px-2.5 py-6 text-center">Searching…</p>
            )}
            {current?.options.map((option) => (
              <CommandItem
                key={option.id}
                value={option.id}
                onSelect={() => {
                  setOpen(false);
                  setQuery("");
                  onChange({ id: option.id, name: option.name, company: option.company ?? null });
                }}
                className="h-auto min-h-10 py-2"
              >
                <Monogram name={option.name} />
                <span className="flex min-w-0 flex-1 flex-col gap-1">
                  <span className="text-foreground truncate">{option.name}</span>
                  {option.detail && (
                    <span className="caption-style text-subtle truncate">{option.detail}</span>
                  )}
                </span>
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
