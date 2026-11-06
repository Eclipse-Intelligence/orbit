import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { POST as captureRoute, OPTIONS as captureOptions } from "@/app/api/extension/capture/route";
import { POST as diffRoute } from "@/app/api/extension/diff/route";
import { POST as logRoute } from "@/app/api/extension/log/route";
import { POST as logCheckRoute } from "@/app/api/extension/log/check/route";
import { GET as lookupRoute } from "@/app/api/extension/lookup/route";
import { GET as meRoute } from "@/app/api/extension/me/route";
import { POST as noteRoute } from "@/app/api/extension/note/route";
import { POST as pairRoute } from "@/app/api/extension/pair/route";
import { POST as redeemRoute } from "@/app/api/extension/pair/redeem/route";
import { POST as revokeRoute } from "@/app/api/extension/revoke/route";
import { POST as taskRoute } from "@/app/api/extension/task/route";
import { POST as mcpRoute } from "@/app/api/mcp/route";
import { POST as quickRoute } from "@/app/api/quick/route";
import { GET as v1Companies } from "@/app/api/v1/companies/route";
import { POST as v1ContactUpsert } from "@/app/api/v1/contacts/upsert/route";
import { GET as exportRoute } from "@/app/api/v1/export/[resource]/route";
import { POST as importRoute } from "@/app/api/v1/import/[resource]/route";
import { createBoard } from "@/lib/crm/boards";
import { upsertCompany } from "@/lib/crm/companies";
import { getContact, upsertContact } from "@/lib/crm/contacts";
import { canonicalSalesNavigator } from "@/lib/crm/normalize";
import { scopesForRole } from "@/lib/crm/scopes";
import { createTask, listTasks } from "@/lib/crm/tasks";
import type { UserActor } from "@/lib/crm/types";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { allowedExtensionOrigins } from "@/lib/extension/http";
import { decidePairing, listBrowsers, pairingState, redeemPairing, revokeBrowser, setBrowserWorkspaces, startPairing } from "@/lib/extension/pairing";
import { dueFrom, messageKey } from "@/lib/extension/capture";
import type {
  CaptureResponse,
  DiffResponse,
  LogCheckResponse,
  LookupResponse,
  MeResponse,
  PairRedeemResponse,
  PairStartResponse,
  ThreadMessage,
} from "@/lib/extension/protocol";
import { createAgent, createUser, resetDatabase } from "./helpers";

const EXTENSION_ID = "fdlhldfkiompmkjhobgnddjdaocjnfkd";
const ORIGIN = `chrome-extension://${EXTENSION_ID}`;

type Handler = (request: Request, context?: never) => Promise<Response> | Response;

async function call<T>(
  handler: Handler,
  path: string,
  options: { method?: string; body?: unknown; token?: string; workspace?: string; origin?: string | null; ip?: string } = {},
) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  if (options.workspace) headers["x-orbit-workspace"] = options.workspace;
  if (options.origin !== null) headers.origin = options.origin ?? ORIGIN;
  if (options.ip) headers["x-forwarded-for"] = options.ip;
  const response = await handler(
    new Request(`https://orbit.test${path}`, {
      method: options.method ?? (options.body === undefined ? "GET" : "POST"),
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    }),
  );
  const text = await response.text();
  return { status: response.status, headers: response.headers, data: (text ? JSON.parse(text) : null) as T };
}

function inWorkspace(actor: UserActor, id: string, name: string): UserActor {
  return { ...actor, workspaceId: id, workspaceName: name, role: "owner", scopes: scopesForRole("owner") };
}

async function connect(owner: UserActor, workspaceIds: string[], name = "Chrome on MacBook Pro") {
  const started = await startPairing("https://orbit.test");
  await decidePairing(owner, { code: started.code, name, workspaceIds, approve: true });
  const redeemed = await redeemPairing(started.code, started.secret);
  assert.equal(redeemed.status, "approved");
  return redeemed.status === "approved" ? redeemed.token : "";
}

before(async () => {
  process.env.LINKEDIN_EXTENSION_ID = EXTENSION_ID;
  await resetDatabase();
});

after(async () => {
  await getPool().end();
});

