import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { chatWorkSettled, createRoom, editMessage, postMessage } from "@/lib/crm/chat";
import type { UserActor } from "@/lib/crm/types";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { setLiveTesting } from "@/lib/docs/live/broadcast";
import { createUser, resetDatabase } from "./helpers";

process.env.VERCEL = "1";

after(async () => {
  setLiveTesting(null);
  await getPool().end();
});

describe("chat on the serverless pool", () => {
  let people: UserActor[];

  before(async () => {
    await resetDatabase();
    const owner = await createUser("owner@pool.test", "Owner Person");
    people = [owner];
    for (const name of ["Ann", "Ben", "Cal"]) {
      const user = await createUser(`${name.toLowerCase()}@pool.test`, `${name} Pool`);
      await getAdminPool().query("insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, 'member')", [owner.workspaceId, user.userId]);
      people.push({ ...user, workspaceId: owner.workspaceId, role: "member" });
    }
    setLiveTesting({ batch: async () => {} });
  });

  it("edits replies at once without waiting on a second connection", async () => {
    assert.equal(getPool().options.max, 2);
    const [owner, ...others] = people;
    const room = (await createRoom(owner, { name: "pool", memberIds: others.map((person) => person.userId) })).id;
    const root = (await postMessage(owner, { conversationId: room, body: "Root", clientKey: "pool-root" })).message.id;
    const replies = await Promise.all(people.map((person, index) => postMessage(person, { conversationId: room, parentId: root, body: `Reply ${index}`, clientKey: `pool-reply-${index}` })));
    await chatWorkSettled();
    const edited = await Promise.all(
      replies.map((reply, index) => editMessage(people[index], reply.message.id, `Reply ${index} @[${people[(index + 1) % people.length].fullName}](member:${people[(index + 1) % people.length].userId})`)),
    );
    assert.equal(edited.length, 4);
    await chatWorkSettled();
  });
});
