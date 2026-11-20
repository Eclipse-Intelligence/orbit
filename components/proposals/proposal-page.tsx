"use client";

import { useState, type FormEvent } from "react";
import Button from "@/components/_ui/button";
import ProposalSite, { SIGN_TAB, visibleTabs } from "@/components/proposals/proposal-site";
import { useReadingTime } from "@/components/proposals/use-reading-time";
import { accentText, longDate, senderCompany } from "@/lib/proposals/model";
import type { PublicDocument, PublicState } from "@/lib/proposals/public";
import { cn } from "@/lib/utils";
import SignaturePad, { type SignatureMode } from "@/components/proposals/signature-pad";
import { signatureFont } from "@/components/proposals/signature-font";

const field =
  "bg-card text-foreground placeholder:text-faint h-11 w-full rounded-xl px-3.5 text-[15px] shadow-[0_0_0_1px_var(--input)] outline-none focus-visible:shadow-[0_0_0_2px_var(--ring)]";

const NOTICES: Partial<Record<PublicState, { title: string; body: string }>> = {
  updating: {
    title: "Being updated",
    body: "The sender is making changes. Check back shortly.",
  },
  declined: {
    title: "Declined",
    body: "If that was a mistake, reply to the email you were sent.",
  },
  withdrawn: {
    title: "Withdrawn",
    body: "Reply to the email you were sent if you have questions.",
  },
  replaced: {
    title: "There's a newer version",
    body: "Use the latest link you were sent.",
  },
  expired: { title: "This has expired", body: "Ask the sender for a new one." },
};

