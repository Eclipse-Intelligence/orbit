import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describeAction, recordNames } from "@/lib/assistant/tools";
import { getAdminPool, getPool, type Db } from "@/lib/db/pool";
import { logActivity } from "@/lib/crm/activities";
import { archiveCompany, createCompany } from "@/lib/crm/companies";
import { archiveContact, createContact, updateContact } from "@/lib/crm/contacts";
import { CrmError } from "@/lib/crm/errors";
import { mergeCompanies, mergeContacts } from "@/lib/crm/merge";
import { createOpportunity } from "@/lib/crm/opportunities";
import { scopesForRole } from "@/lib/crm/scopes";
import { createTask } from "@/lib/crm/tasks";
import type { AgentActor, UserActor } from "@/lib/crm/types";
import { registerOperationTools } from "@/server/mcp/operations";
import { createAgent, createUser, resetDatabase } from "./helpers";

const PROVENANCE = { operation: "merge_test", source: "test" };

let owner: UserActor;
let member: UserActor;
let outsider: UserActor;
let agent: AgentActor;

async function admin<T extends Record<string, unknown>>(text: string, values: unknown[] = []) {
  const result = await getAdminPool().query<T>(text, values);
  return result.rows;
}

async function company(name: string, extra: Record<string, unknown> = {}) {
  return (await createCompany(owner, { name, ...extra }, { provenance: PROVENANCE })).body.company;
}

async function contact(input: Record<string, unknown>) {
  return (await createContact(owner, input, { provenance: PROVENANCE })).body.contact;
}

function isCrmError(code: string, pattern?: RegExp) {
  return (error: unknown) => {
    assert.ok(error instanceof CrmError, String(error));
    assert.equal(error.code, code);
    if (pattern) assert.match(error.message, pattern);
    return true;
  };
}

before(async () => {
  await resetDatabase();
  owner = await createUser("owner@merge.test", "Olivia Owner");
  const second = await createUser("member@merge.test", "Max Member");
  await admin("insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, 'member')", [
    owner.workspaceId,
    second.userId,
  ]);
  member = { ...second, workspaceId: owner.workspaceId, role: "member", scopes: scopesForRole("member") };
  outsider = await createUser("outsider@merge.test", "Oscar Outsider");
  agent = (await createAgent(owner.workspaceId, ["crm:read", "companies:write", "contacts:write", "tasks:write"], "Merge bot")).actor;
});

async function mcpClient(actor: AgentActor) {
  const server = new McpServer({ name: "test", version: "1.0.0" });
  registerOperationTools(server, actor);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(clientSide);
  return client;
}

async function callTool(client: Client, name: string, args: Record<string, unknown>) {
  const result = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
  assert.ok(!result.isError, result.content[0].text);
  return JSON.parse(result.content[0].text) as Record<string, unknown>;
}

async function agentSession<T>(actor: AgentActor, fn: (db: Db) => Promise<T>) {
  const client = await getPool().connect();
  try {
    await client.query("begin");
    await client.query(
      "select set_config('app.workspace_id', $1, true), set_config('app.agent_id', $2, true), set_config('app.actor_type', 'agent', true)",
      [actor.workspaceId, actor.agentId],
    );
    await client.query("set local role crm_agent");
    return await fn(client);
  } finally {
    await client.query("rollback");
    client.release();
  }
}

after(async () => {
  await getPool().end();
  await getAdminPool().end();
});

