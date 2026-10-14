import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, describe, it } from "node:test";
import { GET as listContactsRoute, POST as createContactRoute } from "@/app/api/v1/contacts/route";
import { PATCH as patchContactRoute } from "@/app/api/v1/contacts/[id]/route";
import { GET as listCompaniesRoute } from "@/app/api/v1/companies/route";
import { POST as upsertCompanyRoute } from "@/app/api/v1/companies/upsert/route";
import { POST as mcpRoute } from "@/app/api/mcp/route";
import { companiesCsvRows } from "@/lib/companies";
import { toCsv } from "@/lib/csv";
import { getAdminPool, getPool } from "@/lib/db/pool";
import {
  archiveCompany,
  createCompany,
  getCompany,
  listCompanies,
  updateCompany,
} from "@/lib/crm/companies";
import {
  createContact,
  getContact,
  listContacts,
  updateContact,
  upsertContact,
} from "@/lib/crm/contacts";
import { CrmError } from "@/lib/crm/errors";
import { normalizeTag, normalizeTags, sameTags } from "@/lib/crm/normalize";
import {
  contactsCsvRows,
  importCompaniesCsv,
  importContactsCsv,
} from "@/lib/crm/spreadsheet";
import { addTags, deleteTag, listTags, removeTags, renameTag } from "@/lib/crm/tags";
import { companyQueryFromSearchParams, contactQueryFromSearchParams } from "@/lib/crm/validation";
import { createAgent, createUser, resetDatabase } from "./helpers";

before(async () => {
  await resetDatabase();
});

after(async () => {
  await getPool().end();
});

async function auditCount(entityId: string) {
  const result = await getAdminPool().query<{ total: number }>(
    "select count(*)::int as total from crm.audit_events where entity_id = $1",
    [entityId],
  );
  return result.rows[0].total;
}

describe("tag normalisation", () => {
  it("trims, collapses whitespace, lowercases, and drops duplicates and blanks", () => {
    assert.equal(normalizeTag("  Recruit   Lead \t"), "recruit lead");
    assert.deepEqual(normalizeTags(["Recruit", "recruit ", " RECRUIT", "", "  ", "London"]), [
      "recruit",
      "london",
    ]);
    assert.deepEqual(normalizeTags(null), []);
  });

  it("enforces the length, count, and separator limits", () => {
    assert.deepEqual(normalizeTags(["x".repeat(40)]), ["x".repeat(40)]);
    assert.throws(() => normalizeTags(["x".repeat(41)]), /40 characters/);
    const twenty = Array.from({ length: 20 }, (_, index) => `tag ${index}`);
    assert.equal(normalizeTags([...twenty, "TAG 0"]).length, 20);
    assert.throws(() => normalizeTags([...twenty, "one more"]), /at most 20 tags/);
    assert.throws(() => normalizeTags(["a;b"]), /semicolon/);
  });

  it("compares tag lists without regard to order", () => {
    assert.equal(sameTags(["a", "b"], ["b", "a"]), true);
    assert.equal(sameTags(["a", "b"], ["a"]), false);
    assert.equal(sameTags(["a", "a"], ["a", "b"]), false);
    assert.equal(sameTags([], []), true);
  });

  it("reads the tag filter from the query string", () => {
    assert.equal(contactQueryFromSearchParams(new URLSearchParams("tag=%20Recruit%20")).tag, "recruit");
    assert.equal(companyQueryFromSearchParams(new URLSearchParams("tag=")).tag, undefined);
  });
});