export default function ProposalPage({ token, initial, preview, logoDark }: { token: string; initial: PublicDocument; preview: boolean; logoDark?: boolean }) {
  const [doc, setDoc] = useState(initial);
  const [name, setName] = useState(initial.content.client.name);
  const [title, setTitle] = useState(initial.content.client.title ?? "");
  const [company, setCompany] = useState(initial.content.client.company);
  const [typed, setTyped] = useState("");
  const [mode, setMode] = useState<SignatureMode>("type");
  const [image, setImage] = useState<string | null>(null);
  const [agree, setAgree] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [declining, setDeclining] = useState(false);
  const [pendingStep, setPendingStep] = useState<string | null>(null);
  const [stepError, setStepError] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const content = doc.content;
  const tabs = visibleTabs(content, { booking: doc.booking, steps: doc.steps });
  const [active, setActive] = useState(tabs?.[0]?.slug ?? SIGN_TAB);
  const activeLabel = !tabs ? "Proposal" : active === SIGN_TAB ? "Sign" : (tabs.find((tab) => tab.slug === active)?.label ?? tabs[0]?.label ?? "Proposal");
  useReadingTime(token, activeLabel, !preview);
  const label = content.kind === "nda" ? "NDA" : "proposal";
  const signable = doc.state === "open" && !preview;
  const clientSignature = doc.signatures.find((item) => item.role === "client");

  async function post(path: string, body: unknown) {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/p/${token}/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
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

  async function toggleStep(stepId: string, done: boolean) {
    setPendingStep(stepId);
    setStepError(null);
    try {
      const response = await fetch(`/api/p/${token}/steps/${stepId}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ done }),
      });
      const json = (await response.json().catch(() => ({}))) as PublicDocument & { error?: string };
      if (!response.ok) throw new Error(json.error ?? "That didn't save. Try again.");
      setDoc(json);
    } catch (problem) {
      setStepError(problem instanceof Error ? problem.message : "That didn't save. Try again.");
    } finally {
      setPendingStep(null);
    }
  }

  function sign(event: FormEvent) {
    event.preventDefault();
    const drawn = mode === "draw" ? image : null;
    void post("sign", {
      name,
      title,
      company,
      signatureText: drawn ? name : typed,
      signatureImage: drawn ?? undefined,
      agree,
      hash: doc.hash,
    });
  }

  const ready = mode === "draw" ? Boolean(image) && name.trim().length >= 2 : typed.trim().length >= 2;

  const notice = NOTICES[doc.state];

  const pdfHref = `/api/p/${token}/pdf${doc.state === "completed" && doc.hasExecuted ? "?kind=signed" : ""}`;
  const downloadable = doc.state !== "withdrawn" && doc.state !== "replaced";

  return (
    <div className="paper min-h-dvh">
      {preview && (
        <p role="status" className="bg-[var(--tag-amber-bg)] px-5 py-2 text-center text-[13px] text-[var(--tag-amber-text)]">
          Preview. This visit isn&apos;t counted and signing is off.
        </p>
      )}
      <ProposalSite
        page
        content={content}
        signatures={doc.signatures}
        active={active}
        onActive={setActive}
        followHash
        logoDark={logoDark}
        actions={
          downloadable || signable
            ? (select) => (
                <>
                  {downloadable && (
                    <Button variant="ghost" size="sm" href={pdfHref} className="text-soft hover:text-foreground hidden sm:inline-flex">
                      {doc.state === "completed" ? "Download signed PDF" : "Download PDF"}
                    </Button>
                  )}
                  {signable && (
                    <Button
                      variant="primary"
                      size="sm"
                      style={{
                        backgroundColor: content.accent,
                        color: accentText(content.accent),
                      }}
                      onClick={() => select(SIGN_TAB)}
                    >
                      Review and sign
                    </Button>
                  )}
                </>
              )
            : undefined
        }
        lead={
          (stepError || notice) && (
            <>
              {stepError && (
                <p role="alert" className="bg-card rounded-2xl p-4 text-[14px] text-[#c2410c] shadow-[0_0_0_1px_rgba(0,0,0,0.06)]">
                  {stepError}
                </p>
              )}
              {notice && (
                <div role="status" className="bg-card flex flex-col gap-1 rounded-2xl p-5 shadow-[0_0_0_1px_rgba(0,0,0,0.06)]">
                  <span className="text-[16px] font-semibold">{notice.title}</span>
                  <span className="doc-body text-soft">{notice.body}</span>
                </div>
              )}
            </>
          )
        }
        footer={
          <footer className="text-subtle flex flex-wrap justify-between gap-2 border-t border-[var(--border)] pt-6 text-[12.5px]">
            <span>
              {senderCompany(content)} · Version {doc.versionNumber}
            </span>
            {downloadable && (
              <span className="sm:hidden">
                <a href={pdfHref} className="underline underline-offset-2">
                  Download PDF
                </a>
              </span>
            )}
          </footer>
        }
        extras={{
          fileHref: (itemId) => `/api/p/${token}/files/${itemId}`,
          booking: doc.booking,
          bookingDefaults: {
            name: content.client.name,
            email: content.client.email,
          },
          steps: doc.steps,
          onToggleStep: preview || doc.state === "withdrawn" || doc.state === "replaced" ? undefined : (stepId, done) => void toggleStep(stepId, done),
          pendingStep,
        }}
        signLabel={doc.state === "open" ? "Sign" : "Signatures"}
      >
        {signable && !declining && (
          <form onSubmit={sign} className="bg-card flex flex-col gap-5 rounded-2xl p-5 shadow-[0_0_0_1px_rgba(0,0,0,0.06)] sm:p-7" aria-labelledby="sign-form-title">
            <div className="flex flex-col gap-1">
              <h3 id="sign-form-title" className="text-[18px] leading-7 font-semibold">
                Sign this {label}
              </h3>
              <p className="doc-body text-soft">Check your details, type or draw your signature, then select Agree and sign.</p>
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
            <SignaturePad
              mode={mode}
              onMode={setMode}
              typed={typed}
              onTyped={setTyped}
              placeholder={name}
              onImage={setImage}
              fontClass={signatureFont.className}
              fieldClass={field}
              describedBy="sign-consent"
            />
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
              <Button
                type="submit"
                variant="primary"
                disabled={busy || !agree || !ready}
                className="h-11 px-6 text-[15px]"
                style={{
                  backgroundColor: content.accent,
                  color: accentText(content.accent),
                }}
              >
                {busy ? "Signing…" : "Agree and sign"}
              </Button>
              <Button variant="ghost" onClick={() => setDeclining(true)} className="text-subtle">
                Decline
              </Button>
            </div>
          </form>
        )}
        {signable && declining && (
          <div className="bg-card flex flex-col gap-4 rounded-2xl p-5 shadow-[0_0_0_1px_rgba(0,0,0,0.06)] sm:p-7">
            <label className="flex flex-col gap-1.5">
              <span className="text-[15px] font-semibold">Decline this {label}</span>
              <span className="text-soft text-[14px]">Optional: tell {content.sender.name} why.</span>
              <textarea className={cn(field, "h-auto min-h-28 py-3")} value={reason} onChange={(event) => setReason(event.target.value)} maxLength={2000} />
            </label>
            {error && (
              <p role="alert" className="text-[14px] text-[#c2410c]">
                {error}
              </p>
            )}
            <div className="flex flex-wrap gap-3">
              <Button variant="secondary" disabled={busy} onClick={() => void post("decline", { reason, hash: doc.hash })}>
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
            Thank you, {clientSignature.name.split(/\s+/)[0]}. You signed on {longDate(clientSignature.signedAt)}. {content.sender.name} will countersign, and you&apos;ll get an
            email with the signed copy.
          </p>
        )}
        {doc.state === "completed" && (
          <div role="status" className="bg-card flex flex-col items-start gap-3 rounded-2xl p-5 shadow-[0_0_0_1px_rgba(0,0,0,0.06)]">
            <p className="doc-body">Signed by both sides.</p>
            {doc.hasExecuted && (
              <Button
                variant="primary"
                href={`/api/p/${token}/pdf?kind=signed`}
                style={{
                  backgroundColor: content.accent,
                  color: accentText(content.accent),
                }}
              >
                Download signed PDF
              </Button>
            )}
          </div>
        )}
      </ProposalSite>
    </div>
  );
}
