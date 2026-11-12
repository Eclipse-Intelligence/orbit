"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import Button from "@/components/_ui/button";
import { fileSize } from "@/components/crm/email-attachments";
import BodyEditor from "@/components/mail/body-editor";
import { PeopleStack } from "@/components/mail/share-control";
import { useMailShareEvents, useShareResync } from "@/components/mail/share-live";
import { DraftRequestError, fetchSharedDraft, saveSharedDraftText } from "@/components/mail/shared-draft-client";
import type { ChatPerson } from "@/lib/chat/types";
import { recipientList } from "@/lib/mail/format";
import { laterDetail } from "@/lib/mail/later";
import type { MailSharePerson, SharedDraft } from "@/lib/mail/share-types";
import { draftStateLine, onlyOwnerSends, ownerDraftTitle, personFirstName } from "@/lib/mail/share-view";
import { newerVersion, reconcileText, sameText, textChanges, type DraftText } from "@/lib/mail/shared-text";
import { cn } from "@/lib/utils";
import CloseIcon from "@/public/assets/images/mail/close.svg";
import CheckIcon from "@/public/assets/images/mail/check.svg";
import ClockIcon from "@/public/assets/images/mail/clock.svg";
import LockIcon from "@/public/assets/images/mail/lock.svg";
import PaperclipIcon from "@/public/assets/images/_common/paperclip.svg";
import TrashIcon from "@/public/assets/images/mail/trash.svg";

const SAVE_DELAY_MS = 1000;

type Base = { text: DraftText; version: number };

type Save = { kind: "idle" | "saving" | "saved" | "error"; message?: string };

const STATE_ICONS = { sending: LockIcon, scheduled: ClockIcon, failed: LockIcon, sent: CheckIcon, discarded: TrashIcon } as const;

function textOf(draft: SharedDraft): DraftText {
  return { subject: draft.subject, body: draft.body };
}

export function SharedDraftStateLine({ draft, owner }: { draft: Pick<SharedDraft, "state" | "sendAt">; owner: ChatPerson }) {
  const [now] = useState(() => Date.now());
  const line = draftStateLine(draft.state, owner, draft.sendAt ? laterDetail(draft.sendAt, now) : null);
  if (!line) return null;
  const Icon = draft.state in STATE_ICONS ? STATE_ICONS[draft.state as keyof typeof STATE_ICONS] : null;
  return (
    <p role="status" className="ui-style bg-surface-raised flex items-center gap-2 rounded-xl px-3 py-2">
      {Icon && <Icon aria-hidden className="text-subtle size-3.5 shrink-0" />}
      <span className="min-w-0 flex-1">{line}</span>
    </p>
  );
}

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
  const [text, setText] = useState<DraftText>({ subject: "", body: "" });
  const [base, setBase] = useState<Base | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [save, setSave] = useState<Save>({ kind: "idle" });
  const latest = useRef({ text, base, locked: true });
  const seen = useRef<number | null>(null);
  const asked = useRef(0);
  const applied = useRef(0);
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  const locked = !draft || draft.state !== "editing";
  const dirty = Boolean(base) && !sameText(base!.text, text);

  useEffect(() => {
    latest.current = { text, base, locked };
  });

  const load = useCallback(() => {
    const ask = ++asked.current;
    fetchSharedDraft(shareId)
      .then((fresh) => {
        if (ask < applied.current || !newerVersion(seen.current, fresh.version)) return;
        applied.current = ask;
        seen.current = fresh.version;
        const freshText = textOf(fresh);
        const previous = latest.current.base;
        const next = fresh.state !== "editing" || !previous ? freshText : reconcileText(previous.text, latest.current.text, freshText);
        latest.current = { ...latest.current, text: next, base: { text: freshText, version: fresh.version } };
        setDraft(fresh);
        setLoadError(null);
        setBase({ text: freshText, version: fresh.version });
        setText(next);
      })
      .catch((error: unknown) => setLoadError(error instanceof Error ? error.message : "Couldn't load the draft. Try again."));
  }, [shareId]);

  useEffect(() => {
    load();
  }, [load]);

  useMailShareEvents((event) => {
    if (event.shareId === shareId && (event.type === "draft" || event.type === "people")) load();
  });

  useShareResync(() => {
    const now = latest.current;
    if (!now.base || sameText(now.base.text, now.text)) load();
  });

  const saveNow = useCallback(() => {
    const run = chain.current.then(async () => {
      const { text: wanted, base: from, locked: blocked } = latest.current;
      if (!from || blocked) return;
      const changes = textChanges(from.text, wanted);
      if (!changes) return;
      setSave({ kind: "saving" });
      try {
        const saved = await saveSharedDraftText(shareId, changes, from.version);
        if (saved.version >= (seen.current ?? 0)) {
          seen.current = saved.version;
          const settled = { text: wanted, version: saved.version };
          latest.current = { ...latest.current, base: settled };
          setBase(settled);
        }
        setSave({ kind: "saved" });
      } catch (error) {
        const changed = error instanceof DraftRequestError && error.detail.changed;
        setSave(changed ? { kind: "idle" } : { kind: "error", message: error instanceof Error ? error.message : "Couldn't save the draft. Try again." });
        if (error instanceof DraftRequestError && (error.status === 409 || error.status === 404)) load();
      }
    });
    chain.current = run.catch(() => null);
    return run;
  }, [shareId, load]);

  useEffect(() => {
    if (!dirty || locked) return;
    const timer = window.setTimeout(() => void saveNow(), SAVE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [text, base, dirty, locked, saveNow]);

  useEffect(() => {
    const flush = () => {
      const { text: wanted, base: from, locked: blocked } = latest.current;
      const changes = from && !blocked ? textChanges(from.text, wanted) : null;
      if (changes && from) void saveSharedDraftText(shareId, changes, from.version, true).catch(() => undefined);
    };
    const hidden = () => {
      if (document.visibilityState === "hidden") flush();
    };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", hidden);
    return () => {
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", hidden);
      void chain.current.then(flush);
    };
  }, [shareId]);

  const title = ownerDraftTitle(owner);
  const subjectShown = draft?.mode === "new" || draft?.mode === "forward";
  const gone = draft?.state === "sent" || draft?.state === "discarded" || draft?.state === "none";
  const everyone = [...people.filter((person) => person.owner), ...people.filter((person) => !person.owner)];
  const status = save.kind === "saving" ? "Saving…" : save.kind === "saved" && !dirty ? "Saved" : "";

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
        {draft && <SharedDraftStateLine draft={draft} owner={owner} />}
        {loadError && draft && (
          <p role="alert" className="caption-style text-danger">
            {loadError}
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
            {subjectShown ? (
              <>
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
              </>
            ) : (
              <p className="mt-1 truncate text-[16px] font-medium">{text.subject || "(no subject)"}</p>
            )}
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
            {draft.signature && <p className="caption-style text-subtle pb-1 whitespace-pre-wrap">{draft.signature}</p>}
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
        {save.kind === "error" && (
          <p role="alert" className="caption-style text-danger">
            {save.message}
          </p>
        )}
      </div>
      <div className="border-line-subtle flex items-center gap-2 border-t px-4 py-2">
        <span className="ui-style text-soft flex items-center gap-1.5">
          <LockIcon aria-hidden className="text-subtle size-3.5" />
          {onlyOwnerSends(owner)}
        </span>
        <span role="status" className="caption-style text-subtle ml-auto shrink-0">
          {status}
        </span>
      </div>
    </section>
  );
}
