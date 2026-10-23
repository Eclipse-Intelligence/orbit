"use server";

import { getUserActor } from "@/lib/auth/user";
import { listCompanies } from "@/lib/crm/companies";
import { findContactsToLink, listContacts } from "@/lib/crm/contacts";
import { listOpportunities } from "@/lib/crm/opportunities";
import { listTasks } from "@/lib/crm/tasks";
import type { Mention } from "@/lib/mentions";
import { listDocuments } from "@/lib/proposals/documents";
import { KIND_LABELS, STATUS_LABELS } from "@/lib/proposals/model";

export type MentionOption = Mention & { detail: string | null };

export async function searchMentionsAction(query: string): Promise<MentionOption[]> {
  const user = await getUserActor();
  if (!user) return [];
  const text = query.trim().slice(0, 80);
  const [contacts, companies, tasks, opportunities, proposals] = await Promise.all([
    listContacts(user, text ? { query: text, limit: 5 } : { limit: 4, sort: "updated" }),
    listCompanies(user, text ? { query: text, limit: 4, sort: "name", order: "asc" } : { limit: 3, sort: "updated" }),
    text ? listTasks(user, { query: text, view: "all", limit: 3 }) : Promise.resolve({ data: [] }),
    text ? listOpportunities(user, { query: text, limit: 3 }) : Promise.resolve({ data: [] }),
    text ? listDocuments(user, { search: text, limit: 3 }).catch(() => []) : Promise.resolve([]),
  ]);
  const options: MentionOption[] = [
    ...contacts.data.map((contact) => ({
      kind: "contact" as const,
      id: contact.id,
      name: contact.name,
      detail: [contact.jobTitle, contact.companyName].filter(Boolean).join(" at ") || contact.email,
    })),
    ...companies.data.map((company) => ({ kind: "company" as const, id: company.id, name: company.name, detail: company.domain })),
    ...tasks.data.map((task) => ({ kind: "task" as const, id: task.id, name: task.title, detail: task.companyName ?? task.contactName ?? null })),
    ...opportunities.data.map((opportunity) => ({
      kind: "opportunity" as const,
      id: opportunity.id,
      name: opportunity.name,
      detail: opportunity.companyName ?? null,
    })),
    ...proposals.map((proposal) => ({
      kind: "proposal" as const,
      id: proposal.id,
      name: proposal.title,
      detail: [proposal.kind === "nda" ? KIND_LABELS.nda : null, proposal.companyName, STATUS_LABELS[proposal.status]].filter(Boolean).join(" · "),
    })),
  ];
  const lower = text.toLowerCase();
  const rank = (option: MentionOption) => {
    const name = option.name.toLowerCase();
    if (!lower) return 0;
    if (name.startsWith(lower)) return 0;
    if (name.split(/\s+/).some((word) => word.startsWith(lower))) return 1;
    if (name.includes(lower)) return 2;
    return 3;
  };
  return options.map((option, index) => ({ option, index })).sort((a, b) => rank(a.option) - rank(b.option) || a.index - b.index).map(({ option }) => option);
}

export async function searchWorkspaceAction(query: string) {
  const user = await getUserActor();
  if (!user || !query.trim()) return { companies: [], contacts: [], opportunities: [] };
  const [companies, contacts, opportunities] = await Promise.all([
    listCompanies(user, { query, limit: 8, sort: "name", order: "asc" }),
    listContacts(user, { query, limit: 8 }),
    listOpportunities(user, { query, limit: 8 }),
  ]);
  return {
    companies: companies.data,
    contacts: contacts.data,
    opportunities: opportunities.data,
  };
}

export async function searchContactsToLinkAction(companyId: string, query: string) {
  const user = await getUserActor();
  if (!user) return { contacts: [] };
  return { contacts: await findContactsToLink(user, companyId, query, 8) };
}

export async function searchContactsToFileAction(query: string) {
  const user = await getUserActor();
  if (!user) return { contacts: [] };
  return { contacts: await findContactsToLink(user, null, query, 8) };
}

export async function searchCompanyContactsAction(companyId: string, query: string) {
  const user = await getUserActor();
  if (!user) return { contacts: [] };
  const text = query.trim().slice(0, 200);
  const listed = await listContacts(user, { companyId, ...(text ? { query: text } : { sort: "name", order: "asc" }), limit: 20 });
  return { contacts: listed.data };
}
