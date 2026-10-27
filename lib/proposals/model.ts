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
  z.object({ id: z.string().min(1).max(40), type: z.literal("cover"), title: text(300), subtitle: text(1000), image: text(1000) }),
  z.object({ id: z.string().min(1).max(40), type: z.literal("tab"), label: text(40) }),
  z.object({ id: z.string().min(1).max(40), type: z.literal("video"), heading: text(300), url: text(1000), caption: text(1000) }),
  z.object({ id: z.string().min(1).max(40), type: z.literal("image"), url: text(1000), caption: text(1000) }),
  z.object({
    id: z.string().min(1).max(40),
    type: z.literal("documents"),
    heading: text(300),
    intro: text(4000),
    items: z
      .array(
        z.object({
          id: z.string().uuid(),
          title: text(300),
          kind: text(40),
          sourceUrl: text(2000),
          fingerprint: text(64),
        }),
      )
      .max(50)
      .default([]),
  }),
  z.object({ id: z.string().min(1).max(40), type: z.literal("booking"), heading: text(300), intro: text(2000) }),
  z.object({
    id: z.string().min(1).max(40),
    type: z.literal("faq"),
    heading: text(300),
    items: z.array(z.object({ question: text(500), answer: text(4000) })).max(40).default([]),
  }),
  z.object({ id: z.string().min(1).max(40), type: z.literal("quote"), quote: text(2000), name: text(200), role: text(200) }),
  z.object({
    id: z.string().min(1).max(40),
    type: z.literal("team"),
    heading: text(300),
    people: z.array(z.object({ name: text(200), role: text(200), email: text(200), photo: text(1000) })).max(20).default([]),
  }),
  z.object({ id: z.string().min(1).max(40), type: z.literal("embed"), heading: text(300), url: text(1000), caption: text(1000) }),
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
export const BLOCK_LABELS: Record<BlockType, string> = {
  cover: "Cover",
  tab: "Tab",
  section: "Section",
  pricing: "Pricing table",
  terms: "Terms",
  video: "Video",
  image: "Image",
  documents: "Documents",
  booking: "Booking",
  faq: "Questions",
  quote: "Quote",
  team: "Team",
  embed: "Embed",
};

export const RAW_KEYS = new Set(["id", "type", "linkUrl", "image", "url", "photo", "sourceUrl", "fingerprint", "kind"]);

export type Tab = { id: string; label: string; slug: string; blocks: Block[] };

function slugOf(label: string, taken: Set<string>) {
  const base =
    label
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "tab";
  let slug = base;
  for (let index = 2; taken.has(slug); index += 1) slug = `${base}-${index}`;
  taken.add(slug);
  return slug;
}

export function shows(block: Block, extras: { booking?: boolean } = {}) {
  switch (block.type) {
    case "tab":
      return false;
    case "video":
      return Boolean(videoSource(block.url));
    case "image":
      return Boolean(safeHref(block.url));
    case "embed":
      return Boolean(embedSource(block.url));
    case "documents":
      return block.items.length > 0;
    case "booking":
      return extras.booking ?? true;
    case "faq":
      return block.items.some((item) => item.question.trim());
    case "quote":
      return Boolean(block.quote.trim());
    case "team":
      return block.people.some((person) => person.name.trim());
    default:
      return true;
  }
}

export function tabsOf(blocks: Block[]): Tab[] | null {
  if (!blocks.some((block) => block.type === "tab")) return null;
  const taken = new Set<string>(["sign"]);
  const tabs: Tab[] = [];
  for (const block of blocks) {
    if (block.type === "tab") {
      const label = block.label.trim() || `Tab ${tabs.length + 1}`;
      tabs.push({ id: block.id, label, slug: slugOf(label, taken), blocks: [] });
      continue;
    }
    if (tabs.length === 0) tabs.push({ id: "start", label: "Overview", slug: slugOf("Overview", taken), blocks: [] });
    tabs[tabs.length - 1].blocks.push(block);
  }
  return tabs;
}

export const blocksSchema = z.array(blockSchema).max(60);

export const LOGO_MAX_LENGTH = 300_000;

