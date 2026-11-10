import assert from "node:assert/strict";
import { after, afterEach, before, describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { TOOL_BY_NAME, describeAction, findTool, runTool, toolDefinitions } from "@/lib/assistant/tools";
import { connectLinear, disconnectLinear, linearConnection } from "@/lib/crm/linear-connection";
import { createCompany } from "@/lib/crm/companies";
import type { UserActor } from "@/lib/crm/types";
import { getAdminPool, getPool } from "@/lib/db/pool";
import {
  commentOnLinearIssue,
  createLinearIssue,
  getLinearIssue,
  linearStatus,
  resetLinearCache,
  searchLinearIssues,
  updateLinearIssue,
} from "@/lib/linear";
import { createUser, queryAsUser, resetDatabase } from "./helpers";
import { createWorkspace } from "@/lib/crm/workspaces";

type Call = { query: string; variables: Record<string, unknown>; authorization: string | null };

function issueNode(identifier: string, title: string, extra: Record<string, unknown> = {}) {
  return {
    id: `uuid-${identifier}`,
    identifier,
    title,
    url: `https://linear.app/cntent/issue/${identifier.toLowerCase()}`,
    priorityLabel: "High",
    createdAt: "2026-10-17T09:00:00.000Z",
    updatedAt: "2026-10-18T09:00:00.000Z",
    state: { name: "Todo", type: "unstarted" },
    assignee: null,
    project: null,
    labels: { nodes: [{ name: "Client" }] },
    ...extra,
  };
}

function fakeLinear(options: { status?: number } = {}) {
  const calls: Call[] = [];
  const fetchImpl: typeof fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { query: string; variables: Record<string, unknown> };
    const headers = new Headers(init?.headers);
    calls.push({ query: body.query, variables: body.variables, authorization: headers.get("authorization") });
    if (options.status) return new Response(JSON.stringify({ errors: [{ message: "Authentication required" }] }), { status: options.status });
    const query = body.query;
    let data: unknown;
    if (query.includes("teams(")) {
      data = {
        teams: {
          nodes: [
            {
              id: "team-1",
              key: "CNT",
              name: "Cntent",
              states: {
                nodes: [
                  { id: "s-done", name: "Done", type: "completed", position: 3 },
                  { id: "s-todo", name: "Todo", type: "unstarted", position: 1 },
                  { id: "s-backlog", name: "Backlog", type: "backlog", position: 0 },
                ],
              },
              labels: { nodes: [{ id: "l-client", name: "Client" }, { id: "l-bug", name: "Bug" }] },
            },
          ],
        },
      };
    } else if (query.includes("viewer")) {
      data = { viewer: { id: "user-mark" } };
    } else if (query.includes("issueCreate")) {
      const input = body.variables.input as { title: string };
      data = { issueCreate: { success: true, issue: issueNode("CNT-42", input.title) } };
    } else if (query.includes("issueUpdate")) {
      data = { issueUpdate: { success: true, issue: issueNode(String(body.variables.id), "Updated", { state: { name: "Done", type: "completed" } }) } };
    } else if (query.includes("commentCreate")) {
      data = { commentCreate: { success: true, comment: { id: "c-1", url: "https://linear.app/cntent/issue/cnt-7#comment-c1" } } };
    } else if (query.includes("issue(id")) {
      data = {
        issue: {
          ...issueNode(String(body.variables.id), "Onboarding checklist"),
          description: "Steps",
          comments: { nodes: [{ body: "Second", createdAt: "2026-10-18T10:00:00Z", user: { name: "Mark" } }, { body: "First", createdAt: "2026-10-17T10:00:00Z", user: null }] },
        },
      };
    } else if (query.includes("issues(")) {
      data = { issues: { nodes: [issueNode("CNT-7", "Fix onboarding emails")] } };
    }
    return new Response(JSON.stringify({ data }), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { calls, fetchImpl };
}

describe("linear client", () => {
  it("searches the team's open issues by words or identifier", async () => {
    const fake = fakeLinear();
    const issues = await searchLinearIssues({ query: "onboarding" }, { fetchImpl: fake.fetchImpl, apiKey: "lin_api_test" });
    assert.equal(fake.calls[0].authorization, "lin_api_test");
    assert.deepEqual(fake.calls[0].variables.filter, {
      team: { key: { eq: "CNT" } },
      or: [{ title: { containsIgnoreCase: "onboarding" } }, { description: { containsIgnoreCase: "onboarding" } }],
      state: { type: { nin: ["completed", "canceled"] } },
    });
    assert.deepEqual(
      issues.map((issue) => [issue.identifier, issue.title, issue.state, issue.priority, issue.labels]),
      [["CNT-7", "Fix onboarding emails", "Todo", "High", ["Client"]]],
    );
    await searchLinearIssues({ query: "cnt-12", includeDone: true }, { fetchImpl: fake.fetchImpl, apiKey: "k" });
    assert.deepEqual(fake.calls[1].variables.filter, { team: { key: { eq: "CNT" } }, number: { eq: 12 } });
  });

  it("keeps every query within Linear's complexity limit by sizing each list", async () => {
    resetLinearCache();
    const fake = fakeLinear();
    await createLinearIssue({ title: "LinkedIn extension", labels: ["client"], assignToMe: true }, { fetchImpl: fake.fetchImpl, apiKey: "k" });
    await searchLinearIssues({ query: "extension" }, { fetchImpl: fake.fetchImpl, apiKey: "k" });
    await getLinearIssue("CNT-7", { fetchImpl: fake.fetchImpl, apiKey: "k" });
    for (const { query } of fake.calls) {
      for (const match of query.matchAll(/\b(teams|states|labels|issues|comments)\s*(\(([^)]*)\))?\s*\{/g)) {
        assert.match(match[3] ?? "", /\bfirst:/, `${match[1]} has no page size in: ${query.replace(/\s+/g, " ").slice(0, 120)}`);
      }
    }
    const team = fake.calls.find((call) => call.query.includes("teams("))!.query;
    assert.match(team, /teams\(filter: \{ key: \{ eq: \$key \} \}, first: 1\)/);
  });

  it("creates an issue in the team with status, labels, priority and assignee", async () => {
    const fake = fakeLinear();
    const issue = await createLinearIssue(
      { title: "  Send   Acme the onboarding pack ", description: "From the call", priority: "high", status: "backlog", labels: ["client"], assignToMe: true },
      { fetchImpl: fake.fetchImpl, apiKey: "k" },
    );
    assert.equal(issue.identifier, "CNT-42");
    const create = fake.calls.find((call) => call.query.includes("issueCreate"));
    assert.deepEqual(create?.variables.input, {
      teamId: "team-1",
      title: "Send Acme the onboarding pack",
      description: "From the call",
      priority: 2,
      stateId: "s-backlog",
      labelIds: ["l-client"],
      assigneeId: "user-mark",
    });
    await assert.rejects(
      createLinearIssue({ title: "X", status: "Shipped" }, { fetchImpl: fake.fetchImpl, apiKey: "k" }),
      /no status called Shipped\. Use one of: Backlog, Todo, Done/,
    );
    await assert.rejects(createLinearIssue({ title: " " }, { fetchImpl: fake.fetchImpl, apiKey: "k" }), /Enter a title/);
  });

  it("updates, comments and reports problems plainly", async () => {
    const fake = fakeLinear();
    const updated = await updateLinearIssue("CNT-7", { status: "done" }, { fetchImpl: fake.fetchImpl, apiKey: "k" });
    assert.equal(updated.state, "Done");
    assert.deepEqual(fake.calls.at(-1)?.variables, { id: "CNT-7", input: { stateId: "s-done" } });
    const comment = await commentOnLinearIssue("CNT-7", "Client confirmed", { fetchImpl: fake.fetchImpl, apiKey: "k" });
    assert.equal(comment.issue, "CNT-7");
    assert.deepEqual(fake.calls.at(-1)?.variables, { input: { issueId: "uuid-CNT-7", body: "Client confirmed" } });

    const denied = fakeLinear({ status: 401 });
    await assert.rejects(searchLinearIssues({}, { fetchImpl: denied.fetchImpl, apiKey: "bad" }), (error: unknown) => error instanceof Error && error.message === "Linear rejected the key.");
    await assert.rejects(searchLinearIssues({}, { apiKey: null }), /Linear isn't set up\./);
    resetLinearCache();
    const graphError: typeof fetch = async () => Response.json({ errors: [{ message: "Field 'internalField' doesn't exist on type 'Issue'" }] });
    await assert.rejects(
      searchLinearIssues({}, { fetchImpl: graphError, apiKey: "k" }),
      (error: unknown) => error instanceof Error && error.message === "Linear returned an error: Field 'internalField' doesn't exist on type 'Issue'.",
    );
    assert.deepEqual(await linearStatus({ fetchImpl: graphError, apiKey: "k" }), { configured: true, team: null, error: "Linear returned an error." });
    const offline: typeof fetch = async () => {
      throw new TypeError("fetch failed");
    };
    assert.deepEqual(await linearStatus({ fetchImpl: offline, apiKey: "k" }), { configured: true, team: null, error: "Couldn't reach Linear. Try again." });
    resetLinearCache();
    assert.deepEqual(await linearStatus({ apiKey: null }), { configured: false, team: null, error: null });
    assert.deepEqual(await linearStatus({ fetchImpl: fake.fetchImpl, apiKey: "k" }), {
      configured: true,
      team: { key: "CNT", name: "Cntent" },
      error: null,
    });
  });
});

describe("linear in the assistant", () => {
  let owner: UserActor;
  let companyId: string;
  const realFetch = globalThis.fetch;

  before(async () => {
    await resetDatabase();
    owner = await createUser("linear@orbit.test", "Mark Ridgeon");
    companyId = (await createCompany(owner, { name: "Acme Linear", domain: "acme-linear.test" })).body.company.id;
    await getAdminPool().query("insert into crm.workspace_brands (workspace_id, eclipse_tools) values ($1, true) on conflict (workspace_id) do update set eclipse_tools = true", [owner.workspaceId]);
    await connectLinear(owner);
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    delete process.env.LINEAR_API_KEY;
    delete process.env.SITE_URL;
    resetLinearCache();
  });

  after(async () => {
    await getPool().end();
    await getAdminPool().end();
  });

  it("only writes to Linear through approved actions", () => {
    for (const name of ["linear_create_issue", "linear_update_issue"]) assert.equal(TOOL_BY_NAME.get(name)?.write, true, name);
    assert.equal(TOOL_BY_NAME.has("linear_comment"), false);
    assert.equal(findTool("linear_comment")?.name, "linear_update_issue");
    assert.equal(findTool("linear_comment")?.write, true);
    for (const name of ["linear_search_issues", "linear_get_issue"]) assert.notEqual(TOOL_BY_NAME.get(name)?.write, true, name);
    assert.match(TOOL_BY_NAME.get("linear_create_issue")?.description ?? "", /never on your own initiative/);
    const card = describeAction(
      "linear_create_issue",
      { title: "Send onboarding pack", priority: "high", companyId, description: "Agreed on the call" },
      new Map([[companyId, "Acme Linear"]]),
    );
    assert.deepEqual(card, {
      title: "Create Linear issue: Send onboarding pack",
      lines: ["Team: CNT", "Priority: high", "Company: Acme Linear", "Description: Agreed on the call"],
    });
  });

  it("files an issue linked back to the company, and explains when Linear isn't set up", async () => {
    const missing = await runTool(owner, "linear_search_issues", { query: "x" });
    assert.deepEqual(missing, { error: "Linear isn't set up. Add LINEAR_API_KEY." });

    process.env.LINEAR_API_KEY = "lin_api_test";
    process.env.SITE_URL = "https://orbit.example.com";
    const fake = fakeLinear();
    globalThis.fetch = fake.fetchImpl;
    const result = (await runTool(owner, "linear_create_issue", {
      title: "Send onboarding pack",
      description: "Agreed on the call.",
      companyId,
    })) as { issue: { identifier: string; url: string } };
    assert.equal(result.issue.identifier, "CNT-42");
    const create = fake.calls.find((call) => call.query.includes("issueCreate"));
    assert.equal(
      (create?.variables.input as { description: string }).description,
      `Agreed on the call.\n\nFrom Orbit: [Acme Linear](https://orbit.example.com/companies/${companyId})`,
    );
    const read = (await runTool(owner, "linear_get_issue", { issue: "CNT-7" })) as { issue: { comments: { body: string }[] } };
    assert.deepEqual(
      read.issue.comments.map((comment) => comment.body),
      ["First", "Second"],
    );
  });

  it("comments through linear_update_issue, alone or with changes, and keeps the old linear_comment name working", async () => {
    assert.deepEqual(describeAction("linear_update_issue", { issue: "CNT-7", comment: "Client  confirmed" }), {
      title: "Comment on CNT-7",
      lines: ["Comment: Client confirmed"],
    });
    assert.deepEqual(describeAction("linear_update_issue", { issue: "CNT-7", status: "Done", comment: "Shipped" }), {
      title: "Update CNT-7",
      lines: ["Status: Done", "Comment: Shipped"],
    });
    assert.deepEqual(describeAction("linear_comment", { issue: "CNT-7", body: "From an old card" }), {
      title: "Comment on CNT-7",
      lines: ["Comment: From an old card"],
    });

    process.env.LINEAR_API_KEY = "lin_api_test";
    const fake = fakeLinear();
    globalThis.fetch = fake.fetchImpl;
    const nothing = (await runTool(owner, "linear_update_issue", { issue: "CNT-7" })) as { error: string };
    assert.match(nothing.error, /or give a comment/);
    assert.ok(!fake.calls.some((call) => call.query.includes("issueUpdate") || call.query.includes("commentCreate")));

    const commentOnly = (await runTool(owner, "linear_update_issue", { issue: "CNT-7", comment: "Client confirmed" })) as Record<string, unknown>;
    assert.deepEqual(Object.keys(commentOnly), ["comment"]);
    assert.equal(fake.calls.filter((call) => call.query.includes("issueUpdate")).length, 0);
    assert.deepEqual(fake.calls.at(-1)?.variables, { input: { issueId: "uuid-CNT-7", body: "Client confirmed" } });

    const both = (await runTool(owner, "linear_update_issue", { issue: "CNT-7", status: "done", comment: "Shipped" })) as {
      issue: { state: string };
      comment: { issue: string };
    };
    assert.equal(both.issue.state, "Done");
    assert.equal(both.comment.issue, "CNT-7");
    assert.equal(fake.calls.filter((call) => call.query.includes("issueUpdate")).length, 1);

    const old = (await runTool(owner, "linear_comment", { issue: "CNT-7", body: "Old card" })) as { comment: { issue: string } };
    assert.equal(old.comment.issue, "CNT-7");
    assert.deepEqual(fake.calls.at(-1)?.variables, { input: { issueId: "uuid-CNT-7", body: "Old card" } });
  });

  it("belongs to the workspace it's connected in, and refuses everywhere else without saying where", async () => {
    process.env.LINEAR_API_KEY = "lin_api_test";
    const fake = fakeLinear();
    globalThis.fetch = fake.fetchImpl;
    const other = await createUser("linear-other@orbit.test", "Sam Lee");
    assert.deepEqual(await linearConnection(owner), { here: true, claimable: false });
    assert.deepEqual(await linearConnection(other), { here: false, claimable: false });
    for (const [name, args] of [
      ["linear_search_issues", { query: "x" }],
      ["linear_get_issue", { issue: "CNT-7" }],
      ["linear_create_issue", { title: "Leak" }],
      ["linear_update_issue", { issue: "CNT-7", comment: "Leak" }],
    ] as const) {
      assert.deepEqual(await runTool(other, name, { ...args }), { error: "Linear isn't connected in this workspace.", field: null }, name);
    }
    assert.equal(fake.calls.length, 0);
    const hidden = toolDefinitions({ linear: false }).map((tool) => tool.function.name);
    assert.ok(!hidden.some((name) => name.startsWith("linear_")));
    assert.ok(toolDefinitions({ linear: true }).some((tool) => tool.function.name === "linear_create_issue"));
    await assert.rejects(connectLinear(other), /can't be connected here/);
    const member = { ...owner, role: "member" as const };
    await assert.rejects(disconnectLinear(member), /Only owners and admins can change where Linear is connected/);

    await disconnectLinear(owner);
    assert.deepEqual(await linearConnection(other), { here: false, claimable: false });
    await assert.rejects(connectLinear(other), /can't be connected here/);
    assert.deepEqual(await linearConnection(owner), { here: false, claimable: true });
    const second = await createWorkspace(owner, { name: "Linear Second" });
    const elsewhere = { ...owner, workspaceId: second.id, workspaceName: "Linear Second" };
    await connectLinear(elsewhere);
    assert.deepEqual(await linearConnection(owner), { here: false, claimable: false });
    assert.ok(Array.isArray(((await runTool(elsewhere, "linear_search_issues", { query: "x" })) as { issues: unknown[] }).issues));
    await disconnectLinear(elsewhere);
    await connectLinear(owner);
    const audit = await getAdminPool().query<{ event_type: string; workspace_id: string }>(
      "select event_type, workspace_id from crm.audit_events where entity_type = 'integration' order by created_at, id",
    );
    assert.deepEqual(
      audit.rows.map((row) => `${row.event_type}:${row.workspace_id === owner.workspaceId ? "first" : "second"}`),
      ["integration.connected:first", "integration.disconnected:first", "integration.connected:second", "integration.disconnected:second", "integration.connected:first"],
    );

    const attempt = (userId: string, text: string, values: unknown[]) => queryAsUser(userId, text, values);
    await assert.rejects(
      attempt(other.userId, "insert into crm.integration_settings (integration, workspace_id, connected_by) values ('linear', $1, $2)", [other.workspaceId, owner.userId]),
      /row-level security/,
    );
    await assert.rejects(
      attempt(other.userId, "insert into crm.integration_settings (integration, workspace_id, connected_by) values ('linear', $1, $2)", [owner.workspaceId, other.userId]),
      /row-level security/,
    );
    assert.deepEqual(await attempt(other.userId, "select workspace_id from crm.integration_settings", []), []);
    assert.deepEqual(await attempt(other.userId, "delete from crm.integration_settings returning integration", []), []);
    await assert.rejects(attempt(owner.userId, "update crm.integration_settings set workspace_id = $1", [other.workspaceId]), /permission denied/);
    assert.equal((await getAdminPool().query("select 1 from crm.integration_settings where workspace_id = $1", [owner.workspaceId])).rowCount, 1);
  });

  it("connects Linear to the workspace that owns the Eclipse brand when the migration first runs, and the migration runs twice", async () => {
    const admin = getAdminPool();
    await admin.query("drop table crm.integration_settings cascade");
    await admin.query(
      "insert into crm.workspace_brands (workspace_id, eclipse_tools) values ($1, true) on conflict (workspace_id) do update set eclipse_tools = true",
      [owner.workspaceId],
    );
    const sql = readFileSync("supabase/migrations/20270112300000_assistant_isolation.sql", "utf8");
    await admin.query(sql);
    await admin.query(sql);
    const rows = await admin.query<{ integration: string; workspace_id: string }>("select integration, workspace_id from crm.integration_settings");
    assert.deepEqual(rows.rows, [{ integration: "linear", workspace_id: owner.workspaceId }]);
    assert.deepEqual(await linearConnection(owner), { here: true, claimable: false });
    const client = await admin.connect();
    try {
      await client.query("set role authenticated");
      await assert.rejects(client.query("update crm.workspace_brands set eclipse_tools = true"), /permission denied/);
    } finally {
      await client.query("reset role");
      client.release();
    }
  });
});
