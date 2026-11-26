import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  caretAfterTyping,
  endingCanSave,
  endingEnter,
  endingLine,
  escapeAction,
  typeEnding,
  type EndingAnswer,
  type EndingEditorState,
} from "@/lib/docs/public-ending";

function state(patch: Partial<EndingEditorState> = {}): EndingEditorState {
  return { value: "", current: null, answer: null, error: null, saving: false, busy: false, ...patch };
}

const available: EndingAnswer = { status: "available" };

describe("public ending editor: typing and pasting", () => {
  it("keeps only the part after /d/ when a link is pasted", () => {
    assert.equal(typeEnding("https://orbit.geteclipse.co/d/Climate-Report"), "climate-report");
    assert.equal(typeEnding("orbit.geteclipse.co/d/climate-report?utm=1#top"), "climate-report");
    assert.equal(typeEnding("https://orbit.geteclipse.co/d/Abc_123XyZ"), "abc-123xyz");
    assert.equal(typeEnding("no marker here"), "no-marker-here");
  });

  it("puts the caret where the person was typing when the value is normalised", () => {
    assert.equal(caretAfterTyping("Hello World", 5), 5);
    assert.equal(caretAfterTyping("Hello World", 11), 11);
    assert.equal(caretAfterTyping("Hello  World", 8), 7);
    assert.equal(caretAfterTyping("--Hello", 4), 2);
    assert.equal(caretAfterTyping("Café x", 4), 4);
  });
});

describe("public ending editor: the status line", () => {
  it("shows the rule that is broken, then the check, then the answer", () => {
    assert.deepEqual(endingLine(state({ value: "ab" })), { text: "Use at least 3 characters.", tone: "bad" });
    assert.deepEqual(endingLine(state({ value: "admin" })), { text: "“admin” is reserved. Pick another.", tone: "bad" });
    assert.deepEqual(endingLine(state({ value: "fresh-one" })), { text: "", tone: "plain" });
    assert.deepEqual(endingLine(state({ value: "fresh-one", answer: available })), { text: "Available.", tone: "ok" });
    assert.deepEqual(endingLine(state({ value: "fresh-one", answer: { status: "taken" } })), { text: "Taken. Pick another.", tone: "bad" });
    assert.deepEqual(endingLine(state({ value: "fresh-one", answer: { status: "failed", message: "Couldn't check the ending. Wait a minute and try again." } })), {
      text: "Couldn't check the ending. Wait a minute and try again.",
      tone: "bad",
    });
    assert.deepEqual(endingLine(state({ value: "same-one", current: "same-one" })), { text: "Available.", tone: "ok" });
  });

  it("explains an empty field only when there is an ending to give up, and puts a save error first", () => {
    assert.equal(endingLine(state({ value: "", current: "old-one" })).text, "Save to go back to the random code.");
    assert.equal(endingLine(state({ value: "" })).text, "");
    assert.deepEqual(endingLine(state({ value: "fresh-one", answer: available, error: "Couldn't change the public link. Try again." })), {
      text: "Couldn't change the public link. Try again.",
      tone: "bad",
    });
  });
});

describe("public ending editor: Save and Enter", () => {
  it("saves only a checked, changed ending, or an empty field that gives one up", () => {
    assert.equal(endingCanSave(state({ value: "fresh-one" })), false, "not before the check answers");
    assert.equal(endingCanSave(state({ value: "fresh-one", answer: available })), true);
    assert.equal(endingCanSave(state({ value: "fresh-one", answer: { status: "taken" } })), false);
    assert.equal(endingCanSave(state({ value: "fresh-one", answer: { status: "failed", message: "x" } })), true, "the server decides when the check couldn't run");
    assert.equal(endingCanSave(state({ value: "same-one", current: "same-one" })), false, "nothing changed");
    assert.equal(endingCanSave(state({ value: "", current: "old-one" })), true);
    assert.equal(endingCanSave(state({ value: "", current: null })), false);
    assert.equal(endingCanSave(state({ value: "ab", answer: available })), false);
  });

  it("disables Save and Enter while the editor or any public change on the doc is saving", () => {
    const base = { value: "fresh-one", answer: available };
    assert.equal(endingCanSave(state({ ...base, busy: true })), false);
    assert.equal(endingCanSave(state({ ...base, saving: true })), false);
    assert.equal(endingEnter(state({ ...base, busy: true })), "none");
    assert.equal(endingEnter(state({ ...base, saving: true })), "none");
    assert.equal(endingEnter(state({ value: "", current: "old-one", busy: true })), "none");
  });

  it("runs the check on Enter before the answer arrives, then saves or shows why not", () => {
    assert.equal(endingEnter(state({ value: "fresh-one" })), "check");
    assert.equal(endingEnter(state({ value: "fresh-one", answer: available })), "save");
    assert.equal(endingEnter(state({ value: "fresh-one", answer: { status: "taken" } })), "none");
    assert.equal(endingEnter(state({ value: "fresh-one", answer: { status: "invalid", message: "No." } })), "none");
    assert.equal(endingEnter(state({ value: "fresh-one", answer: { status: "failed", message: "x" } })), "save");
    assert.equal(endingEnter(state({ value: "ab" })), "none");
    assert.equal(endingEnter(state({ value: "same-one", current: "same-one" })), "none");
    assert.equal(endingEnter(state({ value: "", current: "old-one" })), "save");
    assert.equal(endingEnter(state({ value: "", current: null })), "none");
  });
});

describe("public ending editor: Escape", () => {
  it("closes the editor first, wherever focus is, and the popover otherwise", () => {
    assert.equal(escapeAction(true), "close-editor");
    assert.equal(escapeAction(false), "close-popover");
  });
});
