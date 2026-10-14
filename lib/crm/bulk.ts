import { archiveCompany, unarchiveCompany } from "@/lib/crm/companies";
import { archiveContact, unarchiveContact } from "@/lib/crm/contacts";
import { CrmError } from "@/lib/crm/errors";
import { assertScope, type Scope } from "@/lib/crm/scopes";
import type { Actor } from "@/lib/crm/types";

export const BULK_LIMIT = 100;

export type BulkOutcome = { id: string; ok: true } | { id: string; ok: false; error: string };

export function bulkIds(ids: unknown) {
  if (!Array.isArray(ids) || ids.length === 0) {
    throw new CrmError("invalid_input", "Select at least one record.", 400);
  }
  if (ids.some((id) => typeof id !== "string")) {
    throw new CrmError("invalid_input", "Record ids must be strings.", 400);
  }
  const unique = [...new Set(ids as string[])];
  if (unique.length > BULK_LIMIT) {
    throw new CrmError(
      "invalid_input",
      `Select ${BULK_LIMIT} or fewer records at a time.`,
      400,
    );
  }
  return unique;
}

async function runBulk(
  actor: Actor,
  scope: Scope,
  ids: unknown,
  run: (id: string) => Promise<unknown>,
): Promise<BulkOutcome[]> {
  assertScope(actor.scopes, scope);
  const unique = bulkIds(ids);
  const outcomes: BulkOutcome[] = [];
  for (const id of unique) {
    try {
      await run(id);
      outcomes.push({ id, ok: true });
    } catch (error) {
      if (!(error instanceof CrmError)) throw error;
      outcomes.push({ id, ok: false, error: error.message });
    }
  }
  return outcomes;
}

function web(operation: string) {
  return { provenance: { operation, source: "web" } };
}

export function archiveContacts(actor: Actor, ids: unknown) {
  return runBulk(actor, "contacts:write", ids, (id) =>
    archiveContact(actor, id, web("bulk_archive_contacts")),
  );
}

export function unarchiveContacts(actor: Actor, ids: unknown) {
  return runBulk(actor, "contacts:write", ids, (id) =>
    unarchiveContact(actor, id, web("bulk_unarchive_contacts")),
  );
}

export function archiveCompanies(actor: Actor, ids: unknown) {
  return runBulk(actor, "companies:write", ids, (id) =>
    archiveCompany(actor, id, web("bulk_archive_companies")),
  );
}

export function unarchiveCompanies(actor: Actor, ids: unknown) {
  return runBulk(actor, "companies:write", ids, (id) =>
    unarchiveCompany(actor, id, web("bulk_unarchive_companies")),
  );
}
