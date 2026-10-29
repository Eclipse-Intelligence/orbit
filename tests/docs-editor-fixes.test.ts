import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EditorSelection, EditorState, Text } from "@codemirror/state";
import { safeHref } from "@/lib/docs/editor/links";
import { previewPlan, type PlanItem } from "@/lib/docs/editor/plan";
import { planToDecorations } from "@/lib/docs/editor/preview";
import { detectTrigger, linkEnd } from "@/lib/docs/editor/setup";
import { docsLanguage, docsParser } from "@/lib/docs/editor/syntax";
import { tagAt, triggerBefore } from "@/lib/docs/markdown";

function plan(text: string, active: number[] = []) {
  const doc = Text.of(text.split("\n"));
  return { doc, items: previewPlan({ doc, tree: docsParser.parse(text), from: 0, to: doc.length, active: new Set(active), daily: false, resolve: () => true }) };
}

function replaced(doc: Text, items: PlanItem[]) {
  const spans: [number, number][] = [];
  planToDecorations(doc, items).decorations.between(0, doc.length, (from, to, value) => {
    if (value.spec.widget !== undefined || (to > from && !value.spec.class)) spans.push([from, to]);
  });
  return spans;
}

function links(text: string) {
  return plan(text).items.filter((item): item is Extract<PlanItem, { type: "mark" }> => item.type === "mark" && item.className === "note-link").map((item) => item.attributes?.["data-href"]);
}

describe("editor safety", () => {
  it("keeps hidden link syntax on one line when a link wraps", () => {
    for (const text of ['See [t](https://a.b\n"title") now', "[a\nb](https://a.b) and more", '[t](https://a.b\n"title")'] as const) {
      for (const active of [[], [1], [2]]) {
        const { doc, items } = plan(text, active);
        for (const item of items) {
          if (item.type === "hide" || item.type === "widget") assert.equal(doc.lineAt(item.from).number, doc.lineAt(item.to).number, `${JSON.stringify(text)} ${item.from}-${item.to}`);
        }
        for (const [from, to] of replaced(doc, items)) assert.equal(doc.lineAt(from).number, doc.lineAt(to).number);
      }
    }
  });

  it("only links http, https and mailto", () => {
    assert.equal(safeHref("https://acme.test/a"), "https://acme.test/a");
    assert.equal(safeHref("mailto:dana@acme.test"), "mailto:dana@acme.test");
    assert.equal(safeHref("www.acme.test"), "https://www.acme.test/");
    assert.equal(safeHref("/docs/abc"), "/docs/abc");
    assert.equal(safeHref("javascript:alert(1)"), null);
    assert.equal(safeHref("JavaScript:alert(1)"), null);
    assert.equal(safeHref("data:text/html,hi"), null);
    assert.equal(safeHref("vbscript:x"), null);
    assert.equal(safeHref("//evil.test"), null);
    assert.deepEqual(links("[a](javascript:alert(1)) and [b](https://acme.test)"), ["https://acme.test/"]);
    assert.deepEqual(links("Go to https://acme.test now"), ["https://acme.test/"]);
  });

  it("closes the mention picker after an @ and a space", () => {
    assert.equal(triggerBefore("Lunch @ Acme"), null);
    assert.equal(triggerBefore("Lunch @ "), null);
    assert.equal(triggerBefore("Lunch @")?.kind, "mention");
    assert.deepEqual(triggerBefore("Lunch @Acme Co"), { kind: "mention", from: 6, query: "Acme Co" });
    const state = EditorState.create({ doc: "Lunch @ Acme", selection: EditorSelection.cursor(12), extensions: [docsLanguage()] });
    assert.equal(detectTrigger(state, true), null);
  });

  it("replaces to the end of the link the cursor is in", () => {
    const doc = Text.of(["See [[Acme]] and [[Other]]"]);
    assert.equal(linkEnd(doc, 8), 12);
    assert.equal(linkEnd(doc, 6), 12);
    assert.equal(linkEnd(Text.of(["[[Acme ren"]), 10), 10);
    assert.equal(linkEnd(Text.of(["[[Acme and [[X]]"]), 6), 6);
    const text = doc.toString();
    const at = 4;
    const result = `${text.slice(0, at)}[[Acme renewal]]${text.slice(linkEnd(doc, 8))}`;
    assert.equal(result, "See [[Acme renewal]] and [[Other]]");
  });

  it("matches the server's link and tag rules", () => {
    const long = "a".repeat(400);
    const nodes = (text: string) => {
      const found: string[] = [];
      docsParser.parse(text).iterate({ enter: (node) => void (["WikiLink", "Hashtag", "Mention"].includes(node.name) ? found.push(text.slice(node.from, node.to)) : undefined) });
      return found;
    };
    assert.deepEqual(nodes(`[[${long}]]`), [`[[${long}]]`]);
    assert.deepEqual(nodes(`[[${long}a]]`), []);
    assert.deepEqual(nodes("[[ ]] and [[|label]]"), []);
    assert.deepEqual(tagAt("#q4-"), { tag: "q4", length: 3 });
    assert.deepEqual(tagAt("#clients/"), { tag: "clients", length: 8 });
    assert.deepEqual(nodes("Plan #q4- now"), ["#q4"]);
    assert.deepEqual(nodes("@[Acme [old]](company:5a8f2c10-6b1e-4c39-9d0a-0c1a2b3c4d01)").filter((node) => node.startsWith("@")), []);
    assert.equal(nodes("@[Acme](company:5a8f2c10-6b1e-4c39-9d0a-0c1a2b3c4d01)").length, 1);
    assert.deepEqual(nodes("Para\n\n    #indented code\n\nafter #real"), ["#real"]);
    assert.deepEqual(nodes("Text <!-- #hidden --> and #shown"), ["#shown"]);
    assert.deepEqual(nodes("<!--\n#block comment\n-->\n\n#after"), ["#after"]);
    assert.deepEqual(nodes("a#b and (#c) and #d/"), ["#d"]);
  });

  it("hides setext underlines and labels fences in quotes and lists", () => {
    const setext = plan("Title\n=====\nBody");
    assert.ok(setext.items.some((item) => item.type === "hide" && item.from === 6 && item.to === 11));
    assert.ok(!plan("Title\n=====\nBody", [2]).items.some((item) => item.type === "hide"));
    const quote = plan("> ```js\n> code\n> ```\n\nafter");
    const fence = quote.items.find((item): item is Extract<PlanItem, { type: "widget" }> => item.type === "widget" && item.widget.kind === "fence");
    assert.deepEqual(fence && [fence.from, fence.to, fence.widget], [2, 7, { kind: "fence", language: "js" }]);
    const list = plan("- ```ts\n  code\n  ```");
    const listFence = list.items.find((item): item is Extract<PlanItem, { type: "widget" }> => item.type === "widget" && item.widget.kind === "fence");
    assert.deepEqual(listFence && [listFence.from, listFence.widget], [2, { kind: "fence", language: "ts" }]);
    for (const sample of [quote, list, plan("- # Heading\n> ## Quoted"), plan("- # Heading\n> ## Quoted", [1, 2])]) {
      const ranges = sample.items.filter((item) => item.type === "widget" || item.type === "hide").map((item) => [item.from, (item as { to: number }).to] as const);
      const sorted = [...ranges].sort((left, right) => left[0] - right[0]);
      for (let index = 1; index < sorted.length; index += 1) assert.ok(sorted[index][0] >= sorted[index - 1][1], `overlap ${JSON.stringify(sorted)}`);
    }
  });
});
