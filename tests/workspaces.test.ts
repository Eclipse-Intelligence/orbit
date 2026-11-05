import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { membershipsFor, pickMembership } from "@/lib/auth/user";
import { listCalendarItems } from "@/lib/crm/calendars";
import { createCompany, listCompanies } from "@/lib/crm/companies";
import { backgroundTargets } from "@/lib/crm/conversations";
import { CrmError } from "@/lib/crm/errors";
import { listPipeline } from "@/lib/crm/opportunities";
import { scopesForRole } from "@/lib/crm/scopes";
import { acceptInvite, createInvite, removeMember } from "@/lib/crm/team";
import type { UserActor } from "@/lib/crm/types";
import { createWorkspace } from "@/lib/crm/workspaces";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { listDailyNotes, openDailyNote } from "@/lib/docs/daily-notes";
import { listThreads, mailUnreadCount } from "@/lib/mail/threads";
import { sectionIndex, workspaceInitial, workspaceTone } from "@/lib/workspace-paths";
import { createUser, queryAsUser, resetDatabase } from "./helpers";

function inWorkspace(actor: UserActor, id: string, name: string, role: UserActor["role"] = "owner"): UserActor {
  return { ...actor, workspaceId: id, workspaceName: name, role, scopes: scopesForRole(role) };
}

