import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, beforeEach, describe, it } from "node:test";
import { listActivities } from "@/lib/crm/activities";
import { syncCalls } from "@/lib/crm/calls";
import { createCompany } from "@/lib/crm/companies";
import { createContact } from "@/lib/crm/contacts";
import {
  fileImport,
  ignoreImport,
  listUnfiledImports,
  memberActor,
  summarisePendingImports,
  type BackgroundTarget,
} from "@/lib/crm/conversations";
import {
  enableGranolaWebhook,
  GRANOLA_WEBHOOK_UNAVAILABLE,
  handleGranolaWebhook,
  processGranolaWebhook,
  syncGranola,
} from "@/lib/crm/granola";
import { saveMailbox } from "@/lib/crm/inbox";
import {
  cronAuthorization,
  handleCronRequest,
  runScheduledSync,
  syncTargets,
  type SyncTarget,
} from "@/lib/crm/scheduler";
import {
  ensureTranscriptSubscription,
  handleLifecycleRequest,
  handleNotificationRequest,
  syncTeamsTranscripts,
} from "@/lib/crm/teams-transcripts";
import type { UserActor } from "@/lib/crm/types";
import { encryptSecret } from "@/lib/crypto/secret";
import { getAdminPool, getPool } from "@/lib/db/pool";
import {
  granolaTranscriptText,
  signWebhook,
  verifyWebhook,
  type GranolaNote,
  type GranolaTranscriptItem,
} from "@/lib/granola";
import { parseTranscriptResource, TRANSCRIPTS_DISABLED_MESSAGE } from "@/lib/microsoft/transcripts";
import { createUser, resetDatabase } from "./helpers";

const LLM_REPLY = {
  summary: "Mark and Jane went through the proposal and agreed next steps.",
  keyPoints: ["Jane likes the proposal"],
  actionItems: [{ title: "Send the contract", owner: "me", dueDate: null }],
};

before(async () => {
  await resetDatabase();
  process.env.MICROSOFT_CLIENT_ID = "test-client";
  process.env.MICROSOFT_CLIENT_SECRET = "test-secret";
  delete process.env.MICROSOFT_TENANT;
});

beforeEach(() => {
  process.env.LLM_API_KEY = "test-llm-key";
  process.env.GRANOLA_API_KEY = "grn_test_key";
  delete process.env.LLM_API_BASE_URL;
  delete process.env.NEXT_PUBLIC_SITE_URL;
  delete process.env.CRON_SECRET;
});

after(async () => {
  await getPool().end();
});

function llmResponse() {
  return Response.json({
    model: "claude-haiku-5-5",
    choices: [{ message: { role: "assistant", content: JSON.stringify(LLM_REPLY) }, finish_reason: "stop" }],
  });
}

function noteId(n: number) {
  return `not_${"A".repeat(12)}${String(n).padStart(2, "0")}`;
}

function hoursAgo(hours: number) {
  return new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
}

function makeNote(
  id: string,
  owner: UserActor,
  overrides: Partial<GranolaNote> = {},
): GranolaNote {
  return {
    id,
    title: "Proposal review",
    owner: { name: owner.fullName, email: owner.email },
    created_at: hoursAgo(5),
    updated_at: hoursAgo(4),
    deleted_at: null,
    web_url: `https://notes.granola.ai/d/${id}`,
    calendar_event: null,
    attendees: [],
    summary_text: "Summary",
    summary_markdown: "## Summary\n- **Agreed** next steps",
    transcript: [
      { speaker: { source: "microphone", attribution: "me" }, text: "Hi there.", start_time: hoursAgo(5), end_time: hoursAgo(5) },
      { speaker: { source: "speaker", attribution: "them", name: "Guest" }, text: "Hello.", start_time: hoursAgo(5), end_time: hoursAgo(4.9) },
    ],
    ...overrides,
  };
}

type GranolaFake = {
  notes: Map<string, GranolaNote>;
  tooLarge?: Set<string>;
  rateLimited?: number;
  webhookStatus?: number;
  failing?: Set<string>;
};

function granola(state: GranolaFake) {
  const requests: { method: string; url: string; body: string }[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    requests.push({ method, url: url.toString(), body: String(init?.body ?? "") });
    if (url.pathname.endsWith("/chat/completions")) return llmResponse();
    assert.equal(url.origin, "https://public-api.granola.ai");
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer grn_test_key");
    if (url.pathname === "/v1/notes") {
      if (state.rateLimited && state.rateLimited > 0) {
        state.rateLimited -= 1;
        return new Response("{}", { status: 429, headers: { "retry-after": "1" } });
      }
      const all = [...state.notes.values()].sort((a, b) => a.id.localeCompare(b.id));
      const start = Number(url.searchParams.get("cursor") ?? "0");
      const page = all.slice(start, start + 2);
      const more = start + 2 < all.length;
      return Response.json({
        notes: page.map((note) => ({
          id: note.id,
          object: "note",
          title: note.title,
          owner: note.owner,
          created_at: note.created_at,
          updated_at: note.updated_at,
          deleted_at: note.deleted_at,
        })),
        hasMore: more,
        cursor: more ? String(start + 2) : null,
      });
    }
    if (url.pathname === "/v1/webhook-endpoints" && method === "POST") {
      if (state.webhookStatus === 404) return Response.json({ message: "Not found" }, { status: 404 });
      return Response.json(
        {
          id: "whe_ABCDEFGHIJKLMN",
          url: JSON.parse(String(init?.body)).url,
          events: ["note.generated"],
          scopes: ["personal"],
          enabled: true,
          signing_secret: SIGNING_SECRET,
        },
        { status: 201 },
      );
    }
    const transcriptMatch = /^\/v1\/notes\/([^/]+)\/transcript$/.exec(url.pathname);
    if (transcriptMatch) {
      const note = state.notes.get(transcriptMatch[1]);
      const items = note?.transcript ?? [];
      const start = Number(url.searchParams.get("cursor") ?? "0");
      const page = items.slice(start, start + 1);
      const more = start + 1 < items.length;
      return Response.json({ transcript: page, hasMore: more, cursor: more ? String(start + 1) : null });
    }
    const noteMatch = /^\/v1\/notes\/([^/]+)$/.exec(url.pathname);
    if (noteMatch) {
      const note = state.notes.get(noteMatch[1]);
      if (state.failing?.has(noteMatch[1])) {
        return Response.json({ message: "Internal error" }, { status: 500 });
      }
      if (!note) return Response.json({ message: "Not found" }, { status: 404 });
      if (url.searchParams.get("include") === "transcript") {
        if (state.tooLarge?.has(note.id)) {
          return Response.json({ code: "TRANSCRIPT_TOO_LARGE" }, { status: 413 });
        }
        return Response.json(note);
      }
      return Response.json({ ...note, transcript: null });
    }
    return Response.json({ message: "Unexpected" }, { status: 500 });
  };
  return { fetchImpl, requests };
}

