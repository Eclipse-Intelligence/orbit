import type { Db } from "@/lib/db/pool";
import { getInsightsForActivities } from "@/lib/crm/call-insights";
import { withActor } from "@/lib/crm/context";
import { readCompaniesInDb, readCompanyInDb } from "@/lib/crm/companies";
import { listActivities, listCompanyTimeline } from "@/lib/crm/activities";
import { listContacts } from "@/lib/crm/contacts";
import { CrmError, notFound } from "@/lib/crm/errors";
import { iso, isUuid } from "@/lib/crm/mutate";
import { listOpportunities } from "@/lib/crm/opportunities";
import { relationshipsFor, relationshipsInDb } from "@/lib/crm/relationship-signals";
import { assertScope } from "@/lib/crm/scopes";
import { listTasks, mineFilter, taggedFilter } from "@/lib/crm/tasks";
import type {
  Actor,
  CompanyContext,
  DueActions,
  RelationshipStatus,
  StaleRelationship,
  TaskView,
} from "@/lib/crm/types";
import { TASK_VIEWS } from "@/lib/crm/types";
import { dayWindow } from "@/lib/time";
import { directTaskSql } from "@/lib/crm/task-access";

export async function getCompanyContext(actor: Actor, id: string): Promise<CompanyContext> {
  assertScope(actor.scopes, "crm:read");
  if (!isUuid(id)) throw notFound("company");
  const company = await withActor(actor, async (db) => {
    const row = await readCompanyInDb(db, id, actor.workspaceId);
    if (!row) {
      throw notFound("company");
    }
    return row;
  });
  const [contacts, opportunities, activities, timeline, tasks] = await Promise.all([
    listContacts(actor, { companyId: id, limit: 50 }),
    listOpportunities(actor, { companyId: id, limit: 50 }),
    listActivities(actor, { companyId: id, limit: 30 }),
    listCompanyTimeline(actor, id, 100),
    listTasks(actor, { companyId: id, limit: 50 }),
  ]);
  const openTasks = tasks.data.filter((task) => !task.completedAt && !task.archivedAt);
  const relationship = (await relationshipsFor(actor, "company", [id]))[id];
  const insights = await getInsightsForActivities(
    actor,
    timeline.filter((activity) => activity.type === "call" || activity.type === "meeting").map((activity) => activity.id),
  );
  return {
    company,
    contacts: contacts.data,
    opportunities: opportunities.data,
    activities: activities.data,
    timeline,
    insights,
    tasks: openTasks,
    lastInteraction: activities.data[0] ?? null,
    openTaskCount: openTasks.length,
    relationshipStatus: relationshipStatus(activities.data[0] ?? null, openTasks.length),
    relationship,
  };
}

function relationshipStatus(
  last: { occurredAt: string } | null,
  openTaskCount: number,
): RelationshipStatus {
  if (!last) return openTaskCount > 0 ? "active" : "new";
  const days = (Date.now() - new Date(last.occurredAt).getTime()) / 86_400_000;
  if (days > 21) return "quiet";
  if (openTaskCount === 0) return "needs_action";
  return "active";
}

export async function findStaleRelationships(
  actor: Actor,
  days = 21,
  limit = 50,
): Promise<StaleRelationship[]> {
  assertScope(actor.scopes, "crm:read");
  const windowDays = Math.min(3650, Math.max(1, Math.trunc(days) || 21));
  const rowLimit = Math.min(100, Math.max(1, Math.trunc(limit) || 50));
  return withActor(actor, async (db) => {
    const stale = await db.query<{ id: string; last_at: Date | string | null; open_tasks: number }>(
      `select
         c.id,
         max(a.occurred_at) as last_at,
         (
           select count(*)::int
           from crm.tasks t
           where t.company_id = c.id
             and t.archived_at is null
             and t.completed_at is null
             and ${directTaskSql("t")}
         ) as open_tasks
       from crm.companies c
       left join crm.activities a
         on a.company_id = c.id
        and a.workspace_id = c.workspace_id
        and a.archived_at is null
       where c.workspace_id = $1
         and c.archived_at is null
       group by c.id
       having max(a.occurred_at) is null
           or max(a.occurred_at) < now() - make_interval(days => $2::int)
       order by max(a.occurred_at) asc nulls first, c.name asc
       limit $3`,
      [actor.workspaceId, windowDays, rowLimit],
    );
    const now = Date.now();
    const rows: StaleRelationship[] = [];
    for (const item of stale.rows) {
      const company = await readCompanyInDb(db, item.id, actor.workspaceId);
      if (!company) continue;
      const lastActivityAt = iso(item.last_at);
      rows.push({
        company,
        lastActivityAt,
        openTaskCount: item.open_tasks,
        daysSinceActivity: lastActivityAt
          ? Math.floor((now - new Date(lastActivityAt).getTime()) / 86_400_000)
          : null,
      });
    }
    return rows;
  });
}

