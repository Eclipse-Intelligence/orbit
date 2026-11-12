"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import Button from "@/components/_ui/button";
import { fileSize } from "@/components/crm/email-attachments";
import BodyEditor from "@/components/mail/body-editor";
import { PeopleStack } from "@/components/mail/share-control";
import { useMailShareEvents } from "@/components/mail/share-live";
import { fetchSharedDraft, saveSharedDraftText } from "@/components/mail/shared-draft-client";
import { ShareRequestError } from "@/components/mail/share-client";
import type { ChatPerson } from "@/lib/chat/types";
import { recipientList } from "@/lib/mail/format";
import { laterDetail } from "@/lib/mail/later";
import type { MailSharePerson, SharedDraft } from "@/lib/mail/share-types";
import { draftStateLine, onlyOwnerSends, ownerDraftTitle, personFirstName } from "@/lib/mail/share-view";
import { cn } from "@/lib/utils";
import CloseIcon from "@/public/assets/images/mail/close.svg";
import CheckIcon from "@/public/assets/images/mail/check.svg";
import ClockIcon from "@/public/assets/images/mail/clock.svg";
import LockIcon from "@/public/assets/images/mail/lock.svg";
import PaperclipIcon from "@/public/assets/images/_common/paperclip.svg";
import TrashIcon from "@/public/assets/images/mail/trash.svg";

const SAVE_DELAY_MS = 1000;

type Text = { subject: string; body: string };

type Save = { kind: "idle" | "saving" | "saved" | "error"; message?: string };

const STATE_ICONS = { sending: LockIcon, scheduled: ClockIcon, sent: CheckIcon, discarded: TrashIcon } as const;

