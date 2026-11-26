import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { findTables } from "@/lib/docs/editor/tables";
import { docsLanguage, docsParser } from "@/lib/docs/editor/syntax";
import { belongsInline, htmlToMarkdown, inCode, pasteChange, worthConverting, type HtmlNode } from "@/lib/docs/editor/paste";
import { EditorSelection, EditorState, Text } from "@codemirror/state";

type Child = HtmlNode | string;

function el(name: string, attrs: Record<string, string> | Child = {}, ...rest: Child[]): HtmlNode {
  const hasAttrs = typeof attrs === "object" && !("nodeType" in attrs);
  const attributes = hasAttrs ? (attrs as Record<string, string>) : {};
  const kids = (hasAttrs ? rest : [attrs as Child, ...rest]).map((child) =>
    typeof child === "string" ? { nodeType: 3, nodeName: "#text", nodeValue: child, childNodes: [] } : child,
  );
  return { nodeType: 1, nodeName: name.toUpperCase(), nodeValue: null, childNodes: kids, getAttribute: (key) => attributes[key] ?? null };
}

const body = (...kids: Child[]) => el("body", ...kids);

function outline(markdown: string) {
  const names: string[] = [];
  const tree = docsParser.parse(markdown);
  tree.iterate({
    enter: (node) => {
      if (["BulletList", "OrderedList", "ListItem", "Paragraph", "Table", "FencedCode"].includes(node.name) || node.name.startsWith("ATXHeading")) {
        names.push(`${node.name}:${markdown.slice(node.from, node.to).split("\n")[0]}`);
      }
    },
  });
  return names;
}

function pasted(doc: string, from: number, to: number, markdown: string) {
  const state = EditorState.create({ doc, selection: EditorSelection.range(from, to) });
  return state.update(pasteChange(state, markdown)).state.doc.toString();
}