describe("merging companies", () => {
  it("moves every reference to the kept company, fills gaps, unions tags and archives the duplicate", async () => {
    const keep = await company("Acme", { tags: ["client", "uk"] });
    const dupe = await company("Acme Ltd", {
      domain: "acme-merge.test",
      website: "https://acme-merge.test",
      industry: "Manufacturing",
      tags: ["uk", "priority"],
    });
    const other = await company("Elsewhere");
    const jane = await contact({ firstName: "Jane", lastName: "Doe", companyId: dupe.id });
    const sam = await contact({ firstName: "Sam", lastName: "Hill", companyId: dupe.id });
    const task = (await createTask(owner, { title: "Send pricing", companyId: dupe.id, contactId: jane.id }, { provenance: PROVENANCE })).body.task;
    const note = await logActivity(owner, { companyId: dupe.id, contactId: jane.id }, "note", "", "Intro call went well");
    const samNote = await logActivity(owner, { companyId: dupe.id, contactId: sam.id }, "note", "", "Sam asked for a deck");
    await updateContact(owner, sam.id, { companyId: other.id }, { provenance: PROVENANCE });
    const deal = (await createOpportunity(owner, { companyId: dupe.id, name: "Acme rollout", primaryContactId: jane.id }, { provenance: PROVENANCE })).body.opportunity;
    const [knowledge] = await admin<{ id: string }>(
      `insert into crm.knowledge_items (workspace_id, scope, company_id, kind, title)
       values ($1, 'company', $2, 'link', 'Acme deck') returning id`,
      [owner.workspaceId, dupe.id],
    );
    await admin("insert into crm.company_web_state (company_id, workspace_id, icp_score) values ($1, $2, 3)", [dupe.id, owner.workspaceId]);

    const result = await mergeCompanies(member, keep.id, dupe.id, PROVENANCE);

    assert.equal(result.kept.id, keep.id);
    assert.equal(result.kept.name, "Acme");
    assert.equal(result.kept.domain, "acme-merge.test");
    assert.equal(result.kept.website, "https://acme-merge.test/");
    assert.equal(result.kept.industry, "Manufacturing");
    assert.deepEqual(result.kept.tags, ["client", "uk", "priority"]);
    assert.ok(result.merged.archivedAt);
    assert.ok(result.filled.includes("domain"));
    assert.ok(result.filled.includes("industry"));
    assert.equal(result.moved.contacts, 1);
    assert.equal(result.moved.tasks, 1);
    assert.equal(result.moved.activities, 2);
    assert.equal(result.moved.opportunities, 1);
    assert.equal(result.moved.knowledge_items, 1);

    const [moved] = await admin<{ contact: string; task: string; note: string; sam_note: string; deal: string; knowledge: string; web: number }>(
      `select
         (select company_id::text from crm.contacts where id = $1) as contact,
         (select company_id::text from crm.tasks where id = $2) as task,
         (select company_id::text from crm.activities where id = $3) as note,
         (select company_id::text from crm.activities where id = $4) as sam_note,
         (select company_id::text from crm.opportunities where id = $5) as deal,
         (select company_id::text from crm.knowledge_items where id = $6) as knowledge,
         (select count(*)::int from crm.company_web_state where company_id = $7) as web`,
      [jane.id, task.id, note.id, samNote.id, deal.id, knowledge.id, keep.id],
    );
    assert.deepEqual(moved, {
      contact: keep.id,
      task: keep.id,
      note: keep.id,
      sam_note: keep.id,
      deal: keep.id,
      knowledge: keep.id,
      web: 1,
    });
    const [sam2] = await admin<{ company_id: string }>("select company_id from crm.contacts where id = $1", [sam.id]);
    assert.equal(sam2.company_id, other.id);

    const [stillThere] = await admin<{ archived_at: Date | null }>("select archived_at from crm.companies where id = $1", [dupe.id]);
    assert.ok(stillThere.archived_at);

    const [audit] = await admin<{ changes: Record<string, unknown>; actor_user_id: string }>(
      "select changes, actor_user_id from crm.audit_events where event_type = 'company.merged' and entity_id = $1",
      [keep.id],
    );
    assert.equal(audit.actor_user_id, member.userId);
    assert.equal(audit.changes.mergedId, dupe.id);
    assert.equal(audit.changes.keptId, keep.id);
    assert.equal(audit.changes.webState, "moved");
    const auditMoved = audit.changes.moved as Record<string, unknown>;
    assert.equal(auditMoved.tasks, 1);
    assert.equal(auditMoved.activities, 2);
    assert.ok(Object.values(auditMoved).every((value) => typeof value === "number"));
    assert.equal(audit.changes.counts, undefined);
    assert.deepEqual(((audit.changes.before as Record<string, Record<string, unknown>>).kept).tags, ["client", "uk"]);
    assert.equal(((audit.changes.before as Record<string, Record<string, unknown>>).kept).domain, null);
    assert.ok((audit.changes.filled as string[]).includes("website"));

    const archivedEvents = await admin<{ changes: Record<string, unknown>; actor_user_id: string }>(
      "select changes, actor_user_id from crm.audit_events where event_type = 'company.archived' and entity_id = $1",
      [dupe.id],
    );
    assert.equal(archivedEvents.length, 1);
    assert.equal(archivedEvents[0].actor_user_id, member.userId);
    assert.equal(archivedEvents[0].changes.mergedInto, keep.id);
    assert.ok((archivedEvents[0].changes.after as Record<string, unknown>).archivedAt);
  });

  it("keeps the kept company's web state when both have one", async () => {
    const keep = await company("Globex");
    const dupe = await company("Globex Systems");
    await admin("insert into crm.company_web_state (company_id, workspace_id, icp_score) values ($1, $3, 4), ($2, $3, 1)", [
      keep.id,
      dupe.id,
      owner.workspaceId,
    ]);
    await mergeCompanies(owner, keep.id, dupe.id, PROVENANCE);
    const rows = await admin<{ company_id: string; icp_score: number }>(
      "select company_id, icp_score from crm.company_web_state where company_id = any($1::uuid[]) order by icp_score",
      [[keep.id, dupe.id]],
    );
    assert.deepEqual(rows, [
      { company_id: dupe.id, icp_score: 1 },
      { company_id: keep.id, icp_score: 4 },
    ]);
  });

  it("refuses a merge with itself, another workspace or an archived company", async () => {
    const keep = await company("Initech");
    const dupe = await company("Initech UK");
    const person = await contact({ firstName: "Pat", companyId: dupe.id });
    const foreign = (await createCompany(outsider, { name: "Initech" }, { provenance: PROVENANCE })).body.company;
    const archived = await company("Initech Old");
    await archiveCompany(owner, archived.id, { provenance: PROVENANCE });

    await assert.rejects(mergeCompanies(owner, keep.id, keep.id, PROVENANCE), isCrmError("invalid_input", /different company/));
    await assert.rejects(mergeCompanies(owner, keep.id, foreign.id, PROVENANCE), isCrmError("not_found", /isn't in this workspace/));
    await assert.rejects(mergeCompanies(owner, foreign.id, dupe.id, PROVENANCE), isCrmError("not_found"));
    await assert.rejects(mergeCompanies(owner, keep.id, archived.id, PROVENANCE), isCrmError("invalid_input", /Initech Old is already archived/));
    await assert.rejects(mergeCompanies(owner, archived.id, dupe.id, PROVENANCE), isCrmError("invalid_input", /Initech Old is archived/));

    const [unchanged] = await admin<{ company_id: string; archived_at: Date | null }>(
      "select p.company_id, c.archived_at from crm.contacts p join crm.companies c on c.id = $2 where p.id = $1",
      [person.id, dupe.id],
    );
    assert.equal(unchanged.company_id, dupe.id);
    assert.equal(unchanged.archived_at, null);
  });

  it("only relaxes the company link check inside a merge", async () => {
    const here = await company("Umbrella");
    const there = await company("Umbrella Health");
    const person = await contact({ firstName: "Lee", companyId: there.id });
    const task = (await createTask(owner, { title: "Call Lee", companyId: there.id, contactId: person.id }, { provenance: PROVENANCE })).body.task;
    const client = await getPool().connect();
    try {
      await client.query("begin");
      await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: owner.userId, role: "authenticated" })]);
      await client.query("set local role authenticated");
      await client.query("select set_config('orbit.merging', 'on', true)");
      await assert.rejects(
        client.query("update crm.tasks set company_id = $1 where id = $2", [here.id, task.id]),
        /contact belongs to a different company/,
      );
    } finally {
      await client.query("rollback");
      client.release();
    }
  });
});

