"use client";

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import Button from "@/components/_ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/_ui/popover";
import { AttachButton, AttachmentList, useEmailAttachments } from "@/components/crm/email-attachments";
import { useSenders } from "@/components/crm/email-sender";
import { SaveTemplateForm, UseTemplateButton } from "@/components/crm/email-template-picker";
import { TokenChips, insertToken } from "@/components/crm/email-tokens";
import { saveSignatureAction, sendContactEmailAction } from "@/app/(crm)/inbox/actions";
import { addActivityAction } from "@/app/(crm)/records";
import { renderTemplate, unpersonalised, type EmailTemplate, type UsedTemplate } from "@/lib/crm/email-template-rules";
import { personalise, type Recipient } from "@/lib/crm/personalise";
import { cn } from "@/lib/utils";
import BookmarkIcon from "@/public/assets/images/_common/bookmark.svg";
import BracesIcon from "@/public/assets/images/_common/braces.svg";
import ChevronDownIcon from "@/public/assets/images/_common/chevron-down.svg";

const BODY_MIN = 132;
const DRAFT_PREFIX = "orbit:email-draft:";

function readDraft(key: string | null) {
  if (!key || typeof window === "undefined") return { subject: "", message: "" };
  try {
    const stored = JSON.parse(window.localStorage.getItem(DRAFT_PREFIX + key) ?? "null") as { subject?: string; message?: string } | null;
    return { subject: stored?.subject ?? "", message: stored?.message ?? "" };
  } catch {
    return { subject: "", message: "" };
  }
}

function writeDraft(key: string | null, subject: string, message: string) {
  if (!key) return;
  try {
    if (!subject.trim() && !message.trim()) window.localStorage.removeItem(DRAFT_PREFIX + key);
    else window.localStorage.setItem(DRAFT_PREFIX + key, JSON.stringify({ subject, message }));
  } catch {}
}

function Line({ label, htmlFor, children }: { label: string; htmlFor?: string; children: ReactNode }) {
  return (
    <div className="border-line-strong/70 flex min-h-10 items-center gap-3 border-b">
      <label htmlFor={htmlFor} className="caption-style text-subtle w-12 shrink-0">
        {label}
      </label>
      <div className="flex min-w-0 flex-1 items-center">{children}</div>
    </div>
  );
}

