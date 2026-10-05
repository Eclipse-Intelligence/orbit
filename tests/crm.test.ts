import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { GET as listCompaniesRoute, POST as createRoute } from "@/app/api/v1/companies/route";
import { PATCH, GET as getRoute } from "@/app/api/v1/companies/[id]/route";
import { POST as upsertRoute } from "@/app/api/v1/companies/upsert/route";
import { POST as bulkRoute } from "@/app/api/v1/companies/bulk/route";
import { POST as mcpRoute } from "@/app/api/mcp/route";
import { getPool } from "@/lib/db/pool";
import {
  archiveCompany,
  createCompany,
  getCompany,
  listCompanies,
  updateCompany,
  upsertCompany,
} from "@/lib/crm/companies";
import { CrmError } from "@/lib/crm/errors";
import { createAgent, createUser, queryAsUser, resetDatabase } from "./helpers";

before(async () => {
  await resetDatabase();
});

after(async () => {
  await getPool().end();
});

describe("company service", () => {
  it("creates, searches, filters, sorts, patches, and archives companies", async () => {
    const owner = await createUser("owner@example.com", "Olivia Owner");
    const created = await createCompany(
      owner,
      {
        name: "Northwind",
        domain: "www.northwind.io",
        industry: "Logistics",
        lifecycle: "prospect",
        description: "Regional carrier",
      },
      { provenance: { operation: "create_company", source: "manual" } },
    );
    assert.equal(created.status, 201);
    assert.equal(created.body.company.domain, "northwind.io");
    assert.equal(created.body.company.createdByUserId, owner.userId);
    assert.equal(created.body.company.lastInteractionAt, null);
    assert.equal(created.body.company.openTaskCount, 0);

    await createCompany(owner, { name: "Fabrikam", lifecycle: "lead" });
    const searched = await listCompanies(owner, {
      query: "north",
      sort: "name",
      order: "asc",
    });
    assert.equal(searched.total, 1);
    assert.equal(searched.data[0].name, "Northwind");

    const prospects = await listCompanies(owner, { lifecycle: "prospect" });
    assert.equal(prospects.total, 1);

    const patched = await updateCompany(owner, created.body.company.id, {
      description: "Updated carrier",
      source: "conference",
    });
    assert.equal(patched.body.company.description, "Updated carrier");
    assert.equal(patched.body.company.industry, "Logistics");
    assert.equal(patched.body.company.name, "Northwind");

    const cleared = await updateCompany(owner, created.body.company.id, {
      source: null,
    });
    assert.equal(cleared.body.company.source, null);
    assert.equal(cleared.body.company.description, "Updated carrier");

    const archived = await archiveCompany(owner, created.body.company.id);
    assert.ok(archived.body.company.archivedAt);
    const visible = await listCompanies(owner, { query: "Northwind" });
    assert.equal(visible.total, 0);
    const stored = await getCompany(owner, created.body.company.id);
    assert.equal(stored.id, created.body.company.id);
  });

  it("matches duplicates by domain and by name, and keeps partial upserts", async () => {
    const owner = await createUser("dedupe@example.com", "Dedupe");
    const first = await upsertCompany(owner, {
      name: "Acme Incorporated",
      website: "https://www.acme.com/about",
      industry: "Tools",
    });
    assert.equal(first.body.created, true);
    assert.equal(first.body.company.domain, "acme.com");

    const again = await upsertCompany(owner, {
      domain: "acme.com",
      description: "Makes tools",
    });
    assert.equal(again.body.created, false);
    assert.equal(again.body.matchedOn, "domain");
    assert.equal(again.body.company.id, first.body.company.id);
    assert.equal(again.body.company.industry, "Tools");
    assert.equal(again.body.company.description, "Makes tools");
    assert.equal(again.body.company.name, "Acme Incorporated");

    await assert.rejects(
      () => createCompany(owner, { name: "Acme", domain: "https://acme.com" }),
      (error: unknown) => error instanceof CrmError && error.code === "duplicate_company",
    );

    const named = await upsertCompany(owner, { name: "Globex" });
    const enriched = await upsertCompany(owner, {
      name: "Globex LLC",
      domain: "globex.com",
      lifecycle: "customer",
    });
    assert.equal(enriched.body.company.id, named.body.company.id);
    assert.equal(enriched.body.matchedOn, "name");
    assert.equal(enriched.body.company.domain, "globex.com");

    const other = await upsertCompany(owner, { name: "Globex", domain: "globex.org" });
    assert.equal(other.body.created, true);
    assert.notEqual(other.body.company.id, named.body.company.id);
  });

  it("replays idempotent creates and rejects a reused key", async () => {
    const owner = await createUser("idem@example.com");
    const options = {
      idempotencyKey: "lead-1",
      provenance: { operation: "create_company" },
    };
    const first = await createCompany(owner, { name: "Initech" }, options);
    const second = await createCompany(owner, { name: "Initech" }, options);
    assert.equal(second.replayed, true);
    assert.equal(second.body.company.id, first.body.company.id);
    const listed = await listCompanies(owner, { query: "Initech" });
    assert.equal(listed.total, 1);

    await assert.rejects(
      () => createCompany(owner, { name: "Other" }, options),
      (error: unknown) =>
        error instanceof CrmError && error.code === "idempotency_conflict",
    );
  });

  it("records the agent on the company and in the audit log", async () => {
    const owner = await createUser("audit@example.com");
    const { actor } = await createAgent(owner.workspaceId, [
      "crm:read",
      "companies:write",
    ]);
    const created = await upsertCompany(
      actor,
      { name: "Umbrella", domain: "umbrella.test" },
      {
        provenance: {
          operation: "upsert_company",
          source: "research-agent",
          sourceUrl: "https://umbrella.test/about",
        },
      },
    );
    assert.equal(created.body.company.createdByAgentId, actor.agentId);

    const rows = await queryAsUser<{ event_type: string; actor_agent_id: string; source: string }>(
      owner.userId,
      `select event_type, actor_agent_id, source
       from crm.audit_events
       where entity_id = $1`,
      [created.body.company.id],
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].event_type, "company.created");
    assert.equal(rows[0].actor_agent_id, actor.agentId);
    assert.equal(rows[0].source, "research-agent");

    await assert.rejects(
      () =>
        queryAsUser(owner.userId, "update crm.audit_events set source = 'tampered'"),
      /append-only|permission denied/i,
    );
  });

  it("rejects writes from an agent without companies:write", async () => {
    const owner = await createUser("scope@example.com");
    const { actor } = await createAgent(owner.workspaceId, ["crm:read"], "Reader");
    await assert.rejects(
      () => createCompany(actor, { name: "Blocked" }),
      (error: unknown) => error instanceof CrmError && error.status === 403,
    );
  });
});

