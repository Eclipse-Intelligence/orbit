import { assertScope } from "@/lib/crm/scopes";
import { createHash, randomBytes } from "node:crypto";
import { getCompany } from "@/lib/crm/companies";
import { getContact } from "@/lib/crm/contacts";
import { withActor } from "@/lib/crm/context";
import { CrmError } from "@/lib/crm/errors";
import { sendContactEmail } from "@/lib/crm/inbox";
import { isUuid, recordAudit } from "@/lib/crm/mutate";
import { moveToProposalStageInDb } from "@/lib/crm/opportunities";
import { stableStringify } from "@/lib/crm/normalize";
import type { Actor, Provenance, UserActor } from "@/lib/crm/types";
import type { Db } from "@/lib/db/pool";
import { decryptSecret, encryptSecret } from "@/lib/crypto/secret";
import { getTemplate, readBlocks, readSettings } from "@/lib/proposals/catalogue";
import {
  consentText,
  CURRENCIES,
  fieldValues,
  renderBlocks,
  totalLabel,
  totalsOf,
  type Block,
  type Content,
  type Currency,
  type DocumentKind,
  type DocumentStatus,
  type Item,
  type TemplateSettings,
  type Totals,
} from "@/lib/proposals/model";
import { renderPdf, type PdfEvent, type PdfSignature } from "@/lib/proposals/pdf";
import { siteOrigin } from "@/lib/site-url";
import { appTimeZone, zonedParts } from "@/lib/time";

export type DocumentSummary = {
  id: string;
  kind: DocumentKind;
  title: string;
  status: DocumentStatus | "expired";
  companyId: string;
  companyName: string;
  contactId: string;
  contactName: string;
  opportunityId: string | null;
  ownerId: string;
  ownerName: string | null;
  currency: Currency;
  totals: Totals;
  totalLabel: string;
  validUntil: string | null;
  sentAt: string | null;
  lastViewedAt: string | null;
  viewCount: number;
  completedAt: string | null;
  updatedAt: string;
  href: string;
};

type DocumentEvent = { id: string; type: string; actor: string; name: string | null; email: string | null; ip: string | null; at: string; data: Record<string, unknown> };

export type SignatureRecord = PdfSignature & { id: string; versionId: string };

export type DocumentDetail = DocumentSummary & {
  templateId: string | null;
  templateName: string | null;
  items: Item[];
  blocks: Block[];
  settings: TemplateSettings;
  declineReason: string | null;
  version: { id: string; number: number; content: Content; hash: string } | null;
  link: string | null;
  preview: Content;
  missing: string[];
  placeholders: string[];
  signatures: SignatureRecord[];
  events: DocumentEvent[];
  files: { issued: boolean; executed: boolean };
  contactEmail: string | null;
  canCountersign: boolean;
};

type DocumentRow = {
  id: string;
  workspace_id: string;
  kind: DocumentKind;
  template_id: string | null;
  title: string;
  status: DocumentStatus;
  company_id: string;
  company_name: string;
  contact_id: string;
  contact_name: string | null;
  opportunity_id: string | null;
  owner_id: string;
  owner_name: string | null;
  currency: Currency;
  items: Item[];
  blocks: unknown;
  settings: unknown;
  valid_until: string | null;
  current_version_id: string | null;
  sent_at: Date | null;
  last_viewed_at: Date | null;
  view_count: number;
  completed_at: Date | null;
  decline_reason: string | null;
  updated_at: Date;
};

const COLUMNS = `d.id, d.workspace_id, d.kind, d.template_id, d.title, d.status, d.company_id, co.name as company_name, d.contact_id,
  nullif(trim(concat_ws(' ', ct.first_name, ct.last_name)), '') as contact_name, d.opportunity_id, d.owner_id, p.full_name as owner_name,
  d.currency, d.items, d.blocks, d.settings, to_char(d.valid_until, 'YYYY-MM-DD') as valid_until, d.current_version_id, d.sent_at,
  d.last_viewed_at, d.view_count, d.completed_at, d.decline_reason, d.updated_at`;
const FROM = `crm.documents d
  join crm.companies co on co.id = d.company_id
  join crm.contacts ct on ct.id = d.contact_id
  left join crm.profiles p on p.id = d.owner_id`;

const OPEN = new Set<DocumentStatus>(["sent", "viewed"]);

export function documentHref(id: string) {
  return `/proposals/${id}`;
}

function publicUrl(token: string) {
  return `${siteOrigin() ?? ""}/p/${token}`;
}

export function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function sha256(value: string | Buffer) {
  return createHash("sha256").update(value).digest("hex");
}

