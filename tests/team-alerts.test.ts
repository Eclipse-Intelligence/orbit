import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { alertMembers, alertMembersAfterCommit, alertTargets, sendAlert } from "@/lib/alerts";
import { searchMentions } from "@/lib/crm/mention-search";
import type { UserActor } from "@/lib/crm/types";
import { getAdminPool, getPool, type Db } from "@/lib/db/pool";
import { parseMentions } from "@/lib/docs/markdown";
import { publishLiveBatch, setLiveTesting, supabaseBatchSink, type LiveMessage } from "@/lib/docs/live/broadcast";
import { watchLiveActivity } from "@/lib/docs/live/client";
import { personTopic, workspaceTopic } from "@/lib/docs/live/protocol";
import { memoryHub } from "@/lib/docs/live/transport";
import { recordHref } from "@/lib/docs/routes";
import { createDoc, docsMentioning, shareDoc } from "@/lib/docs/store";
import { appBadge, notificationSettings, setMailNotifications, teamUnreadCount } from "@/lib/mail/notify";
import { expandMentions, mentionsIn } from "@/lib/mentions";
import { savePushSubscription, type PushSender } from "@/lib/push";
import { listNotifications, markNotificationsRead } from "@/lib/workflows/store";
import { createUser, resetDatabase } from "./helpers";

const PROVENANCE = { operation: "team_alerts_test", source: "test" };

after(async () => {
  await getPool().end();
});

function pusher() {
  const sent: { endpoint: string; body: Record<string, unknown> }[] = [];
  const send: PushSender = async (subscription, payload) => {
    sent.push({ endpoint: subscription.endpoint, body: JSON.parse(payload) });
  };
  return { send, sent };
}

async function sql(text: string, values: unknown[] = []) {
  return getAdminPool().query(text, values);
}

async function until(check: () => boolean, label: string) {
  for (let tries = 0; tries < 200; tries += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`Timed out waiting for ${label}`);
}

