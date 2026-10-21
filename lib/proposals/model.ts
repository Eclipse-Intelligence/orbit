import { z } from "zod";

export const DOCUMENT_KINDS = ["proposal", "nda"] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];
export const KIND_LABELS: Record<DocumentKind, string> = { proposal: "Proposal", nda: "NDA" };

export const TEMPLATE_STATUSES = ["draft", "active", "archived"] as const;
export type TemplateStatus = (typeof TEMPLATE_STATUSES)[number];

export type DocumentStatus = "draft" | "sent" | "viewed" | "client_signed" | "completed" | "declined" | "withdrawn";
export const STATUS_LABELS: Record<DocumentStatus | "expired", string> = {
  draft: "Draft",
  sent: "Sent",
  viewed: "Viewed",
  client_signed: "Signed by client",
  completed: "Signed",
  declined: "Declined",
  withdrawn: "Withdrawn",
  expired: "Expired",
};

export const CURRENCIES = ["GBP", "USD"] as const;
export type Currency = (typeof CURRENCIES)[number];

export const BILLINGS = ["one_off", "monthly", "yearly"] as const;
export type Billing = (typeof BILLINGS)[number];
export const BILLING_LABELS: Record<Billing, string> = { one_off: "One-off", monthly: "Monthly", yearly: "Yearly" };

const text = (max: number) => z.string().max(max).default("");

const blockSchema = z.discriminatedUnion("type", [
  z.object({ id: z.string().min(1).max(40), type: z.literal("cover"), title: text(300), subtitle: text(1000) }),
  z.object({ id: z.string().min(1).max(40), type: z.literal("section"), heading: text(300), body: text(40000) }),
  z.object({ id: z.string().min(1).max(40), type: z.literal("pricing"), heading: text(300), intro: text(4000) }),
  z.object({
    id: z.string().min(1).max(40),
    type: z.literal("terms"),
    heading: text(300),
    body: text(40000),
    linkLabel: text(200),
    linkUrl: text(1000),
  }),
]);
export type Block = z.infer<typeof blockSchema>;
export type BlockType = Block["type"];
export const BLOCK_LABELS: Record<BlockType, string> = { cover: "Cover", section: "Section", pricing: "Pricing table", terms: "Terms" };

export const blocksSchema = z.array(blockSchema).max(60);

export const settingsSchema = z.object({
  accent: z.string().regex(/^#[0-9a-fA-F]{6}$/).default("#4124fb"),
  validDays: z.coerce.number().int().min(1).max(365).default(30),
});
export type TemplateSettings = z.infer<typeof settingsSchema>;

export type Item = {
  productId: string | null;
  name: string;
  description: string;
  billing: Billing;
  unitPrice: number;
  quantity: number;
};

export type Totals = Record<Billing, number>;

type Party = { name: string; email: string; title: string | null; company: string };

type RenderedBlock = Block;

export type Content = {
  kind: DocumentKind;
  title: string;
  currency: Currency;
  validUntil: string | null;
  accent: string;
  client: Party;
  sender: Party;
  blocks: RenderedBlock[];
  items: Item[];
  totals: Totals;
  consent: string;
  issuedAt: string;
};

type FieldContext = {
  company: { name: string; domain: string | null; website: string | null };
  contact: { name: string; firstName: string | null; lastName: string | null; jobTitle: string | null; email: string | null };
  sender: { name: string; email: string };
  workspace: { name: string };
  proposal: { title: string; currency: Currency; validUntil: string | null; items: Item[] };
};

export const FIELD_OPTIONS: { path: string; label: string }[] = [
  { path: "company.name", label: "Company name" },
  { path: "company.domain", label: "Company domain" },
  { path: "contact.name", label: "Contact name" },
  { path: "contact.firstName", label: "Contact first name" },
  { path: "contact.jobTitle", label: "Contact job title" },
  { path: "contact.email", label: "Contact email" },
  { path: "sender.name", label: "Your name" },
  { path: "sender.email", label: "Your email" },
  { path: "workspace.name", label: "Your company" },
  { path: "proposal.title", label: "Title" },
  { path: "proposal.total", label: "Total" },
  { path: "proposal.validUntil", label: "Valid until" },
  { path: "today", label: "Today's date" },
];

const TOKEN = /\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g;
const PLACEHOLDER = /\[([^\]\n]{2,160})\](?!\()/g;

export function formatMoney(amount: number, currency: Currency) {
  return new Intl.NumberFormat("en-GB", { style: "currency", currency, minimumFractionDigits: amount % 1 === 0 ? 0 : 2 }).format(amount);
}

export function longDate(value: string | Date | null) {
  if (!value) return "";
  const date = typeof value === "string" ? new Date(value.length === 10 ? `${value}T12:00:00Z` : value) : value;
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "Europe/London" }).format(date);
}

