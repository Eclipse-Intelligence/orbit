import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createCompany, getCompany } from "@/lib/crm/companies";
import { createContact, getContact } from "@/lib/crm/contacts";
import type { UserActor } from "@/lib/crm/types";
import { getPool } from "@/lib/db/pool";
import {
  backfillCompanies,
  brandProfile,
  createSuggestedCompany,
  enrichCompanies,
  enrichCompany,
  suggestCompanyForEmail,
  unenrichedCompanyCount,
} from "@/lib/enrichment/companies";
import { enrichContact } from "@/lib/enrichment/contacts";
import { saveEnrichmentSettings } from "@/lib/enrichment/settings";
import { createUser, resetDatabase } from "./helpers";

type Call = { url: string; method: string; body: Record<string, unknown> | null };

function fake(handler: (call: Call) => { status?: number; body: unknown }) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const call = { url, method: init.method ?? "GET", body: typeof init.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null };
    calls.push(call);
    const reply = handler(call);
    return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const ENV = { CONTEXT_DEV_API_KEY: "ctx", ENROW_API_KEY: "enr" };

const BRAND = {
  domain: "orbitbrand.test",
  title: "Orbit Brand",
  slogan: "Payments for everyone",
  description: "Payments infrastructure.",
  email: "hello@orbitbrand.test",
  phone: "+44 20 7946 0000",
  socials: [
    { type: "linkedin", url: "https://www.linkedin.com/company/orbit-brand" },
    { type: "x", url: "https://x.com/orbitbrand" },
    { type: "x", url: "https://x.com/duplicate" },
    { type: "instagram", url: "http://instagram.com/insecure" },
    { type: "crunchbase", url: "https://www.crunchbase.com/organization/orbit-brand" },
  ],
  links: { careers: "https://orbitbrand.test/careers", pricing: "https://orbitbrand.test/pricing", blog: "javascript:alert(1)" },
  industries: { eic: [{ industry: "Finance", subindustry: "Payments & Money Movement" }, { industry: "Technology", subindustry: null }] },
  employees: { range: "51 to 200", exact: 140 },
  stock: { ticker: "ORBT", exchange: "LSE" },
  colors: [{ hex: "#4124FB" }, { hex: "not-a-colour" }, { hex: "#111111" }],
  backdrops: [{ url: "https://evil.example/banner.png" }, { url: "https://media.context.dev/banner.png" }],
  logos: [{ type: "icon", url: "https://media.context.dev/icon.png" }],
};

let owner: UserActor;

before(async () => {
  await resetDatabase();
  owner = await createUser("brand@orbit.test", "Mark Ridgeon");
});

after(async () => {
  await getPool().end();
});

describe("context.dev brand profile", () => {
  it("keeps clean socials, links, sectors, employees, stock, colours and a trusted banner", () => {
    const profile = brandProfile(BRAND, new Date("2026-10-17T12:00:00Z"));
    assert.deepEqual(profile, {
      slogan: "Payments for everyone",
      socials: [
        { type: "linkedin", url: "https://www.linkedin.com/company/orbit-brand" },
        { type: "x", url: "https://x.com/orbitbrand" },
        { type: "crunchbase", url: "https://www.crunchbase.com/organization/orbit-brand" },
      ],
      links: { careers: "https://orbitbrand.test/careers", pricing: "https://orbitbrand.test/pricing" },
      industries: [
        { industry: "Finance", subindustry: "Payments & Money Movement" },
        { industry: "Technology", subindustry: null },
      ],
      employees: { range: "51 to 200", exact: 140 },
      email: "hello@orbitbrand.test",
      stock: { ticker: "ORBT", exchange: "LSE" },
      colors: ["#4124fb", "#111111"],
      backdropUrl: "https://media.context.dev/banner.png",
      checkedAt: "2026-10-17T12:00:00.000Z",
    });
  });

  it("saves the profile on the company and reports an unchanged refresh", async () => {
    const company = (await createCompany(owner, { name: "Orbit Brand", domain: "orbitbrand.test" })).body.company;
    const net = fake(() => ({ body: { status: "ok", brand: BRAND } }));
    const first = await enrichCompany(owner, company.id, { env: ENV, fetchImpl: net.fetchImpl });
    assert.equal(first.status, "updated");
    assert.match(first.message, /3 social profiles/);
    const saved = await getCompany(owner, company.id);
    assert.equal(saved.brand?.socials.length, 3);
    assert.equal(saved.brand?.slogan, "Payments for everyone");
    assert.equal(saved.industry, "Payments & Money Movement");
    assert.equal(saved.logoUrl, "https://media.context.dev/icon.png");
    const again = await enrichCompany(owner, company.id, { env: ENV, fetchImpl: net.fetchImpl });
    assert.equal(again.status, "unchanged");
  });
});