const SIGNING_SECRET = `whsec_${randomBytes(24).toString("base64")}`;

async function importRows(workspaceId: string) {
  const result = await getAdminPool().query<{
    external_id: string;
    status: string;
    contact_id: string | null;
    company_id: string | null;
    activity_id: string | null;
    transcript: string | null;
    source_summary: string | null;
    title: string | null;
    participants: { name: string | null; email: string | null }[];
    id: string;
  }>(
    `select id, external_id, status, contact_id, company_id, activity_id, transcript,
            source_summary, title, participants
     from crm.conversation_imports where workspace_id = $1 order by external_id`,
    [workspaceId],
  );
  return new Map(result.rows.map((row) => [row.external_id, row]));
}

describe("granola transcripts", () => {
  let owner: UserActor;
  let janeId: string;
  let acmeId: string;
  let globexId: string;
  const notes = new Map<string, GranolaNote>();

  before(async () => {
    owner = await createUser("mark@orbit.test", "Mark Ridgeon");
    await createUser("someone-else@orbit.test", "Other Person");
    const acme = await createCompany(owner, { name: "Acme", domain: "acme.com" });
    acmeId = acme.body.company.id;
    const globex = await createCompany(owner, { name: "Globex", domain: "globex.com" });
    globexId = globex.body.company.id;
    await createCompany(owner, { name: "Gmail Holdings", domain: "gmail.com" });
    const jane = await createContact(owner, {
      companyId: acmeId,
      firstName: "Jane",
      lastName: "Doe",
      email: "jane@acme.com",
    });
    janeId = jane.body.contact.id;
    notes.set(
      noteId(1),
      makeNote(noteId(1), owner, {
        title: null,
        calendar_event: {
          event_title: "Acme proposal",
          invitees: [{ email: "jane@acme.com" }, { email: "mark@orbit.test" }],
          organiser: "mark@orbit.test",
          calendar_event_id: "evt-1",
          scheduled_start_time: hoursAgo(6),
          scheduled_end_time: hoursAgo(5),
        },
        attendees: [
          { name: "Mark Ridgeon", email: "mark@orbit.test" },
          { name: "Jane Doe", email: "Jane@Acme.com" },
        ],
        transcript: [
          { speaker: { source: "microphone", attribution: "me" }, text: "Hi Jane.", start_time: hoursAgo(6), end_time: hoursAgo(6) },
          { speaker: { source: "microphone", attribution: "me" }, text: "Thanks for joining.", start_time: hoursAgo(6), end_time: hoursAgo(6) },
          { speaker: { source: "speaker", attribution: "them", name: "Jane Doe" }, text: "Happy to.", start_time: hoursAgo(6), end_time: hoursAgo(6) },
          { speaker: { source: "speaker" }, text: "Bye", start_time: hoursAgo(6), end_time: hoursAgo(5.5) },
        ],
      }),
    );
    notes.set(
      noteId(2),
      makeNote(noteId(2), owner, {
        title: "Globex intro",
        calendar_event: {
          event_title: "Intro",
          invitees: [{ email: "bob@globex.com" }],
          organiser: "mark@orbit.test",
          calendar_event_id: "evt-2",
          scheduled_start_time: hoursAgo(3),
          scheduled_end_time: hoursAgo(2),
        },
      }),
    );
    notes.set(
      noteId(3),
      makeNote(noteId(3), owner, {
        title: "Coffee with a stranger",
        attendees: [{ name: "Stranger", email: "stranger@gmail.com" }],
      }),
    );
    notes.set(
      noteId(4),
      makeNote(noteId(4), owner, {
        title: "Unknown meeting",
        attendees: [{ name: "Nobody", email: "nobody@unknown.org" }],
      }),
    );
    notes.set(noteId(9), { ...makeNote(noteId(9), owner), deleted_at: hoursAgo(1) });
  });

  it("builds transcript text from Granola speakers", () => {
    const items: GranolaTranscriptItem[] = [
      { speaker: { source: "microphone", attribution: "me" }, text: "One", start_time: "", end_time: "" },
      { speaker: { source: "microphone" }, text: " two ", start_time: "", end_time: "" },
      { speaker: { source: "speaker", attribution: "them", name: "Ana" }, text: "Three", start_time: "", end_time: "" },
      { speaker: { source: "speaker", attribution: "them" }, text: "Four", start_time: "", end_time: "" },
      { speaker: { source: "speaker", attribution: "them" }, text: "", start_time: "", end_time: "" },
    ];
    assert.equal(granolaTranscriptText(items, "Mark"), "Mark: One two\nAna: Three\nThem: Four");
    assert.equal(granolaTranscriptText(items.slice(0, 1), null), "Me: One");
  });

  it("polls notes, files matches by email or domain, and leaves the rest unfiled", async () => {
    const { fetchImpl, requests } = granola({ notes });
    const result = await syncGranola({ fetchImpl, force: true, sleep: async () => {} });
    assert.equal(result.error, undefined);
    assert.equal(result.ran, true);
    assert.equal(result.complete, true);
    assert.equal(result.fetched, 4);
    assert.equal(result.filed, 2);
    assert.equal(result.unfiled, 2);
    assert.equal(result.summarised, 2);

    const lists = requests.filter((request) => new URL(request.url).pathname === "/v1/notes");
    assert.ok(lists.length >= 3);
    const first = new URL(lists.find((request) => !new URL(request.url).searchParams.get("cursor") && new URL(request.url).searchParams.get("page_size") === "30")!.url);
    const since = new Date(first.searchParams.get("updated_after")!).getTime();
    assert.ok(Math.abs(Date.now() - 14 * 86_400_000 - since) < 60_000);
    assert.ok(requests.some((request) => new URL(request.url).searchParams.get("cursor") === "2"));

    const rows = await importRows(owner.workspaceId);
    const jane = rows.get(noteId(1))!;
    assert.equal(jane.status, "filed");
    assert.equal(jane.contact_id, janeId);
    assert.equal(jane.company_id, acmeId);
    assert.equal(jane.title, "Acme proposal");
    assert.equal(jane.transcript, "Mark Ridgeon: Hi Jane. Thanks for joining.\nJane Doe: Happy to.\nThem: Bye");
    assert.equal(jane.source_summary, "## Summary\n- **Agreed** next steps");
    assert.deepEqual(jane.participants, [{ name: "Jane Doe", email: "jane@acme.com" }]);

    const activities = await listActivities(owner, { contactId: janeId });
    const meeting = activities.data.find((activity) => activity.id === jane.activity_id)!;
    assert.equal(meeting.type, "meeting");
    assert.equal(meeting.title, "Acme proposal");
    assert.equal(meeting.companyId, acmeId);
    assert.equal(new Date(meeting.occurredAt).getTime(), new Date(notes.get(noteId(1))!.calendar_event!.scheduled_start_time!).getTime());
    assert.match(meeting.body ?? "", /Attendees: Jane Doe <jane@acme\.com>/);
    assert.match(meeting.body ?? "", /Open in Granola: https:\/\/notes\.granola\.ai\/d\//);
    assert.equal(meeting.metadata.externalUrl, `https://notes.granola.ai/d/${noteId(1)}`);

    const globex = rows.get(noteId(2))!;
    assert.equal(globex.status, "filed");
    assert.equal(globex.contact_id, null);
    assert.equal(globex.company_id, globexId);

    assert.equal(rows.get(noteId(3))!.status, "unfiled");
    assert.equal(rows.get(noteId(3))!.company_id, null);
    assert.equal(rows.get(noteId(4))!.status, "unfiled");
    assert.equal(rows.has(noteId(9)), false);

    const insights = await getAdminPool().query<{ source: string; status: string; activity_id: string }>(
      "select source, status, activity_id from crm.call_insights where workspace_id = $1 order by created_at",
      [owner.workspaceId],
    );
    assert.equal(insights.rows.length, 2);
    assert.ok(insights.rows.every((row) => row.source === "granola" && row.status === "ready"));
    assert.ok(insights.rows.some((row) => row.activity_id === jane.activity_id));
  });

  it("does nothing on a re-run or an edit of an imported note", async () => {
    const { fetchImpl, requests } = granola({ notes });
    const before = await getAdminPool().query("select count(*)::int as total from crm.activities");
    const result = await syncGranola({ fetchImpl, force: true });
    assert.equal(result.filed, 0);
    assert.equal(result.unfiled, 0);
    assert.equal(result.skipped, 4);
    assert.equal(requests.filter((request) => /\/v1\/notes\/not_/.test(request.url)).length, 0);
    const since = new URL(requests.find((request) => new URL(request.url).searchParams.has("updated_after"))!.url).searchParams.get("updated_after")!;
    assert.ok(Date.now() - new Date(since).getTime() < 2 * 60 * 60 * 1000);

    await processGranolaWebhook(owner, noteId(1), { fetchImpl });
    const after = await getAdminPool().query("select count(*)::int as total from crm.activities");
    assert.equal(after.rows[0].total, before.rows[0].total);
    assert.equal(requests.filter((request) => /\/v1\/notes\/not_/.test(request.url)).length, 0);
  });

  it("pages a transcript that is too large and backs off when rate limited", async () => {
    notes.set(
      noteId(5),
      makeNote(noteId(5), owner, {
        title: "Long Acme workshop",
        attendees: [{ name: "Jane Doe", email: "jane@acme.com" }],
        transcript: [
          { speaker: { source: "speaker", attribution: "them", name: "Jane Doe" }, text: "Part one.", start_time: hoursAgo(2), end_time: hoursAgo(2) },
          { speaker: { source: "speaker", attribution: "them", name: "Jane Doe" }, text: "Part two.", start_time: hoursAgo(2), end_time: hoursAgo(2) },
          { speaker: { source: "microphone", attribution: "me" }, text: "Thanks.", start_time: hoursAgo(2), end_time: hoursAgo(1.5) },
        ],
      }),
    );
    const sleeps: number[] = [];
    const { fetchImpl, requests } = granola({ notes, tooLarge: new Set([noteId(5)]), rateLimited: 2 });
    const result = await syncGranola({
      fetchImpl,
      force: true,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    assert.equal(result.error, undefined);
    assert.equal(result.filed, 1);
    assert.deepEqual(sleeps, [1000, 1000]);
    assert.equal(requests.filter((request) => request.url.includes(`/v1/notes/${noteId(5)}/transcript`)).length, 3);
    const rows = await importRows(owner.workspaceId);
    assert.equal(rows.get(noteId(5))!.transcript, "Jane Doe: Part one. Part two.\nMark Ridgeon: Thanks.");
    assert.equal(rows.get(noteId(5))!.contact_id, janeId);
  });

  it("registers a webhook and verifies Standard Webhooks signatures", async () => {
    const missing = granola({ notes, webhookStatus: 404 });
    const unavailable = await enableGranolaWebhook(owner, "https://orbit.test", { fetchImpl: missing.fetchImpl });
    assert.deepEqual(unavailable, { enabled: false, message: GRANOLA_WEBHOOK_UNAVAILABLE });

    process.env.NEXT_PUBLIC_SITE_URL = "https://orbit.example.com/inbox";
    const { fetchImpl, requests } = granola({ notes });
    const enabled = await enableGranolaWebhook(owner, "http://localhost:4173", { fetchImpl });
    assert.equal(enabled.enabled, true);
    const created = requests.find((request) => request.method === "POST")!;
    assert.deepEqual(JSON.parse(created.body), {
      url: "https://orbit.example.com/api/granola/webhook",
      scopes: ["personal"],
      events: ["note.generated"],
    });
    const stored = await getAdminPool().query<{ webhook_id: string; webhook_secret: string }>(
      "select webhook_id, webhook_secret from crm.integration_state where workspace_id = $1 and source = 'granola'",
      [owner.workspaceId],
    );
    assert.equal(stored.rows[0].webhook_id, "whe_ABCDEFGHIJKLMN");
    assert.notEqual(stored.rows[0].webhook_secret, SIGNING_SECRET);
    assert.match(stored.rows[0].webhook_secret, /^v1\./);
    const again = await enableGranolaWebhook(owner, "http://localhost:4173", { fetchImpl });
    assert.equal(again.message, "Instant Granola sync is already on.");

    const now = Date.now();
    const timestamp = String(Math.floor(now / 1000));
    const body = JSON.stringify({ type: "note.generated", data: { id: noteId(6) } });
    const signature = `v1,${signWebhook(SIGNING_SECRET, "msg_1", timestamp, body)}`;
    assert.equal(verifyWebhook({ secret: SIGNING_SECRET, id: "msg_1", timestamp, signature, body, now }), true);
    assert.equal(
      verifyWebhook({ secret: SIGNING_SECRET, id: "msg_1", timestamp, signature: `v1,bad v1,${signature.slice(3)}`, body, now }),
      true,
    );
    assert.equal(verifyWebhook({ secret: SIGNING_SECRET, id: "msg_1", timestamp, signature: "v1,AAAA", body, now }), false);
    assert.equal(verifyWebhook({ secret: SIGNING_SECRET, id: "msg_2", timestamp, signature, body, now }), false);
    const stale = String(Math.floor(now / 1000) - 6 * 60);
    const staleSignature = `v1,${signWebhook(SIGNING_SECRET, "msg_1", stale, body)}`;
    assert.equal(verifyWebhook({ secret: SIGNING_SECRET, id: "msg_1", timestamp: stale, signature: staleSignature, body, now }), false);

    notes.set(
      noteId(6),
      makeNote(noteId(6), owner, { attendees: [{ name: "Jane Doe", email: "jane@acme.com" }] }),
    );
    const request = (sig: string, ts: string) =>
      new Request("https://orbit.example.com/api/granola/webhook", {
        method: "POST",
        headers: { "webhook-id": "msg_1", "webhook-timestamp": ts, "webhook-signature": sig },
        body,
      });
    const scheduled: (() => Promise<unknown>)[] = [];
    const schedule = (task: () => Promise<unknown>) => {
      scheduled.push(task);
    };
    const upstream = requests.length;
    const bad = await handleGranolaWebhook(request("v1,AAAA", timestamp), { fetchImpl, schedule });
    assert.equal(bad.status, 401);
    const unsigned = await handleGranolaWebhook(
      new Request("https://orbit.example.com/api/granola/webhook", { method: "POST", body }),
      { fetchImpl, schedule },
    );
    assert.equal(unsigned.status, 401);
    assert.equal(requests.length, upstream);
    const old = await handleGranolaWebhook(request(staleSignature, stale), { fetchImpl, schedule });
    assert.equal(old.status, 401);
    assert.equal(scheduled.length, 0);
    const good = await handleGranolaWebhook(request(signature, timestamp), { fetchImpl, schedule });
    assert.equal(good.status, 200);
    assert.equal(scheduled.length, 1);
    await scheduled[0]();
    const rows = await importRows(owner.workspaceId);
    assert.equal(rows.get(noteId(6))?.status, "filed");

    const replay = await handleGranolaWebhook(request(signature, timestamp), { fetchImpl, schedule });
    assert.equal(replay.status, 200);
    assert.deepEqual(await replay.json(), { ok: true, duplicate: true });
    assert.equal(scheduled.length, 1);

    const hintless = JSON.stringify({ type: "note.generated" });
    const hintSignature = `v1,${signWebhook(SIGNING_SECRET, "msg_9", timestamp, hintless)}`;
    const noHint = await handleGranolaWebhook(
      new Request("https://orbit.example.com/api/granola/webhook", {
        method: "POST",
        headers: { "webhook-id": "msg_9", "webhook-timestamp": timestamp, "webhook-signature": hintSignature },
        body: hintless,
      }),
      { fetchImpl, schedule },
    );
    assert.equal(noHint.status, 200);
    assert.equal(scheduled.length, 2);
    await getAdminPool().query(
      "update crm.integration_state set last_attempt_at = now() where workspace_id = $1 and source = 'granola'",
      [owner.workspaceId],
    );
    const beforeHint = requests.length;
    await scheduled[1]();
    assert.equal(requests.filter((item, index) => index >= beforeHint && item.url.includes("/v1/notes")).length, 0);
  });

  it("files an unfiled conversation from the inbox and ignores another", async () => {
    const unfiled = await listUnfiledImports(owner);
    const titles = unfiled.map((item) => item.title).sort();
    assert.deepEqual(titles, ["Coffee with a stranger", "Unknown meeting"]);
    const unknown = unfiled.find((item) => item.title === "Unknown meeting")!;
    assert.equal(unknown.source, "granola");
    assert.match(unknown.sourceSummary ?? "", /Agreed/);
    assert.deepEqual(unknown.participants, [{ name: "Nobody", email: "nobody@unknown.org" }]);

    const { fetchImpl } = granola({ notes });
    const filed = await fileImport(owner, unknown.id, janeId, { fetchImpl });
    const activities = await listActivities(owner, { contactId: janeId });
    const meeting = activities.data.find((activity) => activity.id === filed.activityId)!;
    assert.equal(meeting.type, "meeting");
    assert.equal(meeting.title, "Unknown meeting");
    assert.equal(meeting.companyId, acmeId);
    const rows = await importRows(owner.workspaceId);
    assert.equal(rows.get(noteId(4))!.status, "filed");
    assert.equal(rows.get(noteId(4))!.contact_id, janeId);
    const insight = await getAdminPool().query<{ source: string; status: string }>(
      "select source, status from crm.call_insights where activity_id = $1",
      [filed.activityId],
    );
    assert.deepEqual(insight.rows[0], { source: "granola", status: "ready" });
    await assert.rejects(fileImport(owner, unknown.id, janeId, { summarise: false }), /already filed/);

    const stranger = unfiled.find((item) => item.title === "Coffee with a stranger")!;
    await ignoreImport(owner, stranger.id);
    assert.equal((await importRows(owner.workspaceId)).get(noteId(3))!.status, "ignored");
    assert.deepEqual(await listUnfiledImports(owner), []);

    const outsider = await createUser("outsider@orbit.test", "Outsider");
    await assert.rejects(fileImport(outsider, stranger.id, janeId), /not found/i);
  });

  it("retries a summary left pending by a killed run", async () => {
    const rows = await importRows(owner.workspaceId);
    const globex = rows.get(noteId(2))!;
    const fresh = rows.get(noteId(1))!;
    const admin = getAdminPool();
    await admin.query("alter table crm.call_insights disable trigger call_insights_set_updated_at");
    try {
      await admin.query(
        `update crm.call_insights set status = 'pending', summary = null,
           updated_at = now() - interval '10 minutes' where activity_id = $1`,
        [globex.activity_id],
      );
      await admin.query(
        "update crm.call_insights set status = 'pending', updated_at = now() where activity_id = $1",
        [fresh.activity_id],
      );
    } finally {
      await admin.query("alter table crm.call_insights enable trigger call_insights_set_updated_at");
    }
    const { fetchImpl, requests } = granola({ notes });
    const summarised = await summarisePendingImports(owner, { fetchImpl });
    assert.equal(summarised, 1);
    assert.equal(requests.filter((item) => item.url.endsWith("/chat/completions")).length, 1);
    const insights = await admin.query<{ activity_id: string; status: string }>(
      "select activity_id, status from crm.call_insights where activity_id = any($1::uuid[])",
      [[globex.activity_id, fresh.activity_id]],
    );
    const status = new Map(insights.rows.map((row) => [row.activity_id, row.status]));
    assert.equal(status.get(globex.activity_id!), "ready");
    assert.equal(status.get(fresh.activity_id!), "pending");
  });

  it("does not file internal meetings on your own company or colleagues", async () => {
    const partner = await createUser("partner@mark-home.net", "Partner");
    await getAdminPool().query(
      "insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, 'member')",
      [owner.workspaceId, partner.userId],
    );
    await createCompany(owner, { name: "Orbit Ltd", domain: "orbit.test" });
    await createContact(owner, { firstName: "Ivy", lastName: "Inside", email: "ivy@orbit.test" });
    await createContact(owner, { firstName: "Pat", lastName: "Partner", email: "partner@mark-home.net" });
    notes.set(
      noteId(10),
      makeNote(noteId(10), owner, {
        title: "Team stand-up",
        updated_at: new Date().toISOString(),
        attendees: [
          { name: "Ivy Inside", email: "ivy@orbit.test" },
          { name: "Partner", email: "partner@mark-home.net" },
          { name: "Sam", email: "sam@orbit.test" },
        ],
      }),
    );
    const { fetchImpl } = granola({ notes });
    const result = await syncGranola({ fetchImpl, force: true });
    assert.equal(result.error, undefined);
    const row = (await importRows(owner.workspaceId)).get(noteId(10))!;
    assert.equal(row.status, "unfiled");
    assert.equal(row.contact_id, null);
    assert.equal(row.company_id, null);
  });

  it("records a note that keeps failing, moves the watermark on, and gives up after three tries", async () => {
    notes.set(noteId(11), makeNote(noteId(11), owner, { updated_at: new Date().toISOString() }));
    const state = { notes, failing: new Set([noteId(11)]) };
    const admin = getAdminPool();
    const watermark = async () =>
      (
        await admin.query<{ last_synced_at: Date }>(
          "select last_synced_at from crm.integration_state where workspace_id = $1 and source = 'granola'",
          [owner.workspaceId],
        )
      ).rows[0].last_synced_at.getTime();
    const before = await watermark();
    const first = await syncGranola({ fetchImpl: granola(state).fetchImpl, force: true });
    assert.equal(first.failed, 1);
    assert.match(first.error ?? "", /Granola returned 500/);
    assert.equal(first.complete, true);
    assert.ok((await watermark()) > before);
    let row = (await importRows(owner.workspaceId)).get(noteId(11))!;
    assert.equal(row.status, "pending");
    const attempts = async () =>
      (
        await admin.query<{ attempts: number; error: string }>(
          "select attempts, error from crm.conversation_imports where workspace_id = $1 and external_id = $2",
          [owner.workspaceId, noteId(11)],
        )
      ).rows[0];
    assert.equal((await attempts()).attempts, 1);

    await syncGranola({ fetchImpl: granola(state).fetchImpl, force: true });
    await syncGranola({ fetchImpl: granola(state).fetchImpl, force: true });
    row = (await importRows(owner.workspaceId)).get(noteId(11))!;
    assert.equal(row.status, "unfiled");
    assert.equal((await attempts()).attempts, 3);
    const after = granola(state);
    const last = await syncGranola({ fetchImpl: after.fetchImpl, force: true });
    assert.equal(last.failed, 0);
    assert.equal(after.requests.filter((item) => item.url.includes(`/v1/notes/${noteId(11)}`)).length, 0);
  });
});

function fakeJwt(claims: Record<string, string>) {
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "none", typ: "JWT" })}.${part(claims)}.signature`;
}

const VTT = (speaker: string, line: string) => `WEBVTT

1
00:00:01.000 --> 00:00:03.000
<v Tom Teams>Hello, thanks for calling.</v>

2
00:00:03.000 --> 00:00:05.000
<v ${speaker}>${line}</v>
`;

type GraphState = {
  transcripts: Record<string, unknown>[];
  pstn: Record<string, unknown>[];
  subscription?: { patchStatus?: number };
  transcriptStatus?: number;
};

function graph(state: GraphState) {
  const requests: { method: string; url: string; body: string }[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    requests.push({ method, url, body: String(init?.body ?? "") });
    if (url.includes("/oauth2/v2.0/token")) {
      return Response.json({ access_token: "app-token", expires_in: 3600 });
    }
    if (url.endsWith("/chat/completions")) return llmResponse();
    if (url.includes("getAllTranscripts")) {
      if (state.transcriptStatus) {
        return Response.json(
          { error: { code: "Forbidden", message: "Denied", innerError: { code: "GraphAccessToTranscriptsDisabled" } } },
          { status: state.transcriptStatus },
        );
      }
      return Response.json({ value: state.transcripts });
    }
    if (url.includes("getPstnCalls")) return Response.json({ value: state.pstn });
    if (url.includes("/content?")) {
      const id = /transcripts\/([^/]+)\/content/.exec(url)?.[1] ?? "";
      return new Response(VTT("Jane Doe", `Transcript ${id}.`), { headers: { "content-type": "text/vtt" } });
    }
    const single = /\/adhocCalls\/([^/]+)\/transcripts\/([^/?]+)$/.exec(url);
    if (single) {
      return Response.json({
        id: single[2],
        callId: single[1],
        createdDateTime: hoursAgo(0.5),
        endDateTime: hoursAgo(0.4),
        transcriptContentUrl: `https://graph.microsoft.com/v1.0/users/user-oid-1/adhocCalls/${single[1]}/transcripts/${single[2]}/content`,
      });
    }
    if (url.endsWith("/subscriptions") && method === "POST") {
      const body = JSON.parse(String(init?.body));
      return Response.json({ id: `sub-${requests.length}`, expirationDateTime: body.expirationDateTime }, { status: 201 });
    }
    if (url.includes("/subscriptions/") && method === "PATCH") {
      if (state.subscription?.patchStatus === 404) {
        return Response.json({ error: { code: "ResourceNotFound" } }, { status: 404 });
      }
      return Response.json({ id: url.split("/").pop(), expirationDateTime: JSON.parse(String(init?.body)).expirationDateTime });
    }
    return Response.json({ error: { message: `Unexpected ${url}` } }, { status: 500 });
  };
  return { fetchImpl, requests };
}

