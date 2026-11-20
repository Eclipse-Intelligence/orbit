"use client";

import { useEffect, useId, useRef, useState } from "react";
import Button from "@/components/_ui/button";
import HoldButton from "@/components/_ui/hold-button";
import { FileChip, UploadQueue } from "@/components/chat/attachments";
import { useChat } from "@/components/chat/chat-context";
import type { ChatInputHandle } from "@/components/chat/chat-input";
import { ComposerBox } from "@/components/chat/composer";
import MessageBody from "@/components/chat/message-body";
import { PhoneBack } from "@/components/chat/room-view";
import { messageBody } from "@/components/chat/use-chat-actions";
import LaterPicker from "@/components/mail/later-picker";
import { fullTime } from "@/lib/chat/format";
import { scheduledPlace, scheduledWhen, sendLaterChoices } from "@/lib/chat/scheduled";
import type { ChatScheduledItem } from "@/lib/chat/types";
import { mentionsIn, plainMentions, type Mention } from "@/lib/mentions";
import { zoneLabel } from "@/lib/time";
import { cn } from "@/lib/utils";
import ClockIcon from "@/public/assets/images/chat/clock.svg";
import { useChatScheduled } from "@/stores/chat-scheduled-store";

function EditRow({ item, onDone }: { item: ChatScheduledItem; onDone: () => void }) {
  const { schedule, now } = useChat();
  const id = useId();
  const input = useRef<ChatInputHandle>(null);
  const [value, setValue] = useState(() => plainMentions(item.body));
  const [mentions, setMentions] = useState<Mention[]>(() => mentionsIn(item.body));
  const [removed, setRemoved] = useState<string[]>([]);
  const [sendAt, setSendAt] = useState<string | null>(null);
  const [picking, setPicking] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const kept = item.attachments.filter((file) => !removed.includes(file.id));
  const empty = !value.trim() && kept.length === 0;
  const at = sendAt ?? item.sendAt;
  const stale = new Date(at).getTime() <= now;

  async function save() {
    if (empty || saving || !schedule) return;
    setSaving(true);
    setError(null);
    const failure = await schedule.update(item, { body: messageBody(value, mentions), format: "markdown", removeAttachmentIds: removed, ...(sendAt ? { sendAt } : {}) });
    if (failure) {
      setError(failure);
      setSaving(false);
      return;
    }
    onDone();
  }

  return (
    <div className="flex flex-col gap-1.5 pt-1">
      <ComposerBox
        id={`scheduled-edit-${id}`}
        inputRef={input}
        value={value}
        mentions={mentions}
        placeholder="Message"
        label="Edit scheduled message"
        submitVerb="save"
        scope="thread"
        autoFocus
        queue={
          kept.length > 0 ? (
            <UploadQueue
              files={kept.map((file) => ({ key: file.id, name: file.name, size: file.size, contentType: file.contentType, preview: null, status: "done", progress: 1, id: file.id, width: file.width, height: file.height }))}
              onRemove={(fileId) => setRemoved((current) => [...current, fileId])}
              onRetry={() => undefined}
            />
          ) : null
        }
        actions={
          <span className="flex items-center gap-2 pointer-coarse:gap-3">
            <Button variant="ghost" size="sm" onMouseDown={(event) => event.preventDefault()} onClick={onDone} className="hit max-md:h-11">
              Cancel
            </Button>
            <Button variant="primary" size="sm" disabled={empty || saving} onMouseDown={(event) => event.preventDefault()} onClick={() => void save()} className="hit max-md:h-11">
              Save
            </Button>
          </span>
        }
        onChange={(next, kept) => {
          setValue(next);
          setMentions(kept);
        }}
        onSubmit={() => void save()}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          event.preventDefault();
          event.stopPropagation();
          onDone();
        }}
      />
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-1">
        <span className="caption-style text-subtle">Sends</span>
        <Button variant="secondary" size="sm" aria-label={`Change time, now ${scheduledWhen(at, now, undefined, { sentence: true })}`} onClick={() => setPicking(Date.now())} className="hit max-md:h-11">
          <ClockIcon aria-hidden className="size-3.5" />
          {scheduledWhen(at, now)}
        </Button>
        {stale && <span className="caption-style text-subtle">Sends within a minute of saving.</span>}
      </div>
      {error && (
        <p role="alert" className="caption-style text-danger px-1">
          {error}
        </p>
      )}
      <LaterPicker
        request={
          picking === null
            ? null
            : {
                title: "Send later",
                description: `Times are ${zoneLabel()} time.`,
                options: sendLaterChoices(picking).map((choice) => ({ id: choice.id, label: choice.label, detail: choice.detail, at: choice.at })),
                now: picking,
                onPick: (picked) => setSendAt(picked),
              }
        }
        onClose={() => setPicking(null)}
      />
    </div>
  );
}

