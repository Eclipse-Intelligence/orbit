import { getCompany, updateCompany } from "@/lib/crm/companies";
import { withActor } from "@/lib/crm/context";
import { CrmError } from "@/lib/crm/errors";
import { canonicalCompanyLinkedin, canonicalDomain, canonicalImageUrl } from "@/lib/crm/normalize";
import type { Actor, Company, CompanyWrite } from "@/lib/crm/types";
import { ProviderFailure, providerKey } from "@/lib/enrichment/providers";
import { getEnrichmentSettings } from "@/lib/enrichment/settings";

const BRAND_TIMEOUT_MS = 45_000;
const LOGO_HOSTS = ["context.dev", "brand.dev"];

function trustedLogo(url: string | null) {
  if (!url) return null;
  const host = new URL(url).hostname;
  return LOGO_HOSTS.some((allowed) => host === allowed || host.endsWith(`.${allowed}`)) ? url : null;
}

type Options = { fetchImpl?: typeof fetch; env?: Record<string, string | undefined> };

export type CompanyEnrichment = { status: "updated" | "unchanged" | "not_found" | "skipped" | "failed"; message: string; fields: string[] };

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function text(value: unknown, max: number) {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;
}

export function sizeFromEmployees(employees: unknown) {
  const data = record(employees);
  let count = typeof data.exact === "number" ? data.exact : null;
  if (count === null && typeof data.range === "string") {
    const numbers = data.range.replace(/,/g, "").match(/\d+/g)?.map(Number) ?? [];
    if (numbers.length > 0) count = numbers[numbers.length - 1];
  }
  if (count === null || count <= 0) return null;
  if (count <= 10) return "1-10";
  if (count <= 50) return "11-50";
  if (count <= 200) return "51-200";
  if (count <= 1000) return "201-1000";
  return "1000+";
}

export function brandToCompany(brand: Record<string, unknown>, domain: string): CompanyWrite {
  const address = record(brand.address);
  const line = [address.street, address.city, address.state_province, address.postal_code, address.country]
    .map((part) => (typeof part === "string" ? part.trim() : ""))
    .filter(Boolean)
    .join(", ");
  const socials = Array.isArray(brand.socials) ? brand.socials.map(record) : [];
  const linkedin = socials.find((social) => social.type === "linkedin");
  const logos = Array.isArray(brand.logos) ? brand.logos.map(record) : [];
  const logo = logos.find((item) => item.type === "icon") ?? logos.find((item) => item.type === "logo") ?? logos[0];
  const industries = Array.isArray(record(brand.industries).eic) ? (record(brand.industries).eic as unknown[]).map(record) : [];
  const description = text(brand.description, 10_000) ?? text(brand.slogan, 10_000);
  const linkedinUrl = typeof linkedin?.url === "string" ? canonicalCompanyLinkedin(linkedin.url) : null;
  const logoUrl = trustedLogo(typeof logo?.url === "string" ? canonicalImageUrl(logo.url) : null);
  return {
    website: `https://${domain}`,
    description,
    industry: text(industries[0]?.industry, 120),
    sizeCategory: sizeFromEmployees(brand.employees),
    linkedinUrl,
    phone: text(record(brand).phone, 60),
    address: line ? line.slice(0, 500) : null,
    logoUrl,
  };
}

function onlyEmpty(company: Company, found: CompanyWrite): CompanyWrite {
  const write: CompanyWrite = {};
  const keys = ["website", "description", "industry", "sizeCategory", "linkedinUrl", "phone", "address", "logoUrl"] as const;
  for (const key of keys) {
    const value = found[key];
    if (value && !company[key]) write[key] = value;
  }
  return write;
}

async function recordLookup(actor: Actor, companyId: string, status: "found" | "not_found" | "failed", detail: string | null) {
  await withActor(actor, async (db) => {
    await db.query(
      `insert into crm.enrichment_lookups (workspace_id, record_type, record_id, field, status, provider, value, created_by_user_id)
       values ($1, 'company', $2, 'company', $3, 'context', $4, $5)`,
      [actor.workspaceId, companyId, status, detail, actor.type === "user" ? actor.userId : null],
    );
    if (status !== "failed") await db.query("update crm.companies set enriched_at = now() where id = $1 and workspace_id = $2", [companyId, actor.workspaceId]);
  });
}

export async function enrichCompany(actor: Actor, companyId: string, options: Options = {}): Promise<CompanyEnrichment> {
  const env = options.env ?? process.env;
  const key = providerKey("context", env);
  if (!key) return { status: "skipped", message: "Add CONTEXT_DEV_API_KEY to enrich companies.", fields: [] };
  const company = await getCompany(actor, companyId);
  const domain = company.domain ?? (company.website ? canonicalDomain(company.website) : null);
  if (!domain) return { status: "skipped", message: "Add the company's website or domain first.", fields: [] };

  let response: Response;
  try {
    response = await (options.fetchImpl ?? fetch)("https://api.context.dev/v1/brand/retrieve", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ type: "by_domain", domain, tags: ["orbit"] }),
      signal: AbortSignal.timeout(BRAND_TIMEOUT_MS),
    });
  } catch {
    await recordLookup(actor, companyId, "failed", "context.dev didn't respond.");
    return { status: "failed", message: "context.dev didn't respond. Try again.", fields: [] };
  }
  const body = record(await response.json().catch(() => null));
  if (response.status === 400 && /not.?found/i.test(String(body.code ?? body.message ?? ""))) {
    await recordLookup(actor, companyId, "not_found", null);
    return { status: "not_found", message: `context.dev has nothing for ${domain}.`, fields: [] };
  }
  if (!response.ok) {
    const reason =
      response.status === 401
        ? "context.dev rejected the key or is out of credits."
        : response.status === 429
          ? "context.dev is rate limiting. Try again shortly."
          : `context.dev returned ${response.status}.`;
    await recordLookup(actor, companyId, "failed", reason);
    return { status: "failed", message: reason, fields: [] };
  }
  const brand = record(body.brand);
  if (Object.keys(brand).length === 0) {
    await recordLookup(actor, companyId, "not_found", null);
    return { status: "not_found", message: `context.dev has nothing for ${domain}.`, fields: [] };
  }
  const write = onlyEmpty(company, brandToCompany(brand, domain));
  const fields = Object.keys(write);
  if (fields.length > 0) {
    try {
      await updateCompany(actor, companyId, write, { provenance: { operation: "enrich_company", source: "context.dev" } });
    } catch (error) {
      const message = error instanceof CrmError ? error.message : "Couldn't save the company details.";
      await recordLookup(actor, companyId, "failed", message);
      return { status: "failed", message, fields: [] };
    }
  }
  await recordLookup(actor, companyId, "found", fields.join(", ") || null);
  return fields.length > 0
    ? { status: "updated", message: `Filled in ${fields.length} ${fields.length === 1 ? "field" : "fields"} from context.dev.`, fields }
    : { status: "unchanged", message: "Nothing new to add. Every field context.dev knows is already filled in.", fields };
}

export async function autoEnrichCompany(actor: Actor, companyId: string) {
  try {
    if (!providerKey("context")) return;
    const settings = await getEnrichmentSettings(actor);
    if (!settings.autoCompanies) return;
    await enrichCompany(actor, companyId);
  } catch (error) {
    if (!(error instanceof ProviderFailure) && !(error instanceof CrmError)) console.error("Company enrichment failed", error);
  }
}
