import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { chatMessage } from "@/lib/chat/tools";
import type { ChatLiveEvent } from "@/lib/chat/types";
import {
  chatWorkSettled,
  createRoom,
  deleteMessage,
  editMessage,
  getDiscussion,
  listMessages,
  listThread,
  openDiscussion,
  openDm,
  postMessage,
  removeLinkPreview,
  setRoomArchived,
} from "@/lib/crm/chat";
import { createHook, postViaHook } from "@/lib/crm/chat-hooks";
import { listSaved, setMessageSaved } from "@/lib/crm/chat-saved";
import { cleanRecordRefs, listRecordCards } from "@/lib/crm/chat-record-cards";
import { linkPreviewImage, previewImageResponse, refreshLinkPreviews, type PreviewTransport } from "@/lib/crm/chat-link-previews";
import { createCompany } from "@/lib/crm/companies";
import { createContact } from "@/lib/crm/contacts";
import { CrmError } from "@/lib/crm/errors";
import { createOpportunity } from "@/lib/crm/opportunities";
import { createTask } from "@/lib/crm/tasks";
import type { UserActor } from "@/lib/crm/types";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { setLiveTesting, type LiveMessage } from "@/lib/docs/live/broadcast";
import { personTopic } from "@/lib/docs/live/protocol";
import { createDoc, shareDoc } from "@/lib/docs/store";
import { applyMigrationSql } from "@/lib/db/migration-sql";
import { createWorkflow } from "@/lib/workflows/store";
import { createUser, queryAsUser, resetDatabase, useServerlessPool } from "./helpers";

const PUBLIC = async () => ["93.184.216.34"];
const NEWS = "https://news.example/story";
const SHOP = "https://shop.example/item";
const THIRD = "https://third.example/x";
const COVER = "https://img.example/cover.png";
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70]);

type Fixture = { body?: string | Buffer; type?: string; status?: number; location?: string };

function web(pages: Record<string, Fixture>) {
  const seen: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    seen.push(url);
    const page = pages[url];
    if (!page) return new Response("missing", { status: 404 });
    return new Response(page.body === undefined ? null : Buffer.from(page.body), {
      status: page.status ?? 200,
      headers: { "content-type": page.type ?? "text/html; charset=utf-8", ...(page.location ? { location: page.location } : {}) },
    });
  }) as typeof fetch;
  const transport: PreviewTransport = { fetchImpl, lookup: PUBLIC };
  return { transport, seen, pages };
}

function pages(): Record<string, Fixture> {
  return {
    [NEWS]: {
      body: `<head><meta property="og:title" content="Outage report &amp; follow-up"><meta property="og:description" content="Some API calls failed."><meta property="og:site_name" content="Northwind Status"><meta property="og:image" content="${COVER}"></head>`,
    },
    [SHOP]: { body: "<head><title>Widgets</title></head>" },
    [THIRD]: { body: "<head><title>Third</title></head>" },
    [COVER]: { body: PNG, type: "image/png" },
  };
}

async function sql(text: string, values: unknown[] = []) {
  return getAdminPool().query(text, values);
}

async function refused(work: Promise<unknown>, pattern: RegExp) {
  await assert.rejects(work, (error: unknown) => error instanceof CrmError && pattern.test(error.message));
}

async function join(user: UserActor, workspaceId: string, role: "member" | "admin" = "member") {
  await sql("insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, $3)", [workspaceId, user.userId, role]);
  return { ...user, workspaceId, role };
}