describe("teammate alerts", () => {
  let mark: UserActor;
  let sam: UserActor;
  let samHome: UserActor;
  let olly: UserActor;
  let markInRidgeon: UserActor;
  let broadcasts: LiveMessage[][];

  before(async () => {
    await resetDatabase();
    mark = await createUser("mark@eclipse.test", "Mark Ridgeon");
    const samUser = await createUser("sam@eclipse.test", "Sam Member");
    olly = await createUser("olly@elsewhere.test", "Olly Outside");
    const ridgeon = await createUser("ridgeon@ridgeon.test", "Ridgeon Owner");
    await sql("update crm.workspaces set name = 'Eclipse' where id = $1", [mark.workspaceId]);
    await sql("update crm.workspaces set name = 'Ridgeon' where id = $1", [ridgeon.workspaceId]);
    await sql("insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, 'member')", [mark.workspaceId, samUser.userId]);
    await sql("insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, 'owner')", [ridgeon.workspaceId, mark.userId]);
    mark = { ...mark, workspaceName: "Eclipse" };
    samHome = samUser;
    sam = { ...samUser, workspaceId: mark.workspaceId, workspaceName: "Eclipse", role: "member" };
    markInRidgeon = { ...mark, workspaceId: ridgeon.workspaceId, workspaceName: "Ridgeon" };
    await savePushSubscription(samHome, { endpoint: "https://web.push.apple.com/sam-phone", keys: { p256dh: "BKey", auth: "auth" } }, "iPhone");
    await savePushSubscription(mark, { endpoint: "https://web.push.apple.com/mark-phone", keys: { p256dh: "BKey", auth: "auth" } }, "iPhone");
  });

  beforeEach(async () => {
    broadcasts = [];
    setLiveTesting({ batch: async (messages) => void broadcasts.push(messages) });
    await sql("truncate crm.push_log, crm.notifications");
    await sql("update crm.mail_preferences set notify_team = true");
  });

  afterEach(() => {
    setLiveTesting(null);
  });

  it("writes the bell row as the recipient in their home workspace and pushes with a tag", async () => {
    const push = pusher();
    const result = await alertMembers(
      mark,
      [sam.userId],
      { source: "chat", key: "chat:m1", title: "Mark mentioned you in #sales", href: "/chat/c1", tag: "chat:c1" },
      { send: push.send },
    );
    assert.deepEqual(result.alerted, [sam.userId]);
    const rows = await sql("select workspace_id, user_id, title, body, href, source from crm.notifications");
    assert.equal(rows.rows.length, 1);
    assert.deepEqual(rows.rows[0], { workspace_id: samHome.workspaceId, user_id: sam.userId, title: "Mark mentioned you in #sales", body: null, href: "/chat/c1", source: "chat" });
    assert.equal(push.sent.length, 1);
    assert.equal(push.sent[0].endpoint, "https://web.push.apple.com/sam-phone");
    assert.equal(push.sent[0].body.title, "Mark mentioned you in #sales");
    assert.equal(push.sent[0].body.tag, "chat:c1");
    assert.equal(push.sent[0].body.url, "/chat/c1");
    assert.equal(push.sent[0].body.badge, 1);
  });

  it("sends once per key and one batched broadcast per call", async () => {
    const push = pusher();
    const alert = { source: "mail_share" as const, key: "share:s1", title: "Mark shared an email with you", href: "/mail", tag: "share:s1" };
    await alertMembers(mark, [sam.userId, sam.userId, mark.userId], alert, { send: push.send });
    const again = await alertMembers(mark, [sam.userId], alert, { send: push.send });
    assert.deepEqual(again.alerted, []);
    assert.equal(push.sent.length, 1);
    assert.equal((await sql("select count(*)::int as n from crm.notifications")).rows[0].n, 1);
    assert.deepEqual(broadcasts, [[{ topic: personTopic(sam.userId), event: "alert", payload: { source: "mail_share" } }]]);
  });

  it("never alerts the sender or people who share no workspace with them", async () => {
    const push = pusher();
    const result = await alertMembers(mark, [mark.userId, olly.userId, "not-a-uuid"], { source: "chat", key: "chat:m2", title: "Hi", href: "/chat", tag: "chat:c2" }, { send: push.send });
    assert.deepEqual(result.alerted, []);
    assert.equal(push.sent.length, 0);
    assert.deepEqual(broadcasts, []);
    assert.equal((await sql("select count(*)::int as n from crm.notifications")).rows[0].n, 0);
  });

  it("puts task and doc alerts in the subject's workspace, and only for its members", async () => {
    const targets = await alertTargets(mark, [sam.userId], { source: "task", workspaceId: mark.workspaceId });
    assert.deepEqual(
      targets.map((target) => [target.userId, target.workspaceId]),
      [[sam.userId, mark.workspaceId]],
    );
    assert.deepEqual(await alertTargets(markInRidgeon, [sam.userId], { source: "doc", workspaceId: markInRidgeon.workspaceId }), []);
    assert.deepEqual(await alertTargets(mark, [sam.userId], { source: "task" }), []);
    assert.deepEqual(await alertTargets(olly, [sam.userId], { source: "task", workspaceId: mark.workspaceId }), []);
    await alertMembers(mark, [sam.userId], { source: "task", key: "task:t1", title: "Mark assigned you a task", href: "/tasks", tag: "task:t1", workspaceId: mark.workspaceId }, { send: pusher().send });
    const row = (await sql("select workspace_id, href from crm.notifications where source = 'task'")).rows[0];
    assert.equal(row.workspace_id, mark.workspaceId);
    assert.match(row.href, /^\/open\?/);
    assert.equal(new URL(row.href, "https://orbit.test").searchParams.get("workspace"), mark.workspaceId);
  });

  it("shows chat and shared mail in every workspace, and tasks only in their own", async () => {
    await alertMembers(mark, [sam.userId], { source: "chat", key: "chat:m3", title: "Chat alert", href: "/chat", tag: "chat:c3" }, { send: pusher().send });
    await alertMembers(mark, [sam.userId], { source: "task", key: "task:t2", title: "Task alert", href: "/tasks", tag: "task:t2", workspaceId: mark.workspaceId }, { send: pusher().send });
    const inEclipse = (await listNotifications(sam)).map((item) => item.title).sort();
    const atHome = (await listNotifications(samHome)).map((item) => item.title).sort();
    assert.deepEqual(inEclipse, ["Chat alert", "Task alert"]);
    assert.deepEqual(atHome, ["Chat alert"]);
    await markNotificationsRead(sam);
    const unread = await sql("select title from crm.notifications where read_at is null");
    assert.deepEqual(unread.rows, []);
  });

  it("records the bell but skips the push when Teammates is off", async () => {
    await setMailNotifications(samHome, { team: false });
    assert.equal((await notificationSettings(sam)).team, false);
    const push = pusher();
    const result = await alertMembers(mark, [sam.userId], { source: "chat", key: "chat:m4", title: "Quiet", href: "/chat", tag: "chat:c4" }, { send: push.send });
    assert.deepEqual(result.alerted, [sam.userId]);
    assert.equal(push.sent.length, 0);
    assert.equal(broadcasts.length, 1);
    assert.equal((await listNotifications(samHome)).length, 1);
  });

  it("keeps notification settings the same in every workspace", async () => {
    await setMailNotifications(mark, { team: false, reads: true, calendarMinutes: 30 });
    await setMailNotifications(markInRidgeon, { mail: "all" });
    const settings = await notificationSettings(mark);
    assert.equal(settings.team, false);
    assert.equal(settings.reads, true);
    assert.equal(settings.calendarMinutes, 30);
    assert.equal(settings.mail, "all");
    await setMailNotifications(markInRidgeon, { calendarMinutes: null, team: true });
    const later = await notificationSettings(mark);
    assert.equal(later.calendarMinutes, null);
    assert.equal(later.team, true);
    assert.equal(later.mail, "all");
  });

  it("gives sendAlert a bell source", async () => {
    await sendAlert(mark, { title: "Push", body: "", url: "/mail", source: "mail_share", bell: { title: "Bell" } }, { send: pusher().send });
    const row = (await sql("select source, workspace_id from crm.notifications where title = 'Bell'")).rows[0];
    assert.deepEqual(row, { source: "mail_share", workspace_id: mark.workspaceId });
    await sendAlert(mark, { title: "Push", body: "", url: "/mail", bell: { title: "Mail bell" } }, { send: pusher().send });
    assert.equal((await sql("select source from crm.notifications where title = 'Mail bell'")).rows[0].source, "mail");
  });

  it("keeps both of two settings changed at the same moment", async () => {
    for (let round = 0; round < 10; round += 1) {
      const reads = round % 2 === 0;
      const team = round % 3 === 0;
      await Promise.all([setMailNotifications(mark, { reads }), setMailNotifications(markInRidgeon, { team }), setMailNotifications(mark, { calendarMinutes: round })]);
      const settings = await notificationSettings(mark);
      assert.deepEqual([settings.reads, settings.team, settings.calendarMinutes], [reads, team, round], `round ${round}`);
    }
  });

  it("always writes the bell row, even when the time budget has run out", async () => {
    const push = pusher();
    const result = await alertMembers(mark, [sam.userId], { source: "chat", key: "chat:m5", title: "Late", href: "/chat", tag: "chat:c5" }, { send: push.send, budgetMs: -1 });
    assert.deepEqual(result.alerted, [sam.userId]);
    assert.equal(result.finished, false);
    assert.equal(result.pushFailures, 0);
    assert.equal((await listNotifications(samHome)).map((item) => item.title).join(), "Late");
    assert.equal(push.sent.length, 1);
  });

  it("sends pushes while a broadcast hangs, and waits for them, not the broadcast", async () => {
    setLiveTesting({ batch: () => new Promise<void>(() => {}) });
    const push = pusher();
    const started = Date.now();
    const result = await alertMembers(mark, [sam.userId], { source: "chat", key: "chat:hang", title: "Hang", href: "/chat", tag: "chat:hang" }, { send: push.send, budgetMs: 100 });
    assert.ok(Date.now() - started < 2_000);
    assert.equal(result.finished, false);
    assert.equal(push.sent.length, 1);
    assert.equal(push.sent[0].body.title, "Hang");
  });

  it("counts failed pushes", async () => {
    const failing: PushSender = async () => {
      throw Object.assign(new Error("refused"), { statusCode: 500, body: "refused" });
    };
    const errors = console.error;
    console.error = () => {};
    try {
      const result = await alertMembers(mark, [sam.userId], { source: "chat", key: "chat:fail", title: "Fail", href: "/chat", tag: "chat:fail" }, { send: failing });
      assert.deepEqual([result.alerted, result.finished, result.pushFailures], [[sam.userId], true, 1]);
    } finally {
      console.error = errors;
    }
  });

  it("refuses an alert without a title, key or Orbit link", async () => {
    const base = { source: "chat" as const, key: "chat:bad", title: "Fine", href: "/chat", tag: "chat:bad" };
    await assert.rejects(() => alertMembers(mark, [sam.userId], { ...base, title: "  " }), /title/);
    await assert.rejects(() => alertMembers(mark, [sam.userId], { ...base, key: "" }), /key/);
    await assert.rejects(() => alertMembers(mark, [sam.userId], { ...base, href: "https://evil.test" }), /Orbit link/);
    await assert.rejects(() => alertMembers(mark, [sam.userId], { ...base, href: "/\\evil.test" }), /Orbit link/);
    await assert.rejects(() => alertMembers(mark, [sam.userId], { ...base, href: "/chat\nx" }), /Orbit link/);
    await assert.rejects(() => alertMembers(mark, [sam.userId], { ...base, source: "task" }), /workspace/);
    assert.throws(() => alertMembersAfterCommit({} as Db, mark, [sam.userId], { ...base, title: "" }), /title/);
    assert.equal((await sql("select count(*)::int as n from crm.notifications")).rows[0].n, 0);
  });

  it("clears every unread alert in the bell's scope when it opens, even beyond the rows it shows", async () => {
    for (let index = 0; index < 13; index += 1) {
      await alertMembers(mark, [sam.userId], { source: "chat", key: `chat:many${index}`, title: `Many ${index}`, href: "/chat", tag: "chat:many" }, { send: pusher().send });
    }
    await sql("insert into crm.notifications (workspace_id, user_id, title, source, category) values ($1, $2, 'Waiting in Capture', 'mail', 'capture')", [samHome.workspaceId, sam.userId]);
    const listed = await listNotifications(samHome, 10);
    assert.equal(listed.length, 10);
    assert.equal(await teamUnreadCount(samHome), 13);
    await alertMembers(mark, [sam.userId], { source: "chat", key: "chat:after", title: "After opening", href: "/chat", tag: "chat:many" }, { send: pusher().send });
    await sql("update crm.notifications set created_at = now() + interval '1 minute' where title = 'After opening'");
    await markNotificationsRead(samHome, listed.map((item) => item.id), listed[0].createdAt);
    assert.equal(await teamUnreadCount(samHome), 1);
    const unread = await sql("select title from crm.notifications where read_at is null order by title");
    assert.deepEqual(
      unread.rows.map((row) => row.title),
      ["After opening", "Waiting in Capture"],
    );
  });

  it("keeps a whole link when the workspace switch would make it too long", async () => {
    const href = `/tasks?q=${"%25".repeat(90)}`;
    await alertMembers(mark, [sam.userId], { source: "task", key: "task:long", title: "Long", href, tag: "task:long", workspaceId: mark.workspaceId }, { send: pusher().send });
    assert.equal((await sql("select href from crm.notifications where title = 'Long'")).rows[0].href, href);
  });

  it("counts the badge from mail and the teammate alerts the bell can clear", async () => {
    const push = pusher();
    for (const index of [1, 2]) {
      await alertMembers(mark, [sam.userId], { source: "chat", key: `chat:b${index}`, title: `Chat ${index}`, href: "/chat", tag: "chat:b" }, { send: push.send });
    }
    await alertMembers(mark, [sam.userId], { source: "task", key: "task:b3", title: "Task 3", href: "/tasks", tag: "task:b3", workspaceId: mark.workspaceId }, { send: push.send });
    assert.deepEqual(
      push.sent.map((item) => item.body.badge),
      [1, 2, 3],
    );
    assert.equal(await teamUnreadCount(sam), 3);
    assert.equal(await teamUnreadCount(samHome), 2);
    assert.equal(await appBadge(samHome), 2);
    await markNotificationsRead(samHome);
    assert.equal(await teamUnreadCount(samHome), 0);
    assert.equal(await teamUnreadCount(sam), 1);
    await markNotificationsRead(sam);
    assert.equal(await appBadge(sam), 0);
  });
});

