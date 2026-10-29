import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EditorSelection, EditorState, Text } from "@codemirror/state";
import { previewPlan, type PlanItem } from "@/lib/docs/editor/plan";
import { detectTrigger } from "@/lib/docs/editor/setup";
import { staticLines } from "@/lib/docs/editor/static";
import { docsLanguage, docsParser } from "@/lib/docs/editor/syntax";

const MENTION = "@[Acme](company:5a8f2c10-6b1e-4c39-9d0a-0c1a2b3c4d01)";

function nodes(text: string) {
  const found: string[] = [];
  docsParser.parse(text).iterate({
    enter(node) {
      if (["WikiLink", "Hashtag", "Mention", "Link"].includes(node.name)) found.push(`${node.name}:${text.slice(node.from, node.to)}`);
    },
  });
  return found;
}

function plan(text: string, active: number[] = [], options: { daily?: boolean; resolve?: (target: string) => boolean } = {}) {
  const doc = Text.of(text.split("\n"));
  return previewPlan({
    doc,
    tree: docsParser.parse(text),
    from: 0,
    to: doc.length,
    active: new Set(active),
    daily: Boolean(options.daily),
    resolve: options.resolve ?? (() => true),
  });
}

function slices(text: string, items: PlanItem[], type: PlanItem["type"]) {
  return items.filter((item) => item.type === type && "to" in item).map((item) => text.slice(item.from, (item as { to: number }).to));
}

describe("docs syntax", () => {
  it("parses wiki links, tags and record mentions", () => {
    assert.deepEqual(nodes(`See [[Northwind MSA redlines]], #partners/q4 and ${MENTION} plus [x](https://a.b).`), [
      "WikiLink:[[Northwind MSA redlines]]",
      "Hashtag:#partners/q4",
      `Mention:${MENTION}`,
      "Link:[x](https://a.b)",
    ]);
  });

  it("leaves numbers, words and code alone", () => {
    assert.deepEqual(nodes("Item #1, c#d and `#code` or `[[code]]`"), []);
  });
});

