"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Button from "@/components/_ui/button";
import { Input } from "@/components/_ui/input";
import { sendContactEmailAction } from "@/app/(crm)/inbox/actions";
import { addContactActivityAction } from "@/app/(crm)/records";

export default function ContactEmail({
  contactId,
  email,
  mailboxConnected,
}: {
  contactId: string;
  email: string | null;
  mailboxConnected: boolean;
}) {
  const router = useRouter();
  const sending = useRef(false);
  const [subject, setSubject] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [logged, setLogged] = useState(false);
  const [pending, setPending] = useState<"send" | "log" | null>(null);

  async function send() {
    if (
      sending.current ||
      pending ||
      subject.trim() === "" ||
      message.trim() === ""
    )
      return;
    sending.current = true;
    setPending("send");
    setError(null);
    setLogged(false);
    try {
      const result = await sendContactEmailAction(contactId, subject, message);
      if ("error" in result && result.error) {
        setError(result.error);
        setSent(false);
        return;
      }
      setSubject("");
      setMessage("");
      setSent(true);
      router.refresh();
    } finally {
      sending.current = false;
      setPending(null);
    }
  }

  async function logEmail() {
    if (
      sending.current ||
      pending ||
      subject.trim() === "" ||
      message.trim() === ""
    )
      return;
    sending.current = true;
    setPending("log");
    setError(null);
    setSent(false);
    try {
      const result = await addContactActivityAction(
        contactId,
        "email",
        subject,
        message,
      );
      if (result.error) {
        setError(result.error);
        setLogged(false);
        return;
      }
      setSubject("");
      setMessage("");
      setLogged(true);
      router.refresh();
    } finally {
      sending.current = false;
      setPending(null);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <p className="caption-style text-subtle">
        {email ? `Email ${email}` : "Log an email on this contact"}
      </p>
      {!email && (
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
      {sent && !error && (
        <p className="caption-style text-subtle" role="status">
          Sent from your Microsoft mailbox.
        </p>
      )}
      {logged && !error && (
        <p className="caption-style text-subtle" role="status">
          Email recorded on this contact.
        </p>
      )}
      <label className="sr-only" htmlFor={`email-subject-${contactId}`}>
        Subject
      </label>
      <Input
        id={`email-subject-${contactId}`}
        value={subject}
        autoComplete="off"
        onChange={(event) => setSubject(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Enter") return;
          event.preventDefault();
        }}
        placeholder="Subject"
        maxLength={200}
      />
      <label className="sr-only" htmlFor={`email-body-${contactId}`}>
        Message
      </label>
      <textarea
        id={`email-body-${contactId}`}
        value={message}
        autoComplete="off"
        onChange={(event) => setMessage(event.target.value)}
        placeholder="Write the message"
        maxLength={8000}
        className="border-line-strong bg-secondary min-h-24 w-full rounded-lg border px-3 py-2 text-[14px] leading-5 outline-none"
      />
      <div className="flex flex-wrap gap-2">
        <Button
          variant="primary"
          size="sm"
          type="button"
          disabled={
            pending !== null ||
            !email ||
            !mailboxConnected ||
            subject.trim() === "" ||
            message.trim() === ""
          }
          onClick={send}
        >
          {pending === "send" ? "Sending…" : "Send email"}
        </Button>
        <Button
          variant="secondary"
          size="sm"
          type="button"
          disabled={
            pending !== null || subject.trim() === "" || message.trim() === ""
          }
          onClick={logEmail}
        >
          {pending === "log" ? "Saving…" : "Log email"}
        </Button>
      </div>
    </div>
  );
}
