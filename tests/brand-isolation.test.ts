import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { userLinks } from "@/lib/assistant/links";
import { describeAction, recordNames, runTool } from "@/lib/assistant/tools";
import { checkSlugAvailable, getBookingPage, saveBookingPage } from "@/lib/booking/pages";
import { DEFAULT_WEEKLY_HOURS } from "@/lib/booking/rules";
import { logActivity } from "@/lib/crm/activities";
import { saveBrandProfile } from "@/lib/crm/brand";
import { createContact } from "@/lib/crm/contacts";
import { withActor } from "@/lib/crm/context";
import { saveMailbox } from "@/lib/crm/inbox";
import { aboutWriterNote, aboutYouSection, getPersonalContext, saveAboutYou, saveYou } from "@/lib/crm/personal-context";
import type { UserActor } from "@/lib/crm/types";
import { createWorkspace } from "@/lib/crm/workspaces";
import { encryptSecret } from "@/lib/crypto/secret";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { latestBrief, learnNow, sortPersonalMemories } from "@/lib/learning/nightly";
import { rememberNote } from "@/lib/learning/memories";
import { defaultSender, resolveSendAccount } from "@/lib/mail/compose";
import { draftWithAi, voiceSamples } from "@/lib/mail/ai";
import { stripSignature } from "@/lib/mail/format";
import { prepareMail, setMailHelp } from "@/lib/mail/prepare";
import { setAddressHome } from "@/lib/mail/routing";
import { syncMail } from "@/lib/mail/sync";
import { createUser, resetDatabase } from "./helpers";

const GRAPH = "https://graph.microsoft.com/v1.0";
const MAIN = "mark@eclipse.test";
const CONSULTING = "mark@ridgeon.me";
const PRIYA = "priya@scaleup.test";
const WEB = { operation: "isolation_test", source: "web" };

function ago(hours: number) {
  return new Date(Date.now() - hours * 3_600_000).toISOString();
}

function message(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    internetMessageId: `<${id}@mail.test>`,
    conversationId: `conv-${id}`,
    subject: "Operations help",
    bodyPreview: "",
    body: { contentType: "text", content: "Hi Mark,\n\nWe need help running operations while we grow. Could we talk next week?\n\nPriya" },
    from: { emailAddress: { name: "Priya Shah", address: PRIYA } },
    toRecipients: [{ emailAddress: { name: "Mark", address: CONSULTING } }],
    ccRecipients: [],
    bccRecipients: [],
    sentDateTime: ago(1),
    receivedDateTime: ago(1),
    isRead: false,
    isDraft: false,
    flag: { flagStatus: "notFlagged" },
    importance: "normal",
    hasAttachments: false,
    categories: [],
    webLink: null,
    ...overrides,
  };
}

function mailbox(state: { inbox: unknown[]; sent: unknown[] }): typeof fetch {
  return async (input) => {
    const url = String(input);
    const named = url.match(/\/me\/mailFolders\/(inbox|sentitems|drafts|archive|deleteditems|junkemail|outbox)\?\$select=id$/);
    if (named) {
      const ids: Record<string, string> = { inbox: "f-inbox", sentitems: "f-sent" };
      return ids[named[1]] ? Response.json({ id: ids[named[1]] }) : Response.json({ error: { code: "ErrorFolderNotFound" } }, { status: 404 });
    }
    if (url.startsWith(`${GRAPH}/me/mailFolders?$top=100`)) {
      return Response.json({ value: [{ id: "f-inbox", displayName: "Inbox", childFolderCount: 0 }, { id: "f-sent", displayName: "Sent Items", childFolderCount: 0 }] });
    }
    if (url.includes("inferenceClassification") && !url.includes("delta")) return Response.json({ value: [] });
    const folder = url.match(/\/me\/mailFolders\/([^/]+)\/messages\/delta/)?.[1];
    const pages: Record<string, unknown[]> = { "f-inbox": state.inbox, "f-sent": state.sent };
    const value = folder ? (pages[folder] ?? []) : [];
    return Response.json({ value, "@odata.deltaLink": `${GRAPH}/me/mailFolders/${folder}/messages/delta?$deltatoken=${Math.random()}` });
  };
}

