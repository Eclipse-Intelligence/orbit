export const RECORD_LISTS = {
  companies: { label: "Companies", path: "/" },
  contacts: { label: "Contacts", path: "/contacts" },
  opportunities: { label: "Opportunities", path: "/opportunities" },
} as const;

export type RecordListKey = keyof typeof RECORD_LISTS;

const RECORD_PARAMS = ["record", "contact"];

export function companyHref(id: string) {
  return `/companies/${encodeURIComponent(id)}`;
}

export function dealHref(id: string) {
  return `/opportunities/${encodeURIComponent(id)}`;
}

export function contactHref(id: string) {
  return `/contacts/${encodeURIComponent(id)}`;
}

export function opportunityHref(opportunity: { id: string; name: string; companyName?: string | null; pipelineId: string | null; pipelineKind: string | null }) {
  if (opportunity.pipelineKind === "board" && opportunity.pipelineId) {
    return `/boards/${encodeURIComponent(opportunity.pipelineId)}?view=list&q=${encodeURIComponent(opportunity.companyName ?? opportunity.name)}`;
  }
  return dealHref(opportunity.id);
}

export function listQuery(search: string | null | undefined) {
  const params = new URLSearchParams(search ?? "");
  for (const key of RECORD_PARAMS) params.delete(key);
  const query = params.toString();
  return query ? `?${query}` : "";
}

export function listHref(list: RecordListKey, search?: string | null) {
  return `${RECORD_LISTS[list].path}${listQuery(search)}`;
}

export function legacyRecordHref(pathname: string, search: URLSearchParams) {
  const record = pathname === "/" ? search.get("record") : null;
  if (record) return companyHref(record);
  const contact = pathname === "/contacts" ? search.get("contact") : null;
  if (contact) return contactHref(contact);
  return null;
}
