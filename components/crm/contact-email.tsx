"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Button from "@/components/_ui/button";
import { Input } from "@/components/_ui/input";
import { sendContactEmailAction } from "@/app/(crm)/inbox/actions";

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
  const [pending, setPending] = useState(false);

  if (!email) {
    return (
      <p className="caption-style text-subtle">
        Save an email address on this contact before sending.
      </p>
    );
  }

  if (!mailboxConnected) {
    return (
      <p className="caption-style text-subtle">
        Connect Microsoft in Inbox before sending to {email}.
      </p>
    );
  }

  async function send() {
    if (sending.current || subject.trim() === "" || message.trim() === "")
      return;
    sending.current = true;
    setPending(true);
    setError(null);
    try {
      const result = await sendContactEmailAction(contactId, subject, message);
      if (result.error) {
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
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <p className="caption-style text-subtle">Email {email}</p>
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
          void send();
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
      <Button
        variant="primary"
        size="sm"
        type="button"
        className="self-start"
        disabled={pending || subject.trim() === "" || message.trim() === ""}
        onClick={send}
      >
        {pending ? "Sending…" : "Send email"}
      </Button>
    </div>
  );
}