function Row({ item }: { item: ChatScheduledItem }) {
  const { go, viewer, now, memberNames, schedule } = useChat();
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState<"send" | "delete" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const failed = item.status === "failed";
  const sending = item.status === "sending";
  const reachable = item.conversation.name !== null;

  async function run(kind: "send" | "delete", work: () => Promise<string | null>) {
    setBusy(kind);
    setError(null);
    const failure = await work();
    if (failure) setError(failure);
    setBusy(null);
  }

  function open() {
    go({ view: { kind: "room", id: item.conversation.id }, thread: item.parentId, message: null });
  }

  return (
    <li className="border-border flex gap-3 border-b px-5 py-3 last:border-b-0 max-md:px-3.5">
      <ClockIcon aria-hidden className={cn("mt-1 size-3.5 shrink-0", failed ? "text-danger" : "text-subtle")} />
      <article aria-label={`Scheduled message for ${scheduledPlace(item)}`} className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className="truncate text-[14px] font-medium">{scheduledPlace(item)}</span>
          <time dateTime={item.sendAt} title={fullTime(item.sendAt)} className={cn("caption-style shrink-0 tabular-nums", failed ? "text-danger" : "text-subtle")}>
            {failed ? "Not sent" : sending ? "Sending" : scheduledWhen(item.sendAt, now)}
          </time>
        </div>
        {failed && item.failure && (
          <p role="status" className="caption-style text-danger">
            {item.failure}
          </p>
        )}
        {editing ? (
          <EditRow item={item} onDone={() => setEditing(false)} />
        ) : (
          <>
            {item.body && <MessageBody body={item.body} format={item.format} viewerId={viewer.id} names={memberNames} />}
            {item.attachments.length > 0 && (
              <div className="flex flex-wrap gap-1.5 pt-0.5">
                {item.attachments.map((file) => (
                  <FileChip key={file.id} file={file} />
                ))}
              </div>
            )}
            <div className="-ml-2 flex flex-wrap items-center gap-1 pt-1 pointer-coarse:gap-2">
              <Button variant="secondary" size="sm" disabled={!schedule || busy !== null || sending} onClick={() => schedule && void run("send", () => schedule.sendNow(item))} className="hit max-md:h-11">
                {busy === "send" ? "Sending…" : failed ? "Try again" : "Send now"}
              </Button>
              <Button variant="ghost" size="sm" disabled={busy !== null || sending} onClick={() => setEditing(true)} className="hit max-md:h-11">
                Edit
              </Button>
              {reachable && (
                <Button variant="ghost" size="sm" onClick={open} className="hit max-md:h-11">
                  Open
                </Button>
              )}
              <HoldButton disabled={!schedule || busy !== null || sending} onConfirm={() => schedule && void run("delete", () => schedule.cancel(item))} className="max-md:h-11">
                Hold to delete
              </HoldButton>
            </div>
          </>
        )}
        {error && (
          <p role="alert" className="caption-style text-danger pt-1">
            {error}
          </p>
        )}
      </article>
    </li>
  );
}

export default function ScheduledView() {
  const { back } = useChat();
  const items = useChatScheduled((store) => store.items);
  const loaded = useChatScheduled((store) => store.loaded);
  const error = useChatScheduled((store) => store.error);

  useEffect(() => {
    useChatScheduled.getState().load({ force: true });
  }, []);

  const failed = items.filter((item) => item.status === "failed");
  const waiting = items.filter((item) => item.status !== "failed");

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex h-[52px] shrink-0 items-center gap-2 px-5 max-md:h-auto max-md:px-3 max-md:py-2.5">
        <PhoneBack label="Chat" onClick={back} />
        <h2 className="max-md:flex-1 max-md:text-center">Scheduled</h2>
        <span aria-hidden className="size-11 shrink-0 md:hidden" />
      </header>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain">
        {error && (
          <div className="flex flex-col items-center gap-3 py-10 text-center">
            <p role="alert" className="text-danger">
              {error}
            </p>
            <Button variant="secondary" size="sm" onClick={() => useChatScheduled.getState().load({ force: true })} className="hit max-md:h-11">
              Try again
            </Button>
          </div>
        )}
        {!loaded && !error && (
          <p role="status" className="caption-style text-subtle py-10 text-center">
            Loading…
          </p>
        )}
        {loaded && !error && items.length === 0 && (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 py-16 text-center">
            <h3>No scheduled messages</h3>
            <p className="text-soft max-w-[24em]">Only you can see what you schedule.</p>
          </div>
        )}
        {failed.length > 0 && (
          <ul aria-label="Messages that weren't sent" className="flex flex-col">
            {failed.map((item) => (
              <Row key={item.id} item={item} />
            ))}
          </ul>
        )}
        {waiting.length > 0 && (
          <ul aria-label="Scheduled messages" className="flex flex-col">
            {waiting.map((item) => (
              <Row key={item.id} item={item} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
