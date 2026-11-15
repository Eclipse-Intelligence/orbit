import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createCompany } from "@/lib/crm/companies";
import { moveRecordsToWorkspace } from "@/lib/crm/move-workspace";
import { scopesForRole } from "@/lib/crm/scopes";
import { createRepeatingTask, rollDueSeries, updateOccurrence } from "@/lib/crm/task-series";
import { getTask, removeTaskParticipant } from "@/lib/crm/tasks";
import { removeMember } from "@/lib/crm/team";
import type { UserActor, WorkspaceRole } from "@/lib/crm/types";
import { undoAuditEvent } from "@/lib/crm/undo";
import { createWorkspace } from "@/lib/crm/workspaces";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { createAgent, createUser, resetDatabase } from "./helpers";

let mark: UserActor;
let sam: UserActor;
let priya: UserActor;

async function sql<T extends Record<string, unknown>>(text: string, values: unknown[] = []) {
  return (await getAdminPool().query<T>(text, values)).rows;
}

async function join(user: UserActor, role: WorkspaceRole): Promise<UserActor> {
  await sql("insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, $3)", [mark.workspaceId, user.userId, role]);
  return { ...user, workspaceId: mark.workspaceId, workspaceName: mark.workspaceName, role, scopes: scopesForRole(role) };
}

async function as(user: UserActor, text: string, values: unknown[] = [], settings: Record<string, string> = {}) {
  const client = await getPool().connect();
  try {
    await client.query("begin");
    await client.query("set local role authenticated");
    await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: user.userId, role: "authenticated" })]);
    for (const [name, value] of Object.entries(settings)) await client.query("select set_config($1, $2, true)", [name, value]);
    const result = await client.query(text, values);
    await client.query("commit");
    return result.rows;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

function at(day: string, time: string) {
  return new Date(`${day}T${time}:00Z`).toISOString();
}

async function seriesRow(id: string) {
  const [row] = await sql<{ workspace_id: string; company_id: string | null; at: string | null; current_task_id: string | null }>(
    "select workspace_id, company_id, to_char(at, 'HH24:MI') as at, current_task_id from crm.task_series where id = $1",
    [id],
  );
  return row;
}

async function laterPart(seriesId: string) {
  return (await sql<{ id: string }>("select id from crm.task_series where split_from_id = $1", [seriesId]))[0].id;
}

before(async () => {
  await resetDatabase();
  mark = await createUser("mark@series-sql.test", "Mark Ridgeon");
  sam = await join(await createUser("sam@series-sql.test", "Sam Okafor"), "member");
  priya = await join(await createUser("priya@series-sql.test", "Priya Nair"), "member");
});

after(async () => {
  await getPool().end();
  await getAdminPool().end();
});

