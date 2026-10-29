import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { appendDailyEntry, isDailyDate, localDate, parseDailyEntries, shiftDate } from "@/lib/docs/daily";
import { changeCounts, diffCounts, lineDiff } from "@/lib/docs/diff";
import { appendText, applyDocEdit, findAndReplace, retag } from "@/lib/docs/edits";
import { excerptFrom, maskCode, normaliseTag, parseDoc, parseLinks, parseMentions, parseTags, plainText, rewriteLinkTitle, wordCount } from "@/lib/docs/markdown";

const ACME = "11111111-1111-4111-8111-111111111111";
const LENA = "22222222-2222-4222-8222-222222222222";

describe("doc links", () => {
  it("reads [[links]] with headings and labels, and skips code", () => {
    const content = [
      "See [[Northwind MSA redlines]] and [[Q4 plan#Risks|the risks]].",
      "`[[Not a link]]` and \\[[escaped]]",
      "```",
      "[[Inside a fence]]",
      "```",
      "[[  Spaced   out  ]] and [[]] and [[ ]]",
    ].join("\n");
    const links = parseLinks(content);
    assert.deepEqual(
      links.map((link) => ({ target: link.target, title: link.title, heading: link.heading, label: link.label })),
      [
        { target: "Northwind MSA redlines", title: "Northwind MSA redlines", heading: null, label: null },
        { target: "Q4 plan#Risks", title: "Q4 plan", heading: "Risks", label: "the risks" },
        { target: "Spaced out", title: "Spaced out", heading: null, label: null },
      ],
    );
    assert.equal(content.slice(links[0].start, links[0].end), "[[Northwind MSA redlines]]");
  });

  it("keeps fences open until a matching close and ignores inline code across paragraphs", () => {
    const masked = maskCode("~~~\n[[a]]\n```\n[[b]]\n~~~\n[[c]] `x\n\ny` [[d]]");
    assert.deepEqual(
      parseLinks("~~~\n[[a]]\n```\n[[b]]\n~~~\n[[c]] `x\n\ny` [[d]]", masked).map((link) => link.target),
      ["c", "d"],
    );
  });

  it("rewrites links on rename, keeping headings and labels, case-insensitively, but not in code", () => {
    const content = "[[acme pricing]] and [[Acme Pricing#Tiers|tiers]] and `[[Acme pricing]]` and [[Acme pricing notes]]";
    const result = rewriteLinkTitle(content, "Acme pricing", "Acme pricing 2027");
    assert.equal(result.count, 2);
    assert.equal(result.content, "[[Acme pricing 2027]] and [[Acme pricing 2027#Tiers|tiers]] and `[[Acme pricing]]` and [[Acme pricing notes]]");
  });

  it("reads @ record mentions once each, outside code", () => {
    const content = `Call with @[Acme](company:${ACME}) and @[Lena Ortiz](contact:${LENA}). Again @[Acme](company:${ACME}). \`@[Hidden](company:${LENA})\``;
    assert.deepEqual(parseMentions(content), [
      { kind: "company", id: ACME, name: "Acme" },
      { kind: "contact", id: LENA, name: "Lena Ortiz" },
    ]);
  });
});

describe("doc tags", () => {
  it("reads inline and nested tags, lowercased and unique", () => {
    assert.deepEqual(parseTags("Plan #partners/q4 for #Clients/Acme and #clients/acme, #follow-up_now."), ["partners/q4", "clients/acme", "follow-up_now"]);
  });

  it("ignores headings, code, numbers, links, anchors and escapes", () => {
    const content = [
      "# Heading",
      "## Second ## ",
      "###### Six",
      "#Real at line start",
      "Issue #123 and #2026 are numbers",
      "A url https://x.test/#anchor and [link](#section) and mid#word",
      "`#code` and \\#escaped",
      "```",
      "#fenced",
      "```",
      "    #indented-code",
      "[[Note #inside]] and @[Name #x](company:" + ACME + ")",
      "## Plan #q4",
    ].join("\n");
    assert.deepEqual(parseTags(content), ["real", "q4"]);
  });

  it("trims slashes and rejects bad tags", () => {
    assert.equal(normaliseTag("#/clients//acme/"), "clients/acme");
    assert.equal(normaliseTag("#123"), null);
    assert.equal(normaliseTag("bad tag"), null);
    assert.equal(normaliseTag("#" + "a".repeat(101)), null);
    assert.deepEqual(parseTags("#émile and #日本"), ["émile", "日本"]);
  });

  it("parses everything in one pass", () => {
    const parsed = parseDoc(`[[A]] #t @[Acme](company:${ACME})`);
    assert.equal(parsed.links.length, 1);
    assert.deepEqual(parsed.tags, ["t"]);
    assert.equal(parsed.mentions[0].id, ACME);
  });
});

