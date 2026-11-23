import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { withActor } from "@/lib/crm/context";
import type { UserActor } from "@/lib/crm/types";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { hiddenByPending } from "@/lib/mail/pending-sql";
import { mailNav, mailUnreadCount } from "@/lib/mail/threads";
import { createUser, resetDatabase, useServerlessPool } from "./helpers";

const ROLES = ["inbox", "sent", "drafts", "archive", "trash", "junk", "snoozed", "other"] as const;
type Role = (typeof ROLES)[number];
type Box = { sourceId: string; folders: Record<Role, string> };

let counter = 0;

async function mailbox(actor: UserActor): Promise<Box> {
  const admin = getAdminPool();
  const connection = await admin.query<{ id: string }>(
    "insert into crm.mailbox_connections (workspace_id, user_id, provider, email, status, refresh_token) values ($1, $2, 'microsoft', $3, 'connected', 'cipher') returning id",
    [actor.workspaceId, actor.userId, actor.email],
  );
  const source = await admin.query<{ id: string }>(
    "insert into crm.mail_sources (workspace_id, user_id, connection_id, email) values ($1, $2, $3, $4) returning id",
    [actor.workspaceId, actor.userId, connection.rows[0].id, actor.email],
  );
  const sourceId = source.rows[0].id;
  const folders = {} as Record<Role, string>;
  for (const role of ROLES) {
    const folder = await admin.query<{ id: string }>(
      "insert into crm.mail_folders (workspace_id, user_id, source_id, provider_folder_id, name, role) values ($1, $2, $3, $4, $5, $6) returning id",
      [actor.workspaceId, actor.userId, sourceId, `${role}-${sourceId}`, `${role} folder`, role],
    );
    folders[role] = folder.rows[0].id;
  }
  return { sourceId, folders };
}

async function message(actor: UserActor, box: Box, thread: string, role: Role, isRead = false) {
  counter += 1;
  await getAdminPool().query(
    `insert into crm.mail_messages (workspace_id, user_id, source_id, folder_id, provider_message_id, internet_message_id, thread_key, subject, snippet, body_text,
       from_email, to_recipients, cc_recipients, sent_at, received_at, is_read)
     values ($1, $2, $3, $4, $5, $6, $7, 'Subject', 'Snippet', 'Body', 'jane@acme.test', '[]'::jsonb, '[]'::jsonb, now(), now(), $8)`,
    [actor.workspaceId, actor.userId, box.sourceId, box.folders[role], `m-${counter}`, `<m-${counter}@mail.test>`, thread, isRead],
  );
}

async function pending(actor: UserActor, box: Box, thread: string, action: string, ageSeconds: number, refused = false) {
  await getAdminPool().query(
    `insert into crm.mail_pending_actions (workspace_id, user_id, source_id, thread_key, action, created_at, refused_at)
     values ($1, $2, $3, $4, $5, now() - ($6 || ' seconds')::interval, case when $7::boolean then now() else null end)`,
    [actor.workspaceId, actor.userId, box.sourceId, thread, action, String(ageSeconds), refused],
  );
}

async function previousUnread(actor: UserActor) {
  return withActor(actor, async (db) => {
    const result = await db.query<{ id: string; unread: number }>(
      `select f.id,
         (select count(distinct m.thread_key)::int from crm.mail_messages m where m.folder_id = f.id and not m.is_read and ${hiddenByPending("m", "f")}) as unread
       from crm.mail_folders f where f.user_id = $1 and f.sync_state <> 'skipped'`,
      [actor.userId],
    );
    return new Map(result.rows.map((row) => [row.id, row.unread]));
  });
}

async function previousInboxThreads(actor: UserActor) {
  return withActor(actor, async (db) => {
    const result = await db.query<{ threads: number }>(
      `select count(distinct m.thread_key)::int as threads from crm.mail_messages m join crm.mail_folders f on f.id = m.folder_id
       where m.user_id = $1 and f.role = 'inbox' and ${hiddenByPending("m", "f")}`,
      [actor.userId],
    );
    return result.rows[0].threads;
  });
}

