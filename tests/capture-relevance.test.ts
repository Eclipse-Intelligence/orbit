import assert from "node:assert/strict";
import { after, afterEach, before, describe, it } from "node:test";
import { runTool } from "@/lib/assistant/tools";
import { saveBrandProfile } from "@/lib/crm/brand";
import { listPeopleMet } from "@/lib/crm/calendar";
import { captureContext, captureStatus } from "@/lib/crm/capture";
import { readCaptureAction, runCaptureAction } from "@/lib/crm/capture-actions";
import { saveAboutYou } from "@/lib/crm/personal-context";
import { scopesForRole } from "@/lib/crm/scopes";
import type { UserActor } from "@/lib/crm/types";
import { createWorkspace } from "@/lib/crm/workspaces";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { learnNow } from "@/lib/learning/nightly";
import { classifyCapture, listUnknownMail } from "@/lib/mail/capture-filter";
import { createAndFileUnknown } from "@/lib/mail/filing";
import { setAddressHome } from "@/lib/mail/routing";
import { bulkHeaderCategory, isMeetingNoise, listedCategory } from "@/lib/mail/senders";
import { createUser, queryAsUser, resetDatabase } from "./helpers";

delete process.env.TYPESAFE_API_KEY;
delete process.env.LLM_API_KEY;

type Box = { sourceId: string; inbox: string; sent: string };
type State = {
  business: { name: string; whatItSells: string; idealCustomer: string; formerNames?: string[] };
  person: { name: string; role: string; aboutYou?: string };
  history: { mailWithSender: string; mailWithDomain: string; userHasWrittenToSender: boolean; userHasWrittenToDomain: boolean; meetings: number };
  email: { fromName: string | null; fromAddress: string; receivedBy: string; subject: string | null; snippet: string | null; signature?: string };
};
type Answer = { category: string; confidence?: number; reason?: string } | "fail";

const WEB = { operation: "capture_relevance_test", source: "web" };

function minutesAgo(minutes: number) {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

function gateway(options: { haiku?: (state: State) => Answer; jev?: (body: { state: State; questions: Record<string, { type: string; criteria: unknown }> }) => unknown }) {
  const haiku: { model: string; system: string; state: State }[] = [];
  const jev: { state: State; questions: Record<string, { type: string; criteria: unknown }> }[] = [];
  const learning: string[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.startsWith("https://api.typesafe.ai/")) {
      const body = JSON.parse(String(init?.body));
      jev.push(body);
      const answer = options.jev?.(body);
      if (answer === "fail" || answer === undefined) return new Response("down", { status: 503 });
      return Response.json({ answers: answer });
    }
    if (url.endsWith("/chat/completions")) {
      const body = JSON.parse(String(init?.body)) as { model: string; messages: { content: string }[] };
      const [system, user] = body.messages.map((message) => message.content);
      if (system.includes("long-term memory")) {
        learning.push(user);
        return Response.json({ model: "test", choices: [{ message: { content: JSON.stringify({ add: [], update: [], archive: [] }) }, finish_reason: "stop" }] });
      }
      const state = JSON.parse(user) as State;
      haiku.push({ model: body.model, system, state });
      const answer = options.haiku?.(state) ?? "fail";
      if (answer === "fail") return new Response("broken", { status: 400 });
      return Response.json({
        model: body.model,
        choices: [{ message: { content: JSON.stringify({ confidence: 0.9, reason: "Test reason.", ...answer }) }, finish_reason: "stop" }],
      });
    }
    return new Response("not here", { status: 404 });
  };
  return { fetchImpl, haiku, jev, learning };
}

const BY_SUBJECT: Record<string, string> = {
  Partnership: "business",
  Invoice: "supplier",
  "Security alert": "service",
  "Test results": "personal",
  "Final demand": "collections",
  "You won": "spam",
  "Spring sale": "newsletter",
};

