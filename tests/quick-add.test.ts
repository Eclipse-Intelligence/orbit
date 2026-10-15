import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { actionError } from "@/lib/companies";
import { CrmError } from "@/lib/crm/errors";
import {
  isTypingTarget,
  opensQuickAdd,
  quickAddKindForKey,
  quickAddPrefill,
  recordRoute,
  type QuickAddRecord,
} from "@/lib/crm/quick-add";

const contactId = "022cc00d-ac58-46ae-9b87-256bc404fc4b";
const companyId = "9894def5-c7b5-4581-8a91-64a3235f6e03";
const jane: QuickAddRecord = {
  type: "contact",
  id: contactId,
  name: "Jane Doe",
  company: { id: companyId, name: "Company 007" },
};
const acme: QuickAddRecord = { type: "company", id: companyId, name: "Company 007" };

function key(input: Partial<Parameters<typeof opensQuickAdd>[0]> = {}) {
  return {
    key: "q",
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    repeat: false,
    defaultPrevented: false,
    target: { tagName: "BODY", isContentEditable: false },
    ...input,
  };
}

describe("quick add record route", () => {
  it("reads contact and company record pages only", () => {
    assert.deepEqual(recordRoute(`/contacts/${contactId}`), { type: "contact", id: contactId });
    assert.deepEqual(recordRoute(`/companies/${companyId}/`), { type: "company", id: companyId });
    assert.equal(recordRoute("/contacts"), null);
    assert.equal(recordRoute("/"), null);
    assert.equal(recordRoute("/tasks"), null);
    assert.equal(recordRoute(`/contacts/${contactId}/edit`), null);
    assert.equal(recordRoute(null), null);
    assert.equal(recordRoute("/contacts/%E0%A4%A"), null);
  });
});

describe("quick add prefill", () => {
  it("links tasks and opportunities to the contact and its company on a contact page", () => {
    const path = `/contacts/${contactId}`;
    const linked = { contact: { id: contactId, name: "Jane Doe" }, company: { id: companyId, name: "Company 007" } };
    assert.deepEqual(quickAddPrefill(path, jane, "task"), linked);
    assert.deepEqual(quickAddPrefill(path, jane, "opportunity"), linked);
    assert.deepEqual(quickAddPrefill(path, jane, "contact"), { contact: null, company: null });
    assert.deepEqual(quickAddPrefill(path, jane, "company"), { contact: null, company: null });
  });

  it("keeps the contact when it has no company", () => {
    const solo: QuickAddRecord = { ...jane, company: null } as QuickAddRecord;
    assert.deepEqual(quickAddPrefill(`/contacts/${contactId}`, solo, "task"), {
      contact: { id: contactId, name: "Jane Doe" },
      company: null,
    });
  });

  it("links everything but a new company to the company on a company page", () => {
    const path = `/companies/${companyId}`;
    const company = { id: companyId, name: "Company 007" };
    assert.deepEqual(quickAddPrefill(path, acme, "task"), { contact: null, company });
    assert.deepEqual(quickAddPrefill(path, acme, "contact"), { contact: null, company });
    assert.deepEqual(quickAddPrefill(path, acme, "opportunity"), { contact: null, company });
    assert.deepEqual(quickAddPrefill(path, acme, "company"), { contact: null, company: null });
  });

  it("ignores a record that doesn't belong to the current page", () => {
    const empty = { contact: null, company: null };
    assert.deepEqual(quickAddPrefill("/tasks", jane, "task"), empty);
    assert.deepEqual(quickAddPrefill(`/contacts/${companyId}`, jane, "task"), empty);
    assert.deepEqual(quickAddPrefill(`/companies/${contactId}`, jane, "task"), empty);
    assert.deepEqual(quickAddPrefill(`/contacts/${contactId}`, null, "task"), empty);
  });
});

describe("quick add shortcuts", () => {
  it("maps menu keys to record kinds", () => {
    assert.equal(quickAddKindForKey("t"), "task");
    assert.equal(quickAddKindForKey("C"), "contact");
    assert.equal(quickAddKindForKey("o"), "company");
    assert.equal(quickAddKindForKey("p"), "opportunity");
    assert.equal(quickAddKindForKey("x"), null);
    assert.equal(quickAddKindForKey("Enter"), null);
  });

  it("treats inputs, textareas, selects and editable content as typing", () => {
    assert.equal(isTypingTarget({ tagName: "INPUT" }), true);
    assert.equal(isTypingTarget({ tagName: "textarea" }), true);
    assert.equal(isTypingTarget({ tagName: "SELECT" }), true);
    assert.equal(isTypingTarget({ tagName: "DIV", isContentEditable: true }), true);
    assert.equal(isTypingTarget({ tagName: "BUTTON", isContentEditable: false }), false);
    assert.equal(isTypingTarget(null), false);
    assert.equal(isTypingTarget("INPUT"), false);
  });

  it("opens on a bare q outside text fields", () => {
    assert.equal(opensQuickAdd(key()), true);
    assert.equal(opensQuickAdd(key({ key: "Q" })), true);
    assert.equal(opensQuickAdd(key({ key: "w" })), false);
    assert.equal(opensQuickAdd(key({ target: { tagName: "INPUT" } })), false);
    assert.equal(opensQuickAdd(key({ target: { tagName: "P", isContentEditable: true } })), false);
    assert.equal(opensQuickAdd(key({ metaKey: true })), false);
    assert.equal(opensQuickAdd(key({ ctrlKey: true })), false);
    assert.equal(opensQuickAdd(key({ altKey: true })), false);
    assert.equal(opensQuickAdd(key({ shiftKey: true })), false);
    assert.equal(opensQuickAdd(key({ repeat: true })), false);
    assert.equal(opensQuickAdd(key({ defaultPrevented: true })), false);
    assert.equal(opensQuickAdd(key({ isComposing: true })), false);
  });
});

describe("quick add errors", () => {
  it("passes the existing record id through for duplicates", () => {
    const duplicate = new CrmError("duplicate_company", "A matching company already exists.", 409, {
      existingId: companyId,
      matchedOn: "domain",
    });
    assert.deepEqual(actionError(duplicate), {
      error: "A matching company already exists.",
      field: undefined,
      existingId: companyId,
    });
    assert.deepEqual(actionError(new CrmError("invalid_input", "Enter a task.", 400, { field: "title" })), {
      error: "Enter a task.",
      field: "title",
      existingId: undefined,
    });
  });
});
