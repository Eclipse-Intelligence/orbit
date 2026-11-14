import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { startPointerGesture, type GestureResult } from "@/lib/pointer-gesture";
import { panelTaskFor, stillOpenIds } from "@/lib/task-done";
import { shownAlert, typingInto } from "@/lib/reminder-alerts";
import { clearFields, draftFields, draftReaction, failFields, fieldError, fieldsOf, saveFailedMessage, unsavedDraftError, type FieldErrors } from "@/lib/task-field-errors";
import { parseTaskText } from "@/lib/task-pad";

describe("task area UI", () => {
  it("keeps a failed due date's error until the due date itself saves", () => {
    let errors: FieldErrors = [];
    errors = failFields(errors, fieldsOf({ dueAt: "2026-11-20T09:00:00Z", dueHasTime: true }), "Couldn't save. Try again.");
    errors = clearFields(errors, fieldsOf({ durationMinutes: 45 }));
    assert.equal(fieldError(errors), "Couldn't save. Try again.");
    errors = clearFields(errors, fieldsOf({ title: "Call Jane" }));
    assert.equal(fieldError(errors), "Couldn't save. Try again.");
    errors = clearFields(errors, fieldsOf({ dueDate: "2026-11-20" }));
    assert.equal(fieldError(errors), null);
  });

  it("shows the latest error still standing, and a retried field's own error replaces its old one", () => {
    let errors: FieldErrors = [];
    errors = failFields(errors, ["due"], "Couldn't move it.");
    errors = failFields(errors, ["title"], "Couldn't save your title. Try again.");
    assert.equal(fieldError(errors), "Couldn't save your title. Try again.");
    errors = clearFields(errors, ["title"]);
    assert.equal(fieldError(errors), "Couldn't move it.");
    errors = failFields(errors, ["due"], "Pick a later time.");
    assert.equal(errors.length, 1);
    assert.equal(fieldError(errors), "Pick a later time.");
    assert.equal(clearFields(errors, ["duration"]), errors);
  });

  it("says a title or description from a failed save wasn't saved when the task opens again", () => {
    assert.equal(unsavedDraftError(undefined), null);
    assert.equal(unsavedDraftError({}), null);
    assert.equal(unsavedDraftError({ title: "Call Jane" }), "Couldn't save your title. Try again.");
    assert.equal(unsavedDraftError({ text: "Notes" }), "Couldn't save your description. Try again.");
    assert.equal(unsavedDraftError({ title: "Call Jane", text: "" }), "Couldn't save your title and description. Try again.");
    assert.equal(saveFailedMessage(["text"]), "Couldn't save your description. Try again.");
    assert.equal(saveFailedMessage(["due", "reminder"]), "Couldn't save. Try again.");
    const errors = failFields([], draftFields({ title: "Call Jane", text: "Notes" }), "x");
    assert.equal(fieldError(clearFields(errors, ["title"])), "x");
    assert.equal(fieldError(clearFields(errors, ["title", "text"])), null);
  });

  it("shows an unsaved draft kept by the panel in a row that is already open, unless that row is being edited", () => {
    assert.equal(draftReaction({ kept: true, value: "Call Jane edited" }, "Call Jane", "Call Jane"), "adopt");
    assert.equal(draftReaction({ kept: true, value: "Call Jane edited" }, "Call Jane edited", "Call Jane"), "ignore");
    assert.equal(draftReaction({ kept: true, value: "Call Jane edited" }, "Call Jane now", "Call Jane"), "ignore");
    assert.equal(draftReaction({ kept: false, value: "Call Jane edited" }, "Call Jane edited", "Call Jane"), "clear");
    assert.equal(draftReaction({ kept: false, value: "Call Jane edited" }, "Call Jane", "Call Jane"), "ignore");
  });

  it("shows only the newest reminder alert, with a count of the rest", () => {
    assert.deepEqual(shownAlert([]), { alert: null, more: 0 });
    assert.deepEqual(shownAlert(["a"]), { alert: "a", more: 0 });
    assert.deepEqual(shownAlert(["a", "b", "c"]), { alert: "c", more: 2 });
  });

  it("hides reminder alerts only while a text field has focus", () => {
    assert.equal(typingInto(null), false);
    assert.equal(typingInto({ tagName: "TEXTAREA" }), true);
    assert.equal(typingInto({ tagName: "TEXTAREA", readOnly: true }), false);
    assert.equal(typingInto({ tagName: "INPUT", type: "text" }), true);
    assert.equal(typingInto({ tagName: "INPUT", type: "search" }), true);
    assert.equal(typingInto({ tagName: "INPUT", type: "checkbox" }), false);
    assert.equal(typingInto({ tagName: "INPUT", type: "text", disabled: true }), false);
    assert.equal(typingInto({ tagName: "DIV", isContentEditable: true }), true);
    assert.equal(typingInto({ tagName: "BUTTON" }), false);
  });

  it("treats tasks as still open when the follow-up check fails, so they show again", async () => {
    const ids = ["a", "b"];
    assert.deepEqual(await stillOpenIds(ids, async () => Promise.reject(new Error("offline"))), ids);
    assert.deepEqual(await stillOpenIds(ids, async () => ({ error: "Couldn't check the tasks. Try again." }) as { open?: string[] }), ids);
    assert.deepEqual(await stillOpenIds(ids, async () => ({ open: ["b"] })), ["b"]);
    assert.deepEqual(await stillOpenIds(ids, async () => ({ open: [] })), []);
  });

  it("keeps the Calendar panel open on a date-only task being reopened", () => {
    const kept = { id: "t1" };
    assert.equal(panelTaskFor("t1", null, kept, () => false), null);
    assert.equal(panelTaskFor("t1", null, kept, (id) => id === "t1"), kept);
    assert.equal(panelTaskFor("t2", null, kept, () => true), null);
    const listed = { id: "t1" };
    assert.equal(panelTaskFor("t1", listed, kept, () => false), listed);
  });

  it("reads a weekday with a time later today as today, and as next week once that time has passed", () => {
    const mondayMorning = new Date("2026-11-16T10:30:00Z");
    const mondayEvening = new Date("2026-11-16T16:00:00Z");
    assert.equal(parseTaskText("Call Jane Monday 3pm", mondayMorning).due, "2026-11-16T15:00");
    assert.equal(parseTaskText("Call Jane this Monday at 3pm", mondayMorning).due, "2026-11-16T15:00");
    assert.equal(parseTaskText("Call Jane mon 15:00", mondayMorning).due, "2026-11-16T15:00");
    assert.equal(parseTaskText("Call Jane Monday 3pm", mondayEvening).due, "2026-11-23T15:00");
    assert.equal(parseTaskText("Call Jane Monday 10am", mondayMorning).due, "2026-11-23T10:00");
    assert.equal(parseTaskText("Call Jane next Monday 3pm", mondayMorning).due, "2026-11-23T15:00");
    assert.equal(parseTaskText("Call Jane Monday", mondayMorning).due, "2026-11-23");
    assert.equal(parseTaskText("Call Jane Tuesday 3pm", mondayMorning).due, "2026-11-17T15:00");
    const saturday = new Date("2026-11-21T09:00:00Z");
    assert.equal(parseTaskText("Call Sam sat 3pm", saturday).due, "2026-11-21T15:00");
    assert.equal(parseTaskText("Call Sam next sat 3pm", saturday).due, "2026-11-28T15:00");
  });
});

