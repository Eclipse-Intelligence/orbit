import { assertScope } from "@/lib/crm/scopes";
import { withActor } from "@/lib/crm/context";
import { CrmError } from "@/lib/crm/errors";
import { isUuid, recordAudit } from "@/lib/crm/mutate";
import type { Actor, Provenance } from "@/lib/crm/types";
import {
  BILLINGS,
  blocksSchema,
  DOCUMENT_KINDS,
  settingsSchema,
  TEMPLATE_STATUSES,
  type Billing,
  type Block,
  type DocumentKind,
  type TemplateSettings,
  type TemplateStatus,
} from "@/lib/proposals/model";
import { STARTER_TEMPLATES } from "@/lib/proposals/starters";

export type Product = {
  id: string;
  name: string;
  description: string | null;
  priceGbp: number | null;
  priceUsd: number | null;
  billing: Billing;
  archived: boolean;
  updatedAt: string;
};

export type Template = {
  id: string;
  kind: DocumentKind;
  name: string;
  status: TemplateStatus;
  blocks: Block[];
  settings: TemplateSettings;
  updatedAt: string;
};

type ProductRow = {
  id: string;
  name: string;
  description: string | null;
  price_gbp: string | null;
  price_usd: string | null;
  billing: Billing;
  archived_at: Date | null;
  updated_at: Date;
};

type TemplateRow = { id: string; kind: DocumentKind; name: string; status: TemplateStatus; blocks: unknown; settings: unknown; updated_at: Date };

const PRODUCT_COLUMNS = "id, name, description, price_gbp, price_usd, billing, archived_at, updated_at";
const TEMPLATE_COLUMNS = "id, kind, name, status, blocks, settings, updated_at";

function userId(actor: Actor) {
  return actor.type === "user" ? actor.userId : null;
}

function invalid(message: string, field?: string) {
  return new CrmError("invalid_input", message, 400, field ? { field } : undefined);
}

function toProduct(row: ProductRow): Product {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    priceGbp: row.price_gbp === null ? null : Number(row.price_gbp),
    priceUsd: row.price_usd === null ? null : Number(row.price_usd),
    billing: row.billing,
    archived: Boolean(row.archived_at),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

export function readBlocks(value: unknown): Block[] {
  const parsed = blocksSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const one = blocksSchema.safeParse([entry]);
    return one.success ? one.data : [];
  });
}

const BLOCKS_BYTES_MAX = 380_000;

export function parseBlocks(value: unknown): Block[] {
  if (!Array.isArray(value)) throw invalid("The sections couldn't be read.", "blocks");
  const parsed = blocksSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const index = typeof issue?.path[0] === "number" ? issue.path[0] : null;
    const field = issue?.path.slice(1).filter((part) => typeof part === "string").join(" ");
    const where = index === null ? "A section" : `Section ${index + 1}`;
    const tooBig = issue?.code === "too_big";
    throw invalid(`${where}${field ? ` (${field})` : ""} ${tooBig ? "is too long" : "couldn't be read"}.`, "blocks");
  }
  if (new Set(parsed.data.map((block) => block.id)).size !== parsed.data.length) throw invalid("Two sections share an id.", "blocks");
  if (JSON.stringify(parsed.data).length > BLOCKS_BYTES_MAX) throw invalid("The sections are too long to save. Shorten the text or split it up.", "blocks");
  return parsed.data;
}

export function readSettings(value: unknown): TemplateSettings {
  const parsed = settingsSchema.safeParse(value ?? {});
  return parsed.success ? parsed.data : settingsSchema.parse({});
}

