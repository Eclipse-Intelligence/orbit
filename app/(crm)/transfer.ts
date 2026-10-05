"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getUserActor } from "@/lib/auth/user";
import { companiesCsvRows } from "@/lib/companies";
import { CrmError } from "@/lib/crm/errors";
import { listCompanies } from "@/lib/crm/companies";
import {
  exportActivitiesCsv,
  exportContactsCsv,
  exportOpportunitiesCsv,
  exportTasksCsv,
  importCompaniesCsv,
  importContactsCsv,
  type ImportResult,
} from "@/lib/crm/spreadsheet";

export type TransferResource = "companies" | "contacts" | "opportunities" | "activities" | "tasks";

async function requireUser() {
  const user = await getUserActor();
  if (!user) redirect("/login");
  return user;
}

export async function exportRecordsAction(resource: TransferResource) {
  const user = await requireUser();
  if (resource === "companies") {
    const rows = [];
    let offset = 0;
    let total = 0;
    do {
      const page = await listCompanies(user, { limit: 100, offset, sort: "name", order: "asc" });
      rows.push(...page.data);
      total = page.total;
      offset += page.data.length;
      if (page.data.length === 0) break;
    } while (rows.length < total && offset < 5000);
    return companiesCsvRows(rows);
  }
  if (resource === "contacts") return exportContactsCsv(user);
  if (resource === "opportunities") return exportOpportunitiesCsv(user);
  if (resource === "activities") return exportActivitiesCsv(user);
  return exportTasksCsv(user);
}

export async function importRecordsAction(
  resource: TransferResource,
  csv: string,
): Promise<ImportResult | { error: string }> {
  const user = await requireUser();
  try {
    const result =
      resource === "companies"
        ? await importCompaniesCsv(user, csv)
        : resource === "contacts"
          ? await importContactsCsv(user, csv)
          : null;
    if (!result) return { error: "That import is not available." };
    revalidatePath("/");
    revalidatePath("/contacts");
    return result;
  } catch (error) {
    return { error: error instanceof CrmError ? error.message : "Import failed." };
  }
}
