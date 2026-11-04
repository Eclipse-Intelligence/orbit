import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EditorSelection, EditorState, type TransactionSpec } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { activeFormats, insertBlock, toggleFormat } from "@/lib/mail/body-editor";
import { formatSpans, headingMarker } from "@/lib/mail/inline-format";

function fakeView(doc: string, from: number, to = from) {
  const view = {
    state: EditorState.create({ doc, selection: EditorSelection.single(from, to) }),
    dispatch(spec: TransactionSpec) {
      view.state = view.state.update(spec).state;
    },
  };
  return view as unknown as EditorView & { state: EditorState };
}

describe("composer formatting", () => {
  it("finds bold, italic and links the way the sent email does", () => {
    const line = "Say **hi** and *thanks* to [Acme](https://acme.test) and [Bob](/contacts/1).";
    const spans = formatSpans(line);
    assert.deepEqual(
      spans.map((span) => [span.kind, line.slice(span.from, span.to), line.slice(span.inner[0], span.inner[1])]),
      [
        ["bold", "**hi**", "hi"],
        ["italic", "*thanks*", "thanks"],
        ["link", "[Acme](https://acme.test)", "Acme"],
        ["link", "[Bob](/contacts/1)", "Bob"],
      ],
    );
    assert.deepEqual(formatSpans("2 * 3 * 4, snake_case and a ** pair"), []);
    assert.equal(headingMarker("## Next steps"), 3);
    assert.equal(headingMarker("#hashtag"), 0);
  });

  it("wraps the selection in bold or italic, and unwraps it again", () => {
    const view = fakeView("make this strong", 5, 9);
    toggleFormat(view, "**");
    assert.equal(view.state.doc.toString(), "make **this** strong");
    assert.equal(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to), "this");
    toggleFormat(view, "**");
    assert.equal(view.state.doc.toString(), "make this strong");
    toggleFormat(view, "*");
    assert.equal(view.state.doc.toString(), "make *this* strong");
    toggleFormat(view, "*");
    assert.equal(view.state.doc.toString(), "make this strong");
  });

  it("puts the cursor between new markers when nothing is selected, and doesn't unwrap bold as italic", () => {
    const empty = fakeView("Hi ", 3);
    toggleFormat(empty, "**");
    assert.equal(empty.state.doc.toString(), "Hi ****");
    assert.equal(empty.state.selection.main.head, 5);
    const bold = fakeView("a **word** b", 4, 8);
    toggleFormat(bold, "*");
    assert.equal(bold.state.doc.toString(), "a ***word*** b");
  });

  it("knows when the cursor or selection is bold or italic", () => {
    const state = (from: number, to = from) => EditorState.create({ doc: "a **bold** and *it* end", selection: EditorSelection.single(from, to) });
    assert.deepEqual(activeFormats(state(5)), { bold: true, italic: false });
    assert.deepEqual(activeFormats(state(4, 8)), { bold: true, italic: false });
    assert.deepEqual(activeFormats(state(2, 10)), { bold: true, italic: false });
    assert.deepEqual(activeFormats(state(16, 18)), { bold: false, italic: true });
    assert.deepEqual(activeFormats(state(0)), { bold: false, italic: false });
    assert.deepEqual(activeFormats(state(10, 18)), { bold: false, italic: false });
  });

  it("removes the formatting the cursor or selection is in when its button is pressed", () => {
    const cursor = fakeView("say **hello** now", 8);
    toggleFormat(cursor, "**");
    assert.equal(cursor.state.doc.toString(), "say hello now");
    assert.equal(cursor.state.selection.main.head, 6);
    const part = fakeView("say **hello** now", 6, 9);
    toggleFormat(part, "**");
    assert.equal(part.state.doc.toString(), "say hello now");
    assert.equal(part.state.sliceDoc(part.state.selection.main.from, part.state.selection.main.to), "hel");
    const whole = fakeView("say **hello** now", 4, 13);
    toggleFormat(whole, "**");
    assert.equal(whole.state.doc.toString(), "say hello now");
    assert.equal(whole.state.sliceDoc(whole.state.selection.main.from, whole.state.selection.main.to), "hello");
    const italic = fakeView("say *hello* now", 6);
    toggleFormat(italic, "*");
    assert.equal(italic.state.doc.toString(), "say hello now");
  });

  it("formats the whole word under the cursor and stacks bold with italic", () => {
    const view = fakeView("say hello now", 6);
    toggleFormat(view, "**");
    assert.equal(view.state.doc.toString(), "say **hello** now");
    toggleFormat(view, "*");
    assert.equal(view.state.doc.toString(), "say ***hello*** now");
    assert.deepEqual(activeFormats(view.state), { bold: true, italic: true });
    toggleFormat(view, "*");
    assert.equal(view.state.doc.toString(), "say **hello** now");
    toggleFormat(view, "**");
    assert.equal(view.state.doc.toString(), "say hello now");
    assert.deepEqual(activeFormats(view.state), { bold: false, italic: false });
    const end = fakeView("say hello", 9);
    toggleFormat(end, "**");
    assert.equal(end.state.doc.toString(), "say hello****");
  });

  it("reads italic inside bold, and bold with italic together", () => {
    const nested = formatSpans("**see *this* now**")[0];
    assert.ok(nested?.kind === "bold");
    assert.deepEqual(nested.spans.map((span) => span.kind), ["italic"]);
    const both = formatSpans("***both***")[0];
    assert.ok(both?.kind === "bold");
    assert.deepEqual(both.spans.map((span) => [span.kind, span.inner]), [["italic", [3, 7]]]);
  });

  it("adds image markers on their own line at the cursor", () => {
    const view = fakeView("Here it is:more", 11);
    insertBlock(view, "[Image: shot.png]");
    assert.equal(view.state.doc.toString(), "Here it is:\n[Image: shot.png]\nmore");
  });
});