function model(reply: (system: string) => unknown) {
  const prompts: { system: string; user: string }[] = [];
  const fetchImpl: typeof fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { messages: { content: string }[] };
    prompts.push({ system: body.messages[0].content, user: body.messages[1].content });
    return Response.json({ model: "test-model", choices: [{ message: { content: JSON.stringify(reply(body.messages[0].content)) }, finish_reason: "stop" }] });
  };
  return { fetchImpl, prompts };
}

describe("brand isolation between workspaces", () => {
  let eclipse: UserActor;
  let ridgeon: UserActor;

  before(async () => {
    process.env.LLM_API_KEY = "test-llm-key";
    await resetDatabase();
    const admin = getAdminPool();
    const owner = await createUser("mark@orbit-isolation.test", "Mark Ridgeon");
    await admin.query("update crm.workspaces set name = 'Eclipse' where id = $1", [owner.workspaceId]);
    eclipse = { ...owner, workspaceName: "Eclipse" };
    const created = await createWorkspace(eclipse, { name: "Mark Ridgeon" });
    ridgeon = { ...eclipse, workspaceId: created.id, workspaceName: "Mark Ridgeon" };

    await saveMailbox(eclipse, { email: MAIN, refreshToken: "refresh", accessToken: "access", expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
    await saveBrandProfile(eclipse, { website: "https://geteclipse.co", whatYouSell: "ECLIPSE OFFER, an AI visibility platform.", whoItsFor: "", tone: "" }, WEB);
    await saveBrandProfile(ridgeon, { website: "https://ridgeon.me", whatYouSell: "RIDGEON OFFER, fractional COO work for scale-ups.", whoItsFor: "", tone: "" }, WEB);
    await saveAboutYou(eclipse, { jobTitle: "Founder, Eclipse", about: "ECLIPSE ABOUT I run Eclipse and Ridgeon Consultancy." });
    await saveAboutYou(ridgeon, { jobTitle: "Fractional COO", about: "RIDGEON ABOUT Fractional COO for scale-ups." });
    await saveYou(eclipse, { linkedinUrl: "", interests: "", writing: "SHARED WRITING Short lines." });

    await saveBookingPage(eclipse, { slug: "mark", enabled: true, durationMinutes: 30, bufferMinutes: 10, minNoticeMinutes: 240, horizonDays: 21, weeklyHours: DEFAULT_WEEKLY_HOURS });

    const eclipsePriya = (await createContact(eclipse, { firstName: "Priya", lastName: "Shah", email: PRIYA, jobTitle: "ECLIPSE TITLE Content lead" })).body.contact;
    const ridgeonPriya = (await createContact(ridgeon, { firstName: "Priya", lastName: "Shah", email: PRIYA, jobTitle: "RIDGEON TITLE COO" })).body.contact;
    await logActivity(eclipse, { contactId: eclipsePriya.id }, "call", "Eclipse demo", "ECLIPSE CALL NOTE about content.");
    await logActivity(ridgeon, { contactId: ridgeonPriya.id }, "call", "Ops intro", "RIDGEON CALL NOTE about operations.");

    const note = (workspaceId: string, title: string) =>
      admin.query("insert into crm.memories (workspace_id, user_id, scope, kind, title, body, all_workspaces) values ($1, $2, 'personal', 'writing', $3, $3, false)", [
        workspaceId,
        eclipse.userId,
        title,
      ]);
    await note(eclipse.workspaceId, "ECLIPSE NOTE Mark's Eclipse emails mention AI answers");
    await note(ridgeon.workspaceId, "RIDGEON NOTE Mark's consulting emails stay under 80 words");

    await setMailHelp(eclipse, { prepareReplies: true, autoRemindDays: null });
    await syncMail(eclipse, {
      budgetMs: 30_000,
      fetchImpl: mailbox({
        inbox: [message("m-priya")],
        sent: [
          message("s-ridgeon", {
            conversationId: "conv-s-ridgeon",
            subject: "Quarter plan",
            from: { emailAddress: { name: "Mark Ridgeon", address: CONSULTING } },
            toRecipients: [{ emailAddress: { name: "Tom", address: "tom@client.test" } }],
            body: { contentType: "text", content: "Hi Tom,\n\nRIDGEON VOICE here is the short plan for the quarter, with the two hires first.\n\nMark\n\nMark Ridgeon\nFractional COO\nridgeon.me" },
            sentDateTime: ago(30),
            receivedDateTime: ago(30),
          }),
          message("s-eclipse", {
            conversationId: "conv-s-eclipse",
            subject: "Visibility report",
            from: { emailAddress: { name: "Mark Ridgeon", address: MAIN } },
            toRecipients: [{ emailAddress: { name: "Ann", address: "ann@agency.test" } }],
            body: { contentType: "text", content: "Hi Ann,\n\nECLIPSE VOICE the AI visibility report for your clients is attached as promised.\n\nMark" },
            sentDateTime: ago(31),
            receivedDateTime: ago(31),
          }),
        ],
      }),
    });
    const source = await admin.query<{ id: string }>("select id from crm.mail_sources where user_id = $1", [eclipse.userId]);
    await admin.query(
      `insert into crm.send_identities (workspace_id, user_id, source_id, email, display_name, smtp_host, smtp_port, username, password_cipher)
       values ($1, $2, $3, $4, 'Mark Ridgeon', 'smtp0001.neo.space', 465, $4, $5)`,
      [eclipse.workspaceId, eclipse.userId, source.rows[0].id, CONSULTING, encryptSecret("neo-password")],
    );
    await setAddressHome(eclipse, CONSULTING, ridgeon.workspaceId);
    await admin.query(
      "insert into crm.email_signatures (workspace_id, user_id, sender_email, body) values ($1, $2, $3, 'Mark Ridgeon\nFractional COO\nridgeon.me')",
      [ridgeon.workspaceId, eclipse.userId, CONSULTING],
    );
  });

  after(async () => {
    await getPool().end();
  });

  it("strips the signature block from a sample", () => {
    assert.equal(stripSignature("Hi Tom,\n\nThe plan.\n\nMark\n\nMark Ridgeon\nFractional COO", { name: "Mark Ridgeon" }), "Hi Tom,\n\nThe plan.\n\nMark");
    assert.equal(stripSignature("Hi Tom,\n\nThe plan.\n\nThanks\n-- \nMark Ridgeon"), "Hi Tom,\n\nThe plan.\n\nThanks");
    assert.equal(stripSignature("Hi Tom,\n\nThe plan.\nMark Ridgeon | Fractional COO", { signature: "Mark Ridgeon | Fractional COO" }), "Hi Tom,\n\nThe plan.");
    const middle = "Hi Tom,\n--\nOne\nTwo\nThree\nFour\nFive\nSix\nSeven\nEight\nNine";
    assert.equal(stripSignature(middle), middle);
    assert.equal(stripSignature("Hi Tom,\n\nMark the dates.\nCOO", { signature: "COO\nridgeon.me", name: "Mark Ridgeon" }), "Hi Tom,\n\nMark the dates.\nCOO");
    assert.equal(stripSignature("Hi Tom,\n\nWe use Mark Ridgeon | Fractional COO style.\n\nMark\nMark Ridgeon | Fractional COO", { signature: "Mark Ridgeon | Fractional COO", name: "Mark Ridgeon" }), "Hi Tom,\n\nWe use Mark Ridgeon | Fractional COO style.\n\nMark");
  });

  it("keeps Eclipse's own voice samples through the addresses homed there by default", async () => {
    const eclipseVoice = await withActor(eclipse, (db) => voiceSamples(db, eclipse));
    assert.ok(eclipseVoice.length > 0);
    assert.ok(eclipseVoice.some((sample) => sample.includes("ECLIPSE VOICE")));
    assert.ok(!eclipseVoice.some((sample) => sample.includes("RIDGEON VOICE")));
    const ridgeonVoice = await withActor(ridgeon, (db) => voiceSamples(db, ridgeon));
    assert.deepEqual(ridgeonVoice.map((sample) => sample.includes("RIDGEON VOICE")), [true]);
    assert.doesNotMatch(ridgeonVoice[0], /Fractional COO/);
  });

  it("writes with AI for the workspace the thread is filed in, even when viewed from another", async () => {
    const found = await getAdminPool().query<{ id: string }>("select id from crm.mail_messages where provider_message_id = 'm-priya'");
    const { fetchImpl, prompts } = model(() => ({ body: "Hi Priya,\n\nHappy to talk next week.\n\nMark" }));
    await draftWithAi(eclipse, { mode: "reply", messageId: found.rows[0].id, to: [], subject: "", instruction: "say yes", current: "" }, { fetchImpl });
    const text = `${prompts[0].system}\n${prompts[0].user}`;
    assert.match(text, /About Mark Ridgeon, the business Mark writes for/);
    assert.match(text, /RIDGEON VOICE/);
    assert.match(text, /RIDGEON TITLE/);
    for (const leak of [/ECLIPSE OFFER/, /ECLIPSE VOICE/, /ECLIPSE TITLE/, /piece/]) assert.doesNotMatch(text, leak);
  });

  it("prepares a consulting reply as Mark Ridgeon, with only that workspace's voice, notes, people, About you and no Eclipse link", async () => {
    const { fetchImpl, prompts } = model(() => ({ needsReply: true, meeting: true, body: "Hi Priya,\n\nHappy to talk.\n\n[[times]]\n\nMark" }));
    const report = await prepareMail(eclipse, { deadline: Date.now() + 60_000, fetchImpl });
    assert.equal(report.prepared, 1);
    const reply = prompts.find((prompt) => prompt.system.includes("You prepare email replies"));
    assert.ok(reply);
    const text = `${reply.system}\n${reply.user}`;
    assert.match(text, /About Mark Ridgeon, the business/);
    assert.match(text, /RIDGEON OFFER/);
    assert.match(text, /RIDGEON VOICE/);
    assert.match(text, /RIDGEON NOTE/);
    assert.match(text, /RIDGEON TITLE/);
    assert.match(text, /RIDGEON CALL NOTE/);
    assert.match(text, /RIDGEON ABOUT/);
    assert.match(text, /SHARED WRITING/);
    for (const leak of [/ECLIPSE OFFER/, /About Eclipse/, /ECLIPSE VOICE/, /ECLIPSE NOTE/, /ECLIPSE TITLE/, /ECLIPSE CALL NOTE/, /ECLIPSE ABOUT/, /Founder, Eclipse/, /\/book\/mark/, /Fractional COO\nridgeon\.me/, /piece/]) {
      assert.doesNotMatch(text, leak);
    }
    const stored = await getAdminPool().query<{ workspace_id: string; body: string }>("select workspace_id, body from crm.mail_prepared where kind = 'reply'");
    assert.equal(stored.rows.length, 1);
    assert.equal(stored.rows[0].workspace_id, ridgeon.workspaceId);
    assert.doesNotMatch(stored.rows[0].body, /\/book\//);
  });

  it("keeps About you to each workspace, shares only the You card, and leaks nothing into a workspace without one", async () => {
    const here = await getPersonalContext(eclipse);
    assert.deepEqual([here.jobTitle, here.about, here.writing], ["Founder, Eclipse", "ECLIPSE ABOUT I run Eclipse and Ridgeon Consultancy.", "SHARED WRITING Short lines."]);
    assert.match(aboutWriterNote(here, "Mark"), /Mark's role: Founder, Eclipse\.\nAbout Mark: ECLIPSE ABOUT[^\n]*\nThis is for Eclipse\. If it mentions another business of theirs, don't sell, name or cite that business here\.\nHow Mark writes: SHARED WRITING/);
    const there = await getPersonalContext(ridgeon);
    assert.deepEqual([there.jobTitle, there.about, there.writing], ["Fractional COO", "RIDGEON ABOUT Fractional COO for scale-ups.", "SHARED WRITING Short lines."]);
    const section = aboutYouSection(there);
    assert.match(section, /Role: Fractional COO\n\nAbout them, in their own words:\nRIDGEON ABOUT[^\n]*\nThis is for Mark Ridgeon\./);
    assert.doesNotMatch(section, /ECLIPSE ABOUT|Founder, Eclipse/);

    await saveAboutYou(ridgeon, { jobTitle: "", about: "" });
    const empty = await getPersonalContext(ridgeon);
    assert.deepEqual([empty.jobTitle, empty.about], ["", ""]);
    for (const text of [aboutWriterNote(empty, "Mark"), aboutYouSection(empty)]) {
      assert.doesNotMatch(text, /ECLIPSE ABOUT|Founder, Eclipse|This is for/);
      assert.match(text, /SHARED WRITING/);
    }
    assert.equal((await getPersonalContext(eclipse)).about, "ECLIPSE ABOUT I run Eclipse and Ridgeon Consultancy.");
    await saveAboutYou(ridgeon, { jobTitle: "Fractional COO", about: "RIDGEON ABOUT Fractional COO for scale-ups." });
  });

  it("reads the workspace's own About you when learning, and none from another workspace", async () => {
    const admin = getAdminPool();
    const run = model(() => ({ add: [], update: [], archive: [] }));
    const conversation = await admin.query<{ id: string }>(
      "insert into crm.assistant_conversations (workspace_id, user_id, title, model, reasoning) values ($1, $2, 'Plan', 'claude-sonnet-5-5', 'medium') returning id",
      [ridgeon.workspaceId, ridgeon.userId],
    );
    await admin.query("insert into crm.assistant_messages (conversation_id, workspace_id, user_id, role, content) values ($1, $2, $3, 'user', 'Keep consulting emails short.')", [
      conversation.rows[0].id,
      ridgeon.workspaceId,
      ridgeon.userId,
    ]);
    await learnNow(ridgeon, { kinds: ["personal"], deadline: Date.now() + 600_000, fetchImpl: run.fetchImpl });
    const personal = run.prompts.find((prompt) => prompt.system.includes("long-term memory"));
    assert.ok(personal);
    assert.match(personal.user, /What Mark Ridgeon wrote in About you: RIDGEON ABOUT/);
    assert.doesNotMatch(personal.user, /ECLIPSE ABOUT/);
  });

  it("sends a new email from the address homed in the workspace, and shows it on the card", async () => {
    assert.equal((await defaultSender(ridgeon))?.email, CONSULTING);
    assert.equal((await defaultSender(eclipse))?.email, MAIN);
    assert.equal((await resolveSendAccount(ridgeon, null)).email, CONSULTING);
    const settings = (await runTool(ridgeon, "get_settings", {})) as { defaultEmailFrom: string };
    assert.equal(settings.defaultEmailFrom, CONSULTING);
    const args = { to: ["tom@client.test"], subject: "Plan", body: "Hi Tom" };
    const names = await recordNames(ridgeon, [args], ["send_email"]);
    assert.ok(describeAction("send_email", args, names).lines.includes(`From: ${CONSULTING}`));
    const links = await userLinks(ridgeon);
    assert.equal(links.defaultFrom, CONSULTING);
  });

  it("keeps one booking page per workspace and never offers another workspace's link", async () => {
    assert.equal((await getBookingPage(ridgeon)).exists, false);
    assert.equal((await userLinks(ridgeon)).booking, null);
    assert.match((await userLinks(eclipse)).booking!.url, /\/book\/mark$/);
    assert.equal((await checkSlugAvailable(ridgeon, "mark")).available, false);
    assert.equal((await checkSlugAvailable(eclipse, "mark")).available, true);
    await saveBookingPage(ridgeon, { slug: "mark-ridgeon", enabled: true, durationMinutes: 45, bufferMinutes: 10, minNoticeMinutes: 240, horizonDays: 21, weeklyHours: DEFAULT_WEEKLY_HOURS });
    assert.match((await userLinks(ridgeon)).booking!.url, /\/book\/mark-ridgeon$/);
    assert.equal((await getBookingPage(eclipse)).slug, "mark");
    await assert.rejects(
      saveBookingPage(ridgeon, { slug: "mark", enabled: true, durationMinutes: 45, bufferMinutes: 10, minNoticeMinutes: 240, horizonDays: 21, weeklyHours: DEFAULT_WEEKLY_HOURS }),
      /That link is taken/,
    );
  });

  it("writes a morning brief in each workspace on the same day", async () => {
    const admin = getAdminPool();
    for (const actor of [eclipse, ridgeon]) {
      await admin.query("insert into crm.memories (workspace_id, user_id, scope, kind, title, body) values ($1, null, 'business', 'fact', $2, $2)", [
        actor.workspaceId,
        `${actor.workspaceName} learned something new`,
      ]);
    }
    const { fetchImpl } = model((system) => ({ brief: `### What Orbit learned\n- ${system.includes("Mark Ridgeon's CRM") ? "Ridgeon" : "Eclipse"} brief.` }));
    for (const actor of [eclipse, ridgeon]) await learnNow(actor, { kinds: ["brief"], deadline: Date.now() + 600_000, fetchImpl });
    const rows = await admin.query<{ workspace_id: string; day: string }>("select workspace_id, day::text from crm.daily_briefs where user_id = $1", [eclipse.userId]);
    assert.equal(rows.rows.length, 2);
    assert.equal(new Set(rows.rows.map((row) => row.day)).size, 1);
    assert.match((await latestBrief(eclipse))!.body, /Eclipse brief/);
    assert.match((await latestBrief(ridgeon))!.body, /Ridgeon brief/);
  });

  it("keeps notes about a business to their workspace", async () => {
    const icp = await rememberNote(ridgeon, { body: "Scale-ups buy a 90 day plan first", kind: "icp", allWorkspaces: true });
    assert.equal(icp.allWorkspaces, false);
    const named = await rememberNote(ridgeon, { body: "Keep Eclipse emails under 90 words", kind: "preference", allWorkspaces: true });
    assert.equal(named.allWorkspaces, false);
    const general = await rememberNote(ridgeon, { body: "Prefers plain words", kind: "preference", allWorkspaces: true });
    assert.equal(general.allWorkspaces, true);
    const fact = await rememberNote(ridgeon, { body: "Mark Ridgeon works from Lisbon in March", kind: "fact", allWorkspaces: true });
    assert.equal(fact.allWorkspaces, true, "the person's own name isn't a business, even when a workspace is called that");

    const args = { body: "Always offer the Eclipse demo first", kind: "instruction", allWorkspaces: true };
    const names = await recordNames(ridgeon, [args], ["remember"]);
    const card = describeAction("remember", args, names).lines;
    assert.ok(card.includes("This workspace"));
    assert.ok(!card.includes("All workspaces"));
    const kept = (await runTool(ridgeon, "remember", args)) as { memory: { allWorkspaces: boolean }; note?: string };
    assert.equal(kept.memory.allWorkspaces, false);
    assert.match(kept.note ?? "", /Kept to Mark Ridgeon only/);
    const plain = { body: "Likes short answers", kind: "preference", allWorkspaces: true };
    assert.ok(describeAction("remember", plain, await recordNames(ridgeon, [plain], ["remember"])).lines.includes("All workspaces"));
  });

  it("keeps the nightly sort from spreading notes about a business", async () => {
    const admin = getAdminPool();
    await admin.query("delete from crm.memories where scope = 'personal'");
    const titles = { "ICP is scale-ups": "icp", "Eclipse demo goes first": "preference", "Writes in UK English": "fact" } as const;
    for (const [title, kind] of Object.entries(titles)) {
      await admin.query("insert into crm.memories (workspace_id, user_id, scope, kind, title, body) values ($1, $2, 'personal', $3, $4, $4)", [ridgeon.workspaceId, eclipse.userId, kind, title]);
    }
    const ids = await admin.query<{ id: string }>("select id from crm.memories where scope = 'personal'");
    const { fetchImpl } = model(() => ({ notes: ids.rows.map((row) => ({ id: row.id, allWorkspaces: true })) }));
    await sortPersonalMemories(ridgeon, { deadline: Date.now() + 60_000, fetchImpl });
    const rows = await admin.query<{ title: string; all_workspaces: boolean }>("select title, all_workspaces from crm.memories where scope = 'personal' order by title");
    assert.deepEqual(Object.fromEntries(rows.rows.map((row) => [row.title, row.all_workspaces])), {
      "Eclipse demo goes first": false,
      "ICP is scale-ups": false,
      "Writes in UK English": true,
    });
  });
});
