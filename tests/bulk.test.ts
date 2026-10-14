import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { getAdminPool, getPool } from "@/lib/db/pool";
import {
  archiveCompanies,
  archiveContacts,
  BULK_LIMIT,
  unarchiveCompanies,
  unarchiveContacts,
} from "@/lib/crm/bulk";
import {
  archiveCompany,
  createCompany,
  getCompaniesByIds,
  listCompanies,
  unarchiveCompany,
} from "@/lib/crm/companies";
import {
  archiveContact,
  createContact,
  getContactsByIds,
  listContacts,
  listContactsAtCompanies,
  unarchiveContact,
} from "@/lib/crm/contacts";
import {
  personalise,
  splitRecipients,
  stopsRun,
  unknownTokens,
  type Recipient,
} from "@/lib/crm/personalise";
import { sendPaced, type SendUpdate } from "@/lib/crm/send-queue";
import { contactsCsvRows } from "@/lib/crm/spreadsheet";
import { createAgent, createUser, resetDatabase } from "./helpers";

function recipient(overrides: Partial<Recipient> = {}): Recipient {
  return {
    id: "r1",
    firstName: "Ada",
    lastName: "Lovelace",
    name: "Ada Lovelace",
    email: "ada@example.com",
    company: "Analytical Engines",
    ...overrides,
  };
}

describe("personalise", () => {
  it("fills every token", () => {
    assert.equal(
      personalise("Hi {{first_name}} {{last_name}} ({{name}}) at {{company}}", recipient()),
      "Hi Ada Lovelace (Ada Lovelace) at Analytical Engines",
    );
    assert.equal(personalise("{{ first_name }}, {{FIRST_NAME}}", recipient()), "Ada, Ada");
  });

  it("falls back when the first name is empty", () => {
    assert.equal(
      personalise("Hi {{first_name}}", recipient({ firstName: null, lastName: "Lovelace" })),
      "Hi Lovelace",
    );
    assert.equal(
      personalise("Hi {{first_name}}", recipient({ firstName: "  ", lastName: null, name: "ada@example.com" })),
      "Hi there",
    );
    assert.equal(
      personalise("{{name}}|{{last_name}}|{{company}}", recipient({ firstName: null, lastName: null, company: null })),
      "there||",
    );
  });

  it("leaves unknown tokens as typed", () => {
    assert.equal(personalise("Hi {{nickname}} {{first_name}}", recipient()), "Hi {{nickname}} Ada");
    assert.equal(personalise("{first_name} {{ }}", recipient()), "{first_name} {{ }}");
    assert.deepEqual(unknownTokens("{{first_name}} {{nickname}} {{ nickname }} {{title}}"), [
      "{{nickname}}",
      "{{ nickname }}",
      "{{title}}",
    ]);
  });

  it("skips recipients without an email and duplicate addresses", () => {
    const { sendable, skipped } = splitRecipients([
      recipient(),
      recipient({ id: "r2", email: null, name: "No Mail" }),
      recipient({ id: "r3", email: "ADA@example.com" }),
      recipient({ id: "r4", email: "grace@example.com" }),
    ]);
    assert.deepEqual(sendable.map((item) => item.id), ["r1", "r4"]);
    assert.deepEqual(
      skipped.map((item) => [item.recipient.id, item.reason]),
      [
        ["r2", "no email address"],
        ["r3", "same email as another recipient"],
      ],
    );
  });

  it("stops a run on mailbox errors only", () => {
    assert.equal(stopsRun("Connect Microsoft in Inbox before sending."), true);
    assert.equal(stopsRun("Microsoft rejected the mailbox connection. Connect it again."), true);
    assert.equal(stopsRun("Add an email address before sending."), false);
    assert.equal(stopsRun("Contact not found."), false);
    assert.equal(
      stopsRun("Orbit could not read the saved Microsoft connection. Disconnect, then connect Microsoft again."),
      true,
    );
  });
});

