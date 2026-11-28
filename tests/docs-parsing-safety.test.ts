import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { docsParser } from "@/lib/docs/editor/syntax";
import { findTags, headingsIn, normaliseTag, parseDoc, plainText, tagAt } from "@/lib/docs/markdown";
import { createHash } from "node:crypto";
import { extractText, getDocumentProxy } from "unpdf";
import { PdfDeadlineError, renderDocPdf } from "@/lib/docs/pdf";

const MEGABYTE = 1_000_000;
const LIMIT_MS = 1000;
const UPDATED = "2026-11-26T10:00:00Z";
const ID = "11111111-2222-4333-8444-555555555555";

function within<T>(label: string, work: () => T, limit = LIMIT_MS) {
  const started = Date.now();
  const result = work();
  const took = Date.now() - started;
  assert.ok(took < limit, `${label} took ${took}ms`);
  return result;
}

const ADVERSARIAL: Record<string, string> = {
  "a table row of unclosed wiki links": `| ${"[[".repeat(MEGABYTE / 2)}`,
  "a table row of unclosed wiki links with text": `| a ${"[[b ".repeat(MEGABYTE / 4)}`,
  "a long line of spaces": `${" ".repeat(MEGABYTE)}x`,
  "a long run of spaces inside a heading": `# a${" ".repeat(MEGABYTE)}b`,
  "a long run of tabs and spaces inside a heading": `# a${"\t ".repeat(MEGABYTE / 2)}b`,
  "a long run of spaces after a heading mark": `#${" ".repeat(MEGABYTE)}b`,
  "a tag of dashes": `#a${"-".repeat(MEGABYTE)}b`,
  "a tag of dashes and slashes": `#a${"-/".repeat(MEGABYTE / 2)}b`,
  "image openers": "![".repeat(MEGABYTE / 2),
  "unclosed links": "[a](".repeat(MEGABYTE / 4),
  "unclosed comments": "<!--".repeat(MEGABYTE / 4),
  "unclosed mentions": "@[a](company:".repeat(MEGABYTE / 13),
  "table rule lookalikes": `|${"- ".repeat(MEGABYTE / 2)}x`,
  "whitespace between words": `a${" \t".repeat(MEGABYTE / 2)}b`,
  "many empty list markers": "- \n".repeat(MEGABYTE / 3),
};

describe("Docs text parsing stays fast on hostile input", () => {
  for (const [label, text] of Object.entries(ADVERSARIAL)) {
    it(`reads ${label} in under a second`, () => {
      within(`plainText of ${label}`, () => plainText(text));
      within(`headingsIn of ${label}`, () => headingsIn(text));
      within(`parseDoc of ${label}`, () => parseDoc(text));
    });
  }

  it("reads a long tag of dashes in under a second", () => {
    const text = `#a${"-".repeat(MEGABYTE)}b #${"/-".repeat(MEGABYTE / 4)}`;
    within("findTags", () => findTags(text));
    within("tagAt", () => tagAt(text.slice(0, 120)));
    within("normaliseTag", () => normaliseTag(`a${"-/".repeat(MEGABYTE / 4)}b`));
  });
});

function referenceHeading(line: string) {
  const match = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
  return match ? { level: match[1].length, text: plainText(match[2]) } : null;
}