describe("LinkedIn capture pairing", () => {
  let mark: UserActor;
  let second: UserActor;

  before(async () => {
    mark = await createUser("mark-pair@linkedin.test", "Mark Ridgeon");
    const admin = getAdminPool();
    const workspace = await admin.query<{ id: string }>("insert into crm.workspaces (name, slug) values ('Mark Ridgeon', 'mark-ridgeon-pair') returning id");
    await admin.query("insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, 'owner')", [workspace.rows[0].id, mark.userId]);
    second = inWorkspace(mark, workspace.rows[0].id, "Mark Ridgeon");
  });

  it("waits for approval, then hands the credential over once to the extension that started it", async () => {
    const started = await call<PairStartResponse>(pairRoute, "/api/extension/pair", { body: {}, ip: "10.0.0.1" });
    assert.equal(started.status, 200);
    assert.match(started.data.code, /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    assert.equal(started.data.approveUrl, `https://orbit.test/connect/chrome?code=${started.data.code}`);
    const { code, secret } = started.data;

    const pending = await call<PairRedeemResponse>(redeemRoute, "/api/extension/pair/redeem", { body: { code, secret } });
    assert.equal(pending.status, 202);
    assert.equal(pending.data.status, "pending");
    assert.equal((await pairingState(code)).state, "pending");

    await assert.rejects(decidePairing(mark, { code, name: "Chrome", workspaceIds: [], approve: true }), /at least one workspace/);
    assert.equal(await decidePairing(mark, { code: code.toLowerCase(), name: "Chrome on MacBook Pro", workspaceIds: [mark.workspaceId], approve: true }), "approved");
    await assert.rejects(decidePairing(mark, { code, name: "Again", workspaceIds: [mark.workspaceId], approve: true }), /expired or was already used/);

    const wrong = await call<{ error: { code: string } }>(redeemRoute, "/api/extension/pair/redeem", { body: { code, secret: "not-the-secret" } });
    assert.equal(wrong.status, 410);

    const approved = await call<PairRedeemResponse>(redeemRoute, "/api/extension/pair/redeem", { body: { code, secret } });
    assert.equal(approved.status, 200);
    assert.ok(approved.data.status === "approved" && approved.data.token.startsWith("olx_"));

    const again = await call<{ error: { code: string } }>(redeemRoute, "/api/extension/pair/redeem", { body: { code, secret } });
    assert.equal(again.status, 410);

    const stored = await getAdminPool().query<{ token_hash: string; name: string }>("select token_hash, name from crm.extension_browsers where user_id = $1", [mark.userId]);
    assert.equal(stored.rows.length, 1);
    assert.equal(stored.rows[0].name, "Chrome on MacBook Pro");
    assert.ok(approved.data.status === "approved" && !stored.rows[0].token_hash.includes(approved.data.token));
    assert.match(stored.rows[0].token_hash, /^[0-9a-f]{64}$/);
  });

  it("refuses expired and cancelled codes", async () => {
    const expired = await startPairing("https://orbit.test");
    await getAdminPool().query("update crm.extension_pairings set expires_at = now() - interval '1 minute' where status = 'pending'");
    assert.equal((await pairingState(expired.code)).state, "expired");
    await assert.rejects(decidePairing(mark, { code: expired.code, name: "Chrome", workspaceIds: [mark.workspaceId], approve: true }), /expired/);
    await assert.rejects(redeemPairing(expired.code, expired.secret), /expired/);

    const declined = await startPairing("https://orbit.test");
    assert.equal(await decidePairing(mark, { code: declined.code, approve: false }), "declined");
    await assert.rejects(redeemPairing(declined.code, declined.secret), /cancelled in Orbit/);
  });

  it("only lets the approver grant workspaces they belong to", async () => {
    const other = await createUser("other-pair@linkedin.test", "Someone Else");
    const started = await startPairing("https://orbit.test");
    await assert.rejects(decidePairing(mark, { code: started.code, name: "Chrome", workspaceIds: [other.workspaceId], approve: true }), /member of/);
    await decidePairing(mark, { code: started.code, name: "Chrome", workspaceIds: [other.workspaceId, second.workspaceId], approve: true });
    const redeemed = await redeemPairing(started.code, started.secret);
    assert.ok(redeemed.status === "approved");
    const me = await call<MeResponse>(meRoute, "/api/extension/me", { token: redeemed.status === "approved" ? redeemed.token : "" });
    assert.deepEqual(me.data.workspaces.map((workspace) => workspace.name), ["Mark Ridgeon"]);
  });

  it("rate limits starting a pairing by address", async () => {
    let last = 0;
    for (let index = 0; index < 11; index += 1) {
      last = (await call(pairRoute, "/api/extension/pair", { body: {}, ip: "10.9.9.9" })).status;
    }
    assert.equal(last, 429);
    assert.equal((await call(pairRoute, "/api/extension/pair", { body: {}, ip: "10.9.9.10" })).status, 200);
  });

  it("lists, edits and revokes browsers for their owner only", async () => {
    const token = await connect(mark, [mark.workspaceId], "Chrome on Mac mini");
    const browsers = await listBrowsers(mark);
    const mini = browsers.find((browser) => browser.name === "Chrome on Mac mini");
    assert.ok(mini);
    assert.deepEqual(mini.workspaces.map((workspace) => workspace.id), [mark.workspaceId]);
    await setBrowserWorkspaces(mark, mini.id, [mark.workspaceId, second.workspaceId]);
    const me = await call<MeResponse>(meRoute, "/api/extension/me", { token });
    assert.equal(me.data.workspaces.length, 2);

    const stranger = await createUser("stranger-pair@linkedin.test", "Stranger");
    assert.deepEqual(await listBrowsers(stranger), []);
    await assert.rejects(revokeBrowser(stranger, mini.id), /isn't connected/);
    await assert.rejects(setBrowserWorkspaces(stranger, mini.id, [stranger.workspaceId]), /isn't connected/);

    await revokeBrowser(mark, mini.id);
    const revoked = await call<{ error: { code: string; message: string } }>(meRoute, "/api/extension/me", { token });
    assert.equal(revoked.status, 401);
    assert.match(revoked.data.error.message, /disconnected/);
  });

  it("signs itself out with revoke", async () => {
    const token = await connect(mark, [mark.workspaceId], "Chrome to sign out");
    assert.equal((await call(revokeRoute, "/api/extension/revoke", { token, body: {} })).status, 200);
    assert.equal((await call(meRoute, "/api/extension/me", { token })).status, 401);
  });
});

describe("LinkedIn capture credential scope", () => {
  let mark: UserActor;
  let side: UserActor;
  let token: string;

  before(async () => {
    mark = await createUser("mark-scope@linkedin.test", "Mark Ridgeon");
    const admin = getAdminPool();
    const workspace = await admin.query<{ id: string }>("insert into crm.workspaces (name, slug) values ('Side', 'side-scope') returning id");
    await admin.query("insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, 'owner')", [workspace.rows[0].id, mark.userId]);
    side = inWorkspace(mark, workspace.rows[0].id, "Side");
    token = await connect(mark, [mark.workspaceId]);
  });

  it("can't reach mail, docs, quick capture or the agent API", async () => {
    const mcp = await mcpRoute(
      new Request("https://orbit.test/api/mcp", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      }),
    );
    assert.equal(mcp.status, 401);
    const v1 = await v1Companies(new Request("https://orbit.test/api/v1/companies", { headers: { authorization: `Bearer ${token}` } }));
    assert.equal(v1.status, 401);
    const quick = await quickRoute(
      new Request("https://orbit.test/api/quick", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ text: "note", to: "daily" }),
      }),
    );
    assert.equal(quick.status, 401);
  });

  it("refuses agent and personal tokens on the extension endpoints", async () => {
    const agent = await createAgent(mark.workspaceId, ["admin"]);
    assert.equal((await call(meRoute, "/api/extension/me", { token: agent.token })).status, 401);
    assert.equal((await call(meRoute, "/api/extension/me", { token: "orbit_abc_def" })).status, 401);
    assert.equal((await call(meRoute, "/api/extension/me", {})).status, 401);
  });

  it("refuses a workspace the browser wasn't given and checks membership on every request", async () => {
    const company = (await upsertCompany(mark, { name: "Scope Ltd", domain: "scope.test" })).body.company;
    const allowed = await call(noteRoute, "/api/extension/note", { token, workspace: mark.workspaceId, body: { body: "Hello", companyId: company.id } });
    assert.equal(allowed.status, 200);
    const refused = await call<{ error: { code: string } }>(noteRoute, "/api/extension/note", { token, workspace: side.workspaceId, body: { body: "Hello", companyId: company.id } });
    assert.equal(refused.status, 403);
    assert.equal(refused.data.error.code, "workspace_not_allowed");
    const missing = await call<{ error: { code: string } }>(noteRoute, "/api/extension/note", { token, body: { body: "Hello", companyId: company.id } });
    assert.equal(missing.status, 400);

    const browser = (await listBrowsers(mark))[0];
    await setBrowserWorkspaces(mark, browser.id, [mark.workspaceId, side.workspaceId]);
    await getAdminPool().query("delete from crm.workspace_members where workspace_id = $1 and user_id = $2", [side.workspaceId, mark.userId]);
    const removed = await call<{ error: { code: string } }>(noteRoute, "/api/extension/note", { token, workspace: side.workspaceId, body: { body: "Hello", companyId: company.id } });
    assert.equal(removed.status, 403);
    const left = await getAdminPool().query("select 1 from crm.extension_browser_workspaces where workspace_id = $1", [side.workspaceId]);
    assert.equal(left.rowCount, 0);
  });

  it("answers CORS only for the configured extension origin", async () => {
    assert.deepEqual(allowedExtensionOrigins({ LINKEDIN_EXTENSION_ID: ` ${EXTENSION_ID}, not-an-id ` }), [ORIGIN]);
    const preflight = await captureOptions(new Request("https://orbit.test/api/extension/capture", { method: "OPTIONS", headers: { origin: ORIGIN } }));
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-origin"), ORIGIN);
    assert.match(preflight.headers.get("access-control-allow-headers") ?? "", /x-orbit-workspace/);
    const stranger = await captureOptions(new Request("https://orbit.test/api/extension/capture", { method: "OPTIONS", headers: { origin: "https://evil.test" } }));
    assert.equal(stranger.status, 403);
    assert.equal(stranger.headers.get("access-control-allow-origin"), null);

    const fromPage = await call<{ error: { code: string } }>(meRoute, "/api/extension/me", { token, origin: "https://www.linkedin.com" });
    assert.equal(fromPage.status, 403);
    assert.equal(fromPage.headers.get("access-control-allow-origin"), null);
    const fromExtension = await call(meRoute, "/api/extension/me", { token });
    assert.equal(fromExtension.status, 200);
    assert.equal(fromExtension.headers.get("access-control-allow-origin"), ORIGIN);
    const withoutOrigin = await call(meRoute, "/api/extension/me", { token, origin: null });
    assert.equal(withoutOrigin.status, 200);
  });
});

