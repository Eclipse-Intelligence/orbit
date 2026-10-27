import { PROVIDERS, providerKey, type ContactField, type ProviderId } from "@/lib/enrichment/providers";
import { withActor } from "@/lib/crm/context";
import { CrmError } from "@/lib/crm/errors";
import type { Actor, UserActor } from "@/lib/crm/types";

const DEFAULT_EMAIL_ORDER: ProviderId[] = ["context", "hunter", "enrow", "icypeas"];
const DEFAULT_LINKEDIN_ORDER: ProviderId[] = ["context", "icypeas", "hunter"];

export type EnrichmentSettings = {
  emailOrder: ProviderId[];
  linkedinOrder: ProviderId[];
  autoCompanies: boolean;
  webTags: boolean;
  webGaps: boolean;
  webSignals: boolean;
};

export type ProviderStatus = { id: ProviderId; name: string; envKey: string; configured: boolean; fields: ContactField[] };

export type EnrichmentAvailability = { email: boolean; linkedin: boolean; phone: boolean; company: boolean; logoClientId: string | null };

export const PHONE_ORDER: ProviderId[] = ["enrow"];

function cleanOrder(value: unknown, field: ContactField, fallback: ProviderId[]) {
  const supported = PROVIDERS.filter((provider) => provider.fields.includes(field)).map((provider) => provider.id);
  const given = Array.isArray(value) ? value.filter((id): id is ProviderId => supported.includes(id as ProviderId)) : [];
  const unique = [...new Set(given)];
  for (const id of fallback) if (supported.includes(id) && !unique.includes(id)) unique.push(id);
  return unique;
}

export function providerStatuses(env: Record<string, string | undefined> = process.env): ProviderStatus[] {
  return PROVIDERS.map((provider) => ({
    id: provider.id,
    name: provider.name,
    envKey: provider.envKey,
    configured: Boolean(providerKey(provider.id, env)),
    fields: provider.fields,
  }));
}

export function enrichmentAvailability(env: Record<string, string | undefined> = process.env): EnrichmentAvailability {
  const statuses = providerStatuses(env);
  const has = (field: ContactField) => statuses.some((status) => status.configured && status.fields.includes(field));
  return {
    email: has("email"),
    linkedin: has("linkedin"),
    phone: has("phone"),
    company: Boolean(providerKey("context", env)),
    logoClientId: env.NEXT_PUBLIC_CONTEXT_LOGO_CLIENT_ID?.trim() || null,
  };
}

export async function getEnrichmentSettings(actor: Actor): Promise<EnrichmentSettings> {
  const row = await withActor(actor, async (db) => {
    const result = await db.query<{ email_order: string[]; linkedin_order: string[]; auto_companies: boolean; web_tags: boolean; web_gaps: boolean; web_signals: boolean }>(
      "select email_order, linkedin_order, auto_companies, web_tags, web_gaps, web_signals from crm.enrichment_settings where workspace_id = $1",
      [actor.workspaceId],
    );
    return result.rows[0] ?? null;
  });
  return {
    emailOrder: cleanOrder(row?.email_order, "email", DEFAULT_EMAIL_ORDER),
    linkedinOrder: cleanOrder(row?.linkedin_order, "linkedin", DEFAULT_LINKEDIN_ORDER),
    autoCompanies: row?.auto_companies ?? true,
    webTags: row?.web_tags ?? false,
    webGaps: row?.web_gaps ?? false,
    webSignals: row?.web_signals ?? false,
  };
}

export async function saveEnrichmentSettings(actor: UserActor, input: Partial<EnrichmentSettings>) {
  if (actor.role !== "owner" && actor.role !== "admin") {
    throw new CrmError("forbidden", "Only workspace owners and admins can change enrichment settings.", 403);
  }
  const current = await getEnrichmentSettings(actor);
  const next: EnrichmentSettings = {
    emailOrder: input.emailOrder ? cleanOrder(input.emailOrder, "email", current.emailOrder) : current.emailOrder,
    linkedinOrder: input.linkedinOrder ? cleanOrder(input.linkedinOrder, "linkedin", current.linkedinOrder) : current.linkedinOrder,
    autoCompanies: typeof input.autoCompanies === "boolean" ? input.autoCompanies : current.autoCompanies,
    webTags: typeof input.webTags === "boolean" ? input.webTags : current.webTags,
    webGaps: typeof input.webGaps === "boolean" ? input.webGaps : current.webGaps,
    webSignals: typeof input.webSignals === "boolean" ? input.webSignals : current.webSignals,
  };
  await withActor(actor, (db) =>
    db.query(
      `insert into crm.enrichment_settings (workspace_id, email_order, linkedin_order, auto_companies, web_tags, web_gaps, web_signals)
       values ($1, $2, $3, $4, $5, $6, $7)
       on conflict (workspace_id) do update set
         email_order = excluded.email_order, linkedin_order = excluded.linkedin_order, auto_companies = excluded.auto_companies,
         web_tags = excluded.web_tags, web_gaps = excluded.web_gaps, web_signals = excluded.web_signals`,
      [actor.workspaceId, next.emailOrder, next.linkedinOrder, next.autoCompanies, next.webTags, next.webGaps, next.webSignals],
    ),
  );
  return next;
}
