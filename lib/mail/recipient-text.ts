import type { MailAddress } from "@/lib/mail/types";

const EMAIL = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;

export type SettledRecipients = { ok: true; value: MailAddress[]; added: MailAddress[] } | { ok: false };

export function parseAddress(text: string): MailAddress | null {
  const value = text.trim().replace(/[,;]$/, "").trim();
  const angled = value.match(/^(.*)<([^>]+)>$/);
  const address = (angled ? angled[2] : value).trim().toLowerCase();
  if (!EMAIL.test(address)) return null;
  const name = angled ? angled[1].trim().replace(/^"|"$/g, "") : "";
  return { address, name: name || null };
}

export function settleRecipients(text: string, value: MailAddress[]): SettledRecipients {
  const parts = text
    .split(/[,;\n]+/)
    .flatMap((part) => ((part.match(/@/g)?.length ?? 0) > 1 ? part.split(/\s+/) : [part]))
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length === 0) return { ok: true, value, added: [] };
  const parsed = parts.map(parseAddress);
  if (parsed.some((item) => !item)) return { ok: false };
  const next = [...value];
  const added: MailAddress[] = [];
  for (const item of parsed as MailAddress[]) {
    if (next.some((entry) => entry.address === item.address)) continue;
    next.push(item);
    added.push(item);
  }
  return { ok: true, value: next, added };
}

export function recipientsError(label: string) {
  return `Check the address in ${label}.`;
}
