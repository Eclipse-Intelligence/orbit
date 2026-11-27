import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createAnchor } from "@/lib/docs/comment-anchor";
import { placeThreads } from "@/lib/docs/comment-layout";
import { sourceMap, sourceRange } from "@/lib/docs/editor/source-map";

const MENTION = "@[Sam Lee](member:11111111-1111-1111-1111-111111111111)";

function rendered(body: string, quote: string, occurrence = 0) {
  const map = sourceMap(body);
  let at = -1;
  for (let count = 0; count <= occurrence; count += 1) at = map.flat.text.indexOf(quote, at + 1);
  assert.ok(at >= 0, `"${quote}" is in the rendered text ${JSON.stringify(map.flat.text)}`);
  return { map, at, span: sourceRange(map, at, at + quote.length) };
}

function sourceOf(body: string, quote: string, occurrence = 0) {
  const { span } = rendered(body, quote, occurrence);
  assert.ok(span, `"${quote}" maps back to the source`);
  return body.slice(span.from, span.to);
}

describe("rendered text and where it sits in the source", () => {
  it("drops heading marks, list marks and emphasis markers from the rendered text", () => {
    const body = "# Title here\n\nSome **bold** words and _slanted_ ones.\n\n- first item\n- [ ] a task\n1. numbered";
    const text = sourceMap(body).flat.text;
    assert.equal(text, "Title here\nSome bold words and slanted ones.\nfirst item\na task\nnumbered");
    assert.equal(sourceOf(body, "Title"), "Title");
    assert.equal(sourceOf(body, "bold words"), "bold** words");
    assert.equal(sourceOf(body, "slanted"), "slanted");
    assert.equal(sourceOf(body, "first item"), "first item");
    assert.equal(sourceOf(body, "a task"), "a task");
    assert.equal(sourceOf(body, "numbered"), "numbered");
  });

  it("maps link text to the text and leaves the address out", () => {
    const body = "See [the report](https://example.test/report) for more.";
    assert.equal(sourceMap(body).flat.text, "See the report for more.");
    assert.equal(sourceOf(body, "the report"), "the report");
    assert.equal(sourceOf(body, "report for"), "report](https://example.test/report) for");
  });

  it("maps a mention to its whole markup", () => {
    const body = `Ask ${MENTION} about it.`;
    assert.equal(sourceMap(body).flat.text, "Ask Sam Lee about it.");
    assert.equal(sourceOf(body, "Sam Lee"), MENTION);
    assert.equal(sourceOf(body, "Sam"), MENTION);
    assert.equal(sourceOf(body, "about"), "about");
  });

  it("keeps table cells separate, with escaped pipes read as one character", () => {
    const body = `Intro line.\n\n| Name | Note |\n| --- | --- |\n| Rae | a\\|b |\n| ${MENTION} | **done** |\n\nAfter.`;
    const text = sourceMap(body).flat.text;
    assert.equal(text, "Intro line.\nName\nNote\nRae\na|b\nSam Lee\ndone\nAfter.");
    assert.equal(sourceOf(body, "Name"), "Name");
    assert.equal(sourceOf(body, "a|b"), "a\\|b");
    assert.equal(sourceOf(body, "Sam Lee"), MENTION);
    assert.equal(sourceOf(body, "done"), "done");
    assert.equal(sourceOf(body, "After"), "After");
  });

  it("never maps text across the break between two blocks to a single span of nothing", () => {
    const body = "First line\n\nSecond line";
    const { map, at } = rendered(body, "line\nSecond");
    const span = sourceRange(map, at, at + "line\nSecond".length)!;
    assert.equal(body.slice(span.from, span.to), "line\n\nSecond");
    assert.equal(sourceRange(map, 999, 1000), null);
  });

  it("handles a blank doc and a doc with only hidden marks", () => {
    assert.equal(sourceMap("").flat.text, "");
    assert.equal(sourceMap("```\n```").flat.text, "");
    assert.equal(sourceRange(sourceMap(""), 0, 5), null);
  });
});

describe("placing comment threads in the editor text", () => {
  const body = "# Report\n\nThe posts lost the **most clicks** afterwards.\n\nA page audit is the second step.";

  function anchorFor(quote: string, occurrence = 0) {
    const map = sourceMap(body);
    let at = -1;
    for (let count = 0; count <= occurrence; count += 1) at = map.flat.text.indexOf(quote, at + 1);
    return createAnchor(map.flat.text, at, at + quote.length)!;
  }

  it("places a thread on the source text and orphans one whose text is gone", () => {
    const threads = [
      { id: "a", anchor: anchorFor("most clicks") },
      { id: "b", anchor: anchorFor("page audit") },
      { id: "c", anchor: { quote: "something deleted long ago", prefix: "", suffix: "", at: 5 } },
      { id: "d", anchor: null },
    ];
    const layout = placeThreads(body, threads);
    assert.deepEqual(layout.orphaned.sort(), ["c", "d"]);
    const a = layout.placed.find((item) => item.id === "a")!;
    assert.equal(body.slice(a.from, a.to), "most clicks");
    const b = layout.placed.find((item) => item.id === "b")!;
    assert.equal(body.slice(b.from, b.to), "page audit");
  });

  it("follows the text after an edit above it, and orphans it once the text changes", () => {
    const anchor = anchorFor("page audit");
    const moved = `Added a new first paragraph.\n\n${body}`;
    const layout = placeThreads(moved, [{ id: "b", anchor }]);
    assert.equal(layout.placed.length, 1);
    assert.equal(moved.slice(layout.placed[0].from, layout.placed[0].to), "page audit");
    const gone = placeThreads(body.replace("A page audit is", "Something wholly different is"), [{ id: "b", anchor }]);
    assert.deepEqual(gone.orphaned, ["b"]);
  });

  it("treats a doc with no anchored threads as all orphaned without reading it", () => {
    assert.deepEqual(placeThreads(body, [{ id: "x", anchor: null }]), { placed: [], orphaned: ["x"] });
    assert.deepEqual(placeThreads(body, []), { placed: [], orphaned: [] });
  });
});