export default function SharedDraftEditor({
  shareId,
  owner,
  people,
  viewer,
  onClose,
}: {
  shareId: string;
  owner: ChatPerson;
  people: MailSharePerson[];
  viewer: ChatPerson;
  onClose: () => void;
}) {
  const id = useId();
  const [draft, setDraft] = useState<SharedDraft | null>(null);
  const [text, setText] = useState<Text>({ subject: "", body: "" });
  const [loadError, setLoadError] = useState<string | null>(null);
  const [save, setSave] = useState<Save>({ kind: "idle" });
  const [loadedAt, setLoadedAt] = useState(0);
  const [savedText, setSavedText] = useState<Text | null>(null);
  const saved = useRef<Text | null>(null);
  const current = useRef(text);
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  const dirty = Boolean(savedText) && (text.subject !== savedText?.subject || text.body !== savedText?.body);
  const dirtyRef = useRef(dirty);

  useEffect(() => {
    current.current = text;
    dirtyRef.current = dirty;
  });

  const settle = useCallback((next: Text) => {
    saved.current = next;
    setSavedText(next);
  }, []);

  const load = useCallback(() => {
    fetchSharedDraft(shareId)
      .then((fresh) => {
        setDraft(fresh);
        setLoadedAt(Date.now());
        setLoadError(null);
        const settled = !dirtyRef.current;
        settle({ subject: fresh.subject, body: fresh.body });
        if (settled) setText({ subject: fresh.subject, body: fresh.body });
      })
      .catch((error: unknown) => setLoadError(error instanceof Error ? error.message : "Couldn't load the draft. Try again."));
  }, [shareId, settle]);

  useEffect(() => {
    load();
  }, [load]);

  useMailShareEvents((event) => {
    if (event.shareId === shareId && (event.type === "draft" || event.type === "people")) load();
  });

  const locked = !draft || draft.state !== "editing";

  const saveNow = useCallback(() => {
    const run = chain.current.then(async () => {
      const wanted = current.current;
      const base = saved.current;
      if (!base || (wanted.subject === base.subject && wanted.body === base.body)) return;
      setSave({ kind: "saving" });
      try {
        await saveSharedDraftText(shareId, {
          subject: wanted.subject !== base.subject ? wanted.subject : null,
          body: wanted.body !== base.body ? wanted.body : null,
        });
        settle({ subject: wanted.subject, body: wanted.body });
        setSave({ kind: "saved" });
      } catch (error) {
        setSave({ kind: "error", message: error instanceof Error ? error.message : "Couldn't save the draft. Try again." });
        if (error instanceof ShareRequestError && (error.status === 409 || error.status === 404)) load();
      }
    });
    chain.current = run.catch(() => null);
    return run;
  }, [shareId, load, settle]);

  useEffect(() => {
    if (!dirty || locked) return;
    const timer = window.setTimeout(() => void saveNow(), SAVE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [text, dirty, locked, saveNow]);

  const title = ownerDraftTitle(owner);
  const line = draft ? draftStateLine(draft.state, owner, draft.sendAt ? laterDetail(draft.sendAt, loadedAt) : null) : null;
  const StateIcon = draft && draft.state in STATE_ICONS ? STATE_ICONS[draft.state as keyof typeof STATE_ICONS] : null;
  const gone = draft?.state === "sent" || draft?.state === "discarded" || draft?.state === "none";
  const everyone = [...people.filter((person) => person.owner), ...people.filter((person) => !person.owner)];
  const status = save.kind === "saving" ? "Saving…" : save.kind === "saved" && !dirty ? "Saved" : save.kind === "error" ? save.message : "";

  return (
    <section aria-label={title} className="bg-surface-panel flex flex-col rounded-2xl">
      <div className="flex items-center gap-2 py-2 pr-2 pl-4">
        <h3 className="min-w-0 flex-1 truncate">{title}</h3>
        <PeopleStack people={everyone} viewerId={viewer.id} size="sm" />
        <Button variant="ghost" size="icon-sm" aria-label={`Close ${title}`} title="Close" onClick={onClose} className="pointer-coarse:size-11">
          <CloseIcon aria-hidden className="size-2.5" />
        </Button>
      </div>
      <div className="flex flex-col gap-1 px-4 pb-2">
        {line && (
          <p role="status" className="ui-style bg-surface-raised flex items-center gap-2 rounded-xl px-3 py-2">
            {StateIcon && <StateIcon aria-hidden className="text-subtle size-3.5 shrink-0" />}
            <span className="min-w-0 flex-1">{line}</span>
          </p>
        )}
        {loadError && !draft && (
          <div className="flex flex-col items-start gap-2">
            <p role="alert" className="caption-style text-danger">
              {loadError}
            </p>
            <Button variant="secondary" size="sm" onClick={load} className="pointer-coarse:h-11">
              Try again
            </Button>
          </div>
        )}
        {!draft && !loadError && (
          <p role="status" className="caption-style text-subtle">
            Loading…
          </p>
        )}
        {draft && !gone && (
          <>
            <dl className="flex flex-col gap-1 text-[14px]">
              {draft.from && (
                <div className="flex items-baseline gap-2">
                  <dt className="text-subtle w-8 shrink-0 text-[13px]">From</dt>
                  <dd className="text-soft min-w-0 truncate">{draft.from}</dd>
                </div>
              )}
              <div className="flex items-baseline gap-2">
                <dt className="text-subtle w-8 shrink-0 text-[13px]">To</dt>
                <dd className="text-soft min-w-0 truncate">{recipientList(draft.to, []) || "No one yet"}</dd>
              </div>
              {draft.cc.length > 0 && (
                <div className="flex items-baseline gap-2">
                  <dt className="text-subtle w-8 shrink-0 text-[13px]">Cc</dt>
                  <dd className="text-soft min-w-0 truncate">{recipientList(draft.cc, [])}</dd>
                </div>
              )}
            </dl>
            <label htmlFor={`${id}-subject`} className="sr-only">
              Subject
            </label>
            <input
              id={`${id}-subject`}
              value={text.subject}
              readOnly={locked}
              aria-readonly={locked}
              onChange={(event) => setText((existing) => ({ ...existing, subject: event.target.value }))}
              placeholder="Subject"
              className={cn("text-foreground placeholder:text-subtle mt-1 h-8 min-w-0 bg-transparent text-[16px] font-medium outline-none", locked && "caret-transparent")}
            />
            <BodyEditor
              value={text.body}
              onChange={(body) => setText((existing) => ({ ...existing, body }))}
              onFiles={() => undefined}
              onFileLink={() => undefined}
              onFormats={() => undefined}
              label="Message"
              placeholder="Write the email"
              fill={false}
              readOnly={locked}
            />
            {draft.attachments.length > 0 && (
              <div className="flex flex-col gap-1.5 pt-2">
                <ul aria-label="Attachments" className="flex flex-wrap gap-1.5">
                  {draft.attachments.map((file) => (
                    <li key={file.id} className="bg-surface-field flex h-8 max-w-full items-center gap-1.5 rounded-full px-3 text-[13px]">
                      <PaperclipIcon aria-hidden className="text-subtle size-3 shrink-0" />
                      <span className="truncate">{file.name}</span>
                      <span className="caption-style text-subtle shrink-0">{fileSize(file.size)}</span>
                    </li>
                  ))}
                </ul>
                <p className="caption-style text-subtle">Only {personFirstName(owner.name)} can add or remove attachments.</p>
              </div>
            )}
          </>
        )}
      </div>
      <div className="border-line-subtle flex items-center gap-2 border-t px-4 py-2">
        <span className="ui-style text-soft flex items-center gap-1.5">
          <LockIcon aria-hidden className="text-subtle size-3.5" />
          {onlyOwnerSends(owner)}
        </span>
        <span role="status" className={cn("caption-style ml-auto min-w-0 truncate", save.kind === "error" ? "text-danger" : "text-subtle")}>
          {status}
        </span>
      </div>
    </section>
  );
}
