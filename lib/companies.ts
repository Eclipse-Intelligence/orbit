import { DEFAULT_COMPANY_SORT, defaultCompanyOrder } from "@/lib/sorting";
import { CrmError } from "@/lib/crm/errors";
import { LIFECYCLES, type AccountHealth, type BuiltInLifecycle, type CompanyListQuery, type CompanySort, type Lifecycle } from "@/lib/crm/types";
import { appTimeZone } from "@/lib/time";

export const ANY_LIFECYCLE = "any";
export const ALL_OWNERS = "all";
export const UNASSIGNED_OWNER = "unassigned";

const LIFECYCLE_LABELS: Record<BuiltInLifecycle, string> = {
  lead: "Lead",
  prospect: "Prospect",
  customer: "Customer",
  churned: "Churned",
};

export const ANY_HEALTH = "any";

export const HEALTH_LABELS: Record<AccountHealth, string> = {
  healthy: "Healthy",
  watch: "Watch",
  at_risk: "At risk",
};

export const HEALTH_OPTIONS = [
  { value: ANY_HEALTH, label: "Any health" },
  { value: "at_risk", label: "At risk" },
  { value: "watch", label: "Watch" },
  { value: "healthy", label: "Healthy" },
  { value: "none", label: "Not set" },
];

export const SIZE_OPTIONS = ["1-10", "11-50", "51-200", "201-1000", "1000+"];

export const SORT_OPTIONS: { value: string; label: string; sort: CompanySort; order: "asc" | "desc" }[] = [
  { value: "name:asc", label: "Name A to Z", sort: "name", order: "asc" },
  { value: "name:desc", label: "Name Z to A", sort: "name", order: "desc" },
  { value: "interaction:desc", label: "Last interaction", sort: "interaction", order: "desc" },
  { value: "strength:asc", label: "Longest since contact", sort: "strength", order: "asc" },
  { value: "updated:desc", label: "Recently updated", sort: "updated", order: "desc" },
  { value: "created:desc", label: "Newest", sort: "created", order: "desc" },
  { value: "domain:asc", label: "Domain", sort: "domain", order: "asc" },
  { value: "owner:asc", label: "Owner", sort: "owner", order: "asc" },
];

export function sortValue(sort: CompanySort = DEFAULT_COMPANY_SORT, order?: "asc" | "desc") {
  const wanted = order ?? defaultCompanyOrder(sort);
  const match = SORT_OPTIONS.find((option) => option.sort === sort && option.order === wanted);
  return match?.value ?? `${sort}:${wanted}`;
}

export function activeFilterCount(filters: CompanyListQuery) {
  const sort = filters.sort ?? DEFAULT_COMPANY_SORT;
  const defaultSort = sort === DEFAULT_COMPANY_SORT && (filters.order ?? defaultCompanyOrder(sort)) === defaultCompanyOrder(sort);
  return (
    [Boolean(filters.query), Boolean(filters.lifecycle), Boolean(filters.health), Boolean(filters.ownerId), Boolean(filters.tag), !defaultSort].filter(Boolean).length +
    (filters.has?.length ?? 0) +
    (filters.missing?.length ?? 0)
  );
}

export function displayInitials(name: string) {
  const parts = name.trim().split(/\s+/).slice(0, 2);
  const letters = parts.map((part) => part[0]?.toUpperCase() ?? "").join("");
  return letters || "?";
}

export function formatDate(iso: string) {
  return new Intl.DateTimeFormat("en-GB", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: appTimeZone(),
  }).format(new Date(iso));
}

export function relativeWhen(iso: string | null | undefined, now = Date.now()) {
  if (!iso) return "No contact";
  const days = (now - new Date(iso).getTime()) / 86_400_000;
  if (!Number.isFinite(days)) return "No contact";
  if (days < 0) return "Upcoming";
  if (days < 1) return "Today";
  if (days < 2) return "Yesterday";
  if (days < 14) return `${Math.floor(days)} days ago`;
  if (days < 45) {
    const weeks = Math.max(1, Math.round(days / 7));
    return weeks === 1 ? "1 week ago" : `${weeks} weeks ago`;
  }
  if (days < 365) {
    const months = Math.max(1, Math.round(days / 30));
    return months === 1 ? "about 1 month ago" : `${months} months ago`;
  }
  const years = Math.max(1, Math.round(days / 365));
  return years === 1 ? "about 1 year ago" : `${years} years ago`;
}

export function formatWhen(iso: string | null) {
  if (!iso) return "No date";
  return new Intl.DateTimeFormat("en-GB", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: appTimeZone(),
  }).format(new Date(iso));
}

export function formatMeetingWhen(iso: string, allDay = false) {
  return new Intl.DateTimeFormat(
    "en-GB",
    allDay
      ? { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }
      : {
          weekday: "short",
          day: "numeric",
          month: "short",
          hour: "2-digit",
          minute: "2-digit",
          hourCycle: "h23",
          timeZone: appTimeZone(),
        },
  ).format(new Date(iso));
}

export function formatMoney(value: string | null, currency: string) {
  if (!value) return "No amount";
  const amount = Number(value);
  if (!Number.isFinite(amount)) return value;
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(amount);
  } catch {
    return `${currency} ${value}`;
  }
}

export function companiesCsvRows(
  companies: {
    name: string;
    domain: string | null;
    website: string | null;
    industry: string | null;
    sizeCategory: string | null;
    lifecycle: string;
    ownerName: string | null;
    source: string | null;
    description: string | null;
    tags: string[];
    createdAt: string;
    updatedAt: string;
  }[],
) {
  return [
    [
      "Company",
      "Domain",
      "Website",
      "Industry",
      "Size",
      "Lifecycle",
      "Owner",
      "Source",
      "Description",
      "Tags",
      "Created",
      "Updated",
    ],
    ...companies.map((company) => [
      company.name,
      company.domain ?? "",
      company.website ?? "",
      company.industry ?? "",
      company.sizeCategory ?? "",
      lifecycleLabel(company.lifecycle),
      company.ownerName ?? "",
      company.source ?? "",
      company.description ?? "",
      company.tags.join("; "),
      company.createdAt,
      company.updatedAt,
    ]),
  ];
}

export function actionError(error: unknown) {
  if (error instanceof CrmError) {
    return {
      error: error.message,
      field: typeof error.details?.field === "string" ? error.details.field : undefined,
      existingId:
        typeof error.details?.existingId === "string" ? error.details.existingId : undefined,
    };
  }
  return { error: "Something went wrong." };
}

export const LIFECYCLE_MAX_LENGTH = 40;

export function lifecycleLabel(value: Lifecycle) {
  return LIFECYCLE_LABELS[value as BuiltInLifecycle] ?? value;
}

export function builtInLifecycle(value: string): BuiltInLifecycle | null {
  const lower = value.trim().toLowerCase();
  return LIFECYCLES.find((key) => key === lower || LIFECYCLE_LABELS[key].toLowerCase() === lower) ?? null;
}

export function cleanLifecycle(value: string) {
  const text = value.replace(/\s+/g, " ").trim().slice(0, LIFECYCLE_MAX_LENGTH);
  if (!text) return null;
  return builtInLifecycle(text) ?? text;
}
