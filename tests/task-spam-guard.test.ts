import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { saveBrandProfile } from "@/lib/crm/brand";
import { createCompany } from "@/lib/crm/companies";
import { createContact } from "@/lib/crm/contacts";
import { fileInboundMessages } from "@/lib/crm/inbox";
import { scopesForRole } from "@/lib/crm/scopes";
import { archiveTask, createTask, listTasks, updateTask } from "@/lib/crm/tasks";
import type { UserActor } from "@/lib/crm/types";
import { createWorkspace } from "@/lib/crm/workspaces";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { classifyCapture, listSenderRules } from "@/lib/mail/capture-filter";
import { markTaskSpam } from "@/lib/mail/filing";
import { fileMailOnTimeline } from "@/lib/mail/timeline";
import { createUser, resetDatabase, useServerlessPool } from "./helpers";

delete process.env.TYPESAFE_API_KEY;
delete process.env.LLM_API_KEY;

const WEB = { operation: "task_spam_guard_test", source: "web" };
const PROFILE = { website: "", whatYouSell: "Software for brands.", whoItsFor: "Marketing leads.", tone: "" };

type Box = { sourceId: string; inbox: string };

function classifierGateway(category: (address: string) => string | "fail") {
  const asked: string[] = [];
  const fetchImpl: typeof fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { model: string; messages: { content: string }[] };
    const [system, user] = body.messages.map((message) => message.content);
    if (system.startsWith("You decide whether an email belongs in a CRM")) {
      const address = (JSON.parse(user) as { email: { fromAddress: string } }).email.fromAddress;
      asked.push(address);
      const answer = category(address);
      if (answer === "fail") return new Response("down", { status: 400 });
      return Response.json({ model: body.model, choices: [{ message: { content: JSON.stringify({ category: answer, confidence: 0.4, reason: "Test." }) }, finish_reason: "stop" }] });
    }
    return Response.json({ model: body.model, choices: [{ message: { content: JSON.stringify({ title: "Reply to them" }) }, finish_reason: "stop" }] });
  };
  return { fetchImpl, asked };
}