export async function listAttention(actor: Actor) {
  const [overdue, today] = await Promise.all([
    getDueActions(actor, "overdue", { mine: true }),
    getDueActions(actor, "today", { mine: true }),
  ]);
  return {
    overdue: overdue.tasks.slice(0, 8),
    today: today.tasks.slice(0, 8),
  };
}

export async function countTaskViews(actor: Actor, options: { mine?: boolean; tagged?: boolean } = {}): Promise<Record<TaskView, number>> {
  assertScope(actor.scopes, "crm:read");
  const window = dayWindow();
  return withActor(actor, async (db) => {
    const values: unknown[] = [
      actor.workspaceId,
      window.start.toISOString(),
      window.end.toISOString(),
      new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString(),
    ];
    const scope = options.tagged
      ? taggedFilter(actor, values)
      : [directTaskSql("t"), options.mine ? mineFilter(actor, values) : null].filter(Boolean).join(" and ");
    const result = await db.query<Record<TaskView, number>>(
      `select
         count(*) filter (where t.completed_at is null)::int as "all",
         count(*) filter (where t.completed_at is null and t.due_at < $2)::int as overdue,
         count(*) filter (
           where t.completed_at is null and (t.due_at is null or (t.due_at >= $2 and t.due_at < $3))
         )::int as today,
         count(*) filter (where t.completed_at is null and t.due_at >= $3)::int as upcoming,
         count(*) filter (where t.completed_at >= $4)::int as completed,
         (
           select count(*)::int
           from crm.companies c
           where c.workspace_id = $1
             and c.archived_at is null
             and not exists (
               select 1
               from crm.tasks open_task
               where open_task.company_id = c.id
                 and open_task.archived_at is null
                 and open_task.completed_at is null
                 and ${directTaskSql("open_task")}
             )
         ) as none
       from crm.tasks t
       where t.workspace_id = $1 and t.archived_at is null and ${scope}`,
      values,
    );
    const row = result.rows[0];
    return Object.fromEntries(TASK_VIEWS.map((view) => [view, row?.[view] ?? 0])) as Record<
      TaskView,
      number
    >;
  });
}

export const PAGE_SIZE = 100;
export const MAX_OFFSET = 10_000;

export async function getDueActions(
  actor: Actor,
  view: TaskView = "today",
  options: { mine?: boolean; tagged?: boolean; offset?: number } = {},
): Promise<DueActions> {
  assertScope(actor.scopes, "crm:read");
  if (!(TASK_VIEWS as readonly string[]).includes(view)) {
    throw new CrmError("invalid_input", "Unknown task view.", 400, {
      field: "view",
    });
  }
  const offset = Math.min(MAX_OFFSET, Math.max(0, Math.floor(options.offset ?? 0)));
  if (view === "none") {
    return withActor(actor, async (db) => {
      const listed = await db.query<{ id: string; total: number }>(
        `select c.id, count(*) over ()::int as total
         from crm.companies c
         where c.workspace_id = $1
           and c.archived_at is null
           and not exists (
             select 1
             from crm.tasks t
             where t.company_id = c.id
               and t.archived_at is null
               and t.completed_at is null
               and ${directTaskSql("t")}
           )
         order by c.updated_at desc, c.id
         limit $2 offset $3`,
        [actor.workspaceId, PAGE_SIZE, offset],
      );
      const total = listed.rows[0]?.total ?? (offset > 0 ? await countWithoutTasks(db, actor) : 0);
      const companies = await readCompaniesInDb(db, actor.workspaceId, listed.rows.map((row) => row.id));
      const relationships = await relationshipsInDb(db, actor.workspaceId, "company", companies.map((company) => company.id));
      return {
        view,
        tasks: [],
        companies: companies.map((company) => ({ ...company, relationship: relationships[company.id] })),
        total,
      };
    });
  }
  const listed = await listTasks(actor, { view, limit: PAGE_SIZE, offset, mine: options.mine, tagged: options.tagged });
  return { view, tasks: listed.data, companies: [], total: listed.total };
}

async function countWithoutTasks(db: Db, actor: Actor) {
  const counted = await db.query<{ total: number }>(
    `select count(*)::int as total
     from crm.companies c
     where c.workspace_id = $1 and c.archived_at is null
       and not exists (
         select 1 from crm.tasks t
         where t.company_id = c.id and t.archived_at is null and t.completed_at is null and ${directTaskSql("t")}
       )`,
    [actor.workspaceId],
  );
  return counted.rows[0]?.total ?? 0;
}