describe("link previews", () => {
  let mark: UserActor;
  let sam: UserActor;
  let priya: UserActor;
  let ada: UserActor;
  let olly: UserActor;
  let room: string;
  let broadcasts: LiveMessage[];
  let counter = 0;

  const key = () => `preview-${(counter += 1)}`;

  function previewEvents(userId: string) {
    return broadcasts
      .filter((message) => message.topic === personTopic(userId) && message.event === "chat")
      .map((message) => message.payload as ChatLiveEvent)
      .filter((event): event is Extract<ChatLiveEvent, { type: "previews" }> => event.type === "previews");
  }

  async function post(actor: UserActor, body: string, transport: PreviewTransport, conversationId = room, parentId: string | null = null) {
    const posted = await postMessage(actor, { conversationId, body, parentId, clientKey: key() }, { linkPreviews: transport });
    await chatWorkSettled();
    return posted.message;
  }

  async function previewsOf(actor: UserActor, messageId: string, conversationId = room) {
    return (await listMessages(actor, conversationId)).messages.find((item) => item.id === messageId)!.previews;
  }

  async function rows(messageId: string) {
    return (await sql("select id, url, position, title, image_url, hidden from crm.chat_link_previews where message_id = $1 order by position", [messageId])).rows as {
      id: string;
      url: string;
      position: number;
      title: string | null;
      image_url: string | null;
      hidden: boolean;
    }[];
  }

  before(async () => {
    await resetDatabase();
    mark = await createUser("mark@previews.test", "Mark Ridgeon");
    sam = await join(await createUser("sam@previews.test", "Sam Okafor"), mark.workspaceId);
    priya = await join(await createUser("priya@previews.test", "Priya Nair"), mark.workspaceId);
    ada = await join(await createUser("ada@previews.test", "Ada Admin"), mark.workspaceId, "admin");
    olly = await createUser("olly@elsewhere.test", "Olly Outside");
    room = (await createRoom(mark, { name: "sales", memberIds: [sam.userId] })).id;
  });

  beforeEach(() => {
    broadcasts = [];
    setLiveTesting({ batch: async (messages) => void broadcasts.push(...messages) });
  });

  afterEach(async () => {
    await chatWorkSettled();
    setLiveTesting(null);
  });

  after(async () => {
    await getPool().end();
  });

  describe("on the serverless pool", () => {
    useServerlessPool();

    it("fetches the first two addresses after a person posts, then tells members on their own channels", async () => {
      const site = web(pages());
      const posted = await postMessage(mark, { conversationId: room, body: `Read ${NEWS} and ${SHOP} and ${THIRD}`, clientKey: key() }, { linkPreviews: site.transport });
      assert.deepEqual(posted.message.previews, []);
      await chatWorkSettled();
      assert.deepEqual(site.seen.filter((url) => url !== COVER).sort(), [NEWS, SHOP].sort());
      const stored = await rows(posted.message.id);
      assert.deepEqual(
        stored.map((row) => [row.url, row.position]),
        [
          [NEWS, 0],
          [SHOP, 1],
        ],
      );
      const forSam = await previewsOf(sam, posted.message.id);
      assert.deepEqual(forSam, [
        { id: stored[0].id, url: NEWS, title: "Outage report & follow-up", description: "Some API calls failed.", site: "Northwind Status", image: true },
        { id: stored[1].id, url: SHOP, title: "Widgets", description: null, site: "shop.example", image: false },
      ]);
      assert.deepEqual(await previewsOf(mark, posted.message.id), forSam);
      for (const member of [mark, sam]) {
        const events = previewEvents(member.userId);
        assert.equal(events.length, 1);
        assert.deepEqual(events[0], { type: "previews", conversationId: room, messageId: posted.message.id, parentId: null, previews: forSam });
      }
      assert.equal(previewEvents(priya.userId).length + previewEvents(ada.userId).length + previewEvents(olly.userId).length, 0);
      assert.ok(broadcasts.filter((message) => (message.payload as ChatLiveEvent).type === "previews").every((message) => message.topic.startsWith("docs-person:")));
    });

    it("keeps previews, images and the message itself from people outside the conversation", async () => {
      const site = web(pages());
      const message = await post(mark, `Look ${NEWS}`, site.transport);
      const [stored] = await rows(message.id);
      for (const outsider of [priya, ada, olly]) {
        await refused(listMessages(outsider, room), /not found/i);
        assert.deepEqual(await queryAsUser(outsider.userId, "select id from crm.chat_link_previews"), [], outsider.email);
        const before = site.seen.length;
        await refused(linkPreviewImage(outsider, stored.id, site.transport), /not found/i);
        assert.equal(site.seen.length, before);
      }
      assert.equal((await queryAsUser(sam.userId, "select id from crm.chat_link_previews where message_id = $1", [message.id])).length, 1);
      await refused(linkPreviewImage(sam, "not-an-id", site.transport), /not found/i);
      await refused(linkPreviewImage(sam, "00000000-0000-4000-8000-000000000000", site.transport), /not found/i);
      await assert.rejects(queryAsUser(sam.userId, "insert into crm.chat_link_previews (message_id, url, title) values ($1, 'https://x.test/', 'x')", [message.id]), /permission denied/);
      await assert.rejects(queryAsUser(mark.userId, "update crm.chat_link_previews set title = 'Mine' where id = $1", [stored.id]), /permission denied/);
      await assert.rejects(queryAsUser(mark.userId, "delete from crm.chat_link_previews where id = $1", [stored.id]), /permission denied/);
    });

    it("serves the image through Orbit only to people who can see the message, judged from its bytes", async () => {
      const site = web(pages());
      const message = await post(mark, NEWS, site.transport);
      const [stored] = await rows(message.id);
      site.seen.length = 0;
      const image = await linkPreviewImage(sam, stored.id, site.transport);
      assert.equal(image.contentType, "image/png");
      assert.deepEqual([...image.bytes], [...PNG]);
      assert.deepEqual(site.seen, [COVER]);
      const response = previewImageResponse(image);
      assert.equal(response.headers.get("content-type"), "image/png");
      assert.equal(response.headers.get("x-content-type-options"), "nosniff");
      assert.match(response.headers.get("cache-control") ?? "", /^private, max-age=\d+$/);
      assert.match(response.headers.get("content-security-policy") ?? "", /sandbox/);
      assert.equal(response.headers.get("content-disposition"), "inline");
      assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [...PNG]);
    });

    it("refuses images that aren't plain pictures, are too big or sit on private addresses", async () => {
      const big = Buffer.alloc(2 * 1024 * 1024 + 10, 1);
      PNG.copy(big);
      const site = web({
        ...pages(),
        "https://img.example/vector.svg": { body: `<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>`, type: "image/svg+xml" },
        "https://img.example/vector-as-png": { body: `<svg xmlns="http://www.w3.org/2000/svg"/>`, type: "image/png" },
        "https://img.example/page.html": { body: "<html><script>alert(1)</script></html>", type: "text/html" },
        "https://img.example/page-as-png": { body: "<!doctype html><html></html>", type: "image/png" },
        "https://img.example/png-as-html": { body: PNG, type: "text/html" },
        "https://img.example/png-as-svg": { body: PNG, type: "image/svg+xml" },
        "https://img.example/big.png": { body: big, type: "image/png" },
        "https://img.example/unlabelled": { body: PNG, type: "application/octet-stream" },
        "https://img.example/jpeg-as-png": { body: JPEG, type: "image/png" },
        "https://img.example/to-private": { status: 302, location: "http://169.254.169.254/latest/meta-data" },
        "https://img.example/missing": { status: 404, body: "gone" },
      });
      const message = await post(mark, NEWS, site.transport);
      const [stored] = await rows(message.id);
      async function serve(url: string) {
        await sql("update crm.chat_link_previews set image_url = $2 where id = $1", [stored.id, url]);
        return linkPreviewImage(sam, stored.id, site.transport);
      }
      for (const url of [
        "https://img.example/vector.svg",
        "https://img.example/vector-as-png",
        "https://img.example/page.html",
        "https://img.example/page-as-png",
        "https://img.example/png-as-html",
        "https://img.example/png-as-svg",
        "https://img.example/big.png",
        "https://img.example/to-private",
        "https://img.example/missing",
        "http://10.0.0.5/cover.png",
        "https://localhost/cover.png",
        "https://[::1]/cover.png",
      ]) {
        await refused(serve(url), /not found/i);
      }
      assert.ok(!site.seen.includes("http://169.254.169.254/latest/meta-data"));
      assert.ok(!site.seen.includes("http://10.0.0.5/cover.png"));
      assert.equal((await serve("https://img.example/unlabelled")).contentType, "image/png");
      assert.equal((await serve("https://img.example/jpeg-as-png")).contentType, "image/jpeg");
      await sql("update crm.chat_link_previews set image_url = null where id = $1", [stored.id]);
      await refused(linkPreviewImage(sam, stored.id, site.transport), /not found/i);
    });

    it("never stores private addresses, other schemes or failed fetches, and shows no card for them", async () => {
      const site = web({ ...pages(), "https://hop.example/": { status: 302, location: "http://10.1.1.1/" } });
      const body = "https://hop.example/ http://insecure.example/a https://localhost/admin https://10.0.0.1/ https://gone.example/ ftp://old.example/x";
      const message = await post(mark, body, site.transport);
      assert.deepEqual(await rows(message.id), []);
      assert.ok(!site.seen.some((url) => url.includes("10.0.0.1") || url.includes("10.1.1.1") || url.includes("insecure") || url.includes("localhost")));
      assert.deepEqual(previewEvents(sam.userId), []);
    });

    it("gives hook, workflow and agent posts no previews, whatever is asked", async () => {
      const site = web(pages());
      const { hook, secret } = await createHook(mark, room, "Zapier");
      const hooked = await postViaHook({ hookId: hook.id, authorization: `Bearer ${secret}`, body: JSON.stringify({ text: `New lead ${NEWS}`, url: SHOP }) });
      await chatWorkSettled();
      assert.equal(await refreshLinkPreviews(hooked.id, site.transport), null);
      const workflow = await createWorkflow(mark, { name: "Won deals" });
      const viaFlow = await postMessage(mark, { conversationId: room, body: `Won ${NEWS}`, clientKey: key() }, { viaWorkflowId: workflow.id, linkPreviews: site.transport });
      const viaAgent = await postMessage(sam, { conversationId: room, body: `Agent says ${NEWS}`, clientKey: key() }, { charge: async () => undefined, linkPreviews: site.transport });
      const plain = await postMessage(sam, { conversationId: room, body: `Quiet ${NEWS}`, clientKey: key() });
      await chatWorkSettled();
      for (const id of [hooked.id, viaFlow.message.id, viaAgent.message.id, plain.message.id]) assert.deepEqual(await rows(id), [], id);
      for (const id of [hooked.id, viaFlow.message.id]) assert.equal(await refreshLinkPreviews(id, site.transport), null, id);
      assert.deepEqual(site.seen, []);
      const read = await listMessages(mark, room);
      assert.ok(read.messages.every((message) => message.previews.length === 0 || ![hooked.id, viaFlow.message.id, viaAgent.message.id, plain.message.id].includes(message.id)));
    });

    it("skips Orbit's own addresses so they can show record cards instead", async () => {
      const original = process.env.SITE_URL;
      process.env.SITE_URL = "https://orbit.test";
      try {
        const site = web(pages());
        const message = await post(mark, `https://orbit.test/companies/00000000-0000-4000-8000-000000000000 ${NEWS}`, site.transport);
        assert.deepEqual(site.seen.filter((url) => url !== COVER), [NEWS]);
        assert.equal((await rows(message.id)).length, 1);
      } finally {
        if (original === undefined) delete process.env.SITE_URL;
        else process.env.SITE_URL = original;
      }
    });

    it("fetches once for a retried send, and not at all for a duplicate key", async () => {
      const site = web(pages());
      const clientKey = key();
      await postMessage(mark, { conversationId: room, body: SHOP, clientKey }, { linkPreviews: site.transport });
      await chatWorkSettled();
      const calls = site.seen.length;
      const again = await postMessage(mark, { conversationId: room, body: SHOP, clientKey }, { linkPreviews: site.transport });
      await chatWorkSettled();
      assert.equal(again.duplicate, true);
      assert.equal(site.seen.length, calls);
      assert.deepEqual(again.message.previews.map((preview) => preview.url), [SHOP]);
    });

    it("refetches only when an edit changes the addresses, and drops a stale card at once", async () => {
      const site = web(pages());
      const message = await post(mark, `First ${NEWS}`, site.transport);
      const calls = site.seen.length;
      broadcasts = [];
      const reworded = await editMessage(mark, message.id, `First, reworded ${NEWS}`, { linkPreviews: site.transport });
      await chatWorkSettled();
      assert.equal(site.seen.length, calls);
      assert.deepEqual(reworded.previews.map((preview) => preview.url), [NEWS]);
      assert.deepEqual(previewEvents(sam.userId), []);

      broadcasts = [];
      const swapped = await editMessage(mark, message.id, `Now ${SHOP}`, { linkPreviews: site.transport });
      assert.deepEqual(swapped.previews, []);
      await chatWorkSettled();
      assert.deepEqual((await rows(message.id)).map((row) => row.url), [SHOP]);
      assert.deepEqual((await previewsOf(sam, message.id)).map((preview) => preview.title), ["Widgets"]);
      assert.deepEqual(previewEvents(sam.userId).map((event) => event.previews.map((preview) => preview.url)), [[SHOP]]);

      broadcasts = [];
      const plainer = await editMessage(mark, message.id, "No links any more", { linkPreviews: site.transport });
      await chatWorkSettled();
      assert.deepEqual(plainer.previews, []);
      assert.deepEqual(await rows(message.id), []);
      assert.deepEqual(previewEvents(mark.userId).map((event) => event.previews), [[]]);
    });

    async function postEditedDuringFetch(edited: string) {
      const slow = web(pages());
      const original = slow.transport.fetchImpl!;
      const clientKey = key();
      let edits = 0;
      slow.transport.fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
        if (String(input) === SHOP && edits === 0) {
          edits += 1;
          await sql("update crm.chat_messages set body = $2 where client_key = $1", [clientKey, edited]);
        }
        return original(input, init);
      }) as typeof fetch;
      const posted = await postMessage(mark, { conversationId: room, body: SHOP, clientKey }, { linkPreviews: slow.transport });
      await chatWorkSettled();
      return { slow, id: posted.message.id };
    }

    it("keeps the preview when the text is edited while it loads, without fetching the page twice", async () => {
      const { slow, id } = await postEditedDuringFetch(`${SHOP} with a note`);
      assert.deepEqual((await rows(id)).map((row) => row.url), [SHOP]);
      assert.deepEqual((await previewsOf(sam, id)).map((preview) => preview.title), ["Widgets"]);
      assert.equal(slow.seen.filter((url) => url === SHOP).length, 1);
      assert.equal(previewEvents(sam.userId).length, 1);
    });

    it("shows no preview when the edit made while it loads removed the link", async () => {
      const { id } = await postEditedDuringFetch("Changed my mind");
      assert.deepEqual(await rows(id), []);
      assert.deepEqual(await previewsOf(sam, id), []);
      assert.deepEqual(previewEvents(sam.userId), []);
    });

    it("fetches the new link when the edit made while it loads swapped it", async () => {
      const { id } = await postEditedDuringFetch(NEWS);
      assert.deepEqual((await rows(id)).map((row) => row.url), [NEWS]);
    });

    it("lets only the author remove a preview, and keeps it removed through edits", async () => {
      const site = web(pages());
      const message = await post(mark, `${NEWS} ${SHOP}`, site.transport);
      const [news, shop] = await rows(message.id);
      for (const other of [sam, priya, ada, olly]) await refused(removeLinkPreview(other, news.id), /not found/i);
      await refused(removeLinkPreview(mark, "nonsense"), /not found/i);
      assert.equal((await rows(message.id)).filter((row) => row.hidden).length, 0);
      broadcasts = [];
      await removeLinkPreview(mark, news.id);
      await chatWorkSettled();
      assert.deepEqual((await previewsOf(sam, message.id)).map((preview) => preview.url), [SHOP]);
      assert.deepEqual(previewEvents(sam.userId).map((event) => event.previews.map((preview) => preview.url)), [[SHOP]]);
      assert.deepEqual(previewEvents(priya.userId), []);
      const removed = (await rows(message.id)).find((row) => row.id === news.id)!;
      assert.equal(removed.hidden, true);
      assert.equal(removed.title, null);
      assert.equal(removed.image_url, null);
      await refused(removeLinkPreview(mark, news.id), /not found/i);
      assert.deepEqual(await queryAsUser(sam.userId, "select id from crm.chat_link_previews where id = $1", [news.id]), []);
      await refused(linkPreviewImage(sam, news.id, site.transport), /not found/i);

      const calls = site.seen.length;
      await editMessage(mark, message.id, `Edited ${NEWS} ${SHOP}`, { linkPreviews: site.transport });
      await chatWorkSettled();
      assert.equal(site.seen.length, calls);
      assert.deepEqual((await previewsOf(mark, message.id)).map((preview) => preview.id), [shop.id]);
    });

    it("stops removals in an archived room and when the author has left it", async () => {
      const archived = (await createRoom(mark, { name: "old-deals", memberIds: [sam.userId] })).id;
      const site = web(pages());
      const message = await post(mark, SHOP, site.transport, archived);
      const [stored] = await rows(message.id);
      await setMessageSaved(mark, message.id, true);
      assert.equal((await listSaved(mark)).items.find((item) => item.message.id === message.id)!.conversation.archived, false);
      await setRoomArchived(mark, archived, true);
      assert.equal((await listSaved(mark)).items.find((item) => item.message.id === message.id)!.conversation.archived, true);
      await refused(removeLinkPreview(mark, stored.id), /archived/i);
      assert.equal((await rows(message.id))[0].hidden, false);
      await sql("update crm.chat_conversations set archived_at = null where id = $1", [archived]);
      await sql("delete from crm.chat_members where conversation_id = $1 and user_id = $2", [archived, mark.userId]);
      await refused(removeLinkPreview(mark, stored.id), /not found/i);
    });

    it("removes previews with the message and shows none for a deleted one", async () => {
      const site = web(pages());
      const message = await post(mark, `${NEWS}`, site.transport);
      const [stored] = await rows(message.id);
      await deleteMessage(mark, message.id);
      assert.deepEqual(await rows(message.id), []);
      await refused(linkPreviewImage(sam, stored.id, site.transport), /not found/i);
    });

    it("previews replies in a thread and direct messages, with the thread's id on the event", async () => {
      const site = web(pages());
      const root = await post(mark, "Question about the outage", site.transport);
      broadcasts = [];
      const reply = await post(sam, `Their report: ${NEWS}`, site.transport, room, root.id);
      assert.deepEqual((await listThread(mark, root.id)).replies.find((item) => item.id === reply.id)!.previews.map((preview) => preview.url), [NEWS]);
      const events = previewEvents(mark.userId);
      assert.equal(events.length, 1);
      assert.equal(events[0].parentId, root.id);
      assert.equal(events[0].messageId, reply.id);

      const dm = await openDm(mark, sam.userId);
      const direct = await post(mark, SHOP, site.transport, dm.id);
      assert.deepEqual((await previewsOf(sam, direct.id, dm.id)).map((preview) => preview.title), ["Widgets"]);
      await refused(listMessages(priya, dm.id), /not found/i);
      assert.deepEqual(await queryAsUser(priya.userId, "select id from crm.chat_link_previews where message_id = $1", [direct.id]), []);
    });

    it("follows the subject's own rules in task and doc discussions, admins included", async () => {
      const site = web(pages());
      const task = (await createTask(mark, { title: "Send Halden pricing", ownerId: sam.userId })).body.task;
      const { conversationId } = await openDiscussion(sam, { kind: "task", id: task.id });
      const message = await post(sam, `Their page ${NEWS}`, site.transport, conversationId);
      const forMark = (await getDiscussion(mark, { kind: "task", id: task.id })).page!.messages.find((item) => item.id === message.id)!;
      assert.equal(forMark.previews.length, 1);
      const [stored] = await rows(message.id);
      for (const outsider of [priya, ada, olly]) {
        assert.deepEqual(await queryAsUser(outsider.userId, "select id from crm.chat_link_previews where message_id = $1", [message.id]), [], outsider.email);
        await refused(linkPreviewImage(outsider, stored.id, site.transport), /not found/i);
      }
      assert.equal(previewEvents(priya.userId).length + previewEvents(ada.userId).length, 0);
      assert.ok(previewEvents(sam.userId).length >= 1);

      const doc = await createDoc(mark, { title: "Pricing notes", content: "x", shared: true }, { operation: "previews_test", source: "test" });
      const { conversationId: docTalk } = await openDiscussion(mark, { kind: "doc", id: doc.id });
      const note = await post(mark, SHOP, site.transport, docTalk);
      for (const colleague of [sam, priya, ada]) {
        assert.equal((await queryAsUser(colleague.userId, "select id from crm.chat_link_previews where message_id = $1", [note.id])).length, 1, colleague.email);
      }
      await shareDoc(mark, doc.id, false, { operation: "previews_test", source: "test" });
      for (const outsider of [sam, priya, ada, olly]) {
        assert.deepEqual(await queryAsUser(outsider.userId, "select id from crm.chat_link_previews where message_id = $1", [note.id]), [], outsider.email);
      }
    });

    it("keeps previews out of what agents read", async () => {
      const site = web(pages());
      const message = await post(mark, NEWS, site.transport);
      const read = (await listMessages(sam, room)).messages.find((item) => item.id === message.id)!;
      assert.equal(read.previews.length, 1);
      const text = JSON.stringify(chatMessage(read));
      assert.ok(!text.includes("Outage report"));
      assert.ok(!text.includes("previews"));
    });

    it("shows previews in Saved too", async () => {
      const site = web(pages());
      const message = await post(mark, SHOP, site.transport);
      await setMessageSaved(sam, message.id, true);
      const saved = await listSaved(sam);
      assert.deepEqual(saved.items.find((item) => item.message.id === message.id)!.message.previews.map((preview) => preview.title), ["Widgets"]);
    });

    it("applies twice without error and keeps the table behind row-level security", async () => {
      const migration = readFileSync("supabase/migrations/20270228120000_chat_link_previews.sql", "utf8");
      await applyMigrationSql(getAdminPool(), migration);
      await applyMigrationSql(getAdminPool(), migration);
      const flags = await sql("select relrowsecurity, relforcerowsecurity from pg_class where oid = 'crm.chat_link_previews'::regclass");
      assert.deepEqual(flags.rows[0], { relrowsecurity: true, relforcerowsecurity: true });
      const grants = await sql("select privilege_type from information_schema.role_table_grants where table_schema = 'crm' and table_name = 'chat_link_previews' and grantee = 'authenticated'");
      assert.deepEqual(grants.rows, [{ privilege_type: "SELECT" }]);
    });
  });

  describe("record cards", () => {
    useServerlessPool();

    it("draw each card from the viewer's own access and say nothing about records they can't open", async () => {
      const company = (await createCompany(mark, { name: "Halden Group", domain: "halden.test" })).body.company.id;
      const contact = (await createContact(mark, { firstName: "Jane", lastName: "Doe", companyId: company, jobTitle: "Buyer" })).body.contact.id;
      const deal = (await createOpportunity(mark, { companyId: company, name: "Halden renewal", value: 48000, currency: "GBP" })).body.opportunity.id;
      const refs = [
        { kind: "company" as const, id: company },
        { kind: "contact" as const, id: contact },
      ];
      const cards = await listRecordCards(sam, refs);
      assert.deepEqual(
        cards.map((card) => [card.kind, card.title, card.href]),
        [
          ["company", "Halden Group", `/companies/${company}`],
          ["contact", "Jane Doe", `/contacts/${contact}`],
        ],
      );
      assert.equal(cards[1].subtitle, "Buyer at Halden Group");
      const [dealCard] = await listRecordCards(sam, [{ kind: "opportunity", id: deal }]);
      assert.equal(dealCard.title, "Halden renewal");
      assert.equal(dealCard.subtitle, "Halden Group");
      assert.equal(dealCard.figure, "£48,000");
      assert.deepEqual(await listRecordCards(olly, [...refs, { kind: "opportunity", id: deal }]), []);
      await sql("update crm.companies set archived_at = now() where id = $1", [company]);
      assert.deepEqual((await listRecordCards(sam, refs)).map((card) => card.kind), ["contact"]);
      await sql("update crm.companies set archived_at = null where id = $1", [company]);
    });

    it("follow task privacy and doc sharing, so a card never shows a title the viewer couldn't read", async () => {
      const task = (await createTask(mark, { title: "Quietly renegotiate Halden", ownerId: sam.userId })).body.task;
      const ref = { kind: "task" as const, id: task.id };
      assert.equal((await listRecordCards(mark, [ref]))[0].title, "Quietly renegotiate Halden");
      assert.equal((await listRecordCards(sam, [ref]))[0].href, `/tasks?task=${task.id}`);
      for (const outsider of [priya, ada, olly]) assert.deepEqual(await listRecordCards(outsider, [ref]), [], outsider.email);

      const doc = await createDoc(mark, { title: "Pricing review", content: "x", shared: false }, { operation: "previews_test", source: "test" });
      const docRef = { kind: "doc" as const, id: doc.id };
      assert.equal((await listRecordCards(mark, [docRef]))[0].title, "Pricing review");
      for (const outsider of [sam, priya, ada, olly]) assert.deepEqual(await listRecordCards(outsider, [docRef]), [], outsider.email);
    });

    it("accept only well-formed requests for up to two records", () => {
      const id = "11111111-1111-4111-8111-111111111111";
      assert.deepEqual(cleanRecordRefs([`company:${id.toUpperCase()}`, `company:${id}`]), [{ kind: "company", id }]);
      assert.deepEqual(cleanRecordRefs([]), []);
      for (const bad of [["company"], ["nope:" + id], ["company:x"], [`company:${id}`, `contact:${id}`, `task:${id}`], [4]]) {
        assert.throws(() => cleanRecordRefs(bad), (error: unknown) => error instanceof CrmError && error.status === 400);
      }
    });
  });
});