describe("repeating tasks moving workspace", () => {
  it("moves a series whose later part is on another company, clearing only that link (2)", async () => {
    const other = await createWorkspace(mark, { name: "Series elsewhere" });
    const moving = (await createCompany(mark, { name: "Moving Co", domain: "moving-co.test" })).body.company;
    const staying = (await createCompany(mark, { name: "Staying Co", domain: "staying-co.test" })).body.company;
    const task = (await createRepeatingTask(mark, { title: "Moving weekly", dueAt: at("2031-03-04", "09:00"), companyId: moving.id }, { every: "week" })).body.task;
    await updateOccurrence(mark, { seriesId: task.seriesId!, occursOn: "2031-03-18" }, { title: "Moving later" }, "following");
    const later = await laterPart(task.seriesId!);
    await sql("update crm.task_series set company_id = $2 where id = $1", [later, staying.id]);
    await moveRecordsToWorkspace(mark, { companyIds: [moving.id], workspaceId: other.id }, { operation: "move_records", source: "web" });
    assert.deepEqual([(await seriesRow(later)).workspace_id, (await seriesRow(later)).company_id], [other.id, null]);
  });

  it("points a series and its later part at the company it merged into, and records it (2, 72, 73)", async () => {
    const other = await createWorkspace(mark, { name: "Series merged" });
    const there: UserActor = { ...mark, workspaceId: other.id, workspaceName: "Series merged", role: "owner", scopes: scopesForRole("owner") };
    const kept = (await createCompany(there, { name: "Merge Co There", domain: "merge-co.test" })).body.company;
    const moving = (await createCompany(mark, { name: "Merge Co", domain: "merge-co.test" })).body.company;
    const task = (await createRepeatingTask(mark, { title: "Merge weekly", dueAt: at("2031-04-01", "09:00"), companyId: moving.id }, { every: "week" })).body.task;
    await updateOccurrence(mark, { seriesId: task.seriesId!, occursOn: "2031-04-15" }, { title: "Merge later" }, "following");
    const later = await laterPart(task.seriesId!);
    await moveRecordsToWorkspace(mark, { companyIds: [moving.id], workspaceId: other.id }, { operation: "move_records", source: "web" });
    assert.equal((await seriesRow(task.seriesId!)).company_id, kept.id);
    assert.equal((await seriesRow(later)).company_id, kept.id);
    const recorded = await sql<{ id: string; changes: { fields: string[]; movedFrom: { id: string } } }>(
      "select id, changes from crm.audit_events where entity_id = $1 and event_type = 'task_series.updated' and changes -> 'series' ->> 'id' = $2 and changes ? 'movedFrom'",
      [task.id, task.seriesId],
    );
    assert.deepEqual(recorded[0].changes.fields, ["workspaceId", "companyId"]);
    assert.equal(recorded[0].changes.movedFrom.id, mark.workspaceId);
    await assert.rejects(undoAuditEvent(there, recorded[0].id, { operation: "undo_change" }), /Can't undo/);
  });
});

describe("repeating tasks when someone is removed", () => {
  it("makes their changed dates date only and reaches the remover's webhook, also for a part not yet started (33, 75, 76)", async () => {
    const leaving = await join(await createUser("leaving@series-sql.test", "Lee Leaving"), "member");
    const task = (await createRepeatingTask(leaving, { title: "Leaving weekly", dueAt: at("2031-05-06", "09:00") }, { every: "week" })).body.task;
    await updateOccurrence(leaving, { seriesId: task.seriesId!, occursOn: "2031-05-13" }, { dueAt: at("2031-05-13", "15:00") }, "this");
    await updateOccurrence(leaving, { seriesId: task.seriesId!, occursOn: "2031-05-27" }, { title: "Leaving later" }, "following");
    await updateOccurrence(leaving, { taskId: task.id }, { ownerId: priya.userId }, "this");
    const later = await laterPart(task.seriesId!);
    const [endpoint] = await sql<{ id: string }>(
      "insert into crm.webhook_endpoints (workspace_id, url, secret, events, created_by_user_id) values ($1, 'https://hooks.example.com/series', 'secret', array['task_series.updated'], $2) returning id",
      [mark.workspaceId, mark.userId],
    );
    await removeMember(mark, leaving.userId);
    const [change] = await sql<{ due_has_time: boolean }>("select due_has_time from crm.task_occurrence_changes where series_id = $1 and occurs_on = '2031-05-13'", [task.seriesId]);
    assert.equal(change.due_has_time, false);
    const delivered = await sql<{ series: string }>(
      "select payload -> 'data' -> 'series' ->> 'id' as series from crm.webhook_deliveries where endpoint_id = $1 order by series",
      [endpoint.id],
    );
    assert.deepEqual(delivered.map((row) => row.series).sort(), [task.seriesId, later].sort());
  });
});

describe("repeating tasks made for a colleague when their creator is removed", () => {
  it("hands the creator role to the assignee and keeps the task hidden from the remover", async () => {
    const leaving = await join(await createUser("lee-maker@series-sql.test", "Lee Maker"), "member");
    const task = (await createRepeatingTask(leaving, { title: "Made for Priya", dueAt: at("2031-05-06", "09:00"), ownerId: priya.userId }, { every: "week" })).body.task;
    await removeMember(mark, leaving.userId);
    const [row] = await sql<{ created_by_user_id: string }>("select created_by_user_id from crm.task_series where id = $1", [task.seriesId]);
    assert.equal(row.created_by_user_id, priya.userId);
    await assert.rejects(getTask(mark, task.id));
  });
});

describe("repeating task database backstops", () => {
  it("keeps the series' owner tagged on a handed-on open task (13)", async () => {
    const task = (await createRepeatingTask(mark, { title: "Keep me tagged", dueAt: at("2031-06-03", "09:00") }, { every: "week" })).body.task;
    await updateOccurrence(mark, { taskId: task.id }, { ownerId: priya.userId }, "this");
    await assert.rejects(removeTaskParticipant(priya, task.id, mark.userId), /can't remove them/);
    assert.equal((await getTask(mark, task.id)).ownerId, priya.userId);
  });

  it("keeps the series' owner from untagging themselves from a handed-on open task", async () => {
    const task = (await createRepeatingTask(mark, { title: "Stay tagged", dueDate: "2032-09-07" }, { every: "week" })).body.task;
    await updateOccurrence(mark, { taskId: task.id }, { ownerId: sam.userId }, "this");
    await assert.rejects(removeTaskParticipant(mark, task.id, mark.userId), /can't remove them/);
    assert.equal((await getTask(mark, task.id)).id, task.id);
  });

  it("keeps an agent's series rolling after the assignee tries to untag the owner (12)", async () => {
    const { actor: agent } = await createAgent(mark.workspaceId, ["crm:read", "tasks:write"], "Series SQL agent");
    const task = (await createRepeatingTask(agent, { title: "Agent roll", dueDate: "2031-07-01" }, { every: "week" })).body.task;
    await updateOccurrence(agent, { taskId: task.id }, { ownerId: sam.userId }, "this");
    await assert.rejects(removeTaskParticipant(sam, task.id, mark.userId));
    await sql("update crm.task_series set archived_at = now() where id <> $1 and archived_at is null", [task.seriesId]);
    const rolled = await rollDueSeries({ deadline: Date.now() + 10_000, now: Date.parse("2031-07-08T01:00:00Z") });
    assert.equal(rolled.rolled, 1);
  });

  it("tells a colleague only whether someone is at the limit, not how many they have (71)", async () => {
    await createRepeatingTask(mark, { title: "Counted", dueDate: "2031-08-05" }, { every: "week" });
    assert.deepEqual(await as(sam, "select * from crm.series_at_limit($1, $2)", [mark.workspaceId, mark.userId]), [{ at_limit: false, keeper: mark.userId }]);
    await assert.rejects(as(sam, "select * from crm.series_at_limit($1, $2, 1)", [mark.workspaceId, mark.userId]), /does not exist/);
  });

  it("refuses an untagged owner taking a handed-on task back (79)", async () => {
    const task = (await createRepeatingTask(priya, { title: "No blind re-own", dueDate: "2032-04-06", ownerId: mark.userId }, { every: "week" })).body.task;
    await updateOccurrence(mark, { taskId: task.id }, { ownerId: sam.userId }, "this");
    await sql("delete from crm.task_participants where task_id = $1 and user_id = $2", [task.id, mark.userId]);
    assert.deepEqual(await as(mark, "update crm.tasks set owner_id = $2 where id = $1 returning id", [task.id, mark.userId]), []);
  });

  it("refuses a handed-on assignee ending a series that never ends (80)", async () => {
    const task = (await createRepeatingTask(mark, { title: "Not yours to end", dueDate: "2032-05-04" }, { every: "week" })).body.task;
    await updateOccurrence(mark, { taskId: task.id }, { ownerId: sam.userId }, "this");
    await as(sam, "update crm.tasks set archived_at = now() where id = $1", [task.id]);
    await as(sam, "select crm.series_end_with_archived($1)", [task.id]);
    const [row] = await sql<{ ended: boolean }>("select ended_at is not null as ended from crm.task_series where id = $1", [task.seriesId]);
    assert.equal(row.ended, false);
  });

  it("refuses a done occurrence's assignee inserting a far-off task in the owner's name (78)", async () => {
    const task = (await createRepeatingTask(mark, { title: "No far date", dueDate: "2032-06-01" }, { every: "week" })).body.task;
    await updateOccurrence(mark, { taskId: task.id }, { ownerId: priya.userId }, "this");
    await sql("update crm.tasks set completed_at = now() where id = $1", [task.id]);
    await assert.rejects(
      as(priya, "insert into crm.tasks (workspace_id, title, owner_id, created_by_user_id, series_id, occurs_on, due_at) values ($1, 'Far', $2, $2, $3, '2040-06-05', now())", [mark.workspaceId, mark.userId, task.seriesId]),
      /row-level security/,
    );
  });

  it("lets the owner start a later part of an agent's series with the agent kept as creator, and no one else", async () => {
    const { actor: agent } = await createAgent(mark.workspaceId, ["crm:read", "tasks:write"], "Series SQL agent three");
    const task = (await createRepeatingTask(agent, { title: "Agent split", dueDate: "2032-08-03" }, { every: "week" })).body.task;
    const part = "insert into crm.task_series (workspace_id, created_by_agent_id, owner_id, title, starts_on, rule, split_from_id) values ($1, $2, $3, 'Agent split later', '2032-08-17', '{\"freq\":\"weekly\",\"interval\":1,\"weekdays\":[\"tu\"]}'::jsonb, $4) returning id";
    const values = [mark.workspaceId, agent.agentId, mark.userId, task.seriesId];
    await assert.rejects(as(sam, part, values));
    assert.equal((await as(mark, part, values)).length, 1);
  });

  it("shows a split series' later parts only to people who can see its open task", async () => {
    const task = (await createRepeatingTask(mark, { title: "Parts", dueDate: "2032-07-06" }, { every: "week" })).body.task;
    await updateOccurrence(mark, { seriesId: task.seriesId!, occursOn: "2032-07-20" }, { title: "Parts later" }, "following");
    assert.equal((await as(mark, "select * from crm.series_view_parts($1)", [task.seriesId])).length, 1);
    assert.deepEqual(await as(sam, "select * from crm.series_view_parts($1)", [task.seriesId]), []);
  });

  it("refuses a done occurrence's assignee inserting done tasks into the series (78)", async () => {
    const task = (await createRepeatingTask(mark, { title: "No forged done", dueDate: "2031-09-02" }, { every: "week" })).body.task;
    await updateOccurrence(mark, { taskId: task.id }, { ownerId: priya.userId }, "this");
    await sql("update crm.tasks set completed_at = now() where id = $1", [task.id]);
    await assert.rejects(
      as(priya, "insert into crm.tasks (workspace_id, title, owner_id, created_by_user_id, series_id, occurs_on, due_at, completed_at) values ($1, 'Forged', $2, $2, $3, '2031-09-09', now(), now())", [mark.workspaceId, mark.userId, task.seriesId]),
      /row-level security/,
    );
  });

  it("ignores an agent id a person sets for themselves (81)", async () => {
    const { actor: agent } = await createAgent(mark.workspaceId, ["crm:read", "tasks:write"], "Series SQL agent two");
    const task = (await createRepeatingTask(agent, { title: "Agent only", dueDate: "2031-10-07" }, { every: "week" })).body.task;
    await updateOccurrence(agent, { taskId: task.id }, { ownerId: sam.userId }, "this");
    await assert.rejects(
      as(sam, "update crm.task_series set title = 'Posing' where id = $1", [task.seriesId], { "app.agent_id": agent.agentId }),
      /change every date/,
    );
  });

  it("refuses a series for a colleague that never gets a task (82)", async () => {
    await assert.rejects(
      as(sam, "insert into crm.task_series (workspace_id, created_by_user_id, owner_id, title, starts_on, rule) values ($1, $2, $3, 'Empty', '2031-11-01', '{\"freq\":\"daily\",\"interval\":1}'::jsonb)", [mark.workspaceId, sam.userId, mark.userId]),
      /needs its first task/,
    );
  });

  it("refuses an open task that left the series while it was being pointed at (83)", async () => {
    const task = (await createRepeatingTask(mark, { title: "Racing", dueDate: "2031-12-02" }, { every: "week" })).body.task;
    const [older] = await sql<{ id: string }>(
      "insert into crm.tasks (workspace_id, title, owner_id, created_by_user_id, series_id, occurs_on, due_at, completed_at) values ($1, 'Older', $2, $2, $3, '2031-11-25', now(), now()) returning id",
      [mark.workspaceId, mark.userId, task.seriesId],
    );
    const leaving = await getAdminPool().connect();
    try {
      await leaving.query("begin");
      await leaving.query("update crm.tasks set series_id = null, occurs_on = null where id = $1", [older.id]);
      const pointing = getAdminPool().query("update crm.task_series set current_task_id = $2 where id = $1", [task.seriesId, older.id]);
      await new Promise((resolve) => setTimeout(resolve, 200));
      await leaving.query("commit");
      await assert.rejects(pointing, /must belong to it/);
    } finally {
      leaving.release();
    }
  });

  it("refuses malformed ends and rules (84)", async () => {
    const task = (await createRepeatingTask(mark, { title: "Ends shape", dueDate: "2032-01-06" }, { every: "week" })).body.task;
    for (const ends of ['{"count": 2.5}', '{"count": 3, "until": "2032-02-01"}', '{"until": "2032-13-40"}', '{"never": true, "count": 2}', "{}", '{"until": "2032-02-30"}']) {
      await assert.rejects(sql("update crm.task_series set ends = $2::jsonb where id = $1", [task.seriesId, ends]), /task_series_ends_shape/, ends);
    }
    for (const rule of ['{"interval": 1}', '{"freq": "weekly", "interval": 1}', '{"freq": "monthly", "interval": 1, "monthWeek": {}}', '{"freq": "monthly", "interval": 1, "monthWeek": {"n": "1", "weekday": "mo"}}']) {
      await assert.rejects(sql("update crm.task_series set rule = $2::jsonb where id = $1", [task.seriesId, rule]), /task_series_rule_shape/, rule);
    }
    await sql("update crm.task_series set ends = '{\"count\": 3, \"spent\": 1}'::jsonb where id = $1", [task.seriesId]);
  });
});