function transcript(id: string, callId: string, createdHoursAgo: number) {
  return {
    id,
    callId,
    meetingId: null,
    createdDateTime: hoursAgo(createdHoursAgo),
    endDateTime: hoursAgo(createdHoursAgo - 0.1),
    transcriptContentUrl: `https://graph.microsoft.com/v1.0/users/user-oid-1/adhocCalls/${callId}/transcripts/${id}/content`,
  };
}

describe("teams transcripts", () => {
  let owner: UserActor;
  let janeId: string;
  const state: GraphState = {
    transcripts: [transcript("tr-1", "call-1", 1), transcript("tr-2", "call-2", 72)],
    pstn: [],
  };

  before(async () => {
    owner = await createUser("teams@orbit.test", "Tom Teams");
    const jane = await createContact(owner, {
      firstName: "Jane",
      lastName: "Doe",
      phone: "07700 900123",
    });
    janeId = jane.body.contact.id;
    await saveMailbox(owner, {
      email: "teams@orbit.test",
      refreshToken: "stored-refresh",
      accessToken: fakeJwt({ tid: "tenant-1", oid: "user-oid-1" }),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    });
  });

  it("parses transcript notification resources", () => {
    assert.deepEqual(parseTranscriptResource("users/u-1/adhocCalls/c-1/transcripts/t-1"), {
      userId: "u-1",
      callId: "c-1",
      transcriptId: "t-1",
    });
    assert.deepEqual(parseTranscriptResource("users('u-1')/adhocCalls('c-1')/transcripts('t-1')"), {
      userId: "u-1",
      callId: "c-1",
      transcriptId: "t-1",
    });
    assert.equal(parseTranscriptResource("users/u-1/onlineMeetings/m-1/transcripts/t-1"), null);
  });

  it("keeps a transcript pending until its call is logged, and unfiles old ones", async () => {
    const { fetchImpl, requests } = graph(state);
    const result = await syncTeamsTranscripts(owner, { fetchImpl, force: true });
    assert.equal(result.error, undefined);
    assert.equal(result.imported, 2);
    assert.equal(result.filed, 0);
    assert.equal(result.pending, 1);
    assert.equal(result.unfiled, 1);
    const list = requests.find((request) => request.url.includes("getAllTranscripts"))!;
    assert.match(
      list.url,
      /\/users\/user-oid-1\/adhocCalls\/getAllTranscripts\(userId='user-oid-1',startDateTime=\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ,endDateTime=\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ\)$/,
    );
    const content = requests.find((request) => request.url.includes("/content?"))!;
    assert.match(content.url, /\/content\?\$format=text\/vtt$/);

    let rows = await importRows(owner.workspaceId);
    assert.equal(rows.get("tr-1")!.status, "pending");
    assert.equal(rows.get("tr-1")!.transcript, "Tom Teams: Hello, thanks for calling.\nJane Doe: Transcript tr-1.");
    assert.equal(rows.get("tr-2")!.status, "unfiled");

    state.pstn = [
      {
        id: "pstn-1",
        callId: "call-1",
        userPrincipalName: "teams@orbit.test",
        callType: "user_out",
        calleeNumber: "+447700900123",
        startDateTime: hoursAgo(1),
        duration: 120,
      },
      {
        id: "pstn-2",
        callId: "call-2",
        userPrincipalName: "teams@orbit.test",
        callType: "user_in",
        callerNumber: "+441632960999",
        startDateTime: hoursAgo(72),
        duration: 60,
      },
    ];
    const calls = await syncCalls(owner, { fetchImpl, force: true });
    assert.equal(calls.error, undefined);
    assert.equal(calls.logged, 1);
    assert.equal(calls.transcripts, 1);

    rows = await importRows(owner.workspaceId);
    const filed = rows.get("tr-1")!;
    assert.equal(filed.status, "filed");
    assert.equal(filed.contact_id, janeId);
    const record = await getAdminPool().query<{ activity_id: string; teams_call_id: string }>(
      "select activity_id, teams_call_id from crm.call_records where provider_call_id = 'pstn-1'",
    );
    assert.equal(record.rows[0].teams_call_id, "call-1");
    assert.equal(filed.activity_id, record.rows[0].activity_id);
    const insight = await getAdminPool().query<{ source: string; status: string; transcript: string }>(
      "select source, status, transcript from crm.call_insights where activity_id = $1",
      [filed.activity_id],
    );
    assert.equal(insight.rows[0].source, "teams");
    assert.equal(insight.rows[0].status, "ready");
    assert.match(insight.rows[0].transcript, /Jane Doe: Transcript tr-1\./);

    const again = await syncTeamsTranscripts(owner, { fetchImpl, force: true });
    assert.equal(again.imported, 0);

    const unfiled = await listUnfiledImports(owner);
    assert.equal(unfiled.length, 1);
    assert.equal(unfiled[0].source, "teams");
    const manual = await fileImport(owner, unfiled[0].id, janeId, { fetchImpl });
    const linked = await getAdminPool().query<{ activity_id: string; contact_id: string }>(
      "select activity_id, contact_id from crm.call_records where provider_call_id = 'pstn-2'",
    );
    assert.equal(linked.rows[0].activity_id, manual.activityId);
    assert.equal(linked.rows[0].contact_id, janeId);
    const activity = (await listActivities(owner, { contactId: janeId })).data.find(
      (item) => item.id === manual.activityId,
    )!;
    assert.equal(activity.type, "call");
    assert.equal(activity.title, "Teams call with Jane Doe");
  });

  it("reports when transcript access is turned off", async () => {
    const { fetchImpl } = graph({ ...state, transcriptStatus: 403 });
    const result = await syncTeamsTranscripts(owner, { fetchImpl, force: true });
    assert.equal(result.error, TRANSCRIPTS_DISABLED_MESSAGE);
    const stored = await getAdminPool().query<{ last_error: string }>(
      "select last_error from crm.integration_state where workspace_id = $1 and source = 'teams_transcripts'",
      [owner.workspaceId],
    );
    assert.equal(stored.rows[0].last_error, TRANSCRIPTS_DISABLED_MESSAGE);
  });

  it("creates, renews and recreates the transcript subscription", async () => {
    const { fetchImpl, requests } = graph(state);
    assert.deepEqual(await ensureTranscriptSubscription(owner, { fetchImpl }), { status: "skipped" });
    process.env.NEXT_PUBLIC_SITE_URL = "http://orbit.example.com";
    assert.deepEqual(await ensureTranscriptSubscription(owner, { fetchImpl }), { status: "skipped" });
    process.env.NEXT_PUBLIC_SITE_URL = "https://orbit.example.com";
    const created = await ensureTranscriptSubscription(owner, { fetchImpl });
    assert.equal(created.status, "created");
    const post = requests.find((request) => request.method === "POST" && request.url.endsWith("/subscriptions"))!;
    const body = JSON.parse(post.body);
    assert.equal(body.changeType, "created");
    assert.equal(body.resource, "users/user-oid-1/adhocCalls/getAllTranscripts");
    assert.equal(body.notificationUrl, "https://orbit.example.com/api/microsoft/notifications");
    assert.equal(body.lifecycleNotificationUrl, "https://orbit.example.com/api/microsoft/lifecycle");
    assert.equal(body.includeResourceData, false);
    const hours = (new Date(body.expirationDateTime).getTime() - Date.now()) / 3_600_000;
    assert.ok(hours > 47 && hours <= 48);
    const stored = await getAdminPool().query<{ subscription_id: string; client_state: string }>(
      "select subscription_id, client_state from crm.integration_state where workspace_id = $1 and source = 'teams_transcripts'",
      [owner.workspaceId],
    );
    assert.notEqual(stored.rows[0].client_state, body.clientState);

    const count = requests.length;
    assert.equal((await ensureTranscriptSubscription(owner, { fetchImpl })).status, "active");
    assert.equal(requests.length, count);

    const later = Date.now() + 30 * 60 * 60 * 1000;
    const renewed = await ensureTranscriptSubscription(owner, { fetchImpl, now: later });
    assert.equal(renewed.status, "renewed");
    assert.ok(requests.some((request) => request.method === "PATCH" && request.url.endsWith(`/subscriptions/${stored.rows[0].subscription_id}`)));

    const gone = graph({ ...state, subscription: { patchStatus: 404 } });
    const recreated = await ensureTranscriptSubscription(owner, { fetchImpl: gone.fetchImpl, mode: "renew" });
    assert.equal(recreated.status, "created");
  });

  it("echoes validation tokens and only accepts notifications with the right clientState", async () => {
    const validation = await handleNotificationRequest(
      new Request("https://orbit.example.com/api/microsoft/notifications?validationToken=Validation%3A%20abc", {
        method: "POST",
      }),
    );
    assert.equal(validation.status, 200);
    assert.match(validation.headers.get("content-type") ?? "", /^text\/plain/);
    assert.equal(await validation.text(), "Validation: abc");
    const lifecycleValidation = await handleLifecycleRequest(
      new Request("https://orbit.example.com/api/microsoft/lifecycle?validationToken=xyz", { method: "POST" }),
    );
    assert.equal(await lifecycleValidation.text(), "xyz");

    process.env.NEXT_PUBLIC_SITE_URL = "https://orbit.example.com";
    const { fetchImpl, requests } = graph(state);
    await getAdminPool().query(
      "update crm.integration_state set subscription_id = null where workspace_id = $1 and source = 'teams_transcripts'",
      [owner.workspaceId],
    );
    await ensureTranscriptSubscription(owner, { fetchImpl });
    const post = requests.find((request) => request.method === "POST" && request.url.endsWith("/subscriptions"))!;
    const clientState = JSON.parse(post.body).clientState as string;
    const stored = await getAdminPool().query<{ subscription_id: string }>(
      "select subscription_id from crm.integration_state where workspace_id = $1 and source = 'teams_transcripts'",
      [owner.workspaceId],
    );
    const subscriptionId = stored.rows[0].subscription_id;

    const notify = (value: unknown[]) =>
      new Request("https://orbit.example.com/api/microsoft/notifications", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ value }),
      });
    const scheduled: (() => Promise<unknown>)[] = [];
    const schedule = (task: () => Promise<unknown>) => {
      scheduled.push(task);
    };
    const resource = "users/user-oid-1/adhocCalls/call-3/transcripts/tr-3";
    const rejected = await handleNotificationRequest(
      notify([{ subscriptionId, clientState: "wrong", changeType: "created", resource }]),
      { fetchImpl, schedule },
    );
    assert.equal(rejected.status, 401);
    const unknown = await handleNotificationRequest(
      notify([{ subscriptionId: "sub-unknown", clientState, changeType: "created", resource }]),
      { fetchImpl, schedule },
    );
    assert.equal(unknown.status, 401);
    assert.equal(scheduled.length, 0);

    const accepted = await handleNotificationRequest(
      notify([{ subscriptionId, clientState, changeType: "created", resource }]),
      { fetchImpl, schedule },
    );
    assert.equal(accepted.status, 202);
    assert.equal(scheduled.length, 1);
    await scheduled[0]();
    const rows = await importRows(owner.workspaceId);
    assert.equal(rows.get("tr-3")?.status, "pending");
    assert.match(rows.get("tr-3")?.transcript ?? "", /Transcript tr-3/);

    const lookup = async (ids: string[]) =>
      new Map(ids.map((id) => [id, { actor: owner, clientState: encryptSecret("lifecycle-secret") }]));
    const lifecycle = await handleLifecycleRequest(
      new Request("https://orbit.example.com/api/microsoft/lifecycle", {
        method: "POST",
        body: JSON.stringify({
          value: [{ subscriptionId: "sub-x", clientState: "lifecycle-secret", lifecycleEvent: "missed" }],
        }),
      }),
      { fetchImpl, schedule, lookup },
    );
    assert.equal(lifecycle.status, 202);
    assert.equal(scheduled.length, 2);
  });

  it("caps notification batches and resolves subscriptions in one lookup", async () => {
    const calls: string[][] = [];
    const lookup = async (ids: string[]) => {
      calls.push(ids);
      return new Map();
    };
    const many = Array.from({ length: 51 }, (_, index) => ({
      subscriptionId: `sub-${index}`,
      clientState: "x",
    }));
    const tooMany = await handleNotificationRequest(
      new Request("https://orbit.example.com/api/microsoft/notifications", {
        method: "POST",
        body: JSON.stringify({ value: many }),
      }),
      { lookup },
    );
    assert.equal(tooMany.status, 413);
    assert.equal(calls.length, 0);
    const batch = [
      { subscriptionId: "sub-a", clientState: "x" },
      { subscriptionId: "sub-b", clientState: "y" },
      { subscriptionId: "sub-a", clientState: "z" },
      { clientState: "no id" },
    ];
    const response = await handleNotificationRequest(
      new Request("https://orbit.example.com/api/microsoft/notifications", {
        method: "POST",
        body: JSON.stringify({ value: batch }),
      }),
      { lookup },
    );
    assert.equal(response.status, 401);
    assert.deepEqual(calls, [["sub-a", "sub-b"]]);
    const garbage = await handleNotificationRequest(
      new Request("https://orbit.example.com/api/microsoft/notifications", { method: "POST", body: "{" }),
      { lookup },
    );
    assert.equal(garbage.status, 400);
  });

  it("keeps Teams transcripts private to the mailbox owner and state per mailbox", async () => {
    const colleagueUser = await createUser("colleague@orbit.test", "Cole League");
    await getAdminPool().query(
      "insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, 'member')",
      [owner.workspaceId, colleagueUser.userId],
    );
    const colleague = memberActor({
      workspace_id: owner.workspaceId,
      workspace_name: "Teams workspace",
      user_id: colleagueUser.userId,
      role: "member",
      email: colleagueUser.email,
      full_name: colleagueUser.fullName,
    });
    const { fetchImpl } = graph(state);
    const early = await syncTeamsTranscripts(colleague, { fetchImpl, force: true });
    assert.equal(early.ran, false);
    assert.match(early.error ?? "", /Connect Microsoft/);
    const colleagueState = await getAdminPool().query(
      "select 1 from crm.integration_state where user_id = $1",
      [colleagueUser.userId],
    );
    assert.equal(colleagueState.rowCount, 0);

    state.transcripts = [...state.transcripts, transcript("tr-4", "call-4", 0.5)];
    const ownerRun = await syncTeamsTranscripts(owner, { fetchImpl, force: true });
    assert.equal(ownerRun.error, undefined);
    const rows = await importRows(owner.workspaceId);
    const pendingImport = rows.get("tr-4")!;
    assert.equal(pendingImport.status, "pending");

    assert.equal((await listUnfiledImports(colleague)).filter((item) => item.source === "teams").length, 0);
    await assert.rejects(fileImport(colleague, pendingImport.id, janeId), /not found/i);

    const manual = await fileImport(owner, pendingImport.id, janeId, { fetchImpl });
    const janeCalls = async () =>
      (await listActivities(owner, { contactId: janeId, type: "call" })).total;
    const callsBefore = await janeCalls();
    state.pstn = [
      ...state.pstn,
      {
        id: "pstn-4",
        callId: "call-4",
        userPrincipalName: "teams@orbit.test",
        callType: "user_out",
        calleeNumber: "+447700900123",
        startDateTime: hoursAgo(0.5),
        duration: 30,
      },
    ];
    const calls = await syncCalls(owner, { fetchImpl, force: true });
    assert.equal(calls.error, undefined);
    assert.equal(await janeCalls(), callsBefore);
    const record = await getAdminPool().query<{ activity_id: string }>(
      "select activity_id from crm.call_records where provider_call_id = 'pstn-4'",
    );
    assert.equal(record.rows[0].activity_id, manual.activityId);

    await saveMailbox(colleague, {
      email: "colleague@orbit.test",
      refreshToken: "colleague-refresh",
      accessToken: fakeJwt({ tid: "tenant-1", oid: "user-oid-2" }),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    });
    const ownerState = async () =>
      (
        await getAdminPool().query<{ last_synced_at: Date; connection_id: string }>(
          "select last_synced_at, connection_id from crm.integration_state where user_id = $1 and source = 'teams_transcripts'",
          [owner.userId],
        )
      ).rows[0];
    const ownerBefore = await ownerState();
    const colleagueRun = await syncTeamsTranscripts(colleague, { fetchImpl, force: true });
    assert.equal(colleagueRun.error, undefined);
    assert.equal(colleagueRun.imported, state.transcripts.length);
    const states = await getAdminPool().query<{ user_id: string; connection_id: string }>(
      "select user_id, connection_id from crm.integration_state where workspace_id = $1 and source = 'teams_transcripts'",
      [owner.workspaceId],
    );
    assert.equal(states.rowCount, 2);
    assert.notEqual(states.rows[0].connection_id, states.rows[1].connection_id);
    assert.equal((await ownerState()).last_synced_at.getTime(), ownerBefore.last_synced_at.getTime());
    const ownerRows = await getAdminPool().query(
      "select 1 from crm.conversation_imports where user_id = $1 and source = 'teams'",
      [owner.userId],
    );
    const colleagueRows = await getAdminPool().query(
      "select 1 from crm.conversation_imports where user_id = $1 and source = 'teams'",
      [colleagueUser.userId],
    );
    assert.equal(colleagueRows.rowCount, state.transcripts.length);
    assert.ok((ownerRows.rowCount ?? 0) >= state.transcripts.length);
  });
});