describe("live preview", () => {
  it("hides Markdown marks away from the cursor and shows them on its line", () => {
    const text = "Hello **bold** and [[Link]]\nNext **line**";
    const resting = plan(text);
    assert.deepEqual(slices(text, resting, "hide"), ["**", "**", "[[", "]]", "**", "**"]);
    const editing = plan(text, [1]);
    assert.deepEqual(slices(text, editing, "hide"), ["**", "**"]);
    assert.deepEqual(
      editing.filter((item) => item.type === "mark" && item.className === "note-syntax").map((item) => text.slice(item.from, (item as { to: number }).to)),
      ["**", "**", "[[", "]]"],
    );
  });

  it("hangs heading marks in the margin so the text never moves", () => {
    const text = "## Risks";
    const resting = plan(text).find((item) => item.type === "widget");
    const editing = plan(text, [1]).find((item) => item.type === "widget");
    assert.deepEqual(resting && { from: resting.from, to: (resting as { to: number }).to, widget: (resting as { widget: unknown }).widget }, { from: 0, to: 3, widget: { kind: "hang", text: "" } });
    assert.deepEqual(editing && (editing as { widget: unknown }).widget, { kind: "hang", text: "##" });
    assert.ok(plan(text).some((item) => item.type === "line" && item.className === "note-h note-h2"));
  });

  it("renders tasks, bullets and nested lists", () => {
    const text = "- [x] Done\n- [ ] Open\n  - Nested\n1. First";
    const items = plan(text);
    const widgets = items.filter((item): item is Extract<PlanItem, { type: "widget" }> => item.type === "widget").map((item) => item.widget);
    assert.deepEqual(widgets, [
      { kind: "checkbox", checked: true, hanging: null },
      { kind: "checkbox", checked: false, hanging: null },
      { kind: "bullet", label: null, raw: null },
      { kind: "bullet", label: "1.", raw: null },
    ]);
    const lines = items.filter((item) => item.type === "line").map((item) => (item as { className: string }).className);
    assert.ok(lines.includes("note-li note-depth-0 note-task note-task-done"));
    assert.ok(lines.includes("note-li note-depth-1"));
  });

  it("marks unresolved links and turns mentions into chips", () => {
    const text = `[[Known]] [[Missing]] ${MENTION}`;
    const items = plan(text, [], { resolve: (target) => target === "Known" });
    const links = items.filter((item) => item.type === "mark" && item.className.startsWith("note-wikilink"));
    assert.deepEqual(
      links.map((item) => (item as { className: string }).className),
      ["note-wikilink", "note-wikilink is-unresolved"],
    );
    assert.ok(items.some((item) => item.type === "widget" && item.widget.kind === "mention" && item.widget.name === "Acme"));
  });

  it("puts daily entry times in the margin", () => {
    const text = "08:42 Slept badly.\n\n16:48\n- [ ] Send dates";
    const items = plan(text, [], { daily: true });
    const times = items.filter((item): item is Extract<PlanItem, { type: "widget" }> => item.type === "widget" && item.widget.kind === "entry");
    assert.deepEqual(
      times.map((item) => [item.widget, text.slice(item.from, item.to)]),
      [
        [{ kind: "entry", time: "08:42" }, "08:42 "],
        [{ kind: "entry", time: "16:48" }, "16:48"],
      ],
    );
    assert.ok(items.some((item) => item.type === "line" && item.className === "note-entry note-entry-solo"));
    assert.ok(!plan(text).some((item) => item.type === "widget" && item.widget.kind === "entry"));
  });

  it("renders the same lines for the first paint", () => {
    const lines = staticLines(`## Plan\n\n- [ ] Ship ${MENTION}`);
    assert.equal(lines.length, 3);
    assert.equal(lines[0].className, "cm-line note-h note-h2");
    assert.equal(lines[1].className, "cm-line note-blank");
    assert.deepEqual(lines[0].segments, [{ widget: { kind: "hang", text: "" } }, { text: "Plan", className: "" }]);
    assert.ok(lines[2].segments.some((segment) => "widget" in segment && segment.widget.kind === "mention"));
  });

  it("keeps long notes cheap by planning only the visible range", () => {
    const text = Array.from({ length: 4000 }, (_, index) => `- **Item ${index}** with [[Link ${index}]] and #tag${index}`).join("\n");
    const doc = Text.of(text.split("\n"));
    const tree = docsParser.parse(text);
    const started = performance.now();
    const items = previewPlan({ doc, tree, from: doc.line(2000).from, to: doc.line(2040).to, active: new Set([2010]), daily: false, resolve: () => true });
    const elapsed = performance.now() - started;
    assert.ok(items.length > 100 && items.length < 600, String(items.length));
    assert.ok(elapsed < 50, `${elapsed}ms`);
  });
});

describe("editor triggers", () => {
  function state(text: string, cursor = text.length) {
    return EditorState.create({ doc: text, selection: EditorSelection.cursor(cursor), extensions: [docsLanguage()] });
  }

  it("opens the link, tag and mention pickers", () => {
    assert.deepEqual(detectTrigger(state("Plan in [[Acme ren"), true), { kind: "link", from: 8, query: "Acme ren", at: 8, head: 18 });
    assert.deepEqual(detectTrigger(state("Line\nTagged #cli"), true), { kind: "tag", from: 7, query: "cli", at: 12, head: 16 });
    assert.equal(detectTrigger(state("With @Le"), true)?.kind, "mention");
  });

  it("stays closed without focus, with a selection or in code", () => {
    assert.equal(detectTrigger(state("[[Acme"), false), null);
    assert.equal(detectTrigger(EditorState.create({ doc: "[[Acme", selection: EditorSelection.range(2, 6), extensions: [docsLanguage()] }), true), null);
    assert.equal(detectTrigger(state("Code `[[Acme", 12), true)?.kind, "link");
    assert.equal(detectTrigger(state("Code `[[Acme` done", 12), true), null);
    assert.equal(detectTrigger(state("```\n#tag"), true), null);
  });
});
