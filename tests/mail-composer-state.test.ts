import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SAVE_DELAY_MS, SAVE_MAX_WAIT_MS, draftSignature, fitsKeepalive, hasUnsaved, heldIsSaved, sameAccounts, saveDelay, type DraftFields, type StoredDraftContent } from "@/lib/mail/composer-state";
import type { MailAddress } from "@/lib/mail/types";
import { parseAddress, recipientsError, settleRecipients } from "@/lib/mail/recipient-text";

const fields: DraftFields = {
  mode: "new",
  messageId: null,
  sourceId: "mailbox-1",
  identityId: null,
  to: [{ address: "bob@y.com", name: "Bob" }],
  cc: [],
  bcc: [],
  subject: "Pricing",
  body: "Hi Bob",
  signature: true,
  replaces: null,
  attachments: [],
  remindHours: null,
  followUpDays: null,
  followUpBody: null,
};

describe("settling typed recipients", () => {
  it("turns text still in the box into recipients before a send reads them", () => {
    const settled = settleRecipients("bob@y.com", []);
    assert.deepEqual(settled, { ok: true, value: [{ address: "bob@y.com", name: null }], added: [{ address: "bob@y.com", name: null }] });
  });

  it("keeps the recipients already chosen and adds several typed at once", () => {
    const settled = settleRecipients("ann@x.com, Cal <cal@x.com>; dee@x.com", [{ address: "bob@y.com", name: "Bob" }]);
    assert.ok(settled.ok);
    assert.deepEqual(settled.value.map((item) => item.address), ["bob@y.com", "ann@x.com", "cal@x.com", "dee@x.com"]);
    assert.equal(settled.value[2].name, "Cal");
  });

  it("splits addresses separated only by spaces", () => {
    const settled = settleRecipients("ann@x.com cal@x.com", []);
    assert.ok(settled.ok);
    assert.deepEqual(settled.added.map((item) => item.address), ["ann@x.com", "cal@x.com"]);
  });

  it("does nothing when the box is empty", () => {
    const value = [{ address: "bob@y.com", name: null }];
    const settled = settleRecipients("   ", value);
    assert.ok(settled.ok);
    assert.equal(settled.value, value);
    assert.deepEqual(settled.added, []);
  });

  it("does not add a recipient twice", () => {
    const settled = settleRecipients("BOB@y.com", [{ address: "bob@y.com", name: "Bob" }]);
    assert.ok(settled.ok);
    assert.equal(settled.value.length, 1);
    assert.deepEqual(settled.added, []);
  });

  it("blocks when anything left in the box isn't an address", () => {
    assert.deepEqual(settleRecipients("bob", []), { ok: false });
    assert.deepEqual(settleRecipients("ann@x.com, bob", []), { ok: false });
    assert.deepEqual(settleRecipients("bob@", []), { ok: false });
  });

  it("parses a name with an address and rejects the rest", () => {
    assert.deepEqual(parseAddress('"Cal Jones" <Cal@X.com>'), { address: "cal@x.com", name: "Cal Jones" });
    assert.equal(parseAddress("nobody"), null);
    assert.equal(recipientsError("Cc"), "Check the address in Cc.");
  });
});

describe("unsaved draft text", () => {
  it("is unsaved until a save has been recorded", () => {
    assert.equal(hasUnsaved(fields, null), true);
    assert.equal(hasUnsaved(fields, draftSignature(fields)), false);
  });

  it("sees every field that goes into a draft", () => {
    const saved = draftSignature(fields);
    const changes: Partial<DraftFields>[] = [
      { body: "Hi Bob, one more line" },
      { subject: "Pricing v2" },
      { to: [] },
      { cc: [{ address: "ann@x.com", name: null }] },
      { bcc: [{ address: "ann@x.com", name: null }] },
      { signature: false },
      { attachments: ["file-1"] },
      { remindHours: 24 },
      { followUpDays: 3 },
      { followUpBody: "Ping" },
      { sourceId: "mailbox-2" },
      { identityId: "smtp-1" },
    ];
    for (const change of changes) assert.equal(hasUnsaved({ ...fields, ...change }, saved), true, JSON.stringify(change));
  });

  it("stays saved when only the key order or empty names differ", () => {
    const saved = draftSignature(fields);
    const again = { ...fields, to: [{ name: "Bob", address: "bob@y.com" }] };
    assert.equal(hasUnsaved(again, saved), false);
    assert.equal(draftSignature({ ...fields, to: [{ address: "bob@y.com", name: null }] }), draftSignature({ ...fields, to: [{ address: "bob@y.com" } as never] }));
  });

  it("keeps text typed after a save started as unsaved, so a quick send's text is not lost", () => {
    const sentSnapshot = { ...fields, body: "Hi Bob, quick" };
    const savedBeforeQuickSend = draftSignature(fields);
    assert.equal(hasUnsaved(sentSnapshot, savedBeforeQuickSend), true);
  });
});

