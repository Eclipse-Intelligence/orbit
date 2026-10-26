"use client";

import { useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import Button from "@/components/_ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/_ui/dialog";
import { Input } from "@/components/_ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/_ui/select";
import {
  TagEditor,
  TemplateTagFilter,
  templateTagSuggestions,
} from "@/components/crm/email-template-picker";
import { TokenChips, insertToken } from "@/components/crm/email-tokens";
import { SettingsCard, SettingsPage } from "@/components/crm/settings-ui";
import { TagChip } from "@/components/crm/tags";
import {
  createEmailTemplateAction,
  deleteEmailTemplateAction,
  duplicateEmailTemplateAction,
  updateEmailTemplateAction,
  type TemplateResult,
} from "@/app/(crm)/email-templates";
import { formatWhen } from "@/lib/companies";
import {
  matchesTemplate,
  renderTemplate,
  SAMPLE_RECIPIENT,
  TEMPLATE_BODY_MAX,
  TEMPLATE_NAME_MAX,
  TEMPLATE_SUBJECT_MAX,
  templateTagCounts,
  type EmailTemplate,
} from "@/lib/crm/email-template-rules";
import type { Recipient } from "@/lib/crm/personalise";
import { cn } from "@/lib/utils";
import PlusIcon from "@/public/assets/images/_common/plus.svg";
import SearchIcon from "@/public/assets/images/_common/search.svg";

const NEW = "new";

type Draft = { name: string; subject: string; body: string; tags: string[] };

const EMPTY: Draft = { name: "", subject: "", body: "", tags: [] };

function draftOf(template: EmailTemplate | undefined): Draft {
  if (!template) return EMPTY;
  return {
    name: template.name,
    subject: template.subject,
    body: template.body,
    tags: template.tags,
  };
}

function sameDraft(left: Draft, right: Draft) {
  return (
    left.name === right.name &&
    left.subject === right.subject &&
    left.body === right.body &&
    left.tags.join("\n") === right.tags.join("\n")
  );
}

export default function EmailTemplatesSettings({
  templates,
  recipients,
  extra,
}: {
  templates: EmailTemplate[];
  recipients: Recipient[];
  extra?: ReactNode;
}) {
  const router = useRouter();
  const [list, setList] = useState(templates);
  const [source, setSource] = useState(templates);
  const [selectedId, setSelectedId] = useState<string | null>(
    templates[0]?.id ?? null,
  );
  const [draft, setDraft] = useState<Draft>(draftOf(templates[0]));
  if (source !== templates) {
    setSource(templates);
    setList(templates);
  }
  const [search, setSearch] = useState("");
  const [tag, setTag] = useState<string | null>(null);
  const [previewId, setPreviewId] = useState(
    recipients[0]?.id ?? SAMPLE_RECIPIENT.id,
  );
  const [pending, setPending] = useState<
    "save" | "duplicate" | "delete" | null
  >(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  const selected =
    selectedId && selectedId !== NEW
      ? list.find((item) => item.id === selectedId)
      : undefined;
  const editing = selectedId === NEW || selected !== undefined;
  const stored = selectedId === NEW ? EMPTY : draftOf(selected);
  const dirty = editing && !sameDraft(draft, stored);
  const tags = templateTagCounts(list);
  const activeTag = tag && tags.some((item) => item.name === tag) ? tag : null;
  const shown = list.filter((template) =>
    matchesTemplate(template, search, activeTag),
  );
  const previewRecipient =
    recipients.find((item) => item.id === previewId) ?? SAMPLE_RECIPIENT;
  const preview = renderTemplate(draft, previewRecipient);
  const field = useRef<"subject" | "body">("body");
  const subjectRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);

  function insert(token: string) {
    if (field.current === "subject")
      insertToken(subjectRef.current, draft.subject, token, (subject) =>
        setDraft((current) => ({ ...current, subject })),
      );
    else
      insertToken(bodyRef.current, draft.body, token, (body) =>
        setDraft((current) => ({ ...current, body })),
      );
  }

  function leave() {
    return (
      !dirty || window.confirm("Discard your unsaved changes to this template?")
    );
  }

  function select(id: string) {
    if (id === selectedId || !leave()) return;
    setSelectedId(id);
    setDraft(id === NEW ? EMPTY : draftOf(list.find((item) => item.id === id)));
    setError(null);
    setMessage(null);
    requestAnimationFrame(() => {
      const editor = document.getElementById("template-editor");
      if (!editor || !window.matchMedia("(max-width: 1023px)").matches) return;
      editor.scrollIntoView({ block: "start", behavior: "smooth" });
    });
  }

  function accept(result: TemplateResult, note: string) {
    if ("error" in result) {
      setError(result.error);
      return false;
    }
    const template = result.template;
    setList((current) => [
      template,
      ...current.filter((item) => item.id !== template.id),
    ]);
    setSelectedId(template.id);
    setDraft(draftOf(template));
    setMessage(note);
    router.refresh();
    return true;
  }

  async function save() {
    if (pending) return;
    setPending("save");
    setError(null);
    setMessage(null);
    const result =
      selectedId === NEW || !selected
        ? await createEmailTemplateAction(draft)
        : await updateEmailTemplateAction(selected.id, draft);
    setPending(null);
    accept(
      result,
      selectedId === NEW ? "Template created." : "Template saved.",
    );
  }

  async function duplicate() {
    if (pending || !selected || !leave()) return;
    setPending("duplicate");
    setError(null);
    setMessage(null);
    const result = await duplicateEmailTemplateAction(selected.id);
    setPending(null);
    if ("template" in result) setSearch("");
    accept(result, "Template duplicated.");
  }

  async function remove() {
    if (pending || !selected) return;
    setPending("delete");
    setError(null);
    setMessage(null);
    const result = await deleteEmailTemplateAction(selected.id);
    setPending(null);
    setConfirming(false);
    if ("error" in result) {
      setError(result.error);
      return;
    }
    const rest = list.filter((item) => item.id !== selected.id);
    setList(rest);
    setSelectedId(rest[0]?.id ?? null);
    setDraft(draftOf(rest[0]));
    setMessage(`Deleted “${selected.name}”.`);
    router.refresh();
  }

  return (
    <SettingsPage
      wide
      title="Email templates and signatures"
      description="Reusable emails for one contact or a bulk send, and the signature for each address you send from. Tokens are filled in for each person."
      action={
        <Button
          variant="primary"
          size="sm"
          onClick={() => select(NEW)}
          disabled={pending !== null}
        >
          <PlusIcon aria-hidden className="size-3" />
          New template
        </Button>
      }
    >
      <SettingsCard
        title={
          list.length === 0
            ? "Templates"
            : `${list.length} ${list.length === 1 ? "template" : "templates"}`
        }
        description="Use a template from the email composer on a contact, a company, or a bulk email."
      >
        {list.length === 0 ? (
          <div className="flex flex-col items-start gap-3 py-2">
            <p className="caption-style text-subtle">
              No templates yet. Create one here, or save a drafted email as a
              template from the composer.
            </p>
            {selectedId !== NEW && (
              <Button variant="secondary" size="sm" onClick={() => select(NEW)}>
                Create a template
              </Button>
            )}
          </div>
        ) : (
          <>
            <div className="relative">
              <label className="sr-only" htmlFor="template-search">
                Search templates
              </label>
              <SearchIcon
                aria-hidden
                className="text-subtle pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2"
              />
              <Input
                id="template-search"
                type="search"
                value={search}
                autoComplete="off"
                placeholder="Search by name, subject or message"
                onChange={(event) => setSearch(event.target.value)}
                className="pl-8"
              />
            </div>
            <TemplateTagFilter
              tags={tags}
              active={activeTag}
              onChange={setTag}
            />
            {shown.length === 0 ? (
              <p className="caption-style text-subtle py-4" role="status">
                No templates match.
              </p>
            ) : (
              <ul
                className="-mx-2 flex max-h-[22em] flex-col overflow-auto"
                aria-label="Templates"
              >
                {shown.map((template) => {
                  const active = template.id === selectedId;
                  return (
                    <li key={template.id}>
                      <button
                        type="button"
                        aria-current={active ? "true" : undefined}
                        onClick={() => select(template.id)}
                        className={cn(
                          "focus-visible:ring-ring/60 grid w-full cursor-pointer gap-x-4 gap-y-1 rounded-lg px-2 py-2.5 text-left transition-colors duration-150 outline-none focus-visible:ring-2 sm:grid-cols-[minmax(0,1fr)_auto]",
                          active ? "bg-white/6" : "hover:bg-white/4",
                        )}
                      >
                        <span className="flex min-w-0 flex-col gap-1">
                          <span className="truncate text-[14px] leading-5">
                            {template.name}
                          </span>
                          <span className="caption-style text-subtle truncate leading-4">
                            {template.subject || "No subject"}
                          </span>
                        </span>
                        <span className="flex min-w-0 flex-wrap items-center gap-1 sm:justify-end">
                          {template.tags.slice(0, 3).map((name) => (
                            <TagChip key={name} name={name} size="sm" />
                          ))}
                          {template.tags.length > 3 && (
                            <span className="caption-style text-subtle">
                              +{template.tags.length - 3}
                            </span>
                          )}
                          <span className="caption-style text-subtle whitespace-nowrap sm:ml-2">
                            Updated {formatWhen(template.updatedAt)}
                          </span>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </>
        )}
      </SettingsCard>

      {editing && (
        <SettingsCard
          id="template-editor"
          title={
            selectedId === NEW ? "New template" : selected?.name || "Template"
          }
          description={
            selected
              ? `Created ${formatWhen(selected.createdAt)} · Updated ${formatWhen(selected.updatedAt)}`
              : undefined
          }
          action={
            <>
              {selected && (
                <>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={pending !== null}
                    onClick={duplicate}
                  >
                    {pending === "duplicate" ? "Duplicating…" : "Duplicate"}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="hover:text-danger"
                    disabled={pending !== null}
                    onClick={() => setConfirming(true)}
                  >
                    Delete
                  </Button>
                </>
              )}
              {selectedId === NEW && (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={pending !== null}
                  onClick={() => {
                    if (!leave()) return;
                    setSelectedId(list[0]?.id ?? null);
                    setDraft(draftOf(list[0]));
                    setError(null);
                  }}
                >
                  Cancel
                </Button>
              )}
              <Button
                variant="primary"
                size="sm"
                disabled={pending !== null || !dirty || !draft.name.trim()}
                data-shortcut="save"
                title="Save (⌘S)"
                onClick={save}
              >
                {pending === "save"
                  ? "Saving…"
                  : selectedId === NEW
                    ? "Create template"
                    : "Save"}
              </Button>
            </>
          }
        >
          {error && (
            <p role="alert" className="caption-style text-danger">
              {error}
            </p>
          )}
          <p role="status" className="caption-style text-subtle empty:hidden">
            {message}
          </p>
          <div className="grid gap-6 lg:grid-cols-2">
            <div className="flex min-w-0 flex-col gap-3">
              <label className="flex flex-col gap-2" htmlFor="template-name">
                <span className="caption-style text-subtle">Name</span>
                <Input
                  id="template-name"
                  value={draft.name}
                  autoComplete="off"
                  maxLength={TEMPLATE_NAME_MAX}
                  placeholder="For example, Intro follow-up"
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      name: event.target.value,
                    }))
                  }
                />
              </label>
              <label className="flex flex-col gap-2" htmlFor="template-subject">
                <span className="caption-style text-subtle">Subject</span>
                <Input
                  id="template-subject"
                  ref={subjectRef}
                  value={draft.subject}
                  autoComplete="off"
                  maxLength={TEMPLATE_SUBJECT_MAX}
                  placeholder="Great to meet you, {{first_name}}"
                  onFocus={() => {
                    field.current = "subject";
                  }}
                  onKeyDown={(event) =>
                    event.key === "Enter" && event.preventDefault()
                  }
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      subject: event.target.value,
                    }))
                  }
                />
              </label>
              <label className="flex flex-col gap-2" htmlFor="template-body">
                <span className="caption-style text-subtle">Message</span>
                <textarea
                  id="template-body"
                  ref={bodyRef}
                  value={draft.body}
                  autoComplete="off"
                  maxLength={TEMPLATE_BODY_MAX}
                  placeholder={"Hi {{first_name}},\n\nWrite the message"}
                  onFocus={() => {
                    field.current = "body";
                  }}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      body: event.target.value,
                    }))
                  }
                  className="border-line-strong bg-secondary focus-visible:border-ring min-h-[16em] w-full resize-y rounded-lg border px-3 py-2 text-[14px] leading-5 outline-none"
                />
              </label>
              <TokenChips
                onInsert={insert}
                text={`${draft.subject}\n${draft.body}`}
                unknownNote="Not a token, left as typed"
              />
              <div className="flex flex-col gap-2">
                <span className="caption-style text-subtle">Tags</span>
                <TagEditor
                  tags={draft.tags}
                  onChange={(next) =>
                    setDraft((current) => ({ ...current, tags: next }))
                  }
                  suggestions={templateTagSuggestions(tags)}
                  disabled={pending !== null}
                />
              </div>
            </div>
            <section
              aria-label="Preview"
              className="flex min-w-0 flex-col gap-3"
            >
              <div className="flex flex-col gap-2">
                <label
                  className="caption-style text-subtle"
                  htmlFor="template-preview-recipient"
                >
                  Preview for
                </label>
                <Select
                  value={previewRecipient.id}
                  onValueChange={setPreviewId}
                >
                  <SelectTrigger id="template-preview-recipient">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {recipients.map((recipient) => (
                      <SelectItem key={recipient.id} value={recipient.id}>
                        {recipient.company
                          ? `${recipient.name} · ${recipient.company}`
                          : recipient.name}
                      </SelectItem>
                    ))}
                    <SelectItem value={SAMPLE_RECIPIENT.id}>
                      {`${SAMPLE_RECIPIENT.name} at ${SAMPLE_RECIPIENT.company} (sample)`}
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="border-line-strong bg-background flex min-h-[16em] flex-col rounded-lg border">
                <div className="border-border flex flex-col gap-1.5 border-b px-3 py-2.5">
                  <span className="caption-style text-subtle truncate">
                    To {previewRecipient.name}
                    {previewRecipient.email
                      ? ` <${previewRecipient.email}>`
                      : ""}
                  </span>
                  <p className="text-[14px] leading-5 font-medium break-words">
                    {preview.subject || "No subject"}
                  </p>
                </div>
                <p className="text-soft px-3 py-2.5 text-[14px] leading-5 break-words whitespace-pre-wrap">
                  {preview.body || "The message appears here as you type."}
                </p>
              </div>
            </section>
          </div>
        </SettingsCard>
      )}

      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent className="max-w-[420px]">
          <DialogHeader>
            <DialogTitle>Delete “{selected?.name}”?</DialogTitle>
            <DialogDescription>
              The template is removed for good. Emails already sent with it
              aren&apos;t affected.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setConfirming(false)}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              size="sm"
              disabled={pending === "delete"}
              onClick={remove}
            >
              {pending === "delete" ? "Deleting…" : "Delete template"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {extra}
    </SettingsPage>
  );
}
