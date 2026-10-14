"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getUserActor } from "@/lib/auth/user";
import { companiesCsvRows } from "@/lib/companies";
import {
  archiveCompanies,
  archiveContacts,
  bulkIds,
  unarchiveCompanies,
  unarchiveContacts,
  type BulkOutcome,
} from "@/lib/crm/bulk";
import { getCompaniesByIds } from "@/lib/crm/companies";
import { getContactsByIds, listContactsAtCompanies } from "@/lib/crm/contacts";
import { CrmError } from "@/lib/crm/errors";
import type { Recipient } from "@/lib/crm/personalise";
import { contactsCsvRows } from "@/lib/crm/spreadsheet";
import type { Actor } from "@/lib/crm/types";
import { revalidateRecordPages } from "@/lib/revalidate";

export type BulkActionResult = { results: BulkOutcome[] } | { error: string };

async function requireUser() {
  const user = await getUserActor();
  if (!user) redirect("/login");
  return user;
}

async function bulk(
  run: (actor: Actor, ids: unknown) => Promise<BulkOutcome[]>,
  ids: string[],
): Promise<BulkActionResult> {
  const user = await requireUser();
  try {
    const results = await run(user, ids);
    revalidatePath("/");
    revalidatePath("/contacts");
    revalidateRecordPages();
    return { results };
  } catch (error) {
    return { error: error instanceof CrmError ? error.message : "Something went wrong." };
  }
}

export async function archiveContactsAction(ids: string[]) {
  return bulk(archiveContacts, ids);
}

export async function unarchiveContactsAction(ids: string[]) {
  return bulk(unarchiveContacts, ids);
}

export async function archiveCompaniesAction(ids: string[]) {
  return bulk(archiveCompanies, ids);
}

export async function unarchiveCompaniesAction(ids: string[]) {
  return bulk(unarchiveCompanies, ids);
}

export async function exportSelectedContactsAction(ids: string[]) {
  const user = await requireUser();
  return contactsCsvRows(await getContactsByIds(user, bulkIds(ids)));
}

export async function exportSelectedCompaniesAction(ids: string[]) {
  const user = await requireUser();
  return companiesCsvRows(await getCompaniesByIds(user, bulkIds(ids)));
}

export async function companyRecipientsAction(companyIds: string[]): Promise<Recipient[]> {
  const user = await requireUser();
  const contacts = await listContactsAtCompanies(user, bulkIds(companyIds));
  return contacts.map((contact) => ({
    id: contact.id,
    firstName: contact.firstName,
    lastName: contact.lastName,
    name: contact.name,
    email: contact.email,
    company: contact.companyName,
  }));
}
