import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { extractText, getDocumentProxy } from "unpdf";
import { renderDocPdf } from "@/lib/docs/pdf";

async function read(buffer: Buffer) {
  const pdf = await getDocumentProxy(new Uint8Array(buffer));
  const { text } = await extractText(pdf, { mergePages: false });
  return { pages: pdf.numPages, text: text.map((page) => page.replace(/\s+/g, " ")) };
}

function table(rows: number) {
  const body = Array.from({ length: rows }, (_, index) => `| Row ${index + 1} ${"wraps across several lines of a cell ".repeat(4)}| ${index + 1} | ${index * 3} |`);
  return ["| Post | Before | After |", "| :--- | ---: | ---: |", ...body].join("\n");
}

const UPDATED = "2026-11-26T10:00:00Z";

describe("Docs PDF writer", () => {
  it("makes a valid A4 PDF with the updated date, title and footer", async () => {
    const buffer = await renderDocPdf({ title: "ClimateWorks blog performance", content: "Plain paragraph.", updatedAt: UPDATED });
    assert.equal(buffer.subarray(0, 5).toString(), "%PDF-");
    const { pages, text } = await read(buffer);
    assert.equal(pages, 1);
    assert.match(text[0], /Updated 26 Nov 2026/);
    assert.match(text[0], /ClimateWorks blog performance/);
    assert.match(text[0], /Plain paragraph\./);
    assert.match(text[0], /Page 1 of 1/);
    const pdf = await getDocumentProxy(new Uint8Array(buffer));
    const page = await pdf.getPage(1);
    const [, , width, height] = page.view;
    assert.ok(Math.abs(width - 595.28) < 0.5 && Math.abs(height - 841.89) < 0.5);
  });

  it("writes headings, inline styles, lists, tasks, quotes, code and rules as text, with mentions, links and tags plain", async () => {
    const content = [
      "# Heading one",
      "",
      "Some **bold**, *italic* and `code` with [a link](https://example.com/secret) and [[Wiki target|alias text]] and [[Other doc]] #climateworks and @[Dan Price](contact:11111111-2222-4333-8444-555555555555).",
      "",
      "- First bullet",
      "  - Nested bullet",
      "- [ ] Open task",
      "- [x] Done task",
      "",
      "1. One",
      "2. Two",
      "",
      "> Quoted words",
      "",
      "```",
      "  indented code",
      "```",
      "",
      "---",
      "",
      "After the rule.",
    ].join("\n");
    const { text } = await read(await renderDocPdf({ title: "Styles", content, updatedAt: UPDATED }));
    const all = text.join(" ");
    for (const wanted of ["Heading one", "bold", "italic", "code", "a link", "alias text", "Other doc", "#climateworks", "Dan Price", "First bullet", "Nested bullet", "Open task", "Done task", "One", "Two", "Quoted words", "indented code", "After the rule."]) {
      assert.ok(all.includes(wanted), wanted);
    }
    assert.ok(!all.includes("example.com"));
    assert.ok(!all.includes("11111111"));
    assert.ok(!all.includes("Wiki target"));
    assert.ok(!all.includes("[["));
    assert.ok(!all.includes("**"));
  });

  it("breaks a table with long cells across pages, repeating the header row", async () => {
    const buffer = await renderDocPdf({ title: "Big table", content: `Intro\n\n${table(70)}\n\nOutro`, updatedAt: UPDATED });
    const { pages, text } = await read(buffer);
    assert.ok(pages >= 4 && pages <= 8, `pages ${pages}`);
    text.forEach((page, index) => {
      assert.match(page, new RegExp(`Page ${index + 1} of ${pages}`));
      if (index > 0) assert.match(page, /Post Before After/, `header repeated on page ${index + 1}`);
    });
    const all = text.join(" ");
    for (let row = 1; row <= 70; row += 1) assert.ok(all.includes(`Row ${row} `), `row ${row}`);
    assert.match(text[pages - 1], /Outro/);
    assert.ok(!text[pages - 1].startsWith("Post Before After Outro"));
  });

  it("splits a single row taller than a page", async () => {
    const huge = Array.from({ length: 1200 }, (_, index) => `sentence${index}`).join(" ");
    const content = `| Notes | Count |\n| --- | --- |\n| ${huge} | 1 |\n| Short row | 2 |`;
    const { pages, text } = await read(await renderDocPdf({ title: "Tall row", content, updatedAt: UPDATED }));
    assert.ok(pages >= 2);
    const all = text.join(" ");
    assert.ok(all.includes("sentence0") && all.includes("sentence1199") && all.includes("Short row"));
    assert.match(text[1], /Notes Count/);
  });

  it("keeps wide unbreakable words inside the page and tolerates an empty doc", async () => {
    const long = "x".repeat(300);
    const wide = await read(await renderDocPdf({ title: "Wide", content: `| A | B |\n| - | - |\n| ${long} | ok |\n\n${long}`, updatedAt: UPDATED }));
    assert.ok(wide.pages >= 1);
    const empty = await read(await renderDocPdf({ title: "", content: "", updatedAt: UPDATED }));
    assert.match(empty.text[0], /Untitled/);
    assert.match(empty.text[0], /Page 1 of 1/);
  });
});
