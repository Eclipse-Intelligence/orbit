export type QuickAddKind = "task" | "contact" | "company" | "opportunity" | "email";

export const QUICK_ADD_ITEMS: { kind: QuickAddKind; label: string; key: string }[] = [
  { kind: "task", label: "Add task", key: "t" },
  { kind: "contact", label: "Add contact", key: "c" },
  { kind: "company", label: "Add company", key: "o" },
  { kind: "opportunity", label: "Add opportunity", key: "p" },
  { kind: "email", label: "Send email", key: "m" },
];

export const QUICK_ADD_KEY = "q";

export type QuickAddRef = { id: string; name: string };

export type QuickAddRecord =
  | { type: "contact"; id: string; name: string; company: QuickAddRef | null }
  | { type: "company"; id: string; name: string };

export type QuickAddPrefill = { contact: QuickAddRef | null; company: QuickAddRef | null };

const EMPTY: QuickAddPrefill = { contact: null, company: null };

const RECORD_ROUTE = /^\/(contacts|companies)\/([^/]+)\/?$/;

export function recordRoute(pathname: string | null | undefined) {
  const match = RECORD_ROUTE.exec(pathname ?? "");
  if (!match) return null;
  let id: string;
  try {
    id = decodeURIComponent(match[2]);
  } catch {
    return null;
  }
  return { type: match[1] === "contacts" ? ("contact" as const) : ("company" as const), id };
}

export function quickAddPrefill(
  pathname: string | null | undefined,
  record: QuickAddRecord | null,
  kind: QuickAddKind,
): QuickAddPrefill {
  const route = recordRoute(pathname);
  if (!route || !record || record.type !== route.type || record.id !== route.id) return EMPTY;
  if (record.type === "company") {
    if (kind === "company") return EMPTY;
    return { contact: null, company: { id: record.id, name: record.name } };
  }
  if (kind === "task" || kind === "opportunity" || kind === "email") {
    return { contact: { id: record.id, name: record.name }, company: record.company };
  }
  return EMPTY;
}

export function quickAddKindForKey(key: string): QuickAddKind | null {
  const wanted = key.toLowerCase();
  return QUICK_ADD_ITEMS.find((item) => item.key === wanted)?.kind ?? null;
}

type TargetLike = { tagName?: unknown; isContentEditable?: unknown } | null | undefined;

export function isTypingTarget(target: unknown) {
  if (!target || typeof target !== "object") return false;
  const element = target as TargetLike;
  if (element?.isContentEditable === true) return true;
  return (
    typeof element?.tagName === "string" && /^(INPUT|TEXTAREA|SELECT)$/i.test(element.tagName)
  );
}

export type ShortcutEvent = {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey?: boolean;
  repeat?: boolean;
  defaultPrevented?: boolean;
  isComposing?: boolean;
  target: unknown;
};

export function opensQuickAdd(event: ShortcutEvent) {
  if (event.defaultPrevented || event.repeat || event.isComposing) return false;
  if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return false;
  if (event.key.toLowerCase() !== QUICK_ADD_KEY) return false;
  return !isTypingTarget(event.target);
}
