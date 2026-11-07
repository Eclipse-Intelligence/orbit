import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { saveBrandProfile } from "@/lib/crm/brand";
import { captureStatuses, markCaptureSeen } from "@/lib/crm/capture";
import { isFreeMailDomain } from "@/lib/crm/communications";
import { withActor } from "@/lib/crm/context";
import { createCompany } from "@/lib/crm/companies";
import { createContact } from "@/lib/crm/contacts";
import { scopesForRole } from "@/lib/crm/scopes";
import type { UserActor } from "@/lib/crm/types";
import { createWorkspace } from "@/lib/crm/workspaces";
import { getAdminPool, getPool } from "@/lib/db/pool";
import {
  addPersonHere,
  createAndFileUnknown,
  fileUnknownTo,
  ignoreUnknownMail,
  listUnknownMail,
  moveUnknownMail,
  setThreadDomainRule,
  setThreadFiling,
  threadBrand,
} from "@/lib/mail/filing";
import { writeNudge } from "@/lib/mail/prepare";
import { listAddressHomes, routedAway, setAddressHome, setDomainRule } from "@/lib/mail/routing";
import { getThread } from "@/lib/mail/threads";
import { fileMailOnTimeline } from "@/lib/mail/timeline";
import { queueMailWorkflowEvents } from "@/lib/workflows/mail-events";
import { createUser, queryAsUser, resetDatabase } from "./helpers";

type Box = { sourceId: string; inbox: string; sent: string };

