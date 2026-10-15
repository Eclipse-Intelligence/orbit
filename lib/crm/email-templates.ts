import type { Db } from "@/lib/db/pool";
import { withActor } from "@/lib/crm/context";
import { CrmError, isPgError } from "@/lib/crm/errors";
import {
  copyName,
  plainBody,
  TEMPLATE_BODY_MAX,
  TEMPLATE_NAME_MAX,
  TEMPLATE_SUBJECT_MAX,
  type EmailTemplate,
  type EmailTemplateWrite,
  type TemplateTagCount,
} from "@/lib/crm/email-template-rules";
import { iso, isUuid } from "@/lib/crm/mutate";
import {
  likePattern,
  normalizeTag,
  normalizeTags,
  TAG_LIMIT,
} from "@/lib/crm/normalize";
import { assertScope } from "@/lib/crm/scopes";
import type { UserActor } from "@/lib/crm/types";

export {
  matchesTemplate,
  renderTemplate,
  SAMPLE_RECIPIENT,
  TEMPLATE_BODY_MAX,
  TEMPLATE_NAME_MAX,
  TEMPLATE_SUBJECT_MAX,
  type EmailTemplate,
  type EmailTemplateWrite,
  type TemplateTagCount,
} from "@/lib/crm/email-template-rules";

export type EmailTemplateQuery = { search?: string; tag?: string | null };

type TemplateRow = {
  id: string;
  name: string;
  subject: string;
  body: string;
  tags: string[];
  created_by: string | null;
  created_at: Date | string;
  updated_at: Date | string;
  archived_at: Date | string | null;
};

const TEMPLATE_COLUMNS =
  "id, name, subject, body, tags, created_by, created_at, updated_at, archived_at";

function mapTemplate(row: TemplateRow): EmailTemplate {
  return {
    id: row.id,
    name: row.name,
    subject: row.subject,
    body: row.body,
    tags: row.tags ?? [],
    createdBy: row.created_by,
    createdAt: iso(row.created_at)!,
    updatedAt: iso(row.updated_at)!,
    archivedAt: iso(row.archived_at),
  };
}

function invalid(message: string, field: string): never {
  throw new CrmError("invalid_input", message, 400, { field });
}

function notFound(): never {
  throw new CrmError("not_found", "That template no longer exists.", 404);
}

function cleanName(value: unknown) {
  if (typeof value !== "string") invalid("Give the template a name.", "name");
  const name = value.normalize("NFC").replace(/\s+/g, " ").trim();
  if (!name) invalid("Give the template a name.", "name");
  if (name.length > TEMPLATE_NAME_MAX) {
    invalid(
      `Template names must be ${TEMPLATE_NAME_MAX} characters or fewer.`,
      "name",
    );
  }
  return name;
}

function cleanSubject(value: unknown) {
  if (value == null) return "";
  if (typeof value !== "string")
    invalid("The subject must be text.", "subject");
  const subject = value.replace(/\s+/g, " ").trim();
  if (subject.length > TEMPLATE_SUBJECT_MAX) {
    invalid(
      `Subjects must be ${TEMPLATE_SUBJECT_MAX} characters or fewer.`,
      "subject",
    );
  }
  return subject;
}

function cleanBody(value: unknown) {
  if (value == null) return "";
  if (typeof value !== "string") invalid("The message must be text.", "body");
  const body = plainBody(value)
    .replace(/^(?:[ \t]*\n)+/, "")
    .trimEnd();
  if (body.length > TEMPLATE_BODY_MAX) {
    invalid(
      `Messages must be ${TEMPLATE_BODY_MAX.toLocaleString("en-GB")} characters or fewer.`,
      "body",
    );
  }
  return body;
}

function cleanTags(value: unknown) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.some((tag) => typeof tag !== "string")) {
    invalid("Tags must be text.", "tags");
  }
  try {
    return normalizeTags(value as string[]);
  } catch (error) {
    if (error instanceof CrmError && /at most/.test(error.message)) {
      invalid(`A template can have at most ${TAG_LIMIT} tags.`, "tags");
    }
    throw error;
  }
}

export function cleanTemplateWrite(input: unknown, mode: "create" | "patch") {
  if (!input || typeof input !== "object")
    invalid("Send the template details.", "name");
  const source = input as Record<string, unknown>;
  const next: EmailTemplateWrite = {};
  if (mode === "create" || source.name !== undefined)
    next.name = cleanName(source.name);
  if (mode === "create" || source.subject !== undefined)
    next.subject = cleanSubject(source.subject);
  if (mode === "create" || source.body !== undefined)
    next.body = cleanBody(source.body);
  if (mode === "create" || source.tags !== undefined)
    next.tags = cleanTags(source.tags);
  return next;
}

function assertContent(subject: string, body: string) {
  if (!subject && !body) invalid("Add a subject or a message.", "body");
}

function duplicateName(error: unknown, name: string): never {
  if (isPgError(error) && error.code === "23505") {
    throw new CrmError(
      "duplicate",
      `A template called “${name}” already exists.`,
      409,
      {
        field: "name",
      },
    );
  }
  throw error;
}

async function readTemplate(
  db: Db,
  actor: UserActor,
  id: string,
  lock = false,
) {
  if (!isUuid(id)) notFound();
  const result = await db.query<TemplateRow>(
    `select ${TEMPLATE_COLUMNS}
     from crm.email_templates
     where workspace_id = $1 and id = $2 and archived_at is null
     ${lock ? "for update" : ""}`,
    [actor.workspaceId, id],
  );
  if (!result.rows[0]) notFound();
  return result.rows[0];
}

