"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import Button from "@/components/_ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/_ui/dialog";
import { Input } from "@/components/_ui/input";
import Tag from "@/components/_ui/tag";
import SectionHeader from "@/components/crm/section-header";
import { recordSelectClass } from "@/components/crm/record-form";
import type { Viewer } from "@/components/crm/viewer";
import CreateProposalDialog from "@/components/proposals/create-proposal-dialog";
import { statusTag } from "@/components/proposals/status";
import { createTemplateAction, saveProductAction } from "@/app/(crm)/proposals/actions";
import { relativeWhen } from "@/lib/companies";
import type { Product, Template } from "@/lib/proposals/catalogue";
import type { DocumentSummary } from "@/lib/proposals/documents";
import { BILLING_LABELS, BILLINGS, formatMoney, KIND_LABELS, type Billing } from "@/lib/proposals/model";
import { cn } from "@/lib/utils";

type Tab = "proposals" | "templates" | "products";

const FILTERS = [
  { id: "all", label: "All" },
  { id: "draft", label: "Drafts" },
  { id: "open", label: "Waiting" },
  { id: "completed", label: "Signed" },
  { id: "closed", label: "Declined or expired" },
] as const;

const TEMPLATE_TAGS = { draft: { label: "Draft", tone: "neutral" }, active: { label: "Active", tone: "green" }, archived: { label: "Archived", tone: "neutral" } } as const;

function matches(filter: string, item: DocumentSummary) {
  if (filter === "draft") return item.status === "draft";
  if (filter === "open") return item.status === "sent" || item.status === "viewed" || item.status === "client_signed";
  if (filter === "completed") return item.status === "completed";
  if (filter === "closed") return item.status === "declined" || item.status === "expired" || item.status === "withdrawn";
  return true;
}

function activity(item: DocumentSummary) {
  if (item.status === "completed" && item.completedAt) return `Signed ${relativeWhen(item.completedAt).toLowerCase()}`;
  if (item.lastViewedAt) return `Viewed ${relativeWhen(item.lastViewedAt).toLowerCase()}${item.viewCount > 1 ? `, ${item.viewCount} times` : ""}`;
  if (item.sentAt) return `Sent ${relativeWhen(item.sentAt).toLowerCase()}`;
  return `Edited ${relativeWhen(item.updatedAt).toLowerCase()}`;
}

