import assert from "node:assert/strict";
import { after, afterEach, before, describe, it } from "node:test";
import { runTool } from "@/lib/assistant/tools";
import { saveBrandProfile } from "@/lib/crm/brand";
import { listPeopleMet } from "@/lib/crm/calendar";
import { captureContext, captureStatus } from "@/lib/crm/capture";
import { withActor } from "@/lib/crm/context";
import { readCaptureAction, runCaptureAction } from "@/lib/crm/capture-actions";
import { saveAboutYou } from "@/lib/crm/personal-context";
import { scopesForRole } from "@/lib/crm/scopes";
import type { UserActor } from "@/lib/crm/types";
import { createWorkspace } from "@/lib/crm/workspaces";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { askJev } from "@/lib/jev";
import { learnNow } from "@/lib/learning/nightly";
import { completeJson } from "@/lib/llm";
import { classifyCapture, listSenderRules, listUnknownMail } from "@/lib/mail/capture-filter";
import { createAndFileUnknown } from "@/lib/mail/filing";
import { recordFiledInDb, verdictFor } from "@/lib/mail/relevance";
import { setAddressHome } from "@/lib/mail/routing";
import { bulkHeaderCategory, isMeetingNoise, listedSender } from "@/lib/mail/senders";
import { z } from "zod";
import { createUser, queryAsUser, resetDatabase } from "./helpers";

delete process.env.TYPESAFE_API_KEY;
delete process.env.LLM_API_KEY;

type Box = { sourceId: string; inbox: string; sent: string };
type State = {
  business: { name: string; whatItSells: string; idealCustomer: string; formerNames?: string[] };
  person: { name: string; role: string; aboutYou?: string };
  history: { mailWithSender: string; mailWithDomain: string; userHasWrittenToSender: boolean; userHasWrittenToDomain: boolean; meetings: number };
  email: { fromName: string | null; fromAddress: string; receivedBy: string; subject: string | null; snippet: string | null; signature?: string; senderDomainIs?: string };
};
type Answer = { category: string; confidence?: number | null; reason?: string } | "fail" | "garbage";
type JevBody = { state: State; questions: Record<string, { type: string; criteria: unknown }> };

const WEB = { operation: "capture_relevance_test", source: "web" };

function minutesAgo(minutes: number) {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

function gateway(options: { haiku?: (state: State) => Answer; jev?: (body: JevBody) => unknown; jevWaits?: boolean }) {
  const haiku: { model: string; system: string; state: State }[] = [];
  const jev: JevBody[] = [];
  const learning: string[] = [];
  const business: string[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.startsWith("https://api.typesafe.ai/")) {
      const body = JSON.parse(String(init?.body));
      jev.push(body);
      if (options.jevWaits) {
        await new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("timed out", "TimeoutError"))));
      }
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
      if (system.includes("shared business memory")) {
        business.push(user);
        return Response.json({ model: "test", choices: [{ message: { content: JSON.stringify({ add: [], update: [], archive: [] }) }, finish_reason: "stop" }] });
      }
      const state = JSON.parse(user) as State;
      haiku.push({ model: body.model, system, state });
      const answer = options.haiku?.(state) ?? "fail";
      if (answer === "fail") return new Response("broken", { status: 400 });
      if (answer === "garbage") return Response.json({ model: body.model, choices: [{ message: { content: "not json at all" }, finish_reason: "stop" }] });
      return Response.json({
        model: body.model,
        choices: [{ message: { content: JSON.stringify({ confidence: 0.9, reason: "Test reason.", ...answer }) }, finish_reason: "stop" }],
      });
    }
    return new Response("not here", { status: 404 });
  };
  return { fetchImpl, haiku, jev, learning, business };
}