describe("workspaces", () => {
  let mark: UserActor;
  let ridgeon: UserActor;
  let priya: UserActor;

  before(async () => {
    await resetDatabase();
    mark = await createUser("mark@eclipse.test", "Mark Ridgeon");
    await getAdminPool().query("update crm.workspaces set name = 'Eclipse' where id = $1", [mark.workspaceId]);
    mark = { ...mark, workspaceName: "Eclipse" };
    priya = await createUser("priya@eclipse.test", "Priya Shah");
  });

  after(async () => {
    await getPool().end();
    await getAdminPool().end();
  });

  it("lets only owners create a workspace, which comes ready to use", async () => {
    const admin = getAdminPool();
    await admin.query("insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, 'member')", [
      mark.workspaceId,
      priya.userId,
    ]);
    await admin.query("delete from crm.workspace_members where user_id = $1 and workspace_id <> $2", [priya.userId, mark.workspaceId]);
    const member = inWorkspace(priya, mark.workspaceId, "Eclipse", "member");
    await assert.rejects(
      createWorkspace(member, { name: "Side project", brandStart: "blank" }),
      (error: unknown) => error instanceof CrmError && error.status === 403,
    );
    await assert.rejects(createWorkspace(mark, { name: "  ", brandStart: "blank" }), /name/);

    await admin.query(
      `insert into crm.workspace_brands (workspace_id, what_you_sell, tone, playbook) values ($1, 'AI visibility for agencies', 'Plain and direct', 'One idea per email')
       on conflict (workspace_id) do update set what_you_sell = excluded.what_you_sell, tone = excluded.tone, playbook = excluded.playbook`,
      [mark.workspaceId],
    );
    const created = await createWorkspace(mark, { name: "Mark Ridgeon", brandStart: "copy" });
    const copied = await admin.query<{ what_you_sell: string; tone: string; playbook: string; eclipse_tools: boolean }>(
      "select what_you_sell, tone, playbook, eclipse_tools from crm.workspace_brands where workspace_id = $1",
      [created.id],
    );
    assert.deepEqual(copied.rows[0], { what_you_sell: "AI visibility for agencies", tone: "Plain and direct", playbook: "One idea per email", eclipse_tools: false });
    assert.equal(created.brandSourceId, mark.workspaceId);
    ridgeon = inWorkspace(mark, created.id, "Mark Ridgeon");

    const stored = await admin.query<{ name: string; brand_source_id: string | null; role: string }>(
      `select w.name, w.brand_source_id, m.role from crm.workspaces w
       join crm.workspace_members m on m.workspace_id = w.id and m.user_id = $2 where w.id = $1`,
      [created.id, mark.userId],
    );
    assert.deepEqual(stored.rows[0], { name: "Mark Ridgeon", brand_source_id: mark.workspaceId, role: "owner" });

    const blank = await createWorkspace(mark, { name: "Blank one", brandStart: "blank" });
    assert.equal(blank.brandSourceId, null);
    const blankBrand = await admin.query("select 1 from crm.workspace_brands where workspace_id = $1 and what_you_sell <> ''", [blank.id]);
    assert.equal(blankBrand.rowCount, 0);

    const pipeline = await listPipeline(ridgeon);
    assert.deepEqual(
      pipeline.stages.map((stage) => stage.name),
      ["New", "Working", "Proposal", "Won", "Lost"],
    );
    const company = await createCompany(ridgeon, { name: "Northfold", domain: "northfold.test" });
    assert.equal(company.body.company.name, "Northfold");
    const audit = await admin.query("select 1 from crm.audit_events where workspace_id = $1 and event_type = 'workspace.created'", [created.id]);
    assert.equal(audit.rowCount, 1);
  });

  it("picks the workspace from the cookie only when the person is in it", async () => {
    const memberships = await membershipsFor(mark.userId);
    assert.deepEqual(
      memberships.map((item) => item.workspace_name),
      ["Eclipse", "Mark Ridgeon", "Blank one"],
    );
    assert.equal(pickMembership(memberships, ridgeon.workspaceId).workspace_id, ridgeon.workspaceId);
    assert.equal(pickMembership(memberships, mark.workspaceId).workspace_id, mark.workspaceId);
    assert.equal(pickMembership(memberships, undefined).workspace_id, mark.workspaceId);
    const elsewhere = await createUser("stranger@elsewhere.test", "Stranger");
    assert.equal(pickMembership(memberships, elsewhere.workspaceId).workspace_id, mark.workspaceId);
  });

  it("keeps each workspace's records away from people who were only invited to the other", async () => {
    await createCompany(mark, { name: "Eclipse client", domain: "eclipse-client.test" });
    const invite = await createInvite(ridgeon, { email: "hannah@ridgeon.test", role: "member" });
    const hannahId = (
      await getAdminPool().query<{ id: string }>("select private.create_local_user($1, $2, $3) as id", [
        "hannah@ridgeon.test",
        "password-123",
        "Hannah Cole",
      ])
    ).rows[0].id;
    const joined = await acceptInvite(invite.token, hannahId);
    assert.equal(joined, ridgeon.workspaceId);
    const hannahMemberships = await membershipsFor(hannahId);
    assert.deepEqual(hannahMemberships.map((item) => item.workspace_id), [ridgeon.workspaceId]);
    const hannah = inWorkspace({ ...mark, userId: hannahId, email: "hannah@ridgeon.test", fullName: "Hannah Cole" }, ridgeon.workspaceId, "Mark Ridgeon", "member");

    const seen = await listCompanies(hannah, {});
    assert.deepEqual(
      seen.data.map((item) => item.name),
      ["Northfold"],
    );
    const direct = await queryAsUser<{ name: string }>(hannahId, "select name from crm.companies where workspace_id = $1", [mark.workspaceId]);
    assert.equal(direct.length, 0);
    const forced = await listCompanies(inWorkspace(hannah, mark.workspaceId, "Eclipse", "member"), {});
    assert.equal(forced.data.length, 0);
  });

  it("shows the same mail and calendar in every workspace the person is in", async () => {
    const admin = getAdminPool();
    const connection = await admin.query<{ id: string }>(
      `insert into crm.mailbox_connections (workspace_id, user_id, provider, email, status, refresh_token)
       values ($1, $2, 'microsoft', 'mark@eclipse.test', 'connected', 'cipher') returning id`,
      [mark.workspaceId, mark.userId],
    );
    const account = await admin.query<{ id: string }>(
      `insert into crm.calendar_accounts (workspace_id, user_id, provider, email, status, refresh_token, can_send)
       values ($1, $2, 'microsoft', 'mark@ridgeon.test', 'connected', 'cipher', true) returning id`,
      [ridgeon.workspaceId, mark.userId],
    );
    const sources = [
      { owner: "connection_id", id: connection.rows[0].id, email: "mark@eclipse.test", subject: "Eclipse renewal" },
      { owner: "account_id", id: account.rows[0].id, email: "mark@ridgeon.test", subject: "Ridgeon proposal" },
    ];
    const calendarIds: string[] = [];
    for (const [index, source] of sources.entries()) {
      const created = await admin.query<{ id: string; workspace_id: string }>(
        `insert into crm.mail_sources (workspace_id, user_id, ${source.owner}, email) values ($1, $2, $3, $4) returning id, workspace_id`,
        [priya.workspaceId, mark.userId, source.id, source.email],
      );
      assert.equal(created.rows[0].workspace_id, index === 0 ? mark.workspaceId : ridgeon.workspaceId);
      const folder = await admin.query<{ id: string }>(
        `insert into crm.mail_folders (workspace_id, user_id, source_id, provider_folder_id, name, role)
         values ($1, $2, $3, $4, 'Inbox', 'inbox') returning id`,
        [ridgeon.workspaceId, mark.userId, created.rows[0].id, `inbox-${index}`],
      );
      const stored = await admin.query<{ workspace_id: string }>(
        `insert into crm.mail_messages (workspace_id, user_id, source_id, folder_id, provider_message_id, thread_key, subject,
           from_email, from_name, received_at, is_read)
         values ($1, $2, $3, $4, $5, $5, $6, 'client@example.test', 'Client', now() - make_interval(mins => $7), false)
         returning workspace_id`,
        [ridgeon.workspaceId, mark.userId, created.rows[0].id, folder.rows[0].id, `message-${index}`, source.subject, index],
      );
      assert.equal(stored.rows[0].workspace_id, created.rows[0].workspace_id);
      const calendar = await admin.query<{ id: string; workspace_id: string }>(
        `insert into crm.calendars (workspace_id, user_id, ${source.owner}, provider_calendar_id, name, color, is_default, is_visible)
         values ($1, $2, $3, $4, 'Calendar', '#4f9be8', true, true) returning id, workspace_id`,
        [priya.workspaceId, mark.userId, source.id, `calendar-${index}`],
      );
      assert.equal(calendar.rows[0].workspace_id, created.rows[0].workspace_id);
      calendarIds.push(calendar.rows[0].id);
      await admin.query(
        `insert into crm.calendar_events (workspace_id, user_id, calendar_id, ${source.owner}, provider_event_id, subject, starts_at, ends_at)
         values ($1, $2, $3, $4, $5, $6, now() + interval '1 day', now() + interval '1 day 1 hour')`,
        [priya.workspaceId, mark.userId, calendar.rows[0].id, source.id, `event-${index}`, `${source.subject} call`],
      );
    }

    const range = { start: new Date(Date.now() - 86_400_000), end: new Date(Date.now() + 3 * 86_400_000) };
    const views = [];
    for (const actor of [mark, ridgeon]) {
      const threads = await listThreads(actor, {});
      const items = await listCalendarItems(actor, range);
      views.push({
        mail: threads.threads.map((thread) => thread.subject).sort(),
        unread: await mailUnreadCount(actor),
        calendar: items.map((item) => item.subject).sort(),
      });
    }
    assert.deepEqual(views[0].mail, ["Eclipse renewal", "Ridgeon proposal"]);
    assert.deepEqual(views[0].calendar, ["Eclipse renewal call", "Ridgeon proposal call"]);
    assert.deepEqual(views[1], views[0]);

    const settings = await admin.query<{ workspace_id: string }>(
      `insert into crm.mail_preferences (workspace_id, user_id) values ($1, $2) returning workspace_id`,
      [ridgeon.workspaceId, mark.userId],
    );
    assert.equal(settings.rows[0].workspace_id, mark.workspaceId);
  });

  it("syncs a person in two workspaces once, and still visits every workspace", async () => {
    const targets = await backgroundTargets();
    const marks = targets.filter((target) => target.actor.userId === mark.userId && (target.mailbox || target.calendarAccounts));
    assert.equal(marks.length, 1);
    assert.equal(marks[0].actor.workspaceId, mark.workspaceId);
    const workspaces = new Set(targets.map((target) => target.actor.workspaceId));
    assert.ok(workspaces.has(mark.workspaceId));
    assert.ok(workspaces.has(ridgeon.workspaceId));
  });

  it("keeps daily notes with the person in every workspace", async () => {
    const now = new Date("2026-11-05T09:00:00Z");
    const fromRidgeon = await openDailyNote(ridgeon, "2026-11-05", { now });
    const fromEclipse = await openDailyNote(mark, "2026-11-05", { now });
    assert.equal(fromEclipse.page.id, fromRidgeon.page.id);
    const stored = await getAdminPool().query<{ workspace_id: string }>("select workspace_id from crm.pages where id = $1", [fromRidgeon.page.id]);
    assert.equal(stored.rows[0].workspace_id, mark.workspaceId);
    await getAdminPool().query("update crm.pages set content = 'Call Hannah' where id = $1", [fromRidgeon.page.id]);
    const lists = await Promise.all([listDailyNotes(mark), listDailyNotes(ridgeon)]);
    assert.deepEqual(lists[1], lists[0]);
    assert.equal(lists[0].length, 1);
  });

  it("moves someone's own things to their other workspace when they leave one", async () => {
    const admin = getAdminPool();
    const hannahId = (await admin.query<{ id: string }>("select id from crm.profiles where email = 'hannah@ridgeon.test'")).rows[0].id;
    const invite = await createInvite(mark, { email: "hannah@ridgeon.test", role: "member" });
    await acceptInvite(invite.token, hannahId);
    const account = await admin.query<{ workspace_id: string }>(
      "insert into crm.ai_accounts (workspace_id, user_id, provider) values ($1, $2, 'chatgpt') returning workspace_id",
      [mark.workspaceId, hannahId],
    );
    assert.equal(account.rows[0].workspace_id, ridgeon.workspaceId);
    await removeMember(ridgeon, hannahId);
    const kept = await admin.query<{ workspace_id: string }>("select workspace_id from crm.ai_accounts where user_id = $1", [hannahId]);
    assert.deepEqual(kept.rows, [{ workspace_id: mark.workspaceId }]);
    const left = await membershipsFor(hannahId);
    assert.deepEqual(left.map((item) => item.workspace_id), [mark.workspaceId]);
  });

  it("works out where switching lands and how a workspace looks", () => {
    assert.equal(sectionIndex("/companies/123"), "/");
    assert.equal(sectionIndex("/contacts/abc"), "/contacts");
    assert.equal(sectionIndex("/boards/abc"), "/opportunities");
    assert.equal(sectionIndex("/opportunities/abc"), "/opportunities");
    assert.equal(sectionIndex("/mail"), "/mail");
    assert.equal(sectionIndex("/mail/subscriptions"), "/mail/subscriptions");
    assert.equal(sectionIndex("/settings/team"), "/settings/team");
    assert.equal(sectionIndex("/docs/some-page"), "/docs");
    assert.equal(sectionIndex("/"), "/");
    assert.equal(workspaceTone("56c09252-607c-47f3-8776-3858fa80dea8"), workspaceTone("56c09252-607c-47f3-8776-3858fa80dea8"));
    assert.equal(workspaceInitial("  eclipse"), "E");
    assert.equal(workspaceInitial("ölçü"), "Ö");
  });
});
