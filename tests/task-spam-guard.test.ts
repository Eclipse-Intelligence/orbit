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
import { classifyCapture, listSenderRules, relevantMail } from "@/lib/mail/capture-filter";
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

  it("gives one thread-linked task to business mail from a colleague, and none to spam", async () => {
    process.env.LLM_API_KEY = "test-key";
    try {
      const admin = getAdminPool();
      await getAdminPool().query("update crm.profiles set other_emails = array['sam.alt@personal-guard.test', 'sam.spam@personal-guard.test'] where id = $1", [sam.userId]);
      const kimId = (await admin.query<{ id: string }>("select private.create_local_user('kim.free@gmail.com', 'password-123', 'Kim Free') as id")).rows[0].id;
      await admin.query("insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, 'member')", [second.workspaceId, kimId]);
      const business = await deliver(owner, box, "sam@guard.test", "Can you look at the proposal");
      const alias = await deliver(owner, box, "sam.alt@personal-guard.test", "From my other address");
      const free = await deliver(owner, box, "kim.free@gmail.com", "Quick question on the pitch");
      const junk = await deliver(owner, box, "sam.spam@personal-guard.test", "Win a prize now");
      const stranger = await deliver(owner, box, "someone@outsider-guard.test", "Hello from outside");
      const model = classifierGateway((address) => (address.startsWith("sam.spam@") ? "spam" : "business"));
      await fileMailOnTimeline(owner, { fetchImpl: model.fetchImpl });
      const tasks = async (key: string) => (await admin.query<{ company_id: string | null; contact_id: string | null }>("select company_id, contact_id from crm.tasks where mail_thread_key = $1", [key])).rows;
      for (const key of [business, alias, free]) {
        const rows = await tasks(key);
        assert.equal(rows.length, 1);
        assert.equal(rows[0].company_id, null);
        assert.equal(rows[0].contact_id, null);
      }
      assert.equal((await tasks(junk)).length, 0);
      assert.equal((await tasks(stranger)).length, 0);
      await fileMailOnTimeline(owner, { fetchImpl: model.fetchImpl });
      assert.equal((await tasks(business)).length, 1);
    } finally {
      delete process.env.LLM_API_KEY;
    }
  });
  it("asks the classifier about a colleague you have written to, and fails open when it is down", async () => {
    const admin = getAdminPool();
    await admin.query("update crm.profiles set other_emails = array_cat(other_emails, array['sam.lunch@personal-guard.test', 'sam.plan@personal-guard.test', 'sam.down@personal-guard.test']) where id = $1", [sam.userId]);
    for (const address of ["sam.lunch@personal-guard.test", "sam.plan@personal-guard.test", "sam.down@personal-guard.test"]) {
      await admin.query("insert into crm.mail_known_addresses (user_id, address, domain, sent_count, met_first) values ($1, $2, 'personal-guard.test', 3, now() - interval '30 days')", [owner.userId, address]);
    }
    const lunch = await deliver(owner, box, "sam.lunch@personal-guard.test", "Lunch Thursday?");
    const plan = await deliver(owner, box, "sam.plan@personal-guard.test", "Launch plan for review");
    const tasks = async (key: string) => (await admin.query("select 1 from crm.tasks where mail_thread_key = $1", [key])).rowCount;
    process.env.LLM_API_KEY = "test-key";
    try {
      const model = classifierGateway((address) => (address.startsWith("sam.lunch@") ? "personal" : "business"));
      await fileMailOnTimeline(owner, { fetchImpl: model.fetchImpl });
      assert.ok(model.asked.includes("sam.lunch@personal-guard.test"));
      assert.equal(await tasks(lunch), 0);
      assert.equal(await tasks(plan), 1);
      const down = await deliver(owner, box, "sam.down@personal-guard.test", "Are you around");
      await fileMailOnTimeline(owner, { fetchImpl: classifierGateway(() => "fail").fetchImpl });
      assert.equal(await tasks(down), 1);
    } finally {
      delete process.env.LLM_API_KEY;
    }
  });

  it("asks the classifier again for a colleague whose earlier email was business", async () => {
    const admin = getAdminPool();
    await admin.query("update crm.profiles set other_emails = array_append(other_emails, 'sam.cache@personal-guard.test') where id = $1", [sam.userId]);
    process.env.LLM_API_KEY = "test-key";
    try {
      let answer = "business";
      const model = classifierGateway(() => answer);
      const first = await deliver(owner, box, "sam.cache@personal-guard.test", "Contract draft", "mark@guard-orbit.test", 90);
      await fileMailOnTimeline(owner, { fetchImpl: model.fetchImpl });
      assert.equal((await admin.query("select 1 from crm.tasks where mail_thread_key = $1", [first])).rowCount, 1);
      answer = "personal";
      const second = await deliver(owner, box, "sam.cache@personal-guard.test", "Lunch Thursday?");
      const before = model.asked.length;
      await fileMailOnTimeline(owner, { fetchImpl: model.fetchImpl });
      assert.ok(model.asked.length > before);
      assert.equal((await admin.query("select 1 from crm.tasks where mail_thread_key = $1", [second])).rowCount, 0);
    } finally {
      delete process.env.LLM_API_KEY;
    }
  });

  it("asks the classifier for a colleague after Capture has copied a cached verdict onto the thread", async () => {
    const admin = getAdminPool();
    await admin.query("update crm.profiles set other_emails = array_append(other_emails, 'sam.copy@personal-guard.test') where id = $1", [sam.userId]);
    process.env.LLM_API_KEY = "test-key";
    try {
      let answer = "business";
      const model = classifierGateway(() => answer);
      const first = await deliver(owner, box, "sam.copy@personal-guard.test", "Contract draft", "mark@guard-orbit.test", 90);
      await fileMailOnTimeline(owner, { fetchImpl: model.fetchImpl });
      assert.equal((await admin.query("select 1 from crm.tasks where mail_thread_key = $1", [first])).rowCount, 1);
      await classifyCapture(owner, { fetchImpl: model.fetchImpl });
      answer = "personal";
      const second = await deliver(owner, box, "sam.copy@personal-guard.test", "Lunch Thursday?");
      await classifyCapture(owner, { fetchImpl: model.fetchImpl });
      const copied = await admin.query("select engine from crm.mail_thread_relevance where user_id = $1 and thread_key = $2", [owner.userId, second.split("|")[1]]);
      assert.equal(copied.rows[0]?.engine, "cached");
      const before = model.asked.length;
      await fileMailOnTimeline(owner, { fetchImpl: model.fetchImpl });
      assert.ok(model.asked.length > before);
      assert.equal((await admin.query("select 1 from crm.tasks where mail_thread_key = $1", [second])).rowCount, 0);
    } finally {
      delete process.env.LLM_API_KEY;
    }
  });

  it("never changes what Capture shows when it judges a colleague's thread personal", async () => {
    const admin = getAdminPool();
    await admin.query("update crm.profiles set other_emails = array_append(other_emails, 'sam.shown@personal-guard.test') where id = $1", [sam.userId]);
    process.env.LLM_API_KEY = "test-key";
    try {
      let answer = "business";
      const model = classifierGateway(() => answer);
      const first = await deliver(owner, box, "sam.shown@personal-guard.test", "Contract draft", "mark@guard-orbit.test", 90);
      await fileMailOnTimeline(owner, { fetchImpl: model.fetchImpl });
      assert.equal((await admin.query("select 1 from crm.tasks where mail_thread_key = $1", [first])).rowCount, 1);
      await classifyCapture(owner, { fetchImpl: model.fetchImpl });
      answer = "personal";
      const second = await deliver(owner, box, "sam.shown@personal-guard.test", "Lunch Thursday?");
      await classifyCapture(owner, { fetchImpl: model.fetchImpl });
      const stored = async () =>
        (await admin.query("select category, engine, decided_at from crm.mail_thread_relevance where user_id = $1 and thread_key = $2", [owner.userId, second.split("|")[1]])).rows[0];
      const sender = async () => (await admin.query("select category, engine, decided_at from crm.mail_sender_relevance where user_id = $1 and sender = 'sam.shown@personal-guard.test'", [owner.userId])).rows;
      const thread = await stored();
      const senders = await sender();
      assert.equal(thread.category, "business");
      const before = model.asked.length;
      await fileMailOnTimeline(owner, { fetchImpl: model.fetchImpl });
      assert.ok(model.asked.length > before);
      assert.equal((await admin.query("select 1 from crm.tasks where mail_thread_key = $1", [second])).rowCount, 0);
      assert.deepEqual(await stored(), thread);
      assert.deepEqual(await sender(), senders);
      const shown = await relevantMail(owner, [owner], Date.now(), { fetchImpl: model.fetchImpl });
      assert.ok(shown.shown.some((email) => email.key === second));
      assert.ok(!shown.skipped.some((email) => email.key === second));
    } finally {
      delete process.env.LLM_API_KEY;
    }
  });

  it("asks the classifier nothing more about a colleague thread it already judged personal", async () => {
    const admin = getAdminPool();
    await admin.query("update crm.profiles set other_emails = array_append(other_emails, 'sam.once@personal-guard.test') where id = $1", [sam.userId]);
    process.env.LLM_API_KEY = "test-key";
    try {
      const model = classifierGateway(() => "personal");
      const key = await deliver(owner, box, "sam.once@personal-guard.test", "Lunch Thursday?");
      const timesAsked = () => model.asked.filter((address) => address === "sam.once@personal-guard.test").length;
      await fileMailOnTimeline(owner, { fetchImpl: model.fetchImpl });
      assert.equal(timesAsked(), 1);
      assert.equal((await admin.query("select 1 from crm.mail_task_judgements j join crm.mail_messages m on m.id = j.message_id where j.user_id = $1 and m.thread_key = $2 and not j.worth", [owner.userId, key.split("|")[1]])).rowCount, 1);
      assert.equal((await admin.query("select 1 from crm.mail_thread_relevance where user_id = $1 and thread_key = $2", [owner.userId, key.split("|")[1]])).rowCount, 0);
      await fileMailOnTimeline(owner, { fetchImpl: model.fetchImpl });
      assert.equal(timesAsked(), 1);
      assert.equal((await admin.query("select 1 from crm.tasks where mail_thread_key = $1", [key])).rowCount, 0);
    } finally {
      delete process.env.LLM_API_KEY;
    }
  });

  it("gives a colleague no task while a Capture sort of the thread is unfinished, then one once it is decided", async () => {
    const admin = getAdminPool();
    await admin.query("update crm.profiles set other_emails = array_append(other_emails, 'sam.held@personal-guard.test') where id = $1", [sam.userId]);
    process.env.LLM_API_KEY = "test-key";
    try {
      const key = await deliver(owner, box, "sam.held@personal-guard.test", "Held thread");
      const { classifyItems } = await import("@/lib/mail/capture-filter");
      let release: () => void = () => undefined;
      const slow: typeof fetch = () =>
        new Promise((resolve) => {
          release = () => resolve(Response.json({ model: "test", choices: [{ message: { content: JSON.stringify({ category: "business", confidence: 0.9, reason: "Test." }) }, finish_reason: "stop" }] }));
        });
      const row = (await admin.query<{ id: string }>("select id from crm.mail_messages where source_id = $1 and thread_key = $2", [key.split("|")[0], key.split("|")[1]])).rows[0];
      const item = { key, messageId: row.id, email: "sam.held@personal-guard.test", name: null, subject: "Held thread", snippet: "Held thread", address: "mark@guard-orbit.test", workspaceId: owner.workspaceId, at: new Date().toISOString(), neverAsk: "" };
      const sorting = classifyItems(owner, [owner], [{ item, hint: null }], { deadline: Date.now() + 30_000, fetchImpl: slow });
      await new Promise((resolve) => setTimeout(resolve, 300));
      await fileMailOnTimeline(owner, { fetchImpl: classifierGateway(() => "business").fetchImpl, titleTimeoutMs: 400 });
      const tasks = async () => (await admin.query("select 1 from crm.tasks where mail_thread_key = $1", [key])).rowCount;
      assert.equal(await tasks(), 0);
      release();
      await sorting;
      await fileMailOnTimeline(owner, { fetchImpl: classifierGateway(() => "business").fetchImpl });
      assert.equal(await tasks(), 1);
    } finally {
      delete process.env.LLM_API_KEY;
    }
  });

  it("gives no task to people outside your workspaces or to your own addresses, and files no activity for colleagues", async () => {
    const admin = getAdminPool();
    await saveBrandProfile(second, { ...PROFILE, ownDomains: "ridgeon-own.test, guard.test" }, WEB);
    try {
      await admin.query(
        "insert into crm.send_identities (workspace_id, user_id, source_id, email, smtp_host, smtp_port, username, password_cipher) values ($1, $2, $3, 'mark.sending@ridgeon-own.test', 'smtp.test', 587, 'mark', 'x')",
        [owner.workspaceId, owner.userId, box.sourceId],
      );
      const keys = [
        await deliver(owner, box, "stranger@guard-stranger.test", "Quick question"),
        await deliver(owner, box, "mark@guard.test", "Note to self"),
        await deliver(owner, box, "mark.sending@ridgeon-own.test", "From my sending address"),
      ];
      const colleague = await deliver(owner, box, "sam@guard.test", "Does Friday work");
      const activities = async () => Number((await admin.query<{ count: string }>("select count(*) from crm.activities")).rows[0].count);
      const before = await activities();
      await fileMailOnTimeline(owner, {});
      assert.equal(await activities(), before);
      for (const key of keys) assert.equal((await admin.query("select 1 from crm.tasks where mail_thread_key = $1", [key])).rowCount, 0);
      assert.equal((await admin.query("select 1 from crm.tasks where mail_thread_key = $1", [colleague])).rowCount, 1);
    } finally {
      await saveBrandProfile(second, PROFILE, WEB);
    }
  });
  it("lets a real enquiry from a company through after spam from the same company in one inbox batch", async () => {
    process.env.LLM_API_KEY = "test-key";
    try {
      const { company, email } = await prospect(owner, "Acme Batch");
      const domain = email.split("@")[1];
      await createContact(owner, { companyId: company, firstName: "Jane", lastName: "Real", email: `jane@${domain}` });
      const junk = await deliver(owner, box, email, "Spring sale");
      const real = await deliver(owner, box, `jane@${domain}`, "Project enquiry");
      const at = new Date(Date.now() - 600_000).toISOString();
      const message = (key: string, from: string, subject: string) => ({ providerMessageId: key.split("|")[1], conversationId: key.split("|")[1], subject, fromEmail: from, fromName: "X", preview: subject, receivedAt: at });
      const model = classifierGateway((address) => (address === email ? "newsletter" : "business"));
      const result = await fileInboundMessages(owner, [message(junk, email, "Spring sale"), message(real, `jane@${domain}`, "Project enquiry")], { fetchImpl: model.fetchImpl });
      assert.equal(result.followUps, 1);
      assert.equal((await taskTitles(owner, company)).length, 1);
      assert.equal((await getAdminPool().query("select 1 from crm.tasks where mail_thread_key = $1", [real])).rowCount, 1);
    } finally {
      delete process.env.LLM_API_KEY;
    }
  });

  it("never mutes a colleague from another of the owner's workspaces", async () => {
    const admin = getAdminPool();
    const kimId = (await admin.query<{ id: string }>("select private.create_local_user('kim.colleague@gmail.com', 'password-123', 'Kim Colleague') as id")).rows[0].id;
    await admin.query("insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, 'member')", [second.workspaceId, kimId]);
    const key = await deliver(owner, box, "kim.colleague@gmail.com", "Quick one");
    const made = await createTask(owner, { title: "Reply to Kim", ownerId: owner.userId, mailThreadKey: key }, { provenance: { operation: "suggest_follow_up", source: "microsoft" } });
    const outcome = await markTaskSpam(owner, made.body.task.id);
    assert.equal(outcome.target, null);
    const rules = await admin.query("select 1 from crm.mail_sender_relevance where user_id = $1 and sender = 'kim.colleague@gmail.com'", [owner.userId]);
    assert.equal(rules.rowCount, 0);
  });

  it("gives no task to an unsubscribed sender", async () => {
    process.env.LLM_API_KEY = "test-key";
    try {
      const quiet = await prospect(owner, "Unsub Co");
      await getAdminPool().query("insert into crm.mail_subscriptions (workspace_id, user_id, sender, status) values ($1, $2, $3, 'unsubscribed')", [owner.workspaceId, owner.userId, quiet.email]);
      await deliver(owner, box, quiet.email, "Hello again");
      await fileMailOnTimeline(owner, { fetchImpl: classifierGateway(() => "business").fetchImpl });
      assert.deepEqual(await taskTitles(owner, quiet.company), []);
    } finally {
      delete process.env.LLM_API_KEY;
    }
  });

  for (const verdict of ["spam", "business"] as const) {
    it(`waits for a sort already running on the thread, which stores ${verdict}`, async () => {
      process.env.LLM_API_KEY = "test-key";
      try {
        const busy = await prospect(owner, `Busy ${verdict} Co`);
        const key = await deliver(owner, box, busy.email, "Terms");
        const { classifyItems } = await import("@/lib/mail/capture-filter");
        let release: () => void = () => undefined;
        const slow: typeof fetch = () =>
          new Promise((resolve) => {
            release = () => resolve(Response.json({ model: "test", choices: [{ message: { content: JSON.stringify({ category: verdict, confidence: 0.9, reason: "Test." }) }, finish_reason: "stop" }] }));
          });
        const row = (await getAdminPool().query<{ id: string }>("select id from crm.mail_messages where source_id = $1 and thread_key = $2", [key.split("|")[0], key.split("|")[1]])).rows[0];
        const item = { key, messageId: row.id, email: busy.email, name: null, subject: "Terms", snippet: "Terms", address: "mark@guard-orbit.test", workspaceId: owner.workspaceId, at: new Date().toISOString(), neverAsk: "" };
        const sorting = classifyItems(owner, [owner], [{ item, hint: null }], { deadline: Date.now() + 30_000, fetchImpl: slow });
        await new Promise((resolve) => setTimeout(resolve, 300));
        const filing = fileMailOnTimeline(owner, { fetchImpl: classifierGateway(() => "business").fetchImpl });
        await new Promise((resolve) => setTimeout(resolve, 300));
        release();
        await sorting;
        await filing;
        assert.equal((await taskTitles(owner, busy.company)).length, verdict === "spam" ? 0 : 1);
      } finally {
        delete process.env.LLM_API_KEY;
      }
    });
  }
});
