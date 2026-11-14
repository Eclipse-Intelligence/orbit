import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { startPointerGesture, type GestureResult } from "@/lib/pointer-gesture";
import { CrmError } from "@/lib/crm/errors";
import { missingOrFailed, panelTaskFor, stillOpenIds } from "@/lib/task-done";
import { alertRenderKey, keyboardUp, restingView, shownAlert, typingInto } from "@/lib/reminder-alerts";
import { draftCommit, taskDrafts, type DraftChange } from "@/lib/task-drafts";
import { applyDraftNews, clearFields, draftFields, draftReaction, failFields, fieldError, fieldsOf, saveFailedMessage, unsavedDraftError, type FieldErrors } from "@/lib/task-field-errors";
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
    const kept = { kept: true, draft: "Call Jane edited", saved: "Call Jane" };
    assert.equal(draftReaction(kept, "Call Jane", "Call Jane"), "adopt");
    assert.equal(draftReaction(kept, "Call Jane edited", "Call Jane"), "ignore");
    assert.equal(draftReaction(kept, "Call Jane now", "Call Jane"), "ignore");
  });

  it("puts other views back to the saved title when a draft is reverted, and clears the error once it saves", () => {
    const reverted = { kept: false, draft: "Call Jane edited", saved: "Call Jane" };
    assert.equal(draftReaction(reverted, "Call Jane edited", "Call Jane"), "restore");
    assert.equal(draftReaction(reverted, "Call Jane", "Call Jane"), "clear");
    assert.equal(draftReaction(reverted, "Call Jane later", "Call Jane"), "ignore");
    const savedElsewhere = { kept: false, draft: "Call Jane edited", saved: "Call Jane edited" };
    assert.equal(draftReaction(savedElsewhere, "Call Jane edited", "Call Jane"), "clear");
    assert.equal(draftReaction(savedElsewhere, "Call Jane later", "Call Jane"), "ignore");
  });

  it("shows only the newest reminder alert, with a count of the rest", () => {
    assert.deepEqual(shownAlert([]), { alert: null, more: 0 });
    assert.deepEqual(shownAlert(["a"]), { alert: "a", more: 0 });
    assert.deepEqual(shownAlert(["a", "b", "c"]), { alert: "c", more: 2 });
  });

  it("hides reminder alerts only while the on-screen keyboard takes up the screen", () => {
    assert.equal(keyboardUp(844, 844, true), false);
    assert.equal(keyboardUp(844, 500, true), true);
    assert.equal(keyboardUp(844, 500, false), false);
    assert.equal(keyboardUp(900, 860, true), false);
  });

  it("measures the screen without the keyboard only while nothing is being typed, and again after rotating", () => {
    const start = { width: 390, height: 844 };
    assert.deepEqual(restingView(start, { width: 390, height: 500, layoutHeight: 844, typing: true }), start);
    assert.deepEqual(restingView(start, { width: 390, height: 760, layoutHeight: 760, typing: false }), { width: 390, height: 760 });
    assert.deepEqual(restingView(start, { width: 844, height: 200, layoutHeight: 390, typing: true }), { width: 844, height: 390 });
  });

  it("announces a reminder again after the keyboard only when a different one is waiting", () => {
    assert.equal(alertRenderKey("a", true, "a"), "a");
    assert.equal(alertRenderKey("b", true, "a"), "b:waiting");
    assert.equal(alertRenderKey("b", false, "a"), "b");
  });

  it("knows which focused elements take typing", () => {
    assert.equal(typingInto(null), false);
    assert.equal(typingInto({ tagName: "TEXTAREA" }), true);
    assert.equal(typingInto({ tagName: "TEXTAREA", readOnly: true }), false);
    assert.equal(typingInto({ tagName: "INPUT", type: "text" }), true);
    assert.equal(typingInto({ tagName: "INPUT", type: "search" }), true);
    assert.equal(typingInto({ tagName: "INPUT", type: "checkbox" }), false);
    assert.equal(typingInto({ tagName: "INPUT", type: "text", disabled: true }), false);
    assert.equal(typingInto({ tagName: "DIV", isContentEditable: true }), true);
    assert.equal(typingInto({ tagName: "BUTTON" }), false);
    assert.equal(typingInto({ tagName: "IFRAME" }), true);
  });

  it("records the saved value on every dropped draft, even in a view that is mid-edit", () => {
    const savedElsewhere = { kept: false, draft: "Call Jane edited", saved: "Call Jane edited" };
    assert.deepEqual(applyDraftNews(savedElsewhere, "Call Jane later", "Call Jane"), { sent: "Call Jane edited", show: null, error: null });
    assert.deepEqual(applyDraftNews(savedElsewhere, "Call Jane edited", "Call Jane"), { sent: "Call Jane edited", show: null, error: "clear" });
    const reverted = { kept: false, draft: "Call Jane edited", saved: "Call Jane" };
    assert.deepEqual(applyDraftNews(reverted, "Call Jane edited", "Call Jane"), { sent: "Call Jane", show: "Call Jane", error: "clear" });
    const kept = { kept: true, draft: "Call Jane edited", saved: "Call Jane" };
    assert.deepEqual(applyDraftNews(kept, "Call Jane", "Call Jane"), { sent: "Call Jane", show: "Call Jane edited", error: "fail" });
    assert.deepEqual(applyDraftNews(kept, "Call Jane later", "Call Jane"), { sent: "Call Jane", show: null, error: null });
  });

  it("tells every other view of a task about a kept or dropped draft, never the view that raised it", () => {
    const store = taskDrafts();
    const views = new Map<string, { local: string; sent: string; error: boolean; heard: number }>();
    const watcher = (name: string) => {
      const view = { local: "Call Jane", sent: "Call Jane", error: false, heard: 0 };
      views.set(name, view);
      const listen = (change: DraftChange) => {
        if (change.id !== "t1") return;
        view.heard += 1;
        const next = applyDraftNews(change, view.local, view.sent);
        view.sent = next.sent;
        if (next.show !== null) view.local = next.show;
        if (next.error) view.error = next.error === "fail";
      };
      return listen;
    };
    const panel = watcher("panel");
    const row = watcher("row");
    const stopPanel = store.watch(panel);
    store.watch(row);
    views.get("panel")!.local = "Call Jane edited";
    store.keep(panel, "t1", "title", "Call Jane edited", "Call Jane");
    assert.equal(views.get("panel")!.heard, 0);
    assert.deepEqual(views.get("row"), { local: "Call Jane edited", sent: "Call Jane", error: true, heard: 1 });
    assert.deepEqual(store.get("t1"), { title: "Call Jane edited" });
    views.get("panel")!.local = "Call Jane";
    store.drop(panel, "t1", "title", "Call Jane");
    assert.deepEqual(views.get("row"), { local: "Call Jane", sent: "Call Jane", error: false, heard: 2 });
    assert.equal(store.get("t1"), undefined);
    store.drop(panel, "t1", "title", "Call Jane");
    assert.equal(views.get("row")!.heard, 2);
    stopPanel();
    store.keep(row, "t1", "text", "Notes", "");
    assert.equal(views.get("panel")!.heard, 0);
  });

  it("puts the saved title back when the title is emptied, and saves only real changes", () => {
    assert.deepEqual(draftCommit("title", "   ", "Call Jane"), { save: false, value: "Call Jane" });
    assert.deepEqual(draftCommit("title", " Call Jane ", "Call Jane"), { save: false, value: "Call Jane" });
    assert.deepEqual(draftCommit("title", "Call Jane edited", "Call Jane"), { save: true, value: "Call Jane edited" });
    assert.deepEqual(draftCommit("text", "", "Notes"), { save: true, value: "" });
    assert.deepEqual(draftCommit("text", "", ""), { save: false, value: "" });
  });

  it("treats tasks as still open when the follow-up check fails, so they show again", async () => {
    const ids = ["a", "b"];
    assert.deepEqual(await stillOpenIds(ids, async () => Promise.reject(new Error("offline"))), ids);
    assert.deepEqual(await stillOpenIds(ids, async () => ({ error: "Couldn't check the tasks. Try again." }) as { open?: string[] }), ids);
    assert.deepEqual(await stillOpenIds(ids, async () => ({ open: ["b"] })), ["b"]);
    assert.deepEqual(await stillOpenIds(ids, async () => ({ open: [] })), []);
  });

  it("tells a missing or hidden task apart from a failed lookup when checking what is still open", () => {
    assert.equal(missingOrFailed(new CrmError("not_found", "Couldn't find that task. Try again.", 404)), null);
    assert.equal(missingOrFailed(new CrmError("forbidden", "You're not in that workspace.", 403)), null);
    assert.equal(missingOrFailed(new CrmError("unavailable", "Down", 503)), undefined);
    assert.equal(missingOrFailed(new Error("connect ECONNREFUSED")), undefined);
  });

  it("keeps the Calendar panel open on a date-only task being reopened", () => {
    const kept = { id: "t1" };
    assert.equal(panelTaskFor("t1", null, kept, () => false), null);
    assert.equal(panelTaskFor("t1", null, kept, (id) => id === "t1"), kept);
    assert.equal(panelTaskFor("t2", null, kept, () => true), null);
    const listed = { id: "t1" };
    assert.equal(panelTaskFor("t1", listed, kept, () => false), listed);
  });

  it("either reads a title from the review corpus with confidence and gets it right, or hands the whole text to the AI", () => {
    const nows: Record<string, string> = {
      monAM: "2026-11-16T09:15:00Z",
      friPM: "2026-11-20T18:30:00Z",
      sunNight: "2026-11-22T23:30:00Z",
      satBeforeSpring: "2027-03-27T20:00:00Z",
      sunSpring: "2027-03-28T00:30:00Z",
      satBeforeAutumn: "2026-10-24T19:00:00Z",
      sunAutumn: "2026-10-25T00:30:00Z",
    };
    const fixtures = path.join(import.meta.dirname, "fixtures");
    const titles = ["task-pad-titles.txt", "task-pad-titles-2.txt"].flatMap((file) => readFileSync(path.join(fixtures, file), "utf8").split("\n")).filter(Boolean);
    const confident = JSON.parse(readFileSync(path.join(fixtures, "task-pad-confident.json"), "utf8")) as Record<string, Record<string, string>>;
    assert.ok(titles.length >= 389);
    for (const [moment, iso] of Object.entries(nows)) {
      for (const text of titles) {
        const parsed = parseTaskText(text, new Date(iso));
        const label = `${moment}: ${text}`;
        if (parsed.unsure) {
          assert.equal(parsed.title, text.replace(/\s+/g, " ").trim(), label);
          continue;
        }
        assert.equal([parsed.due ?? "-", parsed.durationMinutes ?? "-", parsed.remindMinutes ?? "-", parsed.title].join(" | "), confident[text]?.[moment], label);
      }
    }
  });

  it("reads a weekday as a date only when it clearly is one, and otherwise hands the whole text to the AI", () => {
    const monday = "2026-11-16T10:30:00Z";
    const asked = "asked";
    const cases: [string, string, [string, string | null] | typeof asked][] = [
      ["Call Jane Monday 3pm", monday, ["Call Jane", "2026-11-16T15:00"]],
      ["Call Jane this Monday at 3pm", monday, ["Call Jane", "2026-11-16T15:00"]],
      ["Call Jane mon 15:00", monday, ["Call Jane", "2026-11-16T15:00"]],
      ["Call Jane Monday 3pm", "2026-11-16T16:00:00Z", ["Call Jane", "2026-11-23T15:00"]],
      ["Call Jane Monday 10am", monday, ["Call Jane", "2026-11-23T10:00"]],
      ["Call Jane next Monday 3pm", monday, ["Call Jane", "2026-11-23T15:00"]],
      ["Call Jane Monday", monday, asked],
      ["Call Jane Tuesday 3pm", monday, ["Call Jane", "2026-11-17T15:00"]],
      ["Call Jane Sunday 1:30am", "2027-03-27T12:00:00Z", asked],
      ["Call Jane Sunday 2:30am", "2027-03-27T12:00:00Z", ["Call Jane", "2027-03-28T02:30"]],
      ["Call Sam sat 3pm", "2026-11-21T09:00:00Z", ["Call Sam", "2026-11-21T15:00"]],
      ["Call Sam next sat 3pm", "2026-11-21T09:00:00Z", ["Call Sam", "2026-11-28T15:00"]],
      ["Call Sam this Monday", monday, ["Call Sam", "2026-11-16"]],
      ["Call Sam on Friday", monday, ["Call Sam", "2026-11-20"]],
      ["Call Sam by Friday", monday, ["Call Sam", "2026-11-20"]],
      ["Call Jane next week Monday 3pm", monday, ["Call Jane", "2026-11-23T15:00"]],
      ["Call Jane Monday next week 3pm", monday, ["Call Jane", "2026-11-23T15:00"]],
      ["Call Jane next week sat", monday, ["Call Jane", "2026-11-28"]],
      ["Call Jane Monday week 3pm", monday, asked],
      ["Call Jane Monday 30 Nov 3pm", monday, ["Call Jane", "2026-11-30T15:00"]],
      ["Call Sam in 2 weeks", monday, ["Call Sam", "2026-11-30"]],
      ["Call Sam in 2 weeks Friday", monday, ["Call Sam", "2026-12-04"]],
      ["Call Sam Friday in 2 weeks", monday, ["Call Sam", "2026-12-04"]],
      ["Call Jane Monday in 2 weeks 3pm", monday, asked],
      ["Call Sam Monday in 2 weeks", "2026-11-22T10:30:00Z", ["Call Sam", "2026-12-07"]],
      ["Call Sam in 2 weeks Monday", "2026-11-22T10:30:00Z", ["Call Sam", "2026-12-07"]],
      ["Call Jane tomorrow 3pm re Monday meeting", monday, asked],
      ["Send Monday report Tuesday 3pm", monday, asked],
      ["Call Jane 20 Nov re Monday meeting", monday, asked],
      ["Send Friday report next week", monday, asked],
      ["Chase Friday Media next week", monday, asked],
      ["Call Sam next week re Friday Media", monday, asked],
      ["Call Sam in 2 hours re Monday report", monday, asked],
      ["Call Sam Tuesday 23 Nov", monday, asked],
      ["Call Sam Mon 16 Nov 3pm", "2026-11-18T10:30:00Z", asked],
      ["Call Sam today Friday 5pm", "2026-11-14T10:30:00Z", asked],
      ["Call Sam tomorrow Friday", "2026-11-14T10:30:00Z", asked],
      ["Call Sam tomorrow Sunday", "2026-11-14T10:30:00Z", ["Call Sam", "2026-11-15"]],
      ["Black Friday campaign plan", monday, asked],
      ["Chase Monday.com invoice", monday, asked],
      ["Chase Friday Media invoice", monday, asked],
      ["Call Monday re Friday Media", monday, asked],
      ["Call Sam Monday night", monday, ["Call Sam", "2026-11-16T19:00"]],
      ["Dinner Monday night 8", monday, ["Dinner", "2026-11-16T20:00"]],
      ["Drinks Friday night 9", monday, ["Drinks", "2026-11-20T21:00"]],
      ["Call client tomorrow night 8", monday, ["Call client", "2026-11-17T20:00"]],
      ["Call Sam lunchtime", monday, asked],
      ["Call Sam half past 3", monday, asked],
      ["Call Sam before 3pm", monday, asked],
      ["Night shift rota", monday, asked],
      ["Send notes from Monday's call", monday, asked],
      ["Friday", monday, asked],
      ["Monday 9am", monday, asked],
    ];
    for (const [text, at, expected] of cases) {
      const parsed = parseTaskText(text, new Date(at));
      if (expected === asked) {
        assert.deepEqual({ unsure: parsed.unsure, title: parsed.title }, { unsure: true, title: text }, text);
      } else {
        assert.deepEqual({ unsure: parsed.unsure, title: parsed.title, due: parsed.due }, { unsure: false, title: expected[0], due: expected[1] }, text);
      }
    }
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
    const repeat = new KeyboardEventLike("keydown", "Escape");
    fake.dispatchEvent(repeat);
    assert.equal(repeat.defaultPrevented, true);
    fake.dispatchEvent(new KeyboardEventLike("keyup", "Escape"));
    const fresh = new KeyboardEventLike("keydown", "Escape");
    fake.dispatchEvent(fresh);
    assert.equal(fresh.defaultPrevented, false);
  });

  it("stops swallowing clicks when the pointer is cancelled after an Escape", () => {
    const { seen, handlers } = record();
    startPointerGesture({ pointerType: "mouse", pointerId: 1, clientX: 10, clientY: 10 }, handlers);
    fake.dispatchEvent(pointer("pointermove", { clientX: 40, clientY: 10 }));
    fake.dispatchEvent(new KeyboardEventLike("keydown", "Escape"));
    fake.dispatchEvent(new KeyboardEventLike("keyup", "Escape"));
    fake.dispatchEvent(pointer("pointercancel"));
    const click = new Event("click", { cancelable: true });
    fake.dispatchEvent(click);
    assert.equal(click.defaultPrevented, false);
    assert.deepEqual(seen, ["start", "end:cancel"]);
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
