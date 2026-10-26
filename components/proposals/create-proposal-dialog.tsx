"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Button from "@/components/_ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/_ui/dialog";
import { Input } from "@/components/_ui/input";
import { recordSelectClass } from "@/components/crm/record-form";
import { searchCompaniesAction } from "@/app/(crm)/actions";
import { createProposalAction, proposalOptionsAction } from "@/app/(crm)/proposals/actions";
import type { Product, Template } from "@/lib/proposals/catalogue";
import { BILLING_LABELS, formatMoney, KIND_LABELS, totalLabel, totalsOf, type Currency } from "@/lib/proposals/model";
import { cn } from "@/lib/utils";

type ContactOption = { id: string; name: string; email: string | null; jobTitle: string | null };

export default function CreateProposalDialog({
  open,
  onOpenChange,
  company,
  contactId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  company?: { id: string; name: string } | null;
  contactId?: string | null;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[600px]">{open && <CreateForm company={company ?? null} contactId={contactId ?? null} onClose={() => onOpenChange(false)} />}</DialogContent>
    </Dialog>
  );
}

function CreateForm({ company: preset, contactId, onClose }: { company: { id: string; name: string } | null; contactId: string | null; onClose: () => void }) {
  const router = useRouter();
  const [company, setCompany] = useState(preset);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<{ id: string; name: string }[]>([]);
  const [templates, setTemplates] = useState<Template[] | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [contacts, setContacts] = useState<ContactOption[]>([]);
  const [contact, setContact] = useState(contactId ?? "");
  const [templateId, setTemplateId] = useState("");
  const [currency, setCurrency] = useState<Currency>("GBP");
  const [chosen, setChosen] = useState<Record<string, number>>({});
  const [title, setTitle] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    void proposalOptionsAction(company?.id ?? null).then((result) => {
      if (!live) return;
      if (result.error || !result.data) {
        setError(result.error ?? "Couldn't load templates.");
        return;
      }
      setTemplates(result.data.templates);
      setProducts(result.data.products);
      setContacts(result.data.contacts);
      setTemplateId((current) => current || result.data!.templates[0]?.id || "");
      setContact((current) => (current && result.data!.contacts.some((item) => item.id === current) ? current : (result.data!.contacts[0]?.id ?? "")));
    });
    return () => {
      live = false;
    };
  }, [company?.id]);

  useEffect(() => {
    const text = query.trim();
    if (company || text.length < 2) return;
    let live = true;
    const timer = window.setTimeout(() => {
      void searchCompaniesAction(text).then((rows) => live && setResults(rows.map((row) => ({ id: row.id, name: row.name }))));
    }, 200);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [query, company]);

  const template = templates?.find((item) => item.id === templateId) ?? null;
  const priceOf = (product: Product) => (currency === "GBP" ? product.priceGbp : product.priceUsd);
  const items = products
    .filter((product) => chosen[product.id])
    .map((product) => ({ productId: product.id, name: product.name, description: "", billing: product.billing, unitPrice: priceOf(product) ?? 0, quantity: chosen[product.id] }));
  const total = totalLabel(totalsOf(items), currency);

  async function create() {
    if (!company || !contact || !template) return;
    setBusy(true);
    setError(null);
    const result = await createProposalAction({
      templateId: template.id,
      companyId: company.id,
      contactId: contact,
      currency,
      items: items.map((item) => ({ productId: item.productId, quantity: item.quantity })),
      title: title.trim() || undefined,
    });
    if (!result.data) {
      setBusy(false);
      setError(result.error ?? "Couldn't create it.");
      return;
    }
    onClose();
    router.push(`/proposals/${result.data}`);
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>Create proposal</DialogTitle>
        <DialogDescription>Choose who it&apos;s for, a template and what you&apos;re offering. You can edit the wording before sending.</DialogDescription>
      </DialogHeader>
      <div className="flex max-h-[65dvh] flex-col gap-5 overflow-y-auto px-6 py-5">
        {company ? (
          <div className="flex items-center justify-between gap-3">
            <span className="flex flex-col">
              <span className="caption-style text-subtle">Company</span>
              <span className="text-[14px]">{company.name}</span>
            </span>
            {!preset && (
              <Button variant="ghost" size="sm" onClick={() => setCompany(null)}>
                Change
              </Button>
            )}
          </div>
        ) : (
          <div className="flex flex-col gap-1.5">
            <label htmlFor="proposal-company" className="caption-style text-subtle">
              Company
            </label>
            <Input id="proposal-company" value={query} placeholder="Search companies" onChange={(event) => setQuery(event.target.value)} autoFocus />
            {results.length > 0 && (
              <ul className="border-border flex flex-col rounded-lg border">
                {results.slice(0, 6).map((row) => (
                  <li key={row.id}>
                    <button type="button" onClick={() => setCompany(row)} className="w-full cursor-pointer px-3 py-2 text-left text-[14px] hover:bg-white/5">
                      {row.name}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {company && (
          <div className="flex flex-col gap-1.5">
            <label htmlFor="proposal-contact" className="caption-style text-subtle">
              Person
            </label>
            {contacts.length === 0 ? (
              <p className="caption-style text-subtle">{templates ? `Add a contact at ${company.name} first. A proposal goes to a person.` : "Loading…"}</p>
            ) : (
              <select id="proposal-contact" value={contact} onChange={(event) => setContact(event.target.value)} className={recordSelectClass}>
                {contacts.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                    {item.jobTitle ? `, ${item.jobTitle}` : ""}
                    {item.email ? "" : " (no email)"}
                  </option>
                ))}
              </select>
            )}
          </div>
        )}

        <fieldset className="flex flex-col gap-2">
          <legend className="caption-style text-subtle pb-1.5">Template</legend>
          {templates && templates.length === 0 && <p className="caption-style text-subtle">No active templates yet. Make one active under Proposals › Templates.</p>}
          <div className="grid gap-2 sm:grid-cols-2">
            {(templates ?? []).map((item) => (
              <label
                key={item.id}
                className={cn(
                  "border-line-strong has-[:focus-visible]:ring-ring/60 flex cursor-pointer items-center gap-2.5 rounded-xl border px-3 py-2.5 text-[14px] has-[:focus-visible]:ring-2",
                  templateId === item.id && "border-primary bg-[var(--tag-purple-bg)]",
                )}
              >
                <input type="radio" name="proposal-template" className="sr-only" checked={templateId === item.id} onChange={() => setTemplateId(item.id)} />
                <span className="min-w-0 flex-1 truncate">{item.name}</span>
                {!item.name.toLowerCase().includes(KIND_LABELS[item.kind].toLowerCase()) && (
                  <span className="caption-style text-subtle">{KIND_LABELS[item.kind]}</span>
                )}
              </label>
            ))}
          </div>
        </fieldset>

        {template?.kind === "proposal" && (
          <fieldset className="flex flex-col gap-2">
            <div className="flex items-center justify-between gap-3">
              <legend className="caption-style text-subtle">What you&apos;re offering</legend>
              <select aria-label="Currency" value={currency} onChange={(event) => setCurrency(event.target.value as Currency)} className={cn(recordSelectClass, "h-8 w-auto")}>
                <option value="GBP">Pounds (£)</option>
                <option value="USD">Dollars ($)</option>
              </select>
            </div>
            {products.length === 0 && <p className="caption-style text-subtle">No products yet. Add them under Proposals › Products, or add lines after creating it.</p>}
            <ul className="border-border flex flex-col rounded-xl border">
              {products.map((product) => {
                const price = priceOf(product);
                const on = Boolean(chosen[product.id]);
                return (
                  <li key={product.id} className="border-border flex items-center gap-3 border-b px-3 py-2.5 last:border-b-0">
                    <label className={cn("flex min-w-0 flex-1 cursor-pointer items-center gap-3", price === null && "cursor-not-allowed opacity-50")}>
                      <input
                        type="checkbox"
                        disabled={price === null}
                        checked={on}
                        onChange={(event) => setChosen((current) => ({ ...current, [product.id]: event.target.checked ? 1 : 0 }))}
                        className="size-4"
                      />
                      <span className="flex min-w-0 flex-col">
                        <span className="truncate text-[14px]">{product.name}</span>
                        <span className="caption-style text-subtle">
                          {price === null ? `No ${currency === "GBP" ? "pound" : "dollar"} price` : `${formatMoney(price, currency)} ${BILLING_LABELS[product.billing].toLowerCase()}`}
                        </span>
                      </span>
                    </label>
                    {on && (
                      <Input
                        aria-label={`Quantity of ${product.name}`}
                        type="number"
                        min={1}
                        value={chosen[product.id]}
                        onChange={(event) => setChosen((current) => ({ ...current, [product.id]: Math.max(1, Number(event.target.value) || 1) }))}
                        className="w-20"
                      />
                    )}
                  </li>
                );
              })}
            </ul>
            {total && <p className="caption-style text-subtle">Total: {total}</p>}
          </fieldset>
        )}

        <div className="flex flex-col gap-1.5">
          <label htmlFor="proposal-title" className="caption-style text-subtle">
            Title (optional)
          </label>
          <Input
            id="proposal-title"
            value={title}
            maxLength={200}
            placeholder={template?.kind === "nda" ? `NDA with ${company?.name ?? "the company"}` : `Proposal for ${company?.name ?? "the company"}`}
            onChange={(event) => setTitle(event.target.value)}
          />
        </div>
        {error && (
          <p role="alert" className="caption-style text-danger">
            {error}
          </p>
        )}
      </div>
      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="primary" disabled={busy || !company || !contact || !template} onClick={() => void create()}>
          {busy ? "Creating…" : "Create"}
        </Button>
      </DialogFooter>
    </>
  );
}
