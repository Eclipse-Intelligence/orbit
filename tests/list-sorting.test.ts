import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { logActivity } from "@/lib/crm/activities";
import { createCompany, listCompanies, updateCompany } from "@/lib/crm/companies";
import { createContact, listContacts, updateContact } from "@/lib/crm/contacts";
import type { UserActor } from "@/lib/crm/types";
import { companyQueryFromSearchParams, contactQueryFromSearchParams } from "@/lib/crm/validation";
import { getPool } from "@/lib/db/pool";
import { DEFAULT_CONTACT_SORT, defaultContactOrder, nextSort } from "@/lib/sorting";
import { createUser, resetDatabase } from "./helpers";

let owner: UserActor;
let ids: Record<string, string>;

before(async () => {
  await resetDatabase();
  owner = await createUser("sorting@orbit.test", "Mark Ridgeon");
  const zeta = (await createCompany(owner, { name: "Zeta Labs", domain: "zeta.test" })).body.company.id;
  const alpha = (await createCompany(owner, { name: "alpha works" })).body.company.id;
  const mid = (await createCompany(owner, { name: "Mid Co", domain: "mid.test", ownerId: owner.userId })).body.company.id;
  const carol = (await createContact(owner, { firstName: "Carol", lastName: "Baker", email: "carol@zeta.test", companyId: zeta })).body.contact.id;
  const adam = (await createContact(owner, { firstName: "adam", lastName: "Young", phone: "07700 900111", companyId: alpha })).body.contact.id;
  const bea = (await createContact(owner, { firstName: "Bea", lastName: "Stone", linkedinUrl: "https://linkedin.com/in/bea-stone" })).body.contact.id;
  await logActivity(owner, { companyId: mid, contactId: null }, "note", "Kick-off", "Met the team.");
  ids = { zeta, alpha, mid, carol, adam, bea };
});

after(async () => {
  await getPool().end();
});

const names = (rows: { name: string }[]) => rows.map((row) => row.name);

describe("contact list sorting and filters", () => {
  it("sorts by name by default so editing someone doesn't move them", async () => {
    assert.deepEqual(names((await listContacts(owner)).data), ["adam Young", "Bea Stone", "Carol Baker"]);
    await updateContact(owner, ids.carol, { jobTitle: "CTO" });
    assert.deepEqual(names((await listContacts(owner)).data), ["adam Young", "Bea Stone", "Carol Baker"]);
    assert.deepEqual(names((await listContacts(owner, { sort: "name", order: "desc" })).data), ["Carol Baker", "Bea Stone", "adam Young"]);
  });

  it("sorts by company with people without a company last", async () => {
    assert.deepEqual(names((await listContacts(owner, { sort: "company" })).data), ["adam Young", "Carol Baker", "Bea Stone"]);
    assert.deepEqual(names((await listContacts(owner, { sort: "company", order: "desc" })).data), ["Carol Baker", "adam Young", "Bea Stone"]);
  });

  it("filters people who have or are missing an email, phone, LinkedIn or company", async () => {
    assert.deepEqual(names((await listContacts(owner, { has: ["email"] })).data), ["Carol Baker"]);
    assert.deepEqual(names((await listContacts(owner, { missing: ["email"] })).data), ["adam Young", "Bea Stone"]);
    assert.deepEqual(names((await listContacts(owner, { has: ["phone"] })).data), ["adam Young"]);
    assert.deepEqual(names((await listContacts(owner, { has: ["linkedin"], missing: ["company"] })).data), ["Bea Stone"]);
    const counted = await listContacts(owner, { missing: ["email", "phone"] });
    assert.equal(counted.total, 1);
  });

  it("reads sorting and filters from the address bar", () => {
    const query = contactQueryFromSearchParams(new URLSearchParams("sort=company&order=desc&has=email,bogus&missing=phone,email"));
    assert.equal(query.sort, "company");
    assert.equal(query.order, "desc");
    assert.deepEqual(query.has, ["email"]);
    assert.deepEqual(query.missing, ["phone"]);
    assert.equal(contactQueryFromSearchParams(new URLSearchParams("sort=phone")).sort, undefined);
  });

  it("flips direction on a second click and drops defaults from the URL", () => {
    const defaults = { sort: DEFAULT_CONTACT_SORT, order: defaultContactOrder };
    assert.deepEqual(nextSort("name", { sort: "name", order: "asc" }, defaults), { sort: null, order: "desc" });
    assert.deepEqual(nextSort("name", { sort: "name", order: "desc" }, defaults), { sort: null, order: null });
    assert.deepEqual(nextSort("company", { sort: "name", order: "asc" }, defaults), { sort: "company", order: null });
    assert.deepEqual(nextSort("company", { sort: "company", order: "asc" }, defaults), { sort: "company", order: "desc" });
  });
});

describe("company list sorting and filters", () => {
  it("sorts by name by default, case-insensitively", async () => {
    assert.deepEqual(names((await listCompanies(owner)).data), ["alpha works", "Mid Co", "Zeta Labs"]);
    await updateCompany(owner, ids.zeta, { industry: "Software" });
    assert.deepEqual(names((await listCompanies(owner)).data), ["alpha works", "Mid Co", "Zeta Labs"]);
  });

  it("sorts by last interaction, strength, domain and owner", async () => {
    assert.equal((await listCompanies(owner, { sort: "interaction" })).data[0].name, "Mid Co");
    assert.equal((await listCompanies(owner, { sort: "strength" })).data[0].name, "Mid Co");
    assert.equal((await listCompanies(owner, { sort: "strength", order: "asc" })).data.at(-1)?.name, "Mid Co");
    assert.deepEqual(names((await listCompanies(owner, { sort: "domain" })).data), ["Mid Co", "Zeta Labs", "alpha works"]);
    assert.equal((await listCompanies(owner, { sort: "owner" })).data[0].name, "Mid Co");
  });

  it("filters by domain, people and interactions", async () => {
    assert.deepEqual(names((await listCompanies(owner, { missing: ["domain"] })).data), ["alpha works"]);
    assert.deepEqual(names((await listCompanies(owner, { has: ["contacts"] })).data), ["alpha works", "Zeta Labs"]);
    assert.deepEqual(names((await listCompanies(owner, { has: ["interactions"] })).data), ["Mid Co"]);
    assert.deepEqual(names((await listCompanies(owner, { missing: ["interactions", "contacts"] })).data), []);
    const query = companyQueryFromSearchParams(new URLSearchParams("sort=interaction&has=domain&missing=contacts"));
    assert.deepEqual([query.sort, query.has, query.missing], ["interaction", ["domain"], ["contacts"]]);
  });
});
