import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { authenticatePersonal, createPersonalToken, listPersonalTokens } from "@/lib/auth/personal";
import { membershipsFor, pickMembership } from "@/lib/auth/user";
import { relinkCalendar } from "@/lib/crm/calendar";
import { listCalendarItems } from "@/lib/crm/calendars";
import { createCompany, listCompanies } from "@/lib/crm/companies";
import { createContact } from "@/lib/crm/contacts";
import { backgroundTargets } from "@/lib/crm/conversations";
import { CrmError } from "@/lib/crm/errors";
import { listPipeline } from "@/lib/crm/opportunities";
import { scopesForRole } from "@/lib/crm/scopes";
import { acceptInvite, createInvite, removeMember } from "@/lib/crm/team";
import type { UserActor } from "@/lib/crm/types";
import { createWorkspace, workspaceActors } from "@/lib/crm/workspaces";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { listDailyNotes, openDailyNote } from "@/lib/docs/daily-notes";
import { createDoc, docsMentioning, getDoc, listUnlinkedMentions, saveDoc } from "@/lib/docs/store";
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
      createWorkspace(member, { name: "Side project" }),
      (error: unknown) => error instanceof CrmError && error.status === 403,
    );
    await assert.rejects(createWorkspace(mark, { name: "  " }), /name/);

    await admin.query(
      `insert into crm.workspace_brands (workspace_id, what_you_sell, tone, playbook) values ($1, 'AI visibility for agencies', 'Plain and direct', 'One idea per email')
       on conflict (workspace_id) do update set what_you_sell = excluded.what_you_sell, tone = excluded.tone, playbook = excluded.playbook`,
      [mark.workspaceId],
    );
    const created = await createWorkspace(mark, { name: "Mark Ridgeon" });
    const brand = await admin.query("select 1 from crm.workspace_brands where workspace_id = $1 and (what_you_sell <> '' or tone <> '' or playbook <> '')", [created.id]);
    assert.equal(brand.rowCount, 0);
    ridgeon = inWorkspace(mark, created.id, "Mark Ridgeon");

    const stored = await admin.query<{ name: string; brand_source_id: string | null; role: string }>(
      `select w.name, w.brand_source_id, m.role from crm.workspaces w
       join crm.workspace_members m on m.workspace_id = w.id and m.user_id = $2 where w.id = $1`,
      [created.id, mark.userId],
    );
    assert.deepEqual(stored.rows[0], { name: "Mark Ridgeon", brand_source_id: null, role: "owner" });
    await createWorkspace(mark, { name: "Blank one" });

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

  it("links meetings to the contacts of the workspace their calendar is in, whoever runs the relink", async () => {
    const admin = getAdminPool();
    const lena = (await createContact(ridgeon, { firstName: "Lena", lastName: "Ortiz", email: "lena@harbourline.test" })).body.contact;
    await createContact(mark, { firstName: "Lena", lastName: "Ortiz", email: "lena@harbourline.test" });
    await admin.query("update crm.calendars set use_for_crm = true where user_id = $1", [mark.userId]);
    await admin.query(
      `update crm.calendar_events set attendees = '[{"email": "lena@harbourline.test", "name": "Lena Ortiz"}]'::jsonb
       where user_id = $1 and provider_event_id = 'event-1'`,
      [mark.userId],
    );
    await relinkCalendar(mark);
    const linked = await admin.query<{ workspace_id: string; contact_ids: string[] }>(
      "select workspace_id, contact_ids from crm.calendar_events where user_id = $1 and provider_event_id = 'event-1'",
      [mark.userId],
    );
    assert.equal(linked.rows[0].workspace_id, ridgeon.workspaceId);
    assert.deepEqual(linked.rows[0].contact_ids, [lena.id]);
    await admin.query("update crm.calendar_events set contact_ids = '{}' where user_id = $1", [mark.userId]);
    await relinkCalendar(ridgeon);
    const again = await admin.query<{ contact_ids: string[] }>("select contact_ids from crm.calendar_events where user_id = $1 and provider_event_id = 'event-1'", [mark.userId]);
    assert.deepEqual(again.rows[0].contact_ids, [lena.id]);
  });

  it("resolves links and mentions in a daily note against the workspace it is written in, for its owner only", async () => {
    const now = new Date("2026-11-06T09:00:00Z");
    const plan = await createDoc(ridgeon, { title: "Ridgeon plan", content: "Retainers first.", shared: true });
    const lena = (await getAdminPool().query<{ id: string }>("select id from crm.contacts where workspace_id = $1 and normalized_email = 'lena@harbourline.test'", [ridgeon.workspaceId])).rows[0].id;
    const daily = await openDailyNote(ridgeon, "2026-11-06", { now });
    await saveDoc(ridgeon, daily.page.id, { content: `Read [[Ridgeon plan]] and [[Pricing ideas]]. Call @[Lena Ortiz](contact:${lena}).` });
    const detail = await getDoc(ridgeon, daily.page.id);
    assert.equal(detail.links.find((link) => link.title === "Ridgeon plan")?.pageId, plan.id);
    assert.equal(detail.links.find((link) => link.title === "Pricing ideas")?.pageId, null);
    const pricing = await createDoc(ridgeon, { title: "Pricing ideas", content: "", shared: true });
    assert.equal((await getDoc(mark, daily.page.id)).links.find((link) => link.title === "Pricing ideas")?.pageId, pricing.id);

    assert.deepEqual((await docsMentioning(ridgeon, { kind: "contact", id: lena })).map((item) => item.id), [daily.page.id]);
    const mentioned = await createDoc(ridgeon, { title: "Harbourline", content: "", shared: true });
    await saveDoc(ridgeon, daily.page.id, { content: `Read [[Ridgeon plan]] and [[Pricing ideas]]. Call @[Lena Ortiz](contact:${lena}). Harbourline next.` });
    assert.deepEqual((await listUnlinkedMentions(ridgeon, mentioned.id)).map((item) => item.id), [daily.page.id]);

    const sam = await createUser("sam@ridgeon.test", "Sam Lee");
    await getAdminPool().query("insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, 'member')", [ridgeon.workspaceId, sam.userId]);
    const samHere = inWorkspace(sam, ridgeon.workspaceId, "Mark Ridgeon", "member");
    assert.deepEqual(await docsMentioning(samHere, { kind: "contact", id: lena }), []);
    assert.deepEqual(await listUnlinkedMentions(samHere, mentioned.id), []);
    const links = await queryAsUser(sam.userId, "select * from crm.page_links where page_id = $1", [daily.page.id]);
    assert.equal(links.length, 0);
  });

  it("stops a personal token from a workspace someone leaves and leaves it off their list", async () => {
    const admin = getAdminPool();
    const tess = await createUser("tess@ridgeon.test", "Tess Hart");
    await admin.query("insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, 'member')", [ridgeon.workspaceId, tess.userId]);
    const tessHere = inWorkspace(tess, ridgeon.workspaceId, "Mark Ridgeon", "member");
    const issued = await createPersonalToken(tessHere, "Claude");
    const kept = await createPersonalToken(tess, "Home");
    assert.equal((await authenticatePersonal(issued.token)).actor.workspaceId, ridgeon.workspaceId);
    await removeMember(ridgeon, tess.userId);
    const stored = await admin.query<{ revoked: boolean }>("select revoked_at is not null as revoked from crm.personal_tokens where id = $1", [issued.details.id]);
    assert.equal(stored.rows[0].revoked, true);
    await assert.rejects(authenticatePersonal(issued.token), /Invalid credentials/);
    assert.deepEqual((await listPersonalTokens(tess)).map((token) => token.id), [kept.details.id]);
  });

  it("always lists memberships in the order that picks the home workspace", async () => {
    const admin = getAdminPool();
    const tie = await createUser("tie@ridgeon.test", "Tie Break");
    const joined = (await admin.query<{ created_at: Date }>("select created_at from crm.workspace_members where user_id = $1", [tie.userId])).rows[0].created_at;
    await admin.query("insert into crm.workspace_members (workspace_id, user_id, role, created_at) values ($1, $2, 'member', $3)", [ridgeon.workspaceId, tie.userId, joined]);
    const home = (await admin.query<{ id: string }>("select private.home_workspace_id($1) as id", [tie.userId])).rows[0].id;
    const listed = await membershipsFor(tie.userId);
    assert.equal(listed.length, 2);
    assert.equal(listed[0].workspace_id, home);
    assert.equal((await workspaceActors(tie))[0].workspaceId, home);
  });

  it("gathers each person's own things into their home workspace when the migration runs", async () => {
    const admin = getAdminPool();
    await admin.query("insert into crm.ai_accounts (workspace_id, user_id, provider) values ($1, $2, 'chatgpt')", [mark.workspaceId, mark.userId]);
    await admin.query("update crm.ai_accounts set workspace_id = $1 where user_id = $2", [ridgeon.workspaceId, mark.userId]);
    await admin.query("update crm.mail_preferences set workspace_id = $1 where user_id = $2", [ridgeon.workspaceId, mark.userId]);
    const outside = async () =>
      Number(
        (
          await admin.query(
            `select (select count(*) from crm.calendar_accounts where user_id = $1 and workspace_id <> $2)
               + (select count(*) from crm.mail_sources where user_id = $1 and workspace_id <> $2)
               + (select count(*) from crm.calendar_events where user_id = $1 and workspace_id <> $2)
               + (select count(*) from crm.ai_accounts where user_id = $1 and workspace_id <> $2)
               + (select count(*) from crm.mail_preferences where user_id = $1 and workspace_id <> $2) as total`,
            [mark.userId, mark.workspaceId],
          )
        ).rows[0].total,
      );
    assert.ok((await outside()) > 0);
    const migrations = ["20261229100000_workspaces.sql", "20261229200000_brand_profiles.sql", "20261229300000_mail_workspace_routing.sql"];
    await admin.query("create table private.schema_migrations (filename text primary key)");
    await admin.query("insert into private.schema_migrations (filename) values ($1)", [migrations[0]]);
    await admin.query(readFileSync(`supabase/migrations/${migrations[0]}`, "utf8"));
    assert.ok((await outside()) > 0);
    await admin.query("drop table private.schema_migrations");
    for (const file of migrations) await admin.query(readFileSync(`supabase/migrations/${file}`, "utf8"));
    assert.equal(await outside(), 0);
    const preferences = await admin.query("select 1 from crm.mail_preferences where user_id = $1", [mark.userId]);
    assert.equal(preferences.rowCount, 1);
    for (const file of migrations) await admin.query(readFileSync(`supabase/migrations/${file}`, "utf8"));
    assert.equal(await outside(), 0);
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
