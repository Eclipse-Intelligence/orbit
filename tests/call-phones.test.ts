import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { listToFile } from "@/lib/crm/capture";
import { phoneNumbersIn } from "@/lib/crm/call-phones";
import { createCompany } from "@/lib/crm/companies";
import { createContact } from "@/lib/crm/contacts";
import { fileGranolaNote } from "@/lib/crm/granola";
import type { UserActor } from "@/lib/crm/types";
import { getAdminPool, getPool } from "@/lib/db/pool";
import type { GranolaNote } from "@/lib/granola";
import { createUser, resetDatabase } from "./helpers";

function hoursAgo(hours: number) {
  return new Date(Date.now() - hours * 3_600_000).toISOString();
}

function phoneNote(id: string, owner: UserActor, title: string, summary: string): GranolaNote {
  return {
    id,
    title,
    owner: { name: owner.fullName, email: owner.email },
    created_at: hoursAgo(3),
    updated_at: hoursAgo(2),
    deleted_at: null,
    web_url: `https://notes.granola.ai/d/${id}`,
    calendar_event: null,
    attendees: [],
    summary_text: summary,
    summary_markdown: summary,
    transcript: [],
  };
}

describe("matching Granola phone calls by number", () => {
  let mark: UserActor;

  async function imported(id: string) {
    const result = await getAdminPool().query<{ id: string; status: string; contact_id: string | null; company_id: string | null }>(
      "select id, status, contact_id, company_id from crm.conversation_imports where external_id = $1",
      [id],
    );
    assert.equal(result.rows.length, 1);
    return result.rows[0];
  }

  async function companyWithPhone(name: string, domain: string, phone: string) {
    const company = await createCompany(mark, { name, domain });
    const id = company.body.company.id;
    await getAdminPool().query("update crm.companies set phone = $1 where id = $2", [phone, id]);
    return id;
  }

  before(async () => {
    await resetDatabase();
    mark = await createUser("mark@geteclipse.co", "Mark Ridgeon");
  });

  after(async () => {
    await getPool().end();
    await getAdminPool().end();
  });

  it("reads phone numbers from a call title and ignores dates and short numbers", () => {
    assert.deepEqual(phoneNumbersIn("Phone call with +447702794481"), ["+447702794481"]);
    assert.deepEqual(phoneNumbersIn("Call with 07702 794 481"), ["+447702794481"]);
    assert.deepEqual(phoneNumbersIn("Call with +44 (0)20 7946 0018"), ["+442079460018"]);
    assert.deepEqual(phoneNumbersIn("Q3 2026 review"), []);
    assert.deepEqual(phoneNumbersIn("Weekly 2026-11-12"), []);
    assert.deepEqual(phoneNumbersIn(null), []);
  });

  it("files a call to the contact whose phone is the number in the title", async () => {
    const sara = await createContact(mark, { firstName: "Sara", lastName: "Price", email: "sara@price.test", phone: "07700 900111" });
    const call = phoneNote("not_phone_contact1", mark, "Phone call with +447700900111", "Call Summary\n- Talked about renewal");
    assert.equal(await fileGranolaNote(mark, call), "filed");
    const row = await imported(call.id);
    assert.equal(row.status, "filed");
    assert.equal(row.contact_id, sara.body.contact.id);
  });

  it("files a switchboard call to the contact at that company named in the summary", async () => {
    const companyId = await companyWithPhone("Gatehouse", "gatehouse.test", "+44 20 7946 0101");
    const paul = await createContact(mark, { firstName: "Paul", lastName: "Hart", email: "paul@gatehouse.test", companyId });
    await createContact(mark, { firstName: "Anna", lastName: "Reed", email: "anna@gatehouse.test", companyId });
    await createContact(mark, { firstName: "Paul", lastName: "Elsewhere", email: "paul@elsewhere.test" });
    const call = phoneNote(
      "not_phone_board01",
      mark,
      "Phone call with +442079460101",
      "Call Summary\n- Reached Paul via a gatekeeper; brief call as he was heading into a meeting",
    );
    assert.equal(await fileGranolaNote(mark, call), "filed");
    const row = await imported(call.id);
    assert.equal(row.contact_id, paul.body.contact.id);
    assert.equal(row.company_id, companyId);
  });

  it("files a switchboard call to the company when nobody there is named", async () => {
    const companyId = await companyWithPhone("Quiet Ltd", "quiet.test", "020 7946 0202");
    await createContact(mark, { firstName: "Olive", lastName: "Stone", email: "olive@quiet.test", companyId });
    const call = phoneNote("not_phone_board02", mark, "Phone call with +442079460202", "Call Summary\n- Left a message with reception");
    assert.equal(await fileGranolaNote(mark, call), "filed");
    const row = await imported(call.id);
    assert.equal(row.contact_id, null);
    assert.equal(row.company_id, companyId);
  });

  it("suggests the matching people instead of guessing when two share the first name", async () => {
    const companyId = await companyWithPhone("Twin Co", "twin.test", "+44 20 7946 0303");
    const first = await createContact(mark, { firstName: "Paul", lastName: "One", email: "paul.one@twin.test", companyId });
    const second = await createContact(mark, { firstName: "Paul", lastName: "Two", email: "paul.two@twin.test", companyId });
    await createContact(mark, { firstName: "Zed", lastName: "Other", email: "zed@twin.test", companyId });
    const call = phoneNote("not_phone_board03", mark, "Phone call with +442079460303", "Call Summary\n- Spoke to Paul about the trial");
    assert.equal(await fileGranolaNote(mark, call), "unfiled");
    const row = await imported(call.id);
    assert.equal(row.status, "unfiled");
    const item = (await listToFile(mark)).unfiled.find((entry) => entry.id === row.id)!;
    assert.equal(item.suggestedBy, "phone");
    assert.deepEqual(item.suggestions.map((entry) => entry.contactId).sort(), [first.body.contact.id, second.body.contact.id].sort());
  });

  it("does not take the caller's own first name as the person they reached", async () => {
    const companyId = await companyWithPhone("Mirror Ltd", "mirror.test", "+44 20 7946 0505");
    await createContact(mark, { firstName: "Mark", lastName: "Mirror", email: "mark@mirror.test", companyId });
    const call = phoneNote("not_phone_board05", mark, "Phone call with +442079460505", "Call Summary\n- Mark asked for the buyer");
    assert.equal(await fileGranolaNote(mark, call), "filed");
    const row = await imported(call.id);
    assert.equal(row.contact_id, null);
    assert.equal(row.company_id, companyId);
  });

  it("leaves a call to an unknown number in To file with nothing suggested", async () => {
    const call = phoneNote("not_phone_none01", mark, "Phone call with +447700900999", "Call Summary\n- Spoke to Paul");
    assert.equal(await fileGranolaNote(mark, call), "unfiled");
    const row = await imported(call.id);
    const item = (await listToFile(mark)).unfiled.find((entry) => entry.id === row.id)!;
    assert.deepEqual(item.suggestions, []);
    assert.equal(item.suggestedBy, null);
  });

  it("suggests the contact for a call filed before the number was known", async () => {
    const call = phoneNote("not_phone_later01", mark, "Phone call with +447700900444", "Call Summary\n- Quick chat");
    assert.equal(await fileGranolaNote(mark, call), "unfiled");
    const lena = await createContact(mark, { firstName: "Lena", lastName: "Fox", email: "lena@fox.test", phone: "+44 7700 900444" });
    const row = await imported(call.id);
    const item = (await listToFile(mark)).unfiled.find((entry) => entry.id === row.id)!;
    assert.equal(item.suggestedBy, "phone");
    assert.deepEqual(item.suggestions.map((entry) => entry.contactId), [lena.body.contact.id]);
  });
});
