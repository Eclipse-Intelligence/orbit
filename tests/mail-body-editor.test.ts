import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EditorSelection, EditorState, type TransactionSpec } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { insertBlock, toggleFormat } from "@/lib/mail/body-editor";
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

  it("adds image markers on their own line at the cursor", () => {
    const view = fakeView("Here it is:more", 11);
    insertBlock(view, "[Image: shot.png]");
    assert.equal(view.state.doc.toString(), "Here it is:\n[Image: shot.png]\nmore");
  });
});