export function totalsOf(items: Item[]): Totals {
  const totals: Totals = { one_off: 0, monthly: 0, yearly: 0 };
  for (const item of items) totals[item.billing] = Math.round((totals[item.billing] + item.unitPrice * item.quantity) * 100) / 100;
  return totals;
}

export function totalLabel(totals: Totals, currency: Currency) {
  const parts = [
    totals.one_off ? `${formatMoney(totals.one_off, currency)} one-off` : "",
    totals.monthly ? `${formatMoney(totals.monthly, currency)} a month` : "",
    totals.yearly ? `${formatMoney(totals.yearly, currency)} a year` : "",
  ].filter(Boolean);
  if (parts.length === 0) return "";
  return parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}

export function fieldValues(context: FieldContext): Record<string, string> {
  const totals = totalsOf(context.proposal.items);
  return {
    "company.name": context.company.name,
    "company.domain": context.company.domain ?? "",
    "company.website": context.company.website ?? "",
    "contact.name": context.contact.name,
    "contact.firstName": context.contact.firstName ?? context.contact.name.split(/\s+/)[0] ?? "",
    "contact.lastName": context.contact.lastName ?? "",
    "contact.jobTitle": context.contact.jobTitle ?? "",
    "contact.email": context.contact.email ?? "",
    "sender.name": context.sender.name,
    "sender.email": context.sender.email,
    "workspace.name": context.workspace.name,
    "proposal.title": context.proposal.title,
    "proposal.total": totalLabel(totals, context.proposal.currency),
    "proposal.currency": context.proposal.currency,
    "proposal.validUntil": longDate(context.proposal.validUntil),
    today: longDate(new Date()),
  };
}

function fill(template: string, values: Record<string, string>, missing: Set<string>) {
  return template.replace(TOKEN, (_, path: string) => {
    const value = values[path];
    if (value === undefined || value === "") {
      missing.add(path);
      return `[${path}]`;
    }
    return value;
  });
}

export function renderBlocks(blocks: Block[], values: Record<string, string>) {
  const missing = new Set<string>();
  const placeholders = new Set<string>();
  const rendered = blocks.map((block) => {
    const out: Record<string, unknown> = { ...block };
    for (const [key, value] of Object.entries(block)) {
      if (key === "id" || key === "type" || key === "linkUrl" || typeof value !== "string") continue;
      for (const match of value.replace(TOKEN, "").matchAll(PLACEHOLDER)) placeholders.add(`[${match[1]}]`);
      out[key] = fill(value, values, missing);
    }
    return out as RenderedBlock;
  });
  return { blocks: rendered, missing: [...missing], placeholders: [...placeholders] };
}

export function consentText(kind: DocumentKind, sender: string, hasTerms: boolean) {
  const what = kind === "nda" ? "this agreement" : `this proposal${hasTerms ? " and the terms and conditions it includes" : ""}`;
  return `By typing your name and selecting Agree and sign, you agree to ${what} with ${sender}, and you sign it electronically. Your electronic signature has the same effect as a handwritten signature.`;
}

export function newBlockId(existing: string[]) {
  for (let index = 1; index < 1000; index += 1) {
    const id = `b${index}`;
    if (!existing.includes(id)) return id;
  }
  return `b${Date.now()}`;
}

export type Inline = { text: string; bold?: boolean; href?: string };
type Paragraph = { kind: "paragraph" | "bullet" | "subheading"; parts: Inline[] };

export function parseBody(body: string): Paragraph[] {
  const paragraphs: Paragraph[] = [];
  for (const chunk of body.replace(/\r\n/g, "\n").split(/\n{2,}/)) {
    const lines = chunk.split("\n").filter((line) => line.trim() !== "");
    if (lines.length === 0) continue;
    if (lines.every((line) => /^\s*[-*•]\s+/.test(line))) {
      for (const line of lines) paragraphs.push({ kind: "bullet", parts: inline(line.replace(/^\s*[-*•]\s+/, "")) });
    } else if (lines.length === 1 && /^#{1,3}\s+/.test(lines[0])) {
      paragraphs.push({ kind: "subheading", parts: inline(lines[0].replace(/^#{1,3}\s+/, "")) });
    } else {
      paragraphs.push({ kind: "paragraph", parts: inline(lines.join("\n")) });
    }
  }
  return paragraphs;
}

function inline(value: string): Inline[] {
  const parts: Inline[] = [];
  const pattern = /\*\*([^*]+)\*\*|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;
  let last = 0;
  for (const match of value.matchAll(pattern)) {
    if (match.index! > last) parts.push({ text: value.slice(last, match.index) });
    if (match[1]) parts.push({ text: match[1], bold: true });
    else parts.push({ text: match[2], href: match[3] });
    last = match.index! + match[0].length;
  }
  if (last < value.length) parts.push({ text: value.slice(last) });
  return parts;
}

export function safeHref(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" || url.protocol === "mailto:" ? url.toString() : null;
  } catch {
    return null;
  }
}