describe("mail nav counts", () => {
  useServerlessPool();
  let owner: UserActor;
  let stranger: UserActor;
  let box: Box;
  let strangerBox: Box;

  const unread = async (role: Role, who = owner, where = box) => {
    const nav = await mailNav(who);
    return nav.folders.find((folder) => folder.id === where.folders[role])?.unread;
  };

  before(async () => {
    await resetDatabase();
    owner = await createUser("owner@nav.test", "Owner");
    stranger = await createUser("stranger@nav.test", "Stranger");
    box = await mailbox(owner);
    strangerBox = await mailbox(stranger);

    for (const role of ROLES) await message(owner, box, `plain-${role}`, role);
    await message(owner, box, "plain-inbox", "inbox");
    await message(owner, box, "read-inbox", "inbox", true);

    for (const role of ROLES) await message(owner, box, "t-archive", role);
    await pending(owner, box, "t-archive", "archive", 30);

    await message(owner, box, "t-snooze", "inbox");
    await message(owner, box, "t-snooze", "other");
    await message(owner, box, "t-snooze", "snoozed");
    await pending(owner, box, "t-snooze", "snooze", 30);

    for (const role of ROLES) await message(owner, box, "t-trash", role);
    await pending(owner, box, "t-trash", "trash", 30);

    for (const role of ROLES) await message(owner, box, "t-inbox", role);
    await pending(owner, box, "t-inbox", "inbox", 30);

    for (const role of ROLES) await message(owner, box, "t-override", role);
    await pending(owner, box, "t-override", "archive", 60);
    await pending(owner, box, "t-override", "inbox", 30);

    for (const role of ROLES) await message(owner, box, "t-override-back", role);
    await pending(owner, box, "t-override-back", "inbox", 60);
    await pending(owner, box, "t-override-back", "trash", 30);

    for (const role of ROLES) await message(owner, box, "t-refused", role);
    await pending(owner, box, "t-refused", "trash", 30, true);

    for (const role of ROLES) await message(owner, box, "t-refused-latest", role);
    await pending(owner, box, "t-refused-latest", "archive", 60);
    await pending(owner, box, "t-refused-latest", "inbox", 30, true);

    for (const role of ROLES) await message(owner, box, "t-close", role);
    await pending(owner, box, "t-close", "archive", 30);
    await pending(owner, box, "t-close", "inbox", 30);

    for (const role of ROLES) await message(stranger, strangerBox, "t-archive", role);
    for (const role of ROLES) await message(stranger, strangerBox, "stranger-only", role);
    await pending(stranger, strangerBox, "plain-inbox", "trash", 30);
    await message(stranger, strangerBox, "plain-inbox", "inbox");
  });

  after(async () => {
    await getPool().end();
  });

  it("matches the per-folder counts the nested check produced, for every folder", async () => {
    const nav = await mailNav(owner);
    const expected = await previousUnread(owner);
    assert.equal(nav.folders.length, ROLES.length);
    for (const folder of nav.folders) assert.equal(folder.unread, expected.get(folder.id), `${folder.role} folder`);
  });

  it("matches the old counts for the stranger too", async () => {
    const nav = await mailNav(stranger);
    const expected = await previousUnread(stranger);
    for (const folder of nav.folders) assert.equal(folder.unread, expected.get(folder.id), `${folder.role} folder`);
  });

  it("hides a thread from the folders its latest action leaves, and only those", async () => {
    const expected: Record<Role, number> = { inbox: 5, sent: 7, drafts: 7, archive: 4, trash: 6, junk: 4, snoozed: 7, other: 5 };
    for (const role of ROLES) assert.equal(await unread(role), expected[role], `${role} folder`);
  });

  it("lets a later pending action override an earlier one, and ignores a refused one", async () => {
    const nav = await mailNav(owner);
    const inbox = nav.folders.find((folder) => folder.role === "inbox")!.unread;
    const archive = nav.folders.find((folder) => folder.role === "archive")!.unread;
    const expected = await previousUnread(owner);
    assert.equal(inbox, expected.get(box.folders.inbox));
    assert.equal(archive, expected.get(box.folders.archive));
    await getAdminPool().query("update crm.mail_pending_actions set refused_at = now() where thread_key = 't-override' and action = 'inbox'");
    assert.equal(await unread("inbox"), (expected.get(box.folders.inbox) ?? 0) - 1, "with the later action refused, the earlier archive hides it again");
    await getAdminPool().query("update crm.mail_pending_actions set refused_at = null where thread_key = 't-override' and action = 'inbox'");
    assert.equal(await unread("inbox"), expected.get(box.folders.inbox));
  });

  it("counts every thread once however many unread messages it has", async () => {
    await message(owner, box, "busy", "other");
    await message(owner, box, "busy", "other");
    await message(owner, box, "busy", "other");
    const before = await unread("other");
    await message(owner, box, "busy", "other");
    assert.equal(await unread("other"), before);
    assert.equal(before, (await previousUnread(owner)).get(box.folders.other));
  });

  it("never counts another person's messages or lets their moves hide yours", async () => {
    const ownerInbox = await unread("inbox");
    assert.equal(await unread("inbox", stranger, strangerBox), 2, "their own move hides their own plain-inbox, and your moves never reach them");
    assert.equal(await unread("trash", stranger, strangerBox), 2);
    await getAdminPool().query("delete from crm.mail_messages where user_id = $1", [stranger.userId]);
    await getAdminPool().query("delete from crm.mail_pending_actions where user_id = $1", [stranger.userId]);
    assert.equal(await unread("inbox"), ownerInbox, "removing everything they have changes nothing for you");
    const nav = await mailNav(stranger);
    assert.ok(nav.folders.every((folder) => folder.unread === 0));
    assert.ok(nav.folders.every((folder) => Object.values(strangerBox.folders).includes(folder.id)), "their nav lists only their folders");
    const own = await mailNav(owner);
    assert.equal(own.folders.find((folder) => folder.role === "inbox")!.unread, ownerInbox);
    assert.ok(own.folders.every((folder) => Object.values(box.folders).includes(folder.id)));
  });

  it("keeps the inbox splits and the unread badge in step with what the inbox lists", async () => {
    const nav = await mailNav(owner);
    const total = nav.splits.reduce((sum, row) => sum + row.total, 0);
    assert.equal(total, await previousInboxThreads(owner));
    assert.ok((await mailUnreadCount(owner)) <= nav.unread);
  });
});
