export const RELEVANCE_CATEGORIES = ["business", "supplier", "service", "personal", "collections", "spam", "newsletter"] as const;
export type RelevanceCategory = (typeof RELEVANCE_CATEGORIES)[number];
export type StoredCategory = RelevanceCategory | "muted";
export type SkippedCategory = Exclude<StoredCategory, "business">;
export type RelevanceEngine = "jev" | "haiku" | "headers" | "listed" | "history" | "cached" | "rule" | "filed" | "shown" | "failed";

export const SKIPPED_LABELS: Record<SkippedCategory, string> = {
  supplier: "Supplier",
  service: "Service",
  personal: "Personal",
  collections: "Collections",
  spam: "Spam",
  newsletter: "Newsletter",
  muted: "Never ask",
};

export const SENSITIVE_CATEGORIES: StoredCategory[] = ["personal", "collections"];
