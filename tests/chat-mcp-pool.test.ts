import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { consumeChatPostLimit } from "@/lib/auth/rate-limit";
import { postChat } from "@/lib/chat/tools";
import { chatWorkSettled, createRoom } from "@/lib/crm/chat";
import type { UserActor } from "@/lib/crm/types";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { setLiveTesting } from "@/lib/docs/live/broadcast";
import { createUser, resetDatabase } from "./helpers";

process.env.VERCEL = "1";

after(async () => {
  setLiveTesting(null);
  await getPool().end();
});

describe("MCP Chat posts on the serverless pool", () => {
  let people: UserActor[];

  before(async () => {
    await resetDatabase();
    const owner = await createUser("owner@mcp-pool.test", "Owner Person");
    people = [owner];
    for (const name of ["Ann", "Ben", "Cal"]) {
      const user = await createUser(`${name.toLowerCase()}@mcp-pool.test`, `${name} Pool`);
      await getAdminPool().query("insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, 'member')", [owner.workspaceId, user.userId]);
      people.push({ ...user, workspaceId: owner.workspaceId, role: "member" });
    }
    setLiveTesting({ batch: async () => {} });
  });

  it("charges the post limit outside the transaction, so parallel posts never wait on a second connection", async () => {
    assert.equal(getPool().options.max, 2);
    const [owner, ...others] = people;
    const room = (await createRoom(owner, { name: "pool", memberIds: others.map((person) => person.userId) })).id;
    const charged = (person: UserActor) => ({ charge: () => consumeChatPostLimit(person.userId) });
    const posts = await Promise.all([
      ...people.map((person, index) => postChat(person, { conversationId: room, text: `Post ${index}`, key: `pool-${index}` }, charged(person))),
      postChat(owner, { person: others[0].email, text: "Direct", key: "pool-dm" }, charged(owner)),
      postChat(others[1], { person: owner.userId, text: "Back", key: "pool-dm-back" }, charged(others[1])),
    ]);
    assert.equal(posts.length, 6);
    assert.ok(posts.every((post) => post.posted));
    const repeats = await Promise.all(people.map((person, index) => postChat(person, { conversationId: room, text: `Post ${index}`, key: `pool-${index}` }, charged(person))));
    assert.ok(repeats.every((post) => post.duplicate));
    await chatWorkSettled();
  });
});