describe("filling in many companies", () => {
  it("enriches a selection and backfills everything with a website once", async () => {
    const a = (await createCompany(owner, { name: "Fill A", domain: "fill-a.test" })).body.company.id;
    const b = (await createCompany(owner, { name: "Fill B", domain: "fill-b.test" })).body.company.id;
    await createCompany(owner, { name: "No Site" });
    const net = fake((call) =>
      call.body?.domain === "fill-b.test" ? { status: 400, body: { code: "NOT_FOUND" } } : { body: { brand: { ...BRAND, domain: call.body?.domain } } },
    );
    const before = await unenrichedCompanyCount(owner);
    assert.equal(before, 2);
    const picked = await enrichCompanies(owner, [a], { env: ENV, fetchImpl: net.fetchImpl });
    assert.deepEqual(picked.map((result) => result.status), ["updated"]);
    const filled = await backfillCompanies(owner, { env: ENV, fetchImpl: net.fetchImpl });
    assert.deepEqual(filled.results.map((result) => [result.companyId, result.status]), [[b, "not_found"]]);
    assert.equal(filled.remaining, 0);
    assert.deepEqual((await backfillCompanies(owner, { env: ENV, fetchImpl: net.fetchImpl })).results, []);
    await assert.rejects(enrichCompanies(owner, Array.from({ length: 6 }, () => crypto.randomUUID())), /up to 5 companies/);
  });
});

describe("company from a work email", () => {
  it("links an existing company, ignores personal email and suggests new ones from context.dev", async () => {
    const known = (await createCompany(owner, { name: "Known Ltd", domain: "known.test" })).body.company;
    assert.deepEqual(await suggestCompanyForEmail(owner, "sam@known.test", { env: ENV }), {
      kind: "existing",
      company: { id: known.id, name: "Known Ltd" },
    });
    assert.deepEqual(await suggestCompanyForEmail(owner, "sam@mail.known.test", { env: ENV }), {
      kind: "existing",
      company: { id: known.id, name: "Known Ltd" },
    });
    assert.deepEqual(await suggestCompanyForEmail(owner, "sam@gmail.com", { env: ENV }), { kind: "none" });
    const net = fake(() => ({ body: { brand: { ...BRAND, domain: "newco.test", title: "NewCo" } } }));
    const suggestion = await suggestCompanyForEmail(owner, "Ana@NewCo.test", { env: ENV, fetchImpl: net.fetchImpl });
    assert.deepEqual(net.calls[0].body, { type: "by_email", email: "ana@newco.test", tags: ["orbit"] });
    assert.deepEqual(suggestion, {
      kind: "new",
      name: "NewCo",
      domain: "newco.test",
      logoUrl: "https://media.context.dev/icon.png",
      description: "Payments infrastructure.",
    });
    await saveEnrichmentSettings(owner, { autoCompanies: false });
    const created = await createSuggestedCompany(owner, "NewCo", "newco.test", { env: ENV, fetchImpl: net.fetchImpl });
    const company = await getCompany(owner, created.id);
    assert.equal(company.domain, "newco.test");
    assert.equal(company.source, "context.dev");
    assert.equal(company.brand?.slogan, "Payments for everyone");
  });
});

describe("phone numbers", () => {
  it("finds a phone with Enrow from the LinkedIn profile and saves it in international format", async () => {
    const companyId = (await createCompany(owner, { name: "Phone Co", domain: "phoneco.test" })).body.company.id;
    const contact = (
      await createContact(owner, { firstName: "Pat", lastName: "Dial", companyId, linkedinUrl: "https://linkedin.com/in/pat-dial" })
    ).body.contact;
    const net = fake((call) => {
      if (call.url.endsWith("/phone/single") && call.method === "POST") return { status: 201, body: { id: "ph_1" } };
      if (call.url.includes("/phone/single?id=ph_1")) return { body: { number: "07700 900123", country: "GB", qualification: "found" } };
      return { status: 404, body: {} };
    });
    const result = await enrichContact(owner, contact.id, "phone", { env: ENV, fetchImpl: net.fetchImpl, pollMs: 5 });
    assert.equal(result.status, "found");
    assert.equal(result.provider, "enrow");
    assert.deepEqual(net.calls[0].body, { linkedin_url: "https://www.linkedin.com/in/pat-dial" });
    assert.equal((await getContact(owner, contact.id)).phone, "+447700900123");
    assert.equal((await enrichContact(owner, contact.id, "phone", { env: ENV })).status, "skipped");

    const nobody = (await createContact(owner, { firstName: "Quiet", lastName: "Person", companyId })).body.contact;
    const none = fake((call) =>
      call.method === "POST" ? { status: 201, body: { id: "ph_2" } } : { body: { qualification: "not_found" } },
    );
    const missing = await enrichContact(owner, nobody.id, "phone", { env: ENV, fetchImpl: none.fetchImpl, pollMs: 5 });
    assert.equal(missing.status, "not_found");
    assert.equal(missing.message, "No phone number found for Quiet Person.");
    assert.deepEqual(none.calls[0].body, { firstname: "Quiet", lastname: "Person", company_domain: "phoneco.test" });
  });
});
