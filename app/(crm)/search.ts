"use server";

import { getUserActor } from "@/lib/auth/user";
import { listCompanies } from "@/lib/crm/companies";
import { listContacts } from "@/lib/crm/contacts";
import { listOpportunities } from "@/lib/crm/opportunities";

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