type FakeWindow = EventTarget & { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout };

describe("drag cancel with Escape", () => {
  let fake: FakeWindow;
  const original = (globalThis as { window?: unknown }).window;
  beforeEach(() => {
    fake = Object.assign(new EventTarget(), { setTimeout, clearTimeout }) as FakeWindow;
    (globalThis as { window?: unknown }).window = fake;
  });
  afterEach(() => {
    (globalThis as { window?: unknown }).window = original;
  });

  const pointer = (type: string, init: { clientX?: number; clientY?: number; buttons?: number } = {}) =>
    Object.assign(new Event(type, { cancelable: true }), { pointerId: 1, clientX: 0, clientY: 0, buttons: 1, ...init });

  function record() {
    const seen: string[] = [];
    return { seen, handlers: { start: () => seen.push("start"), move: () => undefined, end: (result: GestureResult) => seen.push(`end:${result}`) } };
  }

  it("cancels a mouse drag on Escape, swallows the release click and leaves other keys alone", async () => {
    const { seen, handlers } = record();
    startPointerGesture({ pointerType: "mouse", pointerId: 1, clientX: 10, clientY: 10 }, handlers);
    fake.dispatchEvent(pointer("pointermove", { clientX: 40, clientY: 10 }));
    const other = new KeyboardEventLike("keydown", "Enter");
    fake.dispatchEvent(other);
    assert.equal(other.defaultPrevented, false);
    const escape = new KeyboardEventLike("keydown", "Escape");
    let reachedOthers = false;
    fake.addEventListener("keydown", () => (reachedOthers = true));
    fake.dispatchEvent(escape);
    assert.equal(escape.defaultPrevented, true);
    assert.equal(reachedOthers, false);
    assert.deepEqual(seen, ["start", "end:cancel"]);
    fake.dispatchEvent(pointer("pointerup"));
    const click = new Event("click", { cancelable: true });
    fake.dispatchEvent(click);
    assert.equal(click.defaultPrevented, true);
    assert.deepEqual(seen, ["start", "end:cancel"]);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const later = new Event("click", { cancelable: true });
    fake.dispatchEvent(later);
    assert.equal(later.defaultPrevented, false);
  });

  it("lets Escape through before a drag has started", () => {
    const { seen, handlers } = record();
    startPointerGesture({ pointerType: "mouse", pointerId: 1, clientX: 10, clientY: 10 }, handlers);
    const escape = new KeyboardEventLike("keydown", "Escape");
    fake.dispatchEvent(escape);
    assert.equal(escape.defaultPrevented, false);
    fake.dispatchEvent(pointer("pointerup"));
    assert.deepEqual(seen, ["end:tap"]);
  });
});

class KeyboardEventLike extends Event {
  readonly key: string;
  constructor(type: string, key: string) {
    super(type, { cancelable: true });
    this.key = key;
  }
}
