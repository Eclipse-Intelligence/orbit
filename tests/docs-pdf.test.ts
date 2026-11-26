import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { extractText, getDocumentProxy } from "unpdf";
import { renderDocPdf } from "@/lib/docs/pdf";
import { pdfDisposition } from "@/lib/docs/public";

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

async function within<T>(work: Promise<T>, ms: number, label: string) {
  let timer: NodeJS.Timeout | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} took longer than ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([work, limit]);
  } finally {
    clearTimeout(timer);
  }
}

describe("Docs PDF writer limits", () => {
  it("finishes when a table header is taller than a page", { timeout: 90_000 }, async () => {
    const wide = `| ${Array.from({ length: 30 }, (_, index) => `${index}`.padEnd(60, "h")).join(" | ")} |\n| ${Array.from({ length: 30 }, () => "---").join(" | ")} |\n| ${Array.from({ length: 30 }, () => "x").join(" | ")} |`;
    const long = `| ${Array.from({ length: 1500 }, (_, index) => `word${index}`).join(" ")} | B |\n| --- | --- |\n| row one | 1 |\n| row two | 2 |`;
    for (const content of [wide, long]) {
      const buffer = await within(renderDocPdf({ title: "Tall header", content, updatedAt: UPDATED }), 20_000, "tall header");
      const { pages, text } = await read(buffer);
      assert.ok(pages >= 1);
      assert.ok(text.join(" ").includes("row one") || text.join(" ").includes(" x "));
    }
  });

  it("keeps other columns readable beside one unbreakable word, and survives 60 columns", { timeout: 90_000 }, async () => {
    const url = `https://example.com/${"a".repeat(270)}`;
    const content = `| Before | Link | After |\n| --- | --- | --- |\n| 12 | ${url} | 34 |`;
    const { text } = await read(await renderDocPdf({ title: "Url", content, updatedAt: UPDATED }));
    const all = text.join(" ");
    assert.match(all, /Before/);
    assert.match(all, /After/);
    assert.match(all, /\b12\b/);
    const sixty = `| ${Array.from({ length: 60 }, (_, index) => `c${index}`).join(" | ")} |\n| ${Array.from({ length: 60 }, () => "-").join(" | ")} |\n| ${Array.from({ length: 60 }, (_, index) => `v${index}`).join(" | ")} |`;
    const wide = await within(renderDocPdf({ title: "Sixty", content: sixty, updatedAt: UPDATED }), 20_000, "sixty columns");
    assert.ok((await read(wide)).pages >= 1);
  });

  it("stops indenting deeply nested quotes and lists", { timeout: 90_000 }, async () => {
    const quotes = `${"> ".repeat(60)}deep quote words`;
    const lists = Array.from({ length: 40 }, (_, depth) => `${"  ".repeat(depth)}- level ${depth} words`).join("\n");
    const { text } = await read(await within(renderDocPdf({ title: "Deep", content: `${quotes}\n\n${lists}`, updatedAt: UPDATED }), 20_000, "deep nesting"));
    const all = text.join(" ");
    assert.match(all, /deep quote words/);
    assert.match(all, /level 39 words/);
  });

  it("never leaves a heading alone at the bottom of a page", { timeout: 90_000 }, async () => {
    for (let filler = 36; filler <= 56; filler += 1) {
      const content = `${Array.from({ length: filler }, (_, index) => `Filler line ${index}\n`).join("\n")}\n## Lonely heading\n\n| Post | Count |\n| --- | --- |\n| One | 1 |\n| Two | 2 |\n\nAfter text`;
      const { text } = await read(await renderDocPdf({ title: "Keep", content, updatedAt: UPDATED }));
      for (const page of text) {
        const body = page.replace(/ Keep · Page \d+ of \d+\s*$/, "");
        assert.ok(!/Lonely heading\s*$/.test(body), `filler ${filler}: heading ended a page`);
      }
    }
  });

  it("renders 10,000 nested quotes flat without overflowing the stack", { timeout: 60_000 }, async () => {
    const { text } = await read(await renderDocPdf({ title: "Nest", content: `${"> ".repeat(10_000)}bottom words`, updatedAt: UPDATED }));
    assert.match(text.join(" "), /bottom words/);
    const lists = Array.from({ length: 2_000 }, (_, depth) => `${"  ".repeat(Math.min(depth, 3))}- item ${depth}`).join("\n");
    assert.ok((await read(await renderDocPdf({ title: "Lists", content: lists, updatedAt: UPDATED }))).pages >= 1);
  });

  it("never prints mention, wikilink or link markup, whatever path the text takes", { timeout: 90_000 }, async () => {
    const id = "11111111-2222-4333-8444-555555555555";
    const mention = `@[Ada Lovelace](contact:${id})`;
    const inline = `${mention} and @[Acme](company:${id}) and [[Wiki|Shown]] and [[Secret target]] and [label](https://example.com/x) and ![alt text](https://example.com/i.png)`;
    const nestedLists = Array.from({ length: 45 }, (_, depth) => `${"  ".repeat(depth)}- level ${depth}`).join("\n");
    const inputs: Record<string, string> = {
      "deep quotes": `${"> ".repeat(45)}${inline}`,
      "huge quotes": `${"> ".repeat(10_000)}${inline}`,
      "deep lists": `${nestedLists}\n${"  ".repeat(45)}- ${inline}`,
      "html block": `<div>\nnote ${inline}\n</div>`,
      "html comment": `<!-- hidden ${inline} -->\n\nafter`,
      table: `| Head | ${inline} |\n| --- | --- |\n| ${inline} | cell |`,
      quote: `> ${inline}`,
      list: `- ${inline}\n- [ ] ${inline}`,
      heading: `# ${inline}\n\nSetext ${inline}\n---`,
      emphasis: `**${inline}** and *${inline}* and ~~${inline}~~`,
      "link label": `[${mention} and [[Wiki|Shown]]](https://example.com)`,
      reference: `[text][ref] ${inline}\n\n[ref]: https://example.com`,
    };
    for (const [name, content] of Object.entries(inputs)) {
      const all = (await read(await renderDocPdf({ title: "Rule", content, updatedAt: UPDATED }))).text.join(" ");
      assert.ok(!/\]\((?:contact|company|task|opportunity|proposal|member):/.test(all), `${name}: mention markup printed`);
      assert.ok(!all.includes("[["), `${name}: wikilink markup printed`);
      assert.ok(!all.includes(id), `${name}: an id was printed`);
      assert.ok(!all.includes("example.com"), `${name}: a link target was printed`);
    }
    const html = (await read(await renderDocPdf({ title: "Rule", content: inputs["html block"], updatedAt: UPDATED }))).text.join(" ");
    assert.match(html, /note Ada Lovelace and Acme and Shown and Secret target and label and alt text/);
  });

  it("drops emoji selectors and control characters, and writes strikethrough text", async () => {
    const { text } = await read(await renderDocPdf({ title: "Marks", content: `Love ❤️${"\u007f\u0085"}ok ~~struck~~ words`, updatedAt: UPDATED }));
    const all = text.join(" ");
    assert.match(all, /struck/);
    assert.ok(!/\?\?/.test(all), all);
    assert.ok(!all.includes("\u007f") && !all.includes("\u0085"));
  });

  it("ends with a clear error once its deadline passes", async () => {
    await assert.rejects(renderDocPdf({ title: "Late", content: "Text", updatedAt: UPDATED }, { deadline: Date.now() - 1 }), /Couldn't make the PDF\. Try again\./);
  });

  it("builds the worst 1MB documents in a few seconds", { timeout: 90_000 }, async () => {
    const code = `\`\`\`\n${Array.from({ length: 50_000 }, (_, index) => `const value${index} = compute(${index}); // x`).join("\n")}\n\`\`\``.slice(0, 1_000_000);
    const startedCode = Date.now();
    const codePdf = await within(renderDocPdf({ title: "Code", content: code, updatedAt: UPDATED }), 25_000, "1MB code block");
    const codeMs = Date.now() - startedCode;
    const startedWord = Date.now();
    const wordPdf = await within(renderDocPdf({ title: "Word", content: "w".repeat(1_000_000), updatedAt: UPDATED }), 25_000, "1MB word");
    const wordMs = Date.now() - startedWord;
    console.log(`1MB code block ${codeMs}ms, ${(codePdf.length / 1e6).toFixed(1)}MB; 1MB word ${wordMs}ms, ${(wordPdf.length / 1e6).toFixed(1)}MB`);
    assert.ok(codeMs < 15_000 && wordMs < 15_000);
  });

  it("names the download with the real title for any script", () => {
    const header = pdfDisposition("Café 計画 plan");
    assert.match(header, /filename="cafe-plan\.pdf"/);
    assert.match(header, /filename\*=UTF-8''Caf%C3%A9%20%E8%A8%88%E7%94%BB%20plan\.pdf$/);
    assert.match(pdfDisposition("計画"), /filename="document\.pdf"; filename\*=UTF-8''%E8%A8%88%E7%94%BB\.pdf$/);
  });
});
