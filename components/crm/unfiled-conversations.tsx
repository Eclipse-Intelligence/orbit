"use client";

import { useEffect, useState, type KeyboardEvent } from "react";
import { useRouter } from "next/navigation";
import Button from "@/components/_ui/button";
import { Input } from "@/components/_ui/input";
import Tag from "@/components/_ui/tag";
import { Monogram } from "@/components/beautifui/record-marks";
import {
  createContactAndFileAction,
  fileConversationAction,
  ignoreConversationAction,
} from "@/app/(crm)/inbox/actions";
import { searchContactsToFileAction } from "@/app/(crm)/search";
import { formatWhen } from "@/lib/companies";
import type { ConversationImport, NewPerson, UnfiledImport } from "@/lib/crm/conversations";
import { contactHref } from "@/lib/crm/hrefs";
import type { Contact } from "@/lib/crm/types";

const SOURCE_LABELS: Record<ConversationImport["source"], string> = {
  granola: "Granola",
  teams: "Teams",
};

function plainSummary(markdown: string) {
  return markdown
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/^\s*[-*]\s+/gm, "• ")
    .trim();
}

function participantNames(conversation: ConversationImport) {
  return conversation.participants
    .map((person) => person.name || person.email)
    .filter(Boolean)
    .join(", ");
}

type FiledNotice = { contactId: string; name: string };

export default function UnfiledConversations({
  conversations,
}: {
  conversations: UnfiledImport[];
}) {
  const [notice, setNotice] = useState<FiledNotice | null>(null);
  return (
    <section className="flex flex-col gap-2 px-4 pb-4" aria-labelledby="unfiled-heading">
      <h2 id="unfiled-heading">Unfiled conversations</h2>
      <p role="status" className={notice ? "caption-style text-soft" : "sr-only"}>
        {notice && (
          <>
            Filed to{" "}
            <Button variant="link" size="none" href={contactHref(notice.contactId)}>
              {notice.name}
            </Button>
          </>
        )}
      </p>
      {conversations.length === 0 ? (
        <p className="caption-style text-subtle">
          Every imported meeting and call is filed on a contact.
        </p>
      ) : (
        <ul className="flex max-w-[640px] flex-col gap-2">
          {conversations.map((conversation) => (
            <UnfiledItem key={conversation.id} conversation={conversation} onFiled={setNotice} />
          ))}
        </ul>
      )}
    </section>
  );
}

function personLabel(person: NewPerson) {
  return person.name ?? person.email;
}

function UnfiledItem({
  conversation,
  onFiled,
}: {
  conversation: UnfiledImport;
  onFiled: (notice: FiledNotice) => void;
}) {
  const router = useRouter();
  const [filing, setFiling] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [pending, setPending] = useState(false);
  const [creating, setCreating] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const busy = pending || creating !== null;
  const people = participantNames(conversation);
  const summary = conversation.sourceSummary ? plainSummary(conversation.sourceSummary) : null;
  const summaryId = `unfiled-summary-${conversation.id}`;

  async function ignore() {
    if (pending) return;
    setPending(true);
    setError(null);
    const result = await ignoreConversationAction(conversation.id);
    setPending(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    router.refresh();
  }

  async function createAndFile(person: NewPerson) {
    if (busy) return;
    setCreating(person.email);
    setError(null);
    const result = await createContactAndFileAction(conversation.id, person.email);
    setCreating(null);
    if (result.error || !result.contactId) {
      setError(result.error ?? "Could not file this conversation.");
      return;
    }
    onFiled({ contactId: result.contactId, name: result.contactName ?? personLabel(person) });
    router.refresh();
  }

  return (
    <li className="border-border flex flex-col gap-2 rounded-xl border p-3">
      <div className="flex items-start gap-2">
        <Tag tone={conversation.source === "granola" ? "teal" : "purple"} size="sm" className="text-[12px]">
          {SOURCE_LABELS[conversation.source]}
        </Tag>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-[14px] leading-5">
            {conversation.title || (conversation.kind === "call" ? "Teams call" : "Meeting")}
          </span>
          <span className="caption-style text-subtle">
            {conversation.occurredAt ? formatWhen(conversation.occurredAt) : "No date"}
            {people ? ` · ${people}` : ""}
          </span>
        </span>
      </div>
      {summary && (
        <div className="flex flex-col gap-1">
          <p
            id={summaryId}
            className={`caption-style text-soft whitespace-pre-wrap ${expanded ? "" : "line-clamp-3"}`}
          >
            {summary}
          </p>
          <Button
            variant="ghost"
            size="sm"
            className="self-start"
            aria-expanded={expanded}
            aria-controls={summaryId}
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? "Show less" : "Show the Granola summary"}
          </Button>
        </div>
      )}
      {error && (
        <p role="alert" className="caption-style text-danger">
          {error}
        </p>
      )}
      {filing ? (
        <FilePicker
          importId={conversation.id}
          onCancel={() => setFiling(false)}
          onDone={() => {
            setFiling(false);
            router.refresh();
          }}
        />
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          {conversation.newPeople.map((person) => (
            <Button
              key={person.email}
              variant="secondary"
              size="sm"
              className="max-w-full"
              disabled={busy}
              title={person.name ? person.email : undefined}
              onClick={() => createAndFile(person)}
            >
              <span className="truncate">
                {creating === person.email ? "Creating…" : `Create ${personLabel(person)} & file`}
              </span>
            </Button>
          ))}
          <Button variant="secondary" size="sm" disabled={busy} onClick={() => setFiling(true)}>
            File to…
          </Button>
          <Button variant="ghost" size="sm" disabled={busy} onClick={ignore}>
            {pending ? "Ignoring…" : "Ignore"}
          </Button>
        </div>
      )}
    </li>
  );
}

