import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EditorSelection, EditorState } from "@codemirror/state";
import { entryBlock, jotExtensions } from "@/lib/docs/editor/jot";
import { detectTrigger } from "@/lib/docs/editor/setup";

const handlers = { resolve: () => true, trigger: () => undefined, pickerKey: () => false, submit: () => true };

function jot(text: string) {
  return EditorState.create({ doc: text, selection: EditorSelection.cursor(text.length), extensions: jotExtensions({ label: "New entry at 09:00", placeholder: "Jot something down", handlers }) });
}

describe("Daily jot line", () => {
  it("stamps an entry with the time, putting lists on their own line", () => {
    assert.equal(entryBlock("  Called Acme  ", "09:15"), "09:15 Called Acme");
    assert.equal(entryBlock("- one\n- two", "09:15"), "09:15\n- one\n- two");
    assert.equal(entryBlock("1. first", "09:15"), "09:15\n1. first");
    assert.equal(entryBlock("   ", "09:15"), null);
  });

  it("opens the same pickers as the main editor", () => {
    assert.deepEqual(detectTrigger(jot("Met @Acm"), true), { kind: "mention", query: "Acm", from: 4, at: 4, head: 8 });
    assert.equal(detectTrigger(jot("See [[Road"), true)?.kind, "link");
    assert.equal(detectTrigger(jot("Tagged #dea"), true)?.kind, "tag");
    assert.equal(detectTrigger(jot("Met @Acm"), false), null);
  });
});
