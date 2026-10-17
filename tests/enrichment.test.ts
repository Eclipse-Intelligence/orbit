import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createCompany, getCompany, updateCompany } from "@/lib/crm/companies";
import { createContact, getContact } from "@/lib/crm/contacts";
import type { UserActor } from "@/lib/crm/types";
import { getPool } from "@/lib/db/pool";
import { brandToCompany, enrichCompany, sizeFromEmployees } from "@/lib/enrichment/companies";
import { contactLookups, enrichContact, enrichContacts } from "@/lib/enrichment/contacts";
import { linkedinProfileIn } from "@/lib/enrichment/providers";
import { enrichmentAvailability, getEnrichmentSettings, saveEnrichmentSettings } from "@/lib/enrichment/settings";
import { createUser, resetDatabase } from "./helpers";

type Call = { url: string; method: string; body: Record<string, unknown> | null; headers: Headers };
type Route = (call: Call) => { status?: number; body: unknown } | null;

function fake(routes: Route[]) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const call = {
      url,
      method: init.method ?? "GET",
      body: typeof init.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null,
      headers: new Headers(init.headers),
    };
    calls.push(call);
    for (const route of routes) {
      const hit = route(call);
      if (hit) return new Response(JSON.stringify(hit.body), { status: hit.status ?? 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ message: "unexpected" }), { status: 404 });
  }) as typeof fetch;
  return { calls, fetchImpl, hits: (part: string) => calls.filter((call) => call.url.includes(part)).length };
}

const ENV = { CONTEXT_DEV_API_KEY: "ctx", HUNTER_API_KEY: "hun", ENROW_API_KEY: "enr", ICYPEAS_API_KEY: "icy" };
const FAST = { pollMs: 5 };

const contextPerson = (person: Record<string, unknown>, score = 88): Route => (call) =>
  call.url.endsWith("/v1/people/enrich") ? { body: { match: { status: "candidate", score, person } } } : null;
const contextNone: Route = (call) => (call.url.endsWith("/v1/people/enrich") ? { body: { match: { status: "not_found" } } } : null);
const enrowVerify = (verdict: "valid" | "invalid"): Route => (call) => {
  if (call.url.endsWith("/email/verify/single") && call.method === "POST") return { body: { id: "ver_1", credits_used: 0.25 } };
  if (call.url.includes("/email/verify/single?id=")) return { body: { email: "x", qualification: verdict } };
  return null;
};
const hunterFinds = (email: string | null, extra: Record<string, unknown> = {}): Route => (call) =>
  call.url.includes("api.hunter.io/v2/email-finder")
    ? { body: { data: { email, score: email ? 96 : null, verification: { status: email ? "valid" : null }, ...extra } } }
    : null;
const enrowFinds = (email: string | null): Route => (call) => {
  if (call.url.endsWith("/email/find/single") && call.method === "POST") return { body: { id: "find_1" } };
  if (call.url.includes("/email/find/single?id=")) return { body: email ? { email, qualification: "valid" } : { qualification: "invalid" } };
  return null;
};
const icypeasFinds = (email: string | null): Route => (call) => {
  if (call.url.endsWith("/api/email-search")) return { body: { success: true, item: { _id: "icy_1", status: "NONE" } } };
  if (call.url.endsWith("/api/bulk-single-searchs/read")) {
    return {
      body: {
        success: true,
        items: [
          email
            ? { _id: "icy_1", status: "DEBITED", results: { emails: [{ email, certainty: "very_sure" }] } }
            : { _id: "icy_1", status: "NOT_FOUND", results: { emails: [] } },
        ],
      },
    };
  }
  return null;
};

before(async () => {
  await resetDatabase();
});

after(async () => {
  await getPool().end();
});

