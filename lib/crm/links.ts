import type { Db } from "@/lib/db/pool";
import { CrmError } from "@/lib/crm/errors";

export type LinkRefs = {
  companyId: string | null;
  contactId: string | null;
  opportunityId: string | null;
};

export async function requireCompany(db: Db, workspaceId: string, companyId: string) {
  const result = await db.query<{ id: string; name: string }>(
    "select id, name from crm.companies where id = $1 and workspace_id = $2",
    [companyId, workspaceId],
  );
  const row = result.rows[0];
  if (!row) throw new CrmError("not_found", "Company not found.", 404);
  return row;
}

export async function resolveLinks(
  db: Db,
  workspaceId: string,
  input: {
    companyId?: string | null;
    contactId?: string | null;
    opportunityId?: string | null;
  },
  current?: LinkRefs,
): Promise<LinkRefs> {
  const contactId = input.contactId === undefined ? (current?.contactId ?? null) : input.contactId;
  const opportunityId =
    input.opportunityId === undefined ? (current?.opportunityId ?? null) : input.opportunityId;

  let contactCompany: string | null = null;
  if (contactId) {
    const result = await db.query<{ company_id: string | null }>(
      "select company_id from crm.contacts where id = $1 and workspace_id = $2",
      [contactId, workspaceId],
    );
    if (!result.rows[0]) throw new CrmError("not_found", "Contact not found.", 404);
    contactCompany = result.rows[0].company_id;
  }

  let opportunityCompany: string | null = null;
  if (opportunityId) {
    const result = await db.query<{ company_id: string }>(
      "select company_id from crm.opportunities where id = $1 and workspace_id = $2",
      [opportunityId, workspaceId],
    );
    if (!result.rows[0]) throw new CrmError("not_found", "Opportunity not found.", 404);
    opportunityCompany = result.rows[0].company_id;
  }

  let companyId = input.companyId === undefined ? (current?.companyId ?? null) : input.companyId;
  if (input.companyId === undefined && companyId == null) {
    companyId = contactCompany ?? opportunityCompany;
  }
  if (companyId) await requireCompany(db, workspaceId, companyId);

  if (companyId && contactCompany && companyId !== contactCompany) {
    throw new CrmError(
      "invalid_input",
      "That contact belongs to a different company.",
      400,
      { field: "contactId" },
    );
  }
  if (companyId && opportunityCompany && companyId !== opportunityCompany) {
    throw new CrmError(
      "invalid_input",
      "That opportunity belongs to a different company.",
      400,
      { field: "opportunityId" },
    );
  }

  return { companyId, contactId, opportunityId };
}
