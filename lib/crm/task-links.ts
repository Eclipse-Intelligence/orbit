import { withActor } from "@/lib/crm/context";
import { CrmError, notFound } from "@/lib/crm/errors";
import { isUuid } from "@/lib/crm/mutate";
import { assertScope } from "@/lib/crm/scopes";
import { detectedIds, detectTaskRecordsInDb, folded, memberNames, mentionsName, MIN_NAME, quotesFoldedSql, TEXT_LIMIT, type DetectedLinkIds } from "@/lib/crm/task-detect";
import { straightQuotes } from "@/lib/task-pad";
import { canChangeTask, updateTaskInDb } from "@/lib/crm/tasks";
import type { Actor, Provenance, UserActor } from "@/lib/crm/types";

export type LinkCandidate = {
  kind: "contact" | "company";
  id: string;
  name: string;
  detail: string | null;
};

export type LinkCandidates = { candidates: LinkCandidate[]; reason: string | null };

const LINK_FIELDS = ["companyId", "contactId", "opportunityId"];

function titleWords(title: string) {
  const words = (title.match(/[\p{L}][\p{L}'’-]*/gu) ?? []).map((word) => word.replace(/['’]s$/iu, "").replace(/['’-]+$/u, ""));
  return [...new Set(words.filter((word) => word.length >= 2).map((word) => folded(word)))];
}

function displayWord(title: string, word: string) {
  const found = (title.match(/[\p{L}][\p{L}'’-]*/gu) ?? []).find((item) => folded(item.replace(/['’]s$/iu, "")) === word);
  return found ? found.replace(/['’]s$/iu, "") : word;
}

export async function taskLinkCandidates(actor: Actor, taskId: string): Promise<LinkCandidates> {
  assertScope(actor.scopes, "crm:read");
  if (!isUuid(taskId)) throw notFound("task");
  return withActor(actor, async (db) => {
    const task = await db.query<{ title: string; company_id: string | null; contact_id: string | null; opportunity_id: string | null }>(
      "select title, company_id, contact_id, opportunity_id from crm.tasks where id = $1 and workspace_id = $2",
      [taskId, actor.workspaceId],
    );
    const row = task.rows[0];
    if (!row) throw notFound("task");
    if (row.company_id || row.contact_id || row.opportunity_id) return { candidates: [], reason: null };
    const title = row.title.slice(0, TEXT_LIMIT);
    const members = await memberNames(db, actor.workspaceId);
    const words = titleWords(title);
    const contacts = await db.query<{ id: string; name: string; first: string | null; last: string | null; job_title: string | null; company_name: string | null; full: boolean }>(
      `select c.id, trim(concat_ws(' ', c.first_name, c.last_name)) as name, lower(${quotesFoldedSql("trim(c.first_name)")}) as first, lower(${quotesFoldedSql("trim(c.last_name)")}) as last,
         c.job_title, co.name as company_name,
         strpos(lower($2), lower(${quotesFoldedSql("trim(concat_ws(' ', c.first_name, c.last_name))")})) > 0 as full
       from crm.contacts c
       left join crm.companies co on co.id = c.company_id
       where c.workspace_id = $1 and c.archived_at is null
         and char_length(trim(concat_ws(' ', c.first_name, c.last_name))) >= 2
         and (
           strpos(lower($2), lower(${quotesFoldedSql("trim(concat_ws(' ', c.first_name, c.last_name))")})) > 0
           or lower(${quotesFoldedSql("trim(c.first_name)")}) = any($3::text[])
           or lower(${quotesFoldedSql("trim(c.last_name)")}) = any($3::text[])
         )
       order by 7 desc, c.updated_at desc
       limit 40`,
      [actor.workspaceId, straightQuotes(title), words],
    );
    const companies = await db.query<{ id: string; name: string; domain: string | null }>(
      `select id, name, domain from crm.companies
       where workspace_id = $1 and archived_at is null and char_length(name) >= $3
         and strpos(lower($2), lower(${quotesFoldedSql("name")})) > 0
       order by char_length(name) desc, updated_at desc limit 20`,
      [actor.workspaceId, straightQuotes(title), MIN_NAME],
    );
    const named = contacts.rows
      .filter((contact) => !members.has(folded(contact.name)))
      .filter((contact) => (contact.full ? mentionsName(title, contact.name) : true));
    const people = named.slice(0, 8).map((contact) => ({
      kind: "contact" as const,
      id: contact.id,
      name: contact.name,
      detail: [contact.job_title, contact.company_name].filter(Boolean).join(" · ") || null,
    }));
    const places = companies.rows
      .filter((company) => !members.has(folded(company.name)) && mentionsName(title, company.name))
      .slice(0, 4)
      .map((company) => ({ kind: "company" as const, id: company.id, name: company.name, detail: company.domain }));
    const partial = [...new Set(named.filter((contact) => !contact.full).flatMap((contact) => [contact.first, contact.last]).filter((word): word is string => Boolean(word) && words.includes(word as string)))];
    const counts = partial.length
      ? await db.query<{ word: string; count: number }>(
          `select word, count(c.id)::int as count
           from unnest($2::text[]) as word
           join crm.contacts c on c.workspace_id = $1 and c.archived_at is null and (lower(${quotesFoldedSql("trim(c.first_name)")}) = word or lower(${quotesFoldedSql("trim(c.last_name)")}) = word)
             and lower(regexp_replace(${quotesFoldedSql("trim(concat_ws(' ', c.first_name, c.last_name))")}, '\s+', ' ', 'g')) <> all($3::text[])
           group by word order by min(array_position($2::text[], word))`,
          [actor.workspaceId, partial.sort((left, right) => words.indexOf(left) - words.indexOf(right)), [...members]],
        )
      : { rows: [] };
    const shared = counts.rows.find((entry) => entry.count > 1);
    const reason = shared ? `${displayWord(title, shared.word)} matches ${shared.count} contacts, so nothing was linked.` : null;
    return { candidates: [...people, ...places], reason };
  });
}

export async function linkTask(actor: Actor, taskId: string, link: { contactId?: string; companyId?: string }, provenance: Provenance) {
  assertScope(actor.scopes, "tasks:write");
  if (!isUuid(taskId)) throw notFound("task");
  const contactId = link.contactId && isUuid(link.contactId) ? link.contactId : undefined;
  const companyId = !contactId && link.companyId && isUuid(link.companyId) ? link.companyId : undefined;
  if (!contactId && !companyId) throw new CrmError("invalid_input", "Choose a person or company.", 400);
  return withActor(actor, async (db) => {
    const current = await db.query<{ owner_id: string | null; created_by_user_id: string | null; linked: boolean }>(
      `select owner_id, created_by_user_id, (company_id is not null or contact_id is not null or opportunity_id is not null) as linked
       from crm.tasks where id = $1 and workspace_id = $2 for update`,
      [taskId, actor.workspaceId],
    );
    const row = current.rows[0];
    if (!row) throw notFound("task");
    if (!canChangeTask(actor, { ownerId: row.owner_id, createdByUserId: row.created_by_user_id })) {
      throw new CrmError("forbidden", "Only the assignee, the task's creator, a workspace owner or an admin can change it.", 403);
    }
    if (row.linked) throw new CrmError("conflict", "This task is already linked.", 409);
    const updated = await updateTaskInDb(db, actor, taskId, contactId ? { contactId } : { companyId }, provenance);
    return updated.task;
  });
}

export type BackfillResult = {
  workspaceId: string;
  checked: number;
  linked: number;
  failed: number;
  tasks: { id: string; title: string; links: DetectedLinkIds }[];
};

export async function backfillTaskLinks(actor: UserActor, options: { dryRun?: boolean; batch?: number } = {}): Promise<BackfillResult> {
  const batch = Math.max(1, Math.min(options.batch ?? 200, 1000));
  const result: BackfillResult = { workspaceId: actor.workspaceId, checked: 0, linked: 0, failed: 0, tasks: [] };
  let after = "00000000-0000-0000-0000-000000000000";
  for (;;) {
    const page = await withActor(actor, (db) =>
      db.query<{ id: string; title: string }>(
        `select t.id, t.title from crm.tasks t
         where t.workspace_id = $1 and t.archived_at is null and t.completed_at is null
           and t.company_id is null and t.contact_id is null and t.opportunity_id is null
           and t.id > $2
           and not exists (
             select 1 from crm.audit_events e
             where e.workspace_id = t.workspace_id and e.entity_type = 'task' and e.entity_id = t.id
               and (
                 (e.event_type = 'task.created' and e.source = 'workflow')
                 or (jsonb_typeof(e.changes -> 'fields') = 'array' and (e.changes -> 'fields') ?| $4::text[])
               )
           )
         order by t.id limit $3`,
        [actor.workspaceId, after, batch, LINK_FIELDS],
      ),
    );
    if (page.rows.length === 0) break;
    after = page.rows[page.rows.length - 1].id;
    for (const task of page.rows) {
      result.checked += 1;
      try {
        const linked = await withActor(actor, async (db) => {
          const links = detectedIds(await detectTaskRecordsInDb(db, actor.workspaceId, task.title));
          if (Object.keys(links).length === 0) return null;
          if (options.dryRun) return links;
          const fresh = await db.query(
            "select 1 from crm.tasks where id = $1 and company_id is null and contact_id is null and opportunity_id is null for update",
            [task.id],
          );
          if (fresh.rowCount === 0) return null;
          await updateTaskInDb(db, actor, task.id, links, { operation: "backfill_task_links", source: "backfill", automatic: true, catchUp: true });
          return links;
        });
        if (linked) {
          result.linked += 1;
          result.tasks.push({ id: task.id, title: task.title, links: linked });
        }
      } catch (error) {
        result.failed += 1;
        console.error(`Couldn't link task ${task.id}`, error instanceof Error ? error.message : error);
      }
    }
  }
  return result;
}