describe("company enrichment", () => {
  let owner: UserActor;

  before(async () => {
    owner = await createUser("enrich-company@orbit.test", "Mark Ridgeon");
  });

  it("maps context.dev brand data onto Orbit's company fields", () => {
    assert.equal(sizeFromEmployees({ range: "11 to 50", exact: null }), "11-50");
    assert.equal(sizeFromEmployees({ exact: 4200 }), "1000+");
    assert.equal(sizeFromEmployees({ range: "1,001-5,000" }), "1000+");
    assert.equal(sizeFromEmployees({}), null);
    const mapped = brandToCompany(
      {
        description: "Payments infrastructure.",
        industries: { eic: [{ industry: "Financial Services", subindustry: "Payments" }] },
        employees: { range: "51 to 200" },
        socials: [{ type: "x", url: "https://x.com/acme" }, { type: "linkedin", url: "https://www.linkedin.com/company/acme-pay/" }],
        address: { street: "1 King St", city: "London", postal_code: "EC2V 8AU", country: "United Kingdom" },
        phone: "+44 20 7946 0000",
        logos: [{ type: "logo", url: "https://media.brand.dev/acme-logo.png" }, { type: "icon", url: "https://media.brand.dev/acme-icon.png" }],
      },
      "acme-pay.test",
    );
    assert.deepEqual(mapped, {
      website: "https://acme-pay.test",
      description: "Payments infrastructure.",
      industry: "Financial Services",
      sizeCategory: "51-200",
      linkedinUrl: "https://www.linkedin.com/company/acme-pay",
      phone: "+44 20 7946 0000",
      address: "1 King St, London, EC2V 8AU, United Kingdom",
      logoUrl: "https://media.brand.dev/acme-icon.png",
    });
    assert.equal(brandToCompany({ logos: [{ type: "icon", url: "https://evil.example/logo.png" }] }, "x.test").logoUrl, null);
  });

  it("fills only empty fields, records the lookup and never overwrites your edits", async () => {
    const company = (await createCompany(owner, { name: "Acme Pay", domain: "acme-pay.test", industry: "Fintech" })).body.company;
    const context = fake([
      (call) =>
        call.url.endsWith("/v1/brand/retrieve")
          ? {
              body: {
                status: "ok",
                brand: {
                  description: "Payments infrastructure.",
                  industries: { eic: [{ industry: "Financial Services" }] },
                  employees: { range: "51 to 200" },
                  socials: [{ type: "linkedin", url: "https://linkedin.com/company/acme-pay" }],
                  logos: [{ type: "icon", url: "https://media.context.dev/acme.png" }],
                },
              },
            }
          : null,
    ]);
    const result = await enrichCompany(owner, company.id, { env: ENV, fetchImpl: context.fetchImpl });
    assert.equal(result.status, "updated");
    assert.equal(context.calls[0].headers.get("authorization"), "Bearer ctx");
    assert.deepEqual(context.calls[0].body, { type: "by_domain", domain: "acme-pay.test", tags: ["orbit"] });
    const saved = await getCompany(owner, company.id);
    assert.equal(saved.industry, "Fintech");
    assert.equal(saved.description, "Payments infrastructure.");
    assert.equal(saved.sizeCategory, "51-200");
    assert.equal(saved.linkedinUrl, "https://www.linkedin.com/company/acme-pay");
    assert.equal(saved.logoUrl, "https://media.context.dev/acme.png");
    assert.equal(saved.website, "https://acme-pay.test/");
    assert.ok(saved.enrichedAt);

    const again = await enrichCompany(owner, company.id, { env: ENV, fetchImpl: context.fetchImpl });
    assert.equal(again.status, "unchanged");
  });

  it("explains when it can't look a company up", async () => {
    const bare = (await createCompany(owner, { name: "No Site Ltd" })).body.company;
    assert.equal((await enrichCompany(owner, bare.id, { env: ENV })).status, "skipped");
    assert.equal((await enrichCompany(owner, bare.id, { env: {} })).message, "Add CONTEXT_DEV_API_KEY to enrich companies.");
    await updateCompany(owner, bare.id, { domain: "nosite.test" });
    const missing = fake([(call) => (call.url.endsWith("/v1/brand/retrieve") ? { status: 400, body: { code: "NOT_FOUND", message: "Brand not found" } } : null)]);
    assert.equal((await enrichCompany(owner, bare.id, { env: ENV, fetchImpl: missing.fetchImpl })).status, "not_found");
    const broke = fake([(call) => (call.url.endsWith("/v1/brand/retrieve") ? { status: 401, body: { code: "USAGE_EXCEEDED" } } : null)]);
    const failed = await enrichCompany(owner, bare.id, { env: ENV, fetchImpl: broke.fetchImpl });
    assert.equal(failed.status, "failed");
    assert.match(failed.message, /out of credits/);
  });
});

