"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Button from "@/components/_ui/button";
import { Input } from "@/components/_ui/input";
import {
  SaveTemplateForm,
  UseTemplateButton,
} from "@/components/crm/email-template-picker";
import { AttachButton, AttachmentList, useEmailAttachments } from "@/components/crm/email-attachments";
import { TokenChips, insertToken } from "@/components/crm/email-tokens";
import { sendContactEmailAction } from "@/app/(crm)/inbox/actions";
import { addActivityAction } from "@/app/(crm)/records";
import {
  renderTemplate,
  unpersonalised,
  type EmailTemplate,
  type UsedTemplate,
} from "@/lib/crm/email-template-rules";
import { personalise, type Recipient } from "@/lib/crm/personalise";

export default function ContactEmail({
  contactId,
  companyId,
  email,
  recipient,
  mailboxConnected,
  idPrefix = contactId ?? "none",
  unavailable,
}: {
  contactId: string | null;
  companyId?: string;
  email: string | null;
  recipient: Recipient | null;
  mailboxConnected: boolean;
  idPrefix?: string;
  unavailable?: string;
}) {
  const router = useRouter();
  const files = useEmailAttachments();
  const sending = useRef(false);
  const [subject, setSubject] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [warning, setWarning] = useState<string | null>(null);
  const [logged, setLogged] = useState(false);
  const [pending, setPending] = useState<"send" | "log" | null>(null);
  const [used, setUsed] = useState<UsedTemplate | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedName, setSavedName] = useState<string | null>(null);
  const field = useRef<"subject" | "body">("body");
  const subjectRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const target: Recipient = recipient ?? {
    id: contactId ?? "none",
    firstName: null,
    lastName: null,
    name: "",
    email,
    company: null,
  };

  function insert(token: string) {
    if (field.current === "subject")
      insertToken(subjectRef.current, subject, token, setSubject);
    else insertToken(bodyRef.current, message, token, setMessage);
  }

  function clearNotices() {
    setError(null);
    setWarning(null);
    setSent(false);
    setLogged(false);
    setSavedName(null);
  }

  function applyTemplate(template: EmailTemplate) {
    clearNotices();
    const rendered = renderTemplate(template, target);
    setSubject(rendered.subject);
    setMessage(rendered.body);
    setUsed({
      source: { subject: template.subject, body: template.body },
      rendered,
    });
    setSaving(false);
  }

  function reset() {
    setSubject("");
    setMessage("");
    setUsed(null);
    setSaving(false);
  }

  async function send() {
    if (
      !contactId ||
      sending.current ||
      pending ||
      subject.trim() === "" ||
      message.trim() === ""
    )
      return;
    sending.current = true;
    setPending("send");
    setError(null);
    setWarning(null);
    setLogged(false);
    try {
      const result = await sendContactEmailAction(
        contactId,
        personalise(subject, target),
        personalise(message, target),
        files.ids,
      );
      if ("error" in result && result.error) {
        setError(result.error);
        setSent(false);
        return;
      }
      reset();
      files.clear();
      setSent(true);
      setWarning("warning" in result ? (result.warning ?? null) : null);
      router.refresh();
    } finally {
      sending.current = false;
      setPending(null);
    }
  }

  async function logEmail() {
    if (
      !contactId ||
      sending.current ||
      pending ||
      subject.trim() === "" ||
      message.trim() === ""
    )
      return;
    sending.current = true;
    setPending("log");
    setError(null);
    setWarning(null);
    setSent(false);
    try {
      const result = await addActivityAction(
        { contactId, companyId },
        "email",
        personalise(subject, target),
        personalise(message, target),
      );
      if (result.error) {
        setError(result.error);
        setLogged(false);
        return;
      }
      reset();
      setLogged(true);
      router.refresh();
    } finally {
      sending.current = false;
      setPending(null);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      {!contactId ? (
        <p className="caption-style text-subtle">{unavailable}</p>
      ) : (
        <p className="caption-style text-subtle">
          {email ? `Email ${email}` : "Log an email on this contact"}
        </p>
      )}
      {contactId && !email && (
        <p className="caption-style text-subtle">
          Save an email address on this contact before sending.
        </p>
      )}
      {email && !mailboxConnected && (
        <p className="caption-style text-subtle">
          Connect Microsoft in Inbox before sending to {email}. You can still
          log the email here.
        </p>
      )}
      {error && (
        <p role="alert" className="caption-style text-danger">
          {error}
        </p>
      )}
      {sent && !error && warning && (
        <p className="caption-style text-danger" role="alert">
          {warning}
        </p>
      )}
      {sent && !error && !warning && (
        <p className="caption-style text-subtle" role="status">
          Sent from your Microsoft mailbox.
        </p>
      )}
      {logged && !error && (
        <p className="caption-style text-subtle" role="status">
          Email recorded on this contact.
        </p>
      )}
      {savedName && (
        <p className="caption-style text-subtle" role="status">
          Saved “{savedName}” as a template.
        </p>
      )}
      {contactId && (
        <div className="flex flex-wrap items-center gap-1">
          <UseTemplateButton
            onPick={applyTemplate}
            disabled={pending !== null}
          />
          <Button
            variant="ghost"
            size="sm"
            aria-expanded={saving}
            disabled={
              pending !== null ||
              (subject.trim() === "" && message.trim() === "")
            }
            onClick={() => {
              setSavedName(null);
              setSaving((value) => !value);
            }}
          >
            Save as template
          </Button>
        </div>
      )}
      {saving && (
        <SaveTemplateForm
          idPrefix={idPrefix}
          {...unpersonalised({ subject, body: message }, used)}
          onDone={(template) => {
            setSaving(false);
            if (template) setSavedName(template.name);
          }}
        />
      )}
      <label className="sr-only" htmlFor={`email-subject-${idPrefix}`}>
        Subject
      </label>
      <Input
        id={`email-subject-${idPrefix}`}
        ref={subjectRef}
        data-compose-focus=""
        value={subject}
        autoComplete="off"
        onFocus={() => {
          field.current = "subject";
        }}
        onChange={(event) => setSubject(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Enter") return;
          event.preventDefault();
        }}
        placeholder="Subject"
        maxLength={200}
      />
      <label className="sr-only" htmlFor={`email-body-${idPrefix}`}>
        Message
      </label>
      <textarea
        id={`email-body-${idPrefix}`}
        ref={bodyRef}
        value={message}
        autoComplete="off"
        onFocus={() => {
          field.current = "body";
        }}
        onChange={(event) => setMessage(event.target.value)}
        placeholder="Write the message"
        maxLength={8000}
        className="border-line-strong bg-secondary focus-visible:border-ring min-h-24 w-full rounded-lg border px-3 py-2 text-[14px] leading-5 outline-none"
      />
      {contactId && (
        <TokenChips onInsert={insert} text={`${subject}\n${message}`} />
      )}
      <AttachmentList items={files.items} onRemove={files.remove} disabled={pending !== null} />
      <div className="flex flex-wrap gap-2">
        <Button
          variant="primary"
          size="sm"
          type="button"
          disabled={
            pending !== null ||
            files.uploading ||
            !contactId ||
            !email ||
            !mailboxConnected ||
            subject.trim() === "" ||
            message.trim() === ""
          }
          data-shortcut-submit=""
          title="Send (⌘ Enter)"
          onClick={send}
        >
          {pending === "send" ? "Sending…" : files.uploading ? "Uploading…" : "Send email"}
        </Button>
        <Button
          variant="secondary"
          size="sm"
          type="button"
          disabled={
            pending !== null ||
            !contactId ||
            subject.trim() === "" ||
            message.trim() === ""
          }
          onClick={logEmail}
        >
          {pending === "log" ? "Saving…" : "Log email"}
        </Button>
        {contactId && email && mailboxConnected && (
          <AttachButton id={`email-files-${idPrefix}`} onFiles={(picked) => void files.add(picked)} disabled={pending !== null} />
        )}
      </div>
    </div>
  );
}
