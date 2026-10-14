import type { Db } from "@/lib/db/pool";
import { runBulk } from "@/lib/crm/bulk";
import { editCompanyTags, editCompanyTagsInDb } from "@/lib/crm/companies";
import { editContactTags, editContactTagsInDb } from "@/lib/crm/contacts";
import { withActor } from "@/lib/crm/context";
import { CrmError } from "@/lib/crm/errors";
import { lockNamespace } from "@/lib/crm/mutate";
import { normalizeTag, normalizeTags } from "@/lib/crm/normalize";
import { assertScope } from "@/lib/crm/scopes";
import type { Actor, Provenance, TagCount, TagKind } from "@/lib/crm/types";

export type TagChangeCount = { contacts: number; companies: number };

function web(operation: string): Provenance {
  return { operation, source: "web" };
}

function scopeFor(kind: TagKind) {
  return kind === "contact" ? "contacts:write" : "companies:write";
}

function requestedTags(tags: unknown) {
  if (!Array.isArray(tags) || tags.some((tag) => typeof tag !== "string")) {
    throw new CrmError("invalid_input", "Tags must be text.", 400, { field: "tags" });
  }
  const wanted = normalizeTags(tags as string[]);
  if (wanted.length === 0) {
    throw new CrmError("invalid_input", "Enter a tag.", 400, { field: "tags" });
  }
  return wanted;
}

function tagName(value: unknown, message: string) {
  const name = typeof value === "string" ? normalizeTag(value) : "";
  if (!name) throw new CrmError("invalid_input", message, 400, { field: "name" });
  return name;
}

export function editTags(
  actor: Actor,
  kind: TagKind,
  id: string,
  edit: (tags: string[]) => string[],
  provenance: Provenance,
) {
  return kind === "contact"
    ? editContactTags(actor, id, edit, provenance)
    : editCompanyTags(actor, id, edit, provenance);
}

export async function addTags(actor: Actor, kind: TagKind, ids: unknown, tags: unknown) {
  const wanted = requestedTags(tags);
  return runBulk(actor, scopeFor(kind), ids, (id) =>
    editTags(actor, kind, id, (current) => [...current, ...wanted], web("add_tags")),
  );
}

export async function removeTags(actor: Actor, kind: TagKind, ids: unknown, tags: unknown) {
  const unwanted = new Set(requestedTags(tags));
  return runBulk(actor, scopeFor(kind), ids, (id) =>
    editTags(
      actor,
      kind,
      id,
      (current) => current.filter((tag) => !unwanted.has(tag)),
      web("remove_tags"),
    ),
  );
}

export async function listTags(actor: Actor): Promise<TagCount[]> {
  assertScope(actor.scopes, "crm:read");
  return withActor(actor, async (db) => {
    const result = await db.query<TagCount>(
      `select tag as name,
         count(*) filter (where kind = 'contact')::int as contacts,
         count(*) filter (where kind = 'company')::int as companies
       from (
         select unnest(tags) as tag, 'contact' as kind
         from crm.contacts
         where workspace_id = $1 and archived_at is null
         union all
         select unnest(tags), 'company'
         from crm.companies
         where workspace_id = $1 and archived_at is null
       ) tagged
       group by tag
       order by tag`,
      [actor.workspaceId],
    );
    return result.rows;
  });
}

async function rewriteTag(
  db: Db,
  actor: Actor,
  name: string,
  edit: (tags: string[]) => string[],
  provenance: Provenance,
): Promise<TagChangeCount> {
  await lockNamespace(db, actor.workspaceId, "companies");
  await lockNamespace(db, actor.workspaceId, "contacts");
  const count: TagChangeCount = { contacts: 0, companies: 0 };
  const companies = await db.query<{ id: string }>(
    "select id from crm.companies where workspace_id = $1 and tags @> $2::text[] order by id",
    [actor.workspaceId, [name]],
  );
  for (const row of companies.rows) {
    const result = await editCompanyTagsInDb(db, actor, row.id, edit, provenance);
    if (result.changed) count.companies += 1;
  }
  const contacts = await db.query<{ id: string }>(
    "select id from crm.contacts where workspace_id = $1 and tags @> $2::text[] order by id",
    [actor.workspaceId, [name]],
  );
  for (const row of contacts.rows) {
    const result = await editContactTagsInDb(db, actor, row.id, edit, provenance);
    if (result.changed) count.contacts += 1;
  }
  return count;
}

export async function renameTag(actor: Actor, from: unknown, to: unknown) {
  assertScope(actor.scopes, "contacts:write");
  assertScope(actor.scopes, "companies:write");
  const source = tagName(from, "Choose a tag to rename.");
  if (typeof to !== "string") {
    throw new CrmError("invalid_input", "Enter a new name.", 400, { field: "name" });
  }
  const [target] = normalizeTags([to], "name");
  if (!target) throw new CrmError("invalid_input", "Enter a new name.", 400, { field: "name" });
  if (source === target) return { contacts: 0, companies: 0 };
  return withActor(actor, (db) =>
    rewriteTag(
      db,
      actor,
      source,
      (tags) => tags.map((tag) => (tag === source ? target : tag)),
      web("rename_tag"),
    ),
  );
}

export async function deleteTag(actor: Actor, name: unknown) {
  assertScope(actor.scopes, "contacts:write");
  assertScope(actor.scopes, "companies:write");
  const target = tagName(name, "Choose a tag to delete.");
  return withActor(actor, (db) =>
    rewriteTag(db, actor, target, (tags) => tags.filter((tag) => tag !== target), web("delete_tag")),
  );
}
