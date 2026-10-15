"use client";

import { useEffect, useState, type FormEvent } from "react";
import Button from "@/components/_ui/button";
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/_ui/command";
import { Input } from "@/components/_ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/_ui/popover";
import { TagChip, TagOptions, TagPopover } from "@/components/crm/tags";
import {
  createEmailTemplateAction,
  listEmailTemplatesAction,
} from "@/app/(crm)/email-templates";
import {
  matchesTemplate,
  TEMPLATE_NAME_MAX,
  templateTagCounts,
  type EmailTemplate,
  type TemplateTagCount,
} from "@/lib/crm/email-template-rules";
import type { TagCount } from "@/lib/crm/types";
import { SETTINGS_PATHS } from "@/lib/settings-nav";
import { cn } from "@/lib/utils";
import PlusIcon from "@/public/assets/images/_common/plus.svg";

export function templateTagSuggestions(tags: TemplateTagCount[]): TagCount[] {
  return tags.map((tag) => ({
    name: tag.name,
    contacts: tag.templates,
    companies: 0,
  }));
}

export function TemplateTagFilter({
  tags,
  active,
  onChange,
  label = "Filter templates by tag",
  className,
}: {
  tags: TemplateTagCount[];
  active: string | null;
  onChange: (tag: string | null) => void;
  label?: string;
  className?: string;
}) {
  if (tags.length === 0) return null;
  const chip =
    "focus-visible:ring-ring/60 flex h-7 shrink-0 cursor-pointer items-center gap-1 rounded-full px-2.5 text-[12px] leading-none outline-none transition-colors duration-150 focus-visible:ring-2";
  return (
    <div
      role="group"
      aria-label={label}
      className={cn("flex flex-wrap gap-1", className)}
    >
      <button
        type="button"
        aria-pressed={active === null}
        onClick={() => onChange(null)}
        className={cn(
          chip,
          active === null
            ? "bg-muted text-foreground"
            : "text-subtle hover:text-foreground hover:bg-white/6",
        )}
      >
        All
      </button>
      {tags.map((tag) => (
        <button
          key={tag.name}
          type="button"
          aria-pressed={active === tag.name}
          onClick={() => onChange(active === tag.name ? null : tag.name)}
          className={cn(
            chip,
            active === tag.name
              ? "bg-muted text-foreground"
              : "text-subtle hover:text-foreground hover:bg-white/6",
          )}
        >
          {tag.name}
          <span className="text-faint">{tag.templates}</span>
        </button>
      ))}
    </div>
  );
}

