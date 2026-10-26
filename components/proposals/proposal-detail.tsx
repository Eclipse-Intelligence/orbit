"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import Button from "@/components/_ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/_ui/dialog";
import { Input } from "@/components/_ui/input";
import Tag from "@/components/_ui/tag";
import SectionHeader from "@/components/crm/section-header";
import { recordSelectClass } from "@/components/crm/record-form";
import type { Viewer } from "@/components/crm/viewer";
import ProposalDocument from "@/components/proposals/proposal-document";
import { statusTag } from "@/components/proposals/status";
import { BlockEditor } from "@/components/proposals/template-editor";
import {
  changeProposalAction,
  countersignAction,
  proposalOptionsAction,
  saveProposalAction,
  sendProposalAction,
} from "@/app/(crm)/proposals/actions";
import { companyHref, contactHref } from "@/lib/crm/hrefs";
import type { Product } from "@/lib/proposals/catalogue";
import type { DocumentDetail } from "@/lib/proposals/documents";
import { BILLING_LABELS, formatMoney, KIND_LABELS, longDate, totalsOf, type Block, type Currency, type Item } from "@/lib/proposals/model";
import { cn } from "@/lib/utils";
import HoldButton from "@/components/_ui/hold-button";
import ConfirmDialog from "@/components/_ui/confirm-dialog";
import CopyButton from "@/components/_ui/copy-button";
import { inputClass } from "@/components/_ui/field-styles";
import { signatureFont } from "@/components/proposals/signature-font";
import SignaturePad, { type SignatureMode } from "@/components/proposals/signature-pad";

const EVENT_LABELS: Record<string, string> = {
  created: "Created",
  sent: "Sent",
  resent: "Email sent again",
  viewed: "Opened",
  client_signed: "Signed by the client",
  countersigned: "Countersigned",
  completed: "Fully signed",
  declined: "Declined",
  withdrawn: "Withdrawn",
  reopened: "Reopened for changes",
  downloaded: "PDF downloaded",
  downloaded_signed: "Signed PDF downloaded",
};

const textarea =
  "bg-transparent focus-visible:ring-ring/60 w-full rounded-lg px-3 py-2 text-[14px] leading-[1.5] shadow-[0_0_0_1px_var(--input)] outline-none focus-visible:ring-2";

function when(iso: string) {
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Europe/London" }).format(new Date(iso));
}

