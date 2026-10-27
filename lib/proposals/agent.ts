import type { Template } from "@/lib/proposals/catalogue";
import type { DocumentDetail } from "@/lib/proposals/documents";
import { readingTotals } from "@/lib/proposals/model";

export const BLOCKS_GUIDE =
  "Blocks make the client's page: a tab block starts a tab (label, up to 40 characters) and the blocks after it belong to it; cover (title, subtitle, image url), section (heading, body with blank lines between paragraphs, - bullets, **bold**, [text](https://…)), pricing (heading, intro), terms (heading, body, linkLabel, linkUrl), video (heading, url of YouTube, Loom or Vimeo, caption), image (url, caption), documents (heading, intro, items of Knowledge item ids from list_knowledge or search_knowledge), steps (heading, intro, and in templates items of default steps), booking (heading, intro; shows the owner's booking calendar when their booking page is enabled), faq (heading, items of question and answer), quote (quote, name, role), team (heading, people with name, role, email, photo url), embed (heading, url of Figma, Google Docs, Slides or Forms, Miro, Canva, Typeform, Tally, Pitch, Airtable, Gamma or a Notion site, caption). Fields like {{contact.firstName}}, {{company.name}} and {{proposal.title}} are filled in.";

const LINK_FIELDS = ["url", "image", "linkUrl", "photo"];
const MARKDOWN_LINK = /\]\((https?:\/\/[^)\s]+)\)/g;

function collectLinks(value: unknown, links: Set<string>) {
  if (Array.isArray(value)) {
    for (const entry of value) collectLinks(entry, links);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, field] of Object.entries(value)) {
    if (typeof field === "string") {
      if (LINK_FIELDS.includes(key) && field.trim()) links.add(field.trim());
      for (const match of field.matchAll(MARKDOWN_LINK)) links.add(match[1]);
    } else collectLinks(field, links);
  }
}

export function blockLinks(blocks: unknown) {
  const links = new Set<string>();
  collectLinks(blocks, links);
  return [...links];
}

export function proposalForAgent(detail: DocumentDetail) {
  return {
    ...detail,
    preview: undefined,
    settings: { ...detail.settings, logo: detail.settings.logo ? "set" : null },
    signatures: detail.signatures.map((signature) => ({ ...signature, signatureImage: signature.signatureImage ? "drawn" : null })),
    version: detail.version ? { number: detail.version.number, hash: detail.version.hash } : null,
    readingSecondsByTab: readingTotals(detail.events),
    events: detail.events.filter((event) => event.type !== "reading").slice(-40),
  };
}

export function onlyFields<T extends string>(args: Record<string, unknown>, keys: readonly T[]) {
  const picked: Partial<Record<T, unknown>> = {};
  for (const key of keys) if (args[key] !== undefined) picked[key] = args[key];
  return picked;
}

export function templateForAgent(template: Template) {
  return { ...template, settings: { ...template.settings, logo: template.settings.logo ? "set" : null } };
}

export function templateSettings(template: Template, args: { accent?: unknown; validDays?: unknown }) {
  if (args.accent === undefined && args.validDays === undefined) return undefined;
  return { ...template.settings, ...(args.accent !== undefined ? { accent: args.accent } : {}), ...(args.validDays !== undefined ? { validDays: args.validDays } : {}) };
}
