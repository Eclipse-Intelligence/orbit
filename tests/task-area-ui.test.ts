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
import { acceptAiReading as acceptWithMarks, AI_SETTLE_MS, backspaceKeeps, confirmedReading, keptAfterTyping, keptReading, padReading, parseTaskText, readingToSave, type KeptReading, type PadAiParse, type PadMark, type PadReading } from "@/lib/task-pad";

const plain = (reading: PadAiParse) => ({ title: reading.title, due: reading.due, remindMinutes: reading.remindMinutes, durationMinutes: reading.durationMinutes });
const acceptAiReading = (...args: Parameters<typeof acceptWithMarks>) => plain(acceptWithMarks(...args));
const fixtures = path.join(import.meta.dirname, "fixtures");
const corpusTitles = () =>
  ["task-pad-titles.txt", "task-pad-titles-2.txt", "task-pad-titles-3.txt", "task-pad-titles-4.txt", "task-pad-titles-5.txt"]
    .flatMap((file) => readFileSync(path.join(fixtures, file), "utf8").split("\n"))
    .filter(Boolean);
const CORPUS_NOWS: Record<string, string> = {
  monAM: "2026-11-16T09:15:00Z",
  friPM: "2026-11-20T18:30:00Z",
  sunNight: "2026-11-22T23:30:00Z",
  satBeforeSpring: "2027-03-27T20:00:00Z",
  sunSpring: "2027-03-28T00:30:00Z",
  satBeforeAutumn: "2026-10-24T19:00:00Z",
  sunAutumn: "2026-10-25T00:30:00Z",
  sat14: "2026-11-14T10:30:00Z",
  wed18: "2026-11-18T14:00:00Z",
  dec31: "2026-12-31T16:00:00Z",
};
const collapse = (text: string) => text.replace(/\s+/g, " ").trim();
function withoutMarks(text: string, marks: PadMark[]) {
  let result = "";
  let last = 0;
  for (const mark of [...marks].sort((a, b) => a.start - b.start)) {
    const piece = text.slice(last, mark.start).trim();
    if (piece) result = !result ? piece : /^[,.;:!?]/.test(piece) ? result + piece : `${result} ${piece}`;
    last = mark.end;
  }
  const rest = text.slice(last).trim();
  if (rest) result = !result ? rest : /^[,.;:!?]/.test(rest) ? result + rest : `${result} ${rest}`;
  return collapse(result);
}
function holdsTheRule(text: string, reading: PadReading, keep: (key: string) => PadReading, label: string) {
  if (!reading.due) {
    assert.equal(reading.title, collapse(text), `${label}: no date, so the title is the text as typed`);
    assert.deepEqual(reading.marks, [], label);
    return;
  }
  assert.ok(reading.marks.length > 0 && reading.key, `${label}: a date is only saved with words lit up`);
  assert.equal(reading.title, withoutMarks(text, reading.marks), `${label}: the title is the text minus the lit words`);
  const kept = keep(reading.key);
  assert.deepEqual({ title: kept.title, due: kept.due, marks: kept.marks }, { title: collapse(text), due: null, marks: [] }, `${label}: Keep as text saves the text as typed`);
}

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
    const titles = corpusTitles();
    const confident = JSON.parse(readFileSync(path.join(fixtures, "task-pad-confident.json"), "utf8")) as Record<string, Record<string, string>>;
    assert.ok(titles.length >= 930);
    for (const [moment, iso] of Object.entries(CORPUS_NOWS)) {
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

  it("never saves an unsure guess the AI hasn't confirmed, and lets an AI null clear it", () => {
    const now = new Date("2026-11-16T09:15:00Z");
    const unsure = parseTaskText("Call Sam at 3", now);
    assert.equal(unsure.unsure, true);
    assert.ok(unsure.due);
    assert.deepEqual(plain(confirmedReading(unsure, null)), { title: "Call Sam at 3", due: null, remindMinutes: null, durationMinutes: null });
    assert.deepEqual(plain(confirmedReading(unsure, acceptWithMarks("Call Sam at 3", { phrases: [], due: null, remindMinutes: null, durationMinutes: null }, now))), { title: "Call Sam at 3", due: null, remindMinutes: null, durationMinutes: null });
    assert.deepEqual(plain(confirmedReading(unsure, acceptWithMarks("Call Sam at 3", { phrases: ["at 3"], due: "2026-11-16T15:00", remindMinutes: null, durationMinutes: null }, now))), { title: "Call Sam", due: "2026-11-16T15:00", remindMinutes: null, durationMinutes: null });
    const sure = parseTaskText("Call Sam tomorrow 3pm", now);
    assert.deepEqual(plain(confirmedReading(sure, null)), { title: "Call Sam", due: "2026-11-17T15:00", remindMinutes: null, durationMinutes: null });
  });

  it("lights up the glue words and punctuation that will be removed with the date", () => {
    const now = new Date("2026-11-16T09:15:00Z");
    const lit = (text: string) => {
      const reading = padReading(text, parseTaskText(text, now), null, []);
      return [reading.title, reading.marks.map((mark) => text.slice(mark.start, mark.end))];
    };
    assert.deepEqual(lit("Call Bob and tomorrow"), ["Call Bob", ["and tomorrow"]]);
    assert.deepEqual(lit("Call Bob tomorrow, and remind me 15 mins before"), ["Call Bob", ["tomorrow", ", and remind me 15 mins before"]]);
    assert.deepEqual(lit("Send deck tomorrow."), ["Send deck", ["tomorrow."]]);
    assert.deepEqual(lit("Call Bob, Friday"), ["Call Bob", [", Friday"]]);
    assert.deepEqual(lit("Call Bob tomorrow. Then email Jo"), ["Call Bob. Then email Jo", ["tomorrow"]]);
    const asked = parseTaskText("Call Bob, Friday?", now);
    assert.deepEqual({ unsure: asked.unsure, title: asked.title }, { unsure: true, title: "Call Bob, Friday?" });
  });

  it("keeps the AI's highlight in step with the text as typed, leading spaces and line breaks included", () => {
    const now = new Date("2026-11-16T09:15:00Z");
    for (const typed of ["  Call Sam at 3", "\nCall Sam at 3", " \n Call Sam at 3"]) {
      const reading = acceptWithMarks(typed, { phrases: ["at 3"], due: "2026-11-16T15:00", remindMinutes: null, durationMinutes: null }, now);
      assert.deepEqual(reading.marks.map((mark) => typed.slice(mark.start, mark.end)), ["at 3"], JSON.stringify(typed));
      assert.equal(reading.title, "Call Sam");
    }
  });

  it("shows what was read so it can be kept as text, for the fast reader and the AI alike", () => {
    const now = new Date("2026-11-16T09:15:00Z");
    const typed = "Call Sam tomorrow 3pm";
    const sure = parseTaskText(typed, now);
    const shown = padReading(typed, sure, null, []);
    assert.equal(shown.phrase, "tomorrow 3pm");
    assert.deepEqual(shown.marks.map((mark) => typed.slice(mark.start, mark.end)), ["tomorrow", "3pm"]);
    assert.deepEqual({ title: shown.title, due: shown.due }, { title: "Call Sam", due: "2026-11-17T15:00" });
    const kept = padReading(typed, sure, null, [shown.key]);
    assert.deepEqual({ title: kept.title, due: kept.due, marks: kept.marks, phrase: kept.phrase }, { title: typed, due: null, marks: [], phrase: "" });

    const led = "Send deck by Friday";
    assert.deepEqual(padReading(led, parseTaskText(led, now), null, []).phrase, "by Friday", "the highlight covers every word that will be removed");

    const unsureText = "Call Sam at 3";
    const unsure = parseTaskText(unsureText, now);
    assert.deepEqual(padReading(unsureText, unsure, null, []).marks, [], "nothing lights up until the AI confirms");
    const answer = acceptWithMarks(unsureText, { phrases: ["at 3"], due: "2026-11-16T15:00", remindMinutes: null, durationMinutes: null }, now);
    const confirmed = padReading(unsureText, unsure, answer, []);
    assert.deepEqual(confirmed.marks.map((mark) => unsureText.slice(mark.start, mark.end)), ["at 3"]);
    assert.equal(confirmed.phrase, "at 3");
    assert.deepEqual(padReading(unsureText, unsure, answer, [confirmed.key]).due, null, "the AI's phrase can be kept as text too");
    assert.deepEqual(acceptWithMarks("  Call Sam at 3", { phrases: ["at 3"], due: "2026-11-16T15:00", remindMinutes: null, durationMinutes: null }, now).marks, [{ start: 11, end: 15, kind: "when" }]);

    const marks = shown.marks;
    assert.equal(backspaceKeeps(marks, typed.length, typed.length), true, "Backspace right after the phrase keeps it");
    assert.equal(backspaceKeeps(marks, 8, 8), false);
    assert.equal(backspaceKeeps(marks, typed.length - 3, typed.length), false, "not with a selection");
  });

  it("saves on Enter only a reading that has been on screen, and the text as typed otherwise", () => {
    const now = new Date("2026-11-16T09:15:00Z");
    const pending = "Call Sam at 3";
    const parsed = parseTaskText(pending, now);
    const asTyped = padReading(pending, parsed, null, []);
    assert.deepEqual(plain(asTyped), { title: pending, due: null, remindMinutes: null, durationMinutes: null }, "an unconfirmed reading saves the text as typed");
    const answer = acceptWithMarks(pending, { phrases: ["at 3"], due: "2026-11-16T15:00", remindMinutes: null, durationMinutes: null }, now);
    const shown = padReading(pending, parsed, answer, []);
    assert.equal(readingToSave(shown, asTyped, null, 1000), shown, "the fast reader's reading is on screen as soon as it is typed");
    assert.equal(readingToSave(shown, asTyped, { shownAt: null }, 1000), asTyped, "an AI answer that hasn't rendered is never saved");
    assert.equal(readingToSave(shown, asTyped, { shownAt: 1000 }, 1000 + AI_SETTLE_MS - 1), asTyped, "an AI answer that only just rendered is not saved");
    assert.equal(readingToSave(shown, asTyped, { shownAt: 1000 }, 1000 + AI_SETTLE_MS), shown, "an AI answer that has been on screen is saved");

    const typed = "Call Sam tomorrow 3pm";
    const sure = parseTaskText(typed, now);
    const read = padReading(typed, sure, null, []);
    assert.equal(padReading(typed, sure, null, [read.key]).title, typed, "changing the Due chip by hand keeps the words, like Keep as text");
  });

  it("removes exactly the lit words, and Keep as text keeps exactly the typed text, across the corpus and the seam cases", () => {
    for (const [moment, iso] of Object.entries(CORPUS_NOWS)) {
      const now = new Date(iso);
      for (const text of corpusTitles()) {
        const parsed = parseTaskText(text, now);
        holdsTheRule(text, padReading(text, parsed, null, []), (key) => padReading(text, parsed, null, [key]), `${moment}: ${text}`);
      }
    }
    const seams = JSON.parse(readFileSync(path.join(fixtures, "task-pad-seams.json"), "utf8")) as { now: string; fast: string[]; ai: { text: string; phrases: string[]; due: string }[] };
    const now = new Date(seams.now);
    for (const text of seams.fast) {
      const parsed = parseTaskText(text, now);
      holdsTheRule(text, padReading(text, parsed, null, []), (key) => padReading(text, parsed, null, [key]), text);
    }
    for (const { text, phrases, due } of seams.ai) {
      const parsed = parseTaskText(text, now);
      const answer = acceptWithMarks(text, { phrases, due, remindMinutes: phrases.length > 1 ? 15 : null, durationMinutes: null }, now);
      holdsTheRule(text, padReading(text, parsed, answer, []), (key) => padReading(text, parsed, answer, [key]), `AI: ${text}`);
    }
    const lit = (text: string) => {
      const reading = padReading(text, parseTaskText(text, now), null, []);
      return { title: reading.title, lit: reading.marks.map((mark) => text.slice(mark.start, mark.end)) };
    };
    assert.deepEqual(lit("Call Bob, tomorrow"), { title: "Call Bob", lit: [", tomorrow"] });
    assert.deepEqual(lit("Call Bob tomorrow."), { title: "Call Bob", lit: ["tomorrow."] });
    assert.deepEqual(lit("Tomorrow, call Bob"), { title: "call Bob", lit: ["Tomorrow,"] });
    assert.deepEqual(lit("Call Bob, tomorrow, about pricing"), { title: "Call Bob, about pricing", lit: ["tomorrow,"] });
    assert.deepEqual(lit("Call Bob tomorrow, and"), { title: "Call Bob", lit: ["tomorrow, and"] });
  });

  it("keeps a multi-piece reading as text by the reading itself, and forgets it only when that reading goes", () => {
    const now = new Date(CORPUS_NOWS.monAM);
    for (const text of ["Call Bob tomorrow, 3pm", "Call Bob tomorrow, and remind me 15 mins before", "Call Bob Friday about the deck 3pm", "Call Bob tomorrow\n3pm", "Call Bob tomorrow  3pm"]) {
      const parsed = parseTaskText(text, now);
      const shown = padReading(text, parsed, null, []);
      assert.ok(shown.due && shown.key, text);
      const kept = padReading(text, parsed, null, [shown.key]);
      assert.deepEqual({ title: kept.title, due: kept.due }, { title: collapse(text), due: null }, text);
      const edited = `Ring ${text.slice(5)}`;
      assert.equal(padReading(edited, parseTaskText(edited, now), null, []).key, shown.key, `${text}: editing other words keeps the same reading`);
      const longer = `${text} on 3 Dec`;
      assert.notEqual(padReading(longer, parseTaskText(longer, now), null, []).key, shown.key, `${text}: a different reading is not kept`);
    }
    const typed = "Call Sam at 3 and remind me 15 mins before";
    const parsed = parseTaskText(typed, now);
    const answer = acceptWithMarks(typed, { phrases: ["at 3", "remind me 15 mins before"], due: "2026-11-16T15:00", remindMinutes: 15, durationMinutes: null }, now);
    const shown = padReading(typed, parsed, answer, []);
    assert.deepEqual(shown.marks.map((mark) => typed.slice(mark.start, mark.end)), ["at 3 and", "remind me 15 mins before"]);
    assert.equal(shown.title, "Call Sam");
    const kept = padReading(typed, parsed, answer, [shown.key]);
    assert.deepEqual({ title: kept.title, due: kept.due }, { title: typed, due: null });
    assert.equal(padReading(typed, parsed, null, []).key, "", "without the AI's answer there is no reading to keep");
  });

  it("keeps a kept reading as text while you type on, one key at a time, and drops it only when its words go", () => {
    const now = new Date(CORPUS_NOWS.monAM);
    const typeOn = (start: string, more: string, ai: (text: string) => PadAiParse | null = () => null) => {
      const first = padReading(start, parseTaskText(start, now), ai(start), []);
      assert.ok(first.key, start);
      let kept: KeptReading[] = [keptReading(start, first.marks)];
      for (let index = 1; index <= more.length; index += 1) {
        const text = start + more.slice(0, index);
        const parsed = parseTaskText(text, now);
        kept = keptAfterTyping(kept, text, padReading(text, parsed, ai(text), []));
        assert.equal(kept.length, 1, `${JSON.stringify(text)}: still kept`);
        const shown = padReading(text, parsed, ai(text), kept.map((entry) => entry.key));
        assert.deepEqual({ title: shown.title, due: shown.due }, { title: collapse(text), due: null }, JSON.stringify(text));
      }
      return kept;
    };
    typeOn("Call Bob tomorrow", " about pricing");
    typeOn("Call Bob tomorrow", " about 3 things");
    typeOn("Call Bob tomorrow", " at the office");
    typeOn("Call Bob tomorrow", " re the 2 decks");
    typeOn("Call Bob tomorrow 3pm", " in room 4 please");
    typeOn("Call Bob, tomorrow", " about pricing");
    typeOn("Call Bob on  Friday", " about pricing");
    typeOn("Call Bob at\n3pm", " about pricing");
    typeOn("Call Bob tomorrow  at 3pm", " about pricing");
    typeOn("Call Bob tomorrow\tat 3pm", " about pricing");
    for (const spaced of ["Call Bob next  Friday", "Call Bob next\tFriday", "Call Bob next\nFriday"]) {
      const nextFriday = (text: string) => (text === spaced || text === `${spaced} about pricing` ? acceptWithMarks(text, { phrases: ["next Friday"], due: "2026-11-27", remindMinutes: null, durationMinutes: null }, now) : null);
      const read = nextFriday(spaced);
      assert.equal(read?.due, "2026-11-27", `${JSON.stringify(spaced)}: the AI's phrase matches across any spacing`);
      typeOn(spaced, " about pricing", nextFriday);
    }
    const answers = new Map([["Call Sam at 3", ["at 3"]], ["Call Sam at 3 about pricing", ["at 3"]]]);
    typeOn("Call Sam at 3", " about pricing", (text) => {
      const phrases = answers.get(text);
      return phrases ? acceptWithMarks(text, { phrases, due: "2026-11-16T15:00", remindMinutes: null, durationMinutes: null }, now) : null;
    });

    const start = "Call Bob tomorrow";
    const kept = [keptReading(start, padReading(start, parseTaskText(start, now), null, []).marks)];
    const gone = "Call Bob tomor";
    assert.deepEqual(keptAfterTyping(kept, gone, padReading(gone, parseTaskText(gone, now), null, [])), [], "deleting the kept words forgets them");
    const moved = "tomorrow call Bob";
    assert.equal(keptAfterTyping(kept, moved, padReading(moved, parseTaskText(moved, now), null, [])).length, 1, "the kept words can move");
    const newer = "Call Bob tomorrow 3pm";
    assert.deepEqual(keptAfterTyping(kept, newer, padReading(newer, parseTaskText(newer, now), null, [])), [], "a different reading of the same words shows instead");
  });

  it("never changes the letters you typed", () => {
    const now = new Date(CORPUS_NOWS.monAM);
    for (const [typed, title] of [["call bob tomorrow", "call bob"], ["Tomorrow, call Bob", "call Bob"], ["iPhone repair friday", "iPhone repair"], ["CALL BOB TOMORROW", "CALL BOB"]]) {
      assert.equal(padReading(typed, parseTaskText(typed, now), null, []).title, title, typed);
    }
    assert.equal(acceptWithMarks("ring jane at 3", { phrases: ["at 3"], due: "2026-11-16T15:00", remindMinutes: null, durationMinutes: null }, now).title, "ring jane");
  });

  it("only takes the AI's date when its phrase is really in the text, holds only date words, and the date is real and near", () => {
    const now = new Date("2026-11-16T09:15:00Z");
    const typed = "ring jane re the Q3 deck tmrw afternoon";
    const kept = { title: typed, due: null, remindMinutes: null, durationMinutes: null };
    const read = (phrases: string[], due: string | null, remindMinutes: number | null = null, durationMinutes: number | null = null) =>
      acceptAiReading(typed, { phrases, due, remindMinutes, durationMinutes }, now);
    assert.deepEqual(read(["tmrw afternoon"], "2026-11-17T14:00"), { title: "ring jane re the Q3 deck", due: "2026-11-17T14:00", remindMinutes: null, durationMinutes: null });
    assert.deepEqual(read(["tomorrow afternoon"], "2026-11-17T14:00"), kept, "the phrase must be typed");
    assert.deepEqual(read([], "2026-11-17"), kept, "a due needs its phrase");
    assert.deepEqual(read(["tmrw"], "2026-11-31"), kept, "not a calendar date");
    assert.deepEqual(read(["tmrw afternoon"], "2026-11-17T24:10"), kept, "not a clock time");
    assert.deepEqual(read(["tmrw"], "2026-11-15"), kept, "in the past");
    assert.deepEqual(read(["afternoon"], "2026-11-16T08:00"), kept, "earlier today");
    assert.deepEqual(read(["tmrw"], "2028-12-01"), kept, "more than two years out");
    assert.deepEqual(read(["tmrw"], "2026-11-17T10:00"), kept, "a time with no time words in the phrase");
    assert.deepEqual(read(["tmrw afternoon"], "2027-03-28T01:30"), kept, "a clock time that doesn't exist in London");
    assert.deepEqual(read(["tmrw afternoon"], "2026-11-17T14:00", 15, 30), { title: "ring jane re the Q3 deck", due: "2026-11-17T14:00", remindMinutes: null, durationMinutes: null }, "no reminder or length unless the text asks for one");

    const check = (text: string, phrases: string[], due: string) => acceptAiReading(text, { phrases, due, remindMinutes: null, durationMinutes: null }, now);
    const untouched = (text: string) => ({ title: text, due: null, remindMinutes: null, durationMinutes: null });
    assert.deepEqual(check("Email Tom tomorrow", ["tom"], "2026-11-17"), untouched("Email Tom tomorrow"), "part of a word");
    assert.deepEqual(check("Call Sam tomorrow", ["a"], "2026-11-17"), untouched("Call Sam tomorrow"), "a letter");
    assert.deepEqual(check("Call Jo tomorrow tomorrow", ["tomorrow"], "2026-11-17"), untouched("Call Jo tomorrow tomorrow"), "a phrase that appears twice");
    assert.deepEqual(check("Call Friday Media tomorrow", ["Friday Media"], "2026-11-20"), untouched("Call Friday Media tomorrow"));
    assert.deepEqual(check("ring jane tomorrow", ["ring jane"], "2026-11-17"), untouched("ring jane tomorrow"));
    assert.deepEqual(check("Call Sam tomorrow", ["Sam", "tomorrow"], "2026-11-17"), untouched("Call Sam tomorrow"));
    assert.deepEqual(check("Ping Raj about pricing tomorrow", ["about pricing tomorrow"], "2026-11-17"), untouched("Ping Raj about pricing tomorrow"));
    assert.deepEqual(check("Call April May on 3 June", ["April May on 3 June"], "2027-06-03"), untouched("Call April May on 3 June"));
    assert.deepEqual(check("Call April May on 3 June", ["on 3 June"], "2027-06-03"), { title: "Call April May", due: "2027-06-03", remindMinutes: null, durationMinutes: null });
    assert.deepEqual(check("Pay £300 tomorrow", ["£300 tomorrow"], "2026-11-17"), untouched("Pay £300 tomorrow"));
    assert.deepEqual(check("Send the Monday report by Friday", ["the Monday report by Friday"], "2026-11-20"), untouched("Send the Monday report by Friday"));
    assert.deepEqual(check("Call Jo tmrw and email sam", ["tmrw and email sam"], "2026-11-17"), untouched("Call Jo tmrw and email sam"));

    const friday = "2026-11-20";
    assert.deepEqual(check("Call May about the launch on Friday", ["May", "on Friday"], friday), untouched("Call May about the launch on Friday"), "a bare month");
    assert.deepEqual(check("Late payment notice to Acme on Friday", ["Late", "on Friday"], friday), untouched("Late payment notice to Acme on Friday"));
    assert.deepEqual(check("Early bird tickets go on sale Friday", ["Early", "Friday"], friday), untouched("Early bird tickets go on sale Friday"));
    assert.deepEqual(check("The week in review for Friday", ["The week"], friday), untouched("The week in review for Friday"));
    assert.deepEqual(check("A day in the life post on Monday", ["A day", "on Monday"], "2026-11-23"), untouched("A day in the life post on Monday"));
    assert.deepEqual(check("Half day for Sam on Friday", ["Half day", "on Friday"], friday), untouched("Half day for Sam on Friday"));
    assert.deepEqual(check("Plan the one to one with Sam Friday", ["one to one", "Friday"], friday), untouched("Plan the one to one with Sam Friday"));
    assert.deepEqual(check("Start the day one onboarding on Monday", ["the day one", "on Monday"], "2026-11-23"), untouched("Start the day one onboarding on Monday"));
    assert.deepEqual(check("Tell Sam to log in on Friday", ["in on Friday"], friday), untouched("Tell Sam to log in on Friday"));
    assert.deepEqual(check("Call Sam 1 2 3 Friday", ["1 2 3 Friday"], friday), untouched("Call Sam 1 2 3 Friday"));
    assert.deepEqual(check("Prep [[Friday plan]]", ["Friday"], friday), untouched("Prep [[Friday plan]]"), "never inside a doc link");

    const full = (text: string, phrases: string[], due: string, remindMinutes: number | null = null, durationMinutes: number | null = null) =>
      acceptAiReading(text, { phrases, due, remindMinutes, durationMinutes }, now);
    assert.deepEqual(full("Pay 2.50 tomorrow", ["2.50 tomorrow"], "2026-11-17T14:50"), untouched("Pay 2.50 tomorrow"), "a decimal is not a clock");
    assert.deepEqual(full("Pay £2.50 tomorrow", ["2.50"], "2026-11-17T14:50"), untouched("Pay £2.50 tomorrow"));
    assert.deepEqual(full("Budget 14.50 tomorrow", ["14.50 tomorrow"], "2026-11-17T14:50"), untouched("Budget 14.50 tomorrow"));
    assert.deepEqual(full("Lunch tomorrow at 12:30", ["tomorrow at 12:30"], "2026-11-17T12:30"), { title: "Lunch", due: "2026-11-17T12:30", remindMinutes: null, durationMinutes: null });
    assert.deepEqual(full("Set up reminder tomorrow", ["reminder tomorrow"], "2026-11-17"), untouched("Set up reminder tomorrow"), "a reminder noun is never cut");
    assert.deepEqual(full("Call Sam tomorrow, remind me", ["tomorrow, remind me"], "2026-11-17", 15), untouched("Call Sam tomorrow, remind me"));
    assert.deepEqual(full("Call Sam tomorrow 3pm 1 hour reminder", ["tomorrow 3pm", "1 hour reminder"], "2026-11-17T15:00", 60), { title: "Call Sam", due: "2026-11-17T15:00", remindMinutes: 60, durationMinutes: null });
    assert.deepEqual(full("Holiday tomorrow for 3 days", ["tomorrow", "for 3 days"], "2026-11-17", null, 4320), untouched("Holiday tomorrow for 3 days"), "for N days is never a length");
    assert.deepEqual(full("Call Sam tomorrow 3pm for 30 mins", ["tomorrow 3pm", "for 30 mins"], "2026-11-17T15:00", null, 45), untouched("Call Sam tomorrow 3pm for 30 mins"), "a length must match");
    assert.deepEqual(full("Call Sam tomorrow 3pm for 30 mins", ["tomorrow 3pm", "for 30 mins"], "2026-11-17T15:00", null, 30), { title: "Call Sam", due: "2026-11-17T15:00", remindMinutes: null, durationMinutes: 30 });
    assert.deepEqual(full("Workshop tomorrow 2-4pm", ["tomorrow 2-4pm"], "2026-11-17T15:00", null, 120), untouched("Workshop tomorrow 2-4pm"), "a range's start must be the due time");
    assert.deepEqual(full("Workshop tomorrow 2-4pm", ["tomorrow 2-4pm"], "2026-11-17T14:00", null, 90), untouched("Workshop tomorrow 2-4pm"), "a range's length must match");
    assert.deepEqual(full("Workshop tomorrow 2-4pm", ["tomorrow 2-4pm"], "2026-11-17T14:00", null, 120), { title: "Workshop", due: "2026-11-17T14:00", remindMinutes: null, durationMinutes: 120 });
    assert.deepEqual(full("Renew domain 3 June 2027", ["3 June 2027"], "2028-06-03"), untouched("Renew domain 3 June 2027"), "the year must match");
    assert.deepEqual(full("Renew domain 3 June", ["3 June"], "2028-06-03"), untouched("Renew domain 3 June"), "a day and month is the next one");
    assert.deepEqual(full("Call Sam Friday", ["Friday"], "2026-11-27"), untouched("Call Sam Friday"), "a weekday is the next one");
    assert.deepEqual(full("Call Sam next Friday", ["next Friday"], "2026-11-27"), { title: "Call Sam", due: "2026-11-27", remindMinutes: null, durationMinutes: null });
    assert.deepEqual(full("Call Sam in 2 hours", ["in 2 hours"], "2026-11-16T12:15"), untouched("Call Sam in 2 hours"), "in N hours must add up");
    assert.deepEqual(full("Call Sam in 2 hours", ["in 2 hours"], "2026-11-16T11:15"), { title: "Call Sam", due: "2026-11-16T11:15", remindMinutes: null, durationMinutes: null });
    assert.deepEqual(full("Call Sam in twenty days", ["in twenty days"], "2026-12-06"), { title: "Call Sam", due: "2026-12-06", remindMinutes: null, durationMinutes: null });
    assert.deepEqual(full("Call Sam in twenty days", ["in twenty days"], "2026-12-07"), untouched("Call Sam in twenty days"));
    assert.deepEqual(full("Call Sam tomorrow afternoon", ["tomorrow afternoon"], "2026-11-17T09:00"), untouched("Call Sam tomorrow afternoon"), "afternoon must be in the afternoon");
    assert.deepEqual(full("Call Sam tomorrow at 3 o'clock", ["tomorrow at 3 o'clock"], "2026-11-17T04:00"), untouched("Call Sam tomorrow at 3 o'clock"));
    assert.deepEqual(full("Call Sam next week", ["next week"], "2026-11-30"), untouched("Call Sam next week"), "next week is the coming Monday's week");
    assert.deepEqual(full("Call Sam next week", ["next week"], "2026-11-23"), { title: "Call Sam", due: "2026-11-23", remindMinutes: null, durationMinutes: null });
    assert.deepEqual(check("Tell Sam to log in on Friday", ["on Friday"], friday), untouched("Tell Sam to log in on Friday"), "a cut that would leave a dangling word is dropped");
    assert.deepEqual(check("Tomorrow send NDA", ["Tomorrow"], "2026-11-17"), untouched("Tomorrow send NDA"), "so is a cut at the start that leaves a dangling word");

    assert.deepEqual(check("Call Sam on Friday", ["on Friday"], "2026-11-19"), untouched("Call Sam on Friday"), "the weekday must match");
    assert.deepEqual(check("Call Sam on 3 Dec", ["on 3 Dec"], "2026-12-04"), untouched("Call Sam on 3 Dec"), "the day must match");
    assert.deepEqual(check("Call Sam on 3 Dec", ["on 3 Dec"], "2027-01-03"), untouched("Call Sam on 3 Dec"), "the month must match");
    assert.deepEqual(check("Call Sam tomorrow", ["tomorrow"], "2026-11-18"), untouched("Call Sam tomorrow"), "tomorrow must be tomorrow");
    assert.deepEqual(check("Call Sam tomorrow 3pm", ["tomorrow 3pm"], "2026-11-17T14:00"), untouched("Call Sam tomorrow 3pm"), "the time must match");
    assert.deepEqual(check("Call Sam in 3 days", ["in 3 days"], "2026-11-20"), untouched("Call Sam in 3 days"), "in N days must add up");
    assert.deepEqual(check("Call Sam in 3 days", ["in 3 days"], "2026-11-19"), { title: "Call Sam", due: "2026-11-19", remindMinutes: null, durationMinutes: null });

    const reminded = acceptAiReading("Call Sam tomorrow 3pm, remind me 20 mins before", { phrases: ["tomorrow 3pm", "remind me 20 mins before"], due: "2026-11-17T15:00", remindMinutes: 20, durationMinutes: null }, now);
    assert.deepEqual(reminded, { title: "Call Sam", due: "2026-11-17T15:00", remindMinutes: 15, durationMinutes: null }, "a reminder that was asked for snaps to an option");
    const timed = acceptAiReading("Workshop tomorrow 2-4pm", { phrases: ["tomorrow 2-4pm"], due: "2026-11-17T14:00", remindMinutes: null, durationMinutes: 900 }, now);
    assert.deepEqual(timed, { title: "Workshop", due: "2026-11-17T14:00", remindMinutes: null, durationMinutes: null }, "a duration past the cap is dropped and the date kept");
    const long = `${"Prepare the quarterly board pack with every appendix ".repeat(12)}tomorrow`;
    assert.equal(acceptAiReading(long, { phrases: ["tomorrow"], due: "2026-11-17", remindMinutes: null, durationMinutes: null }, now).title.length, long.length - " tomorrow".length, "a long title is kept whole");
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
      ["Call Sam Monday in 2 weeks", "2026-11-22T10:30:00Z", asked],
      ["Call Sam in 2 weeks Monday", "2026-11-22T10:30:00Z", asked],
      ["Call Sam Friday in 2 weeks", "2026-11-18T10:30:00Z", ["Call Sam", "2026-12-04"]],
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
      ["Call Sam Monday night", monday, asked],
      ["Call Sam Monday night", "2026-11-14T10:30:00Z", ["Call Sam", "2026-11-16T19:00"]],
      ["Dinner Monday night 8", monday, asked],
      ["Dinner Monday night 8", "2026-11-14T10:30:00Z", ["Dinner", "2026-11-16T20:00"]],
      ["Drinks Friday night 9", monday, ["Drinks", "2026-11-20T21:00"]],
      ["Call client tomorrow night 8", monday, ["Call client", "2026-11-17T20:00"]],
      ["Call Sam lunchtime", monday, asked],
      ["Call Sam half past 3", monday, asked],
      ["Call Sam before 3pm", monday, asked],
      ["Night shift rota", monday, asked],
      ["Send notes from Monday's call", monday, asked],
      ["Friday", monday, asked],
      ["Monday 9am", monday, asked],
      ["Call Jo this weekend", "2026-11-14T10:30:00Z", asked],
      ["Call Jo this weekend", "2026-11-18T14:00:00Z", ["Call Jo", "2026-11-21"]],
      ["Chase Noon Ltd tomorrow", monday, asked],
      ["Email Midday Events tomorrow", monday, asked],
      ["Visit Midnight Oil Studio Friday 2pm", monday, asked],
      ["Call Jo in an hour and a half", monday, asked],
      ["Call Jo tomorow 3pm", monday, asked],
      ["Call Jo tommorow", monday, asked],
      ["Call NY office 9am their time tomorrow", monday, asked],
      ["Send deck for Friday meeting", monday, asked],
      ["Cancel Friday 10am meeting", monday, asked],
      ["Tell Sam I'm off Monday", "2026-11-18T14:00:00Z", asked],
      ["Did Jo call Tuesday?", monday, asked],
      ["Call Jo 7:30", monday, asked],
      ["Call Jo at 8.30", monday, asked],
      ["Call Jo 08:30 tomorrow", monday, ["Call Jo", "2026-11-17T08:30"]],
      ["Send NDA (tomorrow)", monday, asked],
      ["Call Jo tomorrow @ 3pm", monday, asked],
      ['Read "Tomorrow" by Friday', monday, asked],
      ["Call Jo w/c 23 Nov", monday, asked],
      ["Watch The Day After Tomorrow", monday, asked],
      ["Call Jo at ten", monday, asked],
      ["Call Jo at half three", monday, asked],
      ["Call Jo 3ish tomorrow", monday, asked],
      ["Call Jo in 3 months", monday, asked],
      ["Send NDA next year", monday, asked],
      ["Send NDA 2027", monday, asked],
      ["Call Jo yesterday", monday, asked],
      ["Call Bob in 2 weeks on Tuesday", "2026-11-20T18:30:00Z", asked],
      ["Call Bob in 2 weeks on Tuesday", monday, ["Call Bob", "2026-12-01"]],
      ["Call Jo tomorrow 13pm", monday, asked],
      ["Call Jo tomorrow 0pm", monday, asked],
      ["Call Jo tomorrow at noon sharp", monday, asked],
      ["Call Jo next week sometime", monday, asked],
      ["Price rise 4.5% from Monday", "2026-11-18T14:00:00Z", asked],
      ["Lunch with Hannah Tuesday 1pm", monday, ["Lunch with Hannah", "2026-11-17T13:00"]],
      ["Call Jo 1 Jan", monday, ["Call Jo", "2027-01-01"]],
      ["Call Jo 14 Nov", monday, asked],
      ["Send NDA tomorrow.", monday, ["Send NDA", "2026-11-17"]],
      ["Drinks Friday evening", "2026-11-20T18:30:00Z", asked],
      ["Drinks Friday night", "2026-11-20T18:30:00Z", asked],
      ["Order cake for 20 Nov tomorrow", monday, asked],
      ["Sign lease starting 1 Jan by Friday", monday, asked],
      ["Call Jo Mon 23", monday, asked],
      ["Call Jo Tuesday 17", monday, asked],
      ["Call Jo Fri 20", monday, asked],
      ["Call Jo next next Friday", monday, asked],
      ["Call Jo 3pmish tomorrow", monday, asked],
      ["Book flights for 3 Dec", monday, asked],
      ["Call Jo 2day", monday, asked],
      ["Call Jo ~3pm tomorrow", monday, asked],
      ["Call Jo approx 3pm tomorrow", monday, asked],
      ["Send deck by 5pm tomorrow at the latest", monday, asked],
      ["Pay invoice dated 3 Dec", monday, asked],
      ["Call Bob 4pm", "2026-11-16T16:00:00Z", ["Call Bob", "2026-11-16T16:00"]],
      ["Call Bob today at 4pm", "2026-11-16T16:00:00Z", ["Call Bob", "2026-11-16T16:00"]],
      ["Call Bob 4pm", "2026-11-16T16:01:00Z", ["Call Bob", "2026-11-17T16:00"]],
      ["Proposal due", monday, ["Proposal due", null]],
      ["Sign this", monday, ["Sign this", null]],
      ["Log on", monday, ["Log on", null]],
      ["Stand by", monday, ["Stand by", null]],
      ["Ask what the budget is for", monday, ["Ask what the budget is for", null]],
      ["Sign this today", monday, ["Sign this", "2026-11-16"]],
      ["Noon Ltd proposal tomorrow", monday, asked],
      ["Evening Standard ad Monday", "2026-11-18T14:00:00Z", asked],
      ["Midnight Oil invoice", monday, asked],
      ["Afternoon Tea Ltd invoice", monday, asked],
      ["Order 12 chairs", monday, ["Order 12 chairs", null]],
      ["Order 12 chairs tomorrow", monday, ["Order 12 chairs", "2026-11-17"]],
      ["Flat 3 viewing Friday", monday, ["Flat 3 viewing", "2026-11-20"]],
      ["iPhone repair tomorrow", monday, ["iPhone repair", "2026-11-17"]],
      ["eBay listing", monday, ["eBay listing", null]],
      ["Prep [[Friday plan]] tomorrow", monday, ["Prep [[Friday plan]]", "2026-11-17"]],
      ["Read [[Tomorrow]]", monday, ["Read [[Tomorrow]]", null]],
      ["Notes [[3pm sync", monday, ["Notes [[3pm sync", null]],
      ["Read [[The Day After Tomorrow]] by Friday", monday, ["Read [[The Day After Tomorrow]]", "2026-11-20"]],
      ["Afternoon tea booking", monday, asked],
      ["Evening class signup", monday, asked],
      ["Evening meal plan", monday, asked],
      ["Midnight release plan", monday, asked],
      ["Weekend rota", monday, asked],
      ["Weekend cover for Jo", monday, asked],
      ["Weekend plans with Jo", monday, asked],
      ["Tonight show tickets", monday, asked],
      ["Today programme pitch", monday, asked],
      ["Morning standup tomorrow", monday, asked],
      ["Agenda for tomorrow", monday, asked],
      ["Notes for tonight", monday, asked],
      ["Prep for today", monday, asked],
      ["Call Sam tomorrow. Then email Jo", monday, ["Call Sam. Then email Jo", "2026-11-17"]],
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