describe("live alerts", () => {
  it("batches broadcasts into one Realtime request", async () => {
    const saved = { url: process.env.NEXT_PUBLIC_SUPABASE_URL, key: process.env.SUPABASE_SERVICE_ROLE_KEY };
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://realtime.example.test";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-key";
    try {
      const calls: { url: string; body: { messages: unknown[] } }[] = [];
      const fake: typeof fetch = async (input, init) => {
        calls.push({ url: String(input), body: JSON.parse(String(init?.body)) });
        return new Response(null, { status: 202 });
      };
      const sink = supabaseBatchSink(fake)!;
      await sink([
        { topic: personTopic("00000000-0000-4000-8000-000000000001"), event: "alert", payload: { source: "chat" } },
        { topic: personTopic("00000000-0000-4000-8000-000000000002"), event: "alert", payload: { source: "chat" } },
      ]);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, "https://realtime.example.test/realtime/v1/api/broadcast");
      assert.equal(calls[0].body.messages.length, 2);
      assert.deepEqual(calls[0].body.messages[0], { topic: personTopic("00000000-0000-4000-8000-000000000001"), event: "alert", payload: { source: "chat" }, private: true });
    } finally {
      if (saved.url === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL;
      else process.env.NEXT_PUBLIC_SUPABASE_URL = saved.url;
      if (saved.key === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
      else process.env.SUPABASE_SERVICE_ROLE_KEY = saved.key;
    }
  });

  it("does nothing without anywhere to publish", async () => {
    setLiveTesting({ batch: null });
    await publishLiveBatch([{ topic: personTopic("00000000-0000-4000-8000-000000000001"), event: "alert", payload: { source: "chat" } }]);
    setLiveTesting(null);
  });

  it("delivers alerts on the person channel, shared with the writing watcher", async () => {
    const hub = memoryHub();
    const transport = hub.transport();
    let opened = 0;
    const counting = {
      open: (topic: string, handlers: Parameters<typeof transport.open>[1]) => {
        opened += 1;
        return transport.open(topic, handlers);
      },
    };
    const scope = { workspaceId: "00000000-0000-4000-8000-0000000000aa", userId: "00000000-0000-4000-8000-0000000000bb" };
    const alerts: string[] = [];
    const writers: string[] = [];
    let bellJoined = false;
    const stopDocs = await watchLiveActivity(counting, scope, (pageId) => writers.push(pageId), () => {});
    const stopBell = await watchLiveActivity(counting, scope, null, (joined) => (bellJoined = joined), (message) => alerts.push(message.source));
    assert.equal(opened, 2);
    await until(() => bellJoined, "bell joins");
    hub.publish(personTopic(scope.userId), "alert", { source: "chat" });
    hub.publish(workspaceTopic(scope.workspaceId), "alert", { source: "forged" });
    hub.publish(personTopic(scope.userId), "writing", { pageId: "p1", user: { id: "u1", name: "Sam", kind: "person" }, writing: true });
    await until(() => alerts.length === 1 && writers.length === 1, "alert and writing arrive");
    assert.deepEqual(alerts, ["chat"]);
    stopBell();
    hub.publish(personTopic(scope.userId), "writing", { pageId: "p2", user: { id: "u1", name: "Sam", kind: "person" }, writing: false });
    await until(() => writers.length === 2, "docs watcher keeps the shared channel");
    stopDocs();
    hub.publish(personTopic(scope.userId), "alert", { source: "chat" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(alerts, ["chat"]);
  });

  it("tells the bell when the channel drops and joins again, and one failing listener doesn't stop the others", async () => {
    const hub = memoryHub();
    const transport = hub.transport();
    const scope = { workspaceId: "00000000-0000-4000-8000-0000000000cc", userId: "00000000-0000-4000-8000-0000000000dd" };
    const joins: boolean[] = [];
    const alerts: string[] = [];
    const errors = console.error;
    console.error = () => {};
    try {
      const stopBroken = await watchLiveActivity(transport, scope, null, () => {}, () => {
        throw new Error("broken listener");
      });
      const stopBell = await watchLiveActivity(transport, scope, null, (joined) => joins.push(joined), (message) => alerts.push(message.source));
      await until(() => joins.at(-1) === true, "first join");
      hub.disconnect(transport.id);
      await until(() => joins.at(-1) === false, "drop");
      hub.reconnect(transport.id);
      await until(() => joins.at(-1) === true, "rejoin");
      assert.deepEqual(
        joins.filter((joined, index) => index === 0 || joined !== joins[index - 1]),
        [true, false, true],
      );
      hub.publish(personTopic(scope.userId), "alert", { source: "doc" });
      await until(() => alerts.length === 1, "alert after a failing listener");
      stopBroken();
      stopBell();
    } finally {
      console.error = errors;
    }
  });
});

describe("people mentions", () => {
  let mark: UserActor;
  let sam: UserActor;

  before(async () => {
    await resetDatabase();
    mark = await createUser("mark@eclipse.test", "Mark Ridgeon");
    const samUser = await createUser("sam@eclipse.test", "Sam Member");
    await sql("insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, 'member')", [mark.workspaceId, samUser.userId]);
    sam = { ...samUser, workspaceId: mark.workspaceId, role: "member" };
  });

  it("parses member tokens like any other mention", () => {
    const text = `Ask @[Sam Member](member:${sam.userId}) about it`;
    assert.deepEqual(mentionsIn(text), [{ kind: "member", id: sam.userId, name: "Sam Member" }]);
    assert.equal(expandMentions(text), `Ask Sam Member [teammate id ${sam.userId}] about it`);
    assert.deepEqual(parseMentions(text), [{ kind: "member", id: sam.userId, name: "Sam Member" }]);
    assert.equal(recordHref("member", sam.userId), "/settings/team");
  });

  it("indexes people tagged in a doc", async () => {
    const doc = await createDoc(mark, { title: "Plan", content: `Owner: @[Sam Member](member:${sam.userId})` }, PROVENANCE);
    await shareDoc(mark, doc.id, true);
    assert.deepEqual(doc.mentions, [{ kind: "member", id: sam.userId, name: "Sam Member" }]);
    const references = await docsMentioning(mark, { kind: "member", id: sam.userId });
    assert.deepEqual(
      references.map((reference) => reference.id),
      [doc.id],
    );
  });

  it("lists teammates first in the picker, never yourself", async () => {
    const empty = await searchMentions(mark, "");
    assert.deepEqual(
      empty.filter((option) => option.kind === "member").map((option) => option.name),
      ["Sam Member"],
    );
    assert.equal(empty[0].kind, "member");
    const named = await searchMentions(mark, "sam");
    assert.deepEqual(named[0], { kind: "member", id: sam.userId, name: "Sam Member", detail: "Member" });
    assert.equal((await searchMentions(mark, "mark")).some((option) => option.kind === "member"), false);
    assert.equal((await searchMentions(mark, "nobody here")).length, 0);
  });

  it("never offers someone from another workspace", async () => {
    const samWorkspace = (await sql("select workspace_id from crm.workspace_members where user_id = $1 and workspace_id <> $2", [sam.userId, mark.workspaceId])).rows[0].workspace_id;
    const sara = await createUser("sara@elsewhere.test", "Sara Elsewhere");
    await sql("insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, 'member')", [samWorkspace, sara.userId]);
    assert.equal((await searchMentions(mark, "sara")).some((option) => option.kind === "member"), false);
    const inSamWorkspace = { ...sam, workspaceId: samWorkspace, role: "owner" as const };
    assert.deepEqual(
      (await searchMentions(inSamWorkspace, "sara")).filter((option) => option.kind === "member").map((option) => option.name),
      ["Sara Elsewhere"],
    );
  });
});
