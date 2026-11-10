import type { MailDraft } from "@/lib/mail/view";

const KEY = "orbit.mail.held-drafts";

export type HeldDraft = { key: string; draft: MailDraft & { replaces?: string | null }; fromEmail: string | null; at: number };

function readAll(): HeldDraft[] {
  if (typeof window === "undefined") return [];
  try {
    const parsed = JSON.parse(window.sessionStorage.getItem(KEY) ?? "[]") as unknown;
    return Array.isArray(parsed) ? (parsed as HeldDraft[]).filter((item) => item && typeof item.key === "string" && item.draft) : [];
  } catch {
    return [];
  }
}

function writeAll(items: HeldDraft[]) {
  try {
    if (items.length === 0) window.sessionStorage.removeItem(KEY);
    else window.sessionStorage.setItem(KEY, JSON.stringify(items));
  } catch {}
}

export function heldDrafts() {
  return readAll();
}

export function holdDraft(item: HeldDraft) {
  writeAll([...readAll().filter((existing) => existing.key !== item.key), item]);
}

export function releaseDraft(key: string | null) {
  if (!key) return;
  const items = readAll();
  if (items.some((item) => item.key === key)) writeAll(items.filter((item) => item.key !== key));
}
