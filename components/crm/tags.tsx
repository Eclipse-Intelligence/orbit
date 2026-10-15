"use client";

import { useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import Button from "@/components/_ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/_ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/_ui/popover";
import { tagVariants } from "@/components/_ui/tag";
import { addRecordTagAction, removeRecordTagAction } from "@/app/(crm)/tags";
import { normalizeTag, TAG_MAX_LENGTH } from "@/lib/crm/normalize";
import type { TagCount, TagKind } from "@/lib/crm/types";
import { cn } from "@/lib/utils";
import PlusIcon from "@/public/assets/images/_common/plus.svg";
import XIcon from "@/public/assets/images/companies/detail/x.svg";

const TONES = [
  "blue",
  "purple",
  "green",
  "moss",
  "red",
  "orange",
  "amber",
  "teal",
  "yellow",
] as const;

export const ANY_TAG = "any";

export function tagTone(name: string) {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return TONES[hash % TONES.length];
}

function tagCount(tag: TagCount, kind: TagKind) {
  return kind === "contact" ? tag.contacts : tag.companies;
}

export function tagFilterOptions(tags: TagCount[], kind: TagKind, current?: string) {
  const options = tags
    .filter((tag) => tagCount(tag, kind) > 0 || tag.name === current)
    .map((tag) => ({ value: tag.name, label: `${tag.name} (${tagCount(tag, kind)})` }));
  if (current && !options.some((option) => option.value === current)) {
    options.push({ value: current, label: `${current} (0)` });
  }
  return [{ value: ANY_TAG, label: "Any tag" }, ...options];
}

export function useTagHref() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  return (tag: string | null) => {
    const params = new URLSearchParams(searchParams.toString());
    params.delete("page");
    if (tag) params.set("tag", tag);
    else params.delete("tag");
    const query = params.toString();
    return query ? `${pathname}?${query}` : pathname;
  };
}

export function TagChip({
  name,
  size = "md",
  href,
  onRemove,
  disabled,
  className,
}: {
  name: string;
  size?: "sm" | "md";
  href?: string;
  onRemove?: () => void;
  disabled?: boolean;
  className?: string;
}) {
  const classes = cn(
    tagVariants({ tone: tagTone(name), size: "sm" }),
    size === "sm" ? "h-[18px] max-w-[10em] text-[11px]" : "h-[22px] max-w-[16em] text-[12px]",
    "gap-0.5",
    className,
  );
  const label = <span className="truncate">{name}</span>;
  if (href) {
    return (
      <Link
        href={href}
        title={`Show everything tagged ${name}`}
        className={cn(classes, "hover:brightness-125")}
      >
        {label}
      </Link>
    );
  }
  return (
    <span className={classes}>
      {label}
      {onRemove && (
        <button
          type="button"
          aria-label={`Remove tag ${name}`}
          disabled={disabled}
          onClick={onRemove}
          className="-mr-1 flex size-4 shrink-0 cursor-pointer items-center justify-center rounded-full opacity-70 transition-opacity duration-150 hover:opacity-100 focus-visible:opacity-100 disabled:opacity-40"
        >
          <XIcon aria-hidden className="size-3" />
        </button>
      )}
    </span>
  );
}

export function RowTags({
  tags,
  max = 3,
  className,
}: {
  tags: string[];
  max?: number;
  className?: string;
}) {
  const tagHref = useTagHref();
  if (tags.length === 0) return null;
  const shown = tags.slice(0, max);
  const hidden = tags.slice(max);
  return (
    <span className={cn("relative z-10 flex min-w-0 flex-wrap items-center gap-1", className)}>
      {shown.map((tag) => (
        <TagChip key={tag} name={tag} size="sm" href={tagHref(tag)} />
      ))}
      {hidden.length > 0 && (
        <span
          title={hidden.join(", ")}
          className={cn(tagVariants({ tone: "neutral", size: "sm" }), "h-[18px] text-[11px]")}
        >
          +{hidden.length}
        </span>
      )}
    </span>
  );
}

