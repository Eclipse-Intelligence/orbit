import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { findTables } from "@/lib/docs/editor/tables";
import { docsParser } from "@/lib/docs/editor/syntax";
import { htmlToMarkdown, worthConverting, type HtmlNode } from "@/lib/docs/editor/paste";
import { Text } from "@codemirror/state";

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
      ["- **Blog** makes up 605 pages.", "- See [the report](https://example.com).", "", "1. **Page audit.** Go through every page.", "  - Nested", "2. Brand.", "", "bad link"].join("\n"),
    );
  });

  it("only takes over pastes that carry structure", () => {
    assert.equal(worthConverting("<meta charset='utf-8'><span>plain words</span>"), false);
    assert.equal(worthConverting("<table><tr><td>1</td></tr></table>"), true);
  });
});