const BY_SUBJECT: Record<string, string> = {
  Partnership: "business",
  Invoice: "supplier",
  "Security alert": "service",
  "Test results": "personal",
  "Final demand": "collections",
  "You won": "spam",
  "Spring sale": "newsletter",
  Appointment: "personal",
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
    owner: UserActor = eclipse,
  ) {
    const result = await getAdminPool().query<{ id: string }>(
      `insert into crm.mail_messages (workspace_id, user_id, source_id, folder_id, provider_message_id, internet_message_id, thread_key, subject, snippet, body_text,
         from_email, from_name, to_recipients, cc_recipients, sent_at, received_at, focused)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9, $10, $11, $12::jsonb, '[]'::jsonb, $13, $13, $14) returning id`,
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
        values.at ?? minutesAgo(2),
        values.focused ?? null,
      ],
    );
    return { id: result.rows[0].id, key: `${box.sourceId}|${values.thread ?? values.id}` };
  }

  async function classify(fetchImpl: typeof fetch, extraOptions: Partial<Parameters<typeof classifyCapture>[1]> = {}) {
    return classifyCapture(eclipse, { deadline: Date.now() + 60_000, fetchImpl, readHeaders: async () => [], ...extraOptions });
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

  async function settleAll() {
    process.env.LLM_API_KEY = "test-key";
    const fake = gateway({ haiku: () => ({ category: "business" }) });
    for (let round = 0; round < 6; round += 1) {
      const result = await classify(fake.fetchImpl, { limit: 100 });
      if (result.decided === 0) break;
    }
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

  it("hides only automated addresses and sending subdomains at listed domains, the whole collections list, and nothing that looks alike", () => {
    assert.deepEqual(listedSender("alerts@accounts.google.com"), { category: "service", hide: true });
    assert.deepEqual(listedSender("partners@google.com"), { category: "service", hide: false });
    assert.deepEqual(listedSender("priya.shah@google.com"), { category: "service", hide: false });
    assert.deepEqual(listedSender("accounts@stripe.com"), { category: "supplier", hide: false });
    assert.deepEqual(listedSender("statements@stripe.com"), { category: "supplier", hide: true });
    assert.deepEqual(listedSender("sarah@stripe.com"), { category: "supplier", hide: false });
    assert.deepEqual(listedSender("notices@hmrc.gov.uk"), { category: "personal", hide: false });
    assert.deepEqual(listedSender("no-reply+tax@hmrc.gov.uk"), { category: "personal", hide: true });
    assert.deepEqual(listedSender("noreply@nhs.net"), { category: "personal", hide: true });
    for (const reachable of ["accounts.payable@trust.nhs.uk", "enquiries@council.gov.uk", "support.partnerships@barclays.com", "mail.smith@nhs.net", "jane@secure.nhs.net", "info@trust.nhs.uk", "notifications.team@gov.uk"]) {
      assert.deepEqual(listedSender(reachable)?.hide, false, reachable);
    }
    assert.deepEqual(listedSender("jane.doe@hmrc.gov.uk"), { category: "personal", hide: false });
    assert.deepEqual(listedSender("clinic@gp.nhs.uk"), { category: "personal", hide: false });
    assert.deepEqual(listedSender("statements@email.barclays.co.uk"), { category: "personal", hide: true });
    assert.deepEqual(listedSender("tom.reed@barclays.co.uk"), { category: "personal", hide: false });
    assert.deepEqual(listedSender("agent@lowell.co.uk"), { category: "collections", hide: true });
    assert.deepEqual(listedSender("kate@recoveries.lowell.co.uk"), { category: "collections", hide: true });
    assert.deepEqual(listedSender("anything@facebookmail.com"), { category: "service", hide: true });
    assert.equal(listedSender("x@google.com.evil.test"), null);
    assert.equal(listedSender("nina@notgoogle.com"), null);
    assert.equal(listedSender("friend@gmail.com"), null);
    assert.equal(listedSender("me@btinternet.com"), null);
    assert.equal(bulkHeaderCategory([{ name: "Precedence", value: "bulk" }]), "newsletter");
    assert.equal(bulkHeaderCategory([{ name: "List-Id", value: "<news.brand.test>" }]), "newsletter");
    assert.equal(bulkHeaderCategory([{ name: "Auto-Submitted", value: "auto-generated" }]), "service");
    assert.equal(bulkHeaderCategory([{ name: "Auto-Submitted", value: "no" }, { name: "Precedence", value: "first-class" }]), null);
    for (const noise of ["c_123@resource.calendar.google.com", "team-all@googlegroups.com", "invite@calendly.com", "boardroom@acme.com", "noreply@acme.com", "meetingroom.london@acme.com"]) {
      assert.equal(isMeetingNoise(noise), true, noise);
    }
    for (const person of ["jane@acme.com", "cal@acme.com", "pat@gmail.com"]) assert.equal(isMeetingNoise(person), false, person);
  });

  it("shows only confident decisions: 0.8 and over hides, below or none shows", () => {
    assert.equal(verdictFor({ category: "newsletter", confidence: 0.79, reason: null }, "haiku").state, "shown");
    assert.equal(verdictFor({ category: "newsletter", confidence: 0.8, reason: null }, "haiku").state, "skipped");
    assert.equal(verdictFor({ category: "newsletter", confidence: null, reason: null }, "jev").state, "shown");
    assert.equal(verdictFor({ category: "newsletter", confidence: null, reason: null }, "cached").state, "shown");
    assert.equal(verdictFor({ category: "newsletter", confidence: null, reason: null }, "headers").state, "skipped");
    assert.equal(verdictFor({ category: "muted", confidence: null, reason: null }, "rule").state, "skipped");
  });

  it("refuses real AI calls under the test runner", async () => {
    process.env.LLM_API_KEY = "test-key";
    process.env.TYPESAFE_API_KEY = "ts-test";
    await assert.rejects(askJev({}, {}, { timeoutMs: 1_000 }), /isn't called for real in tests/);
    await assert.rejects(completeJson({ system: "x", user: "y", schema: z.object({}) }), /isn't called for real in tests/);
  });

  it("hides automated addresses at listed domains without the AI, asks about role mailboxes and people there with a hint, and skips the list for domains Mark knows", async () => {
    process.env.LLM_API_KEY = "test-key";
    const fake = gateway({ haiku: bySubject });
    await addMessage(primary, { id: "paypal", from: "statements@paypal.com", to: ["mark@geteclipse.co"], subject: "Your statement" });
    await addMessage(primary, { id: "paypal-accounts", from: "accounts@paypal.com", to: ["mark@geteclipse.co"], subject: "Invoice question" });
    await addMessage(primary, { id: "trust", from: "accounts.payable@trust.nhs.uk", to: ["mark@geteclipse.co"], subject: "Partnership on patient visibility" });
    await addMessage(primary, { id: "nhs", from: "clinic@gp.nhs.uk", to: ["mark@geteclipse.co"], subject: "Appointment reminder" });
    await addMessage(primary, { id: "lowell", from: "agent@lowell.co.uk", to: ["mark@geteclipse.co"], subject: "Account" });
    await addMessage(primary, { id: "quiet", from: "otto@quiet.test", to: ["mark@geteclipse.co"], subject: "Hello", focused: false });
    await addMessage(primary, { id: "google", from: "priya.shah@google.com", to: ["mark@geteclipse.co"], subject: "Partnership on Gemini visibility" });
    await addMessage(primary, { id: "arrow-old", from: "mark@geteclipse.co", to: ["ops@arrowglobal.net"], subject: "Data partnership", sent: true, at: minutesAgo(60 * 24 * 20) });
    await addMessage(primary, { id: "arrow", from: "kate@arrowglobal.net", to: ["mark@geteclipse.co"], subject: "Partnership follow up" });
    await addMessage(primary, { id: "tom-old", from: "mark@geteclipse.co", to: ["tom@ebay-partners.test"], subject: "Partner programme", sent: true, at: minutesAgo(60 * 24 * 20) });
    await addMessage(primary, { id: "tom", from: "tom@ebay-partners.test", to: ["mark@geteclipse.co"], subject: "Spring sale for partners" });
    await classify(fake.fetchImpl);
    const asked = fake.haiku.map((call) => call.state.email.fromAddress).sort();
    assert.deepEqual(asked, ["accounts.payable@trust.nhs.uk", "accounts@paypal.com", "clinic@gp.nhs.uk", "kate@arrowglobal.net", "priya.shah@google.com"]);
    assert.match(fake.haiku.find((call) => call.state.email.fromAddress === "accounts.payable@trust.nhs.uk")!.state.email.senderDomainIs ?? "", /public sector/);
    assert.match(fake.haiku.find((call) => call.state.email.fromAddress === "clinic@gp.nhs.uk")!.state.email.senderDomainIs ?? "", /public sector/);
    assert.match(fake.haiku.find((call) => call.state.email.fromAddress === "priya.shah@google.com")!.state.email.senderDomainIs ?? "", /platform/);
    assert.equal(fake.haiku.find((call) => call.state.email.fromAddress === "kate@arrowglobal.net")!.state.email.senderDomainIs, undefined);
    const left = await skipped(eclipse);
    assert.deepEqual(left, { "statements@paypal.com": "supplier", "accounts@paypal.com": "supplier", "agent@lowell.co.uk": "collections", "clinic@gp.nhs.uk": "personal" });
    assert.deepEqual(await shown(eclipse), ["accounts.payable@trust.nhs.uk", "kate@arrowglobal.net", "priya.shah@google.com", "tom@ebay-partners.test"]);
    assert.equal((await threadRow(`${primary.sourceId}|paypal`))?.engine, "listed");
    assert.equal((await threadRow(`${primary.sourceId}|nhs`))?.engine, "haiku");
    assert.equal((await threadRow(`${primary.sourceId}|tom`))?.engine, "history");
  });

  it("asks Haiku 5.5 with the workspace's brand and person, and shows only business", async () => {
    process.env.LLM_API_KEY = "test-key";
    const fake = gateway({ haiku: bySubject });
    const senders = ["ana@northwind.test", "bills@vendorco.test", "guard@platform.test", "clinic@healthy.test", "recovery@dues.test", "prize@winner.test", "deals@shopper.test"];
    const subjects = ["Partnership", "Invoice", "Security alert", "Test results", "Final demand", "You won", "Spring sale"];
    for (const [index, sender] of senders.entries()) {
      await addMessage(primary, {
        id: `cat-${index}`,
        from: sender,
        name: `Sender ${index}`,
        to: ["mark@geteclipse.co"],
        subject: `${subjects[index]} for you`,
        body: `Hello Mark\n\nThanks,\nSender ${index}\nHead of Things\n\nOn Monday Someone wrote:\n> Quoted Signature Line`,
      });
    }
    const before = await capture(eclipse);
    assert.ok(senders.every((sender) => !before.emails.some((email) => email.email === sender)));
    assert.equal(before.sorting, 7);
    await classify(fake.fetchImpl);
    assert.equal(fake.haiku.length, 7);
    assert.ok(fake.haiku.every((call) => call.model === "claude-haiku-5-5"));
    const first = fake.haiku.find((call) => call.state.email.fromAddress === "ana@northwind.test")!;
    assert.equal(first.state.business.name, "Eclipse");
    assert.equal(first.state.business.whatItSells, "AI visibility software for brands.");
    assert.equal(first.state.business.idealCustomer, "Marketing leads at consumer brands.");
    assert.deepEqual(first.state.person, { name: "Mark Ridgeon", role: "Founder", aboutYou: "I run Eclipse." });
    assert.match(first.system, /supplier/);
    assert.match(first.state.email.signature ?? "", /Head of Things/);
    assert.doesNotMatch(first.state.email.signature ?? "", /Quoted Signature Line/);
    assert.deepEqual((await shown(eclipse)).filter((email) => senders.includes(email)), ["ana@northwind.test"]);
    const left = await skipped(eclipse);
    assert.equal(left["bills@vendorco.test"], "supplier");
    assert.equal(left["guard@platform.test"], "service");
    assert.equal(left["clinic@healthy.test"], "personal");
    assert.equal(left["recovery@dues.test"], "collections");
    assert.equal(left["prize@winner.test"], "spam");
    assert.equal(left["deals@shopper.test"], "newsletter");
    assert.equal((await capture(eclipse)).sorting, 0);
  });

  it("shares and caches only a show decision for a sender, and judges each other email on its own", async () => {
    process.env.LLM_API_KEY = "test-key";
    const fake = gateway({ haiku: (state) => ({ category: state.email.subject?.startsWith("Spring sale") ? "newsletter" : "business" }) });
    for (const index of [1, 2, 3]) await addMessage(primary, { id: `burst-${index}`, from: "anya@burst.test", to: ["mark@geteclipse.co"], subject: `Proposal ${index}` });
    await classify(fake.fetchImpl);
    assert.equal(fake.haiku.filter((call) => call.state.email.fromAddress === "anya@burst.test").length, 1);
    await addMessage(primary, { id: "burst-4", from: "anya@burst.test", to: ["mark@geteclipse.co"], subject: "Proposal 4" });
    await classify(fake.fetchImpl);
    assert.equal(fake.haiku.length, 1);
    assert.equal((await threadRow(`${primary.sourceId}|burst-4`))?.engine, "cached");
    await getAdminPool().query("update crm.mail_sender_relevance set decided_at = now() - interval '61 days' where sender = 'anya@burst.test'");
    await addMessage(primary, { id: "burst-5", from: "anya@burst.test", to: ["mark@geteclipse.co"], subject: "Proposal 5" });
    await classify(fake.fetchImpl);
    assert.equal(fake.haiku.length, 2);

    await addMessage(primary, { id: "mixed-1", from: "pat@mixed.test", to: ["mark@geteclipse.co"], subject: "Spring sale today", at: minutesAgo(1) });
    await addMessage(primary, { id: "mixed-2", from: "pat@mixed.test", to: ["mark@geteclipse.co"], subject: "Partnership proposal", at: minutesAgo(2) });
    await classify(fake.fetchImpl);
    assert.equal(fake.haiku.filter((call) => call.state.email.fromAddress === "pat@mixed.test").length, 2);
    assert.equal((await threadRow(`${primary.sourceId}|mixed-1`))?.category, "newsletter");
    assert.equal((await threadRow(`${primary.sourceId}|mixed-2`))?.category, "business");
    assert.ok((await capture(eclipse)).emails.some((email) => email.key === `${primary.sourceId}|mixed-2`));
    const cached = await getAdminPool().query("select 1 from crm.mail_sender_relevance where sender = 'pat@mixed.test' and category <> 'business'");
    assert.equal(cached.rowCount, 0);
    await addMessage(primary, { id: "news-1", from: "nell@newsonly.test", to: ["mark@geteclipse.co"], subject: "Spring sale" });
    await classify(fake.fetchImpl);
    await addMessage(primary, { id: "news-2", from: "nell@newsonly.test", to: ["mark@geteclipse.co"], subject: "Spring sale again" });
    await classify(fake.fetchImpl);
    assert.equal(fake.haiku.filter((call) => call.state.email.fromAddress === "nell@newsonly.test").length, 2, "a hide is never reused for the next email");
  });

  it("sorts at most six inline and leaves the rest for the background", async () => {
    process.env.LLM_API_KEY = "test-key";
    const fake = gateway({ haiku: () => ({ category: "business" }) });
    const realFetch = globalThis.fetch;
    globalThis.fetch = fake.fetchImpl;
    try {
      for (let index = 0; index < 8; index += 1) await addMessage(primary, { id: `six-${index}`, from: `six${index}@sixco${index}.test`, to: ["mark@geteclipse.co"], subject: "Hello" });
      const context = await captureContext(eclipse, Date.now(), { inline: true });
      assert.equal(fake.haiku.length, 6);
      assert.equal(context.held.length, 2);
    } finally {
      globalThis.fetch = realFetch;
    }
    await classify(fake.fetchImpl);
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

  it("holds a new email briefly while it's sorted, shows it after five minutes, and shows it when sorting fails or isn't set up", async () => {
    process.env.LLM_API_KEY = "test-key";
    await addMessage(primary, { id: "fresh", from: "una@unsure.test", to: ["mark@geteclipse.co"], subject: "Question" });
    await addMessage(primary, { id: "stale", from: "old@unsorted.test", to: ["mark@geteclipse.co"], subject: "Question", at: minutesAgo(6) });
    const list = await capture(eclipse);
    assert.ok(!list.emails.some((email) => email.email === "una@unsure.test"));
    assert.ok(list.emails.some((email) => email.email === "old@unsorted.test"));
    assert.equal(list.sorting, 1);
    const context = await captureContext(eclipse);
    assert.ok(context.held.some((item) => item.key === `${primary.sourceId}|fresh`));

    const fake = gateway({ haiku: () => "fail" });
    await classify(fake.fetchImpl);
    assert.ok((await shown(eclipse)).includes("una@unsure.test"));
    assert.deepEqual(await threadRow(`${primary.sourceId}|fresh`), { category: null, engine: "failed", workspace_id: eclipse.workspaceId });

    await addMessage(primary, { id: "garbled", from: "gus@garbled.test", to: ["mark@geteclipse.co"], subject: "Hello" });
    await classify(gateway({ haiku: () => "garbage" }).fetchImpl);
    assert.equal((await threadRow(`${primary.sourceId}|garbled`))?.engine, "failed");
    assert.ok((await shown(eclipse)).includes("gus@garbled.test"));

    delete process.env.LLM_API_KEY;
    await addMessage(primary, { id: "nokey", from: "noel@nokey.test", to: ["mark@geteclipse.co"], subject: "Hello" });
    const quiet = gateway({ haiku: () => ({ category: "spam" }) });
    await classify(quiet.fetchImpl);
    assert.equal(quiet.haiku.length, 0);
    assert.ok((await shown(eclipse)).includes("noel@nokey.test"));
  });

  it("uses Jev first with one choice question, Haiku when Jev fails or times out, and shows the email when both fail", async () => {
    process.env.LLM_API_KEY = "test-key";
    process.env.TYPESAFE_API_KEY = "ts-test";
    const fake = gateway({
      jev: (body) =>
        body.state.email.fromAddress === "jill@jevnews.test"
          ? { category: { type: "choice", choice: "newsletter" }, could_do_business: { type: "noul", noul: 0.1 } }
          : body.state.email.fromAddress === "nora@jevnull.test"
            ? { category: { type: "choice", choice: "newsletter" } }
            : "fail",
      haiku: (state) => (state.email.fromAddress === "both@fail.test" ? "fail" : { category: "business" }),
    });
    await addMessage(primary, { id: "jev-1", from: "jill@jevnews.test", to: ["mark@geteclipse.co"], subject: "Weekly roundup" });
    await addMessage(primary, { id: "jev-2", from: "jack@jevdown.test", to: ["mark@geteclipse.co"], subject: "Intro" });
    await addMessage(primary, { id: "jev-3", from: "nora@jevnull.test", to: ["mark@geteclipse.co"], subject: "Hi" });
    await addMessage(primary, { id: "jev-4", from: "both@fail.test", to: ["mark@geteclipse.co"], subject: "Hi" });
    await classify(fake.fetchImpl);
    const asked = fake.jev.find((call) => call.state.email.fromAddress === "jill@jevnews.test")!;
    assert.equal(asked.questions.category.type, "choice");
    assert.deepEqual(Object.keys(asked.questions.category.criteria as object).sort(), ["business", "collections", "newsletter", "personal", "service", "spam", "supplier"]);
    assert.equal(asked.questions.could_do_business.type, "noul");
    assert.equal(asked.state.business.name, "Eclipse");
    assert.equal((await threadRow(`${primary.sourceId}|jev-1`))?.engine, "jev");
    assert.equal((await skipped(eclipse))["jill@jevnews.test"], "newsletter");
    assert.equal((await threadRow(`${primary.sourceId}|jev-2`))?.engine, "haiku");
    assert.equal((await threadRow(`${primary.sourceId}|jev-3`))?.engine, "jev");
    const visible = await shown(eclipse);
    assert.ok(visible.includes("jack@jevdown.test"));
    assert.ok(visible.includes("nora@jevnull.test"), "a Jev answer with no confidence shows");
    assert.ok(visible.includes("both@fail.test"));
    assert.equal((await threadRow(`${primary.sourceId}|jev-4`))?.engine, "failed");

    const slow = gateway({ jevWaits: true, haiku: () => ({ category: "spam" }) });
    await addMessage(primary, { id: "jev-slow", from: "sam@slowjev.test", to: ["mark@geteclipse.co"], subject: "Hi" });
    await classifyCapture(eclipse, { deadline: Date.now() + 4_000, fetchImpl: slow.fetchImpl, readHeaders: async () => [] });
    assert.equal(slow.jev.length, 1);
    assert.equal(slow.haiku.length, 1);
    assert.equal((await threadRow(`${primary.sourceId}|jev-slow`))?.engine, "haiku");
  });

  it("judges the same sender with each workspace's own brand and person, caches per workspace, and keeps rules to one workspace", async () => {
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
    assert.deepEqual(cached.rows, [{ workspace_id: ridgeon.workspaceId, category: "business" }]);

    const both = gateway({ haiku: () => ({ category: "business" }) });
    await runCaptureAction(ridgeon, readCaptureAction({ kind: "rule-remove", sender: "lena@brightpath.test" }));
    const inEclipse = await addMessage(primary, { id: "max-e", from: "max@dualco.test", to: ["mark@geteclipse.co"], subject: "Hello" });
    await addMessage(extra, { id: "max-r", from: "max@dualco.test", to: ["mark@markridgeon.com"], subject: "Hello" });
    await classify(both.fetchImpl);
    await runCaptureAction(eclipse, readCaptureAction({ kind: "email-never", key: inEclipse.key }));
    await addMessage(primary, { id: "max-e2", from: "max@dualco.test", to: ["mark@geteclipse.co"], subject: "Again" });
    await addMessage(extra, { id: "max-r2", from: "max@dualco.test", to: ["mark@markridgeon.com"], subject: "Again" });
    await classify(both.fetchImpl);
    assert.equal((await skipped(eclipse))["max@dualco.test"], "muted");
    assert.ok((await shown(ridgeon)).includes("max@dualco.test"));
  });

  it("puts written-to and met senders first, over cached and thread decisions, and passes domain history to the model", async () => {
    process.env.LLM_API_KEY = "test-key";
    const fake = gateway({ haiku: (state) => ({ category: state.history.userHasWrittenToDomain ? "business" : "newsletter" }) });
    await addMessage(primary, { id: "harbour-old", from: "mark@geteclipse.co", to: ["ops@harbourline.test"], subject: "Proposal", sent: true, at: minutesAgo(60 * 24 * 40) });
    await addMessage(primary, { id: "harbour-reply", from: "ops@harbourline.test", to: ["mark@geteclipse.co"], subject: "Re: Proposal", at: minutesAgo(60 * 24 * 39) });
    await addMessage(primary, { id: "kim", from: "kim@harbourline.test", to: ["mark@geteclipse.co"], subject: "Following up" });
    await addMessage(primary, { id: "cara", from: "cara@caching.test", to: ["mark@geteclipse.co"], subject: "Catch up" });
    await addMessage(primary, { id: "mel", from: "mel@meetings.test", to: ["mark@geteclipse.co"], subject: "Catch up" });
    await addMessage(primary, { id: "relay", from: "rhea@relay.test", to: ["mark@geteclipse.co"], subject: "Catch up" });
    await classify(fake.fetchImpl);
    const kim = fake.haiku.find((call) => call.state.email.fromAddress === "kim@harbourline.test")!;
    assert.equal(kim.state.history.userHasWrittenToDomain, true);
    assert.equal(kim.state.history.userHasWrittenToSender, false);
    assert.match(kim.state.history.mailWithDomain, /^2 from the domain, 1 from the user to it, first \d{4}-\d{2}-\d{2}/);
    assert.doesNotMatch(JSON.stringify(kim.state), /Proposal/);
    assert.ok((await shown(eclipse)).includes("kim@harbourline.test"));
    assert.equal((await skipped(eclipse))["cara@caching.test"], "newsletter");
    assert.equal((await skipped(eclipse))["mel@meetings.test"], "newsletter");

    await addMessage(primary, { id: "cara-sent", from: "mark@geteclipse.co", to: ["cara@caching.test"], subject: "Lunch?", sent: true, at: minutesAgo(1) });
    assert.ok((await shown(eclipse)).includes("cara@caching.test"), "writing to them shows them again");
    const admin = getAdminPool();
    const calendar = await admin.query<{ id: string }>(
      `insert into crm.calendars (workspace_id, user_id, connection_id, provider_calendar_id, name, color, use_for_crm)
       values ($1, $2, $3, 'cal-history', 'History', '#000000', false) returning id`,
      [eclipse.workspaceId, eclipse.userId, connectionId],
    );
    await admin.query(
      `insert into crm.calendar_events (workspace_id, calendar_id, connection_id, user_id, provider_event_id, subject, starts_at, ends_at, attendees)
       values ($1, $2, $3, $4, 'met-mel', 'Coffee', now() - interval '1 day', now() - interval '1 day' + interval '30 minutes', $5::jsonb)`,
      [eclipse.workspaceId, calendar.rows[0].id, connectionId, eclipse.userId, JSON.stringify([{ name: "Mel", email: "mel@meetings.test" }])],
    );
    assert.ok((await shown(eclipse)).includes("mel@meetings.test"), "meeting them shows them");

    assert.equal((await skipped(eclipse))["rhea@relay.test"], "newsletter");
    await addMessage(primary, { id: "relay-2", thread: "relay", from: "dan@forwarded.test", to: ["mark@geteclipse.co"], subject: "Re: Catch up", at: minutesAgo(0) });
    const context = await captureContext(eclipse);
    assert.ok(context.held.some((item) => item.key === `${primary.sourceId}|relay`), "a thread decision about someone else no longer applies");

    await addMessage(primary, { id: "joe-old", from: "mark@geteclipse.co", to: ["joe@gmail.com"], subject: "Lunch", sent: true, at: minutesAgo(60 * 24 * 10) });
    await addMessage(primary, { id: "joe", from: "joe@gmail.com", to: ["mark@geteclipse.co"], subject: "Spring sale for you" });
    const before = fake.haiku.length;
    await classify(fake.fetchImpl);
    assert.equal(fake.haiku.some((call, index) => index >= before && call.state.email.fromAddress === "joe@gmail.com"), false);
    assert.equal((await threadRow(`${primary.sourceId}|joe`))?.engine, "history");
    assert.ok((await shown(eclipse)).includes("joe@gmail.com"));
  });

  it("keeps header decisions on the thread only", async () => {
    process.env.LLM_API_KEY = "test-key";
    const fake = gateway({ haiku: () => ({ category: "business" }) });
    const first = await addMessage(primary, { id: "group-1", from: "gail@groupy.test", to: ["mark@geteclipse.co"], subject: "Group post" });
    await classify(fake.fetchImpl, { readHeaders: async (item) => (item.key === first.key ? [{ name: "List-Id", value: "<group.groupy.test>" }] : []) });
    assert.deepEqual(await threadRow(first.key), { category: "newsletter", engine: "headers", workspace_id: eclipse.workspaceId });
    assert.equal((await skipped(eclipse))["gail@groupy.test"], "newsletter");
    const cached = await getAdminPool().query("select 1 from crm.mail_sender_relevance where sender = 'gail@groupy.test'");
    assert.equal(cached.rowCount, 0);
    await addMessage(primary, { id: "group-2", from: "gail@groupy.test", to: ["mark@geteclipse.co"], subject: "Direct question" });
    await classify(fake.fetchImpl);
    assert.equal(fake.haiku.filter((call) => call.state.email.fromAddress === "gail@groupy.test").length, 1);
    assert.equal((await threadRow(`${primary.sourceId}|group-2`))?.engine, "haiku");
  });

  it("lets Never ask and Show in Capture beat the AI, lists the rules and removes them", async () => {
    process.env.LLM_API_KEY = "test-key";
    const fake = gateway({ haiku: (state) => ({ category: state.email.fromAddress.endsWith("@vendorly.test") ? "business" : "newsletter" }) });
    const first = await addMessage(primary, { id: "vend-1", from: "rep@vendorly.test", to: ["mark@geteclipse.co"], subject: "Quick chat" });
    const promo = await addMessage(primary, { id: "promo-1", from: "maria@promo.test", to: ["mark@geteclipse.co"], subject: "Catch up" });
    await classify(fake.fetchImpl);
    assert.ok((await shown(eclipse)).includes("rep@vendorly.test"));
    assert.equal((await skipped(eclipse))["maria@promo.test"], "newsletter");

    await runCaptureAction(eclipse, readCaptureAction({ kind: "email-never", key: first.key }));
    await addMessage(primary, { id: "vend-2", from: "boss@vendorly.test", to: ["mark@geteclipse.co"], subject: "Following up" });
    const before = fake.haiku.length;
    await classify(fake.fetchImpl);
    assert.equal(fake.haiku.length, before);
    const list = await capture(eclipse);
    assert.ok(!list.emails.some((email) => email.email.endsWith("@vendorly.test")));
    assert.equal(list.notShown.find((email) => email.email === "boss@vendorly.test")?.category, "muted");

    assert.ok(!list.notShown.some((email) => email.key === first.key), "the dismissed thread itself is gone");

    await runCaptureAction(eclipse, readCaptureAction({ kind: "email-show", key: promo.key }));
    assert.ok((await shown(eclipse)).includes("maria@promo.test"));
    await addMessage(primary, { id: "promo-2", from: "maria@promo.test", to: ["mark@geteclipse.co"], subject: "Spring sale" });
    await classify(fake.fetchImpl);
    assert.deepEqual(
      (await capture(eclipse)).emails.filter((email) => email.email === "maria@promo.test").map((email) => email.key).sort(),
      [promo.key, `${primary.sourceId}|promo-2`].sort(),
    );
    assert.deepEqual(
      (await listSenderRules(eclipse)).filter((rule) => ["@vendorly.test", "maria@promo.test"].includes(rule.sender)),
      [
        { sender: "@vendorly.test", kind: "never" },
        { sender: "maria@promo.test", kind: "always" },
      ],
    );
    assert.equal(readCaptureAction({ kind: "rule-remove", sender: "@vendorly.test" }).kind, "rule-remove");
    await runCaptureAction(ridgeon, readCaptureAction({ kind: "rule-remove", sender: "@vendorly.test" }));
    const sam = await createUser("sam.rules@elsewhere.test", "Sam Rules");
    await runCaptureAction(sam, readCaptureAction({ kind: "rule-remove", sender: "@vendorly.test" }));
    assert.ok((await listSenderRules(eclipse)).some((rule) => rule.sender === "@vendorly.test"), "another workspace or person can't remove it");
    await runCaptureAction(eclipse, readCaptureAction({ kind: "rule-remove", sender: "@vendorly.test" }));
    await runCaptureAction(eclipse, readCaptureAction({ kind: "rule-remove", sender: "@vendorly.test" }));
    assert.ok(!(await listSenderRules(eclipse)).some((rule) => rule.sender === "@vendorly.test"));
    await classify(fake.fetchImpl);
    assert.ok((await shown(eclipse)).includes("boss@vendorly.test"));
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

  it("keeps sorting when one email can't be stored, and stores each copied decision on its own", async () => {
    process.env.LLM_API_KEY = "test-key";
    const fake = gateway({ haiku: () => ({ category: "business" }) });
    const long = `${"a".repeat(330)}@gmail.com`;
    const longCollections = `${"b".repeat(330)}@lowell.co.uk`;
    await addMessage(primary, { id: "long", from: long, to: ["mark@geteclipse.co"], subject: "Hello" });
    await addMessage(primary, { id: "long-collections", from: longCollections, to: ["mark@geteclipse.co"], subject: "Account" });
    await addMessage(primary, { id: "after-long", from: "fine@okay.test", to: ["mark@geteclipse.co"], subject: "Hello" });
    await addMessage(primary, { id: "after-long-collections", from: "agent2@lowell.co.uk", to: ["mark@geteclipse.co"], subject: "Account" });
    const run = await classify(fake.fetchImpl);
    assert.equal(run.skipped, false);
    assert.equal((await threadRow(`${primary.sourceId}|after-long`))?.engine, "haiku");
    assert.equal((await threadRow(`${primary.sourceId}|after-long-collections`))?.engine, "listed");
    assert.equal(await threadRow(`${primary.sourceId}|long`), null);
    assert.ok((await captureContext(eclipse)).held.some((item) => item.key === `${primary.sourceId}|long`));
    await getAdminPool().query("update crm.mail_messages set from_email = 'fixed@okay.test' where provider_message_id = 'long'");
    await getAdminPool().query("update crm.mail_messages set from_email = 'agent3@lowell.co.uk' where provider_message_id = 'long-collections'");
  });

  it("takes over a stale claim, releases its claim when a run throws, and only releases its own claim", async () => {
    process.env.LLM_API_KEY = "test-key";
    const fake = gateway({ haiku: () => ({ category: "business" }) });
    const admin = getAdminPool();
    await admin.query("update crm.mail_relevance_runs set started_at = now() - interval '10 minutes', running_until = now() + interval '1 minute' where user_id = $1", [eclipse.userId]);
    assert.equal((await classify(fake.fetchImpl)).skipped, true);
    await admin.query("update crm.mail_relevance_runs set started_at = now() - interval '10 minutes', running_until = now() - interval '1 second' where user_id = $1", [eclipse.userId]);
    assert.equal((await classify(fake.fetchImpl)).skipped, false);
    const exploding = {
      deadline: Date.now() + 60_000,
      fetchImpl: fake.fetchImpl,
      get limit(): number {
        throw new Error("boom");
      },
    };
    await assert.rejects(classifyCapture(eclipse, exploding), /boom/);
    assert.equal((await classify(fake.fetchImpl)).skipped, false);
  });

  it("classifies at most 25 a run, stops at the deadline, and runs one sort per person at a time", async () => {
    await settleAll();
    process.env.LLM_API_KEY = "test-key";
    const fake = gateway({ haiku: () => ({ category: "business" }) });
    for (let index = 0; index < 30; index += 1) await addMessage(primary, { id: `many-${index}`, from: `person${index}@many${index}.test`, to: ["mark@geteclipse.co"], subject: "Hello" });
    const late = await classifyCapture(eclipse, { deadline: Date.now() + 1_000, fetchImpl: fake.fetchImpl, readHeaders: async () => [] });
    assert.equal(late.decided, 0);
    assert.equal(fake.haiku.length, 0);
    const [first, second] = await Promise.all([classify(fake.fetchImpl), classify(fake.fetchImpl)]);
    assert.equal([first, second].filter((run) => run.skipped).length, 1);
    assert.equal((first.skipped ? second : first).decided, 25);
    assert.equal(fake.haiku.length, 25);
    const recent = await classify(fake.fetchImpl, { gapSeconds: 60 });
    assert.equal(recent.skipped, true);
    await classify(fake.fetchImpl);
    assert.equal(fake.haiku.length, 30);
  });

  it("gives the assistant only counts for Personal and Collections email", async () => {
    const result = (await runTool(eclipse, "get_capture", {})) as {
      toFile: { notShown: { count: number; personalOrCollections: number; emails: { from: string; subject?: string; category: string }[] } };
    };
    assert.ok(result.toFile.notShown.count >= 6);
    assert.ok(result.toFile.notShown.personalOrCollections >= 4);
    const listed = JSON.stringify(result.toFile.notShown.emails);
    for (const hidden of ["clinic@gp.nhs.uk", "clinic@healthy.test", "recovery@dues.test", "agent@lowell.co.uk"]) assert.doesNotMatch(listed, new RegExp(hidden));
    assert.ok(result.toFile.notShown.emails.every((email) => email.category !== "Personal" && email.category !== "Collections"));
    assert.equal(result.toFile.notShown.emails.find((email) => email.from.includes("bills@vendorco.test"))?.subject, "Invoice for you");
  });

  it("keeps Personal and Collections mail out of nightly personal learning", async () => {
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
    const decide = (thread: string, sender: string, category: string, confidence: number, workspaceId = eclipse.workspaceId) =>
      admin.query(
        `insert into crm.mail_thread_relevance (workspace_id, user_id, source_id, thread_key, sender, category, engine, confidence)
         values ($1, $2, $3, $4, $5, $6, 'haiku', $7)`,
        [workspaceId, eclipse.userId, primary.sourceId, thread, sender, category, confidence],
      );
    await prepare("learn-business", "dana@clientco.test", "BUSINESS-REPLY");
    await prepare("learn-health", "doc@healthyplace.test", "HEALTH-REPLY");
    await prepare("learn-bank", "advisor@barclays.co.uk", "BANKER-REPLY");
    await prepare("learn-statements", "statements@barclays.co.uk", "STATEMENT-REPLY");
    await prepare("learn-debt", "chaser@chasers.test", "DEBT-REPLY");
    await prepare("learn-unsure", "maybe@unsure-health.test", "UNSURE-REPLY");
    await prepare("learn-elsewhere", "other@elsewhere-health.test", "ELSEWHERE-REPLY");
    await prepare("learn-filed", "jane@acme-health.test", "FILED-REPLY");
    await decide("learn-health", "doc@healthyplace.test", "personal", 0.95);
    await decide("learn-debt-other-thread", "chaser@chasers.test", "collections", 0.9);
    await decide("learn-unsure", "maybe@unsure-health.test", "personal", 0.6);
    await decide("learn-elsewhere", "other@elsewhere-health.test", "personal", 0.95, ridgeon.workspaceId);
    await decide("learn-filed", "jane@acme-health.test", "personal", 0.95);
    await withActor(eclipse, (db) => recordFiledInDb(db, eclipse, eclipse.workspaceId, "jane@acme-health.test"));
    const fake = gateway({});
    await learnNow(eclipse, { deadline: Date.now() + 60_000, fetchImpl: fake.fetchImpl, kinds: ["personal"] });
    assert.equal(fake.learning.length, 1);
    for (const kept of ["BUSINESS-REPLY", "BANKER-REPLY", "UNSURE-REPLY", "ELSEWHERE-REPLY", "FILED-REPLY"]) assert.match(fake.learning[0], new RegExp(kept));
    assert.doesNotMatch(fake.learning[0], /HEALTH-REPLY|STATEMENT-REPLY|DEBT-REPLY/);
  });

  it("keeps another member's Personal email out of shared business learning", async () => {
    process.env.LLM_API_KEY = "test-key";
    const admin = getAdminPool();
    const priya = await createUser("priya@geteclipse.co", "Priya Shah");
    await admin.query("insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, 'member')", [eclipse.workspaceId, priya.userId]);
    const theirConnection = await admin.query<{ id: string }>(
      `insert into crm.mailbox_connections (workspace_id, user_id, provider, email, status, refresh_token)
       values ($1, $2, 'microsoft', 'priya@geteclipse.co', 'connected', 'cipher') returning id`,
      [eclipse.workspaceId, priya.userId],
    );
    const theirs = await source({ ...priya, workspaceId: eclipse.workspaceId }, "connection_id", theirConnection.rows[0].id, "priya@geteclipse.co");
    const message = await addMessage(theirs, { id: "priya-gp", from: "gp@surgery.test", to: ["priya@geteclipse.co"], subject: "Results" }, { ...priya, workspaceId: eclipse.workspaceId });
    await admin.query(
      `insert into crm.mail_thread_relevance (workspace_id, user_id, source_id, thread_key, sender, category, engine, confidence)
       values ($1, $2, $3, 'priya-gp', 'gp@surgery.test', 'personal', 'haiku', 0.95)`,
      [eclipse.workspaceId, priya.userId, theirs.sourceId],
    );
    const unsure = await addMessage(theirs, { id: "priya-unsure", from: "buyer@council.test", to: ["priya@geteclipse.co"], subject: "Tender" }, { ...priya, workspaceId: eclipse.workspaceId });
    await admin.query(
      `insert into crm.mail_thread_relevance (workspace_id, user_id, source_id, thread_key, sender, category, engine, confidence)
       values ($1, $2, $3, 'priya-unsure', 'buyer@council.test', 'personal', 'haiku', 0.6)`,
      [eclipse.workspaceId, priya.userId, theirs.sourceId],
    );
    const company = (await admin.query<{ id: string }>("insert into crm.companies (workspace_id, name, normalized_name) values ($1, 'Toneco', 'toneco') returning id", [eclipse.workspaceId])).rows[0].id;
    const activity = async (title: string, metadata: Record<string, unknown>) =>
      (
        await admin.query<{ id: string }>(
          "insert into crm.activities (workspace_id, company_id, type, title, occurred_at, metadata) values ($1, $2, 'email', $3, now() - interval '1 hour', $4::jsonb) returning id",
          [eclipse.workspaceId, company, title, JSON.stringify(metadata)],
        )
      ).rows[0].id;
    const hidden = await activity("PRIYA-HEALTH", { mailMessageId: message.id });
    const kept = await activity("CLIENT-TONE", { mailMessageId: "not-a-uuid-------------------------" });
    const buyer = await activity("BUYER-TONE", { mailMessageId: unsure.id });
    for (const [id, tone] of [
      [hidden, "negative"],
      [kept, "positive"],
      [buyer, "positive"],
    ]) {
      await admin.query("insert into crm.activity_tones (activity_id, workspace_id, tone, reason) values ($1, $2, $3, 'Test.')", [id, eclipse.workspaceId, tone]);
    }
    const fake = gateway({});
    await learnNow(eclipse, { deadline: Date.now() + 60_000, fetchImpl: fake.fetchImpl, kinds: ["business"] });
    assert.equal(fake.business.length, 1);
    assert.match(fake.business[0], /CLIENT-TONE/);
    assert.match(fake.business[0], /BUYER-TONE/);
    assert.doesNotMatch(fake.business[0], /PRIYA-HEALTH/);
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

  it("keeps sender and thread decisions private to their owner, and closed to agents", async () => {
    const other = await createUser("sam@elsewhere.test", "Sam Other");
    const theirs = await queryAsUser<{ total: number }>(other.userId, "select count(*)::int as total from crm.mail_sender_relevance");
    assert.equal(theirs[0].total, 0);
    const threads = await queryAsUser<{ total: number }>(other.userId, "select count(*)::int as total from crm.mail_thread_relevance");
    assert.equal(threads[0].total, 0);
    const runs = await queryAsUser<{ total: number }>(other.userId, "select count(*)::int as total from crm.mail_relevance_runs");
    assert.equal(runs[0].total, 0);
    const known = await queryAsUser<{ total: number }>(other.userId, "select count(*)::int as total from crm.mail_known_addresses");
    assert.equal(known[0].total, 0);
    assert.ok((await queryAsUser<{ total: number }>(eclipse.userId, "select count(*)::int as total from crm.mail_known_addresses"))[0].total > 0);
    await assert.rejects(queryAsUser(eclipse.userId, "insert into crm.mail_known_addresses (user_id, address, domain) values ($1, 'x@y.test', 'y.test')", [eclipse.userId]), /permission denied/);
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
    assert.equal((await queryAsUser<{ id: string }>(other.userId, "update crm.mail_thread_relevance set category = 'business' returning id")).length, 0);
    assert.equal((await queryAsUser<{ id: string }>(other.userId, "delete from crm.mail_sender_relevance returning id")).length, 0);
    await assert.rejects(queryAsUser(other.userId, "delete from crm.mail_thread_relevance returning id"), /permission denied/);
    const client = await getAdminPool().connect();
    try {
      for (const table of ["mail_sender_relevance", "mail_thread_relevance", "mail_relevance_runs", "mail_known_addresses"]) {
        await client.query("begin");
        await client.query("set local role crm_agent");
        await assert.rejects(client.query(`select count(*) from crm.${table}`), /permission denied/);
        await client.query("rollback");
      }
    } finally {
      client.release();
    }
  });

  it("drops a workspace's decisions when its member leaves", async () => {
    const admin = getAdminPool();
    const before = await admin.query<{ total: number }>("select count(*)::int as total from crm.mail_sender_relevance where workspace_id = $1 and user_id = $2", [ridgeon.workspaceId, eclipse.userId]);
    assert.ok(before.rows[0].total > 0);
    const eclipseRows = await admin.query<{ total: number }>("select count(*)::int as total from crm.mail_sender_relevance where workspace_id = $1 and user_id = $2", [eclipse.workspaceId, eclipse.userId]);
    for (const table of ["granola_keys", "recall_keys", "readwise_keys"]) await admin.query(`delete from crm.${table} where user_id = $1`, [eclipse.userId]);
    await admin.query("insert into crm.granola_keys (workspace_id, user_id, key_cipher) values ($1, $2, 'granola')", [ridgeon.workspaceId, eclipse.userId]);
    await admin.query("insert into crm.recall_keys (workspace_id, user_id, key_cipher) values ($1, $2, 'recall')", [ridgeon.workspaceId, eclipse.userId]);
    const readwise = await admin.query<{ id: string }>(
      `insert into crm.readwise_keys (workspace_id, user_id, token_cipher, token_hint, updated_after, full_sync_at, scan_cursor, list_cursor, list_done)
       values ($1, $2, 'cipher', 'rw01', now(), now(), 'scan-cursor', 'list-cursor', true) returning id`,
      [ridgeon.workspaceId, eclipse.userId],
    );
    await admin.query("insert into crm.readwise_documents (key_id, workspace_id, user_id, document_id) values ($1, $2, $3, 'doc-1')", [
      readwise.rows[0].id,
      ridgeon.workspaceId,
      eclipse.userId,
    ]);
    await admin.query("select private.move_personal_rows($1, $2, $3)", [eclipse.userId, ridgeon.workspaceId, eclipse.workspaceId]);
    const keys = await admin.query<{ granola: string; recall: string; readwise: string; scan_cursor: string | null; list_done: boolean; documents: number }>(
      `select (select workspace_id::text from crm.granola_keys where user_id = $1) as granola,
         (select workspace_id::text from crm.recall_keys where user_id = $1) as recall,
         (select workspace_id::text from crm.readwise_keys where user_id = $1) as readwise,
         (select scan_cursor from crm.readwise_keys where user_id = $1) as scan_cursor,
         (select list_done from crm.readwise_keys where user_id = $1) as list_done,
         (select count(*)::int from crm.readwise_documents where user_id = $1) as documents`,
      [eclipse.userId],
    );
    assert.deepEqual(keys.rows[0], {
      granola: eclipse.workspaceId,
      recall: eclipse.workspaceId,
      readwise: eclipse.workspaceId,
      scan_cursor: null,
      list_done: false,
      documents: 0,
    });
    const left = await admin.query<{ senders: number; threads: number }>(
      `select (select count(*)::int from crm.mail_sender_relevance where workspace_id = $1 and user_id = $2) as senders,
         (select count(*)::int from crm.mail_thread_relevance where workspace_id = $1 and user_id = $2) as threads`,
      [ridgeon.workspaceId, eclipse.userId],
    );
    assert.deepEqual(left.rows[0], { senders: 0, threads: 0 });
    const still = await admin.query<{ total: number }>("select count(*)::int as total from crm.mail_sender_relevance where workspace_id = $1 and user_id = $2", [eclipse.workspaceId, eclipse.userId]);
    assert.equal(still.rows[0].total, eclipseRows.rows[0].total);
  });
});