export const settingsSchema = z.object({
  accent: z.string().regex(/^#[0-9a-fA-F]{6}$/).default("#4124fb"),
  validDays: z.coerce.number().int().min(1).max(365).default(30),
  logo: z
    .string()
    .max(LOGO_MAX_LENGTH)
    .regex(/^data:image\/png;base64,[A-Za-z0-9+/]+=*$/)
    .nullable()
    .default(null),
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
  logo?: string | null;
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
  return new Intl.NumberFormat(currency === "USD" ? "en-US" : "en-GB", { style: "currency", currency, minimumFractionDigits: amount % 1 === 0 ? 0 : 2 }).format(amount);
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

function fillDeep(value: unknown, key: string, values: Record<string, string>, missing: Set<string>, placeholders: Set<string>): unknown {
  if (RAW_KEYS.has(key)) return value;
  if (typeof value === "string") {
    for (const match of value.replace(TOKEN, "").matchAll(PLACEHOLDER)) placeholders.add(`[${match[1]}]`);
    return fill(value, values, missing);
  }
  if (Array.isArray(value)) return value.map((entry) => fillDeep(entry, "", values, missing, placeholders));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([entryKey, entry]) => [entryKey, fillDeep(entry, entryKey, values, missing, placeholders)]));
  }
  return value;
}

export function renderBlocks(blocks: Block[], values: Record<string, string>) {
  const missing = new Set<string>();
  const placeholders = new Set<string>();
  const rendered = blocks.map((block) => {
    if (block.type !== "documents") return fillDeep(block, "", values, missing, placeholders) as RenderedBlock;
    const { items, ...rest } = block;
    return { ...(fillDeep(rest, "", values, missing, placeholders) as object), items } as RenderedBlock;
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

function youtubeIdOf(url: URL) {
  const host = url.hostname.replace(/^(www|m)\./, "");
  if (host === "youtu.be") return url.pathname.slice(1).split("/")[0];
  if (host !== "youtube.com" && host !== "youtube-nocookie.com") return null;
  if (url.pathname === "/watch") return url.searchParams.get("v");
  return url.pathname.match(/^\/(?:shorts|live|embed)\/([^/?]+)/)?.[1] ?? null;
}

export type Playable = { kind: "frame"; src: string } | { kind: "file"; src: string } | null;

export function videoSource(raw: string): Playable {
  const href = safeHref(raw);
  if (!href || !href.startsWith("https:")) return null;
  const url = new URL(href);
  const host = url.hostname.replace(/^www\./, "");
  const youtube = youtubeIdOf(url);
  if (youtube && /^[\w-]{11}$/.test(youtube)) return { kind: "frame", src: `https://www.youtube-nocookie.com/embed/${youtube}?rel=0` };
  const loom = host === "loom.com" ? url.pathname.match(/^\/(?:share|embed)\/([a-f0-9]{20,40})/)?.[1] : null;
  if (loom) return { kind: "frame", src: `https://www.loom.com/embed/${loom}` };
  const vimeo = host === "vimeo.com" ? url.pathname.match(/^\/(\d+)/)?.[1] : host === "player.vimeo.com" ? url.pathname.match(/^\/video\/(\d+)/)?.[1] : null;
  if (vimeo) return { kind: "frame", src: `https://player.vimeo.com/video/${vimeo}` };
  if (/\.(mp4|webm|mov)$/i.test(url.pathname)) return { kind: "file", src: url.href };
  return null;
}

export function embedSource(raw: string): string | null {
  const href = safeHref(raw);
  if (!href || !href.startsWith("https:")) return null;
  const url = new URL(href);
  const host = url.hostname.replace(/^www\./, "");
  if (host === "figma.com" && !url.pathname.startsWith("/embed")) return `https://www.figma.com/embed?embed_host=orbit&url=${encodeURIComponent(url.href)}`;
  if (host === "docs.google.com" && /\/(edit|view)$/.test(url.pathname)) {
    url.pathname = url.pathname.replace(/\/(edit|view)$/, url.pathname.includes("/presentation/") ? "/embed" : "/preview");
    url.search = "";
    return url.href;
  }
  if (host === "miro.com" && url.pathname.startsWith("/app/board/")) return url.href.replace("/app/board/", "/app/live-embed/");
  if (host === "canva.com" && url.pathname.includes("/view") && !url.searchParams.has("embed")) {
    url.searchParams.set("embed", "");
    return url.href;
  }
  const video = videoSource(href);
  if (video?.kind === "frame") return video.src;
  return url.href;
}