describe("paced sending", () => {
  function clock() {
    let time = 1_000;
    const waits: number[] = [];
    return {
      waits,
      now: () => time,
      tick: (ms: number) => (time += ms),
      wait: async (ms: number) => {
        waits.push(ms);
        time += ms;
      },
    };
  }

  it("sends one at a time, spaced by the gap, and keeps going past ordinary failures", async () => {
    const fake = clock();
    const updates: SendUpdate[] = [];
    const sentAt: number[] = [];
    const result = await sendPaced(
      [{ id: "a" }, { id: "b" }, { id: "c" }],
      async (item) => {
        sentAt.push(fake.now());
        fake.tick(500);
        if (item.id === "b") return { error: "Add an email address before sending." };
        return { warning: item.id === "c" ? "Not filed." : null };
      },
      { gapMs: 2100, stopped: () => false, wait: fake.wait, now: fake.now, onUpdate: (u) => updates.push(u) },
    );
    assert.deepEqual(result, { sent: 2, halted: null, unsent: [] });
    assert.deepEqual(fake.waits, [1600, 1600]);
    assert.deepEqual(sentAt, [1000, 3100, 5200]);
    assert.deepEqual(
      updates.map((u) => `${u.id}:${u.status}`),
      ["a:sending", "a:sent", "b:sending", "b:failed", "c:sending", "c:sent"],
    );
    assert.deepEqual(updates[5], { id: "c", status: "sent", warning: "Not filed." });
  });

  it("halts on a mailbox error and when stopped", async () => {
    const fake = clock();
    const halted = await sendPaced(
      [{ id: "a" }, { id: "b" }, { id: "c" }],
      async (item) =>
        item.id === "a" ? {} : { error: "Microsoft rejected the mailbox connection. Connect it again." },
      { gapMs: 2100, stopped: () => false, wait: fake.wait, now: fake.now, onUpdate: () => {} },
    );
    assert.deepEqual(halted, {
      sent: 1,
      halted: "Microsoft rejected the mailbox connection. Connect it again.",
      unsent: ["c"],
    });

    let stop = false;
    const calls: string[] = [];
    const stopped = await sendPaced(
      [{ id: "a" }, { id: "b" }, { id: "c" }],
      async (item) => {
        calls.push(item.id);
        stop = true;
        return {};
      },
      { gapMs: 2100, stopped: () => stop, wait: fake.wait, now: fake.now, onUpdate: () => {} },
    );
    assert.deepEqual(calls, ["a"]);
    assert.deepEqual(stopped, { sent: 1, halted: null, unsent: ["b", "c"] });

    const thrown = await sendPaced(
      [{ id: "a" }],
      async () => {
        throw new Error("network");
      },
      { gapMs: 2100, stopped: () => false, wait: fake.wait, now: fake.now, onUpdate: () => {} },
    );
    assert.deepEqual(thrown, { sent: 0, halted: null, unsent: [] });
  });
});