describe("merging companies as an agent", () => {
  it("merges through the MCP tool and records the agent on both audit events", async () => {
    const keep = await company("Hooli");
    const dupe = await company("Hooli Inc", { domain: "hooli-merge.test" });
    const person = await contact({ firstName: "Gavin", companyId: dupe.id });
    const client = await mcpClient(agent);
    try {
      const result = await callTool(client, "merge_companies", { keep_id: keep.id, merge_id: dupe.id, provenanceSource: "mcp-test" });
      assert.equal((result.kept as { id: string }).id, keep.id);
      assert.equal((result.kept as { domain: string }).domain, "hooli-merge.test");
      assert.ok((result.merged as { archivedAt: string | null }).archivedAt);
      assert.equal((result.moved as Record<string, number>).contacts, 1);
    } finally {
      await client.close();
    }
    const [moved] = await admin<{ company_id: string }>("select company_id from crm.contacts where id = $1", [person.id]);
    assert.equal(moved.company_id, keep.id);
    const events = await admin<{ event_type: string; entity_id: string; actor_type: string; actor_agent_id: string; source: string }>(
      `select event_type, entity_id, actor_type, actor_agent_id, source from crm.audit_events
       where event_type in ('company.merged', 'company.archived') and entity_id = any($1::uuid[]) order by event_type`,
      [[keep.id, dupe.id]],
    );
    assert.deepEqual(
      events.map((event) => [event.event_type, event.entity_id, event.actor_type, event.actor_agent_id, event.source]),
      [
        ["company.archived", dupe.id, "agent", agent.agentId, "mcp-test"],
        ["company.merged", keep.id, "agent", agent.agentId, "mcp-test"],
      ],
    );
  });

  it("merges people through the MCP tool", async () => {
    const keep = await contact({ firstName: "Dana", email: "dana@merge.test" });
    const dupe = await contact({ firstName: "Dana", lastName: "Scully", jobTitle: "Agent" });
    const note = await logActivity(owner, { contactId: dupe.id }, "note", "", "Met Dana");
    const client = await mcpClient(agent);
    try {
      const result = await callTool(client, "merge_contacts", { keep_id: keep.id, merge_id: dupe.id });
      assert.equal((result.kept as { lastName: string }).lastName, "Scully");
      assert.equal((result.moved as Record<string, number>).activities, 1);
    } finally {
      await client.close();
    }
    const [moved] = await admin<{ contact_id: string }>("select contact_id from crm.activities where id = $1", [note.id]);
    assert.equal(moved.contact_id, keep.id);
  });

  it("refuses an agent without write access", async () => {
    const reader = (await createAgent(owner.workspaceId, ["crm:read"], "Reader")).actor;
    const keep = await company("Pied Piper");
    const dupe = await company("Raviga");
    await assert.rejects(mergeCompanies(reader, keep.id, dupe.id, PROVENANCE), isCrmError("forbidden"));
  });

  it("doesn't let an agent session use the merge exemption", async () => {
    const here = await company("Wayne");
    const there = await company("Wayne Enterprises");
    const person = await contact({ firstName: "Lucius", companyId: there.id });
    const task = (await createTask(owner, { title: "Call Lucius", companyId: there.id, contactId: person.id }, { provenance: PROVENANCE })).body.task;
    await agentSession(agent, async (db) => {
      await db.query("select set_config('orbit.merging', 'on', true)");
      await assert.rejects(db.query("update crm.tasks set company_id = $1 where id = $2", [here.id, task.id]), /contact belongs to a different company/);
    });
  });
});