export default function ProposalDetail({ viewer, initial }: { viewer: Viewer; initial: DocumentDetail }) {
  const router = useRouter();
  const [doc, setDoc] = useState(initial);
  const [title, setTitle] = useState(initial.title);
  const [currency, setCurrency] = useState<Currency>(initial.currency);
  const [validUntil, setValidUntil] = useState(initial.validUntil ?? "");
  const [items, setItems] = useState<Item[]>(initial.items);
  const [blocks, setBlocks] = useState<Block[]>(initial.blocks);
  const [products, setProducts] = useState<Product[]>([]);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmRevise, setConfirmRevise] = useState(false);
  const [message, setMessage] = useState<{ text: string; tone: "status" | "alert" } | null>(null);
  const [sending, setSending] = useState(false);
  const [signing, setSigning] = useState(false);
  const [view, setView] = useState<"details" | "preview">("details");
  const draft = doc.status === "draft";
  const tag = statusTag(doc.status);
  const content = draft || !doc.version ? doc.preview : doc.version.content;

  useEffect(() => {
    if (!draft) return;
    let live = true;
    void proposalOptionsAction(null).then((result) => live && result.data && setProducts(result.data.products));
    return () => {
      live = false;
    };
  }, [draft]);

  function edit<T>(setter: (value: T) => void) {
    return (value: T) => {
      setter(value);
      setDirty(true);
    };
  }

  async function act<T>(name: string, work: () => Promise<{ data?: T; error?: string }>, done?: (data: T) => void) {
    setBusy(name);
    setMessage(null);
    const result = await work();
    setBusy(null);
    if (result.error) {
      setMessage({ text: result.error, tone: "alert" });
      return false;
    }
    if (done && result.data !== undefined) done(result.data);
    router.refresh();
    return true;
  }

  function revise() {
    return act("revise", () => changeProposalAction(doc.id, "revise"), (next) => next && apply(next));
  }

  function apply(next: DocumentDetail) {
    setDoc(next);
    setTitle(next.title);
    setCurrency(next.currency);
    setValidUntil(next.validUntil ?? "");
    setItems(next.items);
    setBlocks(next.blocks);
    setDirty(false);
  }

  async function save() {
    return act("save", () => saveProposalAction(doc.id, { title, currency, validUntil: validUntil || null, items: items.map((item) => ({ ...item })), blocks }), apply);
  }


  const preview = { ...content, title: draft ? title : content.title };
  const unsendable = !dirty && (doc.missing.length > 0 || doc.placeholders.length > 0);

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col">
      <SectionHeader
        title={doc.title}
        viewer={viewer}
        action={
          <div className="flex items-center gap-2">
            <Tag tone={tag.tone}>{tag.label}</Tag>
            {draft && (
              <Button
                variant="primary"
                size="sm"
                disabled={busy !== null || unsendable}
                title={unsendable ? "Fill in the highlighted details before sending" : undefined}
                onClick={async () => {
                  if (dirty && !(await save())) return;
                  setSending(true);
                }}
              >
                Send
              </Button>
            )}
            {doc.canCountersign && (
              <Button variant="primary" size="sm" onClick={() => setSigning(true)}>
                Countersign
              </Button>
            )}
          </div>
        }
      />
      <div className="flex gap-1 px-4 pt-3 lg:hidden" role="group" aria-label="View">
        {(["details", "preview"] as const).map((item) => (
          <Button key={item} variant={view === item ? "secondary" : "ghost"} size="sm" aria-pressed={view === item} onClick={() => setView(item)}>
            {item === "details" ? "Details" : "Preview"}
          </Button>
        ))}
      </div>
      <div className="grid min-h-0 flex-1 lg:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]">
        <div className={cn("border-border min-h-0 overflow-y-auto border-r px-4 py-5 pb-24", view === "preview" && "hidden lg:block")}>
          <div className="flex flex-col gap-6">
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-[13.5px]">
              <dt className="text-subtle">For</dt>
              <dd className="truncate">
                <Link href={contactHref(doc.contactId)} className="hover:underline">
                  {doc.contactName}
                </Link>
                <span className="text-subtle"> at </span>
                <Link href={companyHref(doc.companyId)} className="hover:underline">
                  {doc.companyName}
                </Link>
              </dd>
              <dt className="text-subtle">Type</dt>
              <dd>
                {KIND_LABELS[doc.kind]}
                {doc.templateName ? <span className="text-subtle">, from {doc.templateName}</span> : null}
              </dd>
              {doc.totalLabel && (
                <>
                  <dt className="text-subtle">Value</dt>
                  <dd>{doc.totalLabel}</dd>
                </>
              )}
              {doc.sentAt && (
                <>
                  <dt className="text-subtle">Sent</dt>
                  <dd>
                    {when(doc.sentAt)}
                    {doc.version ? <span className="text-subtle">, version {doc.version.number}</span> : null}
                  </dd>
                </>
              )}
              {doc.viewCount > 0 && doc.lastViewedAt && (
                <>
                  <dt className="text-subtle">Opened</dt>
                  <dd>
                    {doc.viewCount} {doc.viewCount === 1 ? "time" : "times"}, last {when(doc.lastViewedAt)}
                  </dd>
                </>
              )}
              {doc.declineReason && (
                <>
                  <dt className="text-subtle">Reason</dt>
                  <dd>{doc.declineReason}</dd>
                </>
              )}
            </dl>

            {message && (
              <p role={message.tone} className={cn("caption-style", message.tone === "alert" ? "text-danger" : "text-subtle")}>
                {message.text}
              </p>
            )}

            {!draft && (
              <div className="flex flex-wrap gap-2">
                {doc.link && (doc.status === "sent" || doc.status === "viewed" || doc.status === "expired" || doc.status === "client_signed") && (
                  <CopyButton text={doc.link} label="Copy link" copiedLabel="Link copied" />
                )}
                {(doc.status === "sent" || doc.status === "viewed") && (
                  <Button variant="secondary" size="sm" disabled={busy !== null} onClick={() => setSending(true)}>
                    Email again
                  </Button>
                )}
                {doc.files.executed && (
                  <Button variant="secondary" size="sm" href={`/api/proposals/${doc.id}/pdf?kind=signed`}>
                    Signed PDF
                  </Button>
                )}
                {doc.files.issued && (
                  <Button variant="ghost" size="sm" href={`/api/proposals/${doc.id}/pdf`}>
                    PDF
                  </Button>
                )}
                {doc.link && (
                  <Button variant="ghost" size="sm" href={doc.link.replace(/^https?:\/\/[^/]+/, "")}>
                    Open client page
                  </Button>
                )}
                {(doc.status === "sent" || doc.status === "viewed" || doc.status === "expired" || doc.status === "declined" || doc.status === "withdrawn") && (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy !== null}
                    onClick={() => {
                      if (doc.status !== "declined" && doc.status !== "withdrawn") setConfirmRevise(true);
                      else void revise();
                    }}
                  >
                    Make changes
                  </Button>
                )}
                {(doc.status === "sent" || doc.status === "viewed" || doc.status === "expired" || doc.status === "client_signed") && (
                  <HoldButton
                    disabled={busy !== null}
                    onConfirm={() => void act("withdraw", () => changeProposalAction(doc.id, "withdraw"), (next) => next && apply(next))}
                  >
                    Hold to withdraw
                  </HoldButton>
                )}
              </div>
            )}

            {draft && (
              <div className="flex flex-col gap-5">
                <div className="flex flex-col gap-1.5">
                  <label htmlFor="proposal-title" className="caption-style text-subtle">
                    Title
                  </label>
                  <Input id="proposal-title" value={title} maxLength={200} onChange={(event) => edit(setTitle)(event.target.value)} />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  {doc.kind === "proposal" && (
                    <div className="flex flex-col gap-1.5">
                      <label htmlFor="proposal-currency" className="caption-style text-subtle">
                        Currency
                      </label>
                      <select id="proposal-currency" value={currency} onChange={(event) => edit(setCurrency)(event.target.value as Currency)} className={recordSelectClass}>
                        <option value="GBP">Pounds (£)</option>
                        <option value="USD">Dollars ($)</option>
                      </select>
                    </div>
                  )}
                  <div className="flex flex-col gap-1.5">
                    <label htmlFor="proposal-valid" className="caption-style text-subtle">
                      Valid until
                    </label>
                    <Input id="proposal-valid" type="date" value={validUntil} onChange={(event) => edit(setValidUntil)(event.target.value)} />
                  </div>
                </div>

                {doc.kind === "proposal" && (
                  <Items
                    items={items}
                    currency={currency}
                    products={products}
                    onChange={edit(setItems)}
                  />
                )}

                {doc.missing.length > 0 && (
                  <p role="status" className="caption-style text-[var(--tag-amber-text)]">
                    Missing before you can send: {doc.missing.map((item) => `{{${item}}}`).join(", ")}. Add the details to the company or contact, or edit the text.
                  </p>
                )}
                {doc.placeholders.length > 0 && (
                  <p role="status" className="caption-style text-[var(--tag-amber-text)]">
                    Replace before you can send: {doc.placeholders.join(", ")}.
                  </p>
                )}

                <div className="flex flex-col gap-2">
                  <h2>Wording</h2>
                  <p className="caption-style text-subtle">Changes here only affect this proposal, not the template.</p>
                  <BlockEditor blocks={blocks} onChange={edit(setBlocks)} kind={doc.kind} />
                </div>

                <div className="flex flex-wrap gap-2">
                  <Button variant="secondary" disabled={!dirty || busy !== null} onClick={() => void save()}>
                    {busy === "save" ? "Saving…" : dirty ? "Save changes" : "Saved"}
                  </Button>
                  <HoldButton
                    disabled={busy !== null}
                    onConfirm={() => void act("delete", () => changeProposalAction(doc.id, "archive"), () => router.push("/proposals"))}
                  >
                    Hold to delete draft
                  </HoldButton>
                </div>
              </div>
            )}

            <section aria-labelledby="timeline-heading" className="flex flex-col gap-3">
              <h2 id="timeline-heading">Timeline</h2>
              <ol className="flex flex-col gap-2.5">
                {[...doc.events].reverse().map((event) => (
                  <li key={event.id} className="flex gap-3 text-[13px] leading-5">
                    <span aria-hidden className="bg-faint mt-2 size-1.5 shrink-0 rounded-full" />
                    <span className="flex min-w-0 flex-col">
                      <span>
                        {EVENT_LABELS[event.type] ?? event.type}
                        {event.name ? <span className="text-subtle">, {event.name}</span> : null}
                      </span>
                      <span className="caption-style text-subtle">
                        {when(event.at)}
                        {event.ip ? `, IP ${event.ip}` : ""}
                      </span>
                    </span>
                  </li>
                ))}
              </ol>
            </section>
          </div>
        </div>
        <div className={cn("min-h-0 overflow-y-auto", view === "details" && "hidden lg:block")}>
          <div className="paper min-h-full px-5 pt-10 pb-28 sm:px-10">
            <div className="mx-auto max-w-[44em]">
              <p className="caption-style text-subtle pb-6">
                {draft ? "Preview with this client's details" : `What ${doc.contactName.split(/\s+/)[0]} sees, version ${doc.version?.number ?? 1}`}
              </p>
              <ProposalDocument
                content={draft ? { ...preview, items, currency, totals: totalsOf(items) } : preview}
                signatures={doc.signatures.map((signature) => ({ role: signature.role, name: signature.name, title: signature.title, signatureText: signature.signatureText, signatureImage: signature.signatureImage, signedAt: signature.signedAt }))}
                compact
              />
            </div>
          </div>
        </div>
      </div>
      <ConfirmDialog
        open={confirmRevise}
        onOpenChange={setConfirmRevise}
        title="Make changes to this proposal?"
        description="The link you sent stops working until you send the new version."
        confirmLabel="Make changes"
        tone="neutral"
        onConfirm={() => void revise()}
      />
      <SendDialog open={sending} onOpenChange={setSending} doc={doc} onSent={(next, text) => {
        apply(next);
        setMessage({ text, tone: "status" });
      }} />
      <CountersignDialog open={signing} onOpenChange={setSigning} doc={doc} viewer={viewer} onSigned={(next) => {
        apply(next);
        setMessage({ text: "Countersigned. It's fully signed, and the client has been emailed the signed copy.", tone: "status" });
      }} />
    </section>
  );
}

