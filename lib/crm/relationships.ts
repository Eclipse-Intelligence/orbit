import { withActor } from "@/lib/crm/context";
import { readCompanyInDb } from "@/lib/crm/companies";
import { listActivities } from "@/lib/crm/activities";
import { listContacts } from "@/lib/crm/contacts";
import { CrmError } from "@/lib/crm/errors";
import { iso, isUuid } from "@/lib/crm/mutate";
import { listOpportunities } from "@/lib/crm/opportunities";
import { assertScope } from "@/lib/crm/scopes";
import { listTasks } from "@/lib/crm/tasks";
import type {
  Actor,
  CompanyContext,
  DueActions,
  StaleRelationship,
  TaskView,
} from "@/lib/crm/types";
import { TASK_VIEWS } from "@/lib/crm/types";

export async function getCompanyContext(actor: Actor, id: string): Promise<CompanyContext> {
  assertScope(actor.scopes, "crm:read");
  if (!isUuid(id)) throw new CrmError("not_found", "Company not found.", 404);
  const company = await withActor(actor, async (db) => {
    const row = await readCompanyInDb(db, id);
    if (!row || row.workspaceId !== actor.workspaceId) {
      throw new CrmError("not_found", "Company not found.", 404);
    }
    return row;
  });
  const [contacts, opportunities, activities, tasks] = await Promise.all([
    listContacts(actor, { companyId: id, limit: 50 }),
    listOpportunities(actor, { companyId: id, limit: 50 }),
    listActivities(actor, { companyId: id, limit: 30 }),
    listTasks(actor, { companyId: id, limit: 50 }),
  ]);
  const openTasks = tasks.data.filter((task) => !task.completedAt && !task.archivedAt);
  return {
    company,
    contacts: contacts.data,
    opportunities: opportunities.data,
    activities: activities.data,
    tasks: openTasks,
    lastInteraction: activities.data[0] ?? null,
    openTaskCount: openTasks.length,
  };
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
         ) as open_tasks
       from crm.companies c
       left join crm.activities a
         on a.company_id = c.id
        and a.workspace_id = c.workspace_id
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
      const company = await readCompanyInDb(db, item.id);
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

export async function getDueActions(actor: Actor, view: TaskView = "today"): Promise<DueActions> {
  assertScope(actor.scopes, "crm:read");
  if (!(TASK_VIEWS as readonly string[]).includes(view)) {
    throw new CrmError("invalid_input", "That next-action view is not recognised.", 400, {
      field: "view",
    });
  }
  if (view === "none") {
    return withActor(actor, async (db) => {
      const listed = await db.query<{ id: string }>(
        `select c.id
         from crm.companies c
         where c.workspace_id = $1
           and c.archived_at is null
           and not exists (
             select 1
             from crm.tasks t
             where t.company_id = c.id
               and t.archived_at is null
               and t.completed_at is null
           )
         order by c.updated_at desc
         limit 100`,
        [actor.workspaceId],
      );
      const companies = [];
      for (const item of listed.rows) {
        const company = await readCompanyInDb(db, item.id);
        if (company) companies.push(company);
      }
      return { view, tasks: [], companies };
    });
  }
  const tasks = await listTasks(actor, { view, limit: 100 });
  return { view, tasks: tasks.data, companies: [] };
}