describe("autosave timing", () => {
  it("waits the usual pause after a keystroke", () => {
    assert.equal(saveDelay(1000, 1000), SAVE_DELAY_MS);
    assert.equal(saveDelay(2000, 1000), SAVE_DELAY_MS);
  });

  it("never lets unsaved text wait longer than the maximum", () => {
    assert.equal(saveDelay(1000 + SAVE_MAX_WAIT_MS - 400, 1000), 400);
    assert.equal(saveDelay(1000 + SAVE_MAX_WAIT_MS, 1000), 0);
    assert.equal(saveDelay(1000 + SAVE_MAX_WAIT_MS + 3000, 1000), 0);
  });
});

describe("keepalive requests", () => {
  it("allows a small draft and refuses one over the browser's 64KB limit", () => {
    assert.equal(fitsKeepalive(JSON.stringify(fields)), true);
    assert.equal(fitsKeepalive("a".repeat(61_000)), false);
    assert.equal(fitsKeepalive("é".repeat(31_000)), false);
  });
});

describe("compose accounts", () => {
  const accounts = [{ id: "a", email: "a@x.com", signature: null, default: true }, { id: "b", email: "b@x.com", signature: "Mark" }];

  it("treats an identical list as unchanged so open cards don't re-render", () => {
    assert.equal(sameAccounts(accounts, accounts.map((item) => ({ ...item }))), true);
  });

  it("sees a change in length or content", () => {
    assert.equal(sameAccounts(accounts, accounts.slice(0, 1)), false);
    assert.equal(sameAccounts(accounts, [accounts[0], { ...accounts[1], signature: "Mark R" }]), false);
  });
});

describe("held copies on reopen", () => {
  const held = {
    id: "draft-1",
    subject: "Pricing",
    body: "Hi Bob\n\nS1 and S2",
    to: [{ address: "bob@y.com", name: "Bob" }],
    cc: [] as MailAddress[],
    bcc: [] as MailAddress[],
    remindHours: null,
    followUpDays: null,
    followUpBody: null,
    attachments: [],
  };
  const stored: StoredDraftContent = {
    subject: "Pricing",
    body: "Hi Bob\n\nS1 and S2",
    to: [{ address: "bob@y.com", name: null }],
    cc: [],
    bcc: [],
    remindHours: null,
    followUpDays: null,
    followUpBody: null,
    attachments: [],
  };

  it("drops a held copy the server already has word for word", () => {
    assert.equal(heldIsSaved(held, stored), true);
  });

  it("keeps a held copy when an older autosave landed after it was held", () => {
    assert.equal(heldIsSaved(held, { ...stored, body: "Hi Bob\n\nS1" }), false);
  });

  it("keeps a held copy whenever the server's draft differs in anything the held one has", () => {
    const differs: Partial<StoredDraftContent>[] = [
      { subject: "Pricing v2" },
      { to: [] },
      { cc: [{ address: "ann@x.com", name: null }] },
      { bcc: [{ address: "ann@x.com", name: null }] },
      { remindHours: 24 },
      { followUpDays: 3, followUpBody: "Ping" },
      { attachments: ["file-1"] },
    ];
    for (const change of differs) assert.equal(heldIsSaved(held, { ...stored, ...change }), false, JSON.stringify(change));
  });

  it("ignores how the server tidied the text and the order and case of addresses", () => {
    assert.equal(heldIsSaved({ ...held, subject: "  Pricing   ", body: "Hi Bob\r\n\r\nS1 and S2", to: [{ address: "BOB@y.com", name: "Bob" }] }, stored), true);
    assert.equal(heldIsSaved({ ...held, cc: [{ address: "b@x.com", name: null }, { address: "a@x.com", name: null }] }, { ...stored, cc: [{ address: "a@x.com", name: null }, { address: "b@x.com", name: null }] }), true);
  });

  it("keeps the held copy when the draft is gone or the server couldn't be asked", () => {
    assert.equal(heldIsSaved(held, null), false);
    assert.equal(heldIsSaved(held, undefined), false);
  });

  it("doesn't depend on any clock", () => {
    assert.equal(heldIsSaved({ ...held, at: 0 } as typeof held, stored), heldIsSaved({ ...held, at: Date.now() + 86_400_000 } as typeof held, stored));
  });
});
