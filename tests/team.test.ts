import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { runTool } from "@/lib/assistant/tools";
import { getMeetings } from "@/lib/crm/calendar";
import { createCompany, getCompany } from "@/lib/crm/companies";
import { createContact } from "@/lib/crm/contacts";
import { listActivities } from "@/lib/crm/activities";
import { getGranolaStatus, personalGranolaKey, removeGranolaKey, saveGranolaKey, syncGranolaFor } from "@/lib/crm/granola";
import { fileInboundMessages, saveMailbox } from "@/lib/crm/inbox";
import { syncTargets } from "@/lib/crm/scheduler";
import { getCompanyContext } from "@/lib/crm/relationships";
import { countOpenTasks, createTask, listDueReminders, listTasks, updateTask } from "@/lib/crm/tasks";
import { scopesForRole } from "@/lib/crm/scopes";
import { acceptInvite, createInvite, getTeam, previewInvite, removeMember, revokeInvite, setMemberRole } from "@/lib/crm/team";
import type { UserActor, WorkspaceRole } from "@/lib/crm/types";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { createUser, queryAsUser, resetDatabase } from "./helpers";

async function localUser(email: string, name: string) {
  const created = await getAdminPool().query<{ id: string }>("select private.create_local_user($1, $2, $3) as id", [
    email,
    "password-123",
    name,
  ]);
  return created.rows[0].id;
}

function actorFor(owner: UserActor, userId: string, email: string, role: WorkspaceRole, fullName: string): UserActor {
  return { ...owner, userId, email, fullName, role, scopes: scopesForRole(role) };
}

