import type { CompanySort, ContactSort } from "@/lib/crm/types";

export type SortOrder = "asc" | "desc";

export const DEFAULT_COMPANY_SORT: CompanySort = "name";
export const DEFAULT_CONTACT_SORT: ContactSort = "name";

export function defaultCompanyOrder(sort: CompanySort): SortOrder {
  return sort === "name" || sort === "domain" || sort === "owner" ? "asc" : "desc";
}

export function defaultContactOrder(sort: ContactSort): SortOrder {
  return sort === "name" || sort === "company" ? "asc" : "desc";
}

export function nextSort<T extends string>(
  column: T,
  current: { sort: T; order: SortOrder },
  defaults: { sort: T; order: (sort: T) => SortOrder },
) {
  const order = current.sort === column ? (current.order === "asc" ? "desc" : "asc") : defaults.order(column);
  return {
    sort: column === defaults.sort ? null : column,
    order: order === defaults.order(column) ? null : order,
  };
}
