import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, describe, it } from "node:test";
import { getGranolaStatus, personalGranolaKey, removeGranolaKey, saveGranolaKey } from "@/lib/crm/granola";
import { scopesForRole } from "@/lib/crm/scopes";
import type { UserActor } from "@/lib/crm/types";
import { createWorkspace } from "@/lib/crm/workspaces";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { defaultSender } from "@/lib/mail/compose";
import { listUnknownMail } from "@/lib/mail/capture-filter";
import { listAddressHomes, setAddressHome } from "@/lib/mail/routing";
import { readwiseStatus, readwiseToken, removeReadwiseToken, saveReadwiseToken, setReadwiseWorkspace } from "@/lib/readwise/keys";
import { listMemories } from "@/lib/learning/memories";
import { recallKey, recallStatus, removeRecallKey, saveRecallKey } from "@/lib/recall/keys";
import { createUser, resetDatabase } from "./helpers";

delete process.env.TYPESAFE_API_KEY;
delete process.env.LLM_API_KEY;

const READWISE_TOKEN = "rw_settings_token_0001";
const RECALL_KEY = "sk_settings_recall_key_0001";
const GRANOLA_KEY = "grn_settings_granola_key_0001";

const accepting: typeof fetch = async (input) => {
  const url = String(input);
  if (url.includes("readwise")) return new Response(null, { status: 204 });
  if (url.includes("granola")) return Response.json({ notes: [], hasMore: false, cursor: null });
  return Response.json({ results: [] });
};