export default function ProposalsScreen({
  viewer,
  tab,
  documents,
  templates,
  products,
}: {
  viewer: Viewer;
  tab: Tab;
  documents: DocumentSummary[];
  templates: Template[];
  products: Product[];
}) {
  const router = useRouter();
  const [filter, setFilter] = useState<string>("all");
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Product | "new" | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const shown = documents.filter((item) => matches(filter, item));

  async function newTemplate(starter: string) {
    setBusy(starter);
    setError(null);
    const result = await createTemplateAction({ starter });
    setBusy(null);
    if (!result.data) {
      setError(result.error ?? "Couldn't create the template.");
      return;
    }
    router.push(`/proposals/templates/${result.data.id}`);
  }

  const action =
    tab === "proposals" ? (
      <Button variant="primary" size="sm" data-shortcut="add-record" onClick={() => setCreating(true)}>
        New proposal
      </Button>
    ) : tab === "products" ? (
      <Button variant="primary" size="sm" data-shortcut="add-record" onClick={() => setEditing("new")}>
        New product
      </Button>
    ) : (
      <Button variant="primary" size="sm" data-shortcut="add-record" disabled={busy !== null} onClick={() => void newTemplate("proposal")}>
        New template
      </Button>
    );

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col">
      <SectionHeader title="Proposals" viewer={viewer} action={action} />
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="mx-auto flex w-full max-w-[60em] flex-col gap-6 px-4 py-6 pb-24">
          <nav aria-label="Proposal sections" className="flex gap-1">
            {(["proposals", "templates", "products"] as const).map((item) => (
              <Link
                key={item}
                href={item === "proposals" ? "/proposals" : `/proposals?tab=${item}`}
                aria-current={tab === item ? "page" : undefined}
                className={cn(
                  "rounded-full px-3 py-1.5 text-[13.5px] transition-colors duration-150 ease-power3-out",
                  tab === item ? "bg-secondary text-foreground" : "text-subtle hover:text-foreground",
                )}
              >
                {item === "proposals" ? "Proposals" : item === "templates" ? "Templates" : "Products"}
              </Link>
            ))}
          </nav>
          {error && (
            <p role="alert" className="caption-style text-danger">
              {error}
            </p>
          )}

          {tab === "proposals" && (
            <>
              <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filter">
                {FILTERS.map((item) => (
                  <Button key={item.id} variant={filter === item.id ? "secondary" : "ghost"} size="sm" aria-pressed={filter === item.id} onClick={() => setFilter(item.id)}>
                    {item.label}
                  </Button>
                ))}
              </div>
              {shown.length === 0 ? (
                <p className="caption-style text-subtle">
                  {documents.length === 0 ? "No proposals yet. Create one here, or from a company or contact." : "Nothing matches this filter."}
                </p>
              ) : (
                <ul className="border-border flex flex-col rounded-xl border">
                  {shown.map((item) => {
                    const tag = statusTag(item.status);
                    return (
                      <li key={item.id} className="border-border border-b last:border-b-0">
                        <Link href={item.href} className="flex items-center gap-3 px-4 py-3 hover:bg-white/3">
                          <span className="flex min-w-0 flex-1 flex-col gap-1">
                            <span className="truncate text-[14px] leading-5">{item.title}</span>
                            <span className="caption-style text-subtle truncate">
                              {item.companyName} · {item.contactName} · {activity(item)}
                            </span>
                          </span>
                          {item.totalLabel && <span className="text-soft hidden shrink-0 text-[13px] tabular-nums sm:inline">{item.totalLabel}</span>}
                          {item.kind === "nda" && <Tag tone="blue">NDA</Tag>}
                          <Tag tone={tag.tone}>{tag.label}</Tag>
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              )}
            </>
          )}

          {tab === "templates" && (
            <>
              <p className="caption-style text-subtle max-w-[46em] leading-[1.45]">
                Templates are designed once and filled in for each client. Only active templates can be used to create and send. Start from one of these, then edit the wording,
                sections and colour.
              </p>
              <div className="flex flex-wrap gap-2">
                {[
                  ["proposal", "New proposal template"],
                  ["mutual-nda", "New mutual NDA"],
                  ["one-way-nda", "New one-way NDA"],
                ].map(([key, label]) => (
                  <Button key={key} variant="secondary" size="sm" disabled={busy !== null} onClick={() => void newTemplate(key)}>
                    {busy === key ? "Creating…" : label}
                  </Button>
                ))}
              </div>
              {templates.length === 0 ? (
                <p className="caption-style text-subtle">No templates yet.</p>
              ) : (
                <ul className="border-border flex flex-col rounded-xl border">
                  {templates.map((item) => (
                    <li key={item.id} className="border-border border-b last:border-b-0">
                      <Link href={`/proposals/templates/${item.id}`} className="flex items-center gap-3 px-4 py-3 hover:bg-white/3">
                        <span className="flex min-w-0 flex-1 flex-col gap-1">
                          <span className="truncate text-[14px] leading-5">{item.name}</span>
                          <span className="caption-style text-subtle">
                            {KIND_LABELS[item.kind]} · {item.blocks.length} {item.blocks.length === 1 ? "section" : "sections"} · Edited {relativeWhen(item.updatedAt).toLowerCase()}
                          </span>
                        </span>
                        <Tag tone={TEMPLATE_TAGS[item.status].tone}>{TEMPLATE_TAGS[item.status].label}</Tag>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}

          {tab === "products" &&
            (products.length === 0 ? (
              <p className="caption-style text-subtle">No products yet. Add what you sell, such as Agency Pilot, Free Trial or Pro, with prices in pounds and dollars.</p>
            ) : (
              <ul className="border-border flex flex-col rounded-xl border">
                {products.map((item) => (
                  <li key={item.id} className="border-border border-b last:border-b-0">
                    <button type="button" onClick={() => setEditing(item)} className="flex w-full cursor-pointer items-center gap-3 px-4 py-3 text-left hover:bg-white/3">
                      <span className="flex min-w-0 flex-1 flex-col gap-1">
                        <span className="truncate text-[14px] leading-5">{item.name}</span>
                        {item.description && <span className="caption-style text-subtle line-clamp-1">{item.description}</span>}
                      </span>
                      <span className="text-soft shrink-0 text-right text-[13px] tabular-nums">
                        {[item.priceGbp !== null ? formatMoney(item.priceGbp, "GBP") : null, item.priceUsd !== null ? formatMoney(item.priceUsd, "USD") : null]
                          .filter(Boolean)
                          .join(" · ")}
                        <span className="caption-style text-subtle block">{BILLING_LABELS[item.billing]}</span>
                      </span>
                      {item.archived && <Tag tone="neutral">Archived</Tag>}
                    </button>
                  </li>
                ))}
              </ul>
            ))}
        </div>
      </div>
      <CreateProposalDialog open={creating} onOpenChange={setCreating} />
      <Dialog open={editing !== null} onOpenChange={(open) => !open && setEditing(null)}>
        <DialogContent className="max-w-[520px]">
          {editing !== null && (
            <ProductForm
              product={editing === "new" ? null : editing}
              onDone={() => {
                setEditing(null);
                router.refresh();
              }}
            />
          )}
        </DialogContent>
      </Dialog>
    </section>
  );
}

function ProductForm({ product, onDone }: { product: Product | null; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError(null);
    const result = await saveProductAction(product?.id ?? null, {
      name: String(form.get("name") ?? ""),
      description: String(form.get("description") ?? ""),
      priceGbp: String(form.get("priceGbp") ?? ""),
      priceUsd: String(form.get("priceUsd") ?? ""),
      billing: String(form.get("billing") ?? "one_off"),
    });
    setBusy(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    onDone();
  }

  async function archive(archived: boolean) {
    if (!product) return;
    setBusy(true);
    const result = await saveProductAction(product.id, { archived });
    setBusy(false);
    if (result.error) setError(result.error);
    else onDone();
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <DialogHeader>
        <DialogTitle>{product ? "Edit product" : "New product"}</DialogTitle>
        <DialogDescription>Choosing it on a proposal fills in its name, description and price. Changing it later doesn&apos;t change proposals already sent.</DialogDescription>
      </DialogHeader>
      <label className="flex flex-col gap-1.5">
        <span className="caption-style text-subtle">Name</span>
        <Input name="name" defaultValue={product?.name ?? ""} required maxLength={120} autoFocus />
      </label>
      <label className="flex flex-col gap-1.5">
        <span className="caption-style text-subtle">Description</span>
        <textarea
          name="description"
          defaultValue={product?.description ?? ""}
          maxLength={4000}
          rows={3}
          className="bg-transparent focus-visible:ring-ring/60 min-h-20 rounded-lg px-3 py-2 text-[14px] shadow-[0_0_0_1px_var(--input)] outline-none focus-visible:ring-2"
        />
      </label>
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="flex flex-col gap-1.5">
          <span className="caption-style text-subtle">Price in pounds</span>
          <Input name="priceGbp" inputMode="decimal" defaultValue={product?.priceGbp ?? ""} placeholder="£" />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="caption-style text-subtle">Price in dollars</span>
          <Input name="priceUsd" inputMode="decimal" defaultValue={product?.priceUsd ?? ""} placeholder="$" />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="caption-style text-subtle">Billing</span>
          <select name="billing" defaultValue={product?.billing ?? "one_off"} className={recordSelectClass}>
            {BILLINGS.map((billing: Billing) => (
              <option key={billing} value={billing}>
                {BILLING_LABELS[billing]}
              </option>
            ))}
          </select>
        </label>
      </div>
      {error && (
        <p role="alert" className="caption-style text-danger">
          {error}
        </p>
      )}
      <DialogFooter>
        {product && (
          <Button variant="ghost" disabled={busy} onClick={() => void archive(!product.archived)} className="mr-auto">
            {product.archived ? "Restore" : "Archive"}
          </Button>
        )}
        <Button type="submit" variant="primary" disabled={busy}>
          {busy ? "Saving…" : "Save"}
        </Button>
      </DialogFooter>
    </form>
  );
}
