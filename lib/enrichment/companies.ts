import { createCompany, getCompany, updateCompany } from "@/lib/crm/companies";
import { FREE_MAIL_DOMAINS } from "@/lib/crm/communications";
import { withActor } from "@/lib/crm/context";
import { CrmError } from "@/lib/crm/errors";
import { isUuid } from "@/lib/crm/mutate";
import { canonicalCompanyLinkedin, canonicalDomain, canonicalImageUrl } from "@/lib/crm/normalize";
import type { Actor, BrandLink, Company, CompanyBrand, CompanyWrite, UserActor } from "@/lib/crm/types";
import { ProviderFailure, providerKey } from "@/lib/enrichment/providers";
import { getEnrichmentSettings } from "@/lib/enrichment/settings";

const BRAND_TIMEOUT_MS = 45_000;
const IMAGE_HOSTS = ["context.dev", "brand.dev"];
const LINK_KEYS: BrandLink[] = ["careers", "pricing", "blog", "contact", "terms", "privacy"];
const BULK_MAX = 5;
const BULK_CONCURRENCY = 3;

type Options = { fetchImpl?: typeof fetch; env?: Record<string, string | undefined> };

export type CompanyEnrichment = {
  status: "updated" | "unchanged" | "not_found" | "skipped" | "failed";
  message: string;
  fields: string[];
};

type BrandResult =
  | { status: "found"; brand: Record<string, unknown> }
  | { status: "not_found" }
  | { status: "failed"; message: string };

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function text(value: unknown, max: number) {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;
}

function httpsUrl(value: unknown) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" && url.toString().length <= 1000 ? url.toString() : null;
  } catch {
    return null;
  }
}

function trustedImage(value: unknown) {
  const url = typeof value === "string" ? canonicalImageUrl(value) : null;
  if (!url) return null;
  const host = new URL(url).hostname;
  return IMAGE_HOSTS.some((allowed) => host === allowed || host.endsWith(`.${allowed}`)) ? url : null;
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

function industries(brand: Record<string, unknown>) {
  const eic = record(brand.industries).eic;
  return (Array.isArray(eic) ? eic.map(record) : [])
    .map((entry) => ({ industry: text(entry.industry, 120), subindustry: text(entry.subindustry, 120) }))
    .filter((entry): entry is { industry: string; subindustry: string | null } => Boolean(entry.industry))
    .slice(0, 6);
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
  const primary = industries(brand)[0];
  return {
    website: `https://${domain}`,
    description: text(brand.description, 10_000) ?? text(brand.slogan, 10_000),
    industry: primary ? (primary.subindustry ?? primary.industry) : null,
    sizeCategory: sizeFromEmployees(brand.employees),
    linkedinUrl: typeof linkedin?.url === "string" ? canonicalCompanyLinkedin(linkedin.url) : null,
    phone: text(brand.phone, 60),
    address: line ? line.slice(0, 500) : null,
    logoUrl: trustedImage(logo?.url),
  };
}

export function brandProfile(brand: Record<string, unknown>, checkedAt = new Date()): CompanyBrand {
  const seen = new Set<string>();
  const socials = (Array.isArray(brand.socials) ? brand.socials.map(record) : []).flatMap((social) => {
    const type = text(social.type, 40)?.toLowerCase();
    const url = httpsUrl(social.url);
    if (!type || !url || seen.has(type)) return [];
    seen.add(type);
    return [{ type, url }];
  });
  const linkSource = record(brand.links);
  const links: CompanyBrand["links"] = {};
  for (const key of LINK_KEYS) {
    const url = httpsUrl(linkSource[key]);
    if (url) links[key] = url;
  }
  const employees = record(brand.employees);
  const stock = record(brand.stock);
  const colors = (Array.isArray(brand.colors) ? brand.colors.map(record) : [])
    .map((color) => (typeof color.hex === "string" && /^#[0-9a-f]{3,8}$/i.test(color.hex) ? color.hex.toLowerCase() : null))
    .filter((hex): hex is string => Boolean(hex))
    .slice(0, 6);
  const backdrops = Array.isArray(brand.backdrops) ? brand.backdrops.map(record) : [];
  const email = text(brand.email, 320);
  return {
    slogan: text(brand.slogan, 300),
    socials: socials.slice(0, 30),
    links,
    industries: industries(brand),
    employees:
      typeof employees.exact === "number" || typeof employees.range === "string"
        ? { range: text(employees.range, 60), exact: typeof employees.exact === "number" ? Math.round(employees.exact) : null }
        : null,
    email: email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null,
    stock: text(stock.ticker, 15) ? { ticker: text(stock.ticker, 15)!, exchange: text(stock.exchange, 40) } : null,
    colors: [...new Set(colors)],
    backdropUrl: backdrops.map((item) => trustedImage(item.url)).find(Boolean) ?? null,
    checkedAt: checkedAt.toISOString(),
  };
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value ?? null);
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

async function fetchBrand(key: string, body: Record<string, unknown>, fetchImpl: typeof fetch): Promise<BrandResult> {
  let response: Response;
  try {
    response = await fetchImpl("https://api.context.dev/v1/brand/retrieve", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ ...body, tags: ["orbit"] }),
      signal: AbortSignal.timeout(BRAND_TIMEOUT_MS),
    });
  } catch {
    return { status: "failed", message: "context.dev didn't respond. Try again." };
  }
  const payload = record(await response.json().catch(() => null));
  if ((response.status === 400 && /not.?found/i.test(String(payload.code ?? payload.message ?? ""))) || response.status === 422) {
    return { status: "not_found" };
  }
  if (!response.ok) {
    return {
      status: "failed",
      message:
        response.status === 401
          ? "context.dev rejected the key or is out of credits."
          : response.status === 429
            ? "context.dev is rate limiting. Try again shortly."
            : `context.dev returned ${response.status}.`,
    };
  }
  const brand = record(payload.brand);
  return Object.keys(brand).length > 0 ? { status: "found", brand } : { status: "not_found" };
}