describe("tags on records", () => {
  it("stores normalised tags and treats a reorder as no change", async () => {
    const owner = await createUser("tags-records@example.com");
    const created = await createContact(owner, {
      firstName: "Isabelle",
      email: "isabelle@tags.example",
      tags: ["Recruit", " London ", "recruit"],
    });
    const contact = created.body.contact;
    assert.deepEqual(contact.tags, ["recruit", "london"]);
    assert.equal(await auditCount(contact.id), 1);

    const reordered = await updateContact(owner, contact.id, { tags: ["LONDON", "recruit"] });
    assert.deepEqual(reordered.body.contact.tags, ["recruit", "london"]);
    assert.equal(reordered.body.contact.updatedAt, contact.updatedAt);
    assert.equal(await auditCount(contact.id), 1);

    const untouched = await updateContact(owner, contact.id, { jobTitle: "Engineer" });
    assert.deepEqual(untouched.body.contact.tags, ["recruit", "london"]);

    const changed = await updateContact(owner, contact.id, { tags: ["recruit"] });
    assert.deepEqual(changed.body.contact.tags, ["recruit"]);
    const audit = await getAdminPool().query<{ changes: { fields: string[]; after: { tags: string[] } } }>(
      `select changes from crm.audit_events
       where entity_id = $1 and event_type = 'contact.updated'
       order by created_at desc, id desc limit 1`,
      [contact.id],
    );
    assert.deepEqual(audit.rows[0].changes.fields, ["tags"]);
    assert.deepEqual(audit.rows[0].changes.after.tags, ["recruit"]);

    const cleared = await updateContact(owner, contact.id, { tags: null });
    assert.deepEqual(cleared.body.contact.tags, []);

    const company = await createCompany(owner, { name: "Tagged Co", tags: ["Customer", "UK"] });
    assert.deepEqual(company.body.company.tags, ["customer", "uk"]);
    const sameCompany = await updateCompany(owner, company.body.company.id, { tags: ["uk", "customer"] });
    assert.equal(sameCompany.body.company.updatedAt, company.body.company.updatedAt);
    await assert.rejects(
      () => updateCompany(owner, company.body.company.id, { tags: ["x".repeat(41)] }),
      (error) => error instanceof CrmError && error.code === "invalid_input",
    );

    const upserted = await upsertContact(owner, {
      email: "isabelle@tags.example",
      tags: ["candidate"],
    });
    assert.equal(upserted.body.created, false);
    assert.deepEqual(upserted.body.contact.tags, ["candidate"]);
  });

  it("adds and removes tags in bulk with per-record results", async () => {
    const owner = await createUser("tags-bulk@example.com");
    const ada = (await createContact(owner, { firstName: "Ada", tags: ["existing"] })).body.contact;
    const full = (
      await createContact(owner, {
        firstName: "Full",
        tags: Array.from({ length: 20 }, (_, index) => `t${index}`),
      })
    ).body.contact;
    const company = (await createCompany(owner, { name: "Bulk Tags Ltd" })).body.company;

    const added = await addTags(owner, "contact", [ada.id, full.id], [" Recruit "]);
    assert.deepEqual(
      added.map((item) => item.ok),
      [true, false],
    );
    assert.match(added[1].ok ? "" : added[1].error, /at most 20 tags/);
    assert.deepEqual((await getContact(owner, ada.id)).tags, ["existing", "recruit"]);

    const again = await addTags(owner, "contact", [ada.id], ["recruit"]);
    assert.equal(again[0].ok, true);
    assert.deepEqual((await getContact(owner, ada.id)).tags, ["existing", "recruit"]);

    const companyAdded = await addTags(owner, "company", [company.id], ["recruit"]);
    assert.equal(companyAdded[0].ok, true);
    assert.deepEqual((await getCompany(owner, company.id)).tags, ["recruit"]);

    const removed = await removeTags(owner, "contact", [ada.id], ["RECRUIT"]);
    assert.equal(removed[0].ok, true);
    assert.deepEqual((await getContact(owner, ada.id)).tags, ["existing"]);

    await assert.rejects(() => addTags(owner, "contact", [ada.id], ["  "]), /Enter a tag/);
    await assert.rejects(
      () => addTags(owner, "contact", Array.from({ length: 101 }, (_, index) => `id-${index}`), ["x"]),
      /100 or fewer/,
    );
    const missing = await addTags(owner, "contact", ["not-a-uuid"], ["x"]);
    assert.equal(missing[0].ok, false);
  });

  it("lists tags with counts, renames with merge, and deletes across both tables", async () => {
    const owner = await createUser("tags-manage@example.com");
    const both = (
      await createContact(owner, { firstName: "Both", tags: ["recruit", "candidate", "london"] })
    ).body.contact;
    const one = (await createContact(owner, { firstName: "One", tags: ["recruit"] })).body.contact;
    const company = (
      await createCompany(owner, { name: "Rename Co", tags: ["recruit", "client"] })
    ).body.company;
    const archived = (
      await createCompany(owner, { name: "Old Co", tags: ["recruit"] })
    ).body.company;
    await archiveCompany(owner, archived.id);

    assert.deepEqual(await listTags(owner), [
      { name: "candidate", contacts: 1, companies: 0 },
      { name: "client", contacts: 0, companies: 1 },
      { name: "london", contacts: 1, companies: 0 },
      { name: "recruit", contacts: 2, companies: 1 },
    ]);

    const renamed = await renameTag(owner, "Recruit", " Candidate ");
    assert.deepEqual(renamed, { contacts: 2, companies: 2 });
    assert.deepEqual((await getContact(owner, both.id)).tags, ["candidate", "london"]);
    assert.deepEqual((await getContact(owner, one.id)).tags, ["candidate"]);
    assert.deepEqual((await getCompany(owner, company.id)).tags, ["candidate", "client"]);
    assert.deepEqual((await getCompany(owner, archived.id)).tags, ["candidate"]);
    const audits = await getAdminPool().query<{ operation: string; source: string }>(
      `select operation, source from crm.audit_events
       where entity_id = $1 and event_type = 'contact.updated'`,
      [one.id],
    );
    assert.deepEqual(audits.rows, [{ operation: "rename_tag", source: "web" }]);

    assert.deepEqual(await renameTag(owner, "candidate", "CANDIDATE"), { contacts: 0, companies: 0 });
    await assert.rejects(() => renameTag(owner, "candidate", "  "), /Enter a new name/);
    await assert.rejects(() => renameTag(owner, "candidate", "x".repeat(41)), /40 characters/);

    const deleted = await deleteTag(owner, "candidate");
    assert.deepEqual(deleted, { contacts: 2, companies: 2 });
    assert.deepEqual((await getContact(owner, both.id)).tags, ["london"]);
    assert.deepEqual(
      (await listTags(owner)).map((tag) => tag.name),
      ["client", "london"],
    );
  });

  it("filters lists by tag together with search and paging", async () => {
    const owner = await createUser("tags-filter@example.com");
    for (let index = 0; index < 5; index += 1) {
      await createContact(owner, {
        firstName: `Person${index}`,
        lastName: index % 2 === 0 ? "Smith" : "Jones",
        tags: index < 4 ? ["recruit"] : ["other"],
      });
    }
    const tagged = await listContacts(owner, { tag: "Recruit" });
    assert.equal(tagged.total, 4);
    assert.ok(tagged.data.every((contact) => contact.tags.includes("recruit")));
    const searched = await listContacts(owner, { tag: "recruit", query: "smith" });
    assert.equal(searched.total, 2);
    const paged = await listContacts(owner, { tag: "recruit", limit: 3, offset: 3 });
    assert.equal(paged.total, 4);
    assert.equal(paged.data.length, 1);
    assert.equal((await listContacts(owner, { tag: "nobody" })).total, 0);

    await createCompany(owner, { name: "Alpha Tag", tags: ["client"] });
    await createCompany(owner, { name: "Beta Tag", tags: ["client", "uk"] });
    await createCompany(owner, { name: "Gamma", tags: ["uk"] });
    const companies = await listCompanies(owner, { tag: "client", sort: "name", order: "asc" });
    assert.deepEqual(
      companies.data.map((company) => company.name),
      ["Alpha Tag", "Beta Tag"],
    );
    const narrowed = await listCompanies(owner, { tag: "uk", query: "beta" });
    assert.deepEqual(
      narrowed.data.map((company) => company.name),
      ["Beta Tag"],
    );
  });

  it("round-trips tags through CSV and leaves them alone for a blank cell", async () => {
    const owner = await createUser("tags-csv@example.com");
    const contact = (
      await createContact(owner, {
        firstName: "Csv",
        email: "csv@tags.example",
        tags: ["recruit", "london"],
      })
    ).body.contact;
    const exported = contactsCsvRows([contact]);
    const tagsAt = exported[0].indexOf("Tags");
    assert.equal(exported[1][tagsAt], "recruit; london");

    await updateContact(owner, contact.id, { tags: [] });
    const reimported = await importContactsCsv(owner, toCsv(exported));
    assert.deepEqual(reimported.errors, []);
    assert.equal(reimported.updated, 1);
    assert.deepEqual((await getContact(owner, contact.id)).tags, ["recruit", "london"]);

    const blank = await importContactsCsv(owner, "Email,Tags\ncsv@tags.example,\n");
    assert.equal(blank.matched, 1);
    assert.deepEqual((await getContact(owner, contact.id)).tags, ["recruit", "london"]);

    const replaced = await importContactsCsv(owner, "Email,Tags\ncsv@tags.example,Candidate ; UK\n");
    assert.equal(replaced.updated, 1);
    assert.deepEqual((await getContact(owner, contact.id)).tags, ["candidate", "uk"]);

    const company = (
      await createCompany(owner, { name: "Csv Co", domain: "csv-tags.example", tags: ["client"] })
    ).body.company;
    const companyRows = companiesCsvRows([company]);
    assert.equal(companyRows[1][companyRows[0].indexOf("Tags")], "client");
    await updateCompany(owner, company.id, { tags: ["old"] });
    const companyImport = await importCompaniesCsv(owner, toCsv(companyRows));
    assert.deepEqual(companyImport.errors, []);
    assert.deepEqual((await getCompany(owner, company.id)).tags, ["client"]);
    await importCompaniesCsv(owner, "Domain,Tags\ncsv-tags.example,\n");
    assert.deepEqual((await getCompany(owner, company.id)).tags, ["client"]);
  });

  it("keeps tags inside their workspace", async () => {
    const mine = await createUser("tags-mine@example.com");
    const theirs = await createUser("tags-theirs@example.com");
    const contact = (await createContact(mine, { firstName: "Mine", tags: ["secret"] })).body.contact;
    const company = (await createCompany(mine, { name: "Mine Co", tags: ["secret"] })).body.company;
    await createContact(theirs, { firstName: "Theirs", tags: ["shared"] });

    assert.deepEqual(
      (await listTags(theirs)).map((tag) => tag.name),
      ["shared"],
    );
    assert.equal((await listContacts(theirs, { tag: "secret" })).total, 0);
    const blocked = await addTags(theirs, "contact", [contact.id], ["hijack"]);
    assert.equal(blocked[0].ok, false);
    const blockedCompany = await removeTags(theirs, "company", [company.id], ["secret"]);
    assert.equal(blockedCompany[0].ok, false);
    assert.deepEqual(await renameTag(theirs, "secret", "gone"), { contacts: 0, companies: 0 });
    assert.deepEqual(await deleteTag(theirs, "secret"), { contacts: 0, companies: 0 });
    assert.deepEqual((await getContact(mine, contact.id)).tags, ["secret"]);
    assert.deepEqual((await getCompany(mine, company.id)).tags, ["secret"]);

    const { actor: reader } = await createAgent(mine.workspaceId, ["crm:read"]);
    await assert.rejects(() => addTags(reader, "contact", [contact.id], ["x"]), /contacts:write/);
    await assert.rejects(() => renameTag(reader, "secret", "x"), /contacts:write/);
  });

  it("re-applies the migration without changing data", async () => {
    const owner = await createUser("tags-migration@example.com");
    const contact = (await createContact(owner, { firstName: "Again", tags: ["kept"] })).body.contact;
    await getAdminPool().query(readFileSync("supabase/migrations/20261021100000_tags.sql", "utf8"));
    assert.deepEqual((await getContact(owner, contact.id)).tags, ["kept"]);
    await assert.rejects(
      () =>
        getAdminPool().query("update crm.contacts set tags = $1 where id = $2", [
          Array.from({ length: 21 }, (_, index) => `t${index}`),
          contact.id,
        ]),
      /contacts_tags_count/,
    );
  });
});