describe("LinkedIn capture records", () => {
  let mark: UserActor;
  let ridgeon: UserActor;
  let token: string;
  let boardId: string;
  let stageId: string;

  before(async () => {
    mark = await createUser("mark-records@linkedin.test", "Mark Ridgeon");
    await getAdminPool().query("update crm.workspaces set name = 'Eclipse' where id = $1", [mark.workspaceId]);
    mark = { ...mark, workspaceName: "Eclipse" };
    const admin = getAdminPool();
    const workspace = await admin.query<{ id: string }>("insert into crm.workspaces (name, slug) values ('Mark Ridgeon', 'mark-ridgeon-records') returning id");
    await admin.query("insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, 'owner')", [workspace.rows[0].id, mark.userId]);
    ridgeon = inWorkspace(mark, workspace.rows[0].id, "Mark Ridgeon");
    token = await connect(mark, [mark.workspaceId, ridgeon.workspaceId]);
    const board = await createBoard(mark, { name: "Outreach" });
    boardId = board.id;
    const me = await call<MeResponse>(meRoute, "/api/extension/me", { token });
    const eclipse = me.data.workspaces.find((workspace) => workspace.id === mark.workspaceId)!;
    const outreach = eclipse.boards.find((item) => item.id === boardId)!;
    stageId = outreach.stages[1].id;
    assert.equal(eclipse.members[0].id, mark.userId);
    assert.ok(eclipse.boards.some((item) => item.kind === "sales"));
    assert.ok(eclipse.lifecycles.some((item) => item.value === "prospect" && item.label === "Prospect"));
  });

  it("matches people by LinkedIn profile, then Sales Navigator lead, per workspace", async () => {
    const northlight = (await upsertCompany(mark, { name: "Northlight SEO", domain: "northlightseo.co.uk" })).body.company;
    await upsertContact(mark, { firstName: "Priya", lastName: "Shah", companyId: northlight.id, linkedinUrl: "linkedin.com/in/Priya-Shah-SEO/", email: "priya@northlightseo.co.uk" });
    await upsertContact(ridgeon, { firstName: "Dan", lastName: "Hughes", salesNavigatorUrl: "https://www.linkedin.com/sales/lead/ACwAAB9xK2sBr4,NAME_SEARCH,x7Yq" });

    const priya = await call<LookupResponse>(lookupRoute, `/api/extension/lookup?url=${encodeURIComponent("https://www.linkedin.com/in/priya-shah-seo/?trk=x")}`, { token });
    assert.equal(priya.data.kind, "person");
    const [eclipse, side] = priya.data.workspaces;
    assert.equal(eclipse.status, "in");
    assert.equal(eclipse.matchedOn, "linkedin");
    assert.equal(eclipse.person?.company?.name, "Northlight SEO");
    assert.equal(eclipse.person?.owner, null);
    assert.match(eclipse.presence, /^In Orbit, saved /);
    assert.match(eclipse.person?.url ?? "", /^\/open\?workspace=/);
    assert.equal(side.status, "none");
    assert.equal(side.presence, "Not in Orbit");

    const lead = await call<LookupResponse>(lookupRoute, `/api/extension/lookup?url=${encodeURIComponent("https://www.linkedin.com/sales/lead/ACwAAB9xK2sBr4,NAME_SEARCH,abc")}`, { token });
    assert.equal(lead.data.kind, "lead");
    assert.equal(lead.data.workspaces.find((item) => item.workspaceId === ridgeon.workspaceId)?.matchedOn, "sales_navigator");
    assert.equal(canonicalSalesNavigator("linkedin.com/sales/people/ACwAAB9xK2sBr4,NAME_SEARCH"), "https://www.linkedin.com/sales/lead/ACwAAB9xK2sBr4");
  });

  it("only offers a possible match on name and company, and never links it without confirmation", async () => {
    const brightline = (await upsertCompany(mark, { name: "Brightline PR", domain: "brightlinepr.co.uk" })).body.company;
    const tom = (await upsertContact(mark, { firstName: "Tom", lastName: "Reilly", companyId: brightline.id, email: "tom@brightlinepr.co.uk" })).body.contact;
    const leadUrl = "https://www.linkedin.com/sales/lead/ACwAAC1tomR3illy,NAME_SEARCH,q";
    const query = `/api/extension/lookup?url=${encodeURIComponent(leadUrl)}&name=Tom%20Reilly&company=Brightline%20PR%20Ltd`;
    const maybe = await call<LookupResponse>(lookupRoute, query, { token });
    const eclipse = maybe.data.workspaces.find((item) => item.workspaceId === mark.workspaceId)!;
    assert.equal(eclipse.status, "maybe");
    assert.equal(eclipse.person, null);
    assert.deepEqual(eclipse.candidates.map((item) => item.id), [tom.id]);
    assert.equal(eclipse.presence, "Possible match");
    assert.equal((await getContact(mark, tom.id)).salesNavigatorUrl, null);

    const wrongCompany = await call<LookupResponse>(lookupRoute, `/api/extension/lookup?url=${encodeURIComponent(leadUrl)}&name=Tom%20Reilly&company=Other`, { token });
    assert.equal(wrongCompany.data.workspaces[0].status, "none");

    const linked = await call<CaptureResponse>(captureRoute, "/api/extension/capture", {
      token,
      workspace: mark.workspaceId,
      body: { kind: "link", contactId: tom.id, linkedinUrl: null, salesNavigatorUrl: leadUrl, sourceUrl: leadUrl },
    });
    assert.equal(linked.status, 200);
    assert.equal(linked.data.person?.salesNavigatorUrl, "https://www.linkedin.com/sales/lead/ACwAAC1tomR3illy");
    const now = await call<LookupResponse>(lookupRoute, query, { token });
    assert.equal(now.data.workspaces.find((item) => item.workspaceId === mark.workspaceId)?.matchedOn, "sales_navigator");

    const other = (await upsertContact(mark, { firstName: "Ann", lastName: "Lee", companyId: brightline.id, linkedinUrl: "linkedin.com/in/ann-lee-one" })).body.contact;
    const notHer = await call<LookupResponse>(lookupRoute, `/api/extension/lookup?url=${encodeURIComponent("https://www.linkedin.com/in/ann-lee-two")}&name=Ann%20Lee&company=Brightline%20PR`, { token });
    assert.equal(notHer.data.workspaces[0].status, "none");

    const separate = await call<CaptureResponse>(captureRoute, "/api/extension/capture", {
      token,
      workspace: mark.workspaceId,
      body: {
        kind: "person",
        person: { firstName: "Ann", lastName: "Lee", jobTitle: "Director", location: "Leeds, England", linkedinUrl: "https://www.linkedin.com/in/ann-lee-two", salesNavigatorUrl: null },
        company: { name: "Brightline PR", domain: null, linkedinUrl: null },
        ownerId: mark.userId,
        tags: [],
        boardId: null,
        stageId: null,
        sourceUrl: "https://www.linkedin.com/in/ann-lee-two",
      },
    });
    assert.equal(separate.status, 200);
    assert.equal(separate.data.created.contact, true);
    assert.notEqual(separate.data.person?.id, other.id);
  });

  it("saves a new person with their company, owner, tags and board stage", async () => {
    const saved = await call<CaptureResponse>(captureRoute, "/api/extension/capture", {
      token,
      workspace: mark.workspaceId,
      body: {
        kind: "person",
        person: {
          firstName: "Hannah",
          lastName: "Okafor",
          jobTitle: "Head of Growth",
          location: "Bristol, England",
          linkedinUrl: "https://www.linkedin.com/in/hannah-okafor",
          salesNavigatorUrl: null,
        },
        company: { name: "Fernhill Digital", domain: "fernhill.digital", linkedinUrl: "https://www.linkedin.com/company/fernhill-digital/" },
        ownerId: mark.userId,
        tags: ["Agency"],
        boardId,
        stageId,
        sourceUrl: "https://www.linkedin.com/in/hannah-okafor/",
      },
    });
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.data.created, { contact: true, company: true });
    assert.equal(saved.data.person?.location, "Bristol, England");
    assert.equal(saved.data.person?.owner?.id, mark.userId);
    assert.deepEqual(saved.data.person?.tags, ["agency"]);
    assert.equal(saved.data.company?.domain, "fernhill.digital");
    assert.equal(saved.data.company?.linkedinUrl, "https://www.linkedin.com/company/fernhill-digital");
    assert.equal(saved.data.company?.deal?.board, "Outreach");

    const audit = await getAdminPool().query<{ event_type: string; source: string; source_url: string; actor_user_id: string }>(
      "select event_type, source, source_url, actor_user_id from crm.audit_events where workspace_id = $1 and source_url = 'https://www.linkedin.com/in/hannah-okafor' order by created_at",
      [mark.workspaceId],
    );
    assert.deepEqual(
      audit.rows.map((row) => row.event_type).sort(),
      ["company.created", "contact.created", "lead.created", "opportunity.created"],
    );
    assert.ok(audit.rows.every((row) => row.source === "linkedin_extension" && row.actor_user_id === mark.userId));

    const colleague = await call<CaptureResponse>(captureRoute, "/api/extension/capture", {
      token,
      workspace: mark.workspaceId,
      body: {
        kind: "person",
        person: { firstName: "Sam", lastName: "Doe", jobTitle: null, location: null, linkedinUrl: "https://www.linkedin.com/in/sam-doe", salesNavigatorUrl: null },
        company: { name: "Fernhill", domain: null, linkedinUrl: "https://www.linkedin.com/company/fernhill-digital" },
        ownerId: null,
        tags: [],
        boardId,
        stageId,
        sourceUrl: null,
      },
    });
    assert.equal(colleague.data.created.company, false);
    assert.equal(colleague.data.company?.id, saved.data.company?.id);
    assert.equal(colleague.data.person?.owner, null);
    const cards = await getAdminPool().query("select 1 from crm.opportunities where pipeline_id = $1 and company_id = $2", [boardId, saved.data.company?.id]);
    assert.equal(cards.rowCount, 1);
  });

  it("saves a company page and matches companies by LinkedIn page, then domain, then name", async () => {
    const saved = await call<CaptureResponse>(captureRoute, "/api/extension/capture", {
      token,
      workspace: mark.workspaceId,
      body: {
        kind: "company",
        company: { name: "Kestrel Content Co", domain: "kestrelcontent.com", linkedinUrl: "https://www.linkedin.com/company/kestrel-content/about/", industry: "Marketing services", sizeCategory: "11-50", description: "Content for tech companies" },
        lifecycle: "prospect",
        ownerId: mark.userId,
        tags: ["agency"],
        boardId: null,
        stageId: null,
        sourceUrl: "https://www.linkedin.com/company/kestrel-content/about/",
      },
    });
    assert.equal(saved.status, 200);
    assert.equal(saved.data.company?.lifecycleLabel, "Prospect");
    assert.equal(saved.data.company?.industry, "Marketing services");

    const byPage = await call<LookupResponse>(lookupRoute, `/api/extension/lookup?url=${encodeURIComponent("https://www.linkedin.com/company/kestrel-content/posts/")}`, { token });
    assert.equal(byPage.data.kind, "company");
    assert.equal(byPage.data.workspaces[0].matchedOn, "linkedin");
    const byDomain = await call<LookupResponse>(lookupRoute, `/api/extension/lookup?url=${encodeURIComponent("https://www.linkedin.com/company/123456/")}&domain=www.kestrelcontent.com`, { token });
    assert.equal(byDomain.data.workspaces[0].matchedOn, "domain");
    const byName = await call<LookupResponse>(lookupRoute, `/api/extension/lookup?url=${encodeURIComponent("https://www.linkedin.com/company/999/")}&name=Kestrel%20Content%20Co%20Ltd`, { token });
    assert.equal(byName.data.workspaces[0].matchedOn, "name");
    assert.equal(byName.data.workspaces[1].status, "none");

    const upserted = await upsertCompany(mark, { name: "Kestrel (renamed on LinkedIn)", linkedinUrl: "linkedin.com/company/kestrel-content" });
    assert.equal(upserted.body.matchedOn, "linkedin");
    assert.equal(upserted.body.company.id, saved.data.company?.id);
    const kept = await upsertCompany(mark, { name: "Kestrel", domain: "other-kestrel.com", linkedinUrl: "linkedin.com/company/kestrel-content" });
    assert.equal(kept.body.company.id, saved.data.company?.id);
    assert.equal(kept.body.company.domain, "kestrelcontent.com");
  });

  it("shows what changed on the page and updates only the ticked fields", async () => {
    const northlight = (await upsertCompany(mark, { name: "Diff Agency", domain: "diff.test" })).body.company;
    const contact = (await upsertContact(mark, { firstName: "Priya", lastName: "Diff", jobTitle: "Founder", companyId: northlight.id, linkedinUrl: "linkedin.com/in/priya-diff" })).body.contact;
    const page = {
      name: "Priya Diff",
      firstName: "Priya",
      lastName: "Diff",
      headline: "Founder and CEO, Diff Agency",
      jobTitle: "Founder and CEO",
      location: "Manchester, England",
      linkedinUrl: "https://www.linkedin.com/in/priya-diff",
      salesNavigatorUrl: null,
      companyName: "Diff Agency Ltd",
      companyLinkedinUrl: null,
    };
    const shown = await call<DiffResponse>(diffRoute, "/api/extension/diff", { token, workspace: mark.workspaceId, body: { contactId: contact.id, person: page } });
    const byField = Object.fromEntries(shown.data.changes.map((row) => [row.field, row]));
    assert.equal(byField.jobTitle.changed, true);
    assert.equal(byField.jobTitle.before, "Founder");
    assert.equal(byField.location.changed, true);
    assert.equal(byField.location.before, null);
    assert.equal(byField.company.changed, false);
    assert.equal(byField.name.changed, false);
    assert.equal(byField.linkedinUrl.changed, false);

    const applied = await call<DiffResponse>(diffRoute, "/api/extension/diff", {
      token,
      workspace: mark.workspaceId,
      body: { contactId: contact.id, person: page, apply: ["location", "name"] },
    });
    assert.deepEqual(applied.data.applied, ["location"]);
    const after = await getContact(mark, contact.id);
    assert.equal(after.location, "Manchester, England");
    assert.equal(after.jobTitle, "Founder");
    const audit = await getAdminPool().query<{ source: string; changes: { fields: string[] } }>(
      "select source, changes from crm.audit_events where entity_id = $1 and event_type = 'contact.updated'",
      [contact.id],
    );
    assert.equal(audit.rows[0].source, "linkedin_extension");
    assert.deepEqual(audit.rows[0].changes.fields, ["location"]);

    const company = (await upsertCompany(mark, { name: "Page Co", domain: "pageco.test" })).body.company;
    const companyDiff = await call<DiffResponse>(diffRoute, "/api/extension/diff", {
      token,
      workspace: mark.workspaceId,
      body: {
        companyId: company.id,
        company: { name: "Page Co", tagline: null, website: "https://www.pageco.test/", industry: "Software", sizeCategory: "2-10", location: null, linkedinUrl: "https://www.linkedin.com/company/page-co" },
        apply: ["linkedinUrl", "industry"],
      },
    });
    assert.deepEqual(companyDiff.data.applied.sort(), ["industry", "linkedinUrl"]);
    assert.equal(companyDiff.data.company?.linkedinUrl, "https://www.linkedin.com/company/page-co");
    assert.equal(companyDiff.data.changes.find((row) => row.field === "website")?.changed, false);
  });

  it("adds tasks owned by the person, notes on person and company, and logs messages once", async () => {
    const company = (await upsertCompany(mark, { name: "Log Co", domain: "logco.test" })).body.company;
    const contact = (await upsertContact(mark, { firstName: "Priya", lastName: "Log", companyId: company.id, linkedinUrl: "linkedin.com/in/priya-log" })).body.contact;

    const task = await call<{ task: { id: string; title: string; dueAt: string } }>(taskRoute, "/api/extension/task", {
      token,
      workspace: mark.workspaceId,
      body: { title: "Send pricing for both clients", due: "tomorrow", remindMinutes: 60, contactId: contact.id },
    });
    assert.equal(task.status, 200);
    const tasks = await listTasks(mark, { contactId: contact.id });
    assert.equal(tasks.data[0].ownerId, mark.userId);
    assert.equal(tasks.data[0].companyId, company.id);
    assert.equal(tasks.data[0].remindMinutes, 60);
    assert.equal(tasks.data[0].dueAt, dueFrom("tomorrow"));
    const badTask = await call(taskRoute, "/api/extension/task", { token, workspace: mark.workspaceId, body: { title: "x", due: "2026-02-30", remindMinutes: null, contactId: contact.id } });
    assert.equal(badTask.status, 400);
    assert.match(dueFrom("2026-11-20") ?? "", /^2026-11-20T09:00:00.000Z$/);

    const note = await call<{ activityId: string }>(noteRoute, "/api/extension/note", {
      token,
      workspace: mark.workspaceId,
      body: { body: "Met at the Manchester SEO meetup.", contactId: contact.id },
    });
    const noted = await getAdminPool().query<{ type: string; contact_id: string; company_id: string }>("select type, contact_id, company_id from crm.activities where id = $1", [note.data.activityId]);
    assert.deepEqual(noted.rows[0], { type: "note", contact_id: contact.id, company_id: company.id });

    const message = await call<{ logged: number }>(logRoute, "/api/extension/log", {
      token,
      workspace: mark.workspaceId,
      body: { kind: "message", contactId: contact.id, direction: "received", occurredAt: "2026-11-06T08:02", text: "Could you join our team call on the 14th?" },
    });
    assert.equal(message.data.logged, 1);

    const thread: ThreadMessage[] = [
      { from: "Priya Log", mine: false, when: "3 Nov, 16:42", at: "2026-11-03T16:42:00.000Z", text: "Thanks for the audit." },
      { from: "Mark Ridgeon", mine: true, when: "3 Nov, 17:05", at: "2026-11-03T17:05:00.000Z", text: "Glad it helped." },
      { from: "Priya Log", mine: false, when: "6 Nov, 08:02", at: null, text: "Could you join our  team call on the 14th?" },
    ];
    const before = await call<LogCheckResponse>(logCheckRoute, "/api/extension/log/check", { token, workspace: mark.workspaceId, body: { contactId: contact.id, messages: thread } });
    assert.deepEqual(before.data.messages.map((item) => Boolean(item.loggedAt)), [false, false, true]);
    assert.equal(before.data.lastLogged?.count, 1);

    const logged = await call<{ activityId: string; logged: number; skipped: number }>(logRoute, "/api/extension/log", {
      token,
      workspace: mark.workspaceId,
      body: { kind: "conversation", contactId: contact.id, title: null, threadUrl: "https://www.linkedin.com/messaging/thread/2-abc/", messages: thread },
    });
    assert.equal(logged.data.logged, 2);
    assert.equal(logged.data.skipped, 1);
    const activity = await getAdminPool().query<{ type: string; title: string; body: string; occurred_at: Date; metadata: { messageCount: number } }>(
      "select type, title, body, occurred_at, metadata from crm.activities where id = $1",
      [logged.data.activityId],
    );
    assert.equal(activity.rows[0].type, "linkedin");
    assert.equal(activity.rows[0].title, "LinkedIn messages with Priya Log");
    assert.equal(activity.rows[0].body, "Priya Log, 3 Nov, 16:42:\nThanks for the audit.\n\nYou, 3 Nov, 17:05:\nGlad it helped.");
    assert.equal(activity.rows[0].occurred_at.toISOString(), "2026-11-03T17:05:00.000Z");
    assert.equal(activity.rows[0].metadata.messageCount, 2);

    const afterLog = await call<LogCheckResponse>(logCheckRoute, "/api/extension/log/check", { token, workspace: mark.workspaceId, body: { contactId: contact.id, messages: [] } });
    assert.deepEqual(afterLog.data.messages, []);
    assert.equal(afterLog.data.lastLogged?.count, 2);
    const again = await call<{ error: { message: string } }>(logRoute, "/api/extension/log", {
      token,
      workspace: mark.workspaceId,
      body: { kind: "conversation", contactId: contact.id, title: null, threadUrl: null, messages: thread },
    });
    assert.equal(again.status, 400);
    assert.match(again.data.error.message, /already logged/);
    assert.equal(messageKey({ mine: false, text: "A  b" }), messageKey({ mine: false, text: "a b" }));
    assert.notEqual(messageKey({ mine: true, text: "a b" }), messageKey({ mine: false, text: "a b" }));

    const sources = await getAdminPool().query<{ event_type: string; source: string }>(
      "select e.event_type, e.source from crm.audit_events e where e.workspace_id = $1 and e.event_type in ('task.created', 'activity.created') and e.created_at > now() - interval '1 minute' and e.source = 'linkedin_extension'",
      [mark.workspaceId],
    );
    assert.ok(sources.rows.filter((row) => row.event_type === "activity.created").length >= 3);
    assert.ok(sources.rows.some((row) => row.event_type === "task.created"));

    const lookup = await call<LookupResponse>(lookupRoute, `/api/extension/lookup?url=${encodeURIComponent("https://www.linkedin.com/in/priya-log")}`, { token });
    const person = lookup.data.workspaces[0].person!;
    assert.equal(person.lastContact?.kind, "LinkedIn");
    assert.equal(person.tasks[0].title, "Send pricing for both clients");
    assert.equal(person.tasks[0].dueLabel, "Tomorrow");
  });

  it("can't see tasks it isn't allowed to and can't write to another person's records in other workspaces", async () => {
    const colleague = await createUser("colleague-records@linkedin.test", "Colleague");
    await getAdminPool().query("insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, 'member')", [mark.workspaceId, colleague.userId]);
    const member = { ...colleague, workspaceId: mark.workspaceId, workspaceName: "Eclipse", role: "member" as const, scopes: scopesForRole("member") };
    const company = (await upsertCompany(member, { name: "Private Task Co", domain: "privatetask.test" })).body.company;
    await createTask(member, { title: "Mine only", companyId: company.id, ownerId: colleague.userId });
    const otherToken = await connect(member, [mark.workspaceId], "Colleague's Chrome");
    const visible = await call<LookupResponse>(lookupRoute, `/api/extension/lookup?url=${encodeURIComponent("https://www.linkedin.com/company/x")}&domain=privatetask.test`, { token: otherToken });
    assert.equal(visible.data.workspaces[0].company?.openTasks, 1);
    const ownerView = await call<LookupResponse>(lookupRoute, `/api/extension/lookup?url=${encodeURIComponent("https://www.linkedin.com/company/x")}&domain=privatetask.test`, { token });
    assert.equal(ownerView.data.workspaces[0].company?.openTasks, 1);
    const refused = await call(noteRoute, "/api/extension/note", { token: otherToken, workspace: ridgeon.workspaceId, body: { body: "x", companyId: company.id } });
    assert.equal(refused.status, 403);
  });
});