async function recordLookup(actor: Actor, companyId: string, status: "found" | "not_found" | "failed", detail: string | null, profile?: CompanyBrand) {
  await withActor(actor, async (db) => {
    await db.query(
      `insert into crm.enrichment_lookups (workspace_id, record_type, record_id, field, status, provider, value, created_by_user_id)
       values ($1, 'company', $2, 'company', $3, 'context', $4, $5)`,
      [actor.workspaceId, companyId, status, detail?.slice(0, 1000) ?? null, actor.type === "user" ? actor.userId : null],
    );
    if (profile) {
      await db.query("update crm.companies set enriched_at = now(), brand = $3::jsonb where id = $1 and workspace_id = $2", [
        companyId,
        actor.workspaceId,
        JSON.stringify(profile),
      ]);
    } else if (status === "not_found") {
      await db.query("update crm.companies set enriched_at = now() where id = $1 and workspace_id = $2", [companyId, actor.workspaceId]);
    }
  });
}

export async function enrichCompany(actor: Actor, companyId: string, options: Options = {}): Promise<CompanyEnrichment> {
  const env = options.env ?? process.env;
  const key = providerKey("context", env);
  if (!key) return { status: "skipped", message: "Add CONTEXT_DEV_API_KEY to enrich companies.", fields: [] };
  const company = await getCompany(actor, companyId);
  const domain = company.domain ?? (company.website ? canonicalDomain(company.website) : null);
  if (!domain) return { status: "skipped", message: "Add the company's website or domain first.", fields: [] };

  const result = await fetchBrand(key, { type: "by_domain", domain }, options.fetchImpl ?? fetch);
  if (result.status === "failed") {
    await recordLookup(actor, companyId, "failed", result.message);
    return { status: "failed", message: result.message, fields: [] };
  }
  if (result.status === "not_found") {
    await recordLookup(actor, companyId, "not_found", null);
    return { status: "not_found", message: `context.dev has nothing for ${domain}.`, fields: [] };
  }
  const profile = brandProfile(result.brand);
  const write = onlyEmpty(company, brandToCompany(result.brand, domain));
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
  await recordLookup(actor, companyId, "found", fields.join(", ") || null, profile);
  const extras = profile.socials.length + Object.keys(profile.links).length;
  const sameProfile = stable({ ...company.brand, checkedAt: null }) === stable({ ...profile, checkedAt: null });
  return fields.length > 0 || (extras > 0 && !sameProfile)
    ? {
        status: "updated",
        message: [
          fields.length > 0 ? `Filled in ${fields.length} ${fields.length === 1 ? "field" : "fields"}` : "Details are up to date",
          extras > 0 ? `${profile.socials.length} social ${profile.socials.length === 1 ? "profile" : "profiles"}` : null,
        ]
          .filter(Boolean)
          .join(", ") + " from context.dev.",
        fields,
      }
    : { status: "unchanged", message: "Nothing new to add. Every field context.dev knows is already filled in.", fields };
}

async function inBatches<T, R>(items: T[], run: (item: T) => Promise<R>) {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next++;
      results[index] = await run(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(BULK_CONCURRENCY, items.length) }, worker));
  return results;
}

