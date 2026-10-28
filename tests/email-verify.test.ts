import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { describeAction, recordNames } from "@/lib/assistant/tools";
import { createContact } from "@/lib/crm/contacts";
import { CrmError } from "@/lib/crm/errors";
import type { UserActor } from "@/lib/crm/types";
import { getAdminPool, getPool } from "@/lib/db/pool";
import { NO_EMAIL_CHECKER, latestEmailCheck, verifyContactEmail, verifyEmail } from "@/lib/enrichment/email-check";
import { createUser, resetDatabase } from "./helpers";

type Call = { url: string; method: string; body: Record<string, unknown> | null };
type Route = (call: Call) => { status?: number; body: unknown } | null;

function fake(routes: Route[]) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const call = { url, method: init.method ?? "GET", body: typeof init.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null };
    calls.push(call);
    for (const route of routes) {
      const hit = route(call);
      if (hit) return new Response(JSON.stringify(hit.body), { status: hit.status ?? 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ message: "unexpected" }), { status: 404 });
  }) as typeof fetch;
  return { calls, fetchImpl, hits: (part: string) => calls.filter((call) => call.url.includes(part)).length };
}

const ENV = { HUNTER_API_KEY: "hun", ENROW_API_KEY: "enr", ICYPEAS_API_KEY: "icy" };
const FAST = { pollMs: 5 };
const ADDRESS = "jane@acme-check.test";

const enrow = (qualification: string): Route => (call) => {
  if (call.url.endsWith("/email/verify/single") && call.method === "POST") return { body: { id: "ver_1" } };
  if (call.url.includes("/email/verify/single?id=")) return { body: { email: ADDRESS, qualification } };
  return null;
};
const icypeas = (certainty: string): Route => (call) => {
  if (call.url.endsWith("/api/email-verification")) return { body: { success: true, item: { _id: "icy_v", status: "NONE" } } };
  if (call.url.endsWith("/api/bulk-single-searchs/read")) {
    return { body: { items: [{ _id: "icy_v", status: "DEBITED", results: { emails: [{ email: ADDRESS, certainty }] } }] } };
  }
  return null;
};
const hunter = (status: string): Route => (call) =>
  call.url.includes("api.hunter.io/v2/email-verifier") ? { body: { data: { status } } } : null;
const outOfCredits: Route = () => ({ status: 402, body: { message: "No credits" } });

async function rejects(run: () => Promise<unknown>, check: { code: string; status?: number; message?: RegExp | string }) {
  await assert.rejects(run, (error: unknown) => {
    assert.ok(error instanceof CrmError, `expected CrmError, got ${String(error)}`);
    assert.equal(error.code, check.code);
    if (check.status) assert.equal(error.status, check.status);
    if (typeof check.message === "string") assert.equal(error.message, check.message);
    if (check.message instanceof RegExp) assert.match(error.message, check.message);
    return true;
  });
}

async function checks() {
  const rows = await getAdminPool().query<{ record_id: string; status: string; provider: string | null; value: string; attempts: unknown[] }>(
    "select record_id, status, provider, value, attempts from crm.enrichment_lookups where field = 'email_check' order by created_at",
  );
  return rows.rows;
}

before(async () => {
  await resetDatabase();
});

after(async () => {
  await getPool().end();
});

