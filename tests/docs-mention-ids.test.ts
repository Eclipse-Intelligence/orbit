import "./svg-stub";
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { UserActor } from "@/lib/crm/types";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { createDoc, getDoc, saveDoc } from "@/lib/docs/store";
import { createUser, resetDatabase, useServerlessPool } from "./helpers";

let mark: UserActor;

const MALFORMED = [
  "------------------------------------",
  "0000000000000000000000000000000000-0",
  "11111111-2222-4333-8444-55555555555-",
  "11111111-2222-4333-84445-5555555555",
  "zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz",
];

before(async () => {
  await resetDatabase();
  mark = await createUser("mark@docs-mentions.test", "Mark Ridgeon");
});

after(async () => {
  await getPool().end();
  await getAdminPool().end();
});

describe("A malformed mention id never blocks saving a note", () => {
  useServerlessPool();

  it("keeps creating and saving notes that carry one, for every kind", async () => {
    for (const id of MALFORMED) {
      const body = ["company", "contact", "task", "opportunity", "proposal"].map((kind) => `@[Name](${kind}:${id})`).join(" ");
      const doc = await createDoc(mark, { title: `Malformed ${id.slice(0, 6)}`, content: `${body} @[Person](member:${id})` });
      const saved = await saveDoc(mark, doc.id, { content: `${body} and more @[Person](member:${id})` });
      assert.ok(saved.content.startsWith(`${body} and more`));
      assert.deepEqual((await getDoc(mark, doc.id)).mentions ?? [], []);
    }
  });

  it("still indexes a well formed mention", async () => {
    const id = "11111111-2222-4333-8444-555555555555";
    const doc = await createDoc(mark, { title: "Well formed", content: `@[Acme](company:${id}) and @[Bad](company:------------------------------------)` });
    const read = await getDoc(mark, doc.id);
    assert.deepEqual((read.mentions ?? []).map((mention: { id: string }) => mention.id), [id]);
  });
});