function minutesAgo(minutes: number) {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

describe("mail across workspaces", () => {
  let eclipse: UserActor;
  let ridgeon: UserActor;
  let primary: Box;
  let extra: Box;

  async function source(owner: UserActor, column: "connection_id" | "account_id", ownerId: string, email: string): Promise<Box> {
    const admin = getAdminPool();
    const created = await admin.query<{ id: string }>(
      `insert into crm.mail_sources (workspace_id, user_id, ${column}, email) values ($1, $2, $3, $4) returning id`,
      [owner.workspaceId, owner.userId, ownerId, email],
    );
    const sourceId = created.rows[0].id;
    const folder = async (role: string) =>
      (
        await admin.query<{ id: string }>(
          "insert into crm.mail_folders (workspace_id, user_id, source_id, provider_folder_id, name, role) values ($1, $2, $3, $4, $4, $5) returning id",
          [owner.workspaceId, owner.userId, sourceId, `${role}-${sourceId}`, role],
        )
      ).rows[0].id;
    return { sourceId, inbox: await folder("inbox"), sent: await folder("sent") };
  }

  async function addMessage(
    owner: UserActor,
    box: Box,
    values: { id: string; thread?: string; from: string; name?: string; to: string[]; cc?: string[]; subject: string; body?: string; at?: string; sent?: boolean; focused?: boolean },
  ) {
    const result = await getAdminPool().query<{ id: string }>(
      `insert into crm.mail_messages (workspace_id, user_id, source_id, folder_id, provider_message_id, internet_message_id, thread_key, subject, snippet, body_text,
         from_email, from_name, to_recipients, cc_recipients, sent_at, received_at, focused)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9, $10, $11, $12::jsonb, $13::jsonb, $14, $14, $15) returning id`,
      [
        owner.workspaceId,
        owner.userId,
        box.sourceId,
        values.sent ? box.sent : box.inbox,
        values.id,
        `<${values.id}@mail.test>`,
        values.thread ?? values.id,
        values.subject,
        values.body ?? `${values.subject} body`,
        values.from,
        values.name ?? null,
        JSON.stringify(values.to.map((address) => ({ name: "", address }))),
        JSON.stringify((values.cc ?? []).map((address) => ({ name: "", address }))),
        values.at ?? minutesAgo(30),
        values.focused ?? null,
      ],
    );
    return { id: result.rows[0].id, key: `${box.sourceId}|${values.thread ?? values.id}` };
  }

  async function emailActivities(workspaceId: string, email: string) {
    const result = await getAdminPool().query<{ title: string }>(
      `select a.title from crm.activities a join crm.contacts c on c.id = a.contact_id
       where a.workspace_id = $1 and a.type = 'email' and c.normalized_email = $2 order by a.occurred_at`,
      [workspaceId, email],
    );
    return result.rows.map((row) => row.title);
  }

  async function senders(actor: UserActor) {
    return (await listUnknownMail(actor)).emails.map((email) => email.email).sort();
  }

  before(async () => {
    await resetDatabase();
    const admin = getAdminPool();
    eclipse = await createUser("mark@geteclipse.co", "Mark Ridgeon");
    await admin.query("update crm.workspaces set name = 'Eclipse' where id = $1", [eclipse.workspaceId]);
    eclipse = { ...eclipse, workspaceName: "Eclipse" };
    const created = await createWorkspace(eclipse, { name: "Mark Ridgeon" });
    ridgeon = { ...eclipse, workspaceId: created.id, workspaceName: "Mark Ridgeon", role: "owner", scopes: scopesForRole("owner") };
    const connection = await admin.query<{ id: string }>(
      `insert into crm.mailbox_connections (workspace_id, user_id, provider, email, status, refresh_token)
       values ($1, $2, 'microsoft', 'mark@geteclipse.co', 'connected', 'cipher') returning id`,
      [eclipse.workspaceId, eclipse.userId],
    );
    const account = await admin.query<{ id: string }>(
      `insert into crm.calendar_accounts (workspace_id, user_id, provider, email, status, refresh_token, can_send)
       values ($1, $2, 'microsoft', 'mark@markridgeon.com', 'connected', 'cipher', true) returning id`,
      [eclipse.workspaceId, eclipse.userId],
    );
    primary = await source(eclipse, "connection_id", connection.rows[0].id, "mark@geteclipse.co");
    extra = await source(eclipse, "account_id", account.rows[0].id, "mark@markridgeon.com");
    await admin.query(
      `insert into crm.send_identities (workspace_id, user_id, source_id, email, smtp_host, smtp_port, username, password_cipher)
       values ($1, $2, $3, 'mark@ridgeon.me', 'smtp.ridgeon.test', 587, 'mark@ridgeon.me', 'cipher')`,
      [eclipse.workspaceId, eclipse.userId, primary.sourceId],
    );
  });

  after(async () => {
    await getPool().end();
    await getAdminPool().end();
  });

  it("sends email from unknown senders to the Capture of the address's home workspace", async () => {
    const homes = await listAddressHomes(eclipse);
    assert.deepEqual(
      homes.map((home) => [home.address, home.kind, home.workspaceId === eclipse.workspaceId]),
      [
        ["mark@geteclipse.co", "mailbox", true],
        ["mark@markridgeon.com", "mailbox", true],
        ["mark@ridgeon.me", "sending", true],
      ],
    );
    await setAddressHome(eclipse, "mark@ridgeon.me", ridgeon.workspaceId);
    await setAddressHome(ridgeon, "Mark@MarkRidgeon.com", ridgeon.workspaceId);
    await assert.rejects(setAddressHome(eclipse, "someone@else.test", ridgeon.workspaceId), /isn't one of your mail accounts/);

    await addMessage(eclipse, primary, { id: "nina", from: "nina@fernleycapital.com", name: "Nina Alvarez", to: ["mark@ridgeon.me"], subject: "Intro: Mark and Tom at Fernley" });
    await addMessage(eclipse, primary, { id: "daniel", from: "daniel@lumenagency.co.uk", name: "Daniel Brooks", to: ["mark@geteclipse.co"], subject: "Pricing for agencies" });
    await addMessage(eclipse, extra, { id: "oliver", from: "oliver@workshops.test", name: "Oliver Grant", to: ["mark@markridgeon.com"], subject: "Workshop dates" });

    assert.deepEqual(await senders(eclipse), ["daniel@lumenagency.co.uk"]);
    assert.deepEqual(await senders(ridgeon), ["nina@fernleycapital.com", "oliver@workshops.test"]);
    const nina = (await listUnknownMail(ridgeon)).emails.find((email) => email.email === "nina@fernleycapital.com")!;
    assert.equal(nina.address, "mark@ridgeon.me");
    assert.equal(nina.name, "Nina Alvarez");
  });

  it("leaves newsletters, pitches, automated mail, other mail and replied or ignored threads out of Capture", async () => {
    const admin = getAdminPool();
    await addMessage(eclipse, primary, { id: "news", from: "news@brand.test", to: ["mark@geteclipse.co"], subject: "This week" });
    await addMessage(eclipse, primary, { id: "shop", from: "anna@shop.test", to: ["mark@geteclipse.co"], subject: "Offer", body: "Big sale.\n\nUnsubscribe here" });
    await addMessage(eclipse, primary, { id: "other", from: "otto@quiet.test", to: ["mark@geteclipse.co"], subject: "Hello", focused: false });
    const pitch = await addMessage(eclipse, primary, { id: "pitch", from: "sam@pitchy.test", to: ["mark@geteclipse.co"], subject: "Quick question" });
    await admin.query(
      `insert into crm.mail_prepared (workspace_id, user_id, source_id, thread_key, message_id, kind, state) values ($1, $2, $3, 'pitch', $4, 'pitch', 'ready')`,
      [eclipse.workspaceId, eclipse.userId, primary.sourceId, pitch.id],
    );
    await addMessage(eclipse, primary, { id: "cold", from: "pat@spammy.test", to: ["mark@geteclipse.co"], subject: "Leads" });
    await admin.query("insert into crm.mail_subscriptions (workspace_id, user_id, sender, cold_pitch_at) values ($1, $2, 'pat@spammy.test', now())", [eclipse.workspaceId, eclipse.userId]);
    await addMessage(eclipse, primary, { id: "rita", from: "rita@replied.test", to: ["mark@geteclipse.co"], subject: "Catch up", at: minutesAgo(60) });
    await addMessage(eclipse, primary, { id: "rita-reply", thread: "rita", from: "mark@geteclipse.co", to: ["rita@replied.test"], subject: "Re: Catch up", at: minutesAgo(10), sent: true });
    const iggy = await addMessage(eclipse, primary, { id: "iggy", from: "iggy@ignore.test", to: ["mark@geteclipse.co"], subject: "Hi" });
    await addMessage(eclipse, primary, { id: "old", from: "old@friend.test", to: ["mark@geteclipse.co"], subject: "Long ago", at: minutesAgo(60 * 24 * 31) });
    await addMessage(eclipse, primary, { id: "colleague", from: "priya@geteclipse.co", to: ["mark@geteclipse.co"], subject: "Release notes" });

    assert.deepEqual(await senders(eclipse), ["daniel@lumenagency.co.uk", "iggy@ignore.test"]);
    await ignoreUnknownMail(eclipse, iggy.key);
    assert.deepEqual(await senders(eclipse), ["daniel@lumenagency.co.uk"]);
  });

  it("files a sender known in one workspace only there", async () => {
    await createContact(ridgeon, { firstName: "Sophie", lastName: "Turner", email: "sophie@haldengroup.co.uk" });
    await addMessage(eclipse, primary, { id: "sophie", from: "sophie@haldengroup.co.uk", to: ["mark@ridgeon.me"], subject: "Retainer for Q1" });
    await fileMailOnTimeline(eclipse);
    assert.deepEqual(await emailActivities(ridgeon.workspaceId, "sophie@haldengroup.co.uk"), ["Retainer for Q1"]);
    const inEclipse = await getAdminPool().query("select 1 from crm.activities where workspace_id = $1 and title = 'Retainer for Q1'", [eclipse.workspaceId]);
    assert.equal(inEclipse.rowCount, 0);
    assert.ok(!(await senders(ridgeon)).includes("sophie@haldengroup.co.uk"));
  });

  it("files a sender known in both workspaces once in each", async () => {
    await createContact(eclipse, { firstName: "James", lastName: "Patel", email: "james@northwindlabs.com" });
    await createContact(ridgeon, { firstName: "James", lastName: "Patel", email: "james@northwindlabs.com" });
    await addMessage(eclipse, primary, { id: "james", from: "james@northwindlabs.com", to: ["mark@geteclipse.co"], subject: "Re: AI visibility pilot" });
    await fileMailOnTimeline(eclipse);
    await fileMailOnTimeline(ridgeon);
    assert.deepEqual(await emailActivities(eclipse.workspaceId, "james@northwindlabs.com"), ["Re: AI visibility pilot"]);
    assert.deepEqual(await emailActivities(ridgeon.workspaceId, "james@northwindlabs.com"), ["Re: AI visibility pilot"]);
  });

  it("queues email received workflows in each workspace the email is filed to", async () => {
    const admin = getAdminPool();
    for (const actor of [eclipse, ridgeon]) {
      await admin.query(
        `insert into crm.workflows (workspace_id, owner_id, name, status, trigger_type, definition)
         values ($1, $2, 'On email', 'active', 'email_received', '{"trigger": {"type": "email_received", "kind": "any"}, "steps": []}'::jsonb)`,
        [actor.workspaceId, actor.userId],
      );
    }
    const ids = await admin.query<{ id: string; provider_message_id: string }>(
      "select id, provider_message_id from crm.mail_messages where provider_message_id = any($1::text[])",
      [["james", "sophie", "nina", "daniel"]],
    );
    const byName = new Map(ids.rows.map((row) => [row.id, row.provider_message_id]));
    const queued = await queueMailWorkflowEvents(eclipse, ids.rows.map((row) => row.id));
    assert.equal(queued, 5);
    const events = await admin.query<{ workspace_id: string; entity_id: string }>(
      "select workspace_id, entity_id from crm.workflow_events where event_type = 'email.received'",
    );
    const seen = (workspaceId: string) =>
      events.rows.filter((row) => row.workspace_id === workspaceId).map((row) => byName.get(row.entity_id)).sort();
    assert.deepEqual(seen(eclipse.workspaceId), ["daniel", "james"]);
    assert.deepEqual(seen(ridgeon.workspaceId), ["james", "nina", "sophie"]);
  });

  it("marks people known in another workspace and adds them here with the thread filed", async () => {
    const company = await createCompany(eclipse, { name: "Acme Partners", domain: "acme-partners.com" });
    await createContact(eclipse, { firstName: "Raj", lastName: "Mehta", email: "raj@acme-partners.com", jobTitle: "CMO", companyId: company.body.company.id });
    const raj = await addMessage(eclipse, primary, { id: "raj", from: "raj@acme-partners.com", name: "Raj Mehta", to: ["mark@geteclipse.co"], cc: ["maya@acme-partners.com"], subject: "Positioning for 2027" });

    const before = await getThread(ridgeon, raj.key);
    const person = before.people.find((item) => item.email === "raj@acme-partners.com")!;
    assert.equal(person.contactId, null);
    assert.deepEqual(person.elsewhere, [{ id: eclipse.workspaceId, name: "Eclipse" }]);
    assert.equal(person.title, "CMO");
    assert.equal(person.companyName, "Acme Partners");
    const maya = before.people.find((item) => item.email === "maya@acme-partners.com")!;
    assert.equal(maya.elsewhere, undefined);
    assert.deepEqual(before.filing?.filedIn, [eclipse.workspaceId]);
    assert.equal(before.filing?.domain, "acme-partners.com");

    const added = await addPersonHere(ridgeon, raj.key, "raj@acme-partners.com");
    assert.equal(added.title, "CMO");
    assert.equal(added.companyName, "Acme Partners");
    const company2 = await getAdminPool().query<{ workspace_id: string; domain: string }>("select workspace_id, domain from crm.companies where id = $1", [added.companyId]);
    assert.deepEqual(company2.rows[0], { workspace_id: ridgeon.workspaceId, domain: "acme-partners.com" });
    assert.deepEqual(await emailActivities(ridgeon.workspaceId, "raj@acme-partners.com"), ["Positioning for 2027"]);
    const after = await getThread(ridgeon, raj.key);
    assert.equal(after.people.find((item) => item.email === "raj@acme-partners.com")?.contactId, added.contactId);
    assert.deepEqual(after.filing?.filedIn, [eclipse.workspaceId, ridgeon.workspaceId]);
  });

  it("moves a Capture item to another workspace", async () => {
    const daniel = (await listUnknownMail(eclipse)).emails.find((email) => email.email === "daniel@lumenagency.co.uk")!;
    await moveUnknownMail(eclipse, daniel.key, ridgeon.workspaceId);
    assert.deepEqual(await senders(eclipse), []);
    assert.ok((await senders(ridgeon)).includes("daniel@lumenagency.co.uk"));
    await assert.rejects(moveUnknownMail(eclipse, daniel.key, "00000000-0000-4000-8000-000000000000"), /not in that workspace/);
  });

  it("files a thread where you choose, keeps earlier activity and takes it out of Capture", async () => {
    const raj = (await getAdminPool().query<{ id: string }>("select id from crm.mail_messages where provider_message_id = 'raj'")).rows[0];
    const key = `${primary.sourceId}|raj`;
    const change = await setThreadFiling(eclipse, key, [ridgeon.workspaceId]);
    assert.deepEqual(change.filing?.filedIn, [ridgeon.workspaceId]);
    assert.equal(change.filing?.chosen, true);
    assert.deepEqual(change.kept, ["Eclipse"]);
    assert.ok(raj);
    await addMessage(eclipse, primary, { id: "raj-2", thread: "raj", from: "raj@acme-partners.com", to: ["mark@geteclipse.co"], subject: "Re: Positioning for 2027", at: minutesAgo(5) });
    await fileMailOnTimeline(eclipse);
    assert.deepEqual(await emailActivities(eclipse.workspaceId, "raj@acme-partners.com"), ["Positioning for 2027"]);
    assert.deepEqual(await emailActivities(ridgeon.workspaceId, "raj@acme-partners.com"), ["Positioning for 2027", "Re: Positioning for 2027"]);

    const nina = (await listUnknownMail(ridgeon)).emails.find((email) => email.email === "nina@fernleycapital.com")!;
    const filed = await setThreadFiling(ridgeon, nina.key, [eclipse.workspaceId, ridgeon.workspaceId]);
    assert.deepEqual(filed.filing?.filedIn, [eclipse.workspaceId, ridgeon.workspaceId]);
    assert.deepEqual(await emailActivities(eclipse.workspaceId, "nina@fernleycapital.com"), ["Intro: Mark and Tom at Fernley"]);
    assert.deepEqual(await emailActivities(ridgeon.workspaceId, "nina@fernleycapital.com"), ["Intro: Mark and Tom at Fernley"]);
    assert.ok(!(await senders(ridgeon)).includes("nina@fernleycapital.com"));
    await assert.rejects(setThreadFiling(eclipse, nina.key, []), /Choose one or more/);
  });

  it("creates the sender and files the email from Capture", async () => {
    const oliver = (await listUnknownMail(ridgeon)).emails.find((email) => email.email === "oliver@workshops.test")!;
    const created = await createAndFileUnknown(ridgeon, oliver.key);
    assert.equal(created.contactName, "Oliver Grant");
    assert.deepEqual(await emailActivities(ridgeon.workspaceId, "oliver@workshops.test"), ["Workshop dates"]);
    assert.ok(!(await senders(ridgeon)).includes("oliver@workshops.test"));
  });

  it("routes future mail from a domain with a rule and refuses rules for free-mail domains", async () => {
    await assert.rejects(setDomainRule(eclipse, "@gmail.com", [ridgeon.workspaceId]), /can't have a rule/);
    const free = await addMessage(eclipse, primary, { id: "gmail", from: "friend@gmail.com", to: ["mark@geteclipse.co"], subject: "Lunch" });
    await assert.rejects(setThreadDomainRule(eclipse, free.key, [ridgeon.workspaceId]), /can't have a rule/);

    await createContact(eclipse, { firstName: "Ben", lastName: "Cole", email: "ben@brightwave.io", jobTitle: "Founder" });
    const rule = await setDomainRule(eclipse, "@BrightWave.io", [ridgeon.workspaceId]);
    assert.deepEqual(rule, { domain: "brightwave.io", workspaceIds: [ridgeon.workspaceId] });
    await addMessage(eclipse, primary, { id: "zoe", from: "zoe@brightwave.io", name: "Zoe Hart", to: ["mark@geteclipse.co"], subject: "Brief", at: minutesAgo(1) });
    await addMessage(eclipse, primary, { id: "ben", from: "ben@brightwave.io", to: ["mark@geteclipse.co"], subject: "Kick-off", at: minutesAgo(1) });
    await addMessage(eclipse, primary, { id: "bot", from: "noreply@brightwave.io", to: ["mark@geteclipse.co"], subject: "Receipt", at: minutesAgo(1) });
    await fileMailOnTimeline(eclipse);
    assert.deepEqual(await emailActivities(ridgeon.workspaceId, "zoe@brightwave.io"), ["Brief"]);
    assert.deepEqual(await emailActivities(ridgeon.workspaceId, "ben@brightwave.io"), ["Kick-off"]);
    assert.deepEqual(await emailActivities(eclipse.workspaceId, "ben@brightwave.io"), []);
    const ben = await getAdminPool().query<{ job_title: string | null }>(
      "select job_title from crm.contacts where workspace_id = $1 and normalized_email = 'ben@brightwave.io'",
      [ridgeon.workspaceId],
    );
    assert.equal(ben.rows[0]?.job_title, "Founder");
    const bot = await getAdminPool().query("select 1 from crm.contacts where normalized_email = 'noreply@brightwave.io'");
    assert.equal(bot.rowCount, 0);
    assert.ok(!(await senders(eclipse)).includes("zoe@brightwave.io"));
  });

  it("keeps one person's rules and choices away from other members", async () => {
    const admin = getAdminPool();
    const priyaBase = await createUser("priya@geteclipse.co", "Priya Shah");
    await admin.query("insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, 'member')", [ridgeon.workspaceId, priyaBase.userId]);
    const connection = await admin.query<{ id: string }>(
      `insert into crm.mailbox_connections (workspace_id, user_id, provider, email, status, refresh_token)
       values ($1, $2, 'microsoft', 'priya@geteclipse.co', 'connected', 'cipher') returning id`,
      [priyaBase.workspaceId, priyaBase.userId],
    );
    const box = await source(priyaBase, "connection_id", connection.rows[0].id, "priya@geteclipse.co");
    await setDomainRule(eclipse, "quietco.io", [ridgeon.workspaceId]);
    await addMessage(priyaBase, box, { id: "kim", from: "kim@quietco.io", name: "Kim Lo", to: ["priya@geteclipse.co"], subject: "Hello Priya", at: minutesAgo(1) });
    await fileMailOnTimeline(priyaBase);
    const kim = await admin.query("select 1 from crm.contacts where normalized_email = 'kim@quietco.io'");
    assert.equal(kim.rowCount, 0);
    assert.deepEqual(await senders(priyaBase), ["kim@quietco.io"]);
    const zoe = await addMessage(priyaBase, box, { id: "zoe-priya", from: "zoe@brightwave.io", to: ["priya@geteclipse.co"], subject: "Brief for Priya", at: minutesAgo(1) });
    await fileMailOnTimeline(priyaBase);
    assert.deepEqual(await emailActivities(ridgeon.workspaceId, "zoe@brightwave.io"), ["Brief", "Brief for Priya"]);
    assert.equal((await getThread(priyaBase, zoe.key)).filing?.rule, null);
    const rules = await queryAsUser(priyaBase.userId, "select * from crm.mail_domain_rules");
    const homes = await queryAsUser(priyaBase.userId, "select * from crm.mail_address_homes");
    const routes = await queryAsUser(priyaBase.userId, "select * from crm.mail_thread_routes");
    assert.deepEqual([rules.length, homes.length, routes.length], [0, 0, 0]);
    await assert.rejects(
      queryAsUser(priyaBase.userId, "insert into crm.mail_address_homes (workspace_id, user_id, address) values ($1, $2, 'x@y.test')", [eclipse.workspaceId, eclipse.userId]),
      /row-level security/,
    );
    await assert.rejects(
      queryAsUser(priyaBase.userId, "insert into crm.mail_domain_rules (workspace_id, user_id, domain, workspace_ids) values ($1, $2, 'x.test', $3::uuid[])", [
        priyaBase.workspaceId,
        priyaBase.userId,
        [eclipse.workspaceId],
      ]),
      /row-level security/,
    );
  });

  it("shows a dot for another workspace with something new in Capture", async () => {
    await markCaptureSeen(ridgeon, new Date());
    await markCaptureSeen(eclipse, new Date());
    let statuses = await captureStatuses(eclipse);
    assert.equal(statuses.get(ridgeon.workspaceId)?.fresh, 0);
    await addMessage(eclipse, primary, { id: "fresh", from: "tom@harbourco.test", name: "Tom Reid", to: ["mark@ridgeon.me"], subject: "Coffee next week?", at: new Date(Date.now() + 1_000).toISOString() });
    statuses = await captureStatuses(eclipse);
    assert.equal(statuses.get(ridgeon.workspaceId)?.fresh, 1);
    assert.equal(statuses.get(eclipse.workspaceId)?.fresh, 0);
    assert.ok((statuses.get(ridgeon.workspaceId)?.waiting ?? 0) >= 1);
  });
  it("drops a chosen contact when the thread is filed away from its workspace", async () => {
    const admin = getAdminPool();
    const office = (await createContact(eclipse, { firstName: "Pat", lastName: "Office", email: "office@quietfirm.test" })).body.contact;
    const pat = await addMessage(eclipse, primary, { id: "pat", from: "pat.home@quietfirm.test", name: "Pat Lane", to: ["mark@geteclipse.co"], subject: "From my other address" });
    await fileUnknownTo(eclipse, pat.key, office.id);
    const onOffice = async () =>
      (await admin.query<{ title: string }>("select title from crm.activities where contact_id = $1 and type = 'email' order by occurred_at", [office.id])).rows.map((row) => row.title);
    assert.deepEqual(await onOffice(), ["From my other address"]);

    await admin.query("update crm.mail_thread_routes set filed_in = $3::uuid[] where user_id = $1 and thread_key = $2", [eclipse.userId, "pat", [ridgeon.workspaceId]]);
    await addMessage(eclipse, primary, { id: "pat-2", thread: "pat", from: "pat.home@quietfirm.test", to: ["mark@geteclipse.co"], subject: "Re: From my other address", at: minutesAgo(2) });
    await fileMailOnTimeline(eclipse);
    assert.deepEqual(await onOffice(), ["From my other address"]);

    await setThreadFiling(eclipse, pat.key, [ridgeon.workspaceId]);
    const route = await admin.query<{ contact_id: string | null }>("select contact_id from crm.mail_thread_routes where user_id = $1 and thread_key = 'pat'", [eclipse.userId]);
    assert.equal(route.rows[0]?.contact_id, null);
    assert.deepEqual(await emailActivities(ridgeon.workspaceId, "pat.home@quietfirm.test"), ["From my other address", "Re: From my other address"]);
    assert.deepEqual(await onOffice(), ["From my other address"]);
  });

  it("checks the older inbox filer against the same thread choice and its source", async () => {
    const admin = getAdminPool();
    const connection = (await admin.query<{ connection_id: string }>("select connection_id from crm.mail_sources where id = $1", [primary.sourceId])).rows[0].connection_id;
    await admin.query(
      `insert into crm.mail_thread_routes (workspace_id, user_id, source_id, thread_key, filed_in, updated_at) values
         ($1, $2, $3, 'shared-key', $4::uuid[], now() - interval '1 hour'),
         ($1, $2, $5, 'shared-key', $6::uuid[], now())`,
      [eclipse.workspaceId, eclipse.userId, primary.sourceId, [eclipse.workspaceId], extra.sourceId, [ridgeon.workspaceId]],
    );
    const away = (workspaceId: string, connectionId?: string) =>
      withActor(eclipse, (db) => routedAway(db, eclipse.userId, workspaceId, "shared-key", "someone@elsewhere.test", connectionId));
    assert.equal(await away(eclipse.workspaceId, connection), false);
    assert.equal(await away(ridgeon.workspaceId, connection), true);
    assert.equal(await away(eclipse.workspaceId), true);
    assert.equal(await withActor(eclipse, (db) => routedAway(db, eclipse.userId, eclipse.workspaceId, "no-route", "zoe@brightwave.io", connection)), true);
    assert.equal(await withActor(eclipse, (db) => routedAway(db, eclipse.userId, ridgeon.workspaceId, "no-route", "zoe@brightwave.io", connection)), false);
  });

  it("files the thread here when you add someone while a rule sends it elsewhere", async () => {
    await createContact(eclipse, { firstName: "Ann", lastName: "Cobalt", email: "ann@cobaltworks.test", jobTitle: "COO" });
    await setDomainRule(eclipse, "cobaltworks.test", [eclipse.workspaceId]);
    const ann = await addMessage(eclipse, primary, { id: "ann", from: "ann@cobaltworks.test", name: "Ann Cobalt", to: ["mark@geteclipse.co"], subject: "Q2 plan", at: minutesAgo(1) });
    await fileMailOnTimeline(eclipse);
    assert.deepEqual((await getThread(ridgeon, ann.key)).filing?.filedIn, [eclipse.workspaceId]);
    const added = await addPersonHere(ridgeon, ann.key, "ann@cobaltworks.test");
    assert.deepEqual(added.filing?.filedIn, [eclipse.workspaceId, ridgeon.workspaceId]);
    assert.equal(added.filing?.chosen, true);
    assert.deepEqual(await emailActivities(ridgeon.workspaceId, "ann@cobaltworks.test"), ["Q2 plan"]);
    assert.deepEqual(await emailActivities(eclipse.workspaceId, "ann@cobaltworks.test"), ["Q2 plan"]);
  });

  it("refuses domain rules for your own, a colleague's or a consumer domain", async () => {
    const admin = getAdminPool();
    await assert.rejects(setDomainRule(eclipse, "@geteclipse.co", [ridgeon.workspaceId]), /your own or a colleague's domain/);
    const sam = await createUser("sam@partnerco.test", "Sam Partner");
    await admin.query("insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, 'member')", [ridgeon.workspaceId, sam.userId]);
    await assert.rejects(setDomainRule(eclipse, "partnerco.test", [eclipse.workspaceId]), /your own or a colleague's domain/);
    for (const domain of ["btinternet.com", "outlook.co.uk", "hotmail.fr", "yahoo.de", "sky.com", "virginmedia.com", "gmx.de"]) {
      assert.ok(isFreeMailDomain(domain), domain);
    }
    await assert.rejects(setDomainRule(eclipse, "@btinternet.com", [ridgeon.workspaceId]), /can't have a rule/);
  });

  it("writes prepared replies and nudges with the brand of the workspace the thread is filed in", async () => {
    const provenance = { operation: "test", source: "test" } as const;
    await saveBrandProfile(eclipse, { website: "", whatYouSell: "AI visibility for agencies.", whoItsFor: "", tone: "" }, provenance);
    await saveBrandProfile(ridgeon, { website: "", whatYouSell: "Fractional marketing leadership.", whoItsFor: "", tone: "" }, provenance);
    const sells = async (thread: string) => (await threadBrand(eclipse, primary.sourceId, thread))?.whatYouSell ?? null;
    assert.equal(await sells("sophie"), "Fractional marketing leadership.");
    assert.equal(await sells("james"), "AI visibility for agencies.");
    assert.equal(await sells("iggy"), "AI visibility for agencies.");
    assert.equal(await sells("fresh"), "Fractional marketing leadership.");
    assert.equal((await threadBrand(ridgeon, primary.sourceId, "sophie"))?.whatYouSell, "Fractional marketing leadership.");

    const prompts: string[] = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      prompts.push(String(init?.body ?? ""));
      return Response.json({ model: "test-model", choices: [{ message: { content: JSON.stringify({ body: "Hi, any news? Mark" }) }, finish_reason: "stop" }] });
    };
    const previous = process.env.LLM_API_KEY;
    process.env.LLM_API_KEY = "test-llm-key";
    try {
      await writeNudge(eclipse, primary.sourceId, "sophie", { fetchImpl });
      await writeNudge(eclipse, primary.sourceId, "james", { fetchImpl });
    } finally {
      if (previous === undefined) delete process.env.LLM_API_KEY;
      else process.env.LLM_API_KEY = previous;
    }
    assert.equal(prompts.length, 2);
    assert.match(prompts[0], /Fractional marketing leadership/);
    assert.doesNotMatch(prompts[0], /AI visibility for agencies/);
    assert.match(prompts[1], /AI visibility for agencies/);
    assert.doesNotMatch(prompts[1], /Fractional marketing leadership/);
  });
});