describe("tags over the API and MCP", () => {
  it("accepts and returns tags and filters by tag", async () => {
    const owner = await createUser("tags-api@example.com");
    const { token } = await createAgent(owner.workspaceId, [
      "crm:read",
      "contacts:write",
      "companies:write",
    ]);
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };

    const created = await createContactRoute(
      new Request("http://crm.test/api/v1/contacts", {
        method: "POST",
        headers,
        body: JSON.stringify({ firstName: "Api", email: "api@tags.example", tags: ["Recruit", "recruit"] }),
      }),
    );
    assert.equal(created.status, 201);
    const body = (await created.json()) as { contact: { id: string; tags: string[] } };
    assert.deepEqual(body.contact.tags, ["recruit"]);

    const patched = await patchContactRoute(
      new Request(`http://crm.test/api/v1/contacts/${body.contact.id}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ tags: ["recruit", "Senior"] }),
      }),
      { params: Promise.resolve({ id: body.contact.id }) },
    );
    assert.equal(patched.status, 200);
    assert.deepEqual(((await patched.json()) as { contact: { tags: string[] } }).contact.tags, [
      "recruit",
      "senior",
    ]);

    const invalid = await patchContactRoute(
      new Request(`http://crm.test/api/v1/contacts/${body.contact.id}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ tags: "recruit" }),
      }),
      { params: Promise.resolve({ id: body.contact.id }) },
    );
    assert.equal(invalid.status, 400);

    const listed = await listContactsRoute(
      new Request("http://crm.test/api/v1/contacts?tag=Senior", { headers }),
    );
    const listedBody = (await listed.json()) as { total: number; data: { tags: string[] }[] };
    assert.equal(listedBody.total, 1);

    const upserted = await upsertCompanyRoute(
      new Request("http://crm.test/api/v1/companies/upsert", {
        method: "POST",
        headers,
        body: JSON.stringify({ name: "Api Tags", domain: "api-tags.example", tags: ["Client"] }),
      }),
    );
    assert.equal(upserted.status, 200);
    assert.deepEqual(((await upserted.json()) as { company: { tags: string[] } }).company.tags, [
      "client",
    ]);
    const companies = await listCompaniesRoute(
      new Request("http://crm.test/api/v1/companies?tag=client", { headers }),
    );
    assert.equal(((await companies.json()) as { total: number }).total, 1);

    const response = await mcpRoute(
      new Request("http://crm.test/api/mcp", {
        method: "POST",
        headers: { ...headers, accept: "application/json, text/event-stream" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "upsert_contact",
            arguments: { email: "api@tags.example", tags: ["Recruit", "MCP"] },
          },
        }),
      }),
    );
    const payload = (await response.json()) as {
      result?: { content?: { text: string }[]; isError?: boolean };
    };
    assert.equal(payload.result?.isError, undefined);
    const mcpBody = JSON.parse(payload.result?.content?.[0]?.text ?? "{}") as {
      contact: { tags: string[] };
    };
    assert.deepEqual(mcpBody.contact.tags, ["recruit", "mcp"]);
  });
});