describe("workspace isolation", () => {
  it("hides another workspace from users and agents", async () => {
    const alpha = await createUser("alpha@example.com", "Alpha");
    const beta = await createUser("beta@example.com", "Beta");
    const alphaCompany = await createCompany(alpha, {
      name: "Alpha Co",
      domain: "alpha.example",
    });
    await createCompany(beta, { name: "Beta Co", domain: "beta.example" });

    const alphaRows = await queryAsUser<{ name: string }>(
      alpha.userId,
      "select name from crm.companies order by name",
    );
    assert.deepEqual(
      alphaRows.map((row) => row.name),
      ["Alpha Co"],
    );

    await assert.rejects(
      () => getCompany(beta, alphaCompany.body.company.id),
      (error: unknown) => error instanceof CrmError && error.status === 404,
    );

    const { actor: betaAgent } = await createAgent(beta.workspaceId, [
      "crm:read",
      "companies:write",
    ]);
    const visible = await listCompanies(betaAgent, {});
    assert.deepEqual(
      visible.data.map((company) => company.name),
      ["Beta Co"],
    );
    await assert.rejects(
      () =>
        upsertCompany(betaAgent, {
          name: "Alpha Co",
          domain: "alpha.example",
          description: "should not attach",
        }).then(async (result) => {
          assert.notEqual(result.body.company.id, alphaCompany.body.company.id);
          assert.equal(result.body.company.workspaceId, beta.workspaceId);
          throw new Error("created in the agent workspace");
        }),
      /created in the agent workspace/,
    );

    await assert.rejects(
      () => getPool().query("select * from crm.companies"),
      /permission denied/i,
    );
  });
});

