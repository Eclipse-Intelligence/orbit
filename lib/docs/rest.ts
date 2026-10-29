import { z } from "zod";
import { CrmError } from "@/lib/crm/errors";
import type { Actor, Provenance } from "@/lib/crm/types";
import { parseInput } from "@/lib/crm/validation";
import { searchDocs } from "@/lib/docs/search";
import { archiveDoc, createDoc, editDoc, getDoc, listDocs, moveDoc, readDoc, renameDoc, shareDoc } from "@/lib/docs/store";
import { DOC_SORTS, type DocSort } from "@/lib/docs/types";

const provenanceSchema = z.object({ source: z.string().max(200).nullable().optional(), sourceUrl: z.string().max(1000).nullable().optional() }).strict();

const createSchema = z
  .object({
    title: z.string().max(300),
    content: z.string().max(1_000_000).optional(),
    folderId: z.uuid().optional(),
    shared: z.boolean().optional(),
    provenance: provenanceSchema.optional(),
  })
  .strict();

const patchSchema = z
  .object({
    title: z.string().min(1).max(300).optional(),
    content: z.string().max(1_000_000).optional(),
    append: z.string().max(1_000_000).optional(),
    find: z.string().max(100_000).optional(),
    replace: z.string().max(100_000).optional(),
    all: z.boolean().optional(),
    folderId: z.uuid().nullable().optional(),
    allowVisibilityChange: z.boolean().optional(),
    shared: z.boolean().optional(),
    baseRevision: z.number().int().min(1).optional(),
    provenance: provenanceSchema.optional(),
  })
  .strict();

function provenanceOf(operation: string, value: { source?: string | null; sourceUrl?: string | null } | undefined): Provenance {
  return { operation, source: value?.source ?? "api", sourceUrl: value?.sourceUrl ?? null };
}

export async function listDocsFromQuery(actor: Actor, params: URLSearchParams) {
  const query = params.get("q");
  const limit = params.get("limit") ? Number(params.get("limit")) : undefined;
  if (query !== null) return { data: await searchDocs(actor, query, { limit, daily: actor.type === "user" }) };
  const sort = params.get("sort");
  const folder = params.get("folderId");
  return listDocs(actor, {
    folderId: folder === "none" ? null : folder ?? undefined,
    tag: params.get("tag") ?? undefined,
    sort: sort && (DOC_SORTS as readonly string[]).includes(sort) ? (sort as DocSort) : undefined,
    archived: params.get("archived") === "true",
    limit,
    offset: params.get("offset") ? Number(params.get("offset")) : undefined,
  });
}

export async function createDocFromBody(actor: Actor, body: unknown) {
  const input = parseInput(createSchema, body);
  return { doc: await createDoc(actor, input, provenanceOf("create_doc", input.provenance)) };
}

export async function readDocFromQuery(actor: Actor, id: string, params: URLSearchParams) {
  const offset = Number(params.get("offset") ?? 0);
  const [doc, window] = await Promise.all([getDoc(actor, id), readDoc(actor, id, Number.isFinite(offset) ? offset : 0)]);
  const rest = Object.fromEntries(Object.entries(doc).filter(([key]) => key !== "content"));
  return { doc: { ...rest, characters: window.characters }, offset: window.offset, text: window.text, nextOffset: window.nextOffset };
}

export async function patchDocFromBody(actor: Actor, id: string, body: unknown) {
  const input = parseInput(patchSchema, body);
  const changes = [input.title, input.content, input.append, input.find, input.folderId, input.shared].filter((value) => value !== undefined).length;
  if (changes === 0) throw new CrmError("invalid_input", "Send at least one change: title, content, append, find and replace, folderId or shared.", 400);
  if ((input.find === undefined) !== (input.replace === undefined)) throw new CrmError("invalid_input", "Send find and replace together.", 400, { field: "find" });
  if (input.content !== undefined && (input.append !== undefined || input.find !== undefined)) {
    throw new CrmError("invalid_input", "Send content on its own, or append and find with replace, not both.", 400, { field: "content" });
  }
  const provenance = provenanceOf("update_doc", input.provenance);
  let visibility = null;
  if (input.title !== undefined) await renameDoc(actor, id, input.title, provenance);
  if (input.content !== undefined) await editDoc(actor, id, { action: "replace", content: input.content }, provenance, { baseRevision: input.baseRevision });
  if (input.find !== undefined && input.replace !== undefined) await editDoc(actor, id, { action: "edit", find: input.find, replace: input.replace, all: input.all }, provenance, { baseRevision: input.baseRevision });
  if (input.append !== undefined) await editDoc(actor, id, { action: "append", content: input.append }, provenance);
  if (input.folderId !== undefined) visibility = (await moveDoc(actor, id, { folderId: input.folderId, allowVisibilityChange: input.allowVisibilityChange }, provenance)).visibility;
  if (input.shared !== undefined) visibility = (await shareDoc(actor, id, input.shared, provenance)).visibility;
  return { doc: await getDoc(actor, id), ...(visibility ? { visibility } : {}) };
}

export async function archiveDocById(actor: Actor, id: string) {
  return { doc: await archiveDoc(actor, id, { operation: "archive_doc", source: "api" }) };
}