function bySubject(state: State): Answer {
  const found = Object.entries(BY_SUBJECT).find(([subject]) => state.email.subject?.startsWith(subject));
  return { category: found?.[1] ?? "business" };
}

describe("Capture relevance", () => {
  let eclipse: UserActor;
  let ridgeon: UserActor;
  let primary: Box;
  let extra: Box;
  let connectionId: string;

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
    box: Box,
    values: { id: string; thread?: string; from: string; name?: string; to: string[]; subject: string; body?: string; at?: string; sent?: boolean; focused?: boolean },
  ) {
    const result = await getAdminPool().query<{ id: string }>(
      `insert into crm.mail_messages (workspace_id, user_id, source_id, folder_id, provider_message_id, internet_message_id, thread_key, subject, snippet, body_text,
         from_email, from_name, to_recipients, cc_recipients, sent_at, received_at, focused)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9, $10, $11, $12::jsonb, '[]'::jsonb, $13, $13, $14) returning id`,
      [
        eclipse.workspaceId,
        eclipse.userId,
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
        values.at ?? minutesAgo(30),
        values.focused ?? null,
      ],
    );
    return { id: result.rows[0].id, key: `${box.sourceId}|${values.thread ?? values.id}` };
  }

  async function classify(fetchImpl: typeof fetch) {
    return classifyCapture(eclipse, { deadline: Date.now() + 60_000, fetchImpl });
  }

  async function capture(actor: UserActor) {
    return listUnknownMail(actor);
  }

  async function shown(actor: UserActor) {
    return (await capture(actor)).emails.map((email) => email.email).sort();
  }

  async function skipped(actor: UserActor) {
    return Object.fromEntries((await capture(actor)).notShown.map((email) => [email.email, email.category]));
  }

  async function threadRow(key: string) {
    const [sourceId, threadKey] = [key.slice(0, key.indexOf("|")), key.slice(key.indexOf("|") + 1)];
    const result = await getAdminPool().query<{ category: string | null; engine: string; workspace_id: string }>(
      "select category, engine, workspace_id from crm.mail_thread_relevance where source_id = $1 and thread_key = $2",
      [sourceId, threadKey],
    );
    return result.rows[0] ?? null;
  }

  before(async () => {
    await resetDatabase();
    const admin = getAdminPool();
    eclipse = await createUser("mark@geteclipse.co", "Mark Ridgeon");
    await admin.query("update crm.workspaces set name = 'Eclipse' where id = $1", [eclipse.workspaceId]);
    eclipse = { ...eclipse, workspaceName: "Eclipse" };
    const created = await createWorkspace(eclipse, { name: "Mark Ridgeon" });
    ridgeon = { ...eclipse, workspaceId: created.id, workspaceName: "Mark Ridgeon", role: "owner", scopes: scopesForRole("owner") };
    await saveBrandProfile(eclipse, { website: "", whatYouSell: "AI visibility software for brands.", whoItsFor: "Marketing leads at consumer brands.", tone: "" }, WEB);
    await saveBrandProfile(ridgeon, { website: "", whatYouSell: "Fractional COO consulting.", whoItsFor: "Founders of scale-ups.", tone: "" }, WEB);
    await saveAboutYou(eclipse, { jobTitle: "Founder", about: "I run Eclipse." });
    await saveAboutYou(ridgeon, { jobTitle: "Consultant", about: "I advise founders on operations." });
    const connection = await admin.query<{ id: string }>(
      `insert into crm.mailbox_connections (workspace_id, user_id, provider, email, status, refresh_token)
       values ($1, $2, 'microsoft', 'mark@geteclipse.co', 'connected', 'cipher') returning id`,
      [eclipse.workspaceId, eclipse.userId],
    );
    connectionId = connection.rows[0].id;
    const account = await admin.query<{ id: string }>(
      `insert into crm.calendar_accounts (workspace_id, user_id, provider, email, status, refresh_token, can_send)
       values ($1, $2, 'microsoft', 'mark@markridgeon.com', 'connected', 'cipher', true) returning id`,
      [eclipse.workspaceId, eclipse.userId],
    );
    primary = await source(eclipse, "connection_id", connectionId, "mark@geteclipse.co");
    extra = await source(eclipse, "account_id", account.rows[0].id, "mark@markridgeon.com");
    await setAddressHome(eclipse, "mark@markridgeon.com", ridgeon.workspaceId);
  });

  afterEach(() => {
    delete process.env.LLM_API_KEY;
    delete process.env.TYPESAFE_API_KEY;
  });

  after(async () => {
    await getPool().end();
    await getAdminPool().end();
  });

  it("knows service, billing, health and collections senders, bulk headers and meeting noise without a model", () => {
    assert.equal(listedCategory("alerts@accounts.google.com"), "service");
    assert.equal(listedCategory("sarah@stripe.com"), "supplier");
    assert.equal(listedCategory("clinic@gp.nhs.uk"), "personal");
    assert.equal(listedCategory("notices@hmrc.gov.uk"), "personal");
    assert.equal(listedCategory("agent@lowell.co.uk"), "collections");
    assert.equal(listedCategory("friend@gmail.com"), null);
    assert.equal(listedCategory("nina@notgoogle.com"), null);
    assert.equal(bulkHeaderCategory([{ name: "Precedence", value: "bulk" }]), "newsletter");
    assert.equal(bulkHeaderCategory([{ name: "List-Id", value: "<news.brand.test>" }]), "newsletter");
    assert.equal(bulkHeaderCategory([{ name: "Auto-Submitted", value: "auto-generated" }]), "service");
    assert.equal(bulkHeaderCategory([{ name: "Auto-Submitted", value: "no" }, { name: "Precedence", value: "first-class" }]), null);
    for (const noise of ["c_123@resource.calendar.google.com", "team-all@googlegroups.com", "invite@calendly.com", "boardroom@acme.com", "noreply@acme.com", "meetingroom.london@acme.com"]) {
      assert.equal(isMeetingNoise(noise), true, noise);
    }
    for (const person of ["jane@acme.com", "cal@acme.com", "pat@gmail.com"]) assert.equal(isMeetingNoise(person), false, person);
  });

  it("drops listed senders and Outlook Other mail before any AI check, unless Mark has written to them", async () => {
    process.env.LLM_API_KEY = "test-key";
    const fake = gateway({ haiku: () => ({ category: "business" }) });
    await addMessage(primary, { id: "stripe", from: "sarah@stripe.com", to: ["mark@geteclipse.co"], subject: "Your receipt" });
    await addMessage(primary, { id: "nhs", from: "clinic@gp.nhs.uk", to: ["mark@geteclipse.co"], subject: "Appointment" });
    await addMessage(primary, { id: "lowell", from: "agent@lowell.co.uk", to: ["mark@geteclipse.co"], subject: "Account" });
    await addMessage(primary, { id: "quiet", from: "otto@quiet.test", to: ["mark@geteclipse.co"], subject: "Hello", focused: false });
    await addMessage(primary, { id: "tom-old", from: "mark@geteclipse.co", to: ["tom@stripe.com"], subject: "Partner programme", sent: true, at: minutesAgo(60 * 24 * 20) });
    await addMessage(primary, { id: "tom", from: "tom@stripe.com", to: ["mark@geteclipse.co"], subject: "Partner programme next steps" });
    await classify(fake.fetchImpl);
    assert.equal(fake.haiku.length, 0);
    assert.deepEqual(await skipped(eclipse), { "agent@lowell.co.uk": "collections", "clinic@gp.nhs.uk": "personal", "sarah@stripe.com": "supplier" });
    assert.deepEqual(await shown(eclipse), ["tom@stripe.com"]);
    assert.equal((await threadRow(`${primary.sourceId}|nhs`))?.category, "personal");
  });

  it("asks Haiku 5.5 with the workspace's brand and person, and shows only business", async () => {
    process.env.LLM_API_KEY = "test-key";
    const fake = gateway({ haiku: bySubject });
    const senders = ["ana@northwind.test", "bills@vendorco.test", "guard@platform.test", "clinic@healthy.test", "recovery@dues.test", "prize@winner.test", "deals@shopper.test"];
    const subjects = Object.keys(BY_SUBJECT);
    for (const [index, sender] of senders.entries()) {
      await addMessage(primary, { id: `cat-${index}`, from: sender, name: `Sender ${index}`, to: ["mark@geteclipse.co"], subject: `${subjects[index]} for you`, body: `Hello Mark\n\nThanks,\nSender ${index}\nHead of Things` });
    }
    await assert.deepEqual((await capture(eclipse)).emails.map((email) => email.email), ["tom@stripe.com"]);
    await classify(fake.fetchImpl);
    assert.equal(fake.haiku.length, 7);
    assert.ok(fake.haiku.every((call) => call.model === "claude-haiku-5-5"));
    const first = fake.haiku.find((call) => call.state.email.fromAddress === "ana@northwind.test")!;
    assert.equal(first.state.business.name, "Eclipse");
    assert.equal(first.state.business.whatItSells, "AI visibility software for brands.");
    assert.equal(first.state.business.idealCustomer, "Marketing leads at consumer brands.");
    assert.deepEqual(first.state.person, { name: "Mark Ridgeon", role: "Founder", aboutYou: "I run Eclipse." });
    assert.match(first.state.email.signature ?? "", /Head of Things/);
    assert.match(first.system, /supplier/);
    assert.deepEqual(await shown(eclipse), ["ana@northwind.test", "tom@stripe.com"]);
    const left = await skipped(eclipse);
    assert.equal(left["bills@vendorco.test"], "supplier");
    assert.equal(left["guard@platform.test"], "service");
    assert.equal(left["clinic@healthy.test"], "personal");
    assert.equal(left["recovery@dues.test"], "collections");
    assert.equal(left["prize@winner.test"], "spam");
    assert.equal(left["deals@shopper.test"], "newsletter");
    assert.equal((await threadRow(`${primary.sourceId}|cat-1`))?.engine, "haiku");
  });

  it("reuses a recent decision for the same sender in the same workspace", async () => {
    process.env.LLM_API_KEY = "test-key";
    const fake = gateway({ haiku: bySubject });
    await addMessage(primary, { id: "deals-2", from: "deals@shopper.test", to: ["mark@geteclipse.co"], subject: "Another offer" });
    assert.equal((await skipped(eclipse))["deals@shopper.test"], "newsletter");
    await classify(fake.fetchImpl);
    assert.equal(fake.haiku.length, 0);
    assert.equal((await threadRow(`${primary.sourceId}|deals-2`))?.engine, "cached");
  });

  it("sorts the pending few inline when Capture opens", async () => {
    process.env.LLM_API_KEY = "test-key";
    const fake = gateway({ haiku: bySubject });
    const realFetch = globalThis.fetch;
    globalThis.fetch = fake.fetchImpl;
    try {
      await addMessage(primary, { id: "inline-1", from: "ivy@inline.test", to: ["mark@geteclipse.co"], subject: "Partnership idea" });
      await addMessage(primary, { id: "inline-2", from: "offers@inline-shop.test", to: ["mark@geteclipse.co"], subject: "Spring sale now" });
      const context = await captureContext(eclipse, Date.now(), { inline: true });
      assert.equal(fake.haiku.length, 2);
      assert.ok(context.unknown.some((email) => email.email === "ivy@inline.test"));
      assert.equal(context.skipped.find((email) => email.email === "offers@inline-shop.test")?.category, "newsletter");
      assert.deepEqual(context.held, []);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("keeps an unsorted email out until it's sorted, and shows it when the AI fails or isn't set up", async () => {
    process.env.LLM_API_KEY = "test-key";
    await addMessage(primary, { id: "fail", from: "una@unsure.test", to: ["mark@geteclipse.co"], subject: "Question" });
    assert.ok(!(await shown(eclipse)).includes("una@unsure.test"));
    const context = await captureContext(eclipse);
    assert.ok(context.held.includes(`${primary.sourceId}|fail`));
    const fake = gateway({ haiku: () => "fail" });
    await classify(fake.fetchImpl);
    assert.ok(fake.haiku.length >= 1);
    assert.ok((await shown(eclipse)).includes("una@unsure.test"));
    assert.deepEqual(await threadRow(`${primary.sourceId}|fail`), { category: null, engine: "failed", workspace_id: eclipse.workspaceId });

    delete process.env.LLM_API_KEY;
    await addMessage(primary, { id: "nokey", from: "noel@nokey.test", to: ["mark@geteclipse.co"], subject: "Hello" });
    const quiet = gateway({ haiku: () => ({ category: "spam" }) });
    await classify(quiet.fetchImpl);
    assert.equal(quiet.haiku.length, 0);
    assert.ok((await shown(eclipse)).includes("noel@nokey.test"));
  });

  it("uses Jev first with one choice question, and Haiku when Jev fails", async () => {
    process.env.LLM_API_KEY = "test-key";
    process.env.TYPESAFE_API_KEY = "ts-test";
    const fake = gateway({
      jev: (body) => (body.state.email.fromAddress === "jill@jevnews.test" ? { category: { type: "choice", choice: "newsletter" }, could_do_business: { type: "noul", noul: 0.1 } } : "fail"),
      haiku: () => ({ category: "business" }),
    });
    await addMessage(primary, { id: "jev-1", from: "jill@jevnews.test", to: ["mark@geteclipse.co"], subject: "Weekly roundup" });
    await addMessage(primary, { id: "jev-2", from: "jack@jevdown.test", to: ["mark@geteclipse.co"], subject: "Intro" });
    await classify(fake.fetchImpl);
    const asked = fake.jev.find((call) => call.state.email.fromAddress === "jill@jevnews.test")!;
    assert.equal(asked.questions.category.type, "choice");
    assert.deepEqual(Object.keys(asked.questions.category.criteria as object).sort(), ["business", "collections", "newsletter", "personal", "service", "spam", "supplier"]);
    assert.equal(asked.questions.could_do_business.type, "noul");
    assert.equal(asked.state.business.name, "Eclipse");
    assert.equal((await threadRow(`${primary.sourceId}|jev-1`))?.engine, "jev");
    assert.equal((await skipped(eclipse))["jill@jevnews.test"], "newsletter");
    assert.equal((await threadRow(`${primary.sourceId}|jev-2`))?.engine, "haiku");
    assert.ok((await shown(eclipse)).includes("jack@jevdown.test"));
  });

  it("judges the same sender with each workspace's own brand and person, and caches per workspace", async () => {
    process.env.LLM_API_KEY = "test-key";
    const fake = gateway({ haiku: (state) => ({ category: state.business.name === "Mark Ridgeon" ? "business" : "newsletter" }) });
    await addMessage(primary, { id: "lena-e", from: "lena@brightpath.test", to: ["mark@geteclipse.co"], subject: "Ops help" });
    await addMessage(extra, { id: "lena-r", from: "lena@brightpath.test", to: ["mark@markridgeon.com"], subject: "Ops help" });
    await classify(fake.fetchImpl);
    const calls = fake.haiku.filter((call) => call.state.email.fromAddress === "lena@brightpath.test");
    assert.equal(calls.length, 2);
    const forEclipse = calls.find((call) => call.state.business.name === "Eclipse")!;
    const forRidgeon = calls.find((call) => call.state.business.name === "Mark Ridgeon")!;
    assert.equal(forEclipse.state.email.receivedBy, "mark@geteclipse.co");
    assert.equal(forRidgeon.state.email.receivedBy, "mark@markridgeon.com");
    assert.equal(forRidgeon.state.business.whatItSells, "Fractional COO consulting.");
    assert.deepEqual(forRidgeon.state.person, { name: "Mark Ridgeon", role: "Consultant", aboutYou: "I advise founders on operations." });
    assert.doesNotMatch(JSON.stringify(forRidgeon.state), /Eclipse|AI visibility/);
    assert.doesNotMatch(JSON.stringify(forEclipse.state), /Fractional|advise founders/);
    assert.ok((await shown(ridgeon)).includes("lena@brightpath.test"));
    assert.equal((await skipped(eclipse))["lena@brightpath.test"], "newsletter");
    const cached = await getAdminPool().query<{ workspace_id: string; category: string }>(
      "select workspace_id, category from crm.mail_sender_relevance where sender = 'lena@brightpath.test' order by category",
    );
    assert.deepEqual(cached.rows, [
      { workspace_id: ridgeon.workspaceId, category: "business" },
      { workspace_id: eclipse.workspaceId, category: "newsletter" },
    ]);
  });

  it("passes past correspondence as counts and leans to business, and never hides someone Mark wrote to", async () => {
    process.env.LLM_API_KEY = "test-key";
    const fake = gateway({ haiku: (state) => ({ category: state.history.userHasWrittenToDomain ? "business" : "newsletter" }) });
    await addMessage(primary, { id: "harbour-old", from: "mark@geteclipse.co", to: ["ops@harbourline.test"], subject: "Proposal", sent: true, at: minutesAgo(60 * 24 * 40) });
    await addMessage(primary, { id: "harbour-reply", from: "ops@harbourline.test", to: ["mark@geteclipse.co"], subject: "Re: Proposal", at: minutesAgo(60 * 24 * 39) });
    await addMessage(primary, { id: "kim", from: "kim@harbourline.test", to: ["mark@geteclipse.co"], subject: "Following up" });
    await addMessage(primary, { id: "joe-old", from: "mark@geteclipse.co", to: ["joe@gmail.com"], subject: "Lunch", sent: true, at: minutesAgo(60 * 24 * 10) });
    await addMessage(primary, { id: "joe", from: "joe@gmail.com", to: ["mark@geteclipse.co"], subject: "Spring sale for you" });
    await classify(fake.fetchImpl);
    const kim = fake.haiku.find((call) => call.state.email.fromAddress === "kim@harbourline.test")!;
    assert.equal(kim.state.history.userHasWrittenToDomain, true);
    assert.equal(kim.state.history.userHasWrittenToSender, false);
    assert.match(kim.state.history.mailWithDomain, /^2 from the domain, 1 from the user to it, first \d{4}-\d{2}-\d{2}/);
    assert.doesNotMatch(JSON.stringify(kim.state), /Proposal/);
    assert.ok((await shown(eclipse)).includes("kim@harbourline.test"));
    assert.equal(fake.haiku.some((call) => call.state.email.fromAddress === "joe@gmail.com"), false);
    assert.equal((await threadRow(`${primary.sourceId}|joe`))?.engine, "history");
    assert.ok((await shown(eclipse)).includes("joe@gmail.com"));
  });

  it("lets Never ask and Show in Capture beat the AI", async () => {
    process.env.LLM_API_KEY = "test-key";
    const fake = gateway({ haiku: (state) => ({ category: state.email.fromAddress.endsWith("@vendorly.test") ? "business" : "newsletter" }) });
    const first = await addMessage(primary, { id: "vend-1", from: "rep@vendorly.test", to: ["mark@geteclipse.co"], subject: "Quick chat" });
    const promo = await addMessage(primary, { id: "promo-1", from: "maria@promo.test", to: ["mark@geteclipse.co"], subject: "Catch up" });
    await classify(fake.fetchImpl);
    assert.ok((await shown(eclipse)).includes("rep@vendorly.test"));
    assert.equal((await skipped(eclipse))["maria@promo.test"], "newsletter");

    assert.equal(readCaptureAction({ kind: "email-never", key: first.key }).kind, "email-never");
    await runCaptureAction(eclipse, readCaptureAction({ kind: "email-never", key: first.key }));
    await addMessage(primary, { id: "vend-2", from: "boss@vendorly.test", to: ["mark@geteclipse.co"], subject: "Following up" });
    const before = fake.haiku.length;
    await classify(fake.fetchImpl);
    assert.equal(fake.haiku.length, before);
    const list = await capture(eclipse);
    assert.ok(!list.emails.some((email) => email.email.endsWith("@vendorly.test")));
    assert.equal(list.notShown.find((email) => email.email === "boss@vendorly.test")?.category, "muted");
    assert.ok(!list.notShown.some((email) => email.key === first.key));

    await runCaptureAction(eclipse, readCaptureAction({ kind: "email-show", key: promo.key }));
    assert.ok((await shown(eclipse)).includes("maria@promo.test"));
    await addMessage(primary, { id: "promo-2", from: "maria@promo.test", to: ["mark@geteclipse.co"], subject: "Spring sale" });
    await classify(fake.fetchImpl);
    assert.deepEqual(
      (await capture(eclipse)).emails.filter((email) => email.email === "maria@promo.test").map((email) => email.key).sort(),
      [promo.key, `${primary.sourceId}|promo-2`].sort(),
    );
  });

  it("records a filed sender as business for them and their domain", async () => {
    const filed = await addMessage(primary, { id: "file-me", from: "rosa@fileco.test", to: ["mark@geteclipse.co"], subject: "Hello" });
    await createAndFileUnknown(eclipse, filed.key);
    const rows = await getAdminPool().query<{ sender: string; category: string; engine: string; rule: boolean }>(
      "select sender, category, engine, rule from crm.mail_sender_relevance where workspace_id = $1 and sender in ('rosa@fileco.test', '@fileco.test') order by sender",
      [eclipse.workspaceId],
    );
    assert.deepEqual(rows.rows, [
      { sender: "@fileco.test", category: "business", engine: "filed", rule: true },
      { sender: "rosa@fileco.test", category: "business", engine: "filed", rule: true },
    ]);
  });

  it("tells the assistant how many were filtered without Personal subjects", async () => {
    const result = (await runTool(eclipse, "get_capture", {})) as { toFile: { notShown: { count: number; emails: { from: string; subject?: string; category: string }[] } } };
    assert.ok(result.toFile.notShown.count >= 6);
    const clinic = result.toFile.notShown.emails.find((email) => email.from === "clinic@gp.nhs.uk")!;
    assert.equal(clinic.category, "Personal");
    assert.equal(clinic.subject, undefined);
    assert.equal(result.toFile.notShown.emails.find((email) => email.from.includes("bills@vendorco.test"))?.subject, "Invoice for you");
  });

  it("keeps Personal and Collections mail out of nightly learning", async () => {
    process.env.LLM_API_KEY = "test-key";
    const admin = getAdminPool();
    const prepare = async (id: string, from: string, body: string) => {
      const message = await addMessage(primary, { id, from, to: ["mark@geteclipse.co"], subject: `${id} subject`, at: minutesAgo(60 * 24 * 3) });
      await admin.query(
        `insert into crm.mail_prepared (workspace_id, user_id, source_id, thread_key, message_id, kind, state, body, sent_body)
         values ($1, $2, $3, $4, $5, 'reply', 'sent', $6, $7)`,
        [eclipse.workspaceId, eclipse.userId, primary.sourceId, id, message.id, `${body} draft`, `${body} as sent`],
      );
    };
    await prepare("learn-business", "dana@clientco.test", "BUSINESS-REPLY");
    await prepare("learn-health", "clinic@healthy.test", "HEALTH-REPLY");
    await prepare("learn-bank", "advisor@barclays.co.uk", "BANK-REPLY");
    await admin.query(
      `insert into crm.mail_thread_relevance (workspace_id, user_id, source_id, thread_key, sender, category, engine)
       values ($1, $2, $3, 'learn-health', 'clinic@healthy.test', 'personal', 'haiku')`,
      [eclipse.workspaceId, eclipse.userId, primary.sourceId],
    );
    const fake = gateway({});
    await learnNow(eclipse, { deadline: Date.now() + 60_000, fetchImpl: fake.fetchImpl, kinds: ["personal"] });
    assert.equal(fake.learning.length, 1);
    assert.match(fake.learning[0], /BUSINESS-REPLY/);
    assert.doesNotMatch(fake.learning[0], /HEALTH-REPLY|BANK-REPLY/);
  });

  it("leaves rooms, groups, booking tools and no-reply addresses out of People you've met", async () => {
    const admin = getAdminPool();
    const calendar = await admin.query<{ id: string }>(
      `insert into crm.calendars (workspace_id, user_id, connection_id, provider_calendar_id, name, color, use_for_crm)
       values ($1, $2, $3, 'cal-1', 'Calendar', '#000000', true) returning id`,
      [eclipse.workspaceId, eclipse.userId, connectionId],
    );
    const people = [
      { name: "Jane", email: "jane@meetco.test" },
      { name: "Room", email: "boardroom@meetco.test" },
      { name: "Google room", email: "c_188@resource.calendar.google.com" },
      { name: "Group", email: "founders@googlegroups.com" },
      { name: "Calendly", email: "notifications@calendly.com" },
      { name: "Bot", email: "noreply@meetco.test" },
    ];
    await admin.query(
      `insert into crm.calendar_events (workspace_id, calendar_id, connection_id, user_id, provider_event_id, subject, starts_at, ends_at, attendees)
       values ($1, $2, $3, $4, 'met-1', 'Intro', now() - interval '2 days', now() - interval '2 days' + interval '30 minutes', $5::jsonb)`,
      [eclipse.workspaceId, calendar.rows[0].id, connectionId, eclipse.userId, JSON.stringify(people)],
    );
    const met = await listPeopleMet(eclipse);
    assert.deepEqual(met.map((person) => person.email), ["jane@meetco.test"]);
    const context = await captureContext(eclipse);
    const status = await captureStatus(eclipse, Date.now(), context);
    const unfiled = await listUnknownMail(eclipse);
    assert.equal(status.sections.toFile, unfiled.total + 1);
  });

  it("keeps sender and thread decisions private to their owner", async () => {
    const other = await createUser("sam@elsewhere.test", "Sam Other");
    const theirs = await queryAsUser<{ total: number }>(other.userId, "select count(*)::int as total from crm.mail_sender_relevance");
    assert.equal(theirs[0].total, 0);
    const threads = await queryAsUser<{ total: number }>(other.userId, "select count(*)::int as total from crm.mail_thread_relevance");
    assert.equal(threads[0].total, 0);
    const mine = await queryAsUser<{ total: number }>(eclipse.userId, "select count(*)::int as total from crm.mail_sender_relevance");
    assert.ok(mine[0].total > 0);
    await assert.rejects(
      queryAsUser(other.userId, "insert into crm.mail_sender_relevance (workspace_id, user_id, sender, category, engine) values ($1, $2, 'x@y.test', 'business', 'rule')", [
        eclipse.workspaceId,
        eclipse.userId,
      ]),
      /row-level security/,
    );
    await assert.rejects(
      queryAsUser(other.userId, "insert into crm.mail_sender_relevance (workspace_id, user_id, sender, category, engine) values ($1, $2, 'x@y.test', 'business', 'rule')", [
        eclipse.workspaceId,
        other.userId,
      ]),
      /row-level security/,
    );
    const updated = await queryAsUser<{ id: string }>(other.userId, "update crm.mail_thread_relevance set category = 'business' returning id");
    assert.equal(updated.length, 0);
  });
});