describe("HTTP API", () => {
  it("authenticates agents and supports search, get, create, patch, and upsert", async () => {
    const owner = await createUser("api@example.com", "Api Owner");
    const { token } = await createAgent(owner.workspaceId, [
      "crm:read",
      "companies:write",
    ]);
    const headers = {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    };

    const unauthorized = await listCompaniesRoute(
      new Request("http://crm.test/api/v1/companies"),
    );
    assert.equal(unauthorized.status, 401);

    const created = await createRoute(
      new Request("http://crm.test/api/v1/companies", {
        method: "POST",
        headers,
        body: JSON.stringify({
          name: "Api Co",
          domain: "api.example",
          provenance: { source: "api-test", sourceUrl: "https://api.example" },
        }),
      }),
    );
    assert.equal(created.status, 201);
    const createdBody = (await created.json()) as { company: { id: string } };

    const fetched = await getRoute(
      new Request(`http://crm.test/api/v1/companies/${createdBody.company.id}`, {
        headers,
      }),
      { params: Promise.resolve({ id: createdBody.company.id }) },
    );
    assert.equal(fetched.status, 200);

    const patched = await PATCH(
      new Request(`http://crm.test/api/v1/companies/${createdBody.company.id}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ industry: "Software" }),
      }),
      { params: Promise.resolve({ id: createdBody.company.id }) },
    );
    const patchedBody = (await patched.json()) as {
      company: { industry: string; name: string };
    };
    assert.equal(patchedBody.company.industry, "Software");
    assert.equal(patchedBody.company.name, "Api Co");

    const upserted = await upsertRoute(
      new Request("http://crm.test/api/v1/companies/upsert", {
        method: "POST",
        headers,
        body: JSON.stringify({ domain: "api.example", description: "From upsert" }),
      }),
    );
    const upsertedBody = (await upserted.json()) as {
      created: boolean;
      company: { description: string; industry: string };
    };
    assert.equal(upserted.status, 200);
    assert.equal(upsertedBody.created, false);
    assert.equal(upsertedBody.company.description, "From upsert");
    assert.equal(upsertedBody.company.industry, "Software");

    const searched = await listCompaniesRoute(
      new Request("http://crm.test/api/v1/companies?q=api.example", { headers }),
    );
    const searchedBody = (await searched.json()) as { total: number };
    assert.equal(searchedBody.total, 1);

    const outsider = await createUser("outsider@example.com");
    const { token: otherToken } = await createAgent(outsider.workspaceId, [
      "crm:read",
      "companies:write",
    ]);
    const hidden = await getRoute(
      new Request(`http://crm.test/api/v1/companies/${createdBody.company.id}`, {
        headers: { authorization: `Bearer ${otherToken}` },
      }),
      { params: Promise.resolve({ id: createdBody.company.id }) },
    );
    assert.equal(hidden.status, 404);
  });

  it("reports per-record results for a bulk upsert", async () => {
    const owner = await createUser("bulk@example.com");
    const { token } = await createAgent(owner.workspaceId, [
      "crm:read",
      "companies:write",
    ]);
    await createCompany(owner, { name: "Existing Bulk", domain: "existing-bulk.test" });
    const response = await bulkRoute(
      new Request("http://crm.test/api/v1/companies/bulk", {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          companies: [
            { name: "Existing Bulk", domain: "existing-bulk.test", industry: "Added" },
            { name: "Fresh Bulk", domain: "fresh-bulk.test" },
            { domain: "not a domain" },
          ],
        }),
      }),
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      results: { index: number; status: string; company?: { industry: string | null } }[];
    };
    assert.equal(body.results[0].status, "updated");
    assert.equal(body.results[0].company?.industry, "Added");
    assert.equal(body.results[1].status, "created");
    assert.equal(body.results[2].status, "error");
  });
});

describe("MCP", () => {
  it("upserts and searches through the MCP endpoint", async () => {
    const owner = await createUser("mcp@example.com");
    const { token } = await createAgent(owner.workspaceId, [
      "crm:read",
      "companies:write",
    ]);

    async function callTool(name: string, args: Record<string, unknown>) {
      const response = await mcpRoute(
        new Request("http://crm.test/api/mcp", {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: { name, arguments: args },
          }),
        }),
      );
      const payload = (await response.json()) as {
        result?: { content?: { text: string }[]; isError?: boolean };
        error?: { message: string };
      };
      return { status: response.status, payload };
    }

    const upserted = await callTool("upsert_company", {
      name: "Mcp Co",
      domain: "mcp.example",
      provenanceSource: "mcp-test",
    });
    assert.equal(upserted.status, 200);
    const text = upserted.payload.result?.content?.[0]?.text ?? "";
    assert.match(text, /mcp\.example/);
    assert.equal(upserted.payload.result?.isError, undefined);

    const searched = await callTool("search_companies", { query: "Mcp" });
    assert.match(searched.payload.result?.content?.[0]?.text ?? "", /Mcp Co/);
  });
});
