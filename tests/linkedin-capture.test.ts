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
import { createCompany, updateCompany, upsertCompany } from "@/lib/crm/companies";
import { createContact, getContact, upsertContact } from "@/lib/crm/contacts";
import { canonicalSalesNavigator } from "@/lib/crm/normalize";
import { scopesForRole } from "@/lib/crm/scopes";
import { createTask, listTasks } from "@/lib/crm/tasks";
import type { UserActor } from "@/lib/crm/types";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { allowedExtensionOrigins } from "@/lib/extension/http";
import {
  authenticateExtension,
  decidePairing,
  listBrowsers,
  pairingState,
  redeemPairing,
  revokeBrowser,
  revokeSelf,
  setBrowserWorkspaces,
  startPairing,
} from "@/lib/extension/pairing";
import { browserRows } from "@/lib/extension/settings";
import { safeNextPath } from "@/lib/auth/next-path";
import { dueFrom, messageKey, messageKeys } from "@/lib/extension/capture";
import { dueLabel } from "@/lib/extension/records";
import {
  dateRangeIn,
  looksLikeDateOrDuration,
  looksLikeEmploymentType,
  type CaptureResponse,
  type DiffResponse,
  type LogCheckResponse,
  type LookupResponse,
  type MeResponse,
  type PairRedeemResponse,
  type PairStartResponse,
  type ThreadMessage,
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

function inLookup(data: LookupResponse, workspaceId: string) {
  const found = data.workspaces.find((item) => item.workspaceId === workspaceId);
  assert.ok(found, `No lookup for workspace ${workspaceId}`);
  return found;
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
    assert.equal(started.data.approveUrl, "https://orbit.test/connect/chrome");
    assert.ok(!started.data.approveUrl.includes(started.data.code.slice(0, 4)));
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
    const postWithoutOrigin = await call(noteRoute, "/api/extension/note", { token, origin: null, workspace: mark.workspaceId, body: { body: "x" } });
    assert.equal(postWithoutOrigin.status, 403);
    const pairWithoutOrigin = await call<{ error: { code: string } }>(pairRoute, "/api/extension/pair", { body: {}, origin: null, ip: "10.9.9.9" });
    assert.equal(pairWithoutOrigin.status, 403);
    assert.equal(pairWithoutOrigin.data.error.code, "origin_not_allowed");
    const pairFromPage = await call(pairRoute, "/api/extension/pair", { body: {}, origin: "https://evil.test", ip: "10.9.9.9" });
    assert.equal(pairFromPage.status, 403);
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
    const eclipse = inLookup(priya.data, mark.workspaceId);
    const side = inLookup(priya.data, ridgeon.workspaceId);
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
    assert.equal(inLookup(wrongCompany.data, mark.workspaceId).status, "none");

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
    assert.equal(inLookup(notHer.data, mark.workspaceId).status, "none");

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
    assert.equal(inLookup(byPage.data, mark.workspaceId).matchedOn, "linkedin");
    const unlinked = (await upsertCompany(mark, { name: "Plover Media", domain: "plovermedia.com" })).body.company;
    const byDomain = await call<LookupResponse>(lookupRoute, `/api/extension/lookup?url=${encodeURIComponent("https://www.linkedin.com/company/plover-media/")}&domain=www.plovermedia.com`, { token });
    assert.equal(inLookup(byDomain.data, mark.workspaceId).status, "in");
    assert.equal(inLookup(byDomain.data, mark.workspaceId).matchedOn, "domain");
    assert.equal(inLookup(byDomain.data, mark.workspaceId).company?.id, unlinked.id);
    const byName = await call<LookupResponse>(lookupRoute, `/api/extension/lookup?url=${encodeURIComponent("https://www.linkedin.com/company/plover-media/")}&name=Plover%20Media%20Ltd`, { token });
    assert.equal(inLookup(byName.data, mark.workspaceId).matchedOn, "name");
    assert.equal(inLookup(byName.data, mark.workspaceId).status, "in");
    assert.equal(inLookup(byName.data, ridgeon.workspaceId).status, "none");

    const otherPage = await call<LookupResponse>(lookupRoute, `/api/extension/lookup?url=${encodeURIComponent("https://www.linkedin.com/company/999/")}&name=Kestrel%20Content%20Co%20Ltd`, { token });
    assert.equal(inLookup(otherPage.data, mark.workspaceId).status, "maybe");
    assert.equal(inLookup(otherPage.data, mark.workspaceId).presence, "Possible match");
    assert.equal(inLookup(otherPage.data, mark.workspaceId).company, null);
    assert.deepEqual(inLookup(otherPage.data, mark.workspaceId).companyCandidates.map((item) => item.id), [saved.data.company?.id]);
    const otherDomain = await call<LookupResponse>(lookupRoute, `/api/extension/lookup?url=${encodeURIComponent("https://www.linkedin.com/company/123456/")}&domain=www.kestrelcontent.com`, { token });
    assert.equal(inLookup(otherDomain.data, mark.workspaceId).status, "maybe");
    const elsewhere = await call<LookupResponse>(lookupRoute, `/api/extension/lookup?url=${encodeURIComponent("https://www.linkedin.com/company/plover-other/")}&name=Plover%20Media&domain=plover.io`, { token });
    assert.equal(inLookup(elsewhere.data, mark.workspaceId).status, "maybe");
    assert.deepEqual(inLookup(elsewhere.data, mark.workspaceId).companyCandidates.map((item) => item.id), [unlinked.id]);

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
      { from: "Priya Log", mine: false, when: "6 Nov, 08:02", at: "2026-11-06T08:02:00.000Z", text: "Could you join our  team call on the 14th?" },
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
    const person = inLookup(lookup.data, mark.workspaceId).person!;
    assert.equal(person.lastContact?.kind, "LinkedIn");
    assert.equal(person.tasks[0].title, "Send pricing for both clients");
    assert.equal(person.tasks[0].dueLabel, dueLabel(dueFrom("tomorrow")!));
  });

  it("can't see tasks it isn't allowed to and can't write to another person's records in other workspaces", async () => {
    const colleague = await createUser("colleague-records@linkedin.test", "Colleague");
    await getAdminPool().query("insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, 'member')", [mark.workspaceId, colleague.userId]);
    const member = { ...colleague, workspaceId: mark.workspaceId, workspaceName: "Eclipse", role: "member" as const, scopes: scopesForRole("member") };
    const company = (await upsertCompany(member, { name: "Private Task Co", domain: "privatetask.test" })).body.company;
    await createTask(member, { title: "Mine only", companyId: company.id, ownerId: colleague.userId });
    const otherToken = await connect(member, [mark.workspaceId], "Colleague's Chrome");
    const visible = await call<LookupResponse>(lookupRoute, `/api/extension/lookup?url=${encodeURIComponent("https://www.linkedin.com/company/x")}&domain=privatetask.test`, { token: otherToken });
    assert.equal(inLookup(visible.data, mark.workspaceId).company?.openTasks, 1);
    const ownerView = await call<LookupResponse>(lookupRoute, `/api/extension/lookup?url=${encodeURIComponent("https://www.linkedin.com/company/x")}&domain=privatetask.test`, { token });
    assert.equal(inLookup(ownerView.data, mark.workspaceId).company?.openTasks, 1);
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

describe("LinkedIn capture fixes", () => {
  let mark: UserActor;
  let side: UserActor;
  let token: string;

  function person(overrides: Record<string, unknown>) {
    return { firstName: null, lastName: null, jobTitle: null, location: null, linkedinUrl: null, salesNavigatorUrl: null, ...overrides };
  }

  function saveBody(body: Record<string, unknown>) {
    return { kind: "person", company: null, tags: [], boardId: null, stageId: null, sourceUrl: null, ...body };
  }

  before(async () => {
    mark = await createUser("mark-fixes@linkedin.test", "Mark Ridgeon");
    const admin = getAdminPool();
    const workspace = await admin.query<{ id: string }>("insert into crm.workspaces (name, slug) values ('Side fixes', 'side-fixes') returning id");
    await admin.query("insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, 'owner')", [workspace.rows[0].id, mark.userId]);
    side = inWorkspace(mark, workspace.rows[0].id, "Side fixes");
    token = await connect(mark, [side.workspaceId, mark.workspaceId]);
  });

  it("lists workspaces oldest membership first and names the home workspace", async () => {
    const me = await call<MeResponse>(meRoute, "/api/extension/me", { token });
    assert.deepEqual(me.data.workspaces.map((item) => item.id), [mark.workspaceId, side.workspaceId]);
    assert.equal(me.data.homeWorkspaceId, mark.workspaceId);
    const sideOnly = await connect(mark, [side.workspaceId], "Side only");
    const limited = await call<MeResponse>(meRoute, "/api/extension/me", { token: sideOnly });
    assert.equal(limited.data.homeWorkspaceId, null);
    await getAdminPool().query("update crm.workspace_members set created_at = '2026-01-01T00:00:00Z' where user_id = $1", [mark.userId]);
    const sorted = [mark.workspaceId, side.workspaceId].sort();
    const tied = await call<MeResponse>(meRoute, "/api/extension/me", { token });
    assert.deepEqual(tied.data.workspaces.map((item) => item.id), sorted);
    assert.equal(tied.data.homeWorkspaceId, sorted[0]);
  });

  it("never treats a company with another LinkedIn page or domain as the same one", async () => {
    const london = (await upsertCompany(mark, { name: "Harbour Studio", linkedinUrl: "linkedin.com/company/harbour-studio-london" })).body.company;
    const refused = await call<{ error: { code: string; message: string } }>(captureRoute, "/api/extension/capture", {
      token,
      workspace: mark.workspaceId,
      body: saveBody({
        person: person({ firstName: "Ola", lastName: "Harbour", linkedinUrl: "https://www.linkedin.com/in/ola-harbour" }),
        company: { name: "Harbour Studio", domain: null, linkedinUrl: "https://www.linkedin.com/company/harbour-studio-leeds" },
      }),
    });
    assert.equal(refused.status, 409);
    assert.match(refused.data.error.message, /different LinkedIn page or domain/);

    const saved = await call<CaptureResponse>(captureRoute, "/api/extension/capture", {
      token,
      workspace: mark.workspaceId,
      body: saveBody({
        person: person({ firstName: "Ola", lastName: "Harbour", linkedinUrl: "https://www.linkedin.com/in/ola-harbour" }),
        company: { name: "Harbour Studio", domain: "harbourleeds.co.uk", linkedinUrl: "https://www.linkedin.com/company/harbour-studio-leeds" },
      }),
    });
    assert.equal(saved.status, 200);
    assert.equal(saved.data.created.company, true);
    assert.notEqual(saved.data.company?.id, london.id);
    assert.equal(saved.data.company?.linkedinUrl, "https://www.linkedin.com/company/harbour-studio-leeds");
    const untouched = await getAdminPool().query<{ linkedin_url: string }>("select linkedin_url from crm.companies where id = $1", [london.id]);
    assert.equal(untouched.rows[0].linkedin_url, "https://www.linkedin.com/company/harbour-studio-london");

    const tern = (await upsertCompany(mark, { name: "Tern", domain: "tern.io", linkedinUrl: "linkedin.com/company/tern-io" })).body.company;
    const group = await call<CaptureResponse>(captureRoute, "/api/extension/capture", {
      token,
      workspace: mark.workspaceId,
      body: {
        kind: "company",
        company: { name: "Tern Group", domain: "tern.io", linkedinUrl: "https://www.linkedin.com/company/tern-group", industry: null, sizeCategory: null, description: null },
        lifecycle: null,
        tags: [],
        boardId: null,
        stageId: null,
        sourceUrl: null,
      },
    });
    assert.equal(group.status, 200);
    assert.equal(group.data.created.company, true);
    assert.notEqual(group.data.company?.id, tern.id);
    assert.equal(group.data.company?.domain, null);
  });

  it("fills only the empty fields of a company it matched", async () => {
    const quay = (await upsertCompany(mark, { name: "Quay Labs", industry: "Software" })).body.company;
    const saved = await call<CaptureResponse>(captureRoute, "/api/extension/capture", {
      token,
      workspace: mark.workspaceId,
      body: {
        kind: "company",
        company: { name: "Quay Labs", domain: "quaylabs.io", linkedinUrl: "https://www.linkedin.com/company/quay-labs", industry: "Marketing", sizeCategory: "11-50", description: "Research for brands" },
        lifecycle: null,
        tags: [],
        boardId: null,
        stageId: null,
        sourceUrl: null,
      },
    });
    assert.equal(saved.data.created.company, false);
    assert.equal(saved.data.company?.id, quay.id);
    assert.equal(saved.data.company?.domain, "quaylabs.io");
    assert.equal(saved.data.company?.linkedinUrl, "https://www.linkedin.com/company/quay-labs");
    assert.equal(saved.data.company?.industry, "Software");
    assert.equal(saved.data.company?.sizeCategory, "11-50");
  });

  it("links a possible company match by its LinkedIn page", async () => {
    const plain = (await upsertCompany(mark, { name: "Gannet Works", domain: "gannet.works" })).body.company;
    const linked = await call<CaptureResponse>(captureRoute, "/api/extension/capture", {
      token,
      workspace: mark.workspaceId,
      body: { kind: "link_company", companyId: plain.id, linkedinUrl: "https://www.linkedin.com/company/gannet-works/", sourceUrl: null },
    });
    assert.equal(linked.status, 200);
    assert.equal(linked.data.company?.linkedinUrl, "https://www.linkedin.com/company/gannet-works");
    const again = await call<{ error: { message: string } }>(captureRoute, "/api/extension/capture", {
      token,
      workspace: mark.workspaceId,
      body: { kind: "link_company", companyId: plain.id, linkedinUrl: "https://www.linkedin.com/company/gannet-other", sourceUrl: null },
    });
    assert.equal(again.status, 409);
    assert.match(again.data.error.message, /different LinkedIn page/);
  });

  it("keeps what a colleague saved when someone saves the same person again", async () => {
    const colleague = await createUser("colleague-fixes@linkedin.test", "Colleague");
    await getAdminPool().query("insert into crm.workspace_members (workspace_id, user_id, role) values ($1, $2, 'member')", [mark.workspaceId, colleague.userId]);
    const member = { ...colleague, workspaceId: mark.workspaceId, workspaceName: mark.workspaceName, role: "member" as const, scopes: scopesForRole("member") };
    const firm = (await upsertCompany(member, { name: "Bright Partners", domain: "brightpartners.test" })).body.company;
    const ola = (
      await upsertContact(member, {
        firstName: "Ola",
        lastName: "Bright",
        jobTitle: "Founder",
        location: "Leeds, England",
        linkedinUrl: "linkedin.com/in/ola-bright",
        companyId: firm.id,
        ownerId: colleague.userId,
        tags: ["vip"],
        source: "Referral",
      })
    ).body.contact;

    const resaved = await call<CaptureResponse>(captureRoute, "/api/extension/capture", {
      token,
      workspace: mark.workspaceId,
      body: saveBody({
        person: person({ firstName: "Ola", lastName: "Bright", linkedinUrl: "https://www.linkedin.com/in/ola-bright/" }),
        company: { name: "Another Firm", domain: null, linkedinUrl: null },
      }),
    });
    assert.equal(resaved.status, 200);
    assert.equal(resaved.data.created.contact, false);
    assert.equal(resaved.data.person?.id, ola.id);
    const kept = await getContact(mark, ola.id);
    assert.equal(kept?.jobTitle, "Founder");
    assert.equal(kept?.location, "Leeds, England");
    assert.equal(kept?.ownerId, colleague.userId);
    assert.deepEqual(kept?.tags, ["vip"]);
    assert.equal(kept?.source, "Referral");
    assert.equal(kept?.companyId, firm.id);

    const tagged = await call<CaptureResponse>(captureRoute, "/api/extension/capture", {
      token,
      workspace: mark.workspaceId,
      body: saveBody({
        person: person({ firstName: "Ola", lastName: "Bright", jobTitle: "CEO", linkedinUrl: "https://www.linkedin.com/in/ola-bright" }),
        tags: ["agency"],
        ownerId: mark.userId,
      }),
    });
    assert.deepEqual([...(tagged.data.person?.tags ?? [])].sort(), ["agency", "vip"]);
    assert.equal(tagged.data.person?.jobTitle, "CEO");
    assert.equal(tagged.data.person?.owner?.id, mark.userId);
    const leads = await getAdminPool().query("select 1 from crm.audit_events where event_type = 'lead.created' and changes->>'contactId' = $1", [ola.id]);
    assert.equal(leads.rowCount, 0);
  });

  it("saves and matches a Sales Navigator lead with nothing else to go on", async () => {
    const saved = await call<CaptureResponse>(captureRoute, "/api/extension/capture", {
      token,
      workspace: mark.workspaceId,
      body: saveBody({ person: person({ salesNavigatorUrl: "https://www.linkedin.com/sales/lead/ACwAAOnlyLead1,NAME_SEARCH" }) }),
    });
    assert.equal(saved.status, 200);
    assert.equal(saved.data.created.contact, true);
    const upserted = await upsertContact(mark, { salesNavigatorUrl: "https://www.linkedin.com/sales/lead/ACwAAOnlyLead1", jobTitle: "Buyer" });
    assert.equal(upserted.body.matchedOn, "sales_navigator");
    assert.equal(upserted.body.contact.id, saved.data.person?.id);
    await assert.rejects(
      createContact(mark, { firstName: "Copy", salesNavigatorUrl: "https://www.linkedin.com/sales/lead/ACwAAOnlyLead1" }),
      (error: Error & { code?: string }) => error.code === "duplicate_contact",
    );
    await assert.rejects(
      getAdminPool().query("update crm.contacts set first_name = null, last_name = null, sales_navigator_url = null where id = $1", [saved.data.person?.id]),
      /contacts_identity/,
    );
  });

  it("matches a lead page by the public profile link on it", async () => {
    const lena = (await upsertContact(mark, { firstName: "Lena", lastName: "Park", linkedinUrl: "linkedin.com/in/lena-park" })).body.contact;
    const lookup = await call<LookupResponse>(
      lookupRoute,
      `/api/extension/lookup?url=${encodeURIComponent("https://www.linkedin.com/sales/lead/ACwAALenaPark1,NAME_SEARCH")}&linkedinUrl=${encodeURIComponent("https://www.linkedin.com/in/lena-park/")}`,
      { token },
    );
    const found = inLookup(lookup.data, mark.workspaceId);
    assert.equal(found.status, "in");
    assert.equal(found.matchedOn, "linkedin");
    assert.equal(found.person?.id, lena.id);
  });

  it("keeps LinkedIn pages and domains on the company they belong to when upserting", async () => {
    const wren = (await upsertCompany(mark, { name: "Wren", domain: "wren.io" })).body.company;
    const labs = (await upsertCompany(mark, { name: "Wren Labs", linkedinUrl: "linkedin.com/company/wren-labs" })).body.company;
    const upserted = await upsertCompany(mark, { name: "Wren", domain: "wren.io", linkedinUrl: "linkedin.com/company/wren-labs" });
    assert.equal(upserted.body.company.id, wren.id);
    assert.equal(upserted.body.company.linkedinUrl, null);
    const labsRow = await getAdminPool().query<{ linkedin_url: string }>("select linkedin_url from crm.companies where id = $1", [labs.id]);
    assert.equal(labsRow.rows[0].linkedin_url, "https://www.linkedin.com/company/wren-labs");

    const finch = (await upsertCompany(mark, { name: "Finch", domain: "finch.io", website: "https://finch.io", linkedinUrl: "linkedin.com/company/finch" })).body.company;
    const moved = await upsertCompany(mark, { name: "Finch", domain: "finch.co", website: "https://finch.co", linkedinUrl: "linkedin.com/company/finch" });
    assert.equal(moved.body.company.id, finch.id);
    assert.equal(moved.body.company.domain, "finch.io");
    assert.equal(moved.body.company.website, "https://finch.io/");

    await assert.rejects(createCompany(mark, { name: "Other Finch", linkedinUrl: "linkedin.com/company/finch" }), /already has that LinkedIn page/);
    await assert.rejects(updateCompany(mark, labs.id, { linkedinUrl: "linkedin.com/company/finch" }), /already has that LinkedIn page/);
    const index = await getAdminPool().query("select 1 from pg_indexes where schemaname = 'crm' and indexname = 'companies_workspace_linkedin_active_uidx'");
    assert.equal(index.rowCount, 1);
  });

  it("only takes a domain from the page's website when it isn't a shared host", async () => {
    const shared = (await upsertCompany(mark, { name: "Shared Host Co" })).body.company;
    const applied = await call<DiffResponse>(diffRoute, "/api/extension/diff", {
      token,
      workspace: mark.workspaceId,
      body: {
        companyId: shared.id,
        company: { name: "Shared Host Co", tagline: null, website: "https://www.facebook.com/sharedhostco", industry: null, sizeCategory: null, location: null, linkedinUrl: null },
        apply: ["website"],
      },
    });
    assert.deepEqual(applied.data.applied, ["website"]);
    assert.match(applied.data.company?.website ?? "", /facebook\.com\/sharedhostco/);
    assert.equal(applied.data.company?.domain, null);

    const own = (await upsertCompany(mark, { name: "Own Host Co" })).body.company;
    const owned = await call<DiffResponse>(diffRoute, "/api/extension/diff", {
      token,
      workspace: mark.workspaceId,
      body: {
        companyId: own.id,
        company: { name: "Own Host Co", tagline: null, website: "https://www.ownhost.example/", industry: null, sizeCategory: null, location: null, linkedinUrl: null },
        apply: ["website"],
      },
    });
    assert.equal(owned.data.company?.domain, "ownhost.example");
  });

  it("signs out only the browser that asks, once", async () => {
    const own = await connect(mark, [mark.workspaceId], "Sign out once");
    const other = await connect(mark, [mark.workspaceId], "Keep me");
    const auth = await authenticateExtension(new Request("https://orbit.test/api/extension/revoke", { headers: { authorization: `Bearer ${own}` } }));
    await revokeSelf(auth);
    await assert.rejects(revokeSelf(auth), /already disconnected/);
    assert.equal((await call(meRoute, "/api/extension/me", { token: own })).status, 401);
    assert.equal((await call(meRoute, "/api/extension/me", { token: other })).status, 200);
  });

  it("logs the same words again when they were sent on another occasion", async () => {
    const contact = (await upsertContact(mark, { firstName: "Tom", lastName: "Again", linkedinUrl: "linkedin.com/in/tom-again" })).body.contact;
    const plain = messageKeys([
      { mine: false, text: "Thanks!" },
      { mine: false, text: "Thanks!" },
    ]);
    assert.notEqual(plain[0], plain[1]);
    assert.equal(plain[0], messageKey({ mine: false, text: "thanks!" }));
    assert.equal(
      messageKey({ mine: false, text: "Thanks!", at: "2026-11-02T09:00:10.000Z" }),
      messageKey({ mine: false, text: "Thanks!", at: "2026-11-02T09:00:40.000Z" }),
    );
    const thread: ThreadMessage[] = [
      { from: "Tom Again", mine: false, when: "2 Nov, 09:00", at: "2026-11-02T09:00:00.000Z", text: "Thanks!" },
      { from: "Mark Ridgeon", mine: true, when: "3 Nov, 10:00", at: "2026-11-03T10:00:00.000Z", text: "Here is the report." },
      { from: "Tom Again", mine: false, when: "4 Nov, 11:00", at: "2026-11-04T11:00:00.000Z", text: "Thanks!" },
    ];
    const logged = await call<{ logged: number; skipped: number }>(logRoute, "/api/extension/log", {
      token,
      workspace: mark.workspaceId,
      body: { kind: "conversation", contactId: contact.id, title: null, threadUrl: null, messages: thread },
    });
    assert.equal(logged.data.logged, 3);
    const later = [...thread, { from: "Tom Again", mine: false, when: "6 Nov, 08:00", at: "2026-11-06T08:00:00.000Z", text: "Thanks!" }];
    const check = await call<LogCheckResponse>(logCheckRoute, "/api/extension/log/check", { token, workspace: mark.workspaceId, body: { contactId: contact.id, messages: later } });
    assert.deepEqual(check.data.messages.map((item) => Boolean(item.loggedAt)), [true, true, true, false]);
  });

  it("dates quick task choices so they aren't overdue straight away", () => {
    assert.equal(dueFrom("today", new Date("2026-11-06T10:00:00Z")), "2026-11-06T17:30:00.000Z");
    assert.equal(dueFrom("today", new Date("2026-11-06T17:00:00Z")), "2026-11-06T18:00:00.000Z");
    assert.equal(dueFrom("tomorrow", new Date("2026-11-06T10:00:00Z")), "2026-11-09T09:00:00.000Z");
    assert.equal(dueFrom("tomorrow", new Date("2026-11-04T10:00:00Z")), "2026-11-05T09:00:00.000Z");
    assert.equal(dueFrom("tomorrow", new Date("2026-08-28T10:00:00Z")), "2026-09-01T08:00:00.000Z");
    assert.equal(dueFrom("next_week", new Date("2026-11-06T10:00:00Z")), "2026-11-09T09:00:00.000Z");
    assert.equal(dueFrom("next_week", new Date("2026-11-09T10:00:00Z")), "2026-11-16T09:00:00.000Z");
    assert.equal(dueFrom("2026-11-06", new Date("2026-11-06T12:00:00Z")), "2026-11-06T17:30:00.000Z");
    assert.equal(dueFrom("2026-11-20", new Date("2026-11-06T12:00:00Z")), "2026-11-20T09:00:00.000Z");
  });

  it("calls an approved code expired once its window has passed", async () => {
    const started = await startPairing("https://orbit.test");
    await decidePairing(mark, { code: started.code, name: "Late Chrome", workspaceIds: [mark.workspaceId], approve: true });
    assert.equal((await pairingState(started.code)).state, "approved");
    await getAdminPool().query("update crm.extension_pairings set decided_at = now() - interval '11 minutes' where status = 'approved'");
    assert.equal((await pairingState(started.code)).state, "expired");
    await assert.rejects(redeemPairing(started.code, started.secret), /expired/);
    await assert.rejects(decidePairing(mark, { code: "", name: "Chrome", workspaceIds: [mark.workspaceId], approve: true }), /8-character code/);
  });

  it("only returns to safe pages after signing in", () => {
    assert.equal(safeNextPath("/connect/chrome?name=Chrome"), "/connect/chrome?name=Chrome");
    assert.equal(safeNextPath("/open?workspace=a&to=/companies/b"), "/open?workspace=a&to=/companies/b");
    assert.equal(safeNextPath("/openx"), null);
    assert.equal(safeNextPath("/connect/../mail"), null);
    assert.equal(safeNextPath("/connect/%2e%2e/mail"), null);
    assert.equal(safeNextPath("/connect/./chrome"), null);
    assert.equal(safeNextPath("/connect/chrome\u0007"), null);
    assert.equal(safeNextPath("/connect/%0d%0aSet-Cookie"), null);
    assert.equal(safeNextPath("//evil.test/connect/"), null);
  });

  it("shows the year on Last used when it was another year", () => {
    const rows = browserRows(
      [
        { id: "a", name: "Old", createdAt: "2025-03-01T10:00:00Z", lastUsedAt: "2025-12-30T10:00:00Z", workspaces: [] },
        { id: "b", name: "Recent", createdAt: "2026-03-01T10:00:00Z", lastUsedAt: "2026-10-30T10:00:00Z", workspaces: [] },
      ],
      new Date("2026-11-06T12:00:00Z"),
    );
    assert.equal(rows[0].usedLabel, "Last used 30 Dec 2025");
    assert.equal(rows[1].usedLabel, "Last used 30 Oct");
  });

  it("tells date ranges and durations apart from real names", () => {
    for (const value of ["Jan 2016 - Sep 2024", "Oct 2024 - Present · 2 yrs 2 mos", "Mar 2024 to now", "2015 to 2018", "Full-time · 13 yrs 3 mos", "9 mos", "Present", "2019"]) {
      assert.equal(looksLikeDateOrDuration(value), true, value);
    }
    for (const value of [
      "Okt. 2024 \u2013 Heute · 2 J. 2 Mon.",
      "Okt. 2024 \u2013 Heute, Vollzeit",
      "Jan. 2016 \u2013 Sept. 2024",
      "oct. 2024 - actualidad",
      "ene. 2016 - sept. 2024 · 8 años 9 meses",
      "oct. 2024 - aujourd’hui · 2 ans 2 mois",
      "out. de 2024 - o momento",
      "gen 2020 - Oggi",
      "okt. 2024 - Huidig",
      "Heute",
      "actualidad",
    ]) {
      assert.equal(looksLikeDateOrDuration(value), true, value);
    }
    for (const value of [
      "PORTABL",
      "Northwind",
      "2020 Ventures",
      "May Lewis",
      "Now Pensions",
      "Vision 2030",
      "7 Eleven",
      "Chief Commercial Officer (CCO)",
      "London Area, United Kingdom",
      "Greater Anglia",
      "Greater London Authority",
      "Greater Manchester Police",
    ]) {
      assert.equal(looksLikeDateOrDuration(value), false, value);
    }
    assert.equal(dateRangeIn("Okt. 2024 \u2013 Heute · 2 J. 2 Mon."), "current");
    assert.equal(dateRangeIn("oct. 2024 - aujourd’hui"), "current");
    assert.equal(dateRangeIn("janv. 2016 - sept. 2024 · 8 ans 9 mois"), "past");
    assert.equal(dateRangeIn("Oct 2024 - Present · 2 yrs 2 mos"), "current");
    assert.equal(dateRangeIn("2015 to 2018"), "past");
    for (const value of ["Full-time", "Freelance", "Vollzeit", "Jornada completa", "Temps plein", "PORTABL · Freelance"]) {
      assert.equal(looksLikeEmploymentType(value), true, value);
    }
    assert.equal(looksLikeEmploymentType("Contract Manager"), false);
  });

  it("blanks employment types and localised dates read as a company or name", async () => {
    for (const name of ["oct. 2024 - actualidad", "Full-time", "Vollzeit"]) {
      const slug = `blank-${name.replace(/[^a-z]/gi, "").toLowerCase()}`;
      const saved = await call<CaptureResponse>(captureRoute, "/api/extension/capture", {
        token,
        workspace: mark.workspaceId,
        body: saveBody({
          person: person({ firstName: "Robin", lastName: "Okt. 2024 \u2013 Heute", linkedinUrl: `https://www.linkedin.com/in/${slug}` }),
          company: { name, domain: null, linkedinUrl: null },
        }),
      });
      assert.equal(saved.status, 200, name);
      assert.equal(saved.data.company, null, name);
      assert.equal(saved.data.person?.lastName, null, name);
    }
    const leaked = await getAdminPool().query("select 1 from crm.companies where name in ('oct. 2024 - actualidad', 'Full-time', 'Vollzeit')");
    assert.equal(leaked.rowCount, 0);
  });

  it("never makes a company from a date range read off the page", async () => {
    const before = await getAdminPool().query("select 1 from crm.companies where workspace_id = $1", [mark.workspaceId]);
    const saved = await call<CaptureResponse>(captureRoute, "/api/extension/capture", {
      token,
      workspace: mark.workspaceId,
      body: saveBody({
        person: person({ firstName: "Dana", lastName: "Range", jobTitle: "Oct 2024 - Present", linkedinUrl: "https://www.linkedin.com/in/dana-range" }),
        company: { name: "Jan 2016 - Sep 2024", domain: null, linkedinUrl: null },
      }),
    });
    assert.equal(saved.status, 200);
    assert.equal(saved.data.created.company, false);
    assert.equal(saved.data.company, null);
    assert.equal(saved.data.person?.jobTitle, null);
    const afterSave = await getAdminPool().query("select 1 from crm.companies where workspace_id = $1", [mark.workspaceId]);
    assert.equal(afterSave.rowCount, before.rowCount);
    const named = await getAdminPool().query("select 1 from crm.companies where name ilike '%2016%'");
    assert.equal(named.rowCount, 0);

    const diff = await call<DiffResponse>(diffRoute, "/api/extension/diff", {
      token,
      workspace: mark.workspaceId,
      body: {
        contactId: saved.data.person?.id,
        person: {
          name: "Dana Range",
          firstName: "Dana",
          lastName: "Range",
          headline: null,
          jobTitle: "Jan 2016 - Sep 2024",
          location: null,
          linkedinUrl: "https://www.linkedin.com/in/dana-range",
          salesNavigatorUrl: null,
          companyName: "Oct 2024 - Present · 2 yrs 2 mos",
          companyLinkedinUrl: null,
        },
      },
    });
    assert.equal(diff.status, 200);
    assert.equal(diff.data.changes.find((row) => row.field === "company"), undefined);
    assert.equal(diff.data.changes.find((row) => row.field === "jobTitle"), undefined);
  });
});