describe("bulk archive and unarchive", () => {
  before(async () => {
    await resetDatabase();
  });

  after(async () => {
    await getPool().end();
  });

  it("unarchives a contact so it reappears in lists, with audit", async () => {
    const owner = await createUser("bulk-owner@example.com", "Bulk Owner");
    const created = await createContact(owner, {
      firstName: "Grace",
      lastName: "Hopper",
      email: "grace@navy.test",
    });
    const id = created.body.contact.id;
    await archiveContact(owner, id);
    assert.equal((await listContacts(owner, { query: "Grace" })).total, 0);

    const restored = await unarchiveContact(owner, id);
    assert.equal(restored.body.contact.archivedAt, null);
    const listed = await listContacts(owner, { query: "Grace" });
    assert.deepEqual(listed.data.map((contact) => contact.id), [id]);

    const again = await unarchiveContact(owner, id);
    assert.equal(again.body.contact.archivedAt, null);

    const audit = await getAdminPool().query<{ event_type: string; operation: string }>(
      "select event_type, operation from crm.audit_events where entity_id = $1 order by created_at, id",
      [id],
    );
    assert.deepEqual(
      audit.rows.map((row) => row.event_type),
      ["contact.created", "contact.archived", "contact.updated"],
    );
    assert.equal(audit.rows[2].operation, "unarchive_contact");
  });

  it("unarchives a company so it reappears in lists", async () => {
    const owner = await createUser("bulk-company@example.com", "Company Owner");
    const created = await createCompany(owner, { name: "Contoso", domain: "contoso.test" });
    const id = created.body.company.id;
    await archiveCompany(owner, id);
    assert.equal((await listCompanies(owner, { query: "Contoso" })).total, 0);
    const restored = await unarchiveCompany(owner, id);
    assert.equal(restored.body.company.archivedAt, null);
    assert.equal((await listCompanies(owner, { query: "Contoso" })).total, 1);
  });

  it("refuses to unarchive when an active record took the same domain", async () => {
    const owner = await createUser("bulk-dupe@example.com", "Dupe Owner");
    const first = await createCompany(owner, { name: "Tailspin", domain: "tailspin.test" });
    await archiveCompany(owner, first.body.company.id);
    await createCompany(owner, { name: "Tailspin Toys", domain: "tailspin.test" });
    await assert.rejects(unarchiveCompany(owner, first.body.company.id), {
      code: "duplicate_company",
    });
  });

  it("checks scope and keeps workspaces apart", async () => {
    const alpha = await createUser("bulk-alpha@example.com", "Alpha");
    const beta = await createUser("bulk-beta@example.com", "Beta");
    const contact = await createContact(alpha, { firstName: "Iso", email: "iso@alpha.test" });
    const company = await createCompany(alpha, { name: "Alpha Ltd", domain: "alpha.test" });
    await archiveContact(alpha, contact.body.contact.id);
    await archiveCompany(alpha, company.body.company.id);

    await assert.rejects(unarchiveContact(beta, contact.body.contact.id), { code: "not_found" });
    await assert.rejects(unarchiveCompany(beta, company.body.company.id), { code: "not_found" });
    const betaBulk = await unarchiveContacts(beta, [contact.body.contact.id]);
    assert.deepEqual(betaBulk, [
      { id: contact.body.contact.id, ok: false, error: "Contact not found." },
    ]);
    assert.deepEqual(await getContactsByIds(beta, [contact.body.contact.id]), []);
    assert.deepEqual(await listContactsAtCompanies(beta, [company.body.company.id]), []);

    const { actor: reader } = await createAgent(alpha.workspaceId, ["crm:read"], "Reader");
    await assert.rejects(unarchiveContact(reader, contact.body.contact.id), { code: "forbidden" });
    await assert.rejects(unarchiveCompany(reader, company.body.company.id), { code: "forbidden" });
    await assert.rejects(unarchiveContacts(reader, [contact.body.contact.id]), { code: "forbidden" });
    await assert.rejects(archiveCompanies(reader, [company.body.company.id]), { code: "forbidden" });

    const { actor: writer } = await createAgent(alpha.workspaceId, ["contacts:write"], "Writer");
    const restored = await unarchiveContact(writer, contact.body.contact.id);
    assert.equal(restored.body.contact.archivedAt, null);
  });

  it("archives in bulk with per-id results and a limit", async () => {
    const owner = await createUser("bulk-many@example.com", "Many");
    const a = await createContact(owner, { firstName: "Ann", email: "ann@many.test" });
    const b = await createContact(owner, { firstName: "Ben", email: "ben@many.test" });
    const results = await archiveContacts(owner, [
      a.body.contact.id,
      "not-a-uuid",
      b.body.contact.id,
      a.body.contact.id,
    ]);
    assert.deepEqual(results, [
      { id: a.body.contact.id, ok: true },
      { id: "not-a-uuid", ok: false, error: "Contact not found." },
      { id: b.body.contact.id, ok: true },
    ]);
    assert.equal((await listContacts(owner, { query: "many.test" })).total, 0);

    const undone = await unarchiveContacts(owner, [a.body.contact.id, b.body.contact.id]);
    assert.ok(undone.every((result) => result.ok));
    assert.equal((await listContacts(owner, { query: "many.test" })).total, 2);

    const tooMany = Array.from({ length: BULK_LIMIT + 1 }, (_, index) =>
      `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    );
    await assert.rejects(archiveContacts(owner, tooMany), { code: "invalid_input" });
    await assert.rejects(archiveContacts(owner, []), { code: "invalid_input" });
    await assert.rejects(archiveContacts(owner, "x"), { code: "invalid_input" });
    const atLimit = await archiveContacts(owner, tooMany.slice(0, BULK_LIMIT));
    assert.equal(atLimit.length, BULK_LIMIT);
    assert.ok(atLimit.every((result) => !result.ok));

    const company = await createCompany(owner, { name: "Many Co", domain: "many.test" });
    const companyResults = await archiveCompanies(owner, [company.body.company.id, "nope"]);
    assert.deepEqual(companyResults, [
      { id: company.body.company.id, ok: true },
      { id: "nope", ok: false, error: "Company not found." },
    ]);
    const companyUndo = await unarchiveCompanies(owner, [company.body.company.id]);
    assert.deepEqual(companyUndo, [{ id: company.body.company.id, ok: true }]);
  });

  it("loads selected records for export and company recipients", async () => {
    const owner = await createUser("bulk-export@example.com", "Export");
    const company = await createCompany(owner, { name: "Fabrikam", domain: "fabrikam.test" });
    const other = await createCompany(owner, { name: "Elsewhere", domain: "elsewhere.test" });
    const zed = await createContact(owner, {
      firstName: "Zed",
      lastName: "Last",
      email: "zed@fabrikam.test",
      companyId: company.body.company.id,
    });
    const amy = await createContact(owner, {
      firstName: "Amy",
      phone: "+44 20 7946 0000",
      companyId: company.body.company.id,
    });
    await createContact(owner, {
      firstName: "Out",
      email: "out@elsewhere.test",
      companyId: other.body.company.id,
    });
    const gone = await createContact(owner, {
      firstName: "Gone",
      email: "gone@fabrikam.test",
      companyId: company.body.company.id,
    });
    await archiveContact(owner, gone.body.contact.id);

    const picked = await getContactsByIds(owner, [zed.body.contact.id, "bad", amy.body.contact.id]);
    assert.deepEqual(picked.map((contact) => contact.firstName), ["Zed", "Amy"]);
    const rows = contactsCsvRows(picked);
    assert.equal(rows[0][0], "First name");
    assert.deepEqual(rows[1].slice(0, 3), ["Zed", "Last", "zed@fabrikam.test"]);
    assert.equal(rows[1][6], "Fabrikam");

    const people = await listContactsAtCompanies(owner, [company.body.company.id]);
    assert.deepEqual(people.map((contact) => contact.firstName), ["Amy", "Zed"]);
    assert.ok(people.every((contact) => contact.companyName === "Fabrikam"));

    const companies = await getCompaniesByIds(owner, [other.body.company.id, company.body.company.id]);
    assert.deepEqual(companies.map((item) => item.name), ["Elsewhere", "Fabrikam"]);
  });
});