function FilePicker({
  importId,
  onCancel,
  onDone,
}: {
  importId: string;
  onCancel: () => void;
  onDone: () => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<{
    query: string;
    contacts: Contact[];
    failed?: boolean;
  } | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const trimmed = query.trim();
  const searching = results?.query !== trimmed;
  const fieldId = `file-conversation-${importId}`;

  useEffect(() => {
    let cancelled = false;
    const handle = window.setTimeout(() => {
      searchContactsToFileAction(trimmed).then(
        (rows) => {
          if (!cancelled) setResults({ query: trimmed, contacts: rows.contacts });
        },
        () => {
          if (!cancelled) setResults({ query: trimmed, contacts: [], failed: true });
        },
      );
    }, 200);
    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [trimmed]);

  async function file(contact: Contact) {
    if (pending) return;
    setPending(contact.id);
    setError(null);
    const result = await fileConversationAction(importId, contact.id);
    setPending(null);
    if (result.error) {
      setError(result.error);
      return;
    }
    onDone();
  }

  function keepInPicker(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") event.preventDefault();
    if (event.key === "Escape") onCancel();
  }

  return (
    <div className="border-line-strong flex flex-col gap-2 rounded-lg border p-2">
      <label className="sr-only" htmlFor={fieldId}>
        Search contacts
      </label>
      <Input
        id={fieldId}
        value={query}
        autoFocus
        placeholder="Search people by name or email"
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={keepInPicker}
      />
      {error && (
        <p role="alert" className="caption-style text-danger px-1">
          {error}
        </p>
      )}
      {searching ? (
        <p className="caption-style text-subtle px-1 py-2">Searching…</p>
      ) : results?.failed ? (
        <p role="alert" className="caption-style text-danger px-1 py-2">
          Search is unavailable right now. Try again in a moment.
        </p>
      ) : results && results.contacts.length === 0 ? (
        <p className="caption-style text-subtle px-1 py-2">
          {trimmed ? `No contacts match “${trimmed}”.` : "No contacts yet."}
        </p>
      ) : (
        <ul className="flex max-h-64 flex-col overflow-auto">
          {results?.contacts.map((contact) => (
            <li key={contact.id}>
              <Button
                variant="item"
                size="md"
                className="items-center"
                disabled={pending !== null}
                onClick={() => file(contact)}
              >
                <Monogram name={contact.name} />
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="truncate text-[14px] leading-5">{contact.name}</span>
                  <span className="caption-style text-subtle truncate">
                    {[contact.email, contact.companyName ? `at ${contact.companyName}` : null]
                      .filter(Boolean)
                      .join(" · ") || "No email"}
                  </span>
                </span>
                {pending === contact.id && (
                  <span className="caption-style text-subtle shrink-0">Filing…</span>
                )}
              </Button>
            </li>
          ))}
        </ul>
      )}
      <Button variant="ghost" size="sm" className="self-start" disabled={pending !== null} onClick={onCancel}>
        Cancel
      </Button>
    </div>
  );
}