function minutesAgo(minutes: number) {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

describe("settings that belong to you or to one workspace", () => {
  let eclipse: UserActor;
  let ridgeon: UserActor;
  let sourceId: string;
  let inbox: string;

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
    const source = await admin.query<{ id: string }>(
      "insert into crm.mail_sources (workspace_id, user_id, connection_id, email) values ($1, $2, $3, 'mark@geteclipse.co') returning id",
      [eclipse.workspaceId, eclipse.userId, connection.rows[0].id],
    );
    sourceId = source.rows[0].id;
    const folder = await admin.query<{ id: string }>(
      "insert into crm.mail_folders (workspace_id, user_id, source_id, provider_folder_id, name, role) values ($1, $2, $3, 'inbox-1', 'Inbox', 'inbox') returning id",
      [eclipse.workspaceId, eclipse.userId, sourceId],
    );
    inbox = folder.rows[0].id;
    await admin.query(
      `insert into crm.send_identities (workspace_id, user_id, source_id, email, smtp_host, smtp_port, username, password_cipher)
       values ($1, $2, $3, 'mark@ridgeon.me', 'smtp.ridgeon.test', 587, 'mark@ridgeon.me', 'cipher')`,
      [eclipse.workspaceId, eclipse.userId, sourceId],
    );
  });

  after(async () => {
    await getPool().end();
    await getAdminPool().end();
  });

  async function unknownTo(actor: UserActor) {
    return (await listUnknownMail(actor)).emails.map((email) => `${email.email}>${email.address}`).sort();
  }

  it("uses one Workspace choice per address for both Capture and the default From", async () => {
    await getAdminPool().query(
      `insert into crm.mail_messages (workspace_id, user_id, source_id, folder_id, provider_message_id, internet_message_id, thread_key, subject, snippet, body_text,
         from_email, from_name, to_recipients, cc_recipients, sent_at, received_at)
       values ($1, $2, $3, $4, 'nina', '<nina@mail.test>', 'nina', 'Intro', 'Intro body', 'Intro body', 'nina@fernleycapital.com', 'Nina Alvarez',
         '[{"name":"","address":"mark@ridgeon.me"}]'::jsonb, '[]'::jsonb, $5, $5)`,
      [eclipse.workspaceId, eclipse.userId, sourceId, inbox, minutesAgo(30)],
    );

    assert.deepEqual(
      (await listAddressHomes(eclipse)).map((home) => [home.address, home.workspaceId === eclipse.workspaceId]),
      [
        ["mark@geteclipse.co", true],
        ["mark@ridgeon.me", true],
      ],
    );
    assert.equal((await defaultSender(eclipse))?.email, "mark@geteclipse.co");
    assert.equal((await defaultSender(ridgeon))?.email, "mark@geteclipse.co");
    assert.deepEqual(await unknownTo(eclipse), ["nina@fernleycapital.com>mark@ridgeon.me"]);
    assert.deepEqual(await unknownTo(ridgeon), []);

    await setAddressHome(eclipse, "mark@ridgeon.me", ridgeon.workspaceId);
    assert.equal((await defaultSender(ridgeon))?.email, "mark@ridgeon.me");
    assert.equal((await defaultSender(eclipse))?.email, "mark@geteclipse.co");
    assert.deepEqual(await unknownTo(eclipse), []);
    assert.deepEqual(await unknownTo(ridgeon), ["nina@fernleycapital.com>mark@ridgeon.me"]);

    await setAddressHome(ridgeon, "mark@ridgeon.me", eclipse.workspaceId);
    assert.equal((await defaultSender(ridgeon))?.email, "mark@geteclipse.co");
    assert.deepEqual(await unknownTo(eclipse), ["nina@fernleycapital.com>mark@ridgeon.me"]);
    assert.deepEqual(await unknownTo(ridgeon), []);
  });

  it("connects Granola, Readwise and Recall once and uses them in every workspace", async () => {
    await saveRecallKey(ridgeon, RECALL_KEY, { fetchImpl: accepting });
    await saveReadwiseToken(ridgeon, READWISE_TOKEN, { fetchImpl: accepting });
    await saveGranolaKey(ridgeon, GRANOLA_KEY, { fetchImpl: accepting });

    for (const actor of [eclipse, ridgeon]) {
      assert.equal((await recallStatus(actor)).connected, true);
      assert.equal(await recallKey(actor), RECALL_KEY);
      const reader = await readwiseStatus(actor);
      assert.equal(reader.connected, true);
      assert.equal(reader.workspaceName, "Eclipse");
      assert.equal(await readwiseToken(actor), READWISE_TOKEN);
      assert.equal((await getGranolaStatus(actor)).personal.connected, true);
      assert.equal(await personalGranolaKey(actor), GRANOLA_KEY);
    }

    const admin = getAdminPool();
    for (const table of ["recall_keys", "readwise_keys", "granola_keys"]) {
      const rows = await admin.query<{ workspace_id: string }>(`select workspace_id from crm.${table} where user_id = $1`, [eclipse.userId]);
      assert.deepEqual(rows.rows.map((row) => row.workspace_id), [eclipse.workspaceId], table);
    }

    await saveRecallKey(eclipse, `${RECALL_KEY}x`, { fetchImpl: accepting });
    assert.equal(await recallKey(ridgeon), `${RECALL_KEY}x`);
    const recallRows = await admin.query("select 1 from crm.recall_keys where user_id = $1", [eclipse.userId]);
    assert.equal(recallRows.rowCount, 1);

    await removeRecallKey(eclipse);
    await removeReadwiseToken(eclipse);
    await removeGranolaKey(eclipse);
    for (const actor of [eclipse, ridgeon]) {
      assert.equal((await recallStatus(actor)).connected, false);
      assert.equal((await readwiseStatus(actor)).connected, false);
      assert.equal((await getGranolaStatus(actor)).personal.connected, false);
    }
  });

  async function keyRows(table: string) {
    const result = await getAdminPool().query<{ workspace_id: string; key_hint: string | null }>(
      `select workspace_id, ${table === "readwise_keys" ? "token_hint" : "key_hint"} as key_hint from crm.${table} where user_id = $1`,
      [eclipse.userId],
    );
    return result.rows;
  }

  async function readwiseKeyWithDocument() {
    const admin = getAdminPool();
    await admin.query("delete from crm.readwise_keys where user_id = $1", [eclipse.userId]);
    const key = await admin.query<{ id: string }>(
      `insert into crm.readwise_keys (workspace_id, user_id, token_cipher, token_hint, updated_after, full_sync_at, scan_cursor, list_cursor, list_done)
       values ($1, $2, 'cipher', 'rw01', now(), now(), 'scan-cursor', 'list-cursor', true) returning id`,
      [eclipse.workspaceId, eclipse.userId],
    );
    await admin.query("insert into crm.readwise_documents (key_id, workspace_id, user_id, document_id) values ($1, $2, $3, 'doc-1')", [
      key.rows[0].id,
      eclipse.workspaceId,
      eclipse.userId,
    ]);
    return key.rows[0].id;
  }

  async function readwiseState() {
    const admin = getAdminPool();
    const key = await admin.query<{ workspace_id: string; updated_after: Date | null; full_sync_at: Date | null; scan_cursor: string | null; list_cursor: string | null; list_done: boolean }>(
      "select workspace_id, updated_after, full_sync_at, scan_cursor, list_cursor, list_done from crm.readwise_keys where user_id = $1",
      [eclipse.userId],
    );
    const documents = await admin.query("select 1 from crm.readwise_documents where user_id = $1", [eclipse.userId]);
    return { key: key.rows[0], documents: documents.rowCount };
  }

  it("keeps the newest key per person and service when the migration runs again, alongside the old per-workspace constraint", async () => {
    const admin = getAdminPool();
    const sql = readFileSync("supabase/migrations/20270108100000_settings_simplified.sql", "utf8");
    for (const table of ["recall_keys", "readwise_keys", "granola_keys"]) {
      await admin.query(`delete from crm.${table} where user_id = $1`, [eclipse.userId]);
      await admin.query(`alter table crm.${table} drop constraint ${table.replace("_keys", "_keys_user")}`);
    }
    await admin.query(
      `insert into crm.recall_keys (workspace_id, user_id, key_cipher, key_hint, connected_at) values
       ($1, $3, 'old', 'old1', now() - interval '2 days'), ($2, $3, 'new', 'new1', now() - interval '1 day')`,
      [eclipse.workspaceId, ridgeon.workspaceId, eclipse.userId],
    );
    await admin.query(
      `insert into crm.readwise_keys (workspace_id, user_id, token_cipher, token_hint, connected_at) values
       ($1, $3, 'new', 'new1', now() - interval '1 day'), ($2, $3, 'old', 'old1', now() - interval '3 days')`,
      [eclipse.workspaceId, ridgeon.workspaceId, eclipse.userId],
    );
    await admin.query(
      `insert into crm.granola_keys (workspace_id, user_id, key_cipher, key_hint, created_at, updated_at) values
       ($1, $3, 'old', 'old1', now() - interval '1 day', now() - interval '5 days'), ($2, $3, 'new', 'new1', now() - interval '9 days', now() - interval '1 hour')`,
      [eclipse.workspaceId, ridgeon.workspaceId, eclipse.userId],
    );
    await admin.query(sql);
    await admin.query(sql);
    assert.deepEqual(await keyRows("recall_keys"), [{ workspace_id: ridgeon.workspaceId, key_hint: "new1" }]);
    assert.deepEqual(await keyRows("readwise_keys"), [{ workspace_id: eclipse.workspaceId, key_hint: "new1" }]);
    assert.deepEqual(await keyRows("granola_keys"), [{ workspace_id: ridgeon.workspaceId, key_hint: "new1" }]);
    const constraints = await admin.query<{ conname: string }>(
      "select conname from pg_constraint where conname in ('recall_keys_owner', 'recall_keys_user', 'readwise_keys_owner', 'readwise_keys_user', 'granola_keys_owner', 'granola_keys_user') order by conname",
    );
    assert.deepEqual(
      constraints.rows.map((row) => row.conname),
      ["granola_keys_owner", "granola_keys_user", "readwise_keys_owner", "readwise_keys_user", "recall_keys_owner", "recall_keys_user"],
    );
    await admin.query(
      `insert into crm.recall_keys (workspace_id, user_id, key_cipher) values ($1, $2, 'same')
       on conflict (workspace_id, user_id) do update set key_cipher = excluded.key_cipher`,
      [ridgeon.workspaceId, eclipse.userId],
    );
    await assert.rejects(
      admin.query("insert into crm.recall_keys (workspace_id, user_id, key_cipher) values ($1, $2, 'again')", [eclipse.workspaceId, eclipse.userId]),
      /recall_keys_user/,
    );
    for (const table of ["recall_keys", "readwise_keys", "granola_keys"]) await admin.query(`delete from crm.${table} where user_id = $1`, [eclipse.userId]);
  });

  it("moves a person's keys with them when they leave the workspace the keys live in, and restarts Readwise there", async () => {
    const admin = getAdminPool();
    await saveRecallKey(eclipse, RECALL_KEY, { fetchImpl: accepting });
    await saveGranolaKey(eclipse, GRANOLA_KEY, { fetchImpl: accepting });
    await readwiseKeyWithDocument();
    await admin.query("select private.move_personal_rows($1, $2, $3)", [eclipse.userId, eclipse.workspaceId, ridgeon.workspaceId]);
    assert.deepEqual((await keyRows("recall_keys")).map((row) => row.workspace_id), [ridgeon.workspaceId]);
    assert.deepEqual((await keyRows("granola_keys")).map((row) => row.workspace_id), [ridgeon.workspaceId]);
    assert.equal(await recallKey(eclipse), RECALL_KEY);
    assert.equal(await personalGranolaKey(eclipse), GRANOLA_KEY);
    const state = await readwiseState();
    assert.equal(state.key.workspace_id, ridgeon.workspaceId);
    assert.deepEqual([state.key.updated_after, state.key.full_sync_at, state.key.scan_cursor, state.key.list_cursor, state.key.list_done], [null, null, null, null, false]);
    assert.equal(state.documents, 0);
    await admin.query("select private.move_personal_rows($1, $2, $3)", [eclipse.userId, ridgeon.workspaceId, eclipse.workspaceId]);
    await removeRecallKey(eclipse);
    await removeGranolaKey(eclipse);
  });

  it("lets someone in two workspaces choose where Readwise adds to Knowledge", async () => {
    await readwiseKeyWithDocument();
    assert.equal((await readwiseStatus(ridgeon)).workspaceId, eclipse.workspaceId);
    await assert.rejects(setReadwiseWorkspace(ridgeon, "00000000-0000-4000-8000-000000000000"), /Choose a workspace you're in/);
    assert.deepEqual(await setReadwiseWorkspace(eclipse, eclipse.workspaceId), { workspaceId: eclipse.workspaceId, moved: false });
    assert.equal((await readwiseState()).documents, 1);
    assert.deepEqual(await setReadwiseWorkspace(eclipse, ridgeon.workspaceId), { workspaceId: ridgeon.workspaceId, moved: true });
    const state = await readwiseState();
    assert.equal(state.key.workspace_id, ridgeon.workspaceId);
    assert.deepEqual([state.key.updated_after, state.key.full_sync_at, state.key.scan_cursor, state.key.list_cursor, state.key.list_done], [null, null, null, null, false]);
    assert.equal(state.documents, 0);
    for (const actor of [eclipse, ridgeon]) {
      const status = await readwiseStatus(actor);
      assert.equal(status.workspaceId, ridgeon.workspaceId);
      assert.equal(status.workspaceName, "Mark Ridgeon");
    }
    await removeReadwiseToken(eclipse);
  });

  it("lists your own notes from every workspace for Memory, never someone else's or shared ones", async () => {
    const admin = getAdminPool();
    const priya = await createUser("priya@geteclipse.co", "Priya Shah");
    await admin.query("insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, 'member')", [eclipse.workspaceId, priya.userId]);
    await admin.query(
      `insert into crm.memories (workspace_id, user_id, scope, kind, title, body, all_workspaces) values
       ($1, $3, 'personal', 'preference', 'Mine everywhere', 'Mine everywhere', true),
       ($2, $3, 'personal', 'preference', 'Mine in Ridgeon', 'Mine in Ridgeon', false),
       ($1, $3, 'personal', 'preference', 'Mine in Eclipse', 'Mine in Eclipse', false),
       ($1, $4, 'personal', 'preference', 'Priya only', 'Priya only', true),
       ($1, null, 'business', 'icp', 'Shared business', 'Shared business', null),
       ($2, null, 'market', 'theme', 'Shared market', 'Shared market', null)`,
      [eclipse.workspaceId, ridgeon.workspaceId, eclipse.userId, priya.userId],
    );
    for (const actor of [eclipse, ridgeon]) {
      const titles = (await listMemories(actor, { scope: "personal", allWorkspaces: true, limit: 200 })).map((memory) => memory.title).sort();
      assert.deepEqual(titles, ["Mine everywhere", "Mine in Eclipse", "Mine in Ridgeon"]);
    }
    const everything = (await listMemories(eclipse, { allWorkspaces: true, limit: 200 })).map((memory) => memory.title);
    assert.equal(everything.includes("Shared business"), false);
    assert.equal(everything.includes("Priya only"), false);
    const here = (await listMemories(ridgeon, { scope: "personal", limit: 200 })).map((memory) => memory.title).sort();
    assert.deepEqual(here, ["Mine everywhere", "Mine in Ridgeon"]);
    const places = (await listMemories(ridgeon, { scope: "personal", allWorkspaces: true, limit: 200 })).map((memory) => [memory.title, memory.workspaceName, memory.allWorkspaces]);
    assert.ok(places.some(([title, name, all]) => title === "Mine in Eclipse" && name === "Eclipse" && all === false));
  });

  it("starts a new workspace blank even when an old client still asks to copy the brand", async () => {
    const admin = getAdminPool();
    await admin.query(
      `insert into crm.workspace_brands (workspace_id, what_you_sell, tone, playbook) values ($1, 'AI visibility', 'Plain', 'One idea per email')
       on conflict (workspace_id) do update set what_you_sell = excluded.what_you_sell, tone = excluded.tone, playbook = excluded.playbook`,
      [eclipse.workspaceId],
    );
    const created = await createWorkspace(eclipse, { name: "Side project", brandStart: "copy" } as { name: string });
    const brand = await admin.query("select 1 from crm.workspace_brands where workspace_id = $1 and (what_you_sell <> '' or tone <> '' or playbook <> '')", [created.id]);
    assert.equal(brand.rowCount, 0);
    const stored = await admin.query<{ brand_source_id: string | null }>("select brand_source_id from crm.workspaces where id = $1", [created.id]);
    assert.equal(stored.rows[0].brand_source_id, null);
  });
});
