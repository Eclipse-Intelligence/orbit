import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { heldDrafts, holdDraft, releaseDraft, type HeldDraft } from "@/components/mail/held-drafts";
import { SAVE_DELAY_MS, SAVE_MAX_WAIT_MS, draftSignature, fitsKeepalive, hasUnsaved, heldIsSaved, heldOpening, openingSignature, sameAccounts, saveDelay, type DraftFields, type StoredDraftContent } from "@/lib/mail/composer-state";
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
      { sourceId: "mailbox-2" },
      { identityId: "smtp-1" },
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
    sourceId: "mailbox-1",
    identityId: null as string | null,
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
    sourceId: "mailbox-1",
    identityId: null,
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
      { sourceId: "mailbox-2" },
      { identityId: "smtp-1" },
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

describe("a reopened held copy", () => {
  const phone: DraftFields = { ...fields, body: "Hi Bob, typed on the phone" };

  it("makes no save of its own until someone edits it", () => {
    const opened = openingSignature(phone, {});
    assert.equal(hasUnsaved(phone, opened), false);
  });

  it("saves everything it holds on the first edit", () => {
    const opened = openingSignature(phone, {});
    const edited = { ...phone, subject: "Pricing v2" };
    assert.equal(hasUnsaved(edited, opened), true);
    assert.notEqual(draftSignature(edited), draftSignature(phone));
    assert.equal(edited.body, "Hi Bob, typed on the phone");
  });

  it("still saves at once when it is marked as never saved", () => {
    assert.equal(hasUnsaved(phone, openingSignature(phone, { unsaved: true })), true);
  });
});

describe("how a held copy reopens", () => {
  const phone: DraftFields = { ...fields, body: "Typed and then the tab went" };
  const savesOnItsOwn = (mode: ReturnType<typeof heldOpening>) => hasUnsaved(phone, openingSignature(phone, { unsaved: mode === "save" || mode === "reconnect" }));

  it("saves an email that was held before its first save, so the text can't be lost", () => {
    const mode = heldOpening({ key: "k", reason: "page" }, "");
    assert.equal(mode, "save");
    assert.equal(savesOnItsOwn(mode), true);
    assert.equal(heldOpening({ key: "k" }, null), "save");
  });

  it("saves a copy held after a reconnect failure, so the prompt and the retry work as before", () => {
    const mode = heldOpening({ key: "k", reason: "reconnect" }, "draft-1");
    assert.equal(mode, "reconnect");
    assert.equal(savesOnItsOwn(mode), true);
    assert.equal(heldOpening({ key: "k", reason: "reconnect" }, ""), "reconnect");
  });

  it("waits for an edit when the server already has a draft the held text may be older than", () => {
    const mode = heldOpening({ key: "k", reason: "page" }, "draft-1");
    assert.equal(mode, "kept");
    assert.equal(savesOnItsOwn(mode), false);
  });

  it("takes the safe path for a copy held before reasons were recorded", () => {
    assert.equal(heldOpening({ key: "k" }, "draft-1"), "kept");
  });

  it("is not a held copy without a key", () => {
    assert.equal(heldOpening({ key: undefined, reason: "reconnect" }, "draft-1"), "none");
    assert.equal(heldOpening({}, ""), "none");
  });
});

describe("held copies in the tab", () => {
  const store = new Map<string, string>();
  const original = Object.getOwnPropertyDescriptor(globalThis, "window");

  beforeEach(() => {
    store.clear();
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { sessionStorage: { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => void store.set(key, value), removeItem: (key: string) => void store.delete(key) } },
    });
  });

  afterEach(() => {
    if (original) Object.defineProperty(globalThis, "window", original);
    else delete (globalThis as { window?: unknown }).window;
  });

  const held = (key: string): HeldDraft => ({
    key,
    at: 1,
    fromEmail: "mark@eclipse.test",
    draft: { id: "", sourceId: "mailbox-1", mode: "new", messageId: null, to: [], cc: [], bcc: [], subject: "Held", body: "Text", savedAt: "", sendAt: null, sendError: null },
  });

  it("remembers why a copy was held", () => {
    holdDraft({ ...held("a"), reason: "reconnect" });
    holdDraft(held("b"));
    assert.deepEqual(heldDrafts().map((item) => [item.key, item.reason]), [["a", "reconnect"], ["b", undefined]]);
  });

  it("keeps a held copy until it is released", () => {
    holdDraft(held("a"));
    holdDraft(held("b"));
    assert.deepEqual(heldDrafts().map((item) => item.key), ["a", "b"]);
    releaseDraft("a");
    assert.deepEqual(heldDrafts().map((item) => item.key), ["b"]);
    releaseDraft(null);
    releaseDraft("missing");
    assert.deepEqual(heldDrafts().map((item) => item.key), ["b"]);
    releaseDraft("b");
    assert.deepEqual(heldDrafts(), []);
  });
});