function toTemplate(row: TemplateRow): Template {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    status: row.status,
    blocks: readBlocks(row.blocks),
    settings: readSettings(row.settings),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

function price(value: unknown, field: string) {
  if (value === null || value === undefined || value === "") return null;
  const cleaned = String(value).replace(/[£$,\s]/g, "");
  const number = typeof value === "number" ? value : /^\d+(\.\d{1,2})?$/.test(cleaned) ? Number(cleaned) : NaN;
  if (!Number.isFinite(number) || number < 0 || number > 9_999_999_999) throw invalid("Enter a price of zero or more.", field);
  return Math.round(number * 100) / 100;
}

export type ProductInput = { name?: unknown; description?: unknown; priceGbp?: unknown; priceUsd?: unknown; billing?: unknown };

function readProduct(input: ProductInput, partial: boolean) {
  const out: Record<string, unknown> = {};
  if (!partial || input.name !== undefined) {
    const name = typeof input.name === "string" ? input.name.replace(/\s+/g, " ").trim() : "";
    if (!name || name.length > 120) throw invalid("Give the product a name of up to 120 characters.", "name");
    out.name = name;
  }
  if (!partial || input.description !== undefined) {
    const description = typeof input.description === "string" ? input.description.trim() : "";
    if (description.length > 4000) throw invalid("Keep the description under 4,000 characters.", "description");
    out.description = description || null;
  }
  if (!partial || input.priceGbp !== undefined) out.price_gbp = price(input.priceGbp, "priceGbp");
  if (!partial || input.priceUsd !== undefined) out.price_usd = price(input.priceUsd, "priceUsd");
  if (!partial || input.billing !== undefined) {
    const billing = BILLINGS.find((item) => item === input.billing);
    if (!billing && !(partial && input.billing === undefined)) throw invalid("Choose one-off, monthly or yearly.", "billing");
    out.billing = billing ?? "one_off";
  }
  return out;
}

export async function listProducts(actor: Actor, options: { includeArchived?: boolean } = {}) {
  assertScope(actor.scopes, "crm:read");
  return withActor(actor, async (db) => {
    const result = await db.query<ProductRow>(
      `select ${PRODUCT_COLUMNS} from crm.products where workspace_id = $1 ${options.includeArchived ? "" : "and archived_at is null"} order by archived_at nulls first, lower(name)`,
      [actor.workspaceId],
    );
    return result.rows.map(toProduct);
  });
}

export async function createProduct(actor: Actor, input: ProductInput, provenance?: Provenance) {
  assertScope(actor.scopes, "opportunities:write");
  const values = readProduct(input, false);
  if (values.price_gbp === null && values.price_usd === null) throw invalid("Add a price in pounds, dollars or both.", "priceGbp");
  return withActor(actor, async (db) => {
    const result = await db.query<ProductRow>(
      `insert into crm.products (workspace_id, name, description, price_gbp, price_usd, billing, created_by)
       values ($1, $2, $3, $4, $5, $6, $7) returning ${PRODUCT_COLUMNS}`,
      [actor.workspaceId, values.name, values.description, values.price_gbp, values.price_usd, values.billing, userId(actor)],
    );
    const product = toProduct(result.rows[0]);
    await recordAudit(db, actor, "product.created", "product", product.id, provenance, { after: product });
    return product;
  });
}

export async function updateProduct(actor: Actor, id: string, input: ProductInput & { archived?: unknown }, provenance?: Provenance) {
  assertScope(actor.scopes, "opportunities:write");
  if (!isUuid(id)) throw new CrmError("not_found", "Product not found.", 404);
  const values = readProduct(input, true);
  if (typeof input.archived === "boolean") values.archived_at = input.archived ? new Date().toISOString() : null;
  const keys = Object.keys(values);
  return withActor(actor, async (db) => {
    const result = await db.query<ProductRow>(
      `update crm.products set ${[...keys.map((key, index) => `${key} = $${index + 3}`), "updated_at = now()"].join(", ")}
       where id = $1 and workspace_id = $2 returning ${PRODUCT_COLUMNS}`,
      [id, actor.workspaceId, ...keys.map((key) => values[key])],
    );
    if (!result.rows[0]) throw new CrmError("not_found", "Product not found.", 404);
    const product = toProduct(result.rows[0]);
    if (product.priceGbp === null && product.priceUsd === null) throw invalid("Keep a price in pounds, dollars or both.", "priceGbp");
    await recordAudit(db, actor, "product.updated", "product", product.id, provenance, { after: product });
    return product;
  });
}

export async function listTemplates(actor: Actor, options: { status?: TemplateStatus | "usable"; kind?: DocumentKind } = {}) {
  assertScope(actor.scopes, "crm:read");
  return withActor(actor, async (db) => {
    const values: unknown[] = [actor.workspaceId];
    const where = ["workspace_id = $1"];
    if (options.status === "usable") where.push("status = 'active'");
    else if (options.status) {
      values.push(options.status);
      where.push(`status = $${values.length}`);
    } else where.push("status <> 'archived'");
    if (options.kind) {
      values.push(options.kind);
      where.push(`kind = $${values.length}`);
    }
    const result = await db.query<TemplateRow>(
      `select ${TEMPLATE_COLUMNS} from crm.document_templates where ${where.join(" and ")} order by status = 'active' desc, lower(name)`,
      values,
    );
    return result.rows.map(toTemplate);
  });
}

export async function getTemplate(actor: Actor, id: string) {
  assertScope(actor.scopes, "crm:read");
  if (!isUuid(id)) throw new CrmError("not_found", "Template not found.", 404);
  return withActor(actor, async (db) => {
    const result = await db.query<TemplateRow>(`select ${TEMPLATE_COLUMNS} from crm.document_templates where id = $1 and workspace_id = $2`, [id, actor.workspaceId]);
    if (!result.rows[0]) throw new CrmError("not_found", "Template not found.", 404);
    return toTemplate(result.rows[0]);
  });
}

export async function createTemplate(
  actor: Actor,
  input: { name?: unknown; kind?: unknown; starter?: unknown; copyOf?: unknown },
  provenance?: Provenance,
) {
  assertScope(actor.scopes, "opportunities:write");
  const starter = STARTER_TEMPLATES.find((item) => item.key === input.starter);
  const source = typeof input.copyOf === "string" ? await getTemplate(actor, input.copyOf) : null;
  const kind = source?.kind ?? starter?.kind ?? DOCUMENT_KINDS.find((item) => item === input.kind) ?? "proposal";
  const name =
    (typeof input.name === "string" && input.name.trim()) || (source ? `${source.name} (copy)` : starter?.name ?? (kind === "nda" ? "New NDA" : "New proposal"));
  const blocks = source?.blocks ?? starter?.blocks ?? [{ id: "b1", type: "cover", title: "{{proposal.title}}", subtitle: "Prepared for {{company.name}}" }];
  const settings = source?.settings ?? starter?.settings ?? settingsSchema.parse({});
  return withActor(actor, async (db) => {
    const result = await db.query<TemplateRow>(
      `insert into crm.document_templates (workspace_id, kind, name, status, blocks, settings, created_by)
       values ($1, $2, $3, 'draft', $4::jsonb, $5::jsonb, $6) returning ${TEMPLATE_COLUMNS}`,
      [actor.workspaceId, kind, name.slice(0, 120), JSON.stringify(blocks), JSON.stringify(settings), userId(actor)],
    );
    const template = toTemplate(result.rows[0]);
    await recordAudit(db, actor, "template.created", "document_template", template.id, provenance, { after: { name: template.name, kind } });
    return template;
  });
}

export async function updateTemplate(
  actor: Actor,
  id: string,
  input: { name?: unknown; status?: unknown; blocks?: unknown; settings?: unknown },
  provenance?: Provenance,
) {
  assertScope(actor.scopes, "opportunities:write");
  const current = await getTemplate(actor, id);
  const name = input.name === undefined ? current.name : typeof input.name === "string" ? input.name.replace(/\s+/g, " ").trim() : "";
  if (!name || name.length > 120) throw invalid("Give the template a name of up to 120 characters.", "name");
  const status = input.status === undefined ? current.status : TEMPLATE_STATUSES.find((item) => item === input.status);
  if (!status) throw invalid("Choose draft, active or archived.", "status");
  const blocks = input.blocks === undefined ? current.blocks : parseBlocks(input.blocks);
  let settings = current.settings;
  if (input.settings !== undefined) {
    const parsed = settingsSchema.safeParse(input.settings);
    if (!parsed.success) {
      if (parsed.error.issues.some((issue) => issue.path[0] === "logo")) throw invalid("The logo must be a PNG image of up to about 200 KB.", "logo");
      throw invalid("Use a colour like #4124fb and between 1 and 365 days.", "settings");
    }
    settings = parsed.data;
  }
  if (status === "active" && blocks.length === 0) throw invalid("Add at least one section before making it active.", "status");
  return withActor(actor, async (db) => {
    const result = await db.query<TemplateRow>(
      `update crm.document_templates set name = $3, status = $4, blocks = coalesce($5::jsonb, blocks), settings = $6::jsonb, updated_at = now()
       where id = $1 and workspace_id = $2 returning ${TEMPLATE_COLUMNS}`,
      [id, actor.workspaceId, name, status, input.blocks === undefined ? null : JSON.stringify(blocks), JSON.stringify(settings)],
    );
    const template = toTemplate(result.rows[0]);
    await recordAudit(db, actor, "template.updated", "document_template", template.id, provenance, { after: { name, status } });
    return template;
  });
}