describe("tasks suggested from mail are gated on relevance", () => {
  let owner: UserActor;
  let second: UserActor;
  let sam: UserActor;
  let stranger: UserActor;
  let box: Box;
  let counter = 0;

  before(async () => {
    await resetDatabase();
    const admin = getAdminPool();
    owner = await createUser("mark@guard.test", "Mark Ridgeon");
    await saveBrandProfile(owner, PROFILE, WEB);
    const samId = (await admin.query<{ id: string }>("select private.create_local_user('sam@guard.test', 'password-123', 'Sam Colleague') as id")).rows[0].id;
    await admin.query("insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, 'member')", [owner.workspaceId, samId]);
    sam = { ...owner, userId: samId, email: "sam@guard.test", fullName: "Sam Colleague", role: "member", scopes: scopesForRole("member") };
    stranger = await createUser("stranger@guard-stranger.test", "Stranger");
    const created = await createWorkspace(owner, { name: "Mark Ridgeon" });
    second = { ...owner, workspaceId: created.id, workspaceName: "Mark Ridgeon", role: "owner", scopes: scopesForRole("owner") };
    box = await mailbox(owner, "mark@guard-orbit.test");
  });

  after(async () => {
    await getPool().end();
    await getAdminPool().end();
  });

  useServerlessPool();

  async function mailbox(user: UserActor, email: string): Promise<Box> {
    const admin = getAdminPool();
    const connection = (
      await admin.query<{ id: string }>(
        `insert into crm.mailbox_connections (workspace_id, user_id, provider, email, status, refresh_token)
         values ($1, $2, 'microsoft', $3, 'connected', 'cipher') returning id`,
        [user.workspaceId, user.userId, email],
      )
    ).rows[0].id;
    const source = (
      await admin.query<{ id: string }>("insert into crm.mail_sources (workspace_id, user_id, email, connection_id) values ($1, $2, $3, $4) returning id", [user.workspaceId, user.userId, email, connection])
    ).rows[0].id;
    const inbox = (
      await admin.query<{ id: string }>(
        "insert into crm.mail_folders (workspace_id, user_id, source_id, provider_folder_id, name, role) values ($1, $2, $3, 'inbox', 'inbox', 'inbox') returning id",
        [user.workspaceId, user.userId, source],
      )
    ).rows[0].id;
    return { sourceId: source, inbox };
  }

  async function deliver(user: UserActor, where: Box, from: string, subject: string, to = "mark@guard-orbit.test", minutesAgo = 60) {
    counter += 1;
    const id = `guard-${counter}`;
    await getAdminPool().query(
      `insert into crm.mail_messages (workspace_id, user_id, source_id, folder_id, provider_message_id, internet_message_id, thread_key, subject, snippet, body_text,
         from_email, from_name, to_recipients, cc_recipients, sent_at, received_at)
       values ($1, $2, $3, $4, $5, $6, $5, $7, $8, $8, $9, 'Sender', $10::jsonb, '[]'::jsonb, $11, $11)`,
      [user.workspaceId, user.userId, where.sourceId, where.inbox, id, `<${id}@guard.test>`, subject, `${subject} body`, from, JSON.stringify([{ name: "", address: to }]), new Date(Date.now() - minutesAgo * 60_000).toISOString()],
    );
    return `${where.sourceId}|${id}`;
  }

  async function prospect(user: UserActor, name: string) {
    counter += 1;
    const domain = `prospect${counter}-guard.test`;
    const company = (await createCompany(user, { name, domain })).body.company.id;
    await createContact(user, { companyId: company, firstName: "Pat", lastName: name, email: `pat@${domain}` });
    return { company, email: `pat@${domain}` };
  }

  async function taskTitles(user: UserActor, company: string) {
    return (await listTasks(user, { companyId: company })).data.map((task) => task.title);
  }

  async function threadCategory(key: string) {
    const split = key.indexOf("|");
    const result = await getAdminPool().query<{ category: string | null; engine: string }>("select category, engine from crm.mail_thread_relevance where source_id = $1 and thread_key = $2", [
      key.slice(0, split),
      key.slice(split + 1),
    ]);
    return result.rows[0] ?? null;
  }

  it("gives a spam verdict no task, even at low confidence, and files the email", async () => {
    process.env.LLM_API_KEY = "test-key";
    try {
      const { company, email } = await prospect(owner, "Spam Co");
      const key = await deliver(owner, box, email, "You won a prize");
      const gateway = classifierGateway(() => "spam");
      const result = await fileMailOnTimeline(owner, { fetchImpl: gateway.fetchImpl });
      assert.equal(result.filed, 1);
      assert.deepEqual(await taskTitles(owner, company), []);
      assert.deepEqual(gateway.asked, [email]);
      assert.equal((await threadCategory(key))?.category, "spam");
    } finally {
      delete process.env.LLM_API_KEY;
    }
  });

  it("suggests the task when the email is judged business, and classifies a pending thread once", async () => {
    process.env.LLM_API_KEY = "test-key";
    try {
      const { company, email } = await prospect(owner, "Real Co");
      const key = await deliver(owner, box, email, "Pilot terms");
      const gateway = classifierGateway(() => "business");
      await fileMailOnTimeline(owner, { fetchImpl: gateway.fetchImpl });
      assert.equal((await taskTitles(owner, company)).length, 1);
      assert.deepEqual(gateway.asked, [email]);
      assert.equal((await threadCategory(key))?.engine, "haiku");
      const again = classifierGateway(() => "spam");
      await classifyCapture(owner, { deadline: Date.now() + 60_000, fetchImpl: again.fetchImpl, readHeaders: async () => [] });
      assert.ok(!again.asked.includes(email), "Capture reuses the stored decision");
    } finally {
      delete process.env.LLM_API_KEY;
    }
  });

  it("suggests the task when the classifier is not configured or fails", async () => {
    const quiet = await prospect(owner, "Quiet Co");
    await deliver(owner, box, quiet.email, "Question");
    await fileMailOnTimeline(owner, {});
    assert.equal((await taskTitles(owner, quiet.company)).length, 1);

    process.env.LLM_API_KEY = "test-key";
    try {
      const down = await prospect(owner, "Outage Co");
      await deliver(owner, box, down.email, "Question");
      await fileMailOnTimeline(owner, { fetchImpl: classifierGateway(() => "fail").fetchImpl });
      assert.equal((await taskTitles(owner, down.company)).length, 1);
    } finally {
      delete process.env.LLM_API_KEY;
    }
  });

  it("keeps a muted sender rule from giving a task without asking the model", async () => {
    process.env.LLM_API_KEY = "test-key";
    try {
      const { company, email } = await prospect(owner, "Muted Co");
      await getAdminPool().query(
        "insert into crm.mail_sender_relevance (workspace_id, user_id, sender, category, engine, rule) values ($1, $2, $3, 'muted', 'rule', true)",
        [owner.workspaceId, owner.userId, `@${email.split("@")[1]}`],
      );
      await deliver(owner, box, email, "Hello");
      const gateway = classifierGateway(() => "business");
      await fileMailOnTimeline(owner, { fetchImpl: gateway.fetchImpl });
      assert.deepEqual(await taskTitles(owner, company), []);
      assert.deepEqual(gateway.asked, []);
    } finally {
      delete process.env.LLM_API_KEY;
    }
  });

  it("treats your domains as internal for the person's mail in every workspace they are in", async () => {
    const saved = await saveBrandProfile(second, { ...PROFILE, ownDomains: " @Ridgeon-Own.test, markridgeon-own.test ,ridgeon-own.test" }, WEB);
    assert.deepEqual(saved.ownDomains, ["ridgeon-own.test", "markridgeon-own.test"]);
    await assert.rejects(saveBrandProfile(second, { ...PROFILE, ownDomains: "gmail.com" }, WEB), /gmail\.com is shared by many people/);
    await assert.rejects(saveBrandProfile(second, { ...PROFILE, ownDomains: "not a domain!" }, WEB), /isn't a domain/);
    await assert.rejects(saveBrandProfile(sam, { ...PROFILE, ownDomains: "sam-own.test" }, WEB), /Only owners and admins/);
    assert.deepEqual((await saveBrandProfile(second, PROFILE, WEB)).ownDomains, saved.ownDomains);

    const home = await createCompany(owner, { name: "Own Website Co", domain: "ridgeon-own.test" });
    const company = home.body.company.id;
    await createContact(owner, { companyId: company, firstName: "Mark", lastName: "Ridgeon", email: "mark@ridgeon-own.test" });
    const enquiry = await deliver(owner, box, "website@ridgeon-own.test", "New enquiry");
    const result = await fileMailOnTimeline(owner, {});
    assert.equal(result.filed, 0);
    assert.deepEqual(await taskTitles(owner, company), []);
    const activities = await getAdminPool().query("select 1 from crm.activities where company_id = $1", [company]);
    assert.equal(activities.rowCount, 0);
    const threadTasks = async (key: string) => (await getAdminPool().query<{ company_id: string | null; contact_id: string | null }>("select company_id, contact_id from crm.tasks where mail_thread_key = $1 and archived_at is null", [key])).rows;
    assert.deepEqual(await threadTasks(enquiry), [{ company_id: null, contact_id: null }]);
    await fileMailOnTimeline(owner, {});
    assert.equal((await threadTasks(enquiry)).length, 1, "one task per thread");

    process.env.LLM_API_KEY = "test-key";
    try {
      const junk = await deliver(owner, box, "junk@ridgeon-own.test", "You won a prize");
      await fileMailOnTimeline(owner, { fetchImpl: classifierGateway(() => "spam").fetchImpl });
      assert.deepEqual(await threadTasks(junk), []);
      const real = await deliver(owner, box, "forms@ridgeon-own.test", "Pilot terms");
      await fileMailOnTimeline(owner, { fetchImpl: classifierGateway(() => "business").fetchImpl });
      assert.equal((await threadTasks(real)).length, 1);
    } finally {
      delete process.env.LLM_API_KEY;
    }

    const theirs = await createCompany(stranger, { name: "Own Website Co", domain: "ridgeon-own.test" });
    await createContact(stranger, { companyId: theirs.body.company.id, firstName: "Mark", lastName: "Ridgeon", email: "mark@ridgeon-own.test" });
    const strangerBox = await mailbox(stranger, "stranger@guard-stranger.test");
    await deliver(stranger, strangerBox, "website@ridgeon-own.test", "New enquiry", "stranger@guard-stranger.test");
    assert.equal((await fileMailOnTimeline(stranger, {})).filed, 1);
    assert.equal((await taskTitles(stranger, theirs.body.company.id)).length, 1);
  });

  it("marks a suggested task as spam, deleting it and muting the sender, for the mailbox owner only", async () => {
    const { company, email } = await prospect(owner, "Junk Co");
    const key = await deliver(owner, box, email, "Great offer");
    await fileMailOnTimeline(owner, {});
    const [task] = (await listTasks(owner, { companyId: company })).data;
    assert.ok(task);
    assert.equal(task.mailThread?.readable, true);

    await updateTask(owner, task.id, { ownerId: sam.userId });
    const theirs = (await listTasks(sam, { companyId: company })).data.find((item) => item.id === task.id);
    assert.ok(theirs);
    assert.equal(theirs.mailThread?.readable, false);
    await assert.rejects(markTaskSpam(sam, task.id), /Only the person who got this email/);
    await updateTask(owner, task.id, { ownerId: owner.userId });

    const plain = (await createTask(owner, { title: "Call them", ownerId: owner.userId, companyId: company })).body.task;
    await assert.rejects(markTaskSpam(owner, plain.id), /Only a task suggested from an email/);

    const outcome = await markTaskSpam(owner, task.id);
    assert.equal(outcome.target, `@${email.split("@")[1]}`);
    assert.deepEqual((await listTasks(owner, { companyId: company })).data.map((item) => item.id), [plain.id]);
    const rules = await listSenderRules(owner);
    assert.ok(rules.some((rule) => rule.sender === outcome.target && rule.kind === "never"));
    const route = await getAdminPool().query("select 1 from crm.mail_thread_routes where user_id = $1 and thread_key = $2 and ignored_at is not null", [owner.userId, key.slice(key.indexOf("|") + 1)]);
    assert.equal(route.rowCount, 1);
  });

  it("never saves a rule for an internal address", async () => {
    await saveBrandProfile(owner, { ...PROFILE, ownDomains: "guard-own.test" }, WEB);
    const { company } = await prospect(owner, "Inside Co");
    const key = await deliver(owner, box, "pat@guard-own.test", "Note to self");
    const admin = getAdminPool();
    const created = await createTask(
      owner,
      { title: "Reply to Pat", ownerId: owner.userId, companyId: company, mailThreadKey: key },
      { provenance: { operation: "suggest_follow_up", source: "microsoft" } },
    );
    const outcome = await markTaskSpam(owner, created.body.task.id);
    assert.equal(outcome.target, null);
    const rules = await admin.query("select 1 from crm.mail_sender_relevance where user_id = $1 and sender like '%guard-own.test'", [owner.userId]);
    assert.equal(rules.rowCount, 0);
    await saveBrandProfile(owner, { ...PROFILE, ownDomains: "" }, WEB);
  });
  it("judges an inbox sync email the mirror doesn't hold yet, without storing the decision", async () => {
    process.env.LLM_API_KEY = "test-key";
    try {
      const junk = await prospect(owner, "Inbox Junk Co");
      const spam = classifierGateway(() => "spam");
      const first = await fileInboundMessages(
        owner,
        [{ providerMessageId: "raw-spam", conversationId: "raw-spam-thread", subject: "You won", fromEmail: junk.email, fromName: "Pat", preview: "Claim your prize", receivedAt: new Date(Date.now() - 600_000).toISOString() }],
        { fetchImpl: spam.fetchImpl },
      );
      assert.equal(first.attached, 1);
      assert.equal(first.followUps, 0);
      assert.deepEqual(spam.asked, [junk.email]);
      assert.deepEqual(await taskTitles(owner, junk.company), []);
      assert.equal((await threadCategory(`${box.sourceId}|raw-spam-thread`)), null);

      const real = await prospect(owner, "Inbox Real Co");
      const business = classifierGateway(() => "business");
      const second = await fileInboundMessages(
        owner,
        [{ providerMessageId: "raw-real", conversationId: "raw-real-thread", subject: "Pilot terms", fromEmail: real.email, fromName: "Pat", preview: "Can we talk terms?", receivedAt: new Date(Date.now() - 600_000).toISOString() }],
        { fetchImpl: business.fetchImpl },
      );
      assert.equal(second.followUps, 1);
      assert.equal((await taskTitles(owner, real.company)).length, 1);
    } finally {
      delete process.env.LLM_API_KEY;
    }
  });
  it("suggests at most one task per own-domain thread, even after it is deleted or marked as spam", async () => {
    const gone = await deliver(owner, box, "forms@ridgeon-own.test", "Enquiry one");
    const junk = await deliver(owner, box, "forms@ridgeon-own.test", "Enquiry two");
    await fileMailOnTimeline(owner, {});
    const open = async (key: string) => (await getAdminPool().query<{ id: string }>("select id from crm.tasks where mail_thread_key = $1", [key])).rows.map((row) => row.id);
    const [first] = await open(gone);
    const [second] = await open(junk);
    assert.ok(first && second);
    await archiveTask(owner, first);
    const spammed = await markTaskSpam(owner, second);
    assert.equal(spammed.target, null);
    await fileMailOnTimeline(owner, {});
    await fileMailOnTimeline(owner, {});
    assert.equal((await open(gone)).length, 1);
    assert.equal((await open(junk)).length, 1);
    const live = await getAdminPool().query("select 1 from crm.tasks where mail_thread_key = any($1::text[]) and archived_at is null", [[gone, junk]]);
    assert.equal(live.rowCount, 0);
  });

  it("gets to a business own-domain thread behind more than 20 spam threads", async () => {
    process.env.LLM_API_KEY = "test-key";
    try {
      const real = await deliver(owner, box, "enquiries@ridgeon-own.test", "Real project", "mark@guard-orbit.test", 120);
      for (let index = 0; index < 22; index += 1) await deliver(owner, box, `spam${index}@ridgeon-own.test`, `Prize ${index}`, "mark@guard-orbit.test", 30);
      const model = classifierGateway((address) => (address.startsWith("enquiries@") ? "business" : "spam"));
      const tasks = async () => (await getAdminPool().query("select 1 from crm.tasks where mail_thread_key = $1", [real])).rowCount;
      for (let round = 0; round < 4 && !(await tasks()); round += 1) await fileMailOnTimeline(owner, { fetchImpl: model.fetchImpl });
      assert.equal(await tasks(), 1);
      const before = model.asked.length;
      await fileMailOnTimeline(owner, { fetchImpl: model.fetchImpl });
      assert.equal(model.asked.length, before, "judged threads are not read again");
      const spamTasks = await getAdminPool().query("select 1 from crm.tasks where title like '%Prize%'");
      assert.equal(spamTasks.rowCount, 0);
    } finally {
      delete process.env.LLM_API_KEY;
    }
  });

  it("gives no task for mail from a colleague on one of your domains", async () => {
    await saveBrandProfile(second, { ...PROFILE, ownDomains: "ridgeon-own.test, guard.test" }, WEB);
    await getAdminPool().query("update crm.profiles set other_emails = array['sam.alt@ridgeon-own.test'] where id = $1", [sam.userId]);
    const direct = await deliver(owner, box, "sam@guard.test", "Quick question");
    const alias = await deliver(owner, box, "sam.alt@ridgeon-own.test", "From my other address");
    const outsider = await deliver(owner, box, "forms@ridgeon-own.test", "Colleague check");
    await fileMailOnTimeline(owner, {});
    const count = async (key: string) => (await getAdminPool().query("select 1 from crm.tasks where mail_thread_key = $1", [key])).rowCount;
    assert.equal(await count(direct), 0);
    assert.equal(await count(alias), 0);
    assert.equal(await count(outsider), 1);
    await saveBrandProfile(second, { ...PROFILE, ownDomains: "ridgeon-own.test" }, WEB);
  });
});
