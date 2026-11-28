import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { docsParser } from "@/lib/docs/editor/syntax";
import { findTags, headingsIn, normaliseTag, parseDoc, plainText, tagAt } from "@/lib/docs/markdown";
import { breakLongLines, PdfDeadlineError, renderDocPdf } from "@/lib/docs/pdf";

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

describe("Breaking long PDF lines never creates block syntax", () => {
  const words = (count: number) => Array.from({ length: count }, (_, index) => `word${index}`).join(" ");
  const MARKERS = ["- item", "* item", "+ item", "1. item", "12) item", "# heading", "###### heading", "> quote", "| cell", "```js", "~~~", "---", "***", "___", "<div>", "===", ": term"];

  function startsOfPieces(text: string) {
    return text.split("\n").slice(1);
  }

  for (const marker of MARKERS) {
    it(`never starts a piece with "${marker}"`, () => {
      for (const offset of [0, 1, 2, 3, 5, 8]) {
        const head = words(1500).slice(0, 8000 - offset).replace(/\s+$/, "");
        const line = `${head} ${marker} and then more words ${words(400)}`;
        const result = breakLongLines(`${line}\n\nAfter`);
        const pieces = startsOfPieces(result.slice(0, result.indexOf("\n\nAfter")));
        assert.ok(pieces.length >= 1, "the line was broken");
        for (const piece of pieces) assert.ok(!/^(?:[-*+](?:\s|$)|\d{1,9}[.)](?:\s|$)|#{1,6}(?:\s|$)|[>|<=:]|`{3}|~{3}|(?:[-*_][ \t]*){3})/.test(piece), `${marker} at ${offset}: ${piece.slice(0, 20)}`);
        assert.equal(result.replace(/\s+/g, " "), `${line}\n\nAfter`.replace(/\s+/g, " "));
      }
    });
  }

  it("keeps a fence that follows a long line closed, so later text is not turned into code", () => {
    const line = `${words(1500).slice(0, 7990)} \`\`\` ${words(300)}`;
    const result = breakLongLines(`${line}\n\nAfter the line`);
    assert.ok(!result.split("\n").some((piece) => piece.startsWith("```")));
  });

  it("leaves long lines inside a fence and long table rows whole", () => {
    const long = words(3000);
    const fenced = `\`\`\`\n${long}\n\`\`\`\n\nAfter`;
    assert.equal(breakLongLines(fenced), fenced);
    const tilde = `~~~~\n${long}\n~~~~`;
    assert.equal(breakLongLines(tilde), tilde);
    const table = `| A | B |\n| - | - |\n| ${long} | x |\n| y | z |`;
    assert.equal(breakLongLines(table), table);
    const bare = `A | B\n- | -\n${long} | x`;
    assert.equal(breakLongLines(bare), bare);
    assert.notEqual(breakLongLines(long), long);
  });

  it("breaks hostile long lines in under a second", () => {
    for (const text of [" ".repeat(MEGABYTE), "- ".repeat(MEGABYTE / 2), "a ".repeat(MEGABYTE / 2), `${"a ".repeat(4000)}${" ".repeat(MEGABYTE)}- x`, "[a](http://".repeat(MEGABYTE / 11)]) {
      within("breakLongLines", () => breakLongLines(text));
    }
  });

  it("still breaks a long line after a closed fence", () => {
    const text = `\`\`\`\ncode\n\`\`\`\n\n${words(3000)}`;
    assert.ok(breakLongLines(text).split("\n").length > text.split("\n").length);
  });
});