describe("merge safety", () => {
  it("rolls back every move when a later step fails", async () => {
    const keep = await company("Stark");
    const dupe = await company("Stark Industries", { industry: "Defence" });
    const person = await contact({ firstName: "Pepper", companyId: dupe.id });
    const task = (await createTask(owner, { title: "Call Pepper", companyId: dupe.id, contactId: person.id }, { provenance: PROVENANCE })).body.task;
    const note = await logActivity(owner, { companyId: dupe.id, contactId: person.id }, "note", "", "Suit demo");
    await admin(
      `alter table crm.companies add constraint merge_test_no_defence
       check (id <> '${keep.id}'::uuid or industry is distinct from 'Defence') not valid`,
    );
    try {
      await assert.rejects(mergeCompanies(owner, keep.id, dupe.id, PROVENANCE), /merge_test_no_defence/);
    } finally {
      await admin("alter table crm.companies drop constraint if exists merge_test_no_defence");
    }
    const [state] = await admin<{ contact: string; task: string; note: string; archived: Date | null; industry: string | null; events: number }>(
      `select
         (select company_id::text from crm.contacts where id = $1) as contact,
         (select company_id::text from crm.tasks where id = $2) as task,
         (select company_id::text from crm.activities where id = $3) as note,
         (select archived_at from crm.companies where id = $4) as archived,
         (select industry from crm.companies where id = $5) as industry,
         (select count(*)::int from crm.audit_events where entity_id = any(array[$4, $5]::uuid[]) and event_type in ('company.merged', 'company.archived')) as events`,
      [person.id, task.id, note.id, dupe.id, keep.id],
    );
    assert.deepEqual(state, { contact: dupe.id, task: dupe.id, note: dupe.id, archived: null, industry: null, events: 0 });
  });

  it("drops tags past the limit and records them", async () => {
    const keepTags = Array.from({ length: 19 }, (_, index) => `keep-${index}`);
    const keep = await company("Tyrell", { tags: keepTags });
    const dupe = await company("Rosen Association", { tags: ["keep-0", "replicant", "offworld", "nexus"] });
    const result = await mergeCompanies(owner, keep.id, dupe.id, PROVENANCE);
    assert.equal(result.kept.tags.length, 20);
    assert.deepEqual(result.tagsAdded, ["replicant"]);
    const [audit] = await admin<{ changes: Record<string, unknown> }>(
      "select changes from crm.audit_events where event_type = 'company.merged' and entity_id = $1",
      [keep.id],
    );
    assert.deepEqual(audit.changes.tagsDropped, ["offworld", "nexus"]);
  });

  it("takes the duplicate's lifecycle when the kept company is still a lead", async () => {
    const keep = await company("Cyberdyne");
    const dupe = await company("Skynet Labs", { lifecycle: "customer" });
    const result = await mergeCompanies(owner, keep.id, dupe.id, PROVENANCE);
    assert.equal(result.kept.lifecycle, "customer");
    assert.ok(result.filled.includes("lifecycle"));

    const prospect = await company("Soylent", { lifecycle: "prospect" });
    const churned = await company("Green Foods", { lifecycle: "churned" });
    const second = await mergeCompanies(owner, prospect.id, churned.id, PROVENANCE);
    assert.equal(second.kept.lifecycle, "prospect");
    assert.ok(!second.filled.includes("lifecycle"));
  });

  it("skips an owner who has left the workspace", async () => {
    const leaver = await createUser("leaver@merge.test", "Lee Leaver");
    await admin("insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, 'member')", [owner.workspaceId, leaver.userId]);
    const keep = await company("Oscorp");
    const dupe = await company("Oscorp Labs", { ownerId: leaver.userId, industry: "Biotech" });
    const keepPerson = await contact({ firstName: "Norman" });
    const dupePerson = await contact({ firstName: "Norman", lastName: "Osborn", ownerId: leaver.userId });
    await admin("delete from crm.workspace_members where workspace_id = $1 and user_id = $2", [owner.workspaceId, leaver.userId]);

    const merged = await mergeCompanies(owner, keep.id, dupe.id, PROVENANCE);
    assert.equal(merged.kept.ownerId, null);
    assert.equal(merged.kept.industry, "Biotech");
    assert.ok(!merged.filled.includes("ownerId"));

    const people = await mergeContacts(owner, keepPerson.id, dupePerson.id, PROVENANCE);
    assert.equal(people.kept.ownerId, null);
    assert.equal(people.kept.lastName, "Osborn");
  });

  it("still fills an owner who is a current member", async () => {
    const keep = await company("Massive Dynamic");
    const dupe = await company("Massive Dynamic UK", { ownerId: member.userId });
    const result = await mergeCompanies(owner, keep.id, dupe.id, PROVENANCE);
    assert.equal(result.kept.ownerId, member.userId);
  });
});