function todayKey() {
  const parts = zonedParts(new Date(), appTimeZone());
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

export function isExpired(status: DocumentStatus, validUntil: string | null) {
  return OPEN.has(status) && Boolean(validUntil) && validUntil! < todayKey();
}

function iso(value: Date | string | null) {
  return value ? new Date(value).toISOString() : null;
}

function toSummary(row: DocumentRow): DocumentSummary {
  const items = Array.isArray(row.items) ? row.items : [];
  const totals = totalsOf(items);
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    status: isExpired(row.status, row.valid_until) ? "expired" : row.status,
    companyId: row.company_id,
    companyName: row.company_name,
    contactId: row.contact_id,
    contactName: row.contact_name ?? "Contact",
    opportunityId: row.opportunity_id,
    ownerId: row.owner_id,
    ownerName: row.owner_name,
    currency: row.currency,
    totals,
    totalLabel: totalLabel(totals, row.currency),
    validUntil: row.valid_until,
    sentAt: iso(row.sent_at),
    lastViewedAt: iso(row.last_viewed_at),
    viewCount: row.view_count,
    completedAt: iso(row.completed_at),
    updatedAt: iso(row.updated_at)!,
    href: documentHref(row.id),
  };
}

function invalid(message: string, field?: string) {
  return new CrmError("invalid_input", message, 400, field ? { field } : undefined);
}

function actorUser(actor: Actor) {
  return actor.type === "user" ? actor.userId : null;
}

async function readRow(db: Db, actor: Actor, id: string) {
  if (!isUuid(id)) throw new CrmError("not_found", "Proposal not found.", 404);
  const result = await db.query<DocumentRow>(`select ${COLUMNS} from ${FROM} where d.id = $1 and d.workspace_id = $2`, [id, actor.workspaceId]);
  const row = result.rows[0];
  if (!row) throw new CrmError("not_found", "Proposal not found.", 404);
  return row;
}

async function logEvent(
  db: Db,
  input: { workspaceId: string; documentId: string; versionId?: string | null; type: string; actor: "user" | "client" | "system" | "agent"; userId?: string | null; name?: string | null; email?: string | null; ip?: string | null; userAgent?: string | null; data?: Record<string, unknown> },
) {
  await db.query(
    `insert into crm.document_events (workspace_id, document_id, version_id, type, actor, actor_user_id, name, email, ip, user_agent, data)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)`,
    [
      input.workspaceId,
      input.documentId,
      input.versionId ?? null,
      input.type,
      input.actor,
      input.userId ?? null,
      input.name?.slice(0, 200) ?? null,
      input.email?.slice(0, 320) ?? null,
      input.ip?.slice(0, 100) ?? null,
      input.userAgent?.slice(0, 400) ?? null,
      JSON.stringify(input.data ?? {}),
    ],
  );
}

export async function listDocuments(
  actor: Actor,
  filter: { companyId?: string; contactId?: string; opportunityIds?: string[]; status?: string; kind?: DocumentKind; search?: string; includeArchived?: boolean; limit?: number } = {},
) {
  return withActor(actor, async (db) => {
    const values: unknown[] = [actor.workspaceId];
    const where = ["d.workspace_id = $1"];
    const add = (value: unknown) => {
      values.push(value);
      return `$${values.length}`;
    };
    if (!filter.includeArchived) where.push("d.archived_at is null");
    if (filter.companyId && isUuid(filter.companyId)) where.push(`d.company_id = ${add(filter.companyId)}`);
    if (filter.contactId && isUuid(filter.contactId)) where.push(`d.contact_id = ${add(filter.contactId)}`);
    if (filter.opportunityIds) where.push(`d.opportunity_id = any(${add(filter.opportunityIds.filter(isUuid))}::uuid[])`);
    if (filter.kind) where.push(`d.kind = ${add(filter.kind)}`);
    if (filter.status === "open") where.push("d.status in ('sent', 'viewed', 'client_signed')");
    else if (filter.status === "expired") where.push(`d.status in ('sent', 'viewed') and d.valid_until < ${add(todayKey())}::date`);
    else if (filter.status && filter.status !== "all") where.push(`d.status = ${add(filter.status)}`);
    if (filter.search?.trim()) {
      const pattern = add(`%${filter.search.trim().replace(/[%_\\]/g, "\\$&")}%`);
      where.push(`(d.title ilike ${pattern} or co.name ilike ${pattern} or concat_ws(' ', ct.first_name, ct.last_name) ilike ${pattern})`);
    }
    const result = await db.query<DocumentRow>(
      `select ${COLUMNS} from ${FROM} where ${where.join(" and ")} order by d.updated_at desc limit ${add(Math.min(Math.max(filter.limit ?? 200, 1), 500))}`,
      values,
    );
    return result.rows.map(toSummary);
  });
}

async function partiesFor(db: Db, actor: Actor, row: { company_id: string; contact_id: string; owner_id: string }) {
  const company = await getCompany(actor, row.company_id);
  const contact = await getContact(actor, row.contact_id);
  const owner = await db.query<{ full_name: string | null; email: string | null }>("select full_name, email from crm.profiles where id = $1", [row.owner_id]);
  const workspace = await db.query<{ name: string }>("select name from crm.workspaces where id = $1", [actor.workspaceId]);
  return {
    company,
    contact,
    sender: { name: owner.rows[0]?.full_name || owner.rows[0]?.email || "Sender", email: owner.rows[0]?.email ?? "" },
    workspaceName: workspace.rows[0]?.name ?? "Our company",
  };
}

