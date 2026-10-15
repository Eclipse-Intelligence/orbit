import { normalizeTag } from "@/lib/crm/normalize";
import { personalise, type Recipient } from "@/lib/crm/personalise";

export const TEMPLATE_NAME_MAX = 120;
export const TEMPLATE_SUBJECT_MAX = 300;
export const TEMPLATE_BODY_MAX = 20000;

export type EmailTemplate = {
  id: string;
  name: string;
  subject: string;
  body: string;
  tags: string[];
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
};

export type EmailTemplateWrite = {
  name?: string;
  subject?: string;
  body?: string;
  tags?: string[];
};

export type TemplateTagCount = { name: string; templates: number };

export type TemplateText = { subject: string; body: string };

export type UsedTemplate = { source: TemplateText; rendered: TemplateText };

export const SAMPLE_RECIPIENT: Recipient = {
  id: "sample",
  firstName: "Alex",
  lastName: "Example",
  name: "Alex Example",
  email: "alex@example.com",
  company: "Example Ltd",
};

export function renderTemplate(
  template: TemplateText,
  recipient: Recipient,
): TemplateText {
  return {
    subject: personalise(template.subject, recipient),
    body: personalise(template.body, recipient),
  };
}

export function unpersonalised(
  current: TemplateText,
  used: UsedTemplate | null,
): TemplateText {
  if (!used) return current;
  return {
    subject:
      current.subject === used.rendered.subject
        ? used.source.subject
        : current.subject,
    body: current.body === used.rendered.body ? used.source.body : current.body,
  };
}

export function matchesTemplate(
  template: Pick<EmailTemplate, "name" | "subject" | "body" | "tags">,
  search: string,
  tag: string | null,
) {
  const wanted = tag ? normalizeTag(tag) : "";
  if (wanted && !template.tags.includes(wanted)) return false;
  const text = search.trim().toLowerCase();
  if (!text) return true;
  return [template.name, template.subject, template.body].some((value) =>
    value.toLowerCase().includes(text),
  );
}

export function templateTagCounts(
  templates: Pick<EmailTemplate, "tags">[],
): TemplateTagCount[] {
  const counts = new Map<string, number>();
  for (const template of templates) {
    for (const tag of template.tags)
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
  return [...counts]
    .map(([name, templates]) => ({ name, templates }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function copyName(name: string, taken: Iterable<string>) {
  const used = new Set([...taken].map((value) => value.toLowerCase()));
  const base = `Copy of ${name}`;
  for (let attempt = 1; ; attempt += 1) {
    const suffix = attempt === 1 ? "" : ` (${attempt})`;
    const candidate = `${base.slice(0, TEMPLATE_NAME_MAX - suffix.length).trimEnd()}${suffix}`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
}

export function plainBody(value: string) {
  return value.replace(/\r\n?/g, "\n");
}