describe("checking an email address", () => {
  let owner: UserActor;
  let jane: string;

  beforeEach(async () => {
    await resetDatabase();
    owner = await createUser("checker@orbit.test", "Mark Ridgeon");
    jane = (await createContact(owner, { firstName: "Jane", lastName: "Doe", email: "Jane@Acme-Check.test" })).body.contact.id;
  });

  it("confirms a valid address with the first checker and saves it on the contact", async () => {
    const api = fake([enrow("valid")]);
    const check = await verifyContactEmail(owner, jane, { env: ENV, fetchImpl: api.fetchImpl, ...FAST });
    assert.equal(check.email, ADDRESS);
    assert.equal(check.verdict, "valid");
    assert.equal(check.provider, "enrow");
    assert.equal(check.providerName, "Enrow");
    assert.equal(check.cached, false);
    assert.equal(check.contactId, jane);
    assert.equal(api.hits("icypeas"), 0);
    assert.equal(api.hits("hunter"), 0);
    const saved = await checks();
    assert.equal(saved.length, 1);
    assert.deepEqual({ ...saved[0], attempts: undefined }, { record_id: jane, status: "valid", provider: "enrow", value: ADDRESS, attempts: undefined });
    assert.deepEqual(saved[0].attempts, [{ provider: "enrow", outcome: "valid" }]);
  });

  it("moves to the next checker when one can't tell, and reports invalid", async () => {
    const api = fake([enrow("catch_all"), icypeas("undeliverable")]);
    const check = await verifyEmail(owner, ADDRESS, { env: ENV, fetchImpl: api.fetchImpl, ...FAST });
    assert.equal(check.verdict, "invalid");
    assert.equal(check.provider, "icypeas");
    assert.equal(check.contactId, jane);
    assert.equal(api.hits("hunter"), 0);
    assert.equal((await checks())[0].status, "invalid");
  });

  it("gives unknown when no checker can tell, naming the last one asked", async () => {
    const api = fake([enrow("catch_all"), icypeas("probable_not"), hunter("accept_all")]);
    const check = await verifyEmail(owner, ADDRESS, { env: ENV, fetchImpl: api.fetchImpl, ...FAST });
    assert.equal(check.verdict, "unknown");
    assert.equal(check.provider, "hunter");
    assert.equal(api.hits("api.enrow.io"), 2);
    assert.equal(api.hits("api.hunter.io"), 1);
  });

  it("reuses a recent check without spending a credit, and checks again when asked or when it's old", async () => {
    await verifyEmail(owner, ADDRESS, { env: ENV, fetchImpl: fake([enrow("valid")]).fetchImpl, ...FAST });
    const again = fake([enrow("invalid")]);
    const cached = await verifyEmail(owner, " JANE@acme-check.test ", { env: ENV, fetchImpl: again.fetchImpl, ...FAST });
    assert.equal(cached.verdict, "valid");
    assert.equal(cached.cached, true);
    assert.equal(again.calls.length, 0);
    assert.equal((await latestEmailCheck(owner, ADDRESS))?.verdict, "valid");

    const refreshed = await verifyEmail(owner, ADDRESS, { env: ENV, fetchImpl: again.fetchImpl, refresh: true, ...FAST });
    assert.equal(refreshed.verdict, "invalid");
    assert.equal(refreshed.cached, false);
    assert.equal((await latestEmailCheck(owner, ADDRESS))?.verdict, "invalid");

    await getAdminPool().query("update crm.enrichment_lookups set created_at = now() - interval '31 days'");
    const stale = fake([enrow("valid")]);
    assert.equal((await verifyEmail(owner, ADDRESS, { env: ENV, fetchImpl: stale.fetchImpl, ...FAST })).cached, false);
    assert.ok(stale.calls.length > 0);
  });

  it("keeps an unknown result for a day only", async () => {
    const unsure = fake([enrow("catch_all"), icypeas("probable_not"), hunter("accept_all")]);
    await verifyEmail(owner, ADDRESS, { env: ENV, fetchImpl: unsure.fetchImpl, ...FAST });
    const soon = fake([enrow("valid")]);
    assert.equal((await verifyEmail(owner, ADDRESS, { env: ENV, fetchImpl: soon.fetchImpl, ...FAST })).cached, true);
    assert.equal(soon.calls.length, 0);
    await getAdminPool().query("update crm.enrichment_lookups set created_at = now() - interval '25 hours'");
    const later = await verifyEmail(owner, ADDRESS, { env: ENV, fetchImpl: soon.fetchImpl, ...FAST });
    assert.equal(later.verdict, "valid");
    assert.equal(later.cached, false);
  });

  it("treats an address Orbit found and verified as valid, crediting the checker, and ignores unverified finds", async () => {
    await getAdminPool().query(
      `insert into crm.enrichment_lookups (workspace_id, record_type, record_id, field, status, provider, value, created_at)
       values ($1, 'contact', $2, 'email', 'found', 'hunter', $3, now() - interval '1 hour')`,
      [owner.workspaceId, jane, ADDRESS],
    );
    assert.equal(await latestEmailCheck(owner, ADDRESS), null);

    await getAdminPool().query(
      `insert into crm.enrichment_lookups (workspace_id, record_type, record_id, field, status, provider, value, attempts)
       values ($1, 'contact', $2, 'email', 'found', 'context', $3, $4::jsonb)`,
      [owner.workspaceId, jane, ADDRESS, JSON.stringify([{ provider: "context", outcome: "found", verifiedBy: "enrow" }])],
    );
    const api = fake([enrow("invalid")]);
    const check = await verifyEmail(owner, ADDRESS, { env: ENV, fetchImpl: api.fetchImpl, ...FAST });
    assert.deepEqual(
      { verdict: check.verdict, source: check.source, provider: check.provider, providerName: check.providerName, cached: check.cached },
      { verdict: "valid", source: "find", provider: "enrow", providerName: "Enrow", cached: true },
    );
    assert.equal(api.calls.length, 0);
  });

  it("checks an address whose only find wasn't verified", async () => {
    await getAdminPool().query(
      `insert into crm.enrichment_lookups (workspace_id, record_type, record_id, field, status, provider, value)
       values ($1, 'contact', $2, 'email', 'found', 'context', $3)`,
      [owner.workspaceId, jane, ADDRESS],
    );
    const api = fake([enrow("invalid")]);
    const check = await verifyEmail(owner, ADDRESS, { env: ENV, fetchImpl: api.fetchImpl, ...FAST });
    assert.deepEqual({ verdict: check.verdict, source: check.source, cached: check.cached }, { verdict: "invalid", source: "check", cached: false });
    assert.ok(api.calls.length > 0);
  });

  it("marks an old check stale so it isn't read as confirmed", async () => {
    await verifyEmail(owner, ADDRESS, { env: ENV, fetchImpl: fake([enrow("valid")]).fetchImpl, ...FAST });
    const fresh = await latestEmailCheck(owner, ADDRESS);
    assert.deepEqual({ verdict: fresh?.verdict, stale: fresh?.stale }, { verdict: "valid", stale: false });
    await getAdminPool().query("update crm.enrichment_lookups set created_at = now() - interval '240 days'");
    const old = await latestEmailCheck(owner, ADDRESS);
    assert.deepEqual({ verdict: old?.verdict, stale: old?.stale }, { verdict: "valid", stale: true });
    assert.equal((await latestEmailCheck(owner, ADDRESS, Date.now() - 239 * 86_400_000))?.stale, false);
  });

  it("reads Hunter's webmail and accept-all as unknown, and disposable as invalid", async () => {
    const only = { HUNTER_API_KEY: "hun" };
    for (const [status, verdict] of [
      ["webmail", "unknown"],
      ["accept_all", "unknown"],
      ["disposable", "invalid"],
      ["invalid", "invalid"],
      ["valid", "valid"],
    ]) {
      const check = await verifyEmail(owner, "someone@gmail.com", { env: only, fetchImpl: fake([hunter(status)]).fetchImpl, refresh: true, ...FAST });
      assert.equal(check.verdict, verdict, status);
    }
  });

  it("refuses to check an address that isn't the contact's before spending a credit", async () => {
    const api = fake([enrow("valid")]);
    await rejects(() => verifyEmail(owner, "jane.doe@other-check.test", { contactId: jane, env: ENV, fetchImpl: api.fetchImpl, ...FAST }), {
      code: "invalid_input",
      message: `Jane Doe's email is ${ADDRESS}, not jane.doe@other-check.test.`,
    });
    assert.equal(api.calls.length, 0);
    assert.equal((await checks()).length, 0);
  });

  it("checks an address that isn't a contact without saving it", async () => {
    const api = fake([enrow("valid")]);
    const first = await verifyEmail(owner, "someone@else-check.test", { env: ENV, fetchImpl: api.fetchImpl, ...FAST });
    assert.equal(first.verdict, "valid");
    assert.equal(first.contactId, null);
    assert.equal((await checks()).length, 0);
    const second = await verifyEmail(owner, "someone@else-check.test", { env: ENV, fetchImpl: api.fetchImpl, ...FAST });
    assert.equal(second.cached, false);
  });

  it("refuses bad input, missing checkers, failures and too many lookups", async () => {
    const api = fake([enrow("valid")]);
    await rejects(() => verifyEmail(owner, "not an email", { env: ENV, fetchImpl: api.fetchImpl }), { code: "invalid_input" });
    await rejects(() => verifyEmail(owner, ADDRESS, { env: { CONTEXT_DEV_API_KEY: "ctx" }, fetchImpl: api.fetchImpl }), {
      code: "not_configured",
      message: NO_EMAIL_CHECKER,
    });
    const noEmail = (await createContact(owner, { firstName: "No", lastName: "Email" })).body.contact.id;
    await rejects(() => verifyContactEmail(owner, noEmail, { env: ENV, fetchImpl: api.fetchImpl }), { code: "invalid_input", message: /has no email/ });
    assert.equal(api.calls.length, 0);

    await rejects(() => verifyEmail(owner, ADDRESS, { env: ENV, fetchImpl: fake([outOfCredits]).fetchImpl, ...FAST }), {
      code: "upstream_error",
      message: /out of credits/,
    });
    assert.equal((await checks()).length, 0);

    await getAdminPool().query(
      `insert into private.rate_limit_buckets (bucket_key, window_start, request_count)
       values ($1, to_timestamp(floor(extract(epoch from clock_timestamp()) / 3600) * 3600), 300)
       on conflict (bucket_key) do update set request_count = 300, window_start = excluded.window_start`,
      [`enrich:${owner.userId}`],
    );
    await rejects(() => verifyEmail(owner, ADDRESS, { env: ENV, fetchImpl: api.fetchImpl, ...FAST }), { code: "rate_limited", status: 429 });
    assert.equal(api.calls.length, 0);
  });

  it("shows the address and the credit on the assistant's card", async () => {
    const names = await recordNames(owner, [{ email: ADDRESS, contactId: jane }]);
    const card = describeAction("verify_email", { email: ADDRESS, contactId: jane }, names);
    assert.equal(card.title, `Check address: ${ADDRESS}`);
    assert.deepEqual(card.lines, ["Contact: Jane Doe", "Uses an email checker credit."]);
  });
});
