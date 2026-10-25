import assert from "node:assert/strict";
import { after, afterEach, before, describe, it } from "node:test";
import { TOOL_BY_NAME, describeAction, runTool } from "@/lib/assistant/tools";
import { createCompany } from "@/lib/crm/companies";
import type { UserActor } from "@/lib/crm/types";
import { getPool } from "@/lib/db/pool";
import {
  commentOnLinearIssue,
  createLinearIssue,
  getLinearIssue,
  linearStatus,
  resetLinearCache,
  searchLinearIssues,
  updateLinearIssue,
} from "@/lib/linear";
import { createUser, resetDatabase } from "./helpers";

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
    await assert.rejects(createLinearIssue({ title: " " }, { fetchImpl: fake.fetchImpl, apiKey: "k" }), /Give the issue a title/);
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
    await assert.rejects(searchLinearIssues({}, { fetchImpl: denied.fetchImpl, apiKey: "bad" }), /rejected the API key/);
    await assert.rejects(searchLinearIssues({}, { apiKey: null }), /Linear isn't connected/);
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
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    delete process.env.LINEAR_API_KEY;
    delete process.env.SITE_URL;
    resetLinearCache();
  });

  after(async () => {
    await getPool().end();
  });

  it("only writes to Linear through approved actions", () => {
    for (const name of ["linear_create_issue", "linear_comment", "linear_update_issue"]) assert.equal(TOOL_BY_NAME.get(name)?.write, true, name);
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
    assert.deepEqual(missing, { error: "Linear isn't connected. Add LINEAR_API_KEY to the server environment." });

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
});
