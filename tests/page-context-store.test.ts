import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { FOCUS_GRACE_MS, focusOnPage, pageSnapshot, releasePageFocus, unpinPageFocus, usePageContextStore } from "@/stores/page-context-store";

const place = { pathname: "/tasks", search: "" };
let now = 1_000_000;
const realNow = Date.now;

Object.assign(globalThis, { window: { location: place } });

const sent = () => pageSnapshot().focus;
const later = (ms: number) => {
  now += ms;
};

beforeEach(() => {
  now = 1_000_000;
  Date.now = () => now;
  place.pathname = "/tasks";
  usePageContextStore.setState({ focus: null, selection: null });
});

afterEach(() => {
  Date.now = realNow;
});

describe("the page focus a message is sent with", () => {
  it("sends an open task, keeps it a minute after it closes, then drops it", () => {
    focusOnPage("task", "a");
    later(10 * 60_000);
    assert.deepEqual(sent(), { kind: "task", id: "a" });
    releasePageFocus("task", "a");
    later(FOCUS_GRACE_MS - 1);
    assert.deepEqual(sent(), { kind: "task", id: "a" });
    later(2);
    assert.equal(sent(), null);
    assert.equal(usePageContextStore.getState().focus, null);
  });

  it("counts a task opened again as open, and never one closed long ago", () => {
    focusOnPage("task", "a");
    releasePageFocus("task", "a");
    later(5 * 60_000);
    assert.equal(sent(), null);
    focusOnPage("task", "a");
    later(5 * 60_000);
    assert.deepEqual(sent(), { kind: "task", id: "a" });
  });

  it("is only sent from the page it was opened on, and a newer focus replaces it", () => {
    focusOnPage("task", "a");
    place.pathname = "/mail";
    assert.equal(sent(), null);
    place.pathname = "/tasks";
    focusOnPage("task", "a");
    focusOnPage("task", "b");
    releasePageFocus("task", "a");
    assert.deepEqual(sent(), { kind: "task", id: "b" });
  });

  it("holds a task Ask Orbit was pressed on while the assistant is open, then gives it the usual minute", () => {
    focusOnPage("task", "a");
    focusOnPage("task", "a", { pinned: true });
    releasePageFocus("task", "a");
    later(10 * 60_000);
    assert.deepEqual(sent(), { kind: "task", id: "a" });
    unpinPageFocus();
    later(FOCUS_GRACE_MS - 1);
    assert.deepEqual(sent(), { kind: "task", id: "a" });
    later(2);
    assert.equal(sent(), null);
  });

  it("keeps a task that is still open after the assistant closes, until it closes too", () => {
    focusOnPage("task", "a");
    focusOnPage("task", "a", { pinned: true });
    unpinPageFocus();
    later(10 * 60_000);
    assert.deepEqual(sent(), { kind: "task", id: "a" });
    focusOnPage("task", "a");
    assert.equal(usePageContextStore.getState().focus?.pinned, undefined);
    releasePageFocus("task", "a");
    later(FOCUS_GRACE_MS + 1);
    assert.equal(sent(), null);
  });

  it("lets another task replace a held one", () => {
    focusOnPage("task", "a", { pinned: true });
    focusOnPage("task", "b");
    assert.deepEqual(sent(), { kind: "task", id: "b" });
    assert.equal(usePageContextStore.getState().focus?.pinned, undefined);
  });
});