async function templateLogo(db: Db, templateId: string, fallback: string | null) {
  const result = await db.query<{ settings: unknown }>("select settings from crm.document_templates where id = $1", [templateId]);
  return result.rows[0] ? readSettings(result.rows[0].settings).logo : fallback;
}

async function buildContent(db: Db, actor: Actor, row: DocumentRow, issuedAt: string) {
  const parties = await partiesFor(db, actor, row);
  const items = Array.isArray(row.items) ? row.items : [];
  const settings = readSettings(row.settings);
  const logo = row.status === "draft" && row.template_id ? await templateLogo(db, row.template_id, settings.logo) : settings.logo;
  const values = fieldValues({
    company: { name: parties.company.name, domain: parties.company.domain, website: parties.company.website },
    contact: {
      name: parties.contact.name,
      firstName: parties.contact.firstName,
      lastName: parties.contact.lastName,
      jobTitle: parties.contact.jobTitle,
      email: parties.contact.email,
    },
    sender: parties.sender,
    workspace: { name: parties.workspaceName },
    proposal: { title: row.title, currency: row.currency, validUntil: row.valid_until, items },
  });
  const { blocks, missing, placeholders } = renderBlocks(readBlocks(row.blocks), values);
  const content: Content = {
    kind: row.kind,
    title: row.title,
    currency: row.currency,
    validUntil: row.valid_until,
    accent: settings.accent,
    logo,
    client: { name: parties.contact.name, email: parties.contact.email ?? "", title: parties.contact.jobTitle, company: parties.company.name },
    sender: { name: parties.sender.name, email: parties.sender.email, title: null, company: parties.workspaceName },
    blocks,
    items,
    totals: totalsOf(items),
    consent: consentText(row.kind, parties.workspaceName, blocks.some((block) => block.type === "terms")),
    issuedAt,
  };
  return { content, missing, placeholders, contactEmail: parties.contact.email };
}

type ItemInput = { productId?: unknown; quantity?: unknown; name?: unknown; description?: unknown; unitPrice?: unknown; billing?: unknown };

async function itemsFrom(db: Db, actor: Actor, input: unknown, currency: Currency): Promise<Item[]> {
  if (!Array.isArray(input)) return [];
  if (input.length > 50) throw invalid("Add up to 50 products.", "items");
  const ids = input.map((item: ItemInput) => item?.productId).filter((id): id is string => typeof id === "string" && isUuid(id));
  const products = ids.length
    ? await db.query<{ id: string; name: string; description: string | null; price_gbp: string | null; price_usd: string | null; billing: Item["billing"] }>(
        "select id, name, description, price_gbp, price_usd, billing from crm.products where workspace_id = $1 and id = any($2::uuid[])",
        [actor.workspaceId, ids],
      )
    : { rows: [] };
  const byId = new Map(products.rows.map((row) => [row.id, row]));
  return input.map((raw: ItemInput, index) => {
    const quantity = Math.max(1, Math.min(10_000, Math.trunc(Number(raw?.quantity ?? 1)) || 1));
    const product = typeof raw?.productId === "string" ? byId.get(raw.productId) : null;
    if (product) {
      const price = currency === "GBP" ? product.price_gbp : product.price_usd;
      if (price === null) throw invalid(`${product.name} has no ${currency === "GBP" ? "pound" : "dollar"} price. Add one in Products, or choose the other currency.`, "items");
      const custom = typeof raw.unitPrice === "number" && Number.isFinite(raw.unitPrice) && raw.unitPrice >= 0 ? raw.unitPrice : null;
      return {
        productId: product.id,
        name: product.name,
        description: typeof raw.description === "string" ? raw.description.slice(0, 4000) : (product.description ?? ""),
        billing: product.billing,
        unitPrice: Math.round((custom ?? Number(price)) * 100) / 100,
        quantity,
      };
    }
    const name = typeof raw?.name === "string" ? raw.name.trim().slice(0, 120) : "";
    const unitPrice = Number(raw?.unitPrice);
    if (!name || !Number.isFinite(unitPrice) || unitPrice < 0) throw invalid(`Line ${index + 1} needs a product, or a name and a price.`, "items");
    const billing = raw?.billing === "monthly" || raw?.billing === "yearly" ? raw.billing : "one_off";
    return { productId: null, name, description: typeof raw?.description === "string" ? raw.description.slice(0, 4000) : "", billing, unitPrice: Math.round(unitPrice * 100) / 100, quantity };
  });
}