describe("contact location and Sales Navigator lead", () => {
  let mark: UserActor;
  let agentToken: string;

  before(async () => {
    mark = await createUser("mark-location@linkedin.test", "Mark Ridgeon");
    agentToken = (await createAgent(mark.workspaceId, ["admin"])).token;
  });

  function agent(path: string, init: { method?: string; body?: string; type?: string } = {}) {
    return new Request(`https://orbit.test${path}`, {
      method: init.method ?? "GET",
      headers: { authorization: `Bearer ${agentToken}`, "content-type": init.type ?? "application/json" },
      body: init.body,
    });
  }

  it("is accepted, validated and returned by the API", async () => {
    const created = await v1ContactUpsert(
      agent("/api/v1/contacts/upsert", {
        method: "POST",
        body: JSON.stringify({ firstName: "Rae", lastName: "Mills", location: "  Leeds,   England ", salesNavigatorUrl: "linkedin.com/sales/lead/ACwAAAraeMills1,NAME_SEARCH" }),
      }),
    );
    assert.equal(created.status, 200);
    const body = (await created.json()) as { contact: { location: string; salesNavigatorUrl: string } };
    assert.equal(body.contact.location, "Leeds,   England");
    assert.equal(body.contact.salesNavigatorUrl, "https://www.linkedin.com/sales/lead/ACwAAAraeMills1");
    const matched = await v1ContactUpsert(
      agent("/api/v1/contacts/upsert", { method: "POST", body: JSON.stringify({ salesNavigatorUrl: "https://www.linkedin.com/sales/lead/ACwAAAraeMills1", location: null }) }),
    );
    const matchedBody = (await matched.json()) as { matchedOn: string; contact: { location: string | null } };
    assert.equal(matchedBody.matchedOn, "sales_navigator");
    assert.equal(matchedBody.contact.location, null);
    const invalid = await v1ContactUpsert(agent("/api/v1/contacts/upsert", { method: "POST", body: JSON.stringify({ firstName: "X", email: "x@x.test", salesNavigatorUrl: "https://example.com/lead" }) }));
    assert.equal(invalid.status, 400);
  });

  it("goes through CSV import and export", async () => {
    const csv = "First name,Last name,Email,Location,Sales Navigator\nJo,Park,jo@park.test,\"Cardiff, Wales\",https://www.linkedin.com/sales/lead/ACwAAAjoPark22\n";
    const imported = await importRoute(agent("/api/v1/import/contacts", { method: "POST", body: csv, type: "text/csv" }), { params: Promise.resolve({ resource: "contacts" }) });
    assert.equal(imported.status, 200);
    const exported = await exportRoute(agent("/api/v1/export/contacts"), { params: Promise.resolve({ resource: "contacts" }) });
    const text = await exported.text();
    const [header, ...rows] = text.trim().split(/\r?\n/);
    assert.match(header, /Company,Location,Sales Navigator,Source/);
    const jo = rows.find((row) => row.includes("jo@park.test"));
    assert.ok(jo?.includes("\"Cardiff, Wales\",https://www.linkedin.com/sales/lead/ACwAAAjoPark22"));
  });
});
