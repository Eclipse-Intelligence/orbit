"use client";

import { useState, type FormEvent } from "react";
import Button from "@/components/_ui/button";
import ProposalDocument from "@/components/proposals/proposal-document";
import { KIND_LABELS, longDate } from "@/lib/proposals/model";
import type { PublicDocument, PublicState } from "@/lib/proposals/public";
import { cn } from "@/lib/utils";

const field =
  "bg-card text-foreground placeholder:text-faint h-11 w-full rounded-xl px-3.5 text-[15px] shadow-[0_0_0_1px_var(--input)] outline-none focus-visible:shadow-[0_0_0_2px_var(--ring)]";

const NOTICES: Partial<Record<PublicState, { title: string; body: string }>> = {
  declined: { title: "Declined", body: "This was declined. If that was a mistake, reply to the email you were sent." },
  withdrawn: { title: "Withdrawn", body: "The sender has withdrawn this. Reply to the email you were sent if you have questions." },
  replaced: { title: "There's a newer version", body: "This version was replaced. Use the latest link you were sent." },
  expired: { title: "This has expired", body: "It's past its valid-until date. Ask the sender for a new one." },
};

export default function ProposalPage({ token, initial, preview }: { token: string; initial: PublicDocument; preview: boolean }) {
  const [doc, setDoc] = useState(initial);
  const [name, setName] = useState(initial.content.client.name);
  const [title, setTitle] = useState(initial.content.client.title ?? "");
  const [company, setCompany] = useState(initial.content.client.company);
  const [typed, setTyped] = useState("");
  const [agree, setAgree] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState("");
  const content = doc.content;
  const label = KIND_LABELS[content.kind].toLowerCase();
  const clientSignature = doc.signatures.find((item) => item.role === "client");

  async function post(path: string, body: unknown) {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/p/${token}/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const json = (await response.json().catch(() => ({}))) as PublicDocument & { error?: string };
      if (!response.ok) throw new Error(json.error ?? "That didn't go through. Try again.");
      setDoc(json);
      setDeclining(false);
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : "That didn't go through. Try again.");
    } finally {
      setBusy(false);
    }
  }

  function sign(event: FormEvent) {
    event.preventDefault();
    void post("sign", { name, title, company, signatureText: typed, agree });
  }

  const notice = NOTICES[doc.state];

  return (
    <div className="paper min-h-dvh">
      <header className="bg-background/85 border-border sticky top-0 z-20 border-b backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-[56em] items-center gap-3 px-5 sm:px-8">
          <span aria-hidden className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: content.accent }} />
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-[14.5px] leading-5 font-semibold">{content.title}</span>
            <span className="text-subtle truncate text-[12.5px] leading-4">
              {content.sender.company} for {content.client.company}
            </span>
          </div>
          <Button variant="ghost" size="sm" href={`/api/p/${token}/pdf${doc.state === "completed" && doc.hasExecuted ? "?kind=signed" : ""}`} className="text-foreground hidden sm:inline-flex">
            {doc.state === "completed" ? "Download signed PDF" : "Download PDF"}
          </Button>
          {doc.state === "open" && (
            <Button variant="primary" size="sm" href="#sign" style={{ backgroundColor: content.accent }}>
              Review and sign
            </Button>
          )}
        </div>
      </header>

      {preview && (
        <p role="status" className="bg-[var(--tag-amber-bg)] px-5 py-2 text-center text-[13px] text-[var(--tag-amber-text)]">
          You&apos;re signed in to Orbit, so this visit isn&apos;t counted as a view.
        </p>
      )}

      <main className="mx-auto flex max-w-[56em] flex-col gap-10 px-5 pt-12 pb-28 sm:px-8 sm:pt-16">
        {notice && (
          <div role="status" className="bg-card flex flex-col gap-1 rounded-2xl p-5 shadow-[0_0_0_1px_rgba(0,0,0,0.06)]">
            <span className="text-[16px] font-semibold">{notice.title}</span>
            <span className="doc-body text-soft">{notice.body}</span>
          </div>
        )}
        <ProposalDocument content={content} signatures={doc.signatures}>
          {doc.state === "open" && !declining && (
            <form onSubmit={sign} className="bg-card flex flex-col gap-5 rounded-2xl p-5 shadow-[0_0_0_1px_rgba(0,0,0,0.06)] sm:p-7" aria-labelledby="sign-form-title">
              <div className="flex flex-col gap-1">
                <h3 id="sign-form-title" className="text-[18px] leading-7 font-semibold">
                  Sign this {label}
                </h3>
                <p className="doc-body text-soft">Check your details, type your name as your signature, then select Agree and sign.</p>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <label className="flex flex-col gap-1.5">
                  <span className="text-[14px] font-medium">Full name</span>
                  <input className={field} value={name} onChange={(event) => setName(event.target.value)} autoComplete="name" required maxLength={200} />
                </label>
                <label className="flex flex-col gap-1.5">
                  <span className="text-[14px] font-medium">Job title</span>
                  <input className={field} value={title} onChange={(event) => setTitle(event.target.value)} autoComplete="organization-title" maxLength={200} />
                </label>
                <label className="flex flex-col gap-1.5 sm:col-span-2">
                  <span className="text-[14px] font-medium">Signing for</span>
                  <input className={field} value={company} onChange={(event) => setCompany(event.target.value)} autoComplete="organization" maxLength={200} />
                </label>
              </div>
              <label className="flex flex-col gap-1.5">
                <span className="text-[14px] font-medium">Type your name to sign</span>
                <input
                  className={cn(field, "h-16 font-serif text-[26px] italic")}
                  value={typed}
                  onChange={(event) => setTyped(event.target.value)}
                  placeholder={name}
                  required
                  maxLength={200}
                  aria-describedby="sign-consent"
                />
              </label>
              <label className="flex items-start gap-3">
                <input
                  type="checkbox"
                  checked={agree}
                  onChange={(event) => setAgree(event.target.checked)}
                  className="mt-1 size-[18px] shrink-0 cursor-pointer"
                  style={{ accentColor: content.accent }}
                  required
                />
                <span id="sign-consent" className="text-soft text-[14.5px] leading-6">
                  {content.consent}
                </span>
              </label>
              {error && (
                <p role="alert" className="text-[14px] text-[#c2410c]">
                  {error}
                </p>
              )}
              <div className="flex flex-wrap items-center gap-3">
                <Button type="submit" variant="primary" disabled={busy || !agree || typed.trim().length < 2} className="h-11 px-6 text-[15px]" style={{ backgroundColor: content.accent }}>
                  {busy ? "Signing…" : "Agree and sign"}
                </Button>
                <Button variant="ghost" onClick={() => setDeclining(true)} className="text-subtle">
                  Decline
                </Button>
              </div>
            </form>
          )}
          {doc.state === "open" && declining && (
            <div className="bg-card flex flex-col gap-4 rounded-2xl p-5 shadow-[0_0_0_1px_rgba(0,0,0,0.06)] sm:p-7">
              <label className="flex flex-col gap-1.5">
                <span className="text-[15px] font-semibold">Decline this {label}</span>
                <span className="text-soft text-[14px]">Optional: tell {content.sender.name} why, so they can follow up.</span>
                <textarea
                  className={cn(field, "h-auto min-h-28 py-3")}
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                  maxLength={2000}
                />
              </label>
              {error && (
                <p role="alert" className="text-[14px] text-[#c2410c]">
                  {error}
                </p>
              )}
              <div className="flex flex-wrap gap-3">
                <Button variant="secondary" disabled={busy} onClick={() => void post("decline", { reason })}>
                  {busy ? "Sending…" : "Decline"}
                </Button>
                <Button variant="ghost" onClick={() => setDeclining(false)}>
                  Back to signing
                </Button>
              </div>
            </div>
          )}
          {doc.state === "client_signed" && clientSignature && (
            <p role="status" className="bg-card doc-body rounded-2xl p-5 shadow-[0_0_0_1px_rgba(0,0,0,0.06)]">
              Thank you, {clientSignature.name.split(/\s+/)[0]}. You signed on {longDate(clientSignature.signedAt)}. {content.sender.name} will countersign, and you&apos;ll get an email with the signed copy.
            </p>
          )}
          {doc.state === "completed" && (
            <div role="status" className="bg-card flex flex-col items-start gap-3 rounded-2xl p-5 shadow-[0_0_0_1px_rgba(0,0,0,0.06)]">
              <p className="doc-body">Signed by both sides. Keep a copy for your records.</p>
              {doc.hasExecuted && (
                <Button variant="primary" href={`/api/p/${token}/pdf?kind=signed`} style={{ backgroundColor: content.accent }}>
                  Download signed PDF
                </Button>
              )}
            </div>
          )}
        </ProposalDocument>
        <footer className="text-faint flex flex-wrap justify-between gap-2 border-t border-[var(--border)] pt-6 text-[12.5px]">
          <span>
            {content.sender.company} · Version {doc.versionNumber}
          </span>
          <span className="sm:hidden">
            <a href={`/api/p/${token}/pdf${doc.state === "completed" && doc.hasExecuted ? "?kind=signed" : ""}`} className="underline underline-offset-2">
              Download PDF
            </a>
          </span>
        </footer>
      </main>
    </div>
  );
}
