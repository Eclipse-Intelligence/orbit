"use server";

import { getUserActor } from "@/lib/auth/user";
import { listCompanies } from "@/lib/crm/companies";
import { findContactsToLink, listContacts } from "@/lib/crm/contacts";
import { searchMentions, type MentionOption } from "@/lib/crm/mention-search";
import { listOpportunities } from "@/lib/crm/opportunities";

export async function searchMentionsAction(query: string): Promise<MentionOption[]> {
  const user = await getUserActor();
  if (!user) return [];
  return searchMentions(user, query);
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
