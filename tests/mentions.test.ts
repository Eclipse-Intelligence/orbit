import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { getConversation, listConversations, sendMessage, type AssistantEvent } from "@/lib/assistant/chat";
import { createCompany } from "@/lib/crm/companies";
import type { UserActor } from "@/lib/crm/types";
import { getPool } from "@/lib/db/pool";
import { encodeMentions, expandMentions, liveMentions, mentionsIn, plainMentions, splitMentions } from "@/lib/mentions";
import { createUser, resetDatabase } from "./helpers";

const JANE = { kind: "contact" as const, id: "11111111-1111-4111-8111-111111111111", name: "Jane Doe" };
const ACME = { kind: "company" as const, id: "22222222-2222-4222-8222-222222222222", name: "Acme" };
const ACME_LTD = { kind: "company" as const, id: "33333333-3333-4333-8333-333333333333", name: "Acme Ltd" };

describe("mention tokens", () => {
  it("encodes typed @names, keeps only the ones still in the text and round-trips", () => {
    const typed = "Email @Jane Doe about the @Acme Ltd renewal";
    const live = liveMentions(typed, [JANE, ACME_LTD, { ...ACME, name: "Globex" }]);
    assert.deepEqual(live.map((mention) => mention.name), ["Jane Doe", "Acme Ltd"]);
    const encoded = encodeMentions(typed, [...live, ACME]);
    assert.equal(
      encoded,
      `Email @[Jane Doe](contact:${JANE.id}) about the @[Acme Ltd](company:${ACME_LTD.id}) renewal`,
    );
    assert.deepEqual(mentionsIn(encoded), [JANE, ACME_LTD]);
    assert.equal(plainMentions(encoded), typed);
    assert.equal(expandMentions(encoded), `Email Jane Doe [person id ${JANE.id}] about the Acme Ltd [company id ${ACME_LTD.id}] renewal`);
    assert.deepEqual(splitMentions("no tags here"), [{ text: "no tags here" }]);
    assert.equal(encodeMentions("@Acme and @Acme", [ACME]), `@[Acme](company:${ACME.id}) and @Acme`);
  });
});

describe("assistant with tagged records", () => {
  let owner: UserActor;

  before(async () => {
    await resetDatabase();
    owner = await createUser("mentions@orbit.test", "Mark Ridgeon");
  });

  after(async () => {
    await getPool().end();
  });

  it("gives the model the exact ids and keeps the chat title readable", async () => {
    process.env.LLM_API_KEY = "test-key";
    const company = (await createCompany(owner, { name: "Initech", domain: "initech-mention.test" })).body.company;
    const requests: { messages: { role: string; content: string }[] }[] = [];
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ model: "claude-sonnet-5-5", choices: [{ message: { role: "assistant", content: "On it." } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    const events: AssistantEvent[] = [];
    const message = encodeMentions("How is @Initech doing?", [{ kind: "company", id: company.id, name: "Initech" }]);
    await sendMessage(owner, { message, model: "claude-sonnet-5-5", reasoning: "low", webSearch: false }, (event) => events.push(event), {
      deadline: Date.now() + 60_000,
      fetchImpl,
    });
    const sent = requests[0].messages;
    assert.equal(sent.at(-1)?.content, `How is Initech [company id ${company.id}] doing?`);
    assert.match(sent[0].content, /tags a record with @/);
    const conversations = await listConversations(owner);
    assert.equal(conversations[0].title, "How is @Initech doing?");
    const saved = await getConversation(owner, conversations[0].id);
    assert.equal(saved.messages[0].content, message);
    delete process.env.LLM_API_KEY;
  });
});
