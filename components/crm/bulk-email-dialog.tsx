"use client";

import { useEffect, useMemo, useRef, useState } from "react";
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
import { sendContactEmailAction } from "@/app/(crm)/inbox/actions";
import {
  BULK_EMAIL_GAP_MS,
  BULK_EMAIL_LIMIT,
  PERSONAL_TOKENS,
  personalise,
  splitRecipients,
  unknownTokens,
  type Recipient,
} from "@/lib/crm/personalise";
import { sendPaced } from "@/lib/crm/send-queue";
import { cn } from "@/lib/utils";

type Status = "queued" | "sending" | "sent" | "failed" | "stopped";

type Progress = Record<string, { status: Status; error?: string; warning?: string }>;

const STATUS_LABELS: Record<Status, string> = {
  queued: "Queued",
  sending: "Sending…",
  sent: "Sent",
  failed: "Failed",
  stopped: "Not sent",
};

const STATUS_CLASSES: Record<Status, string> = {
  queued: "text-subtle",
  sending: "text-foreground",
  sent: "text-success",
  failed: "text-danger",
  stopped: "text-subtle",
};

function plural(value: number, one: string, many: string) {
  return `${value} ${value === 1 ? one : many}`;
}

export default function BulkEmailDialog({
  recipients,
  mailboxConnected,
  onClose,
}: {
  recipients: Recipient[];
  mailboxConnected: boolean;
  onClose: (sent: number) => void;
}) {
  const { sendable, skipped } = useMemo(() => splitRecipients(recipients), [recipients]);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [phase, setPhase] = useState<"compose" | "sending" | "done">("compose");
  const [progress, setProgress] = useState<Progress>({});
  const [halted, setHalted] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  const [sentCount, setSentCount] = useState(0);
  const stop = useRef(false);
  const wake = useRef<(() => void) | null>(null);
  const field = useRef<"subject" | "body">("body");
  const subjectRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);

  const tooMany = sendable.length > BULK_EMAIL_LIMIT;
  const first = sendable[0];
  const unknown = unknownTokens(`${subject}\n${body}`);
  const canSend =
    mailboxConnected &&
    !tooMany &&
    sendable.length > 0 &&
    subject.trim() !== "" &&
    body.trim() !== "";

  useEffect(() => {
    if (phase !== "sending") return;
    function warn(event: BeforeUnloadEvent) {
      event.preventDefault();
    }
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [phase]);

  function insert(token: string) {
    const text = `{{${token}}}`;
    const target = field.current === "subject" ? subjectRef.current : bodyRef.current;
    const value = field.current === "subject" ? subject : body;
    const start = target?.selectionStart ?? value.length;
    const end = target?.selectionEnd ?? value.length;
    const next = value.slice(0, start) + text + value.slice(end);
    if (field.current === "subject") setSubject(next);
    else setBody(next);
    requestAnimationFrame(() => {
      target?.focus();
      target?.setSelectionRange(start + text.length, start + text.length);
    });
  }

  function update(id: string, entry: Progress[string]) {
    setProgress((current) => ({ ...current, [id]: entry }));
  }

  function pause(ms: number) {
    return new Promise<void>((resolve) => {
      const timer = window.setTimeout(done, ms);
      function done() {
        window.clearTimeout(timer);
        wake.current = null;
        resolve();
      }
      wake.current = done;
    });
  }

  async function send() {
    if (!canSend) return;
    stop.current = false;
    setStopping(false);
    setHalted(null);
    setPhase("sending");
    setProgress(Object.fromEntries(sendable.map((recipient) => [recipient.id, { status: "queued" }])));
    const result = await sendPaced(
      sendable,
      async (recipient) => {
        const sent = await sendContactEmailAction(
          recipient.id,
          personalise(subject, recipient),
          personalise(body, recipient),
        );
        if ("error" in sent && sent.error) return { error: sent.error };
        return { warning: "warning" in sent ? sent.warning : null };
      },
      {
        gapMs: BULK_EMAIL_GAP_MS,
        stopped: () => stop.current,
        wait: pause,
        onUpdate: (entry) => {
          if (entry.status === "sent") setSentCount((count) => count + 1);
          const { id, ...rest } = entry;
          update(id, rest);
        },
      },
    );
    setHalted(result.halted);
    setProgress((current) => {
      const next = { ...current };
      for (const id of result.unsent) {
        if (next[id]?.status === "queued") next[id] = { status: "stopped" };
      }
      return next;
    });
    setPhase("done");
  }

  function halt() {
    stop.current = true;
    setStopping(true);
    wake.current?.();
  }

  function close() {
    if (phase === "sending") return;
    onClose(sentCount);
  }

  const failed = Object.values(progress).filter((entry) => entry.status === "failed").length;
  const finished = Object.values(progress).filter(
    (entry) => entry.status === "sent" || entry.status === "failed",
  ).length;

  return (
    <Dialog open onOpenChange={(open) => !open && close()}>
      <DialogContent
        className="max-w-[640px]"
        onEscapeKeyDown={(event) => phase === "sending" && event.preventDefault()}
        onPointerDownOutside={(event) => phase === "sending" && event.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>
            Email {plural(sendable.length, "person", "people")}
          </DialogTitle>
          <DialogDescription>
            Each person gets their own email from your Microsoft mailbox, sent one at a
            time about two seconds apart.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4 px-6 py-5">
          {!mailboxConnected && (
            <p role="alert" className="caption-style text-danger">
              Connect Microsoft in Inbox before sending.
            </p>
          )}
          {tooMany && (
            <p role="alert" className="caption-style text-danger">
              Orbit sends up to {BULK_EMAIL_LIMIT} emails per run. Select{" "}
              {BULK_EMAIL_LIMIT} or fewer people with an email address and send the rest
              in another batch.
            </p>
          )}
          {sendable.length === 0 && (
            <p role="alert" className="caption-style text-danger">
              None of the selected people have an email address.
            </p>
          )}
          {halted && (
            <p role="alert" className="caption-style text-danger">
              Stopped: {halted}
            </p>
          )}
          <section className="flex flex-col gap-1.5">
            <h3 className="caption-style text-subtle">
              {phase === "compose"
                ? "Recipients"
                : `${finished} of ${sendable.length} done${failed ? ` · ${failed} failed` : ""}`}
            </h3>
            <ul className="border-line-strong max-h-44 overflow-auto rounded-lg border">
              {sendable.map((recipient) => {
                const entry = progress[recipient.id];
                return (
                  <li
                    key={recipient.id}
                    className="border-border flex items-start justify-between gap-3 border-b px-3 py-1.5 last:border-b-0"
                  >
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate text-[13px] leading-5">{recipient.name}</span>
                      <span className="caption-style text-subtle truncate">
                        {recipient.email}
                        {recipient.company ? ` · ${recipient.company}` : ""}
                      </span>
                      {entry?.error && (
                        <span className="caption-style text-danger">{entry.error}</span>
                      )}
                      {entry?.warning && (
                        <span className="caption-style text-warning">{entry.warning}</span>
                      )}
                    </span>
                    {entry && (
                      <span
                        className={cn("caption-style shrink-0", STATUS_CLASSES[entry.status])}
                      >
                        {STATUS_LABELS[entry.status]}
                      </span>
                    )}
                  </li>
                );
              })}
              {skipped.map(({ recipient, reason }) => (
                <li
                  key={`skipped-${recipient.id}`}
                  className="border-border flex items-start justify-between gap-3 border-b px-3 py-1.5 last:border-b-0"
                >
                  <span className="text-subtle truncate text-[13px] leading-5">
                    {recipient.name}
                  </span>
                  <span className="caption-style text-subtle shrink-0">
                    Skipped — {reason}
                  </span>
                </li>
              ))}
            </ul>
          </section>
          {phase === "compose" && (
            <>
              <div className="flex flex-col gap-2">
                <label className="sr-only" htmlFor="bulk-email-subject">
                  Subject
                </label>
                <Input
                  id="bulk-email-subject"
                  ref={subjectRef}
                  value={subject}
                  autoComplete="off"
                  maxLength={200}
                  placeholder="Subject"
                  onFocus={() => (field.current = "subject")}
                  onChange={(event) => setSubject(event.target.value)}
                  onKeyDown={(event) => event.key === "Enter" && event.preventDefault()}
                />
                <label className="sr-only" htmlFor="bulk-email-body">
                  Message
                </label>
                <textarea
                  id="bulk-email-body"
                  ref={bodyRef}
                  value={body}
                  autoComplete="off"
                  maxLength={8000}
                  placeholder={"Hi {{first_name}},\n\nWrite the message"}
                  onFocus={() => (field.current = "body")}
                  onChange={(event) => setBody(event.target.value)}
                  className="border-line-strong bg-secondary focus-visible:border-ring min-h-32 w-full rounded-lg border px-3 py-2 text-[14px] leading-5 outline-none"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <p className="caption-style text-subtle">
                  Personalise with a token. Click one to insert it where you are typing.
                </p>
                <ul className="flex flex-wrap gap-1">
                  {PERSONAL_TOKENS.map((item) => (
                    <li key={item.token}>
                      <Button
                        variant="subtle"
                        size="sm"
                        title={item.label}
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => insert(item.token)}
                        className="font-mono"
                      >
                        {`{{${item.token}}}`}
                      </Button>
                    </li>
                  ))}
                </ul>
                <p className="caption-style text-subtle">
                  {"{{first_name}}"} falls back to the full name, then “there”.
                </p>
                {unknown.length > 0 && (
                  <p className="caption-style text-warning">
                    Not a token, sent as typed: {unknown.join(", ")}
                  </p>
                )}
              </div>
              {first && (subject || body) && (
                <section className="flex flex-col gap-1.5" aria-label="Preview">
                  <h3 className="caption-style text-subtle">
                    Preview for {first.name}
                  </h3>
                  <div className="border-line-strong bg-card flex flex-col gap-2 rounded-lg border px-3 py-2.5">
                    <p className="text-[14px] leading-5 font-medium">
                      {personalise(subject, first) || "No subject"}
                    </p>
                    <p
                      className="text-soft text-[14px] leading-5 break-words whitespace-pre-wrap"
                    >
                      {personalise(body, first)}
                    </p>
                  </div>
                </section>
              )}
            </>
          )}
        </div>
        <DialogFooter>
          {phase === "compose" && (
            <>
              <Button variant="ghost" size="sm" onClick={close}>
                Cancel
              </Button>
              <Button variant="primary" size="sm" disabled={!canSend} onClick={send}>
                Send {plural(sendable.length, "email", "emails")}
              </Button>
            </>
          )}
          {phase === "sending" && (
            <Button variant="secondary" size="sm" disabled={stopping} onClick={halt}>
              {stopping ? "Stopping…" : "Stop"}
            </Button>
          )}
          {phase === "done" && (
            <>
              <span className="caption-style text-subtle mr-auto">
                Sent {plural(sentCount, "email", "emails")}
                {failed ? ` · ${failed} failed` : ""}
              </span>
              <Button variant="primary" size="sm" onClick={close}>
                Close
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
