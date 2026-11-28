import { z } from "zod";
import { CrmError } from "@/lib/crm/errors";
import type { Actor, Provenance } from "@/lib/crm/types";
import { agentSource, integerParam, parseInput } from "@/lib/crm/validation";
import { deleteDocComment, readDocComments, replyToDocComment, setDocCommentResolved } from "@/lib/docs/comments";
import { searchDocs } from "@/lib/docs/search";
import { archiveDoc, createDoc, getDoc, listDocs, readDoc, updateDoc } from "@/lib/docs/store";
import { DOC_SORTS, type DocEdit, type DocSort } from "@/lib/docs/types";

const provenanceSchema = z.object({ source: z.string().max(200).nullable().optional().transform(agentSource), sourceUrl: z.string().max(1000).nullable().optional() }).strict();

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
    public: z.boolean().optional(),
    allowDownload: z.boolean().optional(),
    allowComments: z.boolean().optional(),
    expiresAt: z.string().max(10).nullable().optional(),
    slug: z.string().max(200).nullable().optional(),
    baseRevision: z.number().int().min(1).optional(),
    provenance: provenanceSchema.optional(),
  })
  .strict();

function provenanceOf(operation: string, value: { source?: string | null; sourceUrl?: string | null } | undefined): Provenance {
  return { operation, source: value?.source ?? "api", sourceUrl: value?.sourceUrl ?? null };
}

export async function listDocsFromQuery(actor: Actor, params: URLSearchParams) {
  const query = params.get("q");
  const limit = integerParam(params, "limit");
  if (query !== null) return { data: await searchDocs(actor, query, { limit, daily: actor.type === "user" }) };
  const sort = params.get("sort");
  const folder = params.get("folderId");
  return listDocs(actor, {
    folderId: folder === "none" ? null : folder ?? undefined,
    tag: params.get("tag") ?? undefined,
    sort: sort && (DOC_SORTS as readonly string[]).includes(sort) ? (sort as DocSort) : undefined,
    archived: params.get("archived") === "true",
    limit,
    offset: integerParam(params, "offset"),
  });
}

export async function createDocFromBody(actor: Actor, body: unknown) {
  const input = parseInput(createSchema, body);
  return { doc: await createDoc(actor, input, provenanceOf("create_doc", input.provenance)) };
}

export async function readDocFromQuery(actor: Actor, id: string, params: URLSearchParams) {
  const offset = integerParam(params, "offset") ?? 0;
  const [doc, window] = await Promise.all([getDoc(actor, id), readDoc(actor, id, offset)]);
  const rest = Object.fromEntries(Object.entries(doc).filter(([key]) => key !== "content"));
  return { doc: { ...rest, characters: window.characters }, offset: window.offset, text: window.text, nextOffset: window.nextOffset };
}

export async function patchDocFromBody(actor: Actor, id: string, body: unknown) {
  const input = parseInput(patchSchema, body);
  const changes = [input.title, input.content, input.append, input.find, input.folderId, input.shared, input.public, input.allowDownload, input.allowComments, input.expiresAt, input.slug].filter((value) => value !== undefined).length;
  if (changes === 0) throw new CrmError("invalid_input", "Send at least one change: title, content, append, find and replace, folderId, shared, public, allowDownload, allowComments, expiresAt or slug.", 400);
  if ((input.find === undefined) !== (input.replace === undefined)) throw new CrmError("invalid_input", "Send find and replace together.", 400, { field: "find" });
  if (input.content !== undefined && (input.append !== undefined || input.find !== undefined)) {
    throw new CrmError("invalid_input", "Send content on its own, or append and find with replace, not both.", 400, { field: "content" });
  }
  const provenance = provenanceOf("update_doc", input.provenance);
  const edits: DocEdit[] = [
    ...(input.content !== undefined ? [{ action: "replace" as const, content: input.content }] : []),
    ...(input.find !== undefined && input.replace !== undefined ? [{ action: "edit" as const, find: input.find, replace: input.replace, all: input.all }] : []),
    ...(input.append !== undefined ? [{ action: "append" as const, content: input.append }] : []),
  ];
  const result = await updateDoc(
    actor,
    id,
    {
      title: input.title,
      edits,
      folderId: input.folderId,
      allowVisibilityChange: input.allowVisibilityChange,
      shared: input.shared,
      public: input.public,
      allowDownload: input.allowDownload,
      allowComments: input.allowComments,
      expiresAt: input.expiresAt,
      slug: input.slug,
      baseRevision: input.baseRevision,
    },
    provenance,
  );
  return { doc: result.doc, ...(result.visibility ? { visibility: result.visibility } : {}) };
}

export async function archiveDocById(actor: Actor, id: string) {
  return { doc: await archiveDoc(actor, id, { operation: "archive_doc", source: "api" }) };
}

const replySchema = z.object({ body: z.string().max(10_000), provenance: provenanceSchema.optional() }).strict();
const resolveSchema = z.object({ resolved: z.boolean(), provenance: provenanceSchema.optional() }).strict();
const removeSchema = z.object({ provenance: provenanceSchema.optional() }).strict();

export async function listCommentsFromRest(actor: Actor, id: string) {
  return readDocComments(actor, id);
}

export async function replyFromBody(actor: Actor, id: string, commentId: string, body: unknown) {
  const input = parseInput(replySchema, body);
  const comment = await replyToDocComment(actor, id, commentId, { body: input.body }, provenanceOf("reply_to_doc_comment", input.provenance));
  return { comment };
}

export async function resolveFromBody(actor: Actor, id: string, commentId: string, body: unknown) {
  const input = parseInput(resolveSchema, body);
  const comment = await setDocCommentResolved(actor, id, commentId, input.resolved, provenanceOf(input.resolved ? "resolve_doc_comment" : "reopen_doc_comment", input.provenance));
  return { comment };
}

export async function deleteCommentFromRest(actor: Actor, id: string, commentId: string, body: unknown) {
  const input = parseInput(removeSchema, body ?? {});
  return deleteDocComment(actor, id, commentId, provenanceOf("delete_doc_comment", input.provenance));
}
