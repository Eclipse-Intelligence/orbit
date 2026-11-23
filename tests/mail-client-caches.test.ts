import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  bindMailCache,
  cachedList,
  cachedThread,
  forgetThread,
  loadThread,
  mailCacheSizes,
  noteDwellRead,
  dwellReadDue,
  storeList,
  storeThread,
} from "@/components/mail/mail-cache";
import { forwardedKey } from "@/lib/mail/frame-keys";
import { mailFormatterCount, mailFullWhen, mailListWhen, mailShortWhen } from "@/lib/mail/format";
import { THREAD_CACHE_LIMIT, trimOldest, trimRecord } from "@/lib/mail/lru";
import { bareSummary, summaryFromDetail } from "@/lib/mail/thread-summary";
import type { ThreadDetail, ThreadMessage } from "@/lib/mail/view";

function message(id: string, patch: Partial<ThreadMessage> = {}): ThreadMessage {
  return {
    id,
    folderRole: "inbox",
    folder: "Inbox",
    from: { name: "Ann", address: "ann@example.com" },
    to: [{ name: null, address: "me@example.com" }],
    cc: [],
    at: "2026-11-20T10:00:00.000Z",
    isRead: true,
    isDraft: false,
    isFlagged: false,
    hasAttachments: false,
    snippet: "Hello",
    html: null,
    rich: false,
    text: "Hello",
    webLink: null,
    opens: null,
    ...patch,
  };
}

function detail(key: string, messages: ThreadMessage[] = [message(`${key}-1`)]): ThreadDetail {
  return {
    key,
    account: "me@example.com",
    subject: "Subject",
    people: [],
    messages,
    drafts: [],
    prepared: null,
    followUp: null,
  };
}

describe("mail client caches", () => {
  it("drops everything one person loaded when someone else signs in on the same tab", () => {
    bindMailCache("user-a");
    storeThread(detail("src|a"));
    storeList({ view: "inbox", account: null, query: "" }, { threads: [], next: null });
    noteDwellRead("src|a", "m1");
    assert.ok(cachedThread("src|a"));
    assert.ok(cachedList({ view: "inbox", account: null, query: "" }));
    assert.equal(bindMailCache("user-a"), false);
    assert.ok(cachedThread("src|a"));
    assert.equal(bindMailCache("user-b"), true);
    assert.equal(cachedThread("src|a"), null);
    assert.equal(cachedList({ view: "inbox", account: null, query: "" }), null);
    assert.equal(dwellReadDue("src|a", "m1"), true);
    assert.deepEqual(Object.values(mailCacheSizes()).reduce((sum, size) => sum + size, 0), 0);
  });

  it("keeps at most the newest threads and forgets the oldest first", () => {
    bindMailCache("user-lru");
    for (let index = 0; index < THREAD_CACHE_LIMIT + 25; index += 1) storeThread(detail(`src|${index}`));
    assert.equal(mailCacheSizes().details, THREAD_CACHE_LIMIT);
    assert.equal(cachedThread("src|0"), null);
    assert.ok(cachedThread(`src|${THREAD_CACHE_LIMIT + 24}`));
    assert.ok(mailCacheSizes().generations <= 400);
  });

  it("counts a thread that was read again as recent", () => {
    bindMailCache("user-recent");
    for (let index = 0; index < THREAD_CACHE_LIMIT; index += 1) storeThread(detail(`src|${index}`));
    assert.ok(cachedThread("src|0"));
    storeThread(detail("src|new"));
    assert.ok(cachedThread("src|0"));
    assert.equal(cachedThread("src|1"), null);
  });

  it("does not store an answer that arrived after the thread was forgotten", async () => {
    bindMailCache("user-late");
    const original = globalThis.fetch;
    let release: (value: Response) => void = () => undefined;
    globalThis.fetch = (() => new Promise<Response>((resolve) => (release = resolve))) as typeof fetch;
    try {
      const loading = loadThread("src|late");
      forgetThread("src|late");
      release(new Response(JSON.stringify(detail("src|late")), { status: 200, headers: { "content-type": "application/json" } }));
      await loading;
      assert.equal(cachedThread("src|late"), null);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("trimming", () => {
  it("trims the oldest entries of a map", () => {
    const map = new Map([["a", 1], ["b", 2], ["c", 3]]);
    const gone: string[] = [];
    trimOldest(map, 2, (key) => gone.push(key));
    assert.deepEqual([...map.keys()], ["b", "c"]);
    assert.deepEqual(gone, ["a"]);
  });

  it("trims a record oldest first but never the protected keys", () => {
    const record = { a: 1, b: 2, c: 3, d: 4 };
    assert.deepEqual(Object.keys(trimRecord(record, 2, ["a"])), ["a", "d"]);
    assert.equal(trimRecord(record, 4, []), record);
  });
});

describe("thread summaries from an open thread", () => {
  it("describes a thread that is not in the list", () => {
    const open = detail("src1|t", [message("m1"), message("m2", { isRead: false, isFlagged: true, snippet: "Latest" }), message("d1", { isDraft: true, folderRole: "drafts" })]);
    const summary = summaryFromDetail(open);
    assert.equal(summary.key, "src1|t");
    assert.equal(summary.sourceId, "src1");
    assert.equal(summary.latestId, "m2");
    assert.equal(summary.count, 2);
    assert.equal(summary.unread, true);
    assert.equal(summary.flagged, true);
    assert.equal(summary.draft, true);
    assert.equal(summary.snippet, "Latest");
  });

  it("reads as read once every message is read", () => {
    assert.equal(summaryFromDetail(detail("s|t")).unread, false);
    assert.equal(bareSummary("src9|t").sourceId, "src9");
  });
});

describe("keys forwarded from an email", () => {
  it("passes plain letters, symbols, Escape and the up and down arrows", () => {
    assert.deepEqual(forwardedKey({ type: "key", key: "j", code: "KeyJ", shiftKey: false, repeat: true }), { key: "j", code: "KeyJ", shiftKey: false, repeat: true });
    assert.equal(forwardedKey({ type: "key", key: "#", shiftKey: true })?.shiftKey, true);
    assert.ok(forwardedKey({ type: "key", key: "Escape" }));
    assert.ok(forwardedKey({ type: "key", key: "ArrowDown" }));
  });

  it("ignores everything else", () => {
    for (const key of [" ", "Enter", "Tab", "Backspace", "ArrowLeft", "Meta", "ab"]) assert.equal(forwardedKey({ type: "key", key }), null);
    assert.equal(forwardedKey({ type: "height", key: "j" }), null);
    assert.equal(forwardedKey({ type: "key", key: 4 }), null);
    assert.equal(forwardedKey(null), null);
    assert.equal(forwardedKey("j"), null);
  });
});

describe("mail dates", () => {
  it("reuses one formatter per shape and time zone", () => {
    const now = Date.parse("2026-11-23T12:00:00.000Z");
    const first = [mailListWhen("2026-11-23T09:30:00.000Z", now), mailListWhen("2026-10-01T09:30:00.000Z", now), mailListWhen("2025-10-01T09:30:00.000Z", now), mailShortWhen("2026-11-01T09:30:00.000Z", now), mailFullWhen("2026-11-23T09:30:00.000Z")];
    const count = mailFormatterCount();
    for (let index = 0; index < 200; index += 1) mailListWhen("2026-10-01T09:30:00.000Z", now);
    assert.equal(mailFormatterCount(), count);
    assert.deepEqual(first.slice(0, 3), ["09:30", "1 Oct", "1 Oct 2025"]);
    assert.equal(first[3], "1 Nov");
  });
});