function referenceTag(value: string) {
  const tag = value
    .trim()
    .replace(/^#+/, "")
    .toLowerCase()
    .replace(/\/{2,}/g, "/")
    .replace(/^\/+|[-/]+$/g, "");
  if (!tag || tag.length > 64) return null;
  if (!/^[\p{L}\p{N}_\-/]+$/u.test(tag)) return null;
  if (!/\p{L}/u.test(tag)) return null;
  return tag;
}

function strings(alphabet: string[], maxLength: number) {
  const out: string[] = [""];
  let layer = [""];
  for (let length = 1; length <= maxLength; length += 1) {
    layer = layer.flatMap((prefix) => alphabet.map((char) => prefix + char));
    out.push(...layer);
  }
  return out;
}

describe("Docs text parsing keeps its meaning", () => {
  it("finds the same headings as the original pattern on every short line", () => {
    for (const line of strings([" ", "#", "a", "\t", "b "], 6).concat(["# Title", "## Title ##", "### Title #", "#### a # b #", "   ## spaced  ", "    # code", "#", "# ", "#  ", "#nospace", "# #", "# ##", "# a#", "# a #"])) {
      const found = headingsIn(line);
      const expected = referenceHeading(line);
      assert.deepEqual(found.map((heading) => ({ level: heading.level, text: heading.text })), expected ? [expected] : [], JSON.stringify(line));
    }
  });

  it("normalises tags exactly as the original pattern did", () => {
    for (const value of strings(["a", "-", "/", "#", "1"], 5).concat(["Parent/Child-", "//a//b//", "-a-", "#/a/", "a--"])) {
      assert.equal(normaliseTag(value), referenceTag(value), JSON.stringify(value));
    }
  });

  it("still blanks table pipes and keeps the pipes in wiki links and escaped pipes", () => {
    assert.equal(plainText("| a | [[Target|alias]] | b \\| c |"), "a alias b | c");
    assert.equal(plainText("| --- | :-: |\n| a | b |"), "a b");
    assert.equal(plainText("--- | ---\n| a | b |"), "a b");
  });
});

describe("Mentions need a real id", () => {
  const malformed = [
    "------------------------------------",
    "0000000000000000000000000000000000-0",
    "11111111-2222-4333-8444-55555555555-",
    "11111111-2222-4333-84445-5555555555",
    "1111111122224333844455555555555555555",
    "11111111-2222-4333-8444-5555555555",
    "11111111-2222-4333-8444-5555555555555",
  ];

  it("keeps a malformed id as plain text in the parser, the index and the editor", () => {
    for (const id of malformed) {
      const text = `See @[Someone](company:${id}) and @[Other](member:${id}).`;
      assert.deepEqual(parseDoc(text).mentions, [], id);
      let mentions = 0;
      docsParser.parse(text).iterate({
        enter: (node) => {
          if (node.name === "Mention") mentions += 1;
        },
      });
      assert.equal(mentions, 0, id);
    }
  });

  it("still reads a well formed id", () => {
    const text = `See @[Dan Price](contact:${ID}) and @[Acme](company:${ID.toUpperCase().toLowerCase()}).`;
    assert.deepEqual(
      parseDoc(text).mentions.map((mention) => `${mention.kind}:${mention.id}:${mention.name}`),
      [`contact:${ID}:Dan Price`, `company:${ID}:Acme`],
    );
    let mentions = 0;
    docsParser.parse(text).iterate({
      enter: (node) => {
        if (node.name === "Mention") mentions += 1;
      },
    });
    assert.equal(mentions, 2);
    assert.equal(plainText(text), "See Dan Price and Acme.");
  });
});

describe("The Docs PDF writer stays within its deadline on hostile input", () => {
  const hostile: Record<string, string> = {
    "unclosed brackets": `${"[".repeat(MEGABYTE / 2)} text`,
    "unclosed links": `${"[a](http://".repeat(MEGABYTE / 22)} end`,
    "unclosed comments in an html block": `<div>\n${"<!--".repeat(MEGABYTE / 8)}`,
    "unclosed declarations in an html block": `<div>\n${"<!a".repeat(MEGABYTE / 6)}`,
    "code with a long run of spaces": `\`\`\`\nx${" ".repeat(MEGABYTE / 2)}y\n\`\`\``,
    "unclosed image openers": `${"![a](".repeat(MEGABYTE / 12)} end`,
    "nested list markers on one line": `${"- ".repeat(MEGABYTE / 4)}x`,
    "a long table row of links": `| ${"[a](http://".repeat(45_000)} | x |\n| - | - |\n| a | b |`,
    "a long table row of images": `| a | b |\n| - | - |\n| ${"![a](".repeat(90_000)} | x |`,
    "a long code line in a list fence": `- \`\`\`\n  ${"x ".repeat(20_000)}\n- after`,
    "a long code line in a quote fence": `> \`\`\`\n> ${"x ".repeat(20_000)}\n> \`\`\`\n\nafter`,
    "rule markers after a long line": `${"word ".repeat(1700)}_ _ _ _ _ _ ${"word ".repeat(300)}\n\n_ _ _\n\n- - - -`,
    "lines just under the limit": `${`${"[a](http://".repeat(700)}\n`.repeat(100)}`,
    "unclosed mentions": `${"@[a](company:".repeat(MEGABYTE / 13)} end`,
    "one very long word": "w".repeat(MEGABYTE / 2),
    "a wide table": `${"|a".repeat(2000)}|\n${"|-".repeat(2000)}|\n${"|b".repeat(2000)}|`,
    "many table rows": `| a | b |\n| - | - |\n${"| x | y |\n".repeat(MEGABYTE / 20)}`,
  };

  for (const [label, content] of Object.entries(hostile)) {
    it(`finishes or stops cleanly on ${label}`, { timeout: 60_000 }, async () => {
      const started = Date.now();
      try {
        const buffer = await renderDocPdf({ title: "Hostile", content, updatedAt: UPDATED }, { deadline: Date.now() + 3000 });
        assert.equal(buffer.subarray(0, 5).toString(), "%PDF-");
      } catch (error) {
        assert.ok(error instanceof PdfDeadlineError, String(error));
      }
      const took = Date.now() - started;
      assert.ok(took < 8000, `${label} took ${took}ms`);
    });
  }
});

describe("The Docs PDF writer prints a doc with a very long line as plain text", () => {
  const NORMAL = [
    "# Heading one",
    "",
    "Some **bold**, *italic* and `code` with [a link](https://example.com/secret) and [[Wiki target|alias text]] and #tag.",
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
    "code line one",
    "code line two",
    "```",
    "",
    "---",
    "",
    "| A | B |",
    "| :-- | --: |",
    "| one | two |",
    "",
    `A long paragraph. ${"It keeps going with ordinary words. ".repeat(120)}`,
  ].join("\n");
  const MAIN_OUTPUT_SHA256 = "2aa74d9d25a37ffca4c7edd06a421903d025713d40bfb350e240f6caa2d63f3d";

  async function textOf(buffer: Buffer, title: string) {
    const pdf = await getDocumentProxy(new Uint8Array(buffer));
    const { text } = await extractText(pdf, { mergePages: false });
    return text.map((page) => page.replace(new RegExp(`${title} · Page \\d+ of \\d+`), "")).join(" ").replace(/\s+/g, " ").trim();
  }

  it("renders a doc whose lines are all under the limit exactly as it did before", async () => {
    const buffer = await renderDocPdf({ title: "Normal doc", content: NORMAL, updatedAt: UPDATED });
    assert.equal(createHash("sha256").update(buffer).digest("hex"), MAIN_OUTPUT_SHA256);
    const edge = await renderDocPdf({ title: "Normal doc", content: `${NORMAL}\n\n${"w ".repeat(3999)}w`, updatedAt: UPDATED });
    assert.ok((await textOf(edge, "Normal doc")).includes("Heading one"));
  });

  it("keeps every character and shows structure as written once a line is over 8000", async () => {
    const long = Array.from({ length: 1800 }, (_, index) => `word${index}`).join(" ");
    assert.ok(long.length > 8000);
    const content = `# Not a heading\n\n- not a bullet\n\n> not a quote\n\n| a | b |\n\n\`\`\`\nnot code\n\`\`\`\n\n_ _ _\n\n${long}\n\n**not bold** after`;
    const buffer = await renderDocPdf({ title: "Plain", content, updatedAt: UPDATED });
    assert.equal(buffer.subarray(0, 5).toString(), "%PDF-");
    const text = await textOf(buffer, "Plain");
    assert.ok(text.includes(content.replace(/\s+/g, " ").trim()), text.slice(0, 300));
  });

  it("still shows a mention or a wiki link by its visible name, never its id or link target", async () => {
    const id = "11111111-2222-4333-8444-555555555555";
    const content = `Hello @[Ada Lovelace](contact:${id}) and [[Secret target|Shown]] and [[Other]] and [a label](https://example.com/x) ${"filler ".repeat(1500)}`;
    const text = await textOf(await renderDocPdf({ title: "Plain", content, updatedAt: UPDATED }), "Plain");
    assert.ok(text.includes("Hello Ada Lovelace and Shown and Other and a label filler"));
    assert.ok(!text.includes(id) && !text.includes("Secret target") && !text.includes("[[") && !text.includes("example.com"));
  });

  it("keeps every character of a long line inside a table, a list fence and a quote fence", async () => {
    for (const content of [`| a | b |\n| - | - |\n| ${"cell ".repeat(2000)}| x |`, `- \`\`\`\n  ${"code ".repeat(2000)}\n- after`, `> \`\`\`\n> ${"quoted ".repeat(2000)}\n> \`\`\`\n\nafter`]) {
      const text = await textOf(await renderDocPdf({ title: "Plain", content, updatedAt: UPDATED }), "Plain");
      assert.ok(text.includes(content.replace(/\s+/g, " ").trim()));
    }
  });

  it("stays on the deadline for a long table row of links or images", { timeout: 60_000 }, async () => {
    for (const content of [`| ${"[a](http://".repeat(45_000)} | x |`, `| ${"![a](".repeat(90_000)} | x |`]) {
      const started = Date.now();
      try {
        await renderDocPdf({ title: "Hostile", content, updatedAt: UPDATED }, { deadline: Date.now() + 3000 });
      } catch (error) {
        assert.ok(error instanceof PdfDeadlineError, String(error));
      }
      assert.ok(Date.now() - started < 8000, `took ${Date.now() - started}ms`);
    }
  });
});