function Items({ items, currency, products, onChange }: { items: Item[]; currency: Currency; products: Product[]; onChange: (items: Item[]) => void }) {
  const [adding, setAdding] = useState("");
  const update = (index: number, patch: Partial<Item>) => onChange(items.map((item, at) => (at === index ? { ...item, ...patch } : item)));
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="caption-style text-subtle pb-1.5">Products and prices</legend>
      {items.length === 0 && <p className="caption-style text-subtle">Add at least one product before sending.</p>}
      <ul className="flex flex-col gap-2">
        {items.map((item, index) => (
          <li key={index} className="border-line-strong flex flex-col gap-2 rounded-xl border p-3">
            <div className="flex items-start gap-2">
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-[14px]">{item.name}</span>
                <span className="caption-style text-subtle">{BILLING_LABELS[item.billing]}</span>
              </span>
              <Button variant="ghost" size="sm" onClick={() => onChange(items.filter((_, at) => at !== index))} aria-label={`Remove ${item.name}`}>
                Remove
              </Button>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <label className="flex flex-col gap-1">
                <span className="caption-style text-subtle">Price ({currency === "GBP" ? "£" : "$"})</span>
                <Input type="number" min={0} step="0.01" value={item.unitPrice} onChange={(event) => update(index, { unitPrice: Math.max(0, Number(event.target.value) || 0) })} />
              </label>
              <label className="flex flex-col gap-1">
                <span className="caption-style text-subtle">Quantity</span>
                <Input type="number" min={1} value={item.quantity} onChange={(event) => update(index, { quantity: Math.max(1, Math.trunc(Number(event.target.value)) || 1) })} />
              </label>
            </div>
            <label className="flex flex-col gap-1">
              <span className="caption-style text-subtle">Description</span>
              <textarea rows={2} value={item.description} onChange={(event) => update(index, { description: event.target.value })} className={textarea} />
            </label>
          </li>
        ))}
      </ul>
      <div className="flex gap-2">
        <select aria-label="Add a product" value={adding} onChange={(event) => setAdding(event.target.value)} className={cn(recordSelectClass, "flex-1")}>
          <option value="">Add a product…</option>
          {products.map((product) => {
            const price = currency === "GBP" ? product.priceGbp : product.priceUsd;
            return (
              <option key={product.id} value={product.id} disabled={price === null}>
                {product.name}
                {price === null ? ` (no ${currency === "GBP" ? "pound" : "dollar"} price)` : `, ${formatMoney(price, currency)}`}
              </option>
            );
          })}
        </select>
        <Button
          variant="secondary"
          disabled={!adding}
          onClick={() => {
            const product = products.find((item) => item.id === adding);
            if (!product) return;
            const price = currency === "GBP" ? product.priceGbp : product.priceUsd;
            onChange([...items, { productId: product.id, name: product.name, description: product.description ?? "", billing: product.billing, unitPrice: price ?? 0, quantity: 1 }]);
            setAdding("");
          }}
        >
          Add
        </Button>
      </div>
    </fieldset>
  );
}