export default function ContactEmail({
  contactId,
  companyId,
  email,
  recipient,
  mailboxConnected,
  idPrefix = contactId ?? "none",
  unavailable,
  to,
  onDone,
  focusSubject,
}: {
  contactId: string | null;
  companyId?: string;
  email: string | null;
  recipient: Recipient | null;
  mailboxConnected: boolean;
  idPrefix?: string;
  unavailable?: string;
  to?: ReactNode;
  onDone?: (result: { sent: boolean; from: string | null; warning: string | null }) => void;
  focusSubject?: boolean;
}) {
  const router = useRouter();
  const files = useEmailAttachments();
  const sender = useSenders(Boolean(contactId && email));
  const canSendMail = mailboxConnected || sender.senders.length > 0;
  const sending = useRef(false);
  const [subject, setSubject] = useState("");
  const [message, setMessage] = useState("");
  const [draftFor, setDraftFor] = useState<string | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; tone: "ok" | "warn" } | null>(null);
  const [pending, setPending] = useState<"send" | "log" | null>(null);
  const [used, setUsed] = useState<UsedTemplate | null>(null);
  const [saving, setSaving] = useState(false);
  const [withSignature, setWithSignature] = useState(true);
  const [editingSignature, setEditingSignature] = useState(false);
  const [signatureDraft, setSignatureDraft] = useState("");
  const [signatureSaved, setSignatureSaved] = useState<Record<string, string | null>>({});
  const [tokensOpen, setTokensOpen] = useState(false);
  const field = useRef<"subject" | "body">("body");
  const subjectRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const target: Recipient = recipient ?? { id: contactId ?? "none", firstName: null, lastName: null, name: "", email, company: null };
  const chosen = sender.chosen;
  const signature = chosen ? (chosen.email in signatureSaved ? signatureSaved[chosen.email] : chosen.signature) : null;
  const empty = subject.trim() === "" || message.trim() === "";

  useEffect(() => {
    if (draftFor === contactId) return;
    const timer = window.setTimeout(() => {
      const restored = readDraft(contactId);
      setDraftFor(contactId);
      setSubject(restored.subject);
      setMessage(restored.message);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [contactId, draftFor]);

  useEffect(() => {
    if (draftFor !== contactId) return;
    const timer = window.setTimeout(() => writeDraft(contactId, subject, message), 300);
    return () => window.clearTimeout(timer);
  }, [contactId, draftFor, subject, message]);

  useLayoutEffect(() => {
    const node = bodyRef.current;
    if (!node) return;
    node.style.height = "auto";
    node.style.height = `${Math.max(BODY_MIN, Math.min(node.scrollHeight, 560))}px`;
  }, [message]);

  function insert(token: string) {
    if (field.current === "subject") insertToken(subjectRef.current, subject, token, setSubject);
    else insertToken(bodyRef.current, message, token, setMessage);
    setTokensOpen(false);
  }

  function applyTemplate(template: EmailTemplate) {
    setError(null);
    setNotice(null);
    const rendered = renderTemplate(template, target);
    setSubject(rendered.subject);
    setMessage(rendered.body);
    setUsed({ source: { subject: template.subject, body: template.body }, rendered });
    setSaving(false);
  }

  function reset() {
    setSubject("");
    setMessage("");
    setUsed(null);
    setSaving(false);
    setWithSignature(true);
    writeDraft(contactId, "", "");
  }

  async function send() {
    if (!contactId || !email || !canSendMail || sending.current || pending || files.uploading || empty) return;
    sending.current = true;
    setPending("send");
    setError(null);
    setNotice(null);
    try {
      const result = await sendContactEmailAction(contactId, {
        subject: personalise(subject, target),
        body: personalise(message, target),
        attachments: files.ids,
        from: sender.from,
        signature: withSignature,
      });
      if ("error" in result && result.error) {
        setError(result.error);
        return;
      }
      reset();
      files.clear();
      const warning = "warning" in result ? (result.warning ?? null) : null;
      onDone?.({ sent: true, from: chosen?.email ?? null, warning });
      setNotice(warning ? { text: warning, tone: "warn" } : { text: `Sent from ${chosen?.email ?? "your mailbox"}.`, tone: "ok" });
      router.refresh();
    } finally {
      sending.current = false;
      setPending(null);
    }
  }

  async function logEmail() {
    if (!contactId || sending.current || pending || empty) return;
    sending.current = true;
    setPending("log");
    setError(null);
    setNotice(null);
    try {
      const result = await addActivityAction({ contactId, companyId }, "email", personalise(subject, target), personalise(message, target));
      if (result.error) {
        setError(result.error);
        return;
      }
      reset();
      onDone?.({ sent: false, from: null, warning: null });
      setNotice({ text: "Email recorded on this contact.", tone: "ok" });
      router.refresh();
    } finally {
      sending.current = false;
      setPending(null);
    }
  }

  async function saveSignature() {
    if (!chosen) return;
    const result = await saveSignatureAction(chosen.email, signatureDraft);
    if (result.error) {
      setError(result.error);
      return;
    }
    setSignatureSaved((current) => ({ ...current, [chosen.email]: result.signature ?? null }));
    setEditingSignature(false);
    setWithSignature(true);
  }

  if (!contactId && !to) return <p className="caption-style text-subtle px-1 py-2">{unavailable}</p>;

  return (
    <div className="flex flex-col">
      <Line label="To" htmlFor={to ? `email-to-${idPrefix}` : undefined}>
        {to ?? (
          <span className="min-w-0 truncate text-[14px] leading-5">
            {target.name || email || "This contact"}
            {email && target.name && <span className="text-subtle"> &lt;{email}&gt;</span>}
          </span>
        )}
      </Line>
      {email && sender.senders.length > 0 && (
        <Line label="From" htmlFor={`email-from-${idPrefix}`}>
          {sender.senders.length > 1 ? (
            <span className="relative flex min-w-0 items-center">
              <select
                id={`email-from-${idPrefix}`}
                value={sender.from ?? ""}
                disabled={pending !== null}
                onChange={(event) => {
                  sender.setFrom(event.target.value);
                  setEditingSignature(false);
                  setWithSignature(true);
                }}
                className="hover:text-foreground focus-visible:ring-ring/60 min-w-0 cursor-pointer appearance-none truncate rounded-md bg-transparent py-1 pr-6 text-[14px] leading-5 outline-none focus-visible:ring-2"
              >
                {sender.senders.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.email}
                  </option>
                ))}
              </select>
              <ChevronDownIcon aria-hidden className="text-subtle pointer-events-none absolute right-1 size-3" />
            </span>
          ) : (
            <span className="truncate text-[14px] leading-5">{chosen?.email}</span>
          )}
        </Line>
      )}
      <label className="sr-only" htmlFor={`email-subject-${idPrefix}`}>
        Subject
      </label>
      <input
        id={`email-subject-${idPrefix}`}
        ref={subjectRef}
        data-compose-focus=""
        autoFocus={focusSubject}
        value={subject}
        autoComplete="off"
        maxLength={200}
        placeholder="Subject"
        onFocus={() => {
          field.current = "subject";
        }}
        onChange={(event) => setSubject(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Enter") return;
          event.preventDefault();
          bodyRef.current?.focus();
        }}
        className="border-line-strong/70 placeholder:text-subtle min-h-11 w-full border-b bg-transparent text-[15px] leading-6 font-medium outline-none"
      />
      <label className="sr-only" htmlFor={`email-body-${idPrefix}`}>
        Message
      </label>
      <textarea
        id={`email-body-${idPrefix}`}
        ref={bodyRef}
        value={message}
        autoComplete="off"
        maxLength={8000}
        placeholder={email ? "Write your message" : "Write the email to log"}
        onFocus={() => {
          field.current = "body";
        }}
        onChange={(event) => setMessage(event.target.value)}
        className="placeholder:text-subtle min-h-[132px] w-full resize-none bg-transparent pt-3 text-[14.5px] leading-[1.6] outline-none"
      />

      {email && canSendMail && (
        <div className="group/signature pt-1 pb-2">
          {editingSignature ? (
            <div className="flex flex-col gap-2">
              <label className="caption-style text-subtle" htmlFor={`email-signature-${idPrefix}`}>
                Signature for {chosen?.email}
              </label>
              <textarea
                id={`email-signature-${idPrefix}`}
                value={signatureDraft}
                autoFocus
                rows={4}
                maxLength={2000}
                onChange={(event) => setSignatureDraft(event.target.value)}
                className="border-line-strong bg-secondary focus-visible:border-ring w-full rounded-lg border px-3 py-2 text-[13.5px] leading-5 outline-none"
              />
              <span className="flex gap-1">
                <Button variant="secondary" size="sm" type="button" onClick={() => void saveSignature()}>
                  Save signature
                </Button>
                <Button variant="ghost" size="sm" type="button" onClick={() => setEditingSignature(false)}>
                  Cancel
                </Button>
              </span>
            </div>
          ) : signature && withSignature ? (
            <div className="flex items-start gap-3">
              <p className="text-subtle min-w-0 flex-1 border-l-2 border-white/10 pl-3 text-[13.5px] leading-[1.55] whitespace-pre-wrap">{signature}</p>
              <span className="flex shrink-0 gap-1 transition-opacity duration-150 group-hover/signature:opacity-100 focus-within:opacity-100 [@media(hover:hover)]:opacity-0">
                <Button
                  variant="ghost"
                  size="sm"
                  type="button"
                  onClick={() => {
                    setSignatureDraft(signature);
                    setEditingSignature(true);
                  }}
                >
                  Edit
                </Button>
                <Button variant="ghost" size="sm" type="button" onClick={() => setWithSignature(false)}>
                  Remove
                </Button>
              </span>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => {
                if (signature) setWithSignature(true);
                else {
                  setSignatureDraft("");
                  setEditingSignature(true);
                }
              }}
              className="caption-style text-subtle hover:text-foreground cursor-pointer rounded-sm outline-none focus-visible:underline"
            >
              {signature ? "Add signature back" : "Add a signature"}
            </button>
          )}
        </div>
      )}

      <AttachmentList items={files.items} onRemove={files.remove} disabled={pending !== null} />

      {saving && (
        <div className="pt-2">
          <SaveTemplateForm
            idPrefix={idPrefix}
            {...unpersonalised({ subject, body: message }, used)}
            onDone={(template) => {
              setSaving(false);
              if (template) setNotice({ text: `Saved “${template.name}” as a template.`, tone: "ok" });
            }}
          />
        </div>
      )}

      {(error || notice || !email || !canSendMail) && (
        <p
          role={error || notice?.tone === "warn" ? "alert" : "status"}
          className={cn("caption-style pt-2", error || notice?.tone === "warn" ? "text-danger" : "text-subtle")}
        >
          {error ??
            notice?.text ??
            (!contactId
              ? (unavailable ?? "Choose who to email.")
              : !email
                ? "Save an email address on this contact to send. You can still log an email."
                : "Connect Microsoft in Inbox to send. You can still log the email.")}
        </p>
      )}

      <div className="border-line-strong/70 mt-2 flex items-center justify-between gap-2 border-t pt-2">
        <span className="flex items-center">
          {email && canSendMail && (
            <AttachButton compact id={`email-files-${idPrefix}`} onFiles={(picked) => void files.add(picked)} disabled={pending !== null} />
          )}
          <UseTemplateButton compact onPick={applyTemplate} disabled={pending !== null} />
          <Popover open={tokensOpen} onOpenChange={setTokensOpen}>
            <PopoverTrigger asChild>
              <Button variant="ghost" size="sm" type="button" aria-label="Personalise" title="Personalise" className="size-8 p-0">
                <BracesIcon aria-hidden className="size-3.5" />
              </Button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-[min(320px,calc(100vw-2rem))] p-3">
              <TokenChips onInsert={insert} text={`${subject}\n${message}`} />
            </PopoverContent>
          </Popover>
          <Button
            variant="ghost"
            size="sm"
            type="button"
            aria-label="Save as template"
            aria-expanded={saving}
            title="Save as template"
            disabled={pending !== null || (subject.trim() === "" && message.trim() === "")}
            className="size-8 p-0"
            onClick={() => setSaving((value) => !value)}
          >
            <BookmarkIcon aria-hidden className="size-3.5" />
          </Button>
        </span>
        <span className="flex items-center gap-1">
          <Button variant="ghost" size="sm" type="button" disabled={pending !== null || empty || !contactId} onClick={logEmail}>
            {pending === "log" ? "Saving…" : "Log only"}
          </Button>
          <Button
            variant="primary"
            size="sm"
            type="button"
            disabled={pending !== null || files.uploading || !email || !canSendMail || empty}
            data-shortcut-submit=""
            title="Send (⌘ Enter)"
            onClick={send}
          >
            {pending === "send" ? "Sending…" : files.uploading ? "Uploading…" : "Send"}
            <span aria-hidden className="hidden pl-1 text-[11px] opacity-60 sm:inline">
              ⌘↵
            </span>
          </Button>
        </span>
      </div>
    </div>
  );
}
