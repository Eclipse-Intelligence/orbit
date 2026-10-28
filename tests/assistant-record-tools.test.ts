import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { describeAction, recordNames, runTool } from "@/lib/assistant/tools";
import { createBoard } from "@/lib/crm/boards";
import { createCompany, getCompany } from "@/lib/crm/companies";
import { withActor } from "@/lib/crm/context";
import { createContact, getContact } from "@/lib/crm/contacts";
import { saveMailbox } from "@/lib/crm/inbox";
import { storeGrantedScopes } from "@/lib/crm/calendar";
import { createOpportunity, getOpportunity } from "@/lib/crm/opportunities";
import { createTask, getTask } from "@/lib/crm/tasks";
import type { UserActor } from "@/lib/crm/types";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { createProduct, listProducts } from "@/lib/proposals/catalogue";
import { createUser, resetDatabase } from "./helpers";

const ENRICHMENT_KEYS = ["CONTEXT_DEV_API_KEY", "HUNTER_API_KEY", "ENROW_API_KEY", "ICYPEAS_API_KEY"];

async function withFetch<T>(fetchImpl: typeof fetch, run: () => Promise<T>) {
  const original = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

describe("assistant record tools", () => {
  let owner: UserActor;
  let samId: string;
  let acme: string;

  before(async () => {
    await resetDatabase();
    owner = await createUser("records-tools@orbit.test", "Mark Ridgeon");
    const admin = getAdminPool();
    samId = (await admin.query<{ id: string }>("select private.create_local_user('sam@records-tools.test', 'password-123', 'Sam Taylor') as id")).rows[0].id;
    await admin.query("insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, 'member')", [owner.workspaceId, samId]);
    acme = (await createCompany(owner, { name: "Acme", domain: "acme-tools.test" })).body.company.id;
  });

  after(async () => {
    await getPool().end();
  });

  it("finds a missing work email with the first provider that has it, and says when nothing is found", async () => {
    const saved = Object.fromEntries(ENRICHMENT_KEYS.map((key) => [key, process.env[key]]));
    for (const key of ENRICHMENT_KEYS) delete process.env[key];
    process.env.HUNTER_API_KEY = "hunter-test";
    const jane = (await createContact(owner, { firstName: "Jane", lastName: "Doe", companyId: acme })).body.contact.id;
    const omar = (await createContact(owner, { firstName: "Omar", lastName: "Khan", companyId: acme })).body.contact.id;
    const calls: string[] = [];
    const hunter: typeof fetch = async (input) => {
      const url = String(input);
      calls.push(url);
      if (!url.includes("api.hunter.io/v2/email-finder")) return Response.json({ message: "unexpected" }, { status: 404 });
      const found = url.includes("first_name=Jane");
      return Response.json({ data: { email: found ? "jane@acme-tools.test" : null, score: found ? 96 : null, verification: { status: found ? "valid" : null } } });
    };
    try {
      const args = { contactIds: [jane, omar], field: "email" };
      const card = describeAction("find_contact_details", args, await recordNames(owner, [args]));
      assert.equal(card.title, "Find work email for 2 people");
      assert.deepEqual(card.lines, ["People: Jane Doe, Omar Khan", "Uses enrichment credits. Saves what's found to the contact."]);
      assert.equal(describeAction("find_contact_details", { contactIds: [jane], field: "phone" }, await recordNames(owner, [{ contactIds: [jane] }])).title, "Find phone number: Jane Doe");

      const result = (await withFetch(hunter, () => runTool(owner, "find_contact_details", args))) as {
        results: { contactId: string; status: string; message: string; found: string | null; provider: string | null; tried: { provider: string; outcome: string }[] }[];
      };
      const [first, second] = result.results;
      assert.equal(first.status, "found");
      assert.equal(first.found, "jane@acme-tools.test");
      assert.equal(first.provider, "Hunter");
      assert.equal(first.message, "Found Jane Doe's email with Hunter.");
      assert.equal(second.status, "not_found");
      assert.equal(second.found, null);
      assert.equal(second.message, "No email found for Omar Khan.");
      assert.deepEqual(second.tried, [{ provider: "Hunter", outcome: "not_found", detail: null }]);
      assert.equal((await getContact(owner, jane)).email, "jane@acme-tools.test");
      assert.equal((await getContact(owner, omar)).email, null);
      assert.equal(calls.length, 2);
    } finally {
      for (const key of ENRICHMENT_KEYS) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    }
  });

  it("checks the people to look up before spending the hourly lookup budget", async () => {
    const spent = async () =>
      (await getAdminPool().query<{ request_count: number }>("select request_count from private.rate_limit_buckets where bucket_key = $1", [`enrich:${owner.userId}`])).rows[0]
        ?.request_count ?? 0;
    const before = await spent();
    assert.deepEqual(await runTool(owner, "find_contact_details", { contactIds: ["nope", "not-an-id"], field: "email" }), { error: "Say who, using contact ids." });
    const seven = Array.from({ length: 7 }, () => randomUUID());
    assert.deepEqual(await runTool(owner, "find_contact_details", { contactIds: seven, field: "email" }), { error: "Look up at most 6 people at a time." });
    const card = describeAction("find_contact_details", { contactIds: [seven[0], seven[0], "nope"], field: "email" });
    assert.equal(card.title, "Find work email: Unknown record");
    assert.equal(await spent(), before);
  });

  it("archives companies, people and opportunities, naming them on the card", async () => {
    const old = (await createCompany(owner, { name: "Old Co", domain: "old-co.test" })).body.company.id;
    const person = (await createContact(owner, { firstName: "Pat", lastName: "Lee", email: "pat@old-co.test", companyId: old })).body.contact.id;
    const deal = (await createOpportunity(owner, { companyId: old, name: "Old Co renewal" })).body.opportunity.id;
    const args = { companyIds: [old], contactIds: [person], opportunityIds: [deal] };
    assert.deepEqual(describeAction("archive_records", args, await recordNames(owner, [args])), {
      title: "Archive 3 records",
      lines: ["Companies: Old Co", "People: Pat Lee", "Opportunities: Old Co renewal", "Nothing is deleted."],
    });
    const result = (await runTool(owner, "archive_records", args)) as { archived: number; failed: unknown[] };
    assert.deepEqual(result, { archived: 3, failed: [] });
    assert.ok((await getCompany(owner, old)).archivedAt);
    assert.ok((await getContact(owner, person)).archivedAt);
    assert.ok((await getOpportunity(owner, deal)).archivedAt);
    const audit = await getAdminPool().query<{ event_type: string; source: string }>(
      "select event_type, source from crm.audit_events where entity_id = any($1::uuid[]) and event_type like '%.archived' order by event_type",
      [[old, person, deal]],
    );
    assert.deepEqual(audit.rows, [
      { event_type: "company.archived", source: "assistant" },
      { event_type: "contact.archived", source: "assistant" },
      { event_type: "opportunity.archived", source: "assistant" },
    ]);
  });

  it("only takes board cards off a board, never sales opportunities", async () => {
    const deal = (await createOpportunity(owner, { companyId: acme, name: "Acme pilot" })).body.opportunity.id;
    const refused = (await runTool(owner, "remove_from_board", { cardId: deal })) as { error: string };
    assert.match(refused.error, /sales opportunity, not a board card/);
    assert.equal((await getOpportunity(owner, deal)).archivedAt, null);
    const board = await createBoard(owner, { name: "Onboarding" });
    const card = (await createOpportunity(owner, { pipelineId: board.id, companyId: acme })).body.opportunity.id;
    const removed = (await runTool(owner, "remove_from_board", { cardId: card })) as { card: { archivedAt: string | null } };
    assert.ok(removed.card.archivedAt);
  });

  it("assigns tasks to a team member and archives a task", async () => {
    const args = { title: "Send the pilot plan", ownerId: samId, sendToClickUp: false };
    const card = describeAction("create_task", args, await recordNames(owner, [args]));
    assert.ok(card.lines.includes("Assignee: Sam Taylor"));
    const created = (await runTool(owner, "create_task", args)) as { task: { id: string; ownerId: string } };
    assert.equal(created.task.ownerId, samId);
    const mine = (await runTool(owner, "create_task", { title: "Book the kickoff", sendToClickUp: false })) as { task: { id: string; ownerId: string } };
    assert.equal(mine.task.ownerId, owner.userId);
    const update = { taskId: mine.task.id, ownerId: samId };
    assert.deepEqual(describeAction("update_task", update, await recordNames(owner, [update])), { title: "Update task: Book the kickoff", lines: ["Assignee: Sam Taylor"] });
    const updated = (await runTool(owner, "update_task", update)) as { task: { ownerId: string } };
    assert.equal(updated.task.ownerId, samId);

    const task = (await createTask(owner, { title: "Old follow up" })).body.task.id;
    assert.equal(describeAction("archive_task", { taskId: task }, await recordNames(owner, [{ taskId: task }])).title, "Archive task: Old follow up");
    const archived = (await runTool(owner, "archive_task", { taskId: task })) as { task: { archivedAt: string | null } };
    assert.ok(archived.task.archivedAt);
    assert.ok((await getTask(owner, task)).archivedAt);
  });

  it("archives a product and brings it back", async () => {
    const product = await createProduct(owner, { name: "Audit", priceGbp: 1200, billing: "one_off" });
    assert.ok(describeAction("save_product", { id: product.id, archived: true }, await recordNames(owner, [{ id: product.id }])).lines.includes("Archive it"));
    await runTool(owner, "save_product", { id: product.id, archived: true });
    assert.ok(!(await listProducts(owner)).some((item) => item.id === product.id));
    await runTool(owner, "save_product", { id: product.id, archived: false });
    assert.ok((await listProducts(owner)).some((item) => item.id === product.id));
  });

  it("cancels a meeting the user organised, naming it and its guests on the card", async () => {
    process.env.MICROSOFT_CLIENT_ID = "test-client";
    process.env.MICROSOFT_CLIENT_SECRET = "test-secret";
    await saveMailbox(owner, { email: "mark@records-tools.test", refreshToken: "refresh", accessToken: "access", expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
    const admin = getAdminPool();
    const connectionId = (await admin.query<{ id: string }>("select id from crm.mailbox_connections where user_id = $1", [owner.userId])).rows[0].id;
    await withActor(owner, (db) => storeGrantedScopes(db, owner, connectionId, "https://graph.microsoft.com/Calendars.ReadWrite offline_access"));
    const calendarId = (
      await admin.query<{ id: string }>(
        `insert into crm.calendars (workspace_id, user_id, connection_id, provider_calendar_id, name, color, is_default, is_visible, use_for_crm, can_edit)
         values ($1, $2, $3, 'cal-main', 'Calendar', '#4f9be8', true, true, true, true) returning id`,
        [owner.workspaceId, owner.userId, connectionId],
      )
    ).rows[0].id;
    const start = new Date(Date.now() + 3 * 24 * 3_600_000);
    const eventId = (
      await admin.query<{ id: string }>(
        `insert into crm.calendar_events (workspace_id, calendar_id, connection_id, user_id, provider_event_id, subject, starts_at, ends_at, organizer, attendees, created_by_orbit)
         values ($1, $2, $3, $4, 'evt-1', 'Acme kickoff', $5, $6, $7::jsonb, $8::jsonb, true) returning id`,
        [
          owner.workspaceId,
          calendarId,
          connectionId,
          owner.userId,
          start,
          new Date(start.getTime() + 30 * 60_000),
          JSON.stringify({ email: "mark@records-tools.test", name: "Mark Ridgeon" }),
          JSON.stringify([{ email: "jane@acme-tools.test", name: "Jane Doe" }, { email: "omar@acme-tools.test" }]),
        ],
      )
    ).rows[0].id;
    const args = { eventId, message: "Something came up." };
    const card = describeAction("cancel_meeting", args, await recordNames(owner, [args]));
    assert.equal(card.title, "Cancel meeting: Acme kickoff");
    assert.ok(card.lines.some((line) => /^When: \w{3} \d{1,2} \w{3}, \d{2}:\d{2}$/.test(line)), card.lines.join("\n"));
    assert.ok(card.lines.includes("Guests: Jane Doe, omar@acme-tools.test"));
    assert.ok(card.lines.includes("Message: Something came up."));
    const posts: { url: string; body: unknown }[] = [];
    const graph: typeof fetch = async (input, init) => {
      const url = String(input);
      if (init?.method === "POST") posts.push({ url, body: JSON.parse(String(init.body ?? "null")) });
      if (url.endsWith("/cancel")) return new Response(null, { status: 202 });
      return Response.json({ error: { code: "NotFound" } }, { status: 404 });
    };
    const result = (await withFetch(graph, () => runTool(owner, "cancel_meeting", args))) as { cancelled: boolean; warning: string | null; loggedOn: number };
    assert.deepEqual(result, { cancelled: true, warning: null, loggedOn: 1 });
    assert.deepEqual(posts, [{ url: "https://graph.microsoft.com/v1.0/me/events/evt-1/cancel", body: { comment: "Something came up." } }]);
    assert.equal((await admin.query<{ is_cancelled: boolean }>("select is_cancelled from crm.calendar_events where id = $1", [eventId])).rows[0].is_cancelled, true);
  });
});