describe("contact email and LinkedIn waterfall", () => {
  let owner: UserActor;
  let companyId: string;

  before(async () => {
    owner = await createUser("enrich-contacts@orbit.test", "Mark Ridgeon");
    companyId = (await createCompany(owner, { name: "Globex", domain: "globex.test" })).body.company.id;
  });

  async function person(first: string, last: string, extra: Record<string, unknown> = {}) {
    return (await createContact(owner, { firstName: first, lastName: last, companyId, ...extra })).body.contact;
  }

  it("uses context.dev first, checks its email, and fills LinkedIn from the same match", async () => {
    const contact = await person("Hank", "Scorpio");
    const net = fake([
      contextPerson({
        email: "hank@globex.test",
        social_urls: ["https://twitter.com/hank", "https://www.linkedin.com/in/hank-scorpio"],
        current_role: { title: "CEO", organization: { name: "Globex", domain: "globex.test" } },
      }),
      enrowVerify("valid"),
    ]);
    const result = await enrichContact(owner, contact.id, "email", { env: ENV, fetchImpl: net.fetchImpl, ...FAST });
    assert.equal(result.status, "found");
    assert.equal(result.provider, "context");
    assert.equal(result.email, "hank@globex.test");
    assert.equal(result.linkedinUrl, "https://www.linkedin.com/in/hank-scorpio");
    assert.deepEqual(result.attempts, [{ provider: "context", outcome: "found" }]);
    assert.equal(net.hits("api.hunter.io"), 0);
    const contextCall = net.calls.find((call) => call.url.endsWith("/v1/people/enrich"))!;
    assert.deepEqual(contextCall.body?.name, { first: "Hank", last: "Scorpio" });
    assert.deepEqual(contextCall.body?.company, { domain: "globex.test" });

    const saved = await getContact(owner, contact.id);
    assert.equal(saved.email, "hank@globex.test");
    assert.equal(saved.linkedinUrl, "https://www.linkedin.com/in/hank-scorpio");
    const states = await contactLookups(owner, [contact.id]);
    assert.equal(states[contact.id].email?.status, "found");
    assert.equal(states[contact.id].linkedin?.status, "found");
    assert.equal((await enrichContact(owner, contact.id, "email", { env: ENV })).status, "skipped");
  });

  it("rejects a context.dev email that's off-domain or unconfirmed and moves down the list", async () => {
    const offDomain = await person("Frank", "Grimes");
    const net = fake([
      contextPerson({ email: "frank@gmail.com" }),
      hunterFinds("frank.grimes@globex.test", { linkedin_url: "https://www.linkedin.com/in/frank-grimes" }),
    ]);
    const result = await enrichContact(owner, offDomain.id, "email", { env: ENV, fetchImpl: net.fetchImpl, ...FAST });
    assert.equal(result.provider, "hunter");
    assert.equal(result.email, "frank.grimes@globex.test");
    assert.equal(result.linkedinUrl, "https://www.linkedin.com/in/frank-grimes");
    assert.deepEqual(result.attempts.map((attempt) => attempt.outcome), ["not_found", "found"]);

    const unconfirmed = await person("Lionel", "Hutz");
    const second = fake([
      contextPerson({ email: "lionel@globex.test" }),
      enrowVerify("invalid"),
      hunterFinds(null),
      enrowFinds("l.hutz@globex.test"),
    ]);
    const next = await enrichContact(owner, unconfirmed.id, "email", { env: ENV, fetchImpl: second.fetchImpl, ...FAST });
    assert.equal(next.provider, "enrow");
    assert.equal(next.email, "l.hutz@globex.test");
    assert.deepEqual(next.attempts, [
      { provider: "context", outcome: "rejected", detail: "Enrow couldn't confirm the email." },
      { provider: "hunter", outcome: "not_found" },
      { provider: "enrow", outcome: "found" },
    ]);
  });

  it("keeps going when a provider is out of credits, polls Icypeas, and remembers what wasn't found", async () => {
    const contact = await person("Troy", "McClure");
    const net = fake([
      contextNone,
      (call) => (call.url.includes("api.hunter.io") ? { status: 429, body: { errors: [{ details: "usage limit" }] } } : null),
      (call) => (call.url.includes("api.enrow.io") ? { status: 402, body: { reason: "Insufficient credits", success: false } } : null),
      icypeasFinds("troy@globex.test"),
    ]);
    const result = await enrichContact(owner, contact.id, "email", { env: ENV, fetchImpl: net.fetchImpl, ...FAST });
    assert.equal(result.provider, "icypeas");
    assert.deepEqual(
      result.attempts.map((attempt) => [attempt.provider, attempt.outcome]),
      [
        ["context", "not_found"],
        ["hunter", "failed"],
        ["enrow", "failed"],
        ["icypeas", "found"],
      ],
    );
    assert.equal(net.calls.find((call) => call.url.endsWith("/api/email-search"))!.headers.get("authorization"), "icy");

    const nobody = await person("Gil", "Gunderson");
    const empty = fake([contextNone, hunterFinds(null), enrowFinds(null), icypeasFinds(null)]);
    const none = await enrichContact(owner, nobody.id, "email", { env: ENV, fetchImpl: empty.fetchImpl, ...FAST });
    assert.equal(none.status, "not_found");
    assert.equal(none.message, "No email found for Gil Gunderson.");
    assert.equal((await contactLookups(owner, [nobody.id]))[nobody.id].email?.status, "not_found");

    const down = await person("Disco", "Stu");
    const broke = fake([(call) => ({ status: 402, body: { reason: "Insufficient credits" }, url: call.url })]);
    const failed = await enrichContact(owner, down.id, "email", { env: { ENROW_API_KEY: "enr" }, fetchImpl: broke.fetchImpl, ...FAST });
    assert.equal(failed.status, "failed");
    assert.match(failed.message, /Enrow is out of credits/);
  });

  it("finds LinkedIn profiles with Icypeas and follows your provider order", async () => {
    const contact = await person("Moe", "Szyslak");
    await saveEnrichmentSettings(owner, { linkedinOrder: ["icypeas", "context", "hunter"] });
    const net = fake([
      (call) =>
        call.url.endsWith("/api/url-search/profile")
          ? { body: { success: true, item: { status: "FOUND", result: { profiles: [{ url: "https://linkedin.com/in/moe-szyslak/" }] } } } }
          : null,
    ]);
    const result = await enrichContact(owner, contact.id, "linkedin", { env: ENV, fetchImpl: net.fetchImpl, ...FAST });
    assert.equal(result.provider, "icypeas");
    assert.equal(result.linkedinUrl, "https://www.linkedin.com/in/moe-szyslak");
    assert.equal(net.hits("/v1/people/enrich"), 0);
    assert.deepEqual(net.calls[0].body, { firstname: "Moe", lastname: "Szyslak", companyOrDomain: "globex.test" });
    const settings = await getEnrichmentSettings(owner);
    assert.deepEqual(settings.linkedinOrder, ["icypeas", "context", "hunter"]);
    assert.deepEqual(settings.emailOrder, ["context", "hunter", "enrow", "icypeas"]);
  });

  it("skips people it can't search for and handles a batch", async () => {
    const loose = (await createContact(owner, { firstName: "Cher", email: "cher@globex.test" })).body.contact;
    const noCompany = (await createContact(owner, { firstName: "Otto", lastName: "Mann" })).body.contact;
    const ready = await person("Kent", "Brockman");
    const net = fake([contextNone, hunterFinds("kent@globex.test")]);
    const results = await enrichContacts(owner, [loose.id, noCompany.id, ready.id], "email", { env: ENV, fetchImpl: net.fetchImpl, ...FAST });
    assert.deepEqual(
      results.map((result) => [result.status, result.message]),
      [
        ["skipped", "Cher already has an email."],
        ["skipped", "Link Otto Mann to a company with a website first."],
        ["found", "Found Kent Brockman's email with Hunter."],
      ],
    );
    await assert.rejects(enrichContacts(owner, Array.from({ length: 7 }, () => crypto.randomUUID()), "email"), /up to 6 people/);
    assert.deepEqual(enrichmentAvailability(ENV), { email: true, linkedin: true, company: true });
    assert.deepEqual(enrichmentAvailability({ ENROW_API_KEY: "x" }), { email: true, linkedin: false, company: false });
  });

  it("spots LinkedIn profile URLs anywhere in a response", () => {
    assert.equal(linkedinProfileIn({ a: [{ b: "https://uk.linkedin.com/in/jane-doe" }] }), "https://uk.linkedin.com/in/jane-doe");
    assert.equal(linkedinProfileIn(["https://linkedin.com/company/acme"]), null);
  });
});
