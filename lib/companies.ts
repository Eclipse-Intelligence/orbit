import { CrmError } from "@/lib/crm/errors";
import {
  COMPANY_SORTS,
  LIFECYCLES,
  type CompanyListQuery,
  type CompanySort,
  type Lifecycle,
} from "@/lib/crm/types";

export const ANY_LIFECYCLE = "any";
export const ALL_OWNERS = "all";
export const UNASSIGNED_OWNER = "unassigned";

export const LIFECYCLE_LABELS: Record<Lifecycle, string> = {
  lead: "Lead",
  prospect: "Prospect",
  customer: "Customer",
  churned: "Churned",
};

export const SIZE_OPTIONS = ["1-10", "11-50", "51-200", "201-1000", "1000+"];

export const SORT_OPTIONS: { value: string; label: string; sort: CompanySort; order: "asc" | "desc" }[] = [
  { value: "updated:desc", label: "Recently updated", sort: "updated", order: "desc" },
  { value: "created:desc", label: "Newest", sort: "created", order: "desc" },
  { value: "name:asc", label: "Name", sort: "name", order: "asc" },
  { value: "domain:asc", label: "Domain", sort: "domain", order: "asc" },
];

export function sortValue(sort: CompanySort = "updated", order: "asc" | "desc" = "desc") {
  const match = SORT_OPTIONS.find((option) => option.sort === sort && option.order === order);
  return match?.value ?? "updated:desc";
}

export function parseSortValue(value: string) {
  const match = SORT_OPTIONS.find((option) => option.value === value);
  return { sort: match?.sort ?? "updated", order: match?.order ?? "desc" };
}

export function activeFilterCount(filters: CompanyListQuery) {
  const defaultSort =
    (filters.sort ?? "updated") === "updated" && (filters.order ?? "desc") === "desc";
  return [
    Boolean(filters.query),
    Boolean(filters.lifecycle),
    Boolean(filters.ownerId),
    !defaultSort,
  ].filter(Boolean).length;
}

export function displayInitials(name: string) {
  const parts = name.trim().split(/\s+/).slice(0, 2);
  const letters = parts.map((part) => part[0]?.toUpperCase() ?? "").join("");
  return letters || "?";
}

export function formatDate(iso: string) {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(iso));
}

export function formatWhen(iso: string | null) {
  if (!iso) return "No date";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
  }).format(new Date(iso));
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
      "Created",
      "Updated",
    ],
    ...companies.map((company) => [
      company.name,
      company.domain ?? "",
      company.website ?? "",
      company.industry ?? "",
      company.sizeCategory ?? "",
      company.lifecycle,
      company.ownerName ?? "",
      company.source ?? "",
      company.description ?? "",
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
    };
  }
  return { error: "Something went wrong." };
}

export function isLifecycle(value: string): value is Lifecycle {
  return (LIFECYCLES as readonly string[]).includes(value);
}

export function isCompanySort(value: string): value is CompanySort {
  return (COMPANY_SORTS as readonly string[]).includes(value);
}
