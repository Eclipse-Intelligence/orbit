import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EditorSelection, EditorState, Text } from "@codemirror/state";
import { EditorView, type DecorationSet } from "@codemirror/view";
import { staticLines } from "@/lib/docs/editor/static";
import { docsLanguage, docsParser } from "@/lib/docs/editor/syntax";
import { alignmentOf, findTables, noteTables, setTableFocus, splitRow, tableAlignments, tableViews, type TableView } from "@/lib/docs/editor/tables";
import { plainText } from "@/lib/docs/markdown";

const COMPANY = "5a8f2c10-6b1e-4c39-9d0a-0c1a2b3c4d01";
const TABLE = ["| Name | Stage | Value |", "|:-----|:-----:|------:|", `| @[Acme](company:${COMPANY}) | **Won** | £12k |`, "| [[Plan]] | #deals | |"].join("\n");

function blocks(text: string) {
  const doc = Text.of(text.split("\n"));
  return { doc, found: findTables(doc, docsParser.parse(text)) };
}

function views(text: string): TableView[] {
  const doc = Text.of(text.split("\n"));
  return tableViews({ doc, tree: docsParser.parse(text), resolve: () => true });
}

function cellText(view: TableView, row: number, column: number) {
  const cells = row === 0 ? view.header : view.rows[row - 1];
  return cells[column].segments.map((segment) => ("text" in segment ? segment.text : `<${segment.widget.kind}>`)).join("");
}

function decorated(state: EditorState) {
  const ranges: { from: number; to: number; block: boolean; className: string | null }[] = [];
  for (const source of state.facet(EditorView.decorations)) {
    const set = (typeof source === "function" ? null : source) as DecorationSet | null;
    if (!set) continue;
    set.between(0, state.doc.length, (from, to, decoration) => {
      ranges.push({ from, to, block: Boolean(decoration.spec.block), className: (decoration.spec.class as string | undefined) ?? null });
    });
  }
  return ranges;
}

function editor(text: string, cursor = 0) {
  return EditorState.create({ doc: text, selection: EditorSelection.cursor(cursor), extensions: [docsLanguage(), noteTables({ resolve: () => true })] });
}

describe("Docs tables", () => {
  it("splits rows into trimmed cells, with or without outer pipes", () => {
    const row = "| a | **b** |  |";
    assert.deepEqual(
      splitRow(row).map((cell) => row.slice(cell.from, cell.to)),
      ["a", "**b**", ""],
    );
    assert.deepEqual(
      splitRow("one | two").map((cell) => "one | two".slice(cell.from, cell.to)),
      ["one", "two"],
    );
    const escaped = "| x \\| y | z |";
    assert.deepEqual(
      splitRow(escaped).map((cell) => escaped.slice(cell.from, cell.to)),
      ["x \\| y", "z"],
    );
  });

  it("reads column alignment from the delimiter row", () => {
    assert.deepEqual(tableAlignments("|:---|:---:|---:|---|"), ["left", "center", "right", null]);
    assert.deepEqual(tableAlignments(":-: | -"), ["center", null]);
    assert.equal(alignmentOf(" :--- "), "left");
    assert.equal(alignmentOf("---:"), "right");
    assert.equal(alignmentOf(":"), "left");
  });

  it("finds a table block covering whole lines, with alignment and padded rows", () => {
    const text = `Intro\n\n${TABLE}\n\nAfter`;
    const { doc, found } = blocks(text);
    assert.equal(found.length, 1);
    const [table] = found;
    assert.equal(doc.lineAt(table.from).number, 3);
    assert.equal(doc.lineAt(table.to).number, 6);
    assert.equal(table.from, doc.line(3).from);
    assert.equal(table.to, doc.line(6).to);
    assert.deepEqual(table.align, ["left", "center", "right"]);
    assert.equal(table.header.length, 3);
    assert.equal(table.rows.length, 2);
    assert.ok(table.rows.every((row) => row.length === 3));
  });

  it("drops cells past the header and pads short rows", () => {
    const { found } = blocks("| a | b |\n|---|---|\n| 1 | 2 | 3 |\n| only |");
    assert.deepEqual(
      found[0].rows.map((row) => row.length),
      [2, 2],
    );
  });

  it("ignores pipes without a delimiter row and pipes inside code", () => {
    assert.equal(blocks("| a | b |\n| c | d |").found.length, 0);
    assert.equal(blocks("```\n| a | b |\n|---|---|\n```").found.length, 0);
    assert.equal(blocks("Just a | pipe").found.length, 0);
  });

  it("finds tables inside quotes", () => {
    assert.equal(blocks("> | a | b |\n> |---|---|\n> | 1 | 2 |").found.length, 1);
  });

  it("renders inline formatting inside cells", () => {
    const [view] = views(TABLE);
    assert.equal(cellText(view, 0, 0), "Name");
    assert.equal(cellText(view, 1, 0), "<mention>");
    assert.equal(cellText(view, 1, 1), "Won");
    assert.ok(view.rows[0][1].segments.some((segment) => "text" in segment && segment.className.includes("note-strong")));
    assert.equal(cellText(view, 2, 0), "Plan");
    assert.ok(view.rows[1][0].segments.some((segment) => "text" in segment && segment.className.includes("note-wikilink")));
    assert.ok(view.rows[1][1].segments.some((segment) => "text" in segment && segment.className.includes("note-tag")));
    assert.equal(cellText(view, 2, 2), "");
    assert.equal(cellText(views("| a |\n|---|\n| x \\| y |")[0], 1, 0), "x | y");
  });

  it("renders a table as one block in the static first paint", () => {
    const lines = staticLines(`Intro\n\n${TABLE}\n\nAfter`);
    assert.equal(lines.length, 5);
    assert.ok(lines[2].table);
    assert.equal(lines[2].table?.rows.length, 2);
    assert.equal(lines[4].segments.map((segment) => ("text" in segment ? segment.text : "")).join(""), "After");
  });

  it("replaces the table with a block widget until the cursor is inside it in a focused editor", () => {
    const text = `Intro\n\n${TABLE}\n\nAfter`;
    const inside = text.indexOf("Stage");
    const blurred = editor(text, inside);
    const widget = decorated(blurred).filter((range) => range.block);
    assert.equal(widget.length, 1);
    assert.equal(blurred.doc.lineAt(widget[0].from).number, 3);
    assert.equal(widget[0].to, blurred.doc.line(6).to);

    const focused = blurred.update({ effects: setTableFocus.of(true) }).state;
    assert.equal(decorated(focused).filter((range) => range.block).length, 0);
    assert.equal(decorated(focused).filter((range) => range.className === "note-table-line").length, 4);

    const outside = focused.update({ selection: EditorSelection.cursor(text.length) }).state;
    assert.equal(decorated(outside).filter((range) => range.block).length, 1);
  });

  it("keeps table syntax out of plain text and snippets", () => {
    assert.equal(plainText(TABLE.replace(`@[Acme](company:${COMPANY})`, "Acme")), "Name Stage Value Acme Won £12k Plan #deals");
    assert.equal(plainText("| [[Plan|the plan]] | x |\n|---|---|"), "the plan x");
  });
});