describe("doc edits", () => {
  it("appends with a blank line, or a single newline between list items", () => {
    assert.equal(appendText("First", "Second"), "First\n\nSecond");
    assert.equal(appendText("- one\n", "- two"), "- one\n- two");
    assert.equal(appendText("", "Only"), "Only");
  });

  it("finds and replaces once, refusing missing or ambiguous text", () => {
    assert.equal(findAndReplace("early December, early", "early December", "12 December"), "12 December, early");
    assert.throws(() => findAndReplace("abc", "zzz", "y"), /isn't in the doc/);
    assert.throws(() => findAndReplace("a a", "a", "b"), /appears 2 times/);
    assert.equal(findAndReplace("a a", "a", "b", true), "b b");
  });

  it("adds tags on a tag line and removes them inline", () => {
    assert.equal(retag("Body", ["clients/acme", "#Q4"], []), "Body\n\n#clients/acme #q4");
    assert.equal(retag("Body\n\n#a", ["b"], []), "Body\n\n#a #b");
    assert.equal(retag("Body #a here\n\n#b", [], ["a", "b"]), "Body here");
    assert.equal(retag("Body #a", ["a"], []), "Body #a");
    assert.throws(() => retag("x", ["no spaces allowed"], []), /isn't a tag/);
    assert.equal(applyDocEdit("x", { action: "replace", content: "y" }), "y");
  });
});

describe("doc diffs", () => {
  it("shows changed lines with a little context and gaps", () => {
    const before = ["## Q4 plan", "- [ ] Share pricing", "a", "b", "c", "d", "e", "## Risks", "Legal could slip."].join("\n");
    const after = ["## Q4 plan", "- [x] Share pricing", "a", "b", "c", "d", "e", "## Risks", "Legal could slip.", "Acme renews in January."].join("\n");
    const diff = lineDiff(before, after, { context: 1 });
    assert.deepEqual(diff, [
      { kind: "same", text: "## Q4 plan" },
      { kind: "remove", text: "- [ ] Share pricing" },
      { kind: "add", text: "- [x] Share pricing" },
      { kind: "same", text: "a" },
      { kind: "gap", text: "" },
      { kind: "same", text: "Legal could slip." },
      { kind: "add", text: "Acme renews in January." },
    ]);
    assert.deepEqual(diffCounts(diff), { added: 2, removed: 1 });
    assert.deepEqual(lineDiff("", "new"), [{ kind: "add", text: "new" }]);
  });
});

describe("daily notes format", () => {
  it("appends timed entries and reads them back", () => {
    let content = appendDailyEntry("", "08:42", "Slept badly. Coffee first.");
    content = appendDailyEntry(content, "16:48", "- [ ] Send Lena the dates\n- [x] Reply to Dana");
    assert.equal(content, "08:42 Slept badly. Coffee first.\n\n16:48 - [ ] Send Lena the dates\n- [x] Reply to Dana");
    assert.deepEqual(parseDailyEntries(content), [
      { time: "08:42", text: "Slept badly. Coffee first." },
      { time: "16:48", text: "- [ ] Send Lena the dates\n- [x] Reply to Dana" },
    ]);
  });

  it("uses the London date", () => {
    assert.equal(localDate(new Date("2026-10-28T23:30:00Z")), "2026-10-28");
    assert.equal(localDate(new Date("2026-07-01T23:30:00Z")), "2026-07-02");
    assert.equal(shiftDate("2026-03-01", -1), "2026-02-28");
    assert.ok(isDailyDate("2026-10-29"));
    assert.ok(!isDailyDate("2026-02-30"));
  });

  it("counts words and writes excerpts without markdown", () => {
    assert.equal(wordCount(`## Plan\n- [ ] Ship it with @[Acme](company:${ACME}) and [[Q4 plan|the plan]]`), 8);
    assert.equal(excerptFrom("# Title\n**Bold** and _it_"), "Title Bold and it");
  });
});

describe("server and editor agree on what is a tag or link", () => {
  it("needs a real boundary before a tag, drops trailing dashes and slashes, and skips indented code and comments", () => {
    assert.deepEqual(parseTags("[[A]]#glued and `x`#glued2 and #trail- and #slash/ and #todo-- end"), ["trail", "slash", "todo"]);
    assert.deepEqual(parseTags("\n    #indented [[Code link]]\n\npara\n    #lazy-continuation"), ["lazy-continuation"]);
    assert.deepEqual(parseLinks("\n    [[In code]]\n\n[[Outside]]").map((link) => link.target), ["Outside"]);
    assert.deepEqual(parseTags("- item\n\n    #in-list"), ["in-list"]);
    assert.deepEqual(parseTags("# Heading\n    #after-heading"), []);
    assert.deepEqual(parseTags("<!-- #comment [[Hidden]] -->\n#real and <!-- #inline --> #after"), ["real", "after"]);
    assert.deepEqual(parseLinks("<!--\n[[Hidden]]\n-->\n[[Shown]]").map((link) => link.target), ["Shown"]);
    assert.equal(normaliseTag("follow-up-"), "follow-up");
  });
});

describe("retagging leaves the rest of the doc alone", () => {
  it("collapses blank lines only where a tag line was removed", () => {
    const code = "Intro\n\n```\na\n\n\n\nb\n```\n\n\n\nOutro\n";
    assert.equal(retag(code, [], ["missing"]), code);
    assert.equal(retag(`Intro\n\n#gone\n\n\nKept\n\n\n\nEnd`, [], ["gone"]), "Intro\n\nKept\n\n\n\nEnd");
    assert.equal(retag("Line one\n#gone\nLine two", [], ["gone"]), "Line one\nLine two");
    assert.equal(retag("Body\n\n#gone\n", [], ["gone"]), "Body\n");
    assert.equal(retag("#gone\n\nBody", [], ["gone"]), "Body");
    assert.equal(retag(`${code}\n#gone`, [], ["gone"]), code.replace(/\n+$/, ""));
  });
});

describe("full change counts", () => {
  it("counts the whole change even when the shown diff is cut short", () => {
    const before = Array.from({ length: 1000 }, (_, index) => `a${index}`).join("\n");
    const after = Array.from({ length: 1000 }, (_, index) => `b${index}`).join("\n");
    assert.deepEqual(changeCounts(before, after), { added: 1000, removed: 1000 });
    assert.notDeepEqual(diffCounts(lineDiff(before, after, { maxLines: 200 })), { added: 1000, removed: 1000 });
  });
});

describe("parsing stays fast on hostile text", () => {
  const size = 1_000_000;
  const inputs: Record<string, string> = {
    brackets: "[".repeat(size),
    "unclosed links": "[a](".repeat(size / 4),
    "unclosed images": "![".repeat(size / 2),
    mentions: "@[".repeat(size / 2),
    "wiki links": "[[a".repeat(size / 3),
    "angle brackets": "<".repeat(size),
    "blank lines": "\n".repeat(size),
    "spaced lines": " \n".repeat(size / 2),
    "backtick pairs": "``a".repeat(size / 3),
    "growing backtick runs": Array.from({ length: 1000 }, (_, index) => `${"`".repeat(index + 1)}x`).join(" ").repeat(2),
    fences: "```\n".repeat(size / 4),
    comments: "<!--".repeat(size / 4),
    "indented lines": "    a\n".repeat(size / 6),
    "list markers": "- ".repeat(size / 2),
    mixed: "[x](y [[z @[w `q <p #t ".repeat(size / 24),
  };
  for (const [name, text] of Object.entries(inputs)) {
    it(`counts words and parses 1MB of ${name} in well under a second`, () => {
      for (const run of [wordCount, parseDoc, plainText] as ((value: string) => unknown)[]) {
        const started = performance.now();
        run(text);
        const took = performance.now() - started;
        assert.ok(took < 500, `${run.name} took ${Math.round(took)}ms`);
      }
    });
  }
});