function addDays(days: number) {
  const date = new Date(`${todayKey()}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export async function createDocument(
  actor: Actor,
  input: { templateId?: unknown; companyId?: unknown; contactId?: unknown; opportunityId?: unknown; currency?: unknown; items?: unknown; title?: unknown; ownerId?: unknown },
  provenance: Provenance = { operation: "create_proposal" },
) {
  assertScope(actor.scopes, "opportunities:write");
  if (typeof input.templateId !== "string") throw invalid("Choose a template.", "templateId");
  const template = await getTemplate(actor, input.templateId);
  if (template.status !== "active") throw invalid("Only active templates can be used. Make this template active first.", "templateId");
  if (typeof input.companyId !== "string" || !isUuid(input.companyId)) throw invalid("Choose a company.", "companyId");
  if (typeof input.contactId !== "string" || !isUuid(input.contactId)) throw invalid("Choose a person at the company.", "contactId");
  const company = await getCompany(actor, input.companyId);
  const contact = await getContact(actor, input.contactId);
  if (contact.companyId !== company.id) throw invalid(`${contact.name} isn't at ${company.name}. Choose someone from that company.`, "contactId");
  const currency = CURRENCIES.find((item) => item === input.currency) ?? "GBP";
  const ownerId =
    actor.type === "user" ? actor.userId : typeof input.ownerId === "string" && isUuid(input.ownerId) ? input.ownerId : (company.ownerId ?? null);
  if (!ownerId) throw invalid("Choose who sends and countersigns it (ownerId).", "ownerId");
  const title =
    (typeof input.title === "string" && input.title.replace(/\s+/g, " ").trim().slice(0, 200)) ||
    (template.kind === "nda" ? `NDA with ${company.name}` : `Proposal for ${company.name}`);
  return withActor(actor, async (db) => {
    const items = await itemsFrom(db, actor, input.items, currency);
    let opportunityId = typeof input.opportunityId === "string" && isUuid(input.opportunityId) ? input.opportunityId : null;
    if (!opportunityId && template.kind === "proposal") {
      const open = await db.query<{ id: string }>(
        `select o.id from crm.opportunities o join crm.pipelines pl on pl.id = o.pipeline_id
         where o.workspace_id = $1 and o.company_id = $2 and o.status = 'open' and o.archived_at is null and pl.kind <> 'board'
         order by o.updated_at desc limit 2`,
        [actor.workspaceId, company.id],
      );
      if (open.rows.length === 1) opportunityId = open.rows[0].id;
    }
    if (template.kind === "proposal") {
      const totals = totalsOf(items);
      const placed = await moveToProposalStageInDb(
        db,
        actor,
        {
          companyId: company.id,
          contactId: contact.id,
          companyName: company.name,
          opportunityId,
          value: Math.round((totals.one_off + totals.monthly * 12 + totals.yearly) * 100) / 100,
          currency,
          ownerId,
        },
        { ...provenance, operation: "proposal_stage" },
      );
      opportunityId = placed.opportunityId;
    }
    const result = await db.query<{ id: string }>(
      `insert into crm.documents (workspace_id, kind, template_id, title, company_id, contact_id, opportunity_id, owner_id, currency, items, blocks, settings, valid_until, created_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12::jsonb, $13, $14) returning id`,
      [
        actor.workspaceId,
        template.kind,
        template.id,
        title,
        company.id,
        contact.id,
        opportunityId,
        ownerId,
        currency,
        JSON.stringify(items),
        JSON.stringify(template.blocks),
        JSON.stringify(template.settings),
        addDays(template.settings.validDays),
        actorUser(actor),
      ],
    );
    const id = result.rows[0].id;
    await logEvent(db, { workspaceId: actor.workspaceId, documentId: id, type: "created", actor: actor.type === "agent" ? "agent" : "user", userId: actorUser(actor), data: { template: template.name } });
    await recordAudit(db, actor, "document.created", "document", id, provenance, { after: { title, kind: template.kind, companyId: company.id, contactId: contact.id } });
    return id;
  });
}

export async function getDocument(actor: Actor, id: string): Promise<DocumentDetail> {
  return withActor(actor, async (db) => {
    const row = await readRow(db, actor, id);
    const built = await buildContent(db, actor, row, new Date().toISOString());
    const version = row.current_version_id
      ? (
          await db.query<{ id: string; number: number; content: Content; content_hash: string }>(
            "select id, number, content, content_hash from crm.document_versions where id = $1",
            [row.current_version_id],
          )
        ).rows[0]
      : undefined;
    const link = row.current_version_id
      ? (
          await db.query<{ token_cipher: string }>(
            "select token_cipher from crm.document_links where document_id = $1 and revoked_at is null order by created_at desc limit 1",
            [row.id],
          )
        ).rows[0]
      : undefined;
    const signatures = await db.query<SignatureRow>(`select ${SIGNATURE_COLUMNS} from crm.document_signatures where document_id = $1 order by signed_at`, [row.id]);
    const events = await db.query<{ id: string; type: string; actor: string; name: string | null; email: string | null; ip: string | null; occurred_at: Date; data: Record<string, unknown> }>(
      "select id, type, actor, name, email, ip, occurred_at, data from crm.document_events where document_id = $1 order by occurred_at, id",
      [row.id],
    );
    const files = await db.query<{ kind: string }>("select kind from crm.document_files where document_id = $1 and version_id = $2", [row.id, row.current_version_id]);
    const template = row.template_id ? await db.query<{ name: string }>("select name from crm.document_templates where id = $1", [row.template_id]) : null;
    const role = actor.type === "user" ? actor.role : null;
    return {
      ...toSummary(row),
      templateId: row.template_id,
      templateName: template?.rows[0]?.name ?? null,
      items: Array.isArray(row.items) ? row.items : [],
      blocks: readBlocks(row.blocks),
      settings: readSettings(row.settings),
      declineReason: row.decline_reason,
      version: version ? { id: version.id, number: version.number, content: version.content, hash: version.content_hash } : null,
      link: link ? publicUrl(decryptSecret(link.token_cipher)) : null,
      preview: built.content,
      missing: built.missing,
      placeholders: built.placeholders,
      signatures: signatures.rows.filter((signature) => signature.version_id === row.current_version_id).map(toSignature),
      events: events.rows.map((event) => ({ id: event.id, type: event.type, actor: event.actor, name: event.name, email: event.email, ip: event.ip, at: iso(event.occurred_at)!, data: event.data ?? {} })),
      files: { issued: files.rows.some((file) => file.kind === "issued"), executed: files.rows.some((file) => file.kind === "executed") },
      contactEmail: built.contactEmail,
      canCountersign: row.status === "client_signed" && actor.type === "user" && (actor.userId === row.owner_id || role === "owner" || role === "admin"),
    };
  });
}

type SignatureRow = {
  id: string;
  version_id: string;
  role: "client" | "sender";
  name: string;
  email: string;
  title: string | null;
  company: string | null;
  signature_text: string;
  signature_image: string | null;
  method: string;
  ip: string | null;
  signed_at: Date;
};

const SIGNATURE_COLUMNS = "id, version_id, role, name, email, title, company, signature_text, signature_image, method, ip, signed_at";

function toSignature(row: SignatureRow): SignatureRecord {
  return {
    id: row.id,
    versionId: row.version_id,
    role: row.role,
    name: row.name,
    email: row.email,
    title: row.title,
    company: row.company,
    signatureText: row.signature_text,
    signatureImage: row.signature_image,
    signedAt: iso(row.signed_at)!,
    ip: row.ip,
    method: row.method,
  };
}

export async function updateDocument(
  actor: Actor,
  id: string,
  input: { title?: unknown; currency?: unknown; items?: unknown; blocks?: unknown; validUntil?: unknown; contactId?: unknown },
  provenance: Provenance = { operation: "update_proposal" },
) {
  assertScope(actor.scopes, "opportunities:write");
  return withActor(actor, async (db) => {
    const row = await readRow(db, actor, id);
    if (row.status !== "draft") throw invalid("This has been sent. Choose Make changes first, which withdraws the sent version.", "status");
    const sets: string[] = [];
    const values: unknown[] = [id];
    const set = (column: string, value: unknown, cast = "") => {
      values.push(value);
      sets.push(`${column} = $${values.length}${cast}`);
    };
    if (input.title !== undefined) {
      const title = typeof input.title === "string" ? input.title.replace(/\s+/g, " ").trim() : "";
      if (!title || title.length > 200) throw invalid("Give it a title of up to 200 characters.", "title");
      set("title", title);
    }
    const currency = input.currency === undefined ? row.currency : CURRENCIES.find((item) => item === input.currency);
    if (!currency) throw invalid("Choose pounds or dollars.", "currency");
    if (input.currency !== undefined) set("currency", currency);
    if (input.items !== undefined) set("items", JSON.stringify(await itemsFrom(db, actor, input.items, currency)), "::jsonb");
    else if (input.currency !== undefined && currency !== row.currency) {
      set("items", JSON.stringify(await itemsFrom(db, actor, (row.items ?? []).map((item) => ({ ...item, unitPrice: undefined })), currency)), "::jsonb");
    }
    if (input.blocks !== undefined) {
      const blocks = readBlocks(input.blocks);
      if (Array.isArray(input.blocks) && blocks.length !== input.blocks.length) throw invalid("The sections couldn't be read.", "blocks");
      set("blocks", JSON.stringify(blocks), "::jsonb");
    }
    if (input.validUntil !== undefined) {
      const value = typeof input.validUntil === "string" && /^\d{4}-\d{2}-\d{2}$/.test(input.validUntil) ? input.validUntil : null;
      if (input.validUntil && !value) throw invalid("Choose a valid date.", "validUntil");
      set("valid_until", value);
    }
    if (input.contactId !== undefined) {
      if (typeof input.contactId !== "string" || !isUuid(input.contactId)) throw invalid("Choose a person at the company.", "contactId");
      const contact = await getContact(actor, input.contactId);
      if (contact.companyId !== row.company_id) throw invalid(`${contact.name} isn't at ${row.company_name}.`, "contactId");
      set("contact_id", contact.id);
    }
    if (sets.length === 0) return;
    await db.query(`update crm.documents set ${sets.join(", ")}, updated_at = now() where id = $1`, values);
    await recordAudit(db, actor, "document.updated", "document", id, provenance, { fields: Object.keys(input) });
  });
}

export async function reviseDocument(actor: Actor, id: string, provenance: Provenance = { operation: "revise_proposal" }) {
  assertScope(actor.scopes, "opportunities:write");
  await withActor(actor, async (db) => {
    const row = await readRow(db, actor, id);
    if (!OPEN.has(row.status) && row.status !== "declined" && row.status !== "withdrawn") throw invalid("Only a sent, declined or withdrawn proposal can be changed.", "status");
    await db.query("update crm.documents set status = 'draft', withdrawn_at = null, declined_at = null, decline_reason = null, updated_at = now() where id = $1", [id]);
    await logEvent(db, { workspaceId: actor.workspaceId, documentId: id, versionId: row.current_version_id, type: "reopened", actor: "user", userId: actorUser(actor) });
    await recordAudit(db, actor, "document.reopened", "document", id, provenance, {});
  });
}

export async function withdrawDocument(actor: Actor, id: string, provenance: Provenance = { operation: "withdraw_proposal" }) {
  assertScope(actor.scopes, "opportunities:write");
  await withActor(actor, async (db) => {
    const row = await readRow(db, actor, id);
    if (!OPEN.has(row.status) && row.status !== "client_signed") throw invalid("Only a sent proposal can be withdrawn.", "status");
    await db.query("update crm.document_links set revoked_at = now() where document_id = $1 and revoked_at is null", [id]);
    await db.query("update crm.documents set status = 'withdrawn', withdrawn_at = now(), updated_at = now() where id = $1", [id]);
    await logEvent(db, { workspaceId: actor.workspaceId, documentId: id, versionId: row.current_version_id, type: "withdrawn", actor: "user", userId: actorUser(actor) });
    await recordAudit(db, actor, "document.withdrawn", "document", id, provenance, {});
  });
}

export async function archiveDocument(actor: Actor, id: string, archived: boolean) {
  await withActor(actor, async (db) => {
    const row = await readRow(db, actor, id);
    if (archived && row.status === "draft") {
      await db.query("delete from crm.documents where id = $1 and status = 'draft'", [id]);
      await recordAudit(db, actor, "document.deleted", "document", id, { operation: "delete_proposal" }, {});
      return;
    }
    await db.query("update crm.documents set archived_at = $2, updated_at = now() where id = $1", [id, archived ? new Date().toISOString() : null]);
  });
}

export async function sendDocument(
  actor: UserActor,
  id: string,
  input: { subject?: unknown; message?: unknown; from?: unknown; email?: boolean } = {},
  options: { fetchImpl?: typeof fetch; provenance?: Provenance } = {},
) {
  const provenance = options.provenance ?? { operation: "send_proposal" };
  const prepared = await withActor(actor, async (db) => {
    const row = await readRow(db, actor, id);
    if (row.status === "completed" || row.status === "client_signed") throw invalid("This has already been signed.", "status");
    if (OPEN.has(row.status) && row.current_version_id) {
      const link = await db.query<{ token_cipher: string }>(
        "select token_cipher from crm.document_links where document_id = $1 and revoked_at is null order by created_at desc limit 1",
        [id],
      );
      if (link.rows[0]) return { row, token: decryptSecret(link.rows[0].token_cipher), versionId: row.current_version_id, resend: true };
    }
    if (row.status !== "draft") throw invalid("Choose Make changes first, then send it again.", "status");
    if (row.template_id) {
      const template = await db.query<{ status: string }>("select status from crm.document_templates where id = $1", [row.template_id]);
      if (template.rows[0] && template.rows[0].status !== "active") throw invalid("Its template isn't active any more. Make the template active to send this.", "template");
    }
    if (row.valid_until && row.valid_until < todayKey()) throw invalid("The valid-until date has passed. Choose a later date.", "validUntil");
    const issuedAt = new Date().toISOString();
    const built = await buildContent(db, actor, row, issuedAt);
    if (built.missing.length) throw invalid(`Fill in ${built.missing.map((item) => `{{${item}}}`).join(", ")} before sending. Add the details to the record, or edit the text.`, "blocks");
    if (built.placeholders.length) throw invalid(`Replace ${built.placeholders.join(", ")} with your own wording before sending.`, "blocks");
    if (!built.contactEmail) throw invalid(`${row.contact_name ?? "The contact"} has no email address.`, "contactId");
    if (row.kind === "proposal" && built.content.items.length === 0) throw invalid("Add at least one product before sending.", "items");
    const number = ((await db.query<{ number: number }>("select coalesce(max(number), 0) + 1 as number from crm.document_versions where document_id = $1", [id])).rows[0]?.number ?? 1);
    const hash = sha256(stableStringify(built.content));
    const version = await db.query<{ id: string }>(
      `insert into crm.document_versions (workspace_id, document_id, number, content, content_hash, created_by) values ($1, $2, $3, $4::jsonb, $5, $6) returning id`,
      [actor.workspaceId, id, number, JSON.stringify(built.content), hash, actor.userId],
    );
    const versionId = version.rows[0].id;
    const pdf = await renderPdf({ content: built.content, contentHash: hash, documentId: id, versionNumber: number });
    await db.query(
      "insert into crm.document_files (workspace_id, document_id, version_id, kind, data, sha256) values ($1, $2, $3, 'issued', $4, $5)",
      [actor.workspaceId, id, versionId, pdf, sha256(pdf)],
    );
    const kept = await db.query<{ token_cipher: string; email: string }>(
      "select token_cipher, email from crm.document_links where document_id = $1 and revoked_at is null order by created_at desc limit 1",
      [id],
    );
    let token: string;
    if (kept.rows[0] && kept.rows[0].email === built.contactEmail.toLowerCase()) {
      token = decryptSecret(kept.rows[0].token_cipher);
    } else {
      token = randomBytes(24).toString("base64url");
      await db.query("update crm.document_links set revoked_at = now() where document_id = $1 and revoked_at is null", [id]);
      await db.query(
        "insert into crm.document_links (workspace_id, document_id, version_id, email, token_hash, token_cipher) values ($1, $2, $3, $4, $5, $6)",
        [actor.workspaceId, id, versionId, built.contactEmail.toLowerCase(), hashToken(token), encryptSecret(token)],
      );
    }
    await db.query(
      "update crm.documents set status = 'sent', current_version_id = $2, sent_at = now(), withdrawn_at = null, declined_at = null, decline_reason = null, updated_at = now() where id = $1",
      [id, versionId],
    );
    await logEvent(db, { workspaceId: actor.workspaceId, documentId: id, versionId, type: "sent", actor: "user", userId: actor.userId, email: built.contactEmail, data: { version: number, hash, emailed: input.email !== false } });
    await recordAudit(db, actor, "document.sent", "document", id, provenance, { version: number, title: row.title });
    return { row, token, versionId, resend: false };
  });
  const url = publicUrl(prepared.token);
  let warning: string | null = null;
  if (input.email !== false) {
    const first = (prepared.row.contact_name ?? "").split(/\s+/)[0] || "there";
    const what = prepared.row.kind === "nda" ? "the non-disclosure agreement" : "our proposal";
    const message =
      typeof input.message === "string" && input.message.trim()
        ? input.message.trim().slice(0, 8000)
        : `Hi ${first},\n\nHere is ${what} for ${prepared.row.company_name}. You can read it, download a PDF and sign it online.`;
    const subject = typeof input.subject === "string" && input.subject.trim() ? input.subject.trim().slice(0, 300) : prepared.row.title;
    try {
      const sent = await sendContactEmail(
        actor,
        prepared.row.contact_id,
        { subject, body: `${message}\n\n${url}`, from: typeof input.from === "string" ? input.from : null },
        options.fetchImpl,
      );
      warning = sent.warning;
    } catch (error) {
      warning = `The proposal is ready, but the email didn't send: ${error instanceof Error ? error.message : "try again"}. You can copy the link instead.`;
    }
    if (prepared.resend) {
      await withActor(actor, (db) =>
        logEvent(db, { workspaceId: actor.workspaceId, documentId: id, versionId: prepared.versionId, type: "resent", actor: "user", userId: actor.userId }),
      );
    }
  }
  return { url, warning };
}

export async function countersignDocument(
  actor: UserActor,
  id: string,
  input: { signatureText?: unknown; title?: unknown; signatureImage?: unknown },
  meta: { ip?: string | null; userAgent?: string | null } = {},
) {
  const signatureText = typeof input.signatureText === "string" ? input.signatureText.replace(/\s+/g, " ").trim() : "";
  if (signatureText.length < 2 || signatureText.length > 200) throw invalid("Type your full name to sign.", "signatureText");
  const image = typeof input.signatureImage === "string" && input.signatureImage.startsWith("data:image/png;base64,") && input.signatureImage.length < 300_000 ? input.signatureImage : null;
  await withActor(actor, async (db) => {
    const row = await readRow(db, actor, id);
    if (row.status !== "client_signed" || !row.current_version_id) throw invalid("It can be countersigned once the client has signed.", "status");
    if (actor.userId !== row.owner_id && actor.role !== "owner" && actor.role !== "admin") throw new CrmError("forbidden", "Only the proposal's owner or an admin can countersign.", 403);
    const version = await db.query<{ content: Content }>("select content from crm.document_versions where id = $1", [row.current_version_id]);
    const content = version.rows[0].content;
    await db.query(
      `insert into crm.document_signatures (workspace_id, document_id, version_id, role, name, email, title, company, signature_text, signature_image, consent, method, user_id, ip, user_agent)
       values ($1, $2, $3, 'sender', $4, $5, $6, $7, $8, $9, $10, 'orbit_login', $11, $12, $13)`,
      [
        actor.workspaceId,
        id,
        row.current_version_id,
        actor.fullName || actor.email,
        actor.email,
        typeof input.title === "string" && input.title.trim() ? input.title.trim().slice(0, 200) : null,
        content.sender.company,
        signatureText,
        image,
        content.consent,
        actor.userId,
        meta.ip?.slice(0, 100) ?? null,
        meta.userAgent?.slice(0, 400) ?? null,
      ],
    );
    await logEvent(db, { workspaceId: actor.workspaceId, documentId: id, versionId: row.current_version_id, type: "countersigned", actor: "user", userId: actor.userId, name: actor.fullName, email: actor.email, ip: meta.ip, userAgent: meta.userAgent });
    await db.query("update crm.documents set status = 'completed', completed_at = now(), updated_at = now() where id = $1", [id]);
    await logEvent(db, { workspaceId: actor.workspaceId, documentId: id, versionId: row.current_version_id, type: "completed", actor: "system" });
    await storeExecuted(db, actor.workspaceId, id, row.current_version_id);
    await recordAudit(db, actor, "document.completed", "document", id, { operation: "countersign_proposal" }, { title: row.title });
  });
  const detail = await getDocument(actor, id);
  if (detail.link) {
    const first = detail.contactName.split(/\s+/)[0] || "there";
    await sendContactEmail(actor, detail.contactId, {
      subject: `Signed: ${detail.title}`,
      body: `Hi ${first},\n\nWe've countersigned ${detail.title}, so it's now fully signed. You can download the signed copy here:\n\n${detail.link}`,
    }).catch((error) => console.error("Signed copy email failed", error));
  }
  return detail;
}

async function storeExecuted(db: Db, workspaceId: string, documentId: string, versionId: string) {
  const version = await db.query<{ number: number; content: Content; content_hash: string }>("select number, content, content_hash from crm.document_versions where id = $1", [versionId]);
  const signatures = await db.query<SignatureRow>(`select ${SIGNATURE_COLUMNS} from crm.document_signatures where version_id = $1 order by signed_at`, [versionId]);
  const events = await db.query<{ type: string; occurred_at: Date; name: string | null; email: string | null; ip: string | null }>(
    "select type, occurred_at, name, email, ip from crm.document_events where document_id = $1 and (version_id = $2 or version_id is null) order by occurred_at, id",
    [documentId, versionId],
  );
  const pdfEvents: PdfEvent[] = events.rows.map((event) => ({ type: event.type, at: new Date(event.occurred_at).toISOString(), who: event.name ?? event.email, ip: event.ip }));
  const pdf = await renderPdf({
    content: version.rows[0].content,
    contentHash: version.rows[0].content_hash,
    documentId,
    versionNumber: version.rows[0].number,
    signatures: signatures.rows.map(toSignature),
    events: pdfEvents,
  });
  await db.query(
    `insert into crm.document_files (workspace_id, document_id, version_id, kind, data, sha256) values ($1, $2, $3, 'executed', $4, $5)
     on conflict (version_id, kind) do nothing`,
    [workspaceId, documentId, versionId, pdf, sha256(pdf)],
  );
}

export async function documentFile(actor: Actor, id: string, kind: "issued" | "executed") {
  return withActor(actor, async (db) => {
    const row = await readRow(db, actor, id);
    if (!row.current_version_id) throw new CrmError("not_found", "There's no PDF until it's sent.", 404);
    const file = await db.query<{ data: Buffer }>("select data from crm.document_files where version_id = $1 and kind = $2", [row.current_version_id, kind]);
    if (!file.rows[0]) throw new CrmError("not_found", kind === "executed" ? "The signed PDF is ready once both parties have signed." : "PDF not found.", 404);
    return { data: file.rows[0].data, filename: `${row.title.replace(/[^\w\s.-]+/g, "").trim().slice(0, 80) || "proposal"}${kind === "executed" ? " (signed)" : ""}.pdf` };
  });
}

export { logEvent, readRow, toSignature, SIGNATURE_COLUMNS, type SignatureRow };

export type DealProposal = { id: string; title: string; status: DocumentSummary["status"]; href: string };

export async function proposalsForDeals(actor: Actor, deals: { id: string; companyId: string | null }[]) {
  const companies = [...new Set(deals.map((deal) => deal.companyId).filter((id): id is string => Boolean(id)))];
  if (companies.length === 0) return {} as Record<string, DealProposal>;
  const rows = await withActor(actor, async (db) => {
    const result = await db.query<{ id: string; title: string; status: DocumentStatus; valid_until: string | null; company_id: string; opportunity_id: string | null }>(
      `select id, title, status, to_char(valid_until, 'YYYY-MM-DD') as valid_until, company_id, opportunity_id from crm.documents
       where workspace_id = $1 and kind = 'proposal' and archived_at is null and company_id = any($2::uuid[])
       order by updated_at desc`,
      [actor.workspaceId, companies],
    );
    return result.rows;
  });
  const map: Record<string, DealProposal> = {};
  for (const deal of deals) {
    const linked = rows.find((row) => row.opportunity_id === deal.id) ?? rows.find((row) => !row.opportunity_id && row.company_id === deal.companyId);
    if (linked) map[deal.id] = { id: linked.id, title: linked.title, status: isExpired(linked.status, linked.valid_until) ? "expired" : linked.status, href: documentHref(linked.id) };
  }
  return map;
}