async function insertTemplate(
  db: Db,
  actor: UserActor,
  values: { name: string; subject: string; body: string; tags: string[] },
) {
  try {
    const result = await db.query<TemplateRow>(
      `insert into crm.email_templates (workspace_id, created_by, name, subject, body, tags)
       values ($1, $2, $3, $4, $5, $6::text[])
       returning ${TEMPLATE_COLUMNS}`,
      [
        actor.workspaceId,
        actor.userId,
        values.name,
        values.subject,
        values.body,
        values.tags,
      ],
    );
    return mapTemplate(result.rows[0]);
  } catch (error) {
    duplicateName(error, values.name);
  }
}

export async function listEmailTemplates(
  actor: UserActor,
  query: EmailTemplateQuery = {},
): Promise<EmailTemplate[]> {
  assertScope(actor.scopes, "crm:read");
  return withActor(actor, async (db) => {
    const values: unknown[] = [actor.workspaceId];
    const where = ["workspace_id = $1", "archived_at is null"];
    const tag = query.tag ? normalizeTag(query.tag) : "";
    if (tag) {
      values.push([tag]);
      where.push(`tags @> $${values.length}::text[]`);
    }
    const text = query.search?.trim();
    if (text) {
      values.push(likePattern(text.slice(0, 200)));
      const ref = `$${values.length}`;
      where.push(
        `(name ilike ${ref} escape '\\' or subject ilike ${ref} escape '\\' or body ilike ${ref} escape '\\')`,
      );
    }
    const result = await db.query<TemplateRow>(
      `select ${TEMPLATE_COLUMNS}
       from crm.email_templates
       where ${where.join(" and ")}
       order by updated_at desc, lower(name) asc, id asc
       limit 500`,
      values,
    );
    return result.rows.map(mapTemplate);
  });
}

export async function getEmailTemplate(actor: UserActor, id: string) {
  assertScope(actor.scopes, "crm:read");
  return withActor(actor, async (db) =>
    mapTemplate(await readTemplate(db, actor, id)),
  );
}

export async function createEmailTemplate(actor: UserActor, input: unknown) {
  const values = cleanTemplateWrite(
    input,
    "create",
  ) as Required<EmailTemplateWrite>;
  assertContent(values.subject, values.body);
  return withActor(actor, (db) => insertTemplate(db, actor, values));
}

export async function updateEmailTemplate(
  actor: UserActor,
  id: string,
  input: unknown,
) {
  const patch = cleanTemplateWrite(input, "patch");
  return withActor(actor, async (db) => {
    const current = mapTemplate(await readTemplate(db, actor, id, true));
    const next = {
      name: patch.name ?? current.name,
      subject: patch.subject ?? current.subject,
      body: patch.body ?? current.body,
      tags: patch.tags ?? current.tags,
    };
    assertContent(next.subject, next.body);
    try {
      const result = await db.query<TemplateRow>(
        `update crm.email_templates
         set name = $3, subject = $4, body = $5, tags = $6::text[]
         where workspace_id = $1 and id = $2
         returning ${TEMPLATE_COLUMNS}`,
        [actor.workspaceId, id, next.name, next.subject, next.body, next.tags],
      );
      return mapTemplate(result.rows[0]);
    } catch (error) {
      duplicateName(error, next.name);
    }
  });
}

export async function duplicateEmailTemplate(actor: UserActor, id: string) {
  return withActor(actor, async (db) => {
    const source = mapTemplate(await readTemplate(db, actor, id));
    const names = await db.query<{ name: string }>(
      "select name from crm.email_templates where workspace_id = $1 and archived_at is null",
      [actor.workspaceId],
    );
    return insertTemplate(db, actor, {
      name: copyName(
        source.name,
        names.rows.map((row) => row.name),
      ),
      subject: source.subject,
      body: source.body,
      tags: source.tags,
    });
  });
}

export async function archiveEmailTemplate(actor: UserActor, id: string) {
  return withActor(actor, async (db) => {
    await readTemplate(db, actor, id, true);
    const result = await db.query<TemplateRow>(
      `update crm.email_templates set archived_at = now()
       where workspace_id = $1 and id = $2
       returning ${TEMPLATE_COLUMNS}`,
      [actor.workspaceId, id],
    );
    return mapTemplate(result.rows[0]);
  });
}

export async function deleteEmailTemplate(actor: UserActor, id: string) {
  if (!isUuid(id)) notFound();
  return withActor(actor, async (db) => {
    const result = await db.query(
      "delete from crm.email_templates where workspace_id = $1 and id = $2",
      [actor.workspaceId, id],
    );
    if ((result.rowCount ?? 0) === 0) notFound();
    return { id };
  });
}

export async function listTemplateTags(
  actor: UserActor,
): Promise<TemplateTagCount[]> {
  assertScope(actor.scopes, "crm:read");
  return withActor(actor, async (db) => {
    const result = await db.query<TemplateTagCount>(
      `select tag as name, count(*)::int as templates
       from crm.email_templates, unnest(tags) as tag
       where workspace_id = $1 and archived_at is null
       group by tag
       order by tag`,
      [actor.workspaceId],
    );
    return result.rows;
  });
}