describe("scheduled sync", () => {
  it("requires the cron secret", async () => {
    const run = async () => ({ startedAt: "", durationMs: 0, errors: 0, workspaces: [] });
    const request = (header?: string) =>
      new Request("https://orbit.example.com/api/cron/sync", {
        headers: header ? { authorization: header } : {},
      });
    assert.equal((await handleCronRequest(request("Bearer anything"), run)).status, 503);
    process.env.CRON_SECRET = "cron-secret-value";
    assert.equal((await handleCronRequest(request(), run)).status, 401);
    assert.equal((await handleCronRequest(request("Bearer wrong"), run)).status, 401);
    assert.equal((await handleCronRequest(request("cron-secret-value"), run)).status, 401);
    const ok = await handleCronRequest(request("Bearer cron-secret-value"), run);
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { startedAt: "", durationMs: 0, errors: 0, workspaces: [] });
    assert.equal(cronAuthorization("Bearer x", "x"), "ok");
  });

  it("isolates failing steps and stops starting steps when out of time", async () => {
    const actor = await createUser("cron@orbit.test", "Cron Owner");
    const target: SyncTarget = { actor, mailbox: true, members: [actor], granola: null };
    const ran: string[] = [];
    const steps = [
      {
        name: "mail",
        applies: () => true,
        run: async () => {
          ran.push("mail");
          throw new Error("Mail exploded");
        },
      },
      {
        name: "calls",
        applies: () => true,
        run: async () => {
          ran.push("calls");
          return { ran: true, error: "Calls said no" };
        },
      },
      {
        name: "granola",
        applies: (item: SyncTarget) => Boolean(item.granola),
        run: async () => {
          ran.push("granola");
          return {};
        },
      },
      {
        name: "summaries",
        applies: () => true,
        run: async () => {
          ran.push("summaries");
          return { summarised: 2 };
        },
      },
    ];
    const report = await runScheduledSync({ steps, targets: [target] });
    assert.deepEqual(ran, ["mail", "calls", "summaries"]);
    assert.equal(report.errors, 2);
    const entry = report.workspaces[0];
    assert.deepEqual(entry.steps.mail, { ok: false, error: "Mail exploded" });
    assert.equal(entry.steps.calls.ok, false);
    assert.equal(entry.steps.calls.error, "Calls said no");
    assert.deepEqual(entry.steps.summaries, { summarised: 2, ok: true });
    assert.equal(entry.steps.granola, undefined);

    ran.length = 0;
    const late = await runScheduledSync({ steps, targets: [target], budgetMs: 0 });
    assert.deepEqual(ran, []);
    assert.equal(late.workspaces[0].steps.mail.skipped, "Out of time for this run.");
  });

  it("builds background actors for mailbox and Granola workspaces", async () => {
    const { fetchImpl } = granola({ notes: new Map() });
    const list = (await syncTargets({ fetchImpl })).targets;
    const byEmail = (email: string) => list.find((target: BackgroundTarget) => target.actor.email === email);
    const teams = byEmail("teams@orbit.test");
    assert.equal(teams?.mailbox, true);
    assert.equal(teams?.actor.role, "owner");
    assert.ok(teams?.actor.scopes.includes("activities:write"));
    const mark = list.find((target) => target.granola?.email === "mark@orbit.test");
    assert.ok(mark);
    assert.equal(byEmail("cron@orbit.test"), undefined);
  });
});