export function TagOptions({
  suggestions,
  exclude = [],
  onPick,
  removable = [],
  onRemove,
  placeholder = "Find or create a tag",
}: {
  suggestions: TagCount[];
  exclude?: string[];
  onPick: (tag: string) => void;
  removable?: string[];
  onRemove?: (tag: string) => void;
  placeholder?: string;
}) {
  const [search, setSearch] = useState("");
  const typed = normalizeTag(search);
  const tooLong = typed.length > TAG_MAX_LENGTH;
  const matches = suggestions
    .map((tag) => tag.name)
    .filter((name) => !exclude.includes(name) && (!typed || name.includes(typed)));
  const canCreate =
    typed !== "" &&
    !tooLong &&
    !typed.includes(";") &&
    !exclude.includes(typed) &&
    !suggestions.some((tag) => tag.name === typed);
  const removals = removable.filter((name) => !typed || name.includes(typed));
  const hasAdd = matches.length > 0 || canCreate;

  return (
    <Command shouldFilter={false}>
      <CommandInput
        value={search}
        onValueChange={setSearch}
        placeholder={placeholder}
        aria-label={placeholder}
        maxLength={TAG_MAX_LENGTH + 20}
      />
      <CommandList>
        <CommandEmpty className="py-6">
          {tooLong
            ? `Tags are ${TAG_MAX_LENGTH} characters or fewer.`
            : exclude.includes(typed)
              ? "Already tagged."
              : "Type a name for the tag."}
        </CommandEmpty>
        {hasAdd && (
          <CommandGroup heading={onRemove ? "Add tag" : undefined}>
            {matches.map((name) => (
              <CommandItem key={`add:${name}`} value={`add:${name}`} onSelect={() => onPick(name)}>
                <TagChip name={name} />
              </CommandItem>
            ))}
            {canCreate && (
              <CommandItem key="create" value={`create:${typed}`} onSelect={() => onPick(typed)}>
                <PlusIcon aria-hidden className="size-3 shrink-0" />
                <span className="truncate">
                  Create <span className="text-foreground">“{typed}”</span>
                </span>
              </CommandItem>
            )}
          </CommandGroup>
        )}
        {onRemove && removals.length > 0 && (
          <CommandGroup heading="Remove tag">
            {removals.map((name) => (
              <CommandItem
                key={`remove:${name}`}
                value={`remove:${name}`}
                onSelect={() => onRemove(name)}
              >
                <XIcon aria-hidden className="size-3.5 shrink-0" />
                <TagChip name={name} />
              </CommandItem>
            ))}
          </CommandGroup>
        )}
      </CommandList>
    </Command>
  );
}

export function TagPopover({
  trigger,
  open,
  onOpenChange,
  children,
  align = "start",
}: {
  trigger: ReactNode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
  align?: "start" | "end";
}) {
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent align={align} className="w-[260px]">
        {open && children}
      </PopoverContent>
    </Popover>
  );
}

export default function RecordTags({
  kind,
  id,
  tags,
  suggestions,
  className,
}: {
  kind: TagKind;
  id: string;
  tags: string[];
  suggestions: TagCount[];
  className?: string;
}) {
  const router = useRouter();
  const [shown, setShown] = useState(tags);
  const [source, setSource] = useState(tags);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (source !== tags) {
    setSource(tags);
    setShown(tags);
  }

  async function add(tag: string) {
    setOpen(false);
    setError(null);
    if (shown.includes(tag)) return;
    setShown((current) => [...current, tag]);
    const result = await addRecordTagAction(kind, id, tag);
    if ("error" in result) {
      setShown((current) => current.filter((item) => item !== tag));
      setError(result.error);
      return;
    }
    setShown(result.tags);
    router.refresh();
  }

  async function remove(tag: string) {
    setError(null);
    const index = shown.indexOf(tag);
    setShown((current) => current.filter((item) => item !== tag));
    const result = await removeRecordTagAction(kind, id, tag);
    if ("error" in result) {
      setShown((current) => {
        if (current.includes(tag)) return current;
        const next = [...current];
        next.splice(Math.max(0, index), 0, tag);
        return next;
      });
      setError(result.error);
      return;
    }
    setShown(result.tags);
    router.refresh();
  }

  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <div className="flex flex-wrap items-center gap-1">
        {shown.map((tag) => (
          <TagChip key={tag} name={tag} onRemove={() => remove(tag)} />
        ))}
        <TagPopover
          open={open}
          onOpenChange={setOpen}
          trigger={
            <Button
              variant="ghost"
              size="none"
              aria-label="Add a tag"
              data-shortcut="add-tag"
              title="Add a tag (T)"
              className="h-[22px] gap-1 px-2 text-[12px]"
            >
              <PlusIcon aria-hidden className="size-3" />
              Tag
            </Button>
          }
        >
          <TagOptions suggestions={suggestions} exclude={shown} onPick={add} />
        </TagPopover>
      </div>
      {error && (
        <p role="alert" className="caption-style text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