export function UseTemplateButton({
  onPick,
  disabled,
}: {
  onPick: (template: EmailTemplate) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [templates, setTemplates] = useState<EmailTemplate[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [tag, setTag] = useState<string | null>(null);

  async function load() {
    setError(null);
    const result = await listEmailTemplatesAction();
    if ("error" in result) {
      setError(result.error);
      return;
    }
    setTemplates(result.templates);
  }

  function change(next: boolean) {
    setOpen(next);
    if (next) {
      setSearch("");
      void load();
    }
  }

  const tags = templateTagCounts(templates ?? []);
  const activeTag = tag && tags.some((item) => item.name === tag) ? tag : null;
  const shown = (templates ?? []).filter((template) =>
    matchesTemplate(template, search, activeTag),
  );

  return (
    <Popover open={open} onOpenChange={change}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          disabled={disabled}
          aria-haspopup="dialog"
          data-shortcut="use-template"
          title="Use a template (⌘⇧T)"
        >
          Use template
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[min(360px,calc(100vw-2rem))]">
        {open && (
          <Command shouldFilter={false} label="Email templates">
            <CommandInput
              value={search}
              onValueChange={setSearch}
              placeholder="Search templates"
              aria-label="Search templates"
            />
            {tags.length > 0 && (
              <TemplateTagFilter
                tags={tags}
                active={activeTag}
                onChange={setTag}
                className="border-line-strong max-h-[6.5em] overflow-auto border-b px-3 py-2"
              />
            )}
            <CommandList>
              {templates === null && !error ? (
                <p
                  className="caption-style text-subtle py-10 text-center"
                  role="status"
                >
                  Loading templates…
                </p>
              ) : (
                <CommandEmpty className="flex flex-col items-center gap-2 px-4 py-8">
                  {error ? (
                    <span className="text-danger">{error}</span>
                  ) : templates && templates.length === 0 ? (
                    <>
                      <span>No templates yet.</span>
                      <Button
                        variant="link"
                        size="none"
                        href={SETTINGS_PATHS.emailTemplates}
                        className="caption-style"
                      >
                        Create one in Settings
                      </Button>
                    </>
                  ) : (
                    "No templates match."
                  )}
                </CommandEmpty>
              )}
              {shown.map((template) => (
                <CommandItem
                  key={template.id}
                  value={template.id}
                  onSelect={() => {
                    setOpen(false);
                    onPick(template);
                  }}
                  className="h-auto flex-col items-start gap-1.5 py-2"
                >
                  <span className="w-full truncate text-[14px] leading-5">
                    {template.name}
                  </span>
                  {template.subject && (
                    <span className="caption-style text-subtle w-full truncate">
                      {template.subject}
                    </span>
                  )}
                  {template.tags.length > 0 && (
                    <span className="flex flex-wrap gap-1">
                      {template.tags.slice(0, 4).map((name) => (
                        <TagChip key={name} name={name} size="sm" />
                      ))}
                    </span>
                  )}
                </CommandItem>
              ))}
            </CommandList>
          </Command>
        )}
      </PopoverContent>
    </Popover>
  );
}

export function TagEditor({
  tags,
  onChange,
  suggestions,
  disabled,
}: {
  tags: string[];
  onChange: (tags: string[]) => void;
  suggestions: TagCount[];
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-wrap items-center gap-1">
      {tags.map((tag) => (
        <TagChip
          key={tag}
          name={tag}
          disabled={disabled}
          onRemove={() => onChange(tags.filter((item) => item !== tag))}
        />
      ))}
      <TagPopover
        open={open}
        onOpenChange={setOpen}
        trigger={
          <Button
            variant="ghost"
            size="none"
            aria-label="Add a tag"
            disabled={disabled}
            className="h-[22px] gap-1 px-2 text-[12px]"
          >
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
            if (!tags.includes(tag)) onChange([...tags, tag]);
          }}
        />
      </TagPopover>
    </div>
  );
}

export function SaveTemplateForm({
  subject,
  body,
  idPrefix,
  onDone,
}: {
  subject: string;
  body: string;
  idPrefix: string;
  onDone: (template: EmailTemplate | null) => void;
}) {
  const [name, setName] = useState(subject.trim().slice(0, TEMPLATE_NAME_MAX));
  const [tags, setTags] = useState<string[]>([]);
  const [suggestions, setSuggestions] = useState<TagCount[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    let live = true;
    void listEmailTemplatesAction().then((result) => {
      if (live && "templates" in result) {
        setSuggestions(
          templateTagSuggestions(templateTagCounts(result.templates)),
        );
      }
    });
    return () => {
      live = false;
    };
  }, []);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setError(null);
    const result = await createEmailTemplateAction({
      name,
      subject,
      body,
      tags,
    });
    setPending(false);
    if ("error" in result) {
      setError(result.error);
      return;
    }
    onDone(result.template);
  }

  return (
    <form
      onSubmit={save}
      aria-label="Save as template"
      className="border-line-strong flex flex-col gap-2 rounded-lg border p-3"
    >
      <label
        className="caption-style text-subtle"
        htmlFor={`template-name-${idPrefix}`}
      >
        Template name
      </label>
      <Input
        id={`template-name-${idPrefix}`}
        value={name}
        autoFocus
        autoComplete="off"
        maxLength={TEMPLATE_NAME_MAX}
        placeholder="For example, Intro follow-up"
        aria-invalid={error ? true : undefined}
        onChange={(event) => setName(event.target.value)}
      />
      <span className="caption-style text-subtle">Tags</span>
      <TagEditor
        tags={tags}
        onChange={setTags}
        suggestions={suggestions ?? []}
        disabled={pending}
      />
      {error && (
        <p role="alert" className="caption-style text-danger">
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          variant="secondary"
          size="sm"
          type="submit"
          disabled={pending || !name.trim()}
        >
          {pending ? "Saving…" : "Save template"}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={pending}
          onClick={() => onDone(null)}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}