function SendDialog({
  open,
  onOpenChange,
  doc,
  onSent,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  doc: DocumentDetail;
  onSent: (next: DocumentDetail, message: string) => void;
}) {
  const first = doc.contactName.split(/\s+/)[0] || "there";
  const [subject, setSubject] = useState(doc.title);
  const [message, setMessage] = useState(
    `Hi ${first},\n\nHere is ${doc.kind === "nda" ? "the non-disclosure agreement" : "our proposal"} for ${doc.companyName}. You can read it, download a PDF and sign it online.`,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send(email: boolean) {
    setBusy(true);
    setError(null);
    const result = await sendProposalAction(doc.id, { subject, message, email });
    setBusy(false);
    if (!result.data) {
      setError(result.error ?? "It didn't send.");
      return;
    }
    if (!email) await navigator.clipboard.writeText(result.data.url).catch(() => undefined);
    onOpenChange(false);
    onSent(
      result.data.detail,
      result.data.warning ?? (email ? `Sent to ${doc.contactEmail}. You'll be notified when they open and sign it.` : "Ready to share. The link is copied."),
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[540px]">
        <DialogHeader>
          <DialogTitle>{doc.status === "draft" ? `Send ${KIND_LABELS[doc.kind].toLowerCase()}` : "Email it again"}</DialogTitle>
          <DialogDescription>
            {doc.status === "draft"
              ? "Sending locks this version: later changes need a new version. The email comes from your mailbox with a private link."
              : "Sends the same link again."}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4 px-6 py-5">
          <p className="text-[13.5px]">
            <span className="text-subtle">To </span>
            {doc.contactName} {doc.contactEmail ? <span className="text-subtle">({doc.contactEmail})</span> : <span className="text-danger">(no email address)</span>}
          </p>
          <label className="flex flex-col gap-1.5">
            <span className="caption-style text-subtle">Subject</span>
            <Input value={subject} maxLength={300} onChange={(event) => setSubject(event.target.value)} />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="caption-style text-subtle">Message (the link is added below it)</span>
            <textarea rows={5} value={message} onChange={(event) => setMessage(event.target.value)} className={textarea} />
          </label>
          {error && (
            <p role="alert" className="caption-style text-danger">
              {error}
            </p>
          )}
        </div>
        <DialogFooter>
          {doc.status === "draft" && (
            <Button variant="ghost" disabled={busy} onClick={() => void send(false)} className="mr-auto">
              Copy link only
            </Button>
          )}
          <Button variant="primary" disabled={busy || !doc.contactEmail} onClick={() => void send(true)}>
            {busy ? "Sending…" : "Send email"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CountersignDialog({
  open,
  onOpenChange,
  doc,
  viewer,
  onSigned,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  doc: DocumentDetail;
  viewer: Viewer;
  onSigned: (next: DocumentDetail) => void;
}) {
  const [typed, setTyped] = useState("");
  const [mode, setMode] = useState<SignatureMode>("type");
  const [image, setImage] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [agree, setAgree] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const client = doc.signatures.find((item) => item.role === "client");

  async function sign() {
    setBusy(true);
    setError(null);
    const drawn = mode === "draw" ? image : null;
    const result = await countersignAction(doc.id, { signatureText: drawn ? viewer.name : typed, title, signatureImage: drawn });
    setBusy(false);
    if (!result.data) {
      setError(result.error ?? "It didn't sign.");
      return;
    }
    onOpenChange(false);
    onSigned(result.data);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[520px]">
        <DialogHeader>
          <DialogTitle>Countersign</DialogTitle>
          <DialogDescription>
            {client ? `${client.name} signed on ${longDate(client.signedAt)}. ` : ""}Signing completes it for {doc.version?.content.sender.company ?? viewer.workspaceName}.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4 px-6 py-5">
          <label className="flex flex-col gap-1.5">
            <span className="caption-style text-subtle">Your job title</span>
            <Input value={title} maxLength={200} onChange={(event) => setTitle(event.target.value)} placeholder="Founder" />
          </label>
          <SignaturePad
            mode={mode}
            onMode={setMode}
            typed={typed}
            onTyped={setTyped}
            placeholder={viewer.name}
            onImage={setImage}
            fontClass={signatureFont.className}
            fieldClass={inputClass}
          />
          <label className="caption-style text-soft flex items-start gap-2.5 rounded-xl bg-white/[0.03] p-3 leading-[1.5]">
            <input type="checkbox" checked={agree} onChange={(event) => setAgree(event.target.checked)} className="mt-0.5 size-4 shrink-0" />
            <span>
              I agree to sign this electronically for {doc.version?.content.sender.company ?? viewer.workspaceName}. My electronic signature has the same effect as a handwritten
              signature.
            </span>
          </label>
          {error && (
            <p role="alert" className="caption-style text-danger">
              {error}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="primary" disabled={busy || !agree || (mode === "draw" ? !image : typed.trim().length < 2)} onClick={() => void sign()}>
            {busy ? "Signing…" : "Countersign"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
