export type Recipient = {
  id: string;
  firstName: string | null;
  lastName: string | null;
  name: string;
  email: string | null;
  company: string | null;
};

export function contactRecipient(contact: {
  id: string;
  firstName: string | null;
  lastName: string | null;
  name: string;
  email: string | null;
  companyName: string | null;
}): Recipient {
  return {
    id: contact.id,
    firstName: contact.firstName,
    lastName: contact.lastName,
    name: contact.name,
    email: contact.email,
    company: contact.companyName,
  };
}

export const PERSONAL_TOKENS = [
  { token: "first_name", label: "First name, or the full name, or “there”" },
  { token: "last_name", label: "Last name" },
  { token: "name", label: "Full name" },
  { token: "company", label: "Company name" },
] as const;

export const BULK_EMAIL_LIMIT = 50;
export const BULK_EMAIL_GAP_MS = 2100;

const TOKEN_PATTERN = /\{\{\s*([a-zA-Z_]+)\s*\}\}/g;

function clean(value: string | null | undefined) {
  return value?.replace(/\s+/g, " ").trim() ?? "";
}

function tokenValues(recipient: Recipient): Record<string, string> {
  const first = clean(recipient.firstName);
  const last = clean(recipient.lastName);
  const full = clean([first, last].filter(Boolean).join(" "));
  return {
    first_name: first || full || "there",
    last_name: last,
    name: full || "there",
    company: clean(recipient.company),
  };
}

export function personalise(template: string, recipient: Recipient) {
  const values = tokenValues(recipient);
  return template.replace(TOKEN_PATTERN, (match, key: string) => {
    const value = values[key.toLowerCase()];
    return value === undefined ? match : value;
  });
}

export function unknownTokens(template: string) {
  const known = new Set<string>(PERSONAL_TOKENS.map((item) => item.token));
  const found = new Set<string>();
  for (const match of template.matchAll(TOKEN_PATTERN)) {
    if (!known.has(match[1].toLowerCase())) found.add(match[0]);
  }
  return [...found];
}

export function splitRecipients(recipients: Recipient[]) {
  const sendable: Recipient[] = [];
  const skipped: { recipient: Recipient; reason: string }[] = [];
  const seen = new Set<string>();
  for (const recipient of recipients) {
    const email = recipient.email?.trim().toLowerCase();
    if (!email) {
      skipped.push({ recipient, reason: "no email address" });
      continue;
    }
    if (seen.has(email)) {
      skipped.push({ recipient, reason: "same email as another recipient" });
      continue;
    }
    seen.add(email);
    sendable.push(recipient);
  }
  return { sendable, skipped };
}

export function stopsRun(error: string) {
  return /connect microsoft|connect it again|sign in to send|throttl|too many requests/i.test(error);
}