describe("merge approval cards", () => {
  it("shows domain, date and history for both companies so keep and merge can be told apart", async () => {
    const keep = await company("Vandelay", { domain: "vandelay-merge.test" });
    const dupe = await company("Vandelay", { domain: "vandelay-merge.co.uk" });
    await logActivity(owner, { companyId: keep.id }, "note", "", "Latex order");
    await logActivity(owner, { companyId: keep.id }, "note", "", "Second order");
    await createOpportunity(owner, { companyId: keep.id, name: "Latex supply" }, { provenance: PROVENANCE });
    await createTask(owner, { title: "Chase Art", companyId: dupe.id }, { provenance: PROVENANCE });
    const added = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "Europe/London" }).format(new Date());

    const args = { keepId: keep.id, mergeId: dupe.id };
    const card = describeAction("merge_companies", args, await recordNames(owner, [args]));
    assert.equal(card.lines[0], `Keep: Vandelay (vandelay-merge.test, added ${added}, 2 activities, 1 deal, 0 tasks)`);
    assert.equal(card.lines[1], `Merge and archive: Vandelay (vandelay-merge.co.uk, added ${added}, 0 activities, 0 deals, 1 task)`);

    const swapped = { keepId: dupe.id, mergeId: keep.id };
    const swappedCard = describeAction("merge_companies", swapped, await recordNames(owner, [swapped]));
    assert.notDeepEqual(swappedCard.lines, card.lines);
    assert.match(swappedCard.lines[0], /^Keep: Vandelay \(vandelay-merge\.co\.uk/);
  });

  it("shows email for people", async () => {
    const keep = await contact({ firstName: "Kramer", email: "kramer@merge.test" });
    const dupe = await contact({ firstName: "Kramer" });
    await logActivity(owner, { contactId: dupe.id }, "note", "", "Kramerica pitch");
    const args = { keepId: keep.id, mergeId: dupe.id };
    const card = describeAction("merge_contacts", args, await recordNames(owner, [args]));
    assert.match(card.lines[0], /^Keep: Kramer \(kramer@merge\.test, added .+, 0 activities, 0 deals, 0 tasks\)$/);
    assert.match(card.lines[1], /^Merge and archive: Kramer \(added .+, 1 activity, 0 deals, 0 tasks\)$/);
  });
});