describe("team", () => {
  let owner: UserActor;
  let member: UserActor;
  let admin: UserActor;
  let companyId: string;
  let contactId: string;

  before(async () => {
    await resetDatabase();
    owner = await createUser("mark@team.test", "Mark Ridgeon");
    companyId = (await createCompany(owner, { name: "Acme Team", domain: "acme-team.test" })).body.company.id;
    contactId = (await createContact(owner, { firstName: "Jane", lastName: "Client", companyId, email: "jane@acme-team.test" })).body.contact.id;
  });

  after(async () => {
    await getPool().end();
  });

  it("invites a member who joins with their own login", async () => {
    const invite = await createInvite(owner, { email: "Sam@Team.test", role: "member" });
    assert.equal(invite.email, "sam@team.test");
    const preview = await previewInvite(invite.token);
    assert.deepEqual(
      preview && { email: preview.email, role: preview.role, status: preview.status, invitedBy: preview.invitedBy },
      { email: "sam@team.test", role: "member", status: "pending", invitedBy: "Mark Ridgeon" },
    );
    assert.equal(await previewInvite("not-a-token"), null);

    const stranger = await localUser("stranger@team.test", "Stranger");
    await assert.rejects(acceptInvite(invite.token, stranger), /This invite is for sam@team.test/);
    const sam = await localUser("sam@team.test", "Sam Colleague");
    assert.equal(await acceptInvite(invite.token, sam), owner.workspaceId);
    assert.equal(await acceptInvite(invite.token, sam), owner.workspaceId);
    assert.equal((await previewInvite(invite.token))?.status, "accepted");
    member = actorFor(owner, sam, "sam@team.test", "member", "Sam Colleague");

    const team = await getTeam(owner);
    assert.deepEqual(
      team.members.map((person) => [person.name, person.role]),
      [
        ["Mark Ridgeon", "owner"],
        ["Sam Colleague", "member"],
      ],
    );
    await assert.rejects(createInvite(owner, { email: "sam@team.test" }), /already in this workspace/);
  });

  it("keeps people management with the owner and admins", async () => {
    await assert.rejects(createInvite(member, { email: "x@team.test" }), /Only the owner or an admin can invite/);
    await assert.rejects(removeMember(member, owner.userId), /Only the owner or an admin can remove/);
    await assert.rejects(setMemberRole(member, owner.userId, "member"), /Only the owner can change roles/);
    assert.deepEqual((await getTeam(member)).invites, []);

    const invite = await createInvite(owner, { email: "ada@team.test", role: "admin" });
    const ada = await localUser("ada@team.test", "Ada Admin");
    await acceptInvite(invite.token, ada);
    admin = actorFor(owner, ada, "ada@team.test", "admin", "Ada Admin");

    await assert.rejects(createInvite(admin, { email: "y@team.test", role: "admin" }), /Only the owner can invite an admin/);
    await assert.rejects(removeMember(admin, owner.userId), /The owner can't be removed/);
    await assert.rejects(setMemberRole(admin, owner.userId, "member"), /Only the owner can change roles/);
    await assert.rejects(setMemberRole(owner, owner.userId, "admin"), /owner's role can't be changed/);
    await assert.rejects(removeMember(owner, owner.userId), /The owner can't be removed/);

    const pending = await createInvite(admin, { email: "later@team.test" });
    const team = await getTeam(admin);
    assert.deepEqual(
      team.invites.map((item) => item.email),
      ["later@team.test"],
    );
    await revokeInvite(admin, pending.inviteId);
    assert.equal((await previewInvite(pending.token))?.status, "revoked");
    assert.deepEqual((await getTeam(admin)).invites, []);
  });

  it("keeps tasks private to whoever they belong to, with oversight for the owner", async () => {
    const mine = (await createTask(owner, { title: "Owner renewal call", companyId })).body.task;
    assert.equal(mine.ownerId, owner.userId);
    const theirs = (await createTask(member, { title: "Sam onboarding prep", companyId })).body.task;
    assert.equal(theirs.ownerId, member.userId);
    const handed = (await createTask(owner, { title: "Sam to send pack", companyId, ownerId: member.userId })).body.task;

    const memberTitles = (await listTasks(member)).data.map((task) => task.title).sort();
    assert.deepEqual(memberTitles, ["Sam onboarding prep", "Sam to send pack"]);
    assert.deepEqual(
      (await listTasks(owner, { mine: true })).data.map((task) => task.title),
      ["Owner renewal call"],
    );
    assert.equal((await listTasks(owner)).total, 3);
    assert.equal(await countOpenTasks(member, { mine: true }), 2);
    assert.equal(await countOpenTasks(owner, { mine: true }), 1);

    const context = await getCompanyContext(member, companyId);
    assert.ok(!context.tasks.some((task) => task.title === "Owner renewal call"));
    const tool = (await runTool(member, "list_tasks", {})) as { data: { title: string }[] };
    assert.ok(!tool.data.some((task) => task.title === "Owner renewal call"));
    await assert.rejects(updateTask(member, mine.id, { title: "Hijacked" }), /not found/i);
    const raw = await queryAsUser<{ total: number }>(member.userId, "select count(*)::int as total from crm.tasks where id = $1", [mine.id]);
    assert.equal(raw[0].total, 0);

    await assert.rejects(updateTask(member, handed.id, { ownerId: owner.userId }), /didn't create it/);
    const own = (await createTask(member, { title: "Ask Mark to sign", companyId })).body.task;
    const passed = await updateTask(member, own.id, { ownerId: owner.userId });
    assert.equal(passed.body.task.ownerId, owner.userId);
    assert.equal((await listTasks(member)).total, 3);

    await updateTask(owner, mine.id, { dueAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(), remindMinutes: 15 });
    assert.deepEqual(
      (await listDueReminders(owner)).map((item) => item.title),
      ["Owner renewal call"],
    );
    assert.deepEqual(await listDueReminders(member), []);
  });

  it("shares meetings logged against clients but not the rest of someone's calendar", async () => {
    await saveMailbox(owner, {
      email: "mark@team.test",
      refreshToken: "refresh",
      accessToken: "access",
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    const db = getAdminPool();
    const connection = await db.query<{ id: string }>("select id from crm.mailbox_connections where user_id = $1", [owner.userId]);
    const calendar = await db.query<{ id: string }>(
      `insert into crm.calendars (workspace_id, user_id, connection_id, provider_calendar_id, name, color, is_default, is_visible, use_for_crm)
       values ($1, $2, $3, 'cal-team', 'Calendar', '#4f9be8', true, true, true) returning id`,
      [owner.workspaceId, owner.userId, connection.rows[0].id],
    );
    const insert = (subject: string, contacts: string[]) =>
      db.query(
        `insert into crm.calendar_events (workspace_id, calendar_id, connection_id, user_id, provider_event_id, subject, starts_at, ends_at, contact_ids, company_ids)
         values ($1, $2, $3, $4, $5, $5, now() - interval '2 hours', now() - interval '1 hour', $6::uuid[], $7::uuid[])`,
        [owner.workspaceId, calendar.rows[0].id, connection.rows[0].id, owner.userId, subject, contacts, contacts.length ? [companyId] : []],
      );
    await insert("Acme quarterly review", [contactId]);
    await insert("Dentist", []);

    const seen = await getMeetings(member, { companyId });
    assert.deepEqual(
      seen.recent.map((meeting) => meeting.subject),
      ["Acme quarterly review"],
    );
    const raw = await queryAsUser<{ subject: string }>(member.userId, "select subject from crm.calendar_events");
    assert.deepEqual(
      raw.map((row) => row.subject),
      ["Acme quarterly review"],
    );
  });

  it("logs an email once when two people receive it", async () => {
    await saveMailbox(member, {
      email: "sam@team.test",
      refreshToken: "sam-refresh",
      accessToken: "sam-access",
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    const email = (providerMessageId: string) => ({
      providerMessageId,
      internetMessageId: "<pricing-123@acme-team.test>",
      subject: "Pricing question",
      preview: "Could you both look at the pricing?",
      fromEmail: "jane@acme-team.test",
      toEmails: ["mark@team.test", "sam@team.test"],
      receivedAt: new Date().toISOString(),
    });
    await fileInboundMessages(owner, [email("mark-copy")]);
    await fileInboundMessages(member, [email("sam-copy")]);
    const logged = await listActivities(owner, { contactId, type: "email" });
    assert.equal(logged.data.filter((activity) => activity.title === "Pricing question").length, 1);
    const linked = await getAdminPool().query<{ total: number }>(
      "select count(distinct activity_id)::int as total from crm.email_messages where internet_message_id = '<pricing-123@acme-team.test>'",
    );
    assert.equal(linked.rows[0].total, 1);
  });

  it("lets each person connect their own Granola, kept private to them", async () => {
    const seen: string[] = [];
    const granola = (status = 200): typeof fetch => async (_input, init) => {
      seen.push(new Headers(init?.headers).get("authorization") ?? "");
      if (status !== 200) return Response.json({ message: "Invalid API key" }, { status });
      return Response.json({ notes: [], hasMore: false, cursor: null });
    };
    await assert.rejects(saveGranolaKey(member, "grn_bad_key_123456", { fetchImpl: granola(401) }), /Granola didn't accept that key/);
    await saveGranolaKey(member, "grn_sam_key_123456", { fetchImpl: granola() });
    assert.equal(await personalGranolaKey(member), "grn_sam_key_123456");
    assert.deepEqual((await getGranolaStatus(member)).personal, { connected: true, hint: "3456" });
    assert.deepEqual((await getGranolaStatus(owner)).personal, { connected: false, hint: null });
    const peek = await queryAsUser<{ total: number }>(owner.userId, "select count(*)::int as total from crm.granola_keys");
    assert.equal(peek[0].total, 0);

    seen.length = 0;
    const run = await syncGranolaFor(member, { fetchImpl: granola() });
    assert.equal(run.error, undefined);
    assert.ok(seen.every((header) => header === "Bearer grn_sam_key_123456") && seen.length > 0);

    const { targets } = await syncTargets();
    const samTarget = targets.find((target) => target.actor.userId === member.userId);
    assert.equal(samTarget?.personalGranola, true);

    await removeGranolaKey(member);
    assert.equal(await personalGranolaKey(member), null);
    await saveGranolaKey(member, "grn_sam_key_123456", { fetchImpl: granola() });
  });

  it("removes a member, hands their records to the remover, and disconnects them", async () => {
    await getAdminPool().query("update crm.companies set owner_id = $1 where id = $2", [member.userId, companyId]);
    await removeMember(owner, member.userId);
    assert.equal((await getCompany(owner, companyId)).ownerId, owner.userId);
    const tasks = await getAdminPool().query<{ total: number }>(
      "select count(*)::int as total from crm.tasks where owner_id = $1",
      [member.userId],
    );
    assert.equal(tasks.rows[0].total, 0);
    const mailbox = await getAdminPool().query<{ status: string; refresh_token: string | null }>(
      "select status, refresh_token from crm.mailbox_connections where user_id = $1",
      [member.userId],
    );
    assert.deepEqual(mailbox.rows[0], { status: "disconnected", refresh_token: null });
    const keys = await getAdminPool().query<{ total: number }>("select count(*)::int as total from crm.granola_keys where user_id = $1", [member.userId]);
    assert.equal(keys.rows[0].total, 0);
    assert.deepEqual(
      (await getTeam(owner)).members.map((person) => person.role),
      ["owner", "admin"],
    );
    await assert.rejects(removeMember(admin, owner.userId), /The owner can't be removed/);
  });
});
