import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, describe, it } from "node:test";
import * as bookingPages from "@/lib/booking/pages";
import * as brandModule from "@/lib/crm/brand";
import { getGranolaStatus, personalGranolaKey, removeGranolaKey, saveGranolaKey } from "@/lib/crm/granola";
import { scopesForRole } from "@/lib/crm/scopes";
import type { UserActor } from "@/lib/crm/types";
import * as workspacesModule from "@/lib/crm/workspaces";
import { createWorkspace } from "@/lib/crm/workspaces";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { defaultSender } from "@/lib/mail/compose";
import { listUnknownMail } from "@/lib/mail/filing";
import { listAddressHomes, setAddressHome } from "@/lib/mail/routing";
import { readwiseStatus, readwiseToken, removeReadwiseToken, saveReadwiseToken } from "@/lib/readwise/keys";
import { recallKey, recallStatus, removeRecallKey, saveRecallKey } from "@/lib/recall/keys";
import { createUser, resetDatabase } from "./helpers";

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

  it("keeps the newest key per person and service when the migration runs again", async () => {
    const admin = getAdminPool();
    const sql = readFileSync("supabase/migrations/20270108100000_settings_simplified.sql", "utf8");
    await admin.query("alter table crm.recall_keys drop constraint recall_keys_owner");
    await admin.query("alter table crm.recall_keys add constraint recall_keys_owner unique (workspace_id, user_id)");
    await admin.query(
      `insert into crm.recall_keys (workspace_id, user_id, key_cipher, key_hint, connected_at) values
       ($1, $3, 'old', 'old1', now() - interval '2 days'),
       ($2, $3, 'new', 'new1', now() - interval '1 day')`,
      [eclipse.workspaceId, ridgeon.workspaceId, eclipse.userId],
    );
    await admin.query(sql);
    await admin.query(sql);
    const kept = await admin.query<{ key_hint: string; workspace_id: string }>("select key_hint, workspace_id from crm.recall_keys where user_id = $1", [eclipse.userId]);
    assert.deepEqual(kept.rows, [{ key_hint: "new1", workspace_id: ridgeon.workspaceId }]);
    await assert.rejects(
      admin.query("insert into crm.recall_keys (workspace_id, user_id, key_cipher) values ($1, $2, 'again')", [eclipse.workspaceId, eclipse.userId]),
      /recall_keys_owner/,
    );
    await admin.query("delete from crm.recall_keys where user_id = $1", [eclipse.userId]);
  });

  it("moves a person's keys with them when they leave the workspace the keys live in", async () => {
    const admin = getAdminPool();
    await saveRecallKey(eclipse, RECALL_KEY, { fetchImpl: accepting });
    await admin.query("select private.move_personal_rows($1, $2, $3)", [eclipse.userId, eclipse.workspaceId, ridgeon.workspaceId]);
    const moved = await admin.query<{ workspace_id: string }>("select workspace_id from crm.recall_keys where user_id = $1", [eclipse.userId]);
    assert.deepEqual(moved.rows.map((row) => row.workspace_id), [ridgeon.workspaceId]);
    assert.equal(await recallKey(eclipse), RECALL_KEY);
  });

  it("has no Copy from: new workspaces start blank and booking pages are never offered from another workspace", () => {
    assert.equal("otherBookingPages" in bookingPages, false);
    assert.equal("copyBrandProfile" in brandModule, false);
    assert.equal("BRAND_COPY_FAILED" in workspacesModule, false);
    assert.equal(createWorkspace.length, 2);
  });
});