describe("merging contacts", () => {
  it("moves activity, tasks and deals to the kept person and keeps their email", async () => {
    const oldCo = await company("Old Co");
    const newCo = await company("New Co");
    const keep = await contact({ firstName: "Ann", email: "ann@newco-merge.test", companyId: newCo.id, tags: ["vip"] });
    const dupe = await contact({
      firstName: "Ann",
      lastName: "Lee",
      email: "ann@oldco-merge.test",
      phone: "+44 20 7946 0000",
      jobTitle: "CTO",
      companyId: oldCo.id,
      notes: "Met at the Leeds conference",
      tags: ["vip", "tech"],
    });
    const call = await logActivity(owner, { companyId: oldCo.id, contactId: dupe.id }, "call", "Discovery", "Talked through the roadmap");
    const task = (await createTask(owner, { title: "Follow up with Ann", contactId: dupe.id }, { provenance: PROVENANCE })).body.task;
    const deal = (await createOpportunity(owner, { companyId: oldCo.id, name: "Old Co pilot", primaryContactId: dupe.id }, { provenance: PROVENANCE })).body.opportunity;

    const result = await mergeContacts(member, keep.id, dupe.id, PROVENANCE);

    assert.equal(result.kept.email, "ann@newco-merge.test");
    assert.equal(result.kept.lastName, "Lee");
    assert.equal(result.kept.phone, "+44 20 7946 0000");
    assert.equal(result.kept.jobTitle, "CTO");
    assert.equal(result.kept.companyId, newCo.id);
    assert.deepEqual(result.kept.tags, ["vip", "tech"]);
    assert.match(result.kept.notes ?? "", /Met at the Leeds conference/);
    assert.match(result.kept.notes ?? "", /Other email: ann@oldco-merge\.test/);
    assert.ok(result.merged.archivedAt);
    assert.equal(result.moved.activities, 1);
    assert.equal(result.moved.tasks, 1);
    assert.equal(result.moved.opportunities, 1);

    const [moved] = await admin<{ call_contact: string; call_company: string; task: string; deal: string }>(
      `select
         (select contact_id::text from crm.activities where id = $1) as call_contact,
         (select company_id::text from crm.activities where id = $1) as call_company,
         (select contact_id::text from crm.tasks where id = $2) as task,
         (select primary_contact_id::text from crm.opportunities where id = $3) as deal`,
      [call.id, task.id, deal.id],
    );
    assert.deepEqual(moved, { call_contact: keep.id, call_company: oldCo.id, task: keep.id, deal: keep.id });

    const [audit] = await admin<{ changes: Record<string, unknown> }>(
      "select changes from crm.audit_events where event_type = 'contact.merged' and entity_id = $1",
      [keep.id],
    );
    assert.equal(audit.changes.mergedId, dupe.id);
    assert.equal((audit.changes.moved as Record<string, number>).activities, 1);
    assert.ok((audit.changes.filled as string[]).includes("notes"));
    assert.equal(((audit.changes.before as Record<string, Record<string, unknown>>).kept).notes, null);

    const [archivedEvent] = await admin<{ changes: Record<string, unknown> }>(
      "select changes from crm.audit_events where event_type = 'contact.archived' and entity_id = $1",
      [dupe.id],
    );
    assert.equal(archivedEvent.changes.mergedInto, keep.id);
  });

  it("doesn't count trailing whitespace on the kept notes as a change", async () => {
    const keep = await contact({ firstName: "Elaine", email: "elaine@merge.test", notes: "Works at Pendant  \n" });
    const dupe = await contact({ firstName: "Elaine", lastName: "Benes" });
    await admin("update crm.contacts set notes = $2 where id = $1", [keep.id, "Works at Pendant  \n"]);
    const result = await mergeContacts(owner, keep.id, dupe.id, PROVENANCE);
    assert.ok(!result.filled.includes("notes"));
    assert.equal(result.kept.notes, "Works at Pendant  \n");
  });

  it("takes the duplicate's email when the kept person has none", async () => {
    const keep = await contact({ firstName: "Bob", lastName: "Stone" });
    const dupe = await contact({ firstName: "Bob", email: "bob@merge.test" });
    const result = await mergeContacts(owner, keep.id, dupe.id, PROVENANCE);
    assert.equal(result.kept.email, "bob@merge.test");
    assert.equal(result.kept.notes, null);
    assert.ok(result.filled.includes("email"));
  });

  it("refuses a merge with itself, another workspace or an archived person", async () => {
    const keep = await contact({ firstName: "Cara" });
    const dupe = await contact({ firstName: "Cara", lastName: "Jones" });
    const foreign = (await createContact(outsider, { firstName: "Cara" }, { provenance: PROVENANCE })).body.contact;
    const archived = await contact({ firstName: "Old", lastName: "Cara" });
    await archiveContact(owner, archived.id, { provenance: PROVENANCE });

    await assert.rejects(mergeContacts(owner, keep.id, keep.id, PROVENANCE), isCrmError("invalid_input", /different person/));
    await assert.rejects(mergeContacts(owner, keep.id, foreign.id, PROVENANCE), isCrmError("not_found", /isn't in this workspace/));
    await assert.rejects(mergeContacts(owner, keep.id, archived.id, PROVENANCE), isCrmError("invalid_input", /Old Cara is already archived/));
    await assert.rejects(mergeContacts(owner, archived.id, dupe.id, PROVENANCE), isCrmError("invalid_input", /Old Cara is archived/));
    await assert.rejects(mergeContacts({ ...owner, scopes: ["crm:read"] }, keep.id, dupe.id, PROVENANCE), isCrmError("forbidden"));
  });
});