describe("pasting HTML into Docs", () => {
  it("turns a table into a markdown table the editor renders", () => {
    const markdown = htmlToMarkdown(
      body(
        el("h2", "Where the traffic was lost"),
        "\n  ",
        el("p", "The posts that earned the most traffic lost the most."),
        el(
          "table",
          el("thead", el("tr", el("th", "Post"), el("th", "Clicks before"), el("th", "Clicks after"))),
          el("tbody", el("tr", "\n", el("td", "What electrical work is required"), el("td", "77"), el("td", "5")), el("tr", el("td", "A | B"), el("td", "43"))),
        ),
        el("p", { class: "note" }, "Clicks are per week."),
      ),
    );
    assert.equal(
      markdown,
      [
        "## Where the traffic was lost",
        "",
        "The posts that earned the most traffic lost the most.",
        "",
        "| Post | Clicks before | Clicks after |",
        "| --- | --- | --- |",
        "| What electrical work is required | 77 | 5 |",
        "| A \\| B | 43 |  |",
        "",
        "Clicks are per week.",
      ].join("\n"),
    );
    const doc = Text.of(markdown.split("\n"));
    const tables = findTables(doc, docsParser.parse(markdown));
    assert.equal(tables.length, 1);
    assert.equal(tables[0].rows.length, 2);
  });

  it("keeps lists, emphasis and links", () => {
    const markdown = htmlToMarkdown(
      body(
        el("ul", el("li", el("strong", "Blog"), " makes up 605 pages."), el("li", "See ", el("a", { href: "https://example.com" }, "the report"), ".")),
        el("ol", el("li", el("strong", "Page audit."), " Go through every page.", el("ul", el("li", "Nested"))), el("li", "Brand.")),
        el("p", el("a", { href: "javascript:alert(1)" }, "bad link")),
      ),
    );
    assert.equal(
      markdown,
      ["- **Blog** makes up 605 pages.", "- See [the report](https://example.com).", "", "1. **Page audit.** Go through every page.", "   - Nested", "2. Brand.", "", "bad link"].join("\n"),
    );
  });

  it("only takes over pastes that carry structure", () => {
    assert.equal(worthConverting("<meta charset='utf-8'><span>plain words</span>"), false);
    assert.equal(worthConverting("<table><tr><td>1</td></tr></table>"), true);
  });

  it("nests lists under ordered items so later items stay in the outer list", () => {
    const markdown = htmlToMarkdown(
      body(el("ol", { start: "9" }, el("li", "Nine", el("ul", el("li", "Bullet", el("ol", el("li", "Deep"))))), el("li", "Ten", el("ul", el("li", "Under ten"))), el("li", "Eleven"))),
    );
    assert.equal(markdown, ["9. Nine", "   - Bullet", "     1. Deep", "10. Ten", "    - Under ten", "11. Eleven"].join("\n"));
    const items = outline(markdown).filter((name) => name.startsWith("ListItem"));
    assert.deepEqual(items, ["ListItem:9. Nine", "ListItem:- Bullet", "ListItem:1. Deep", "ListItem:10. Ten", "ListItem:- Under ten", "ListItem:11. Eleven"]);
    assert.deepEqual(outline(markdown).filter((name) => name.endsWith("List:9. Nine")), ["OrderedList:9. Nine"]);
  });

  it("keeps structure when an inline element wraps block content, as Google Docs does", () => {
    const markdown = htmlToMarkdown(
      body(
        el("meta", { charset: "utf-8" }),
        el(
          "b",
          { style: "font-weight:normal;" },
          el("h2", "Title"),
          el("p", "Para one."),
          el("ul", el("li", el("p", "Item"))),
          el("div", el("table", el("tbody", el("tr", el("td", "a"), el("td", "b")), el("tr", el("td", "1"), el("td", "2"))))),
        ),
        el("a", { href: "https://example.com" }, el("div", "Card title"), el("div", "Card text")),
      ),
    );
    assert.equal(markdown, ["## Title", "", "Para one.", "", "- Item", "", "| a | b |", "| --- | --- |", "| 1 | 2 |", "", "Card title", "", "Card text"].join("\n"));
    assert.equal(findTables(Text.of(markdown.split("\n")), docsParser.parse(markdown)).length, 1);
  });

  it("strips bold from a heading only when one run covers all of it", () => {
    assert.equal(htmlToMarkdown(body(el("h3", el("strong", "Phase 1"), ": ", el("strong", "Audit")))), "### **Phase 1**: **Audit**");
    assert.equal(htmlToMarkdown(body(el("h3", el("strong", "Whole heading")))), "### Whole heading");
  });

  it("keeps code indentation inside list items", () => {
    const markdown = htmlToMarkdown(body(el("ul", el("li", "Run:", el("pre", "if (x) {\n    y();\n}")))));
    assert.equal(markdown, ["- Run:", "  ```", "  if (x) {", "      y();", "  }", "  ```"].join("\n"));
  });

  it("puts pasted blocks on their own lines around existing text", () => {
    const table = "| a | b |\n| --- | --- |\n| 1 | 2 |";
    assert.equal(pasted("Hello world", 6, 6, table), `Hello \n\n${table}\n\nworld`);
    assert.equal(pasted("world", 0, 0, table), `${table}\n\nworld`);
    assert.equal(pasted("Intro", 5, 5, table), `Intro\n\n${table}`);
    assert.equal(pasted("Say hi there", 4, 6, "**hello**"), "Say **hello** there");
    assert.equal(pasted("Intro\n\nOutro", 6, 6, table), `Intro\n\n${table}\n\nOutro`);
    assert.equal(pasted("A\nB\nC", 2, 3, table), `A\n\n${table}\n\nC`);
    assert.equal(pasted("Intro\nOutro", 5, 5, "- x\n- y"), "Intro\n\n- x\n- y\n\nOutro");
    assert.equal(pasted("Hello world", 6, 6, "## Heading"), "Hello \n\n## Heading\n\nworld");
    assert.equal(pasted("Hello world", 6, 6, "- x"), "Hello \n\n- x\n\nworld");
    for (const [doc, from, to] of [["Intro\n\nOutro", 6, 6], ["A\nB\nC", 2, 3], ["Intro\nOutro", 0, 0], ["Intro\nOutro", 11, 11]] as const) {
      const result = pasted(doc, from, to, table);
      const found = findTables(Text.of(result.split("\n")), docsParser.parse(result));
      assert.equal(found.length, 1, result);
      assert.equal(found[0].rows.length, 1, result);
    }
    assert.equal(findTables(Text.of(pasted("Hello world", 6, 6, table).split("\n")), docsParser.parse(pasted("Hello world", 6, 6, table))).length, 1);
  });

  it("leaves pastes inside code to the plain text", () => {
    const doc = "```\ncode here\n```\n\nText `inline` here";
    const state = EditorState.create({ doc, extensions: [docsLanguage()] });
    assert.equal(inCode(state, 7), true);
    assert.equal(inCode(state, doc.indexOf("inline") + 2), true);
    assert.equal(inCode(state, doc.length), false);
  });

  it("leaves a one-line paste beside existing text to the plain text", () => {
    const at = (doc: string, from: number, to = from) => EditorState.create({ doc, selection: EditorSelection.range(from, to) });
    assert.equal(belongsInline(at("Hello world", 6), "## two words"), true);
    assert.equal(belongsInline(at("Run  now", 4), "```\nnpm run dev\n```"), true);
    assert.equal(belongsInline(at("Hello world", 6), "**bold**"), false);
    assert.equal(belongsInline(at("Hello world", 0, 11), "## Heading"), false);
    assert.equal(belongsInline(at("Intro\n\nOutro", 6), "## Heading"), false);
    assert.equal(belongsInline(at("Hello world", 6), "| a |\n| --- |\n| 1 |"), false);
  });
});