async function safeEnrich(actor: Actor, id: string, options: Options): Promise<CompanyEnrichment & { companyId: string }> {
  try {
    return { companyId: id, ...(await enrichCompany(actor, id, options)) };
  } catch (error) {
    return { companyId: id, status: "failed", message: error instanceof CrmError ? error.message : "That lookup failed.", fields: [] };
  }
}

export async function enrichCompanies(actor: Actor, ids: unknown, options: Options = {}) {
  const list = Array.isArray(ids) ? [...new Set(ids.filter((id): id is string => typeof id === "string" && isUuid(id)))] : [];
  if (list.length === 0) throw new CrmError("invalid_input", "Select at least one company.", 400);
  if (list.length > BULK_MAX) throw new CrmError("invalid_input", `Send up to ${BULK_MAX} companies at a time.`, 400);
  return inBatches(list, (id) => safeEnrich(actor, id, options));
}

const UNENRICHED_SQL = `
  from crm.companies c
  where c.workspace_id = $1
    and c.archived_at is null
    and (c.domain is not null or c.website is not null)
    and c.enriched_at is null
    and not exists (
      select 1 from crm.enrichment_lookups l
      where l.record_type = 'company' and l.record_id = c.id and l.status = 'failed' and l.created_at > now() - interval '1 hour'
    )`;

export async function unenrichedCompanyCount(actor: Actor) {
  return withActor(actor, async (db) => {
    const result = await db.query<{ total: number }>(`select count(*)::int as total ${UNENRICHED_SQL}`, [actor.workspaceId]);
    return result.rows[0]?.total ?? 0;
  });
}

export async function backfillCompanies(actor: Actor, options: Options = {}) {
  const ids = await withActor(actor, async (db) => {
    const result = await db.query<{ id: string }>(`select c.id ${UNENRICHED_SQL} order by c.created_at limit ${BULK_MAX}`, [actor.workspaceId]);
    return result.rows.map((row) => row.id);
  });
  const results = ids.length > 0 ? await inBatches(ids, (id) => safeEnrich(actor, id, options)) : [];
  return { results, remaining: await unenrichedCompanyCount(actor) };
}

export type CompanySuggestion =
  | { kind: "existing"; company: { id: string; name: string } }
  | { kind: "new"; name: string; domain: string; logoUrl: string | null; description: string | null }
  | { kind: "none" };

export async function suggestCompanyForEmail(actor: UserActor, email: unknown, options: Options = {}): Promise<CompanySuggestion> {
  const address = typeof email === "string" ? email.trim().toLowerCase() : "";
  const domain = /^[^\s@]+@([^\s@]+\.[^\s@]+)$/.exec(address)?.[1] ?? null;
  if (!domain || FREE_MAIL_DOMAINS.has(domain)) return { kind: "none" };
  const existing = await withActor(actor, async (db) => {
    const result = await db.query<{ id: string; name: string }>(
      `select id, name from crm.companies
       where workspace_id = $1 and archived_at is null and (domain = $2 or domain = $3)
       order by created_at limit 1`,
      [actor.workspaceId, domain, domain.replace(/^[^.]+\.(?=[^.]+\.[^.]+$)/, "")],
    );
    return result.rows[0] ?? null;
  });
  if (existing) return { kind: "existing", company: existing };
  const key = providerKey("context", options.env ?? process.env);
  if (!key) return { kind: "none" };
  const result = await fetchBrand(key, { type: "by_email", email: address }, options.fetchImpl ?? fetch);
  if (result.status !== "found") return { kind: "none" };
  const brandDomain = canonicalDomain(text(result.brand.domain, 253) ?? domain) ?? domain;
  const name = text(result.brand.title, 200);
  if (!name) return { kind: "none" };
  const mapped = brandToCompany(result.brand, brandDomain);
  return { kind: "new", name, domain: brandDomain, logoUrl: mapped.logoUrl ?? null, description: mapped.description ?? null };
}

export async function createSuggestedCompany(actor: UserActor, name: unknown, domain: unknown, options: Options = {}) {
  if (typeof name !== "string" || typeof domain !== "string") throw new CrmError("invalid_input", "Pick a company.", 400);
  const created = await createCompany(actor, { name, domain, source: "context.dev" }, { provenance: { operation: "create_company", source: "contact_email" } });
  const company = created.body.company;
  const settings = await getEnrichmentSettings(actor);
  if (!settings.autoCompanies) await enrichCompany(actor, company.id, options).catch(() => undefined);
  return { id: company.id, name: company.name };
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
