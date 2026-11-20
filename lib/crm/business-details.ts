import { withActor } from "@/lib/crm/context";
import { CrmError, isPgError, tooLong } from "@/lib/crm/errors";
import { recordAudit } from "@/lib/crm/mutate";
import type { Actor, Provenance, UserActor } from "@/lib/crm/types";
import type { Db } from "@/lib/db/pool";
import { normaliseWebsite } from "@/lib/personal-context-rules";
import { BUSINESS_LIMITS, EMPTY_BUSINESS, type BusinessDetails } from "@/lib/proposals/model";

type BusinessRow = {
  business_name: string;
  business_address: string;
  business_phone: string;
  business_email: string;
  business_website: string;
};

const FORBIDDEN = "Only owners and admins can change the business details.";

const LABELS: Record<keyof BusinessDetails, string> = {
  name: "Business name",
  address: "Address",
  phone: "Phone",
  email: "Email",
  website: "Website",
};

export async function readBusinessDetailsInDb(db: Db, workspaceId: string): Promise<BusinessDetails> {
  const result = await db.query<BusinessRow>(
    "select business_name, business_address, business_phone, business_email, business_website from crm.workspace_brands where workspace_id = $1",
    [workspaceId],
  );
  const row = result.rows[0];
  if (!row) return { ...EMPTY_BUSINESS };
  return {
    name: row.business_name,
    address: row.business_address,
    phone: row.business_phone,
    email: row.business_email,
    website: row.business_website,
  };
}

export async function getBusinessDetails(actor: Actor): Promise<BusinessDetails> {
  return withActor(actor, (db) => readBusinessDetailsInDb(db, actor.workspaceId));
}

function field(input: Record<string, unknown>, key: keyof BusinessDetails) {
  const value = input[key];
  if (value !== undefined && value !== null && typeof value !== "string") {
    throw new CrmError("invalid_input", `${LABELS[key]} must be text.`, 400, {
      field: key,
    });
  }
  const raw = (value ?? "").replace(/\r\n?/g, "\n");
  const cleaned =
    key === "address"
      ? raw
          .split("\n")
          .map((line) => line.replace(/[^\S\n]+/g, " ").trim())
          .filter(Boolean)
          .join("\n")
      : raw.replace(/\s+/g, " ").trim();
  if (cleaned.length > BUSINESS_LIMITS[key]) {
    throw new CrmError("invalid_input", tooLong(`the ${LABELS[key].toLowerCase()}`, BUSINESS_LIMITS[key]), 400, { field: key });
  }
  return cleaned;
}

export function cleanBusinessDetails(raw: unknown): BusinessDetails {
  if (!raw || typeof raw !== "object") throw new CrmError("invalid_input", "Send the business details.", 400);
  const input = raw as Record<string, unknown>;
  const email = field(input, "email");
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new CrmError("invalid_input", "Enter an email address, such as hello@example.com.", 400, { field: "email" });
  }
  const website = field(input, "website");
  const checked = normaliseWebsite(website);
  if (!checked.ok) throw new CrmError("invalid_input", "Enter a website, such as example.com.", 400, { field: "website" });
  const url = checked.url ?? "";
  if (url.length > BUSINESS_LIMITS.website) throw new CrmError("invalid_input", tooLong("the website", BUSINESS_LIMITS.website), 400, { field: "website" });
  return {
    name: field(input, "name"),
    address: field(input, "address"),
    phone: field(input, "phone"),
    email,
    website: url,
  };
}

export async function saveBusinessDetails(actor: UserActor, raw: unknown, provenance: Provenance): Promise<BusinessDetails> {
  if (actor.role !== "owner" && actor.role !== "admin") throw new CrmError("forbidden", FORBIDDEN, 403);
  const next = cleanBusinessDetails(raw);
  return withActor(actor, async (db) => {
    const before = await readBusinessDetailsInDb(db, actor.workspaceId);
    await db
      .query(
        `insert into crm.workspace_brands (workspace_id, business_name, business_address, business_phone, business_email, business_website, updated_by)
         values ($1, $2, $3, $4, $5, $6, $7)
         on conflict (workspace_id) do update set business_name = excluded.business_name, business_address = excluded.business_address,
           business_phone = excluded.business_phone, business_email = excluded.business_email, business_website = excluded.business_website, updated_by = excluded.updated_by`,
        [actor.workspaceId, next.name, next.address, next.phone, next.email, next.website, actor.userId],
      )
      .catch((error: unknown) => {
        if (isPgError(error) && error.code === "42501") throw new CrmError("forbidden", FORBIDDEN, 403);
        throw error;
      });
    await recordAudit(db, actor, "workspace_brand.business_updated", "workspace_brand", actor.workspaceId, provenance, { before, after: next });
    return readBusinessDetailsInDb(db, actor.workspaceId);
  });
}
